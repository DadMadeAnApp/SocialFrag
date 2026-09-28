//! Small JPEG frames for the timeline, cached under `thumbs/<source_key>/<ms>.jpg`.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::ffmpeg::tool_command;
use crate::filtergraph::secs;
use crate::proxy::source_key;

pub const THUMB_HEIGHT: u32 = 96;

pub fn thumb_path(cache: &Path, source: &Path, at_s: f64) -> PathBuf {
    cache.join("thumbs").join(source_key(source)).join(format!("{}.jpg", (at_s * 1000.0).round() as i64))
}

pub fn thumb_args(source: &Path, at_s: f64, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-ss"].map(String::from).to_vec();
    a.push(secs(at_s));
    a.push("-i".into());
    a.push(source.to_string_lossy().into_owned());
    a.extend(["-frames:v", "1", "-vf", &format!("scale=-2:{THUMB_HEIGHT}"), "-q:v", "5"].map(String::from));
    a.push(out.to_string_lossy().into_owned());
    a
}

pub fn make_thumbnail(cache: &Path, source: &Path, at_s: f64) -> Result<PathBuf, String> {
    if !(at_s.is_finite() && at_s >= 0.0) {
        return Err("bad thumbnail time".into());
    }
    let out = thumb_path(cache, source, at_s);
    if out.exists() {
        return Ok(out);
    }
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    let ok = tool_command("ffmpeg").args(thumb_args(source, at_s, &out)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?.success();
    if ok && out.exists() {
        Ok(out)
    } else {
        Err("Couldn't make a thumbnail.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumb_path_is_per_source_and_millisecond() {
        let p = thumb_path(Path::new("/c"), Path::new("/v/a.mp4"), 12.3456);
        assert!(p.starts_with("/c/thumbs"));
        assert!(p.ends_with("12346.jpg"));
    }

    #[test]
    fn thumb_args_seek_then_grab_one_scaled_frame() {
        let a = thumb_args(Path::new("/v/a b.mp4"), 3.0, Path::new("/c/t.jpg")).join(" ");
        assert_eq!(a, "-hide_banner -nostdin -y -ss 3.000 -i /v/a b.mp4 -frames:v 1 -vf scale=-2:96 -q:v 5 /c/t.jpg");
    }

    #[test]
    fn rejects_negative_or_nan_times() {
        let d = tempfile::tempdir().unwrap();
        assert!(make_thumbnail(d.path(), Path::new("/v/a.mp4"), -1.0).is_err());
        assert!(make_thumbnail(d.path(), Path::new("/v/a.mp4"), f64::NAN).is_err());
    }
}
