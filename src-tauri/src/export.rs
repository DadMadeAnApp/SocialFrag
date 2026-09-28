use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;

use crate::encoders::{Encoder, EncoderSet};
use crate::ffmpeg::tool_command;
use crate::filtergraph::build_args;
use crate::job::{validate_job, ExportError, ExportJob, ExportProgress, ExportResult};
use crate::output_path::{is_dir_writable, mp4_path, part_path, same_file};
use crate::preset::validate_on;
use crate::progress::{eta, parse_progress_line};

const STDERR_LINES: usize = 50;

#[derive(Default)]
pub struct ExportState {
    pub child: Mutex<Option<Child>>,
    pub cancelled: AtomicBool,
    /// One export at a time: a second run would overwrite `child` and cancel the wrong ffmpeg.
    pub running: AtomicBool,
}

struct RunningGuard<'a>(&'a AtomicBool);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ExportState {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

/// Files written for one clip: layer masks, overlay PNGs (with clip-local start seconds) and gain curves.
#[derive(Debug, Default)]
pub struct ClipAssets {
    pub masks: Vec<(String, PathBuf)>,
    pub overlays: Vec<(PathBuf, f64)>,
    pub gains: Vec<(u32, PathBuf)>,
    /// ffconcat list of the clip's caption frames, when it has captions.
    pub captions: Option<PathBuf>,
}

fn io_err(e: impl std::fmt::Display) -> ExportError {
    ExportError::new("io", "Couldn't prepare export files.", &e.to_string())
}

pub fn write_assets(job: &ExportJob, dir: &Path) -> Result<Vec<ClipAssets>, ExportError> {
    std::fs::create_dir_all(dir).map_err(io_err)?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let write = |name: String, data: &str| -> Result<PathBuf, ExportError> {
        let p = dir.join(name);
        std::fs::write(&p, b64.decode(data).map_err(io_err)?).map_err(io_err)?;
        Ok(p)
    };
    let mut out = Vec::new();
    for (n, c) in job.clips.iter().enumerate() {
        let mut a = ClipAssets::default();
        for (i, layer) in c.preset.layers.iter().enumerate() {
            if layer.hidden {
                continue;
            }
            if let Some(data) = c.layer_masks.get(&layer.id) {
                a.masks.push((layer.id.clone(), write(format!("c{n}-mask-{i}.png"), data)?));
            }
        }
        for (i, o) in c.overlays.iter().enumerate() {
            a.overlays.push((write(format!("c{n}-overlay-{i}.png"), &o.png_base64)?, o.start));
        }
        if !c.caption_frames.is_empty() {
            let mut list = String::from("ffconcat version 1.0\n");
            for (i, f) in c.caption_frames.iter().enumerate() {
                write(format!("c{n}-cap-{i}.png"), &f.png_base64)?;
                list.push_str(&format!("file 'c{n}-cap-{i}.png'\nduration {:.3}\n", f.end - f.start));
            }
            // The concat demuxer ignores the last entry's duration unless the file is listed again.
            list.push_str(&format!("file 'c{n}-cap-{}.png'\n", c.caption_frames.len() - 1));
            let lp = dir.join(format!("c{n}-captions.ffconcat"));
            std::fs::write(&lp, list).map_err(io_err)?;
            a.captions = Some(lp);
        }
        for t in crate::audio_mix::enabled_tracks(c) {
            if let Some(data) = c.gain_curves.get(&t.index) {
                a.gains.push((t.index, write(format!("c{n}-gain-{}.f32", t.index), data)?));
            }
        }
        out.push(a);
    }
    Ok(out)
}

fn run_once(job: &ExportJob, assets: &[ClipAssets], enc: Encoder, out: &Path, state: &ExportState, on_progress: &dyn Fn(ExportProgress)) -> Result<(), ExportError> {
    let args = build_args(job, assets, enc, out);
    let mut child = tool_command("ffmpeg")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ExportError::new("ffmpeg", "Couldn't start ffmpeg.", &e.to_string()))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_LINES)));
    let tail_w = Arc::clone(&tail);
    let err_thread = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut t = tail_w.lock().unwrap();
            if t.len() == STDERR_LINES {
                t.pop_front();
            }
            t.push_back(line);
        }
    });

    *state.child.lock().unwrap() = Some(child);
    if state.cancelled.load(Ordering::SeqCst) {
        state.cancel(); // cancel arrived while spawning
    }

    let total_us = job.duration() * 1_000_000.0;
    let started = Instant::now();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if line == "progress=end" {
            on_progress(ExportProgress { fraction: 1.0, eta_s: Some(0.0) });
        } else if let Some(f) = parse_progress_line(&line, total_us) {
            on_progress(ExportProgress { fraction: f, eta_s: eta(started.elapsed().as_secs_f64(), f) });
        }
    }

    let child = state.child.lock().unwrap().take();
    let status = child.map(|mut c| c.wait());
    let _ = err_thread.join();

    if state.cancelled.load(Ordering::SeqCst) {
        return Err(ExportError::new("cancelled", "Export cancelled.", ""));
    }
    match status {
        Some(Ok(s)) if s.success() => Ok(()),
        other => {
            let tail = tail.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
            let details = format!("encoder: {}\nstatus: {:?}\nargs: {}\n\n{}", enc.ffmpeg_name(), other.map(|r| r.map(|s| s.code())), args.join(" "), tail);
            Err(ExportError::new("ffmpeg", "Export failed.", &details))
        }
    }
}

pub fn run_export(job: ExportJob, encoders: &EncoderSet, work_root: &Path, state: &ExportState, on_progress: &dyn Fn(ExportProgress)) -> Result<ExportResult, ExportError> {
    if state.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(ExportError::new("busy", "An export is already running.", ""));
    }
    let _running = RunningGuard(&state.running);
    validate_job(&job).map_err(|e| ExportError::new("invalid_project", "This timeline can't be exported.", &e))?;
    for (n, c) in job.clips.iter().enumerate() {
        validate_on(&c.preset, job.canvas.w as f64, job.canvas.h as f64).map_err(|e| ExportError::new("invalid_preset", "This preset can't be exported.", &format!("clip {}: {e}", n + 1)))?;
        crate::audio_mix::validate_mix(c).map_err(|e| ExportError::new("invalid_audio", "The audio mix can't be exported.", &format!("clip {}: {e}", n + 1)))?;
    }
    let out = mp4_path(&job.output_path)?;
    // The encode goes to `part` and is renamed over `out` only on success, so a failure or cancel never touches
    // an existing file. Neither may be a clip source: that is the user's only copy of the recording.
    let part = part_path(&out);
    if job.clips.iter().any(|c| same_file(&out, Path::new(&c.source)) || same_file(&part, Path::new(&c.source))) {
        return Err(ExportError::new("same_as_source", "Pick a different file name — this is one of your clips.", &out.to_string_lossy()));
    }
    let out_dir = out.parent().map(Path::to_path_buf).unwrap_or_default();
    if !is_dir_writable(&out_dir) {
        return Err(ExportError::new("not_writable", "Can't save to this folder. Pick another one.", &out_dir.to_string_lossy()));
    }
    let primary = encoders.primary().ok_or_else(|| ExportError::new("ffmpeg", "No H.264 encoder found in the bundled ffmpeg.", ""))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let work = work_root.join(format!("export-{stamp}"));
    let assets = write_assets(&job, &work)?;

    state.cancelled.store(false, Ordering::SeqCst);
    let result = match run_once(&job, &assets, primary, &part, state, on_progress) {
        Ok(()) => Ok(false),
        Err(e) if e.code == "ffmpeg" => match encoders.fallback_for(primary) {
            Some(cpu) => {
                let _ = std::fs::remove_file(&part);
                run_once(&job, &assets, cpu, &part, state, on_progress).map(|_| true)
            }
            None => Err(e),
        },
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(&work);
    let result = result.and_then(|used_cpu_fallback| {
        std::fs::rename(&part, &out).map_err(|e| ExportError::new("io", "Couldn't save the export.", &e.to_string()))?;
        Ok(used_cpu_fallback)
    });
    match result {
        Ok(used_cpu_fallback) => Ok(ExportResult { output_path: out.to_string_lossy().into_owned(), used_cpu_fallback }),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::fixtures::{clip, job};
    use crate::job::{Canvas, ClipJob, ClipKind, Overlay, Trim};

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    fn some_encoder() -> EncoderSet {
        EncoderSet { gpu: None, cpu: Some(Encoder::X264) }
    }

    fn writable_job(dir: &Path) -> ExportJob {
        let mut j = job();
        j.output_path = dir.join("out.mp4").to_string_lossy().into_owned();
        j
    }

    #[test]
    fn write_assets_names_files_per_clip_and_keeps_overlay_starts() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.clips[0].layer_masks.insert("killfeed".into(), PNG_1X1.into());
        j.clips[0].overlays = vec![Overlay { png_base64: PNG_1X1.into(), start: 0.0 }, Overlay { png_base64: PNG_1X1.into(), start: 4.0 }];
        j.clips.push(clip());
        j.clips[1].overlays = vec![Overlay { png_base64: PNG_1X1.into(), start: 1.0 }];
        let a = write_assets(&j, dir.path()).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].masks[0].0, "killfeed");
        assert!(a[0].masks[0].1.ends_with("c0-mask-1.png"));
        assert_eq!(a[0].overlays.iter().map(|o| o.1).collect::<Vec<_>>(), [0.0, 4.0]);
        assert!(a[1].overlays[0].0.ends_with("c1-overlay-0.png"));
        assert!(std::fs::read(&a[0].overlays[1].0).unwrap().starts_with(b"\x89PNG"));
    }

    #[test]
    fn write_assets_writes_gain_curves_for_enabled_tracks_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.clips[0].clip.audio_tracks = vec![crate::job::AudioTrackInfo { index: 0, label: "G".into(), named: true, channels: 2 }];
        j.clips[0].audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
        j.clips[0].gain_curves.insert(0, "AACAPw==".into()); // one f32 = 1.0
        let mut frz = j.clips[0].clone();
        frz.kind = ClipKind::Freeze;
        j.clips.push(frz);
        let a = write_assets(&j, dir.path()).unwrap();
        assert_eq!(std::fs::read(&a[0].gains[0].1).unwrap(), 1.0f32.to_le_bytes());
        assert!(a[0].gains[0].1.ends_with("c0-gain-0.f32"));
        assert!(a[1].gains.is_empty(), "freeze frames are silent");
    }

    #[test]
    fn bad_base64_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.clips[0].layer_masks.insert("killfeed".into(), "%%%".into());
        assert_eq!(write_assets(&j, dir.path()).err().unwrap().code, "io");
    }

    #[test]
    fn an_empty_timeline_is_an_invalid_project() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = writable_job(dir.path());
        j.clips.clear();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "invalid_project");
    }

    #[test]
    fn invalid_audio_names_the_clip() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = writable_job(dir.path());
        j.clips.push(clip());
        j.clips[1].clip.audio_tracks = vec![crate::job::AudioTrackInfo { index: 0, label: "G".into(), named: true, channels: 2 }];
        j.clips[1].audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "invalid_audio");
        assert!(e.details.starts_with("clip 2:"), "{}", e.details);
    }

    #[test]
    fn invalid_preset_is_rejected_before_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = writable_job(dir.path());
        j.clips[0].preset.layers.clear();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "invalid_preset");
    }

    #[test]
    fn missing_output_folder_is_not_writable() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.output_path = dir.path().join("nope").join("out.mp4").to_string_lossy().into_owned();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "not_writable");
    }

    #[test]
    fn no_encoder_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let e = run_export(writable_job(dir.path()), &EncoderSet::default(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert!(e.message.contains("No H.264 encoder"));
    }

    #[test]
    fn second_export_while_one_runs_is_rejected_as_busy() {
        let dir = tempfile::tempdir().unwrap();
        let state = ExportState::default();
        state.running.store(true, Ordering::SeqCst);
        let e = run_export(writable_job(dir.path()), &some_encoder(), dir.path(), &state, &|_| {}).unwrap_err();
        assert_eq!(e.code, "busy");
        assert!(state.running.load(Ordering::SeqCst), "the running export keeps its flag");
    }

    #[test]
    fn running_flag_is_released_after_an_export_ends() {
        let dir = tempfile::tempdir().unwrap();
        let state = ExportState::default();
        let mut j = writable_job(dir.path());
        j.clips[0].preset.layers.clear();
        let _ = run_export(j, &some_encoder(), dir.path(), &state, &|_| {});
        assert!(!state.running.load(Ordering::SeqCst));
    }

    fn source_job(dir: &Path, output: &Path) -> (ExportJob, PathBuf) {
        let src = dir.join("My Clip.mp4");
        std::fs::write(&src, b"original recording").unwrap();
        let mut j = job();
        j.clips[0].source = src.to_string_lossy().into_owned();
        j.output_path = output.to_string_lossy().into_owned();
        (j, src)
    }

    #[test]
    fn exporting_over_a_source_clip_is_refused_and_leaves_it_intact() {
        let dir = tempfile::tempdir().unwrap();
        let (j, src) = source_job(dir.path(), &dir.path().join("My Clip.mp4"));
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "same_as_source");
        assert_eq!(e.message, "Pick a different file name — this is one of your clips.");
        assert_eq!(std::fs::read(&src).unwrap(), b"original recording");
    }

    #[cfg(windows)]
    #[test]
    fn exporting_over_a_source_clip_spelled_differently_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let other = PathBuf::from(dir.path().to_string_lossy().to_uppercase().replace('\\', "/")).join("my clip.MP4");
        let (j, src) = source_job(dir.path(), &other);
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "same_as_source");
        assert_eq!(std::fs::read(&src).unwrap(), b"original recording");
    }

    #[test]
    fn a_source_clip_named_like_the_temp_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (mut j, src) = source_job(dir.path(), &dir.path().join("out.mp4"));
        let part = dir.path().join("out.part.mp4");
        std::fs::rename(&src, &part).unwrap();
        j.clips[0].source = part.to_string_lossy().into_owned();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "same_as_source");
        assert_eq!(std::fs::read(&part).unwrap(), b"original recording");
    }

    #[test]
    fn a_failed_export_keeps_the_file_it_would_have_replaced() {
        // The fixture source doesn't exist, so ffmpeg fails (or can't even start without one on PATH).
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.mp4");
        std::fs::write(&out, b"last week's export").unwrap();
        let e = run_export(writable_job(dir.path()), &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "ffmpeg");
        assert_eq!(std::fs::read(&out).unwrap(), b"last week's export");
        assert!(!dir.path().join("out.part.mp4").exists(), "temp file removed");
    }

    fn make_source(dir: &Path, name: &str, lavfi: &str, audio: bool) -> String {
        let src = dir.join(name);
        let mut c = tool_command("ffmpeg");
        c.args(["-hide_banner", "-y", "-f", "lavfi", "-i", lavfi]);
        if audio {
            c.args(["-f", "lavfi", "-i", "sine=d=6", "-c:a", "aac"]);
        }
        assert!(c.args(["-c:v", "mpeg4"]).arg(&src).status().unwrap().success());
        src.to_string_lossy().into_owned()
    }

    fn ones(t: &Trim) -> String {
        let n = crate::audio_mix::curve_samples(t);
        base64::engine::general_purpose::STANDARD.encode(vec![1.0f32; n].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
    }

    /// Needs a real ffmpeg on PATH (Homebrew on the Mac) or SOCIALFRAG_FFMPEG_DIR. Run: cargo test -- --ignored
    /// Four clips: 1080p60 with audio, a freeze frame, 1440p120 without audio at 2x, the first source again at 0.5x.
    #[test]
    #[ignore]
    fn real_timeline_export() {
        let dir = tempfile::tempdir().unwrap();
        let a = make_source(dir.path(), "a clip é.mp4", "testsrc2=s=1920x1080:r=60:d=6", true);
        let b = make_source(dir.path(), "b.mp4", "testsrc2=s=2560x1440:r=120:d=4", false);
        let probe = |p: &str| crate::probe::probe_clip_file(p).unwrap();
        let with_audio = |mut c: ClipJob| {
            c.audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
            c.gain_curves.insert(0, ones(&c.trim));
            c
        };
        let base = |src: &str, in_s: f64, out_s: f64, speed: f64, kind: ClipKind| ClipJob { kind, source: src.into(), clip: probe(src), trim: Trim { in_s, out_s }, speed, ..clip() };
        let mut j = job();
        j.output_path = dir.path().join("timeline.mp4").to_string_lossy().into_owned();
        j.clips = vec![
            with_audio(base(&a, 0.5, 2.5, 1.0, ClipKind::Video)), // 2 s
            base(&a, 1.0, 2.0, 1.0, ClipKind::Freeze),            // 1 s
            base(&b, 0.0, 2.0, 2.0, ClipKind::Video),             // 1 s
            with_audio(base(&a, 1.0, 3.0, 0.5, ClipKind::Video)), // 4 s
        ];
        j.clips[0].overlays = vec![Overlay { png_base64: PNG_1X1.into(), start: 1.0 }];
        let encoders = crate::encoders::detect(&crate::ffmpeg::RealRunner);
        let last = std::sync::Mutex::new(0.0);
        let r = run_export(j, &encoders, dir.path(), &ExportState::default(), &|p| *last.lock().unwrap() = p.fraction).unwrap_or_else(|e| panic!("{} {}", e.message, e.details));
        assert!(r.output_path.ends_with("timeline.mp4"));
        assert!(!dir.path().join("timeline.part.mp4").exists(), "temp file renamed away");
        assert_eq!(*last.lock().unwrap(), 1.0);
        let info = crate::probe::probe_clip_file(&r.output_path).unwrap();
        assert_eq!((info.width, info.height, info.fps.as_str()), (1080, 1920, "60/1"));
        assert!((info.duration - 8.0).abs() < 0.2, "duration {}", info.duration);
        assert_eq!(info.audio_tracks.len(), 1, "exactly one mixed audio track");
    }

    /// Exports a 15 s slice of every .mp4 in SOCIALFRAG_CLIPS_DIR with the built-in WARDOGS preset.
    /// Run single-threaded: both tests export the same clip into the same folder.
    /// Run: SOCIALFRAG_CLIPS_DIR="../example clips" SOCIALFRAG_OUT_DIR=/tmp/out cargo test real_clip -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn real_clips_export_with_wardogs() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let preset: crate::preset::Preset = serde_json::from_str(include_str!("../../src/presets/builtin/wardogs.json")).unwrap();
        let encoders = crate::encoders::detect(&crate::ffmpeg::RealRunner);
        let work = tempfile::tempdir().unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        assert!(!files.is_empty(), "no .mp4 in {clips}");
        for src in files {
            let source = src.to_string_lossy().into_owned();
            let info = crate::probe::probe_clip_file(&source).unwrap();
            let trim = Trim { in_s: 30.0, out_s: 45.0 };
            let tracks: Vec<crate::audio_mix::TrackMix> = info
                .audio_tracks
                .iter()
                .map(|a| crate::audio_mix::TrackMix { index: a.index, enabled: !a.label.to_lowercase().contains("desktop"), ceiling_db: Some(-3.0), offset_s: 0.0 })
                .collect();
            let gain_curves = tracks.iter().filter(|t| t.enabled).map(|t| (t.index, ones(&trim))).collect();
            let c = ClipJob { source: source.clone(), clip: info, preset: preset.clone(), trim, audio: crate::audio_mix::AudioMix { tracks }, gain_curves, ..clip() };
            let stem = src.file_stem().unwrap().to_string_lossy().into_owned();
            let j = ExportJob { clips: vec![c], output_path: format!("{out_dir}/{stem}_vertical.mp4"), ..job() };
            let t = Instant::now();
            let r = run_export(j, &encoders, work.path(), &ExportState::default(), &|_| {}).unwrap_or_else(|e| panic!("{source}: {} {}", e.message, e.details));
            assert!(!part_path(Path::new(&r.output_path)).exists(), "temp file renamed away");
            let out = crate::probe::probe_clip_file(&r.output_path).unwrap();
            println!("{} -> {}x{} {} {:.2}s in {:.1}s", src.file_name().unwrap().to_string_lossy(), out.width, out.height, out.fps, out.duration, t.elapsed().as_secs_f64());
            assert_eq!((out.width, out.height), (1080, 1920));
            assert!((out.duration - 15.0).abs() < 0.2);
            assert!(out.has_audio);
            assert_eq!(out.audio_tracks.len(), 1, "exactly one mixed audio track");
        }
    }

    /// Landscape: 10 s of the first clip in SOCIALFRAG_CLIPS_DIR at 1080p and 1440p. Same env vars as above.
    #[test]
    #[ignore]
    fn real_clip_landscape_exports() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let source = files[0].to_string_lossy().into_owned();
        let info = crate::probe::probe_clip_file(&source).unwrap();
        let encoders = crate::encoders::detect(&crate::ffmpeg::RealRunner);
        for (w, h) in [(1920u32, 1080u32), (2560, 1440)] {
            let mut c = clip();
            c.source = source.clone();
            c.clip = info.clone();
            c.trim = Trim { in_s: 30.0, out_s: 40.0 };
            c.preset.background = crate::preset::Background::None;
            c.preset.layers.truncate(1);
            c.preset.layers[0].src = [0.0, 0.0, 1.0, 1.0];
            c.preset.layers[0].dst = [0.0, 0.0, w as f64, h as f64];
            c.preset.layers[0].fit = crate::preset::Fit::Contain;
            let j = ExportJob { clips: vec![c], canvas: Canvas { w, h }, output_path: format!("{out_dir}/landscape_{h}p.mp4"), ..job() };
            let work = tempfile::tempdir().unwrap();
            let r = run_export(j, &encoders, work.path(), &ExportState::default(), &|_| {}).unwrap_or_else(|e| panic!("{} {}", e.message, e.details));
            let out = crate::probe::probe_clip_file(&r.output_path).unwrap();
            println!("{}x{} -> {}x{} {:.2}s", w, h, out.width, out.height, out.duration);
            assert_eq!((out.width, out.height), (w, h));
            assert!((out.duration - 10.0).abs() < 0.2);
        }
    }

    /// Mutes 5–8 s of the output on the first clip's "Game" track. Same env vars as above.
    /// Run: SOCIALFRAG_CLIPS_DIR="../example clips" SOCIALFRAG_OUT_DIR=/tmp/out cargo test real_clip -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn real_clip_mute_range_is_silent() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let source = files[0].to_string_lossy().into_owned();
        let info = crate::probe::probe_clip_file(&source).unwrap();
        let game = info.audio_tracks.iter().find(|a| a.label == "Game").expect("clip has a Game track").index;
        let trim = Trim { in_s: 30.0, out_s: 45.0 };
        let curve: Vec<f32> = (0..crate::audio_mix::curve_samples(&trim)).map(|i| if (1000..1600).contains(&i) { 0.0 } else { 1.0 }).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(curve.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        let mut c = clip();
        c.source = source;
        c.clip = info;
        c.preset = serde_json::from_str(include_str!("../../src/presets/builtin/wardogs.json")).unwrap();
        c.trim = trim;
        c.audio = crate::audio_mix::AudioMix { tracks: vec![crate::audio_mix::TrackMix { index: game, enabled: true, ceiling_db: None, offset_s: 0.0 }] };
        c.gain_curves.insert(game, b64);
        let j = ExportJob { clips: vec![c], output_path: format!("{out_dir}/mute_check.mp4"), ..job() };
        let work = tempfile::tempdir().unwrap();
        let r = run_export(j, &crate::encoders::detect(&crate::ffmpeg::RealRunner), work.path(), &ExportState::default(), &|_| {}).unwrap();
        let max_db = |ss: &str, t: &str| -> f64 {
            let o = tool_command("ffmpeg").args(["-hide_banner", "-nostats", "-ss", ss, "-t", t, "-i", &r.output_path, "-vn", "-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
            let e = String::from_utf8_lossy(&o.stderr);
            let line = e.lines().find(|l| l.contains("max_volume")).expect("volumedetect output");
            line.split("max_volume:").nth(1).unwrap().trim().trim_end_matches(" dB").parse().unwrap()
        };
        assert!(max_db("5.2", "2.6") < -60.0, "muted window should be silent");
        assert!(max_db("0", "4.5") > -50.0, "unmuted window should have audio");
    }

    #[test]
    fn caption_frames_become_an_ffconcat_list_with_the_last_file_repeated() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        let png = base64::engine::general_purpose::STANDARD.encode(b"png");
        j.clips[0].caption_frames = (0..300).map(|i| crate::job::CaptionFrame { png_base64: png.clone(), start: i as f64 * 0.1, end: (i + 1) as f64 * 0.1 }).collect();
        let a = write_assets(&j, dir.path()).unwrap();
        let list = std::fs::read_to_string(a[0].captions.as_ref().unwrap()).unwrap();
        assert!(list.starts_with("ffconcat version 1.0\n"));
        assert_eq!(list.matches("duration 0.100").count(), 300);
        assert_eq!(list.matches("file 'c0-cap-").count(), 301, "last file repeated so its duration applies");
    }

    #[test]
    fn no_caption_frames_means_no_caption_list() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write_assets(&job(), dir.path()).unwrap()[0].captions.is_none());
    }


    /// Timed caption frames through real ffmpeg: blank 0-2 s, red 2-5 s, blank 5-10 s. Same env vars as the other real tests.
    #[test]
    #[ignore]
    fn real_clip_exports_timed_captions() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let work = tempfile::tempdir().unwrap();
        let png = |name: &str, color: &str| -> String {
            let p = work.path().join(name);
            let st = tool_command("ffmpeg").args(["-hide_banner", "-y", "-f", "lavfi", "-i", &format!("color=c={color}:s=1080x1920,format=rgba"), "-frames:v", "1"]).arg(&p).output().unwrap();
            assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stderr));
            base64::engine::general_purpose::STANDARD.encode(std::fs::read(p).unwrap())
        };
        let (blank, red) = (png("blank.png", "black@0.0"), png("red.png", "red"));
        let mut c = clip();
        c.source = files[0].to_string_lossy().into_owned();
        c.clip = crate::probe::probe_clip_file(&c.source).unwrap();
        c.trim = Trim { in_s: 30.0, out_s: 40.0 };
        c.caption_frames = vec![
            crate::job::CaptionFrame { png_base64: blank.clone(), start: 0.0, end: 2.0 },
            crate::job::CaptionFrame { png_base64: red, start: 2.0, end: 5.0 },
            crate::job::CaptionFrame { png_base64: blank, start: 5.0, end: 10.0 },
        ];
        let j = ExportJob { clips: vec![c], output_path: format!("{out_dir}/timed_captions.mp4"), ..job() };
        let r = run_export(j, &crate::encoders::detect(&crate::ffmpeg::RealRunner), work.path(), &ExportState::default(), &|_| {}).unwrap_or_else(|e| panic!("{} {}", e.message, e.details));
        let out = crate::probe::probe_clip_file(&r.output_path).unwrap();
        assert!((out.duration - 10.0).abs() < 0.2, "duration {}", out.duration);
        let pixel = |t: &str| -> Vec<u8> {
            let o = tool_command("ffmpeg").args(["-hide_banner", "-ss", t, "-i", &r.output_path, "-frames:v", "1", "-vf", "crop=1:1:540:960,format=rgb24", "-f", "rawvideo", "-"]).output().unwrap();
            o.stdout
        };
        let (p1, p3, p7) = (pixel("1"), pixel("3"), pixel("7"));
        println!("pixels at 1 s {p1:?}, 3 s {p3:?}, 7 s {p7:?}");
        assert!(p3[0] > 200 && p3[1] < 60 && p3[2] < 60, "caption shows at 3 s: {p3:?}");
        assert!(!(p7[0] > 200 && p7[1] < 60 && p7[2] < 60), "caption gone at 7 s: {p7:?}");
        assert!(!(p1[0] > 200 && p1[1] < 60 && p1[2] < 60), "caption not yet at 1 s: {p1:?}");
    }

}
