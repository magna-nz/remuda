// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod registry;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![registry::probe_model])
        .run(tauri::generate_context!())
        .expect("error while running Remuda");
}
