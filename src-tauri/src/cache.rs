//! Proxy + preview-audio cache bookkeeping. Entries are keyed by `proxy::source_key`:
//! `audio/<key>/`, `proxies/<key>.mp4` and `thumbs/<key>/`. Last use is the mtime of `lru/<key>`.
use std::path::{Path, PathBuf};
use std::time::SystemTime;

struct Entry { key: String, bytes: u64, last_used: SystemTime, paths: Vec<PathBuf> }

fn size_of(p: &Path) -> u64 {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|rd| rd.filter_map(|e| e.ok()).map(|e| size_of(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

/// Mark a source's cache entry as used now.
pub fn touch(cache: &Path, key: &str) {
    let dir = cache.join("lru");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(key), b"");
}

fn entries(cache: &Path) -> Vec<Entry> {
    let mut map: std::collections::BTreeMap<String, Vec<PathBuf>> = Default::default();
    if let Ok(rd) = std::fs::read_dir(cache.join("audio")) {
        for e in rd.filter_map(|e| e.ok()) {
            map.entry(e.file_name().to_string_lossy().into_owned()).or_default().push(e.path());
        }
    }
    if let Ok(rd) = std::fs::read_dir(cache.join("proxies")) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if let Some(stem) = p.file_stem() {
                let key = stem.to_string_lossy().split('.').next().unwrap_or_default().to_string();
                map.entry(key).or_default().push(p);
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(cache.join("thumbs")) {
        for e in rd.filter_map(|e| e.ok()) {
            map.entry(e.file_name().to_string_lossy().into_owned()).or_default().push(e.path());
        }
    }
    map.into_iter()
        .map(|(key, paths)| {
            let last_used = std::fs::metadata(cache.join("lru").join(&key)).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let bytes = paths.iter().map(|p| size_of(p)).sum();
            Entry { key, bytes, last_used, paths }
        })
        .collect()
}

pub fn total_bytes(cache: &Path) -> u64 {
    entries(cache).iter().map(|e| e.bytes).sum()
}

/// Delete least-recently-used entries (never those in `keep`) until the total is at most `cap_bytes`.
pub fn prune(cache: &Path, cap_bytes: u64, keep: &[String]) -> u64 {
    let mut es = entries(cache);
    let mut total: u64 = es.iter().map(|e| e.bytes).sum();
    es.sort_by_key(|e| e.last_used);
    let mut freed = 0;
    for e in es {
        if total <= cap_bytes {
            break;
        }
        if keep.contains(&e.key) {
            continue;
        }
        for p in &e.paths {
            let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
        }
        let _ = std::fs::remove_file(cache.join("lru").join(&e.key));
        total -= e.bytes;
        freed += e.bytes;
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn entry(cache: &Path, key: &str, audio_bytes: usize, proxy_bytes: usize, age_s: u64) {
        let a = cache.join("audio").join(key);
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("track-0.pcm"), vec![0u8; audio_bytes]).unwrap();
        if proxy_bytes > 0 {
            std::fs::create_dir_all(cache.join("proxies")).unwrap();
            std::fs::write(cache.join("proxies").join(format!("{key}.mp4")), vec![0u8; proxy_bytes]).unwrap();
        }
        touch(cache, key);
        let t = SystemTime::now() - Duration::from_secs(age_s);
        std::fs::File::options().write(true).open(cache.join("lru").join(key)).unwrap().set_modified(t).unwrap();
    }

    #[test]
    fn total_counts_audio_and_proxies_only() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "a", 100, 50, 0);
        std::fs::create_dir_all(d.path().join("WebKit")).unwrap();
        std::fs::write(d.path().join("WebKit").join("x"), vec![0u8; 999]).unwrap();
        assert_eq!(total_bytes(d.path()), 150);
    }

    #[test]
    fn prune_removes_least_recently_used_first_until_under_cap() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "old", 100, 0, 300);
        entry(d.path(), "mid", 100, 0, 200);
        entry(d.path(), "new", 100, 0, 100);
        assert_eq!(prune(d.path(), 150, &[]), 200);
        assert!(!d.path().join("audio/old").exists());
        assert!(!d.path().join("audio/mid").exists());
        assert!(d.path().join("audio/new").exists());
        assert!(!d.path().join("lru/old").exists());
    }

    #[test]
    fn prune_keeps_listed_keys() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "open", 100, 40, 999);
        entry(d.path(), "other", 100, 0, 1);
        assert_eq!(prune(d.path(), 0, &["open".to_string()]), 100);
        assert!(d.path().join("audio/open").exists());
        assert!(d.path().join("proxies/open.mp4").exists());
        assert!(!d.path().join("audio/other").exists());
    }

    #[test]
    fn prune_under_cap_does_nothing() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "a", 100, 0, 0);
        assert_eq!(prune(d.path(), 1000, &[]), 0);
        assert!(d.path().join("audio/a").exists());
    }

    #[test]
    fn entries_without_lru_marker_count_as_oldest() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "tracked", 100, 0, 5000);
        std::fs::create_dir_all(d.path().join("audio/legacy")).unwrap();
        std::fs::write(d.path().join("audio/legacy/track-0.m4a"), vec![0u8; 100]).unwrap();
        assert_eq!(prune(d.path(), 150, &[]), 100);
        assert!(!d.path().join("audio/legacy").exists());
    }

    #[test]
    fn thumbnails_count_and_are_pruned_with_their_source() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("thumbs").join("k1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("0.jpg"), vec![0u8; 100]).unwrap();
        assert_eq!(total_bytes(d.path()), 100);
        assert_eq!(prune(d.path(), 0, &[]), 100);
        assert!(!dir.exists());
    }

    #[test]
    fn part_mp4_groups_with_its_entry() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "k", 100, 50, 0);
        std::fs::write(d.path().join("proxies").join("k.part.mp4"), vec![0u8; 25]).unwrap();
        assert_eq!(total_bytes(d.path()), 175);

        entry(d.path(), "old", 100, 0, 500);
        assert_eq!(prune(d.path(), 0, &["k".to_string()]), 100);
        assert!(d.path().join("audio/k").exists());
        assert!(d.path().join("proxies/k.mp4").exists());
        assert!(d.path().join("proxies/k.part.mp4").exists());
        assert!(!d.path().join("audio/old").exists());

        assert_eq!(prune(d.path(), 0, &[]), 175);
        assert!(!d.path().join("audio/k").exists());
        assert!(!d.path().join("proxies/k.mp4").exists());
        assert!(!d.path().join("proxies/k.part.mp4").exists());
    }

    /// prepare_audio / make_proxy touch their entry before generating, so an in-flight entry
    /// (only .part files so far) is the newest and a concurrent prune takes older entries first.
    #[test]
    fn a_just_touched_in_flight_entry_outlives_an_older_one() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "old", 300, 0, 60);
        let a = d.path().join("audio/new");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("track-0.part.pcm"), vec![0u8; 100]).unwrap();
        std::fs::create_dir_all(d.path().join("proxies")).unwrap();
        std::fs::write(d.path().join("proxies/new.part.mp4"), vec![0u8; 50]).unwrap();
        touch(d.path(), "new");
        assert_eq!(prune(d.path(), 200, &[]), 300);
        assert!(d.path().join("audio/new/track-0.part.pcm").exists());
        assert!(d.path().join("proxies/new.part.mp4").exists());
        assert!(!d.path().join("audio/old").exists());
    }
}
