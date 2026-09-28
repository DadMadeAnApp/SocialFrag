use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::encoders::{detect, EncoderSet};
use crate::export::{run_export, ExportState};
use crate::ffmpeg::RealRunner;
use crate::job::{ClipInfo, ExportError, ExportJob, ExportProgress, ExportResult};
use crate::presets_store::{self, RawPresetFile};
use crate::probe::probe_clip_file;
use crate::audio_prep::{prepare_audio_files, PreparedTrack};
use crate::proxy::{make_proxy_file, source_key};
use crate::thumbs::make_thumbnail;
use crate::transcribe::{run_transcribe, RealTools, TranscribeJob, TranscribeOutcome, TranscribeState};
use crate::whisper::{download_model, is_downloaded, model_path, spec, HttpFetch, MODELS};

#[derive(Clone, Default)]
pub struct AppState {
    pub export: Arc<ExportState>,
    pub encoders: Arc<OnceLock<EncoderSet>>,
    pub transcribe: Arc<TranscribeState>,
}

fn encoder_set(cell: &OnceLock<EncoderSet>) -> EncoderSet {
    *cell.get_or_init(|| detect(&RealRunner))
}

fn join_err(e: impl std::fmt::Display) -> String {
    format!("background task failed: {e}")
}

fn presets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("presets")).map_err(|e| e.to_string())
}

/// The asset protocol scope starts empty; only files the user opened (and their proxies) become readable by the webview.
fn allow_asset(app: &AppHandle, path: &str) -> Result<(), String> {
    app.asset_protocol_scope().allow_file(path).map_err(|e| e.to_string())
}

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo { bytes: u64, cap_gb: f64 }

fn app_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let p = app.path();
    Ok((p.app_cache_dir().map_err(|e| e.to_string())?, p.app_data_dir().map_err(|e| e.to_string())?))
}

fn keys(paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| source_key(Path::new(p))).collect()
}

/// Mark `source` used and trim the cache to the configured cap, keeping `source` and every path in `keep` (the open project's media).
fn touch_and_prune(cache: &Path, data: &Path, source: &str, keep: &[String]) {
    let key = source_key(Path::new(source));
    crate::cache::touch(cache, &key);
    let cap = (crate::settings::load(data).cache_cap_gb * GB) as u64;
    let mut kept = keys(keep);
    kept.push(key);
    crate::cache::prune(cache, cap, &kept);
}

fn info(cache: &Path, data: &Path) -> CacheInfo {
    CacheInfo { bytes: crate::cache::total_bytes(cache), cap_gb: crate::settings::load(data).cache_cap_gb }
}

#[tauri::command]
pub async fn cache_info(app: AppHandle) -> Result<CacheInfo, String> {
    let (cache, data) = app_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || info(&cache, &data)).await.map_err(join_err)
}

#[tauri::command]
pub async fn cache_set_cap(app: AppHandle, gb: f64, keep: Vec<String>) -> Result<CacheInfo, String> {
    if !(1.0..=500.0).contains(&gb) {
        return Err("Cache limit must be between 1 and 500 GB.".into());
    }
    let (cache, data) = app_dirs(&app)?;
    crate::settings::save(&data, &crate::settings::Settings { cache_cap_gb: gb })?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::cache::prune(&cache, (gb * GB) as u64, &keys(&keep));
        info(&cache, &data)
    })
    .await
    .map_err(join_err)
}

#[tauri::command]
pub async fn cache_clear(app: AppHandle, keep: Vec<String>) -> Result<CacheInfo, String> {
    let (cache, data) = app_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::cache::prune(&cache, 0, &keys(&keep));
        info(&cache, &data)
    })
    .await
    .map_err(join_err)
}

#[tauri::command]
pub async fn probe_clip(app: AppHandle, path: String) -> Result<ClipInfo, String> {
    if !presets_store::is_video_path(&path) {
        return Err("This file isn't a video SocialFrag can read.".into());
    }
    let p = path.clone();
    let info = tauri::async_runtime::spawn_blocking(move || probe_clip_file(&p)).await.map_err(join_err)??;
    allow_asset(&app, &path)?;
    Ok(info)
}

#[tauri::command]
pub async fn make_proxy(app: AppHandle, state: State<'_, AppState>, path: String, duration: f64, keep: Vec<String>, on_progress: Channel<f64>) -> Result<String, String> {
    let (cache, data) = app_dirs(&app)?;
    let st = state.inner().clone();
    // Newest before generating, so a prune finishing meanwhile (an earlier clip's prep) never takes it.
    crate::cache::touch(&cache, &source_key(Path::new(&path)));
    let proxy = tauri::async_runtime::spawn_blocking(move || {
        let enc = encoder_set(&st.encoders).primary().ok_or("No H.264 encoder found in the bundled ffmpeg.")?;
        let out = make_proxy_file(&cache, &PathBuf::from(&path), enc, duration, &|f| {
            let _ = on_progress.send(f);
        })?;
        touch_and_prune(&cache, &data, &path, &keep);
        Ok::<_, String>(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(join_err)??;
    allow_asset(&app, &proxy)?;
    Ok(proxy)
}

#[tauri::command]
pub async fn prepare_audio(app: AppHandle, path: String, keep: Vec<String>) -> Result<Vec<PreparedTrack>, String> {
    if !presets_store::is_video_path(&path) {
        return Err("This file isn't a video SocialFrag can read.".into());
    }
    let (cache, data) = app_dirs(&app)?;
    let p = path.clone();
    // Newest before generating, so a prune finishing meanwhile (an earlier clip's prep) never takes it.
    crate::cache::touch(&cache, &source_key(Path::new(&path)));
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        let info = probe_clip_file(&p)?;
        let t = prepare_audio_files(&cache, &PathBuf::from(&p), info.audio_tracks.len() as u32)?;
        touch_and_prune(&cache, &data, &p, &keep);
        Ok::<_, String>(t)
    })
    .await
    .map_err(join_err)??;
    Ok(tracks)
}

/// A cached JPEG of the frame at `at_s`, readable by the webview.
#[tauri::command]
pub async fn thumbnail(app: AppHandle, path: String, at_s: f64) -> Result<String, String> {
    if !presets_store::is_video_path(&path) {
        return Err("This file isn't a video SocialFrag can read.".into());
    }
    let (cache, _) = app_dirs(&app)?;
    let p = path.clone();
    let out = tauri::async_runtime::spawn_blocking(move || make_thumbnail(&cache, Path::new(&p), at_s)).await.map_err(join_err)??;
    let out = out.to_string_lossy().into_owned();
    allow_asset(&app, &out)?;
    Ok(out)
}

/// `path` resolved (symlinks and `..` included) if it lies inside `root` and has extension `ext`.
fn guard_cache_file(root: &Path, path: &Path, ext: &str) -> Result<PathBuf, String> {
    let p = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !p.starts_with(&root) || p.extension().map_or(true, |x| x != ext) {
        return Err(format!("not an audio cache .{ext} file"));
    }
    Ok(p)
}

/// Only files inside the audio cache with the expected extension are readable from the webview.
fn audio_cache_file(app: &AppHandle, path: &str, ext: &str) -> Result<PathBuf, String> {
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("audio");
    guard_cache_file(&root, Path::new(path), ext)
}

/// Raw f32le bytes over IPC; avoids asset-protocol CORS for fetch().
#[tauri::command]
pub async fn audio_envelope(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = audio_cache_file(&app, &path, "f32")?;
        std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(join_err)?
}

/// One chunk of preview PCM (s16le stereo 48 kHz) as raw bytes.
#[tauri::command]
pub async fn audio_pcm_chunk(app: AppHandle, path: String, start_frame: u64, frames: u64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = audio_cache_file(&app, &path, "pcm")?;
        crate::audio_prep::read_pcm_range(&p, start_frame, frames).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn export_clip(app: AppHandle, state: State<'_, AppState>, job: ExportJob, on_progress: Channel<ExportProgress>) -> Result<ExportResult, ExportError> {
    let work_root = app.path().app_cache_dir().map_err(|e| ExportError::new("io", "Can't find the cache folder.", &e.to_string()))?;
    let st = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let enc = encoder_set(&st.encoders);
        run_export(job, &enc, &work_root, &st.export, &|p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| ExportError::new("io", "Export crashed.", &e.to_string()))?
}

#[tauri::command]
pub fn cancel_export(state: State<'_, AppState>) {
    state.export.cancel();
}

#[tauri::command]
pub fn presets_list_user(app: AppHandle) -> Result<Vec<RawPresetFile>, String> {
    presets_store::list(&presets_dir(&app)?)
}

#[tauri::command]
pub fn preset_save(app: AppHandle, id: String, contents: String) -> Result<(), String> {
    presets_store::save(&presets_dir(&app)?, &id, &contents)
}

#[tauri::command]
pub fn preset_delete(app: AppHandle, id: String) -> Result<(), String> {
    presets_store::delete(&presets_dir(&app)?, &id)
}

/// File paths for presets come from a native dialog opened here, never from the webview.
#[tauri::command]
pub async fn preset_import_dialog(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = app.dialog().file().add_filter("SocialFrag preset", &["json"]).blocking_pick_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        presets_store::read_preset_file(&path).map(Some)
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn preset_export_dialog(app: AppHandle, default_name: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = app.dialog().file().add_filter("SocialFrag preset", &["json"]).set_file_name(&default_name).blocking_save_file() else {
            return Ok(());
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        presets_store::write_preset_file(&path, &contents)
    })
    .await
    .map_err(join_err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("audio");
        std::fs::create_dir_all(root.join("k")).unwrap();
        std::fs::write(root.join("k/track-0.pcm"), b"x").unwrap();
        std::fs::write(root.join("k/env-0.f32"), b"x").unwrap();
        std::fs::write(d.path().join("outside.pcm"), b"x").unwrap();
        (d, root)
    }

    #[test]
    fn guard_accepts_a_cache_file_with_the_right_extension() {
        let (_d, root) = fixture();
        let p = guard_cache_file(&root, &root.join("k/track-0.pcm"), "pcm").unwrap();
        assert!(p.ends_with("audio/k/track-0.pcm"));
    }

    #[test]
    fn guard_rejects_the_wrong_extension() {
        let (_d, root) = fixture();
        assert!(guard_cache_file(&root, &root.join("k/env-0.f32"), "pcm").is_err());
    }

    #[test]
    fn guard_rejects_a_file_outside_the_root() {
        let (d, root) = fixture();
        assert!(guard_cache_file(&root, &d.path().join("outside.pcm"), "pcm").is_err());
    }

    #[test]
    fn guard_rejects_dot_dot_escapes() {
        let (_d, root) = fixture();
        assert!(guard_cache_file(&root, &root.join("../outside.pcm"), "pcm").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn guard_rejects_a_symlink_that_points_outside() {
        let (d, root) = fixture();
        let link = root.join("k/link.pcm");
        std::os::unix::fs::symlink(d.path().join("outside.pcm"), &link).unwrap();
        assert!(guard_cache_file(&root, &link, "pcm").is_err());
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelInfo { id: &'static str, bytes: u64, downloaded: bool }

#[tauri::command]
pub fn whisper_models(app: AppHandle) -> Result<Vec<WhisperModelInfo>, String> {
    let (_, data) = app_dirs(&app)?;
    Ok(MODELS.iter().map(|m| WhisperModelInfo { id: m.id, bytes: m.bytes, downloaded: is_downloaded(&data, m) }).collect())
}

/// Holds `TranscribeState::running` for one download or run; a second one is refused.
struct Busy(Arc<TranscribeState>);

impl Busy {
    fn take(st: &Arc<TranscribeState>) -> Result<Self, String> {
        st.running
            .compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
            .map_err(|_| "A captioning run is already in progress.".to_string())?;
        st.cancelled.store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(Busy(st.clone()))
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.running.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle, state: State<'_, AppState>, model: String, on_progress: Channel<f64>) -> Result<(), String> {
    let (_, data) = app_dirs(&app)?;
    let s = spec(&model).ok_or_else(|| format!("Unknown model {model}."))?;
    let st = state.transcribe.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = Busy::take(&st)?;
        download_model(&data, s, &HttpFetch, &st.cancelled, &|f| {
            let _ = on_progress.send(f);
        })
        .map(|_| ())
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub async fn transcribe(app: AppHandle, state: State<'_, AppState>, job: TranscribeJob, on_progress: Channel<f64>) -> Result<TranscribeOutcome, String> {
    let (cache, data) = app_dirs(&app)?;
    let s = spec(&job.model).ok_or_else(|| format!("Unknown model {}.", job.model))?;
    if !is_downloaded(&data, s) {
        return Err("Model not downloaded.".into());
    }
    let model = model_path(&data, s);
    let st = state.transcribe.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = Busy::take(&st)?;
        // Not one of the cache's managed folders, so pruning never touches a run in progress.
        run_transcribe(&job, &model, &cache.join("transcribe"), &RealTools, &st, &|f| {
            let _ = on_progress.send(f);
        })
    })
    .await
    .map_err(join_err)?
}

#[tauri::command]
pub fn cancel_transcribe(state: State<'_, AppState>) {
    state.transcribe.cancel();
}
