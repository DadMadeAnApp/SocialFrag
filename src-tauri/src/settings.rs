use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub cache_cap_gb: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { cache_cap_gb: 10.0 }
    }
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join("settings.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), serde_json::to_string_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_10_gb_when_missing_or_corrupt() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(load(d.path()).cache_cap_gb, 10.0);
        std::fs::write(d.path().join("settings.json"), "{not json").unwrap();
        assert_eq!(load(d.path()).cache_cap_gb, 10.0);
    }

    #[test]
    fn round_trips() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), &Settings { cache_cap_gb: 25.0 }).unwrap();
        assert_eq!(load(d.path()).cache_cap_gb, 25.0);
    }
}
