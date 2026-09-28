use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::io::{BufRead, BufReader};
use std::process::Stdio;

use crate::encoders::Encoder;
use crate::ffmpeg::tool_command;
use crate::job::Quality;
use crate::progress::parse_progress_line;

/// Stable per source file (path + size + mtime); used for the proxy and audio caches.
pub fn source_key(source: &Path) -> String {
    let mut h = DefaultHasher::new();
    source.hash(&mut h);
    if let Ok(m) = std::fs::metadata(source) {
        m.len().hash(&mut h);
        if let Ok(t) = m.modified() {
            t.hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}

pub fn proxy_path(cache: &Path, source: &Path) -> PathBuf {
    cache.join("proxies").join(format!("{}.mp4", source_key(source)))
}

/// Proxy args: 720p, at most 60 fps (halves encode time for 120/144 fps captures), H.264 + AAC, progress on stdout.
pub fn proxy_args(source: &Path, part: &Path, enc: Encoder) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", "-i"].map(String::from).to_vec();
    args.push(source.to_string_lossy().into_owned());
    args.extend(["-vf", "scale=-2:720,fps=fps='min(source_fps,60)'"].map(String::from));
    args.extend(enc.args(Quality::Small));
    args.extend(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"].map(String::from));
    args.push(part.to_string_lossy().into_owned());
    args
}

/// 720p H.264 copy for previewing codecs the webview can't play (HEVC without the Store extension on
/// Windows, hev1-tagged HEVC in WebKit). Reports 0..1 progress from ffmpeg's `-progress` output.
pub fn make_proxy_file(cache: &Path, source: &Path, enc: Encoder, duration_s: f64, on_progress: &dyn Fn(f64)) -> Result<PathBuf, String> {
    let out = proxy_path(cache, source);
    if out.exists() {
        on_progress(1.0);
        return Ok(out);
    }
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    let part = out.with_extension("part.mp4");
    let mut child = tool_command("ffmpeg")
        .args(proxy_args(source, &part, enc))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    let mut stderr = child.stderr.take().expect("stderr piped");
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut s);
        s
    });
    let total_us = duration_s * 1_000_000.0;
    for line in BufReader::new(child.stdout.take().expect("stdout piped")).lines().map_while(Result::ok) {
        if line == "progress=end" {
            on_progress(1.0);
        } else if let Some(f) = parse_progress_line(&line, total_us) {
            on_progress(f);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let err = err_thread.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Couldn't prepare a preview.\n{}", err.lines().rev().take(20).collect::<Vec<_>>().join("\n")));
    }
    std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_path_is_stable_and_per_source() {
        let cache = Path::new("/cache");
        let a = proxy_path(cache, Path::new("/v/a.mp4"));
        assert_eq!(a, proxy_path(cache, Path::new("/v/a.mp4")));
        assert_ne!(a, proxy_path(cache, Path::new("/v/b.mp4")));
        assert!(a.starts_with("/cache/proxies"));
        assert_eq!(a.extension().unwrap(), "mp4");
    }

    #[test]
    fn proxy_args_cap_fps_and_report_progress() {
        let a = proxy_args(Path::new("/v/in.mp4"), Path::new("/c/p.part.mp4"), Encoder::X264).join(" ");
        assert!(a.contains("-progress pipe:1"));
        assert!(a.contains("scale=-2:720,fps=fps='min(source_fps,60)'"));
        assert!(a.ends_with("/c/p.part.mp4"));
    }

    /// Needs ffmpeg on PATH. Run: cargo test proxy_real -- --ignored
    #[test]
    #[ignore]
    fn proxy_real_reports_progress_to_one() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.mp4");
        assert!(tool_command("ffmpeg").args(["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=120:d=2", "-c:v", "mpeg4"]).arg(&src).status().unwrap().success());
        let seen = std::sync::Mutex::new(Vec::new());
        let enc = crate::encoders::detect(&crate::ffmpeg::RealRunner).primary().expect("an H.264 encoder");
        let p = make_proxy_file(dir.path(), &src, enc, 2.0, &|f| seen.lock().unwrap().push(f)).unwrap();
        assert!(p.exists());
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.last(), Some(&1.0));
        let info = crate::probe::probe_clip_file(&p.to_string_lossy()).unwrap();
        assert_eq!((info.height, info.fps.as_str()), (720, "60/1"));
    }
}
