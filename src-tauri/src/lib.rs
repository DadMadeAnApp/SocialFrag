pub mod audio_mix;
pub mod audio_prep;
pub mod cache;
pub mod commands;
pub mod encoders;
pub mod export;
pub mod ffmpeg;
pub mod filtergraph;
pub mod job;
pub mod output_path;
pub mod preset;
pub mod presets_store;
pub mod probe;
pub mod progress;
pub mod proxy;
pub mod settings;
pub mod thumbs;
pub mod transcribe;
pub mod whisper;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::probe_clip,
            commands::make_proxy,
            commands::prepare_audio,
            commands::thumbnail,
            commands::audio_envelope,
            commands::audio_pcm_chunk,
            commands::cache_info,
            commands::cache_set_cap,
            commands::cache_clear,
            commands::export_clip,
            commands::cancel_export,
            commands::whisper_models,
            commands::download_whisper_model,
            commands::transcribe,
            commands::cancel_transcribe,
            commands::presets_list_user,
            commands::preset_save,
            commands::preset_delete,
            commands::preset_import_dialog,
            commands::preset_export_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SocialFrag");
}
