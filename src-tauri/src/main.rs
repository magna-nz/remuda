// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;
mod registry;

fn main() {
    tauri::Builder::default()
        // Opens documentation links in the system browser instead of
        // navigating the webview. Scoped to http/https in
        // `capabilities/default.json`.
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            host::host_stats,
            host::start_ollama,
            registry::probe_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running Remuda");
}
