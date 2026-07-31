pub mod commands;
pub mod core;
pub mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::agents_detected,
            commands::ui_prefs_get,
            commands::ui_prefs_set,
            commands::auto_update_get,
            commands::auto_update_set,
            commands::agents_set_disabled,
            commands::open_library_url,
            commands::auth_login_oauth,
            commands::auth_login_token,
            commands::auth_status,
            commands::auth_logout,
            commands::store_index,
            commands::store_skill_detail,
            commands::skill_install,
            commands::skill_install_batch,
            commands::installed_list,
            commands::skill_remove,
            commands::skill_repair,
            commands::share_candidates,
            commands::skill_share,
            commands::skill_share_changes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
