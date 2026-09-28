use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RawPresetFile {
    pub file: String,
    pub contents: String,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn list(dir: &Path) -> Result<Vec<RawPresetFile>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file = path.file_name().unwrap().to_string_lossy().into_owned();
        // Unreadable files come back empty so the UI lists them as a warning.
        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        out.push(RawPresetFile { file, contents });
    }
    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

pub fn save(dir: &Path, id: &str, contents: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("invalid preset id {id}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{id}.json")), contents).map_err(|e| e.to_string())
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("invalid preset id {id}"));
    }
    std::fs::remove_file(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
}

const MAX_PRESET_BYTES: u64 = 1024 * 1024;
const VIDEO_EXTS: [&str; 5] = ["mp4", "mkv", "mov", "webm", "avi"];

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension().and_then(|e| e.to_str()).map(|e| exts.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// Only clip files may be probed and exposed to the webview through the asset protocol.
pub fn is_video_path(path: &str) -> bool {
    has_ext(Path::new(path), &VIDEO_EXTS)
}

pub fn read_preset_file(path: &Path) -> Result<String, String> {
    if !has_ext(path, &["json"]) {
        return Err("Presets are .json files.".into());
    }
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_PRESET_BYTES {
        return Err("File is too big to be a preset.".into());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn write_preset_file(path: &Path, contents: &str) -> Result<(), String> {
    if !has_ext(path, &["json"]) {
        return Err("Presets are .json files.".into());
    }
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_list_delete() {
        let dir = tempfile::tempdir().unwrap();
        let presets = dir.path().join("presets");
        assert!(list(&presets).unwrap().is_empty());
        save(&presets, "b-2", "{\"id\":\"b-2\"}").unwrap();
        save(&presets, "a_1", "{}").unwrap();
        std::fs::write(presets.join("notes.txt"), "ignore me").unwrap();
        let files = list(&presets).unwrap();
        assert_eq!(files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(), ["a_1.json", "b-2.json"]);
        assert_eq!(files[1].contents, "{\"id\":\"b-2\"}");
        delete(&presets, "a_1").unwrap();
        assert_eq!(list(&presets).unwrap().len(), 1);
    }

    #[test]
    fn rejects_path_like_ids() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save(dir.path(), "../evil", "{}").is_err());
        assert!(delete(dir.path(), "a/b").is_err());
        assert!(valid_id("9f1c2d3e-aaaa-bbbb-cccc-0123456789ab"));
    }

    #[test]
    fn preset_files_must_be_json_and_small() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("p.json");
        write_preset_file(&ok, "{}").unwrap();
        assert_eq!(read_preset_file(&ok).unwrap(), "{}");
        assert!(write_preset_file(&dir.path().join("evil.bat"), "x").is_err());
        let big = dir.path().join("big.json");
        std::fs::write(&big, vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(read_preset_file(&big).is_err());
        assert!(read_preset_file(&dir.path().join("x.txt")).is_err());
    }

    #[test]
    fn only_video_extensions_count_as_clips() {
        assert!(is_video_path(r"C:\clips\Bob's clip.MP4"));
        assert!(is_video_path("/v/a.mkv"));
        assert!(!is_video_path("/Users/me/.ssh/id_rsa"));
        assert!(!is_video_path("/pics/photo.png"));
    }
}
