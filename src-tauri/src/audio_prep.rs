use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use crate::ffmpeg::tool_command;
use crate::proxy::source_key;

/// 8 kHz mono, 40-sample windows = 5 ms = 200 envelope values per second (matches the TS SAMPLE_RATE).
const ENV_RATE: &str = "8000";
const ENV_WINDOW: usize = 40;
/// Envelope samples are read from the raw ffmpeg output in windows-worth-of-chunks at a time,
/// rather than loading the whole file, to cap memory on long clips.
const ENV_CHUNK_WINDOWS: usize = 4096;

/// Preview playback PCM: interleaved s16le stereo at 48 kHz, so time t is at byte round(t*48000)*4.
pub const PCM_RATE: u32 = 48000;
pub const PCM_BYTES_PER_FRAME: u64 = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTrack {
    pub index: u32,
    pub pcm_path: String,
    pub frames: u64,
    pub envelope_path: String,
}

/// Upper bound on one IPC chunk (5 s) so a bad request can't read a whole file into memory.
pub const MAX_CHUNK_FRAMES: u64 = PCM_RATE as u64 * 5;

pub fn read_pcm_range(path: &Path, start_frame: u64, frames: u64) -> Result<Vec<u8>, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let total = f.metadata().map_err(|e| e.to_string())?.len() / PCM_BYTES_PER_FRAME;
    let start = start_frame.min(total);
    let end = start.saturating_add(frames.min(MAX_CHUNK_FRAMES)).min(total);
    let mut buf = vec![0u8; ((end - start) * PCM_BYTES_PER_FRAME) as usize];
    f.seek(SeekFrom::Start(start * PCM_BYTES_PER_FRAME)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

pub fn audio_dir(cache: &Path, source: &Path) -> PathBuf {
    cache.join("audio").join(source_key(source))
}

pub fn track_paths(dir: &Path, index: u32) -> (PathBuf, PathBuf) {
    (dir.join(format!("track-{index}.pcm")), dir.join(format!("env-{index}.f32")))
}

pub fn rms_envelope(samples: &[f32], window: usize) -> Vec<f32> {
    samples.chunks(window).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect()
}

fn ffmpeg_err(what: &str, stderr: &[u8]) -> String {
    let e = String::from_utf8_lossy(stderr);
    format!("Couldn't prepare {what}.\n{}", e.lines().rev().take(10).collect::<Vec<_>>().join("\n"))
}

fn raw_env_part(env_out: &Path) -> PathBuf {
    let mut name = env_out.file_stem().unwrap_or_default().to_os_string();
    name.push(".part.raw");
    env_out.with_file_name(name)
}

fn pcm_part(audio_out: &Path) -> PathBuf {
    let mut name = audio_out.file_stem().unwrap_or_default().to_os_string();
    name.push(".part.pcm");
    audio_out.with_file_name(name)
}

/// Streams the raw f32le samples in bounded chunks (not the whole file) into RMS envelope
/// windows, writing the result via a .part file renamed on success.
fn compute_envelope_streaming(raw_path: &Path, out: &Path) -> Result<(), String> {
    let mut f = std::fs::File::open(raw_path).map_err(|e| e.to_string())?;
    let window_bytes = ENV_WINDOW * 4;
    let mut buf = vec![0u8; window_bytes * ENV_CHUNK_WINDOWS];
    let mut leftover: Vec<u8> = Vec::new();
    let part = out.with_extension("part");
    let mut outf = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        leftover.extend_from_slice(&buf[..n]);
        let full_windows = leftover.len() / window_bytes;
        let consume = full_windows * window_bytes;
        if consume == 0 {
            continue;
        }
        let samples: Vec<f32> = leftover[..consume].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let bytes: Vec<u8> = rms_envelope(&samples, ENV_WINDOW).iter().flat_map(|v| v.to_le_bytes()).collect();
        outf.write_all(&bytes).map_err(|e| e.to_string())?;
        leftover.drain(..consume);
    }
    if !leftover.is_empty() {
        let samples: Vec<f32> = leftover.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        if !samples.is_empty() {
            let bytes: Vec<u8> = rms_envelope(&samples, ENV_WINDOW).iter().flat_map(|v| v.to_le_bytes()).collect();
            outf.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    drop(outf);
    std::fs::rename(&part, out).map_err(|e| e.to_string())
}

/// One ffmpeg run reads the source once and produces, for every track, both the raw s16le PCM
/// (preview playback) and the raw f32 mono samples the envelope is computed from — instead
/// of reading the whole source twice per track.
fn generate_all(source: &Path, count: u32, paths: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let pcm_parts: Vec<PathBuf> = paths.iter().map(|(a, _)| pcm_part(a)).collect();
    let raw_parts: Vec<PathBuf> = paths.iter().map(|(_, e)| raw_env_part(e)).collect();

    let mut cmd = tool_command("ffmpeg");
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(source);
    for i in 0..count as usize {
        cmd.args(["-map", &format!("0:a:{i}"), "-vn", "-ac", "2", "-ar", &PCM_RATE.to_string(), "-f", "s16le"]).arg(&pcm_parts[i]);
    }
    for i in 0..count as usize {
        cmd.args(["-map", &format!("0:a:{i}"), "-vn", "-ac", "1", "-ar", ENV_RATE, "-f", "f32le"]).arg(&raw_parts[i]);
    }
    let cleanup = |parts: &[PathBuf]| {
        for p in parts {
            let _ = std::fs::remove_file(p);
        }
    };
    let r = cmd.stdin(Stdio::null()).output().map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    if !r.status.success() {
        cleanup(&pcm_parts);
        cleanup(&raw_parts);
        return Err(ffmpeg_err("audio tracks", &r.stderr));
    }

    for (i, (_, env_out)) in paths.iter().enumerate() {
        if let Err(e) = compute_envelope_streaming(&raw_parts[i], env_out) {
            cleanup(&pcm_parts);
            cleanup(&raw_parts);
            return Err(e);
        }
    }
    cleanup(&raw_parts);
    for (i, (audio_out, _)) in paths.iter().enumerate() {
        std::fs::rename(&pcm_parts[i], audio_out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Drop `track-*.m4a` left by the build that previewed from AAC; nothing reads them now.
fn remove_legacy_m4a(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("track-") && name.ends_with(".m4a") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Per-track raw PCM (preview) plus a 200 Hz RMS envelope (waveforms, ducking). Cached per source.
/// Skips the ffmpeg run entirely when every output already exists; if only some exist, regenerates all of them.
pub fn prepare_audio_files(cache: &Path, source: &Path, count: u32) -> Result<Vec<PreparedTrack>, String> {
    let dir = audio_dir(cache, source);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let paths: Vec<(PathBuf, PathBuf)> = (0..count).map(|i| track_paths(&dir, i)).collect();
    let all_exist = paths.iter().all(|(a, e)| a.exists() && e.exists());
    if !all_exist {
        generate_all(source, count, &paths)?;
        remove_legacy_m4a(&dir);
    }
    paths
        .into_iter()
        .enumerate()
        .map(|(i, (pcm, env))| {
            let bytes = std::fs::metadata(&pcm).map_err(|e| e.to_string())?.len();
            Ok(PreparedTrack { index: i as u32, pcm_path: pcm.to_string_lossy().into_owned(), frames: bytes / PCM_BYTES_PER_FRAME, envelope_path: env.to_string_lossy().into_owned() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_pcm_range_clamps_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.pcm");
        let bytes: Vec<u8> = (0..40u8).collect(); // 10 frames
        std::fs::write(&p, &bytes).unwrap();
        assert_eq!(read_pcm_range(&p, 2, 3).unwrap(), bytes[8..20].to_vec());
        assert_eq!(read_pcm_range(&p, 8, 5).unwrap(), bytes[32..40].to_vec());
        assert!(read_pcm_range(&p, 10, 5).unwrap().is_empty());
        assert!(read_pcm_range(&p, 99, 5).unwrap().is_empty());
    }

    #[test]
    fn read_pcm_range_ignores_a_truncated_trailing_frame() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.pcm");
        std::fs::write(&p, [1u8; 10]).unwrap(); // 2 whole frames + 2 stray bytes
        assert_eq!(read_pcm_range(&p, 0, 10).unwrap().len(), 8);
    }

    #[test]
    fn rms_envelope_windows_and_partial_tail() {
        let mut s = vec![0.5f32; 40];
        s.extend(vec![0.0f32; 40]);
        s.extend(vec![1.0f32; 10]);
        let e = rms_envelope(&s, 40);
        assert_eq!(e.len(), 3);
        assert!((e[0] - 0.5).abs() < 1e-6);
        assert_eq!(e[1], 0.0);
        assert!((e[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cache_paths_are_per_source_and_track() {
        let d = audio_dir(Path::new("/cache"), Path::new("/v/a.mp4"));
        assert!(d.starts_with("/cache/audio"));
        assert_ne!(d, audio_dir(Path::new("/cache"), Path::new("/v/b.mp4")));
        assert!(track_paths(&d, 2).0.ends_with("track-2.pcm"));
        assert!(track_paths(&d, 2).1.ends_with("env-2.f32"));
    }

    /// Needs ffmpeg on PATH. A cache dir left by the m4a build (no .pcm) must regenerate.
    #[test]
    #[ignore]
    fn regenerates_when_pcm_missing() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("one.mp4");
        assert!(crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "aac"])
            .arg(&src).status().unwrap().success());
        let adir = audio_dir(dir.path(), &src);
        std::fs::create_dir_all(&adir).unwrap();
        std::fs::write(adir.join("track-0.m4a"), b"old").unwrap();
        std::fs::write(adir.join("env-0.f32"), [0u8; 8]).unwrap();
        let t = prepare_audio_files(dir.path(), &src, 1).unwrap();
        assert!(std::path::Path::new(&t[0].pcm_path).exists());
        assert!((47_000..=49_100).contains(&t[0].frames), "frames {}", t[0].frames);
        assert!(!adir.join("track-0.m4a").exists(), "stale m4a left behind");
    }

    /// Needs ffmpeg on PATH. Run: cargo test prepare_real -- --ignored
    #[test]
    #[ignore]
    fn prepare_real_two_track_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("two.mp4");
        let ok = crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "anullsrc=d=2", "-map", "0:a", "-map", "1:a", "-c:a", "aac"])
            .arg(&src).status().unwrap().success();
        assert!(ok);
        let t = prepare_audio_files(dir.path(), &src, 2).unwrap();
        assert_eq!(t.len(), 2);
        let env0 = std::fs::read(&t[0].envelope_path).unwrap();
        let env1 = std::fs::read(&t[1].envelope_path).unwrap();
        let windows = env0.len() / 4;
        assert!((398..=410).contains(&windows), "got {windows} windows");
        let loud = f32::from_le_bytes(env0[400..404].try_into().unwrap());
        let quiet = f32::from_le_bytes(env1[400..404].try_into().unwrap());
        assert!(loud > 0.05 && quiet < 0.001);
        let pcm1 = std::fs::metadata(&t[1].pcm_path).unwrap().len();
        assert_eq!(pcm1 % PCM_BYTES_PER_FRAME, 0);
        assert_eq!(t[1].frames, pcm1 / PCM_BYTES_PER_FRAME);
        assert!((95_000..=97_100).contains(&t[0].frames), "2 s at 48 kHz, got {}", t[0].frames);
    }

    /// PCM written by the multi-output run is byte-identical to a direct single-track decode.
    /// Run: cargo test pcm_matches_direct_decode -- --ignored
    #[test]
    #[ignore]
    fn pcm_matches_direct_decode() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("two.mp4");
        assert!(crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "sine=f=220:d=2", "-map", "0:a", "-map", "1:a", "-c:a", "aac"])
            .arg(&src).status().unwrap().success());
        let t = prepare_audio_files(dir.path(), &src, 2).unwrap();
        let direct = crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-nostdin", "-i"]).arg(&src)
            .args(["-map", "0:a:1", "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "-"])
            .output().unwrap().stdout;
        assert_eq!(std::fs::read(&t[1].pcm_path).unwrap(), direct);
    }

    /// Needs SOCIALFRAG_CLIPS_DIR pointing at a folder of real 4-track clips (git-ignored "example clips/").
    /// Run: SOCIALFRAG_CLIPS_DIR="../example clips" cargo test prepare_real_clip_under_3s -- --ignored
    #[test]
    #[ignore]
    fn prepare_real_clip_under_3s() {
        let clips_dir = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let src = std::fs::read_dir(&clips_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some("mp4"))
            .expect("no .mp4 in SOCIALFRAG_CLIPS_DIR");
        let dir = tempfile::tempdir().unwrap();
        let start = std::time::Instant::now();
        let t = prepare_audio_files(dir.path(), &src, 4).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(t.len(), 4);
        assert!(elapsed.as_secs_f64() < 3.0, "took {:.2}s", elapsed.as_secs_f64());
    }
}
