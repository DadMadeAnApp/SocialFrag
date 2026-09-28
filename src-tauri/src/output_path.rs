use std::path::{Path, PathBuf};

use crate::job::ExportError;

/// The path chosen in the Save dialog. Rejected with `bad_extension` unless it already ends in `.mp4` (any case).
pub fn mp4_path(p: &str) -> Result<PathBuf, ExportError> {
    let path = PathBuf::from(p);
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4")) {
        return Ok(path);
    }
    Err(ExportError::new("bad_extension", "The file name must end in .mp4.", p))
}

/// Where the encode is written before it is renamed over `out`: `<stem>.part.mp4` in the same folder, so the rename stays on one volume.
pub fn part_path(out: &Path) -> PathBuf {
    let stem = out.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    out.with_file_name(format!("{stem}.part.mp4"))
}

/// True when both paths exist and resolve to the same file. Case-insensitive on Windows.
pub fn same_file(a: &Path, b: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) else {
        return false;
    };
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

pub fn is_dir_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".socialfrag-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp4_path_accepts_mp4_names_case_insensitively() {
        assert_eq!(mp4_path("C:/v/clip.MP4").unwrap(), PathBuf::from("C:/v/clip.MP4"));
        assert_eq!(mp4_path("C:/v/Bob's é.mp4").unwrap(), PathBuf::from("C:/v/Bob's é.mp4"));
    }

    #[test]
    fn mp4_path_rejects_anything_else() {
        assert_eq!(mp4_path("C:/v/clip.mov").unwrap_err().code, "bad_extension");
        assert_eq!(mp4_path("C:/v/clip").unwrap_err().code, "bad_extension");
        assert_eq!(mp4_path("C:/v/clip").unwrap_err().message, "The file name must end in .mp4.");
    }

    #[test]
    fn part_path_is_a_sibling_mp4() {
        assert_eq!(part_path(Path::new("C:/v/clip.MP4")), PathBuf::from("C:/v/clip.part.mp4"));
        assert_eq!(part_path(Path::new("C:/v/a.b.mp4")), PathBuf::from("C:/v/a.b.part.mp4"));
    }

    #[test]
    fn same_file_needs_both_to_exist() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.mp4");
        std::fs::write(&a, b"x").unwrap();
        assert!(same_file(&a, &dir.path().join(".").join("a.mp4")));
        assert!(!same_file(&a, &dir.path().join("b.mp4")));
    }

    #[test]
    fn writable_checks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_dir_writable(dir.path()));
        assert!(!is_dir_writable(&dir.path().join("missing")));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "probe file cleaned up");
    }
}
