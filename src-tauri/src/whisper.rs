//! whisper.cpp models (download + checksum), `whisper-cli` arguments and its JSON output.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// English-only ggml models, pinned by size and SHA-256 (Hugging Face `ggerganov/whisper.cpp`).
pub const MODELS: [ModelSpec; 3] = [
    ModelSpec { id: "base.en", file: "ggml-base.en.bin", bytes: 147_964_211, sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" },
    ModelSpec { id: "small.en", file: "ggml-small.en.bin", bytes: 487_614_201, sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d" },
    ModelSpec { id: "medium.en", file: "ggml-medium.en.bin", bytes: 1_533_774_781, sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356" },
];

const URL_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const CHUNK: usize = 1 << 20;

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

/// In app data, not the cache: Clear cache never deletes a model.
pub fn models_dir(data: &Path) -> PathBuf {
    data.join("whisper-models")
}

pub fn model_path(data: &Path, s: &ModelSpec) -> PathBuf {
    models_dir(data).join(s.file)
}

pub fn is_downloaded(data: &Path, s: &ModelSpec) -> bool {
    std::fs::metadata(model_path(data, s)).is_ok_and(|m| m.len() == s.bytes)
}

pub trait Fetch {
    fn open(&self, url: &str) -> Result<Box<dyn Read>, String>;
}

pub struct HttpFetch;

impl Fetch for HttpFetch {
    fn open(&self, url: &str) -> Result<Box<dyn Read>, String> {
        let resp = ureq::get(url).call().map_err(|e| e.to_string())?;
        Ok(Box::new(resp.into_body().into_reader()))
    }
}

/// Streams the model to `<file>.part`, checks size and SHA-256, then renames it into place.
pub fn download_model(data: &Path, s: &ModelSpec, fetch: &dyn Fetch, cancelled: &AtomicBool, on_progress: &dyn Fn(f64)) -> Result<PathBuf, String> {
    let dir = models_dir(data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join(format!("{}.part", s.file));
    let result = (|| {
        let mut src = fetch.open(&format!("{URL_BASE}{}", s.file))?;
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err("cancelled".to_string());
            }
            let n = src.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            hash.update(&buf[..n]);
            done += n as u64;
            on_progress((done as f64 / s.bytes as f64).min(1.0));
        }
        out.flush().map_err(|e| e.to_string())?;
        let hex: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if done != s.bytes || hex != s.sha256 {
            return Err(format!("{}: checksum or size mismatch", s.file));
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            let dst = model_path(data, s);
            std::fs::rename(&part, &dst).map_err(|e| e.to_string())?;
            Ok(dst)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Pinned to whisper.cpp v1.9.4: English, one word per segment, no carried-over context (`-mc 0`, stops
/// repetition loops), non-speech tokens suppressed (`-sns`), JSON to `<out_base>.json`, progress on stderr.
pub fn whisper_args(model: &Path, wav: &Path, out_base: &Path) -> Vec<String> {
    let p = |x: &Path| x.to_string_lossy().into_owned();
    vec!["-m".into(), p(model), "-f".into(), p(wav), "-l".into(), "en".into(), "-ml".into(), "1".into(), "-sow".into(), "-mc".into(), "0".into(), "-sns".into(), "-oj".into(), "-of".into(), p(out_base), "-pp".into(), "-np".into()]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub start_s: f64,
    pub end_s: f64,
}

/// Words from `-oj` output. Drops empty segments and non-speech tags like `[BLANK_AUDIO]` or `(laughs)`.
pub fn parse_words(json: &str) -> Result<Vec<Word>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let segs = v.get("transcription").and_then(|t| t.as_array()).ok_or("whisper output has no transcription")?;
    let mut out = Vec::new();
    for seg in segs {
        let text = seg.get("text").and_then(|t| t.as_str()).unwrap_or("").trim();
        let tag = (text.starts_with('[') && text.ends_with(']')) || (text.starts_with('(') && text.ends_with(')'));
        if text.is_empty() || tag {
            continue;
        }
        let ms = |k: &str| seg.get("offsets").and_then(|o| o.get(k)).and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
        out.push(Word { text: text.to_string(), start_s: ms("from"), end_s: ms("to") });
    }
    Ok(out)
}

/// A phrase (1 to 12 words) said 3 or more times back to back is a decoding loop, not speech: keep it once.
pub fn drop_loops(words: Vec<Word>) -> Vec<Word> {
    let key = |w: &Word| w.text.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric() && c != '\'').to_string();
    let mut out: Vec<Word> = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        let mut skip = 0;
        for k in 1..=12usize.min((words.len() - i) / 3) {
            let same = |a: usize, b: usize| (0..k).all(|j| key(&words[a + j]) == key(&words[b + j]));
            let mut reps = 1;
            while i + (reps + 1) * k <= words.len() && same(i, i + reps * k) {
                reps += 1;
            }
            if reps >= 3 {
                skip = k * reps;
                out.extend(words[i..i + k].iter().cloned());
                break;
            }
        }
        if skip == 0 {
            out.push(words[i].clone());
            i += 1;
        } else {
            i += skip;
        }
    }
    out
}

/// `whisper_print_progress_callback: progress =  45%` → 0.45.
pub fn parse_progress(line: &str) -> Option<f64> {
    let rest = &line[line.find("progress =")? + "progress =".len()..];
    let n: f64 = rest.trim().trim_end_matches('%').trim().parse().ok()?;
    Some(n / 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn model_table_matches_the_spec() {
        let b = spec("base.en").unwrap();
        assert_eq!((b.file, b.bytes), ("ggml-base.en.bin", 147_964_211));
        assert_eq!(b.sha256, "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002");
        assert_eq!(MODELS.map(|m| m.id), ["base.en", "small.en", "medium.en"]);
        assert!(spec("large").is_none());
    }

    #[test]
    fn args_are_pinned() {
        let a = whisper_args(Path::new("/m/ggml-base.en.bin"), Path::new("/t/a.wav"), Path::new("/t/a"));
        assert_eq!(a, ["-m", "/m/ggml-base.en.bin", "-f", "/t/a.wav", "-l", "en", "-ml", "1", "-sow", "-mc", "0", "-sns", "-oj", "-of", "/t/a", "-pp", "-np"]);
    }

    #[test]
    fn parses_words_and_drops_blanks_and_non_speech() {
        let w = parse_words(include_str!("testdata/whisper-sample.json")).unwrap();
        let got: Vec<(&str, f64, f64)> = w.iter().map(|w| (w.text.as_str(), w.start_s, w.end_s)).collect();
        assert_eq!(got, [("Nice", 0.0, 0.32), ("shot!", 0.32, 0.61), ("GG", 3.0, 3.4)]);
    }

    #[test]
    fn a_phrase_repeated_three_or_more_times_in_a_row_is_kept_once() {
        let w = |t: &str, s: f64| Word { text: t.into(), start_s: s, end_s: s + 0.2 };
        let mut words = vec![w("Hi", 0.0)];
        for i in 0..4 {
            for (j, t) in ["I'm", "not", "going."].iter().enumerate() {
                words.push(w(t, 1.0 + i as f64 + j as f64 * 0.3));
            }
        }
        words.push(w("GG", 9.0));
        let got: Vec<String> = drop_loops(words).into_iter().map(|w| w.text).collect();
        assert_eq!(got, ["Hi", "I'm", "not", "going.", "GG"]);
        let twice = vec![w("go", 0.0), w("go", 1.0), w("team", 2.0)];
        assert_eq!(drop_loops(twice).len(), 3, "two in a row is normal speech");
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress("whisper_print_progress_callback: progress =  45%"), Some(0.45));
        assert_eq!(parse_progress("whisper_init_from_file: loading model"), None);
    }

    struct Bytes(Vec<u8>);
    impl Fetch for Bytes {
        fn open(&self, _url: &str) -> Result<Box<dyn std::io::Read>, String> {
            Ok(Box::new(std::io::Cursor::new(self.0.clone())))
        }
    }

    #[test]
    fn download_verifies_size_and_hash_and_leaves_no_part_file() {
        let dir = tempfile::tempdir().unwrap();
        let bad = ModelSpec { id: "t", file: "t.bin", bytes: 3, sha256: "0000000000000000000000000000000000000000000000000000000000000000" };
        let err = download_model(dir.path(), &bad, &Bytes(b"abc".to_vec()), &AtomicBool::new(false), &|_| {}).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!models_dir(dir.path()).join("t.bin.part").exists());
        assert!(!models_dir(dir.path()).join("t.bin").exists());
        // sha256("abc")
        let good = ModelSpec { sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ..bad };
        let p = download_model(dir.path(), &good, &Bytes(b"abc".to_vec()), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(std::fs::read(p).unwrap(), b"abc");
        assert!(is_downloaded(dir.path(), &good));
    }

    #[test]
    fn download_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let s = ModelSpec { id: "t", file: "t.bin", bytes: 3, sha256: "x" };
        let err = download_model(dir.path(), &s, &Bytes(b"abc".to_vec()), &AtomicBool::new(true), &|_| {}).unwrap_err();
        assert_eq!(err, "cancelled");
        assert!(!models_dir(dir.path()).join("t.bin.part").exists());
    }
}
