pub mod commands;
pub mod core;
pub mod error;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

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

/// 从托盘回到主窗:显示、取消最小化、拿焦点。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 托盘常驻(M2 任务 4,用户拍板:关窗缩到托盘,「退出」只在托盘菜单)。
/// 菜单文案与 AppError 一样属于"用户可见文案的 Rust 侧通道":中文、禁 git 术语。
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 SkillSync", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check-updates", "立即检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check, &quit])?;

    let tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "check-updates" => {
                if let Some(s) = app.try_state::<core::scheduler::Scheduler>() {
                    s.check_now();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    tray_with_icon(tray, app).build(app)?;
    Ok(())
}

/// macOS 菜单栏用 **template image**:单色 + 只吃 alpha 通道,系统按浅色/深色菜单栏
/// 自动反色。彩色应用图标贴上去会在深色菜单栏里糊成一团,是 macOS 上一眼就露怯的细节。
#[cfg(target_os = "macos")]
fn tray_with_icon<R: tauri::Runtime>(
    builder: tauri::tray::TrayIconBuilder<R>,
    _app: &tauri::App<R>,
) -> tauri::tray::TrayIconBuilder<R> {
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")) {
        Ok(icon) => builder.icon(icon).icon_as_template(true),
        // 图标读不出来不该拦住托盘本身:没有图标的托盘仍能用,没有托盘就彻底没入口了
        Err(err) => {
            tracing::warn!(error = %err, "托盘图标加载失败,使用系统默认外观");
            builder
        }
    }
}

/// 非 macOS 沿用应用图标:Windows 任务栏通知区就是彩色图标,没有 template 一说。
#[cfg(not(target_os = "macos"))]
fn tray_with_icon<R: tauri::Runtime>(
    builder: tauri::tray::TrayIconBuilder<R>,
    app: &tauri::App<R>,
) -> tauri::tray::TrayIconBuilder<R> {
    match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _log_guard = init_tracing();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "SkillSync 启动");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 定时更新检查(M2 任务 3)。内建库没配置(本地开发构建)就不起——
            // 起了也只会每轮报错刷日志。
            if let Some(scheduler) = commands::spawn_scheduler(app.handle().clone()) {
                app.manage(scheduler);
            }
            setup_tray(app)?;
            // App 自更新的启动探测(M2 任务 5;更新源未配置或开关关闭时内部直接返回)
            commands::spawn_app_update_probe(app.handle().clone());
            Ok(())
        })
        // 关窗 = 缩到托盘(已拍板):拦下关闭请求,只隐藏窗口。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
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
            commands::registry_list,
            commands::auth_device_start,
            commands::auth_device_wait,
            commands::registry_add,
            commands::registry_remove,
            commands::update_check_now,
            commands::app_update_check,
            commands::app_update_install,
            commands::app_restart,
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
            commands::skill_link_agents,
            commands::share_candidates,
            commands::skill_share,
            commands::skill_share_changes
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // 窗口全部隐藏/关闭也不退出——托盘常驻;只有显式 app.exit(托盘「退出」)才走
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
