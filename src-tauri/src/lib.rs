pub mod commands;
pub mod core;
pub mod error;

use tauri::Manager;

/// 日志初始化:滚动文件落 `~/.skillsync/logs/`,按天切割、保留 7 份(假设:一周的
/// 追溯窗口对"昨晚自动更新为什么没动"这类问题够用)。失败不拦启动——日志是
/// 辅助通道,不能因为磁盘没权限就打不开应用。
fn init_tracing() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let dir = dirs_log_dir()?;
    let appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("skillsync")
        .filename_suffix("log")
        .max_log_files(7)
        .build(dir)
        .ok()?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(false)
        .try_init()
        .ok()?;
    Some(guard)
}

fn dirs_log_dir() -> Option<std::path::PathBuf> {
    use core::agents::AgentEnv;
    let env = core::agents::SystemEnv;
    Some(env.home()?.join(".skillsync").join("logs"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _log_guard = init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 定时更新检查(M2 任务 3)。内建库没配置(本地开发构建)就不起——
            // 起了也只会每轮报错刷日志。
            if let Some(scheduler) = commands::spawn_scheduler(app.handle().clone()) {
                app.manage(scheduler);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::agents_detected,
            commands::ui_prefs_get,
            commands::ui_prefs_set,
            commands::auto_update_get,
            commands::auto_update_set,
            commands::agents_set_disabled,
            commands::open_library_url,
            commands::update_check_now,
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
