//! One captioning run: per clip and track, cut a 16 kHz WAV with ffmpeg, run whisper-cli, collect words.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::ffmpeg::tool_command;
use crate::whisper::{drop_loops, parse_progress, parse_words, whisper_args, Word};

const STDERR_LINES: usize = 20;
const VOICE_FILTER: &str = "highpass=f=150,lowpass=f=4000,afftdn=nf=-25,dynaudnorm=f=200:g=15";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeItem {
    pub key: String,
    pub source: String,
    pub track: u32,
    pub in_s: f64,
    pub out_s: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranscribeJob {
    pub model: String,
    pub items: Vec<TranscribeItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemWords {
    pub key: String,
    pub words: Vec<Word>,
}

/// Items finished before any failure are kept; `error` says why the run stopped early.
#[derive(Debug, Clone, Serialize)]
pub struct TranscribeOutcome {
    pub items: Vec<ItemWords>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct TranscribeState {
    pub child: Mutex<Option<Child>>,
    pub cancelled: AtomicBool,
    /// One run (or model download) at a time: a second would overwrite `child` and cancel the wrong process.
    pub running: AtomicBool,
}

impl TranscribeState {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

/// Runs a bundled tool to completion, streaming stderr lines. Err carries the stderr tail.
pub trait Tools {
    fn run(&self, name: &str, args: &[String], state: &TranscribeState, on_line: &dyn Fn(&str)) -> Result<(), String>;
}

pub struct RealTools;

impl Tools for RealTools {
    fn run(&self, name: &str, args: &[String], state: &TranscribeState, on_line: &dyn Fn(&str)) -> Result<(), String> {
        let mut child = tool_command(name)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("couldn't start {name}: {e}"))?;
        let stderr = child.stderr.take().expect("stderr piped");
        *state.child.lock().unwrap() = Some(child);
        if state.cancelled.load(Ordering::SeqCst) {
            state.cancel(); // cancel arrived while spawning
        }
        let mut tail = VecDeque::with_capacity(STDERR_LINES);
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            on_line(&line);
            if tail.len() == STDERR_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
        let status = state.child.lock().unwrap().take().map(|mut c| c.wait());
        match status {
            Some(Ok(s)) if s.success() => Ok(()),
            other => Err(format!("{name} args: {}\nstatus: {:?}\n{}", args.join(" "), other.map(|r| r.map(|s| s.code())), Vec::from(tail).join("\n"))),
        }
    }
}

pub fn wav_args(item: &TranscribeItem, wav: &Path) -> Vec<String> {
    let s = |v: f64| format!("{v:.3}");
    ["-hide_banner", "-nostdin", "-y", "-ss"].map(String::from).into_iter()
        .chain([s(item.in_s), "-t".into(), s(item.out_s - item.in_s), "-i".into(), item.source.clone(), "-map".into(), format!("0:a:{}", item.track)])
        // Voice band, noise reduction and levelling: game voice sits under gunfire and engines.
        .chain(["-af", VOICE_FILTER, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"].map(String::from))
        .chain([wav.to_string_lossy().into_owned()])
        .collect()
}

/// Deletes this run's work files on every exit path.
struct WorkFiles(Vec<PathBuf>);

impl Drop for WorkFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Words per item in source seconds. Err("cancelled") on cancel (nothing kept); a tool failure stops the run and
/// returns the items finished so far with `error` = "Captioning failed.\n…".
pub fn run_transcribe(job: &TranscribeJob, model: &Path, work: &Path, tools: &dyn Tools, state: &TranscribeState, on_progress: &dyn Fn(f64)) -> Result<TranscribeOutcome, String> {
    state.cancelled.store(false, Ordering::SeqCst);
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let n = job.items.len().max(1) as f64;
    let mut out = Vec::new();
    for (i, item) in job.items.iter().enumerate() {
        match transcribe_item(i, item, n, model, work, tools, state, on_progress) {
            Ok(words) => out.push(ItemWords { key: item.key.clone(), words }),
            Err(e) if e == "cancelled" => return Err(e),
            Err(e) => return Ok(TranscribeOutcome { items: out, error: Some(e) }),
        }
    }
    on_progress(1.0);
    Ok(TranscribeOutcome { items: out, error: None })
}

#[allow(clippy::too_many_arguments)]
fn transcribe_item(i: usize, item: &TranscribeItem, n: f64, model: &Path, work: &Path, tools: &dyn Tools, state: &TranscribeState, on_progress: &dyn Fn(f64)) -> Result<Vec<Word>, String> {
    let wav = work.join(format!("{i}.wav"));
    let base = work.join(format!("{i}"));
    let json = work.join(format!("{i}.json"));
    let _files = WorkFiles(vec![wav.clone(), json.clone()]);
    let step = |r: Result<(), String>| -> Result<(), String> {
        if state.cancelled.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        r.map_err(|e| format!("Captioning failed.\n{e}"))
    };
    step(tools.run("ffmpeg", &wav_args(item, &wav), state, &|_| {}))?;
    step(tools.run("whisper-cli", &whisper_args(model, &wav, &base), state, &|l| {
        if let Some(f) = parse_progress(l) {
            on_progress((i as f64 + f) / n);
        }
    }))?;
    let text = std::fs::read_to_string(&json).map_err(|e| format!("Captioning failed.\n{}: {e}", json.display()))?;
    let mut words = drop_loops(parse_words(&text).map_err(|e| format!("Captioning failed.\n{e}"))?);
    for w in &mut words {
        w.start_s += item.in_s;
        w.end_s += item.in_s;
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn item(key: &str) -> TranscribeItem {
        TranscribeItem { key: key.into(), source: "/c/in.mp4".into(), track: 3, in_s: 30.0, out_s: 40.0 }
    }

    #[test]
    fn wav_args_cut_the_track_range_to_16k_mono() {
        let a = wav_args(&item("k"), Path::new("/t/k.wav"));
        assert_eq!(a, ["-hide_banner", "-nostdin", "-y", "-ss", "30.000", "-t", "10.000", "-i", "/c/in.mp4", "-map", "0:a:3", "-af", "highpass=f=150,lowpass=f=4000,afftdn=nf=-25,dynaudnorm=f=200:g=15", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/t/k.wav"]);
    }

    /// ffmpeg: touch the wav. whisper-cli: write the sample JSON next to -of, print progress.
    struct Fake { calls: RefCell<Vec<String>>, fail_whisper: bool, cancel_on_first: Option<std::sync::Arc<TranscribeState>>, fail_from: Option<usize> }
    impl Tools for Fake {
        fn run(&self, name: &str, args: &[String], state: &TranscribeState, on_line: &dyn Fn(&str)) -> Result<(), String> {
            self.calls.borrow_mut().push(name.into());
            if name == "ffmpeg" {
                std::fs::write(args.last().unwrap(), b"RIFF").unwrap();
                return Ok(());
            }
            if let Some(s) = &self.cancel_on_first { s.cancel(); let _ = state; return Err("killed".into()); }
            let whispers = self.calls.borrow().iter().filter(|c| *c == "whisper-cli").count();
            if self.fail_whisper || self.fail_from.is_some_and(|n| whispers >= n) { return Err("exit 1".into()); }
            on_line("whisper_print_progress_callback: progress =  50%");
            let of = &args[args.iter().position(|a| a == "-of").unwrap() + 1];
            std::fs::write(format!("{of}.json"), include_str!("testdata/whisper-sample.json")).unwrap();
            Ok(())
        }
    }

    #[test]
    fn words_come_back_in_source_seconds_per_item_and_temp_files_are_removed() {
        let work = tempfile::tempdir().unwrap();
        let job = TranscribeJob { model: "base.en".into(), items: vec![item("a"), item("b")] };
        let tools = Fake { calls: RefCell::new(vec![]), fail_whisper: false, cancel_on_first: None, fail_from: None };
        let last = std::sync::Mutex::new(0.0);
        let out = run_transcribe(&job, Path::new("/m.bin"), work.path(), &tools, &TranscribeState::default(), &|f| *last.lock().unwrap() = f).unwrap().items;
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].key, "a");
        assert_eq!((out[0].words[0].text.as_str(), out[0].words[0].start_s), ("Nice", 30.0));
        assert_eq!(*tools.calls.borrow(), ["ffmpeg", "whisper-cli", "ffmpeg", "whisper-cli"]);
        assert_eq!(*last.lock().unwrap(), 1.0);
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    }

    #[test]
    fn cancel_returns_cancelled_and_removes_temp_files() {
        let work = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(TranscribeState::default());
        let tools = Fake { calls: RefCell::new(vec![]), fail_whisper: false, cancel_on_first: Some(state.clone()), fail_from: None };
        let job = TranscribeJob { model: "base.en".into(), items: vec![item("a")] };
        let err = run_transcribe(&job, Path::new("/m.bin"), work.path(), &tools, &state, &|_| {}).unwrap_err();
        assert_eq!(err, "cancelled");
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_whisper_failure_is_reported_with_details() {
        let work = tempfile::tempdir().unwrap();
        let tools = Fake { calls: RefCell::new(vec![]), fail_whisper: true, cancel_on_first: None, fail_from: None };
        let job = TranscribeJob { model: "base.en".into(), items: vec![item("a")] };
        let got = run_transcribe(&job, Path::new("/m.bin"), work.path(), &tools, &TranscribeState::default(), &|_| {}).unwrap();
        let err = got.error.unwrap();
        assert!(err.starts_with("Captioning failed."), "{err}");
        assert!(err.contains("exit 1"));
        assert!(got.items.is_empty());
    }
    /// Needs the built whisper-cli (SOCIALFRAG_FFMPEG_DIR holding ffmpeg + whisper-cli), a downloaded base.en in
    /// SOCIALFRAG_WHISPER_MODEL, and SOCIALFRAG_CLIPS_DIR with the example clips.
    #[test]
    #[ignore]
    fn real_clip_discord_track_has_words() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").unwrap();
        let model = std::env::var("SOCIALFRAG_WHISPER_MODEL").unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let src = files[0].to_string_lossy().into_owned();
        let info = crate::probe::probe_clip_file(&src).unwrap();
        let discord = info.audio_tracks.iter().find(|a| a.label == "Discord").unwrap().index;
        let job = TranscribeJob { model: "base.en".into(), items: vec![TranscribeItem { key: "k".into(), source: src, track: discord, in_s: 80.0, out_s: 100.0 }] };
        let work = tempfile::tempdir().unwrap();
        let out = run_transcribe(&job, Path::new(&model), work.path(), &RealTools, &TranscribeState::default(), &|_| {}).unwrap().items;
        let w = &out[0].words;
        println!("{} words: {:?}", w.len(), w.iter().take(8).map(|w| &w.text).collect::<Vec<_>>());
        assert!(!w.is_empty(), "no words on the Discord track");
        assert!(w.windows(2).all(|p| p[0].start_s <= p[1].start_s));
        assert!(w.len() >= 10, "expected speech in 80-100 s, got {} words", w.len());
        assert!(w.iter().all(|x| x.start_s >= 80.0 - 0.01 && x.end_s <= 100.0 + 0.5));
    }


    #[test]
    fn a_failure_keeps_the_items_finished_before_it() {
        let work = tempfile::tempdir().unwrap();
        let tools = Fake { calls: RefCell::new(vec![]), fail_whisper: false, cancel_on_first: None, fail_from: Some(2) };
        let job = TranscribeJob { model: "base.en".into(), items: vec![item("a"), item("b"), item("c")] };
        let got = run_transcribe(&job, Path::new("/m.bin"), work.path(), &tools, &TranscribeState::default(), &|_| {}).unwrap();
        assert_eq!(got.items.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(), ["a"]);
        assert!(got.error.unwrap().starts_with("Captioning failed."));
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    }


    /// In-game voice under gunfire (Game track of "Replay 2026-09-24 22-52-53", user-confirmed lines 1:00-1:53) and a
    /// noise-only Game track that used to make whisper loop. Needs SOCIALFRAG_WHISPER_MODEL = small.en, same env as above.
    #[test]
    #[ignore]
    fn real_game_voice_under_gunfire() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").unwrap();
        let model = std::env::var("SOCIALFRAG_WHISPER_MODEL").unwrap();
        let game = |name: &str| {
            let src = format!("{clips}/Replay {name}.mp4");
            let info = crate::probe::probe_clip_file(&src).unwrap();
            let track = info.audio_tracks.iter().find(|a| a.label == "Game").unwrap().index;
            TranscribeItem { key: name.into(), source: src, track, in_s: 0.0, out_s: info.duration }
        };
        let job = TranscribeJob { model: "small.en".into(), items: vec![game("2026-09-24 22-52-53"), game("2026-09-24 21-40-41")] };
        let work = tempfile::tempdir().unwrap();
        let out = run_transcribe(&job, Path::new(&model), work.path(), &RealTools, &TranscribeState::default(), &|_| {}).unwrap().items;
        let heard: std::collections::HashSet<String> = out[0].words.iter().map(|w| w.text.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric() && c != '\'').to_string()).collect();
        let real = "possible one more over here didn't kill them both can't handle so many whole squad rpgs pointing every direction should just pick let way thought about tried negotiate know what";
        let hits = real.split(' ').filter(|w| heard.contains(*w)).count();
        println!("22-52-53: {} words, {hits}/{} confirmed words", out[0].words.len(), real.split(' ').count());
        println!("21-40-41: {} words: {:?}", out[1].words.len(), out[1].words.iter().map(|w| &w.text).collect::<Vec<_>>());
        assert!(hits >= 25, "only {hits} confirmed words heard");
        assert!(out[1].words.len() < 40, "noise-only track produced {} words (loop?)", out[1].words.len());
    }

}
