//! Tauri IPC command 定义。薄壳:仅做参数转换与调用 core,禁止在此写业务逻辑。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use tauri::{Emitter, Manager};

use crate::core::acquire;
use crate::core::agents::{AgentRegistry, DetectedAgent, SystemEnv};
use crate::core::app_update::{self, AppUpdateStatus, ReadyState};
use crate::core::auth::{self, CredentialStore, KeyringStore, OAuthConfig};
use crate::core::builtin;
use crate::core::create;
use crate::core::watcher;
use crate::core::gitea::{GiteaClient, RepoRef};
use crate::core::github;
use crate::core::installer::{self, InstallReport, Installer};
use crate::core::local_detail;
use crate::core::plaza;
use crate::core::registry::{self, BUILTIN_REGISTRY_ID};
use crate::core::remove;
use crate::core::scheduler;
use crate::core::share;
use crate::core::session::{self, BrowserOpener, SessionStatus, SessionUser};
use crate::core::state;
use crate::core::store::{self, SkillDetail, StoreIndexView};
use crate::error::AppError;

/// 应用基础信息,供前端启动时展示与自检。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    /// 本次构建是否注入了内建技能库配置(地址 + OAuth Client ID)。
    pub builtin_configured: bool,
}

#[tauri::command]
pub fn app_info() -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        builtin_configured: builtin::builtin_configured(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgents {
    pub agents: Vec<DetectedAgent>,
    /// 技能本体的落盘目录(`~/.agents/skills`),与 npx skills 共用。
    pub canonical_dir: Option<String>,
}

#[tauri::command]
pub fn agents_detected() -> Result<DetectedAgents, AppError> {
    let registry = AgentRegistry::builtin();
    let env = SystemEnv;
    let mut agents = registry.detect_all(&env);
    // 设置页的开关标上去:关掉的 agent 不进默认勾选(手动勾选不拦)
    let disabled = app_store()?.load_config()?.value.disabled_agents;
    crate::core::agents::mark_disabled(&mut agents, &disabled);
    Ok(DetectedAgents {
        agents,
        canonical_dir: registry
            .canonical_global_dir(&env)
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

// ============================================================ 界面偏好

#[tauri::command]
pub fn ui_prefs_get() -> Result<Option<state::UiPrefs>, AppError> {
    app_store()?.load_ui_prefs()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPrefsArgs {
    pub prefs: state::UiPrefs,
}

#[tauri::command]
pub fn ui_prefs_set(args: UiPrefsArgs) -> Result<(), AppError> {
    app_store()?.save_ui_prefs(&args.prefs)
}

#[tauri::command]
pub fn auto_update_get() -> Result<state::AutoUpdate, AppError> {
    Ok(app_store()?.load_config()?.value.auto_update)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateArgs {
    pub auto_update: state::AutoUpdate,
}

#[tauri::command]
pub fn auto_update_set(app: tauri::AppHandle, args: AutoUpdateArgs) -> Result<(), AppError> {
    app_store()?.save_auto_update(&args.auto_update)?;
    // 频率变更即时生效:通知调度循环重算下一次时刻(没起 scheduler 的开发构建下无事发生)
    if let Some(s) = app.try_state::<scheduler::Scheduler>() {
        s.reschedule();
    }
    Ok(())
}

/// 设置页「立即检查」。结果经 `scheduler://report` 事件回来,这里即发即忘。
#[tauri::command]
pub fn update_check_now(app: tauri::AppHandle) -> Result<(), AppError> {
    let Some(s) = app.try_state::<scheduler::Scheduler>() else {
        return Err(AppError::new(
            "AUTH_NOT_CONFIGURED",
            "这个版本没有配置公司技能库,请向 IT 索取正式安装包",
        ));
    };
    s.check_now();
    Ok(())
}

// ============================================================ App 自更新(M2 任务 5)

/// 构造 updater:地址与公钥都是编译期注入的,conf 里不放任何真实值。
fn app_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, AppError> {
    use tauri_plugin_updater::UpdaterExt;
    let (endpoint, pubkey) = builtin::update_source()?;
    let url = endpoint.parse().map_err(|e| {
        AppError::new("UPDATE_NOT_CONFIGURED", "应用更新源地址不合法,请向 IT 反馈")
            .with_detail(format!("{e}: {endpoint}"))
    })?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(update_err)?
        .pubkey(pubkey)
        .build()
        .map_err(update_err)
}

fn update_err(e: tauri_plugin_updater::Error) -> AppError {
    AppError::new("NET_UPDATE", "检查应用更新失败,请确认已接入公司内网后重试")
        .with_detail(e.to_string())
}

/// 进程内唯一的就绪记账(重启后天然作废,见 core::app_update 模块头)。
fn ready_state() -> &'static ReadyState {
    static READY: std::sync::OnceLock<ReadyState> = std::sync::OnceLock::new();
    READY.get_or_init(ReadyState::default)
}

#[tauri::command]
pub async fn app_update_check(app: tauri::AppHandle) -> Result<AppUpdateStatus, AppError> {
    let remote = app_updater(&app)?
        .check()
        .await
        .map_err(update_err)?
        .map(|u| u.version.clone());
    Ok(ready_state().classify(remote.as_deref()))
}

/// 一轮"下载安装"的结果(不含重启)。
enum Staged {
    /// 远端没有新版。
    NoUpdate,
    /// 这一轮真装好了——只有它需要提示用户。
    Fresh(String),
    /// 之前就装好等重启了,或另一轮正在下载:都不是这一轮的成果,别重复提示。
    AlreadyHandled,
}

/// 把新版本准备到"点一下就能生效"的状态(公共体)。
/// 签名校验在插件内完成:校验不过整个流程终止,不会落半个字节。
/// **全程不重启、不退出**——用户可能正开着别的操作,由前端提示后调 `app_restart`。
/// 就绪与互斥记账走 `ready_state()`:同版本处理过不重复下载,并发轮次只放行一个。
///
/// **两个平台在这里必须分开走,因为"安装"的语义根本不同**(2026-08-07 Windows 真机暴露):
/// - macOS:安装 = 替换 `.app` 目录包,应用可以照常运行 → 直接装好,等重启生效;
/// - Windows:替换不了正在运行的 exe,tauri 的 `install()` 会**先把应用杀掉**
///   (`std::process::exit(0)`)再跑安装程序 → 在自动轮次里装,等于"用着用着应用
///   自己没了"。所以只**下载**、把字节留着,等用户按下重启按钮时才装。
///
/// 两条路对外的语义是**一致的**:`ready` = 新版内容已备好、点一下就生效,
/// 因此前端那个 pill 与 `app-update://ready` 事件一个字都不用改。
async fn stage_app_update(app: &tauri::AppHandle) -> Result<Staged, AppError> {
    let Some(update) = app_updater(app)?.check().await.map_err(update_err)? else {
        return Ok(Staged::NoUpdate);
    };
    let version = update.version.clone();
    if !ready_state().begin_stage(&version) {
        return Ok(Staged::AlreadyHandled);
    }

    #[cfg(target_os = "windows")]
    {
        let result = update.download(|_chunk, _total| {}, || {}).await;
        match result {
            Ok(bytes) => {
                let size = bytes.len();
                ready_state().finish_download(&version, bytes);
                let _ = app.emit("app-update://progress", "installed");
                tracing::info!(%version, size, "应用更新已下载,等待用户确认后安装");
            }
            Err(e) => {
                ready_state().abort_stage();
                return Err(AppError::new(
                    "UPDATE_INSTALL_FAILED",
                    "应用更新下载失败,已保持当前版本",
                )
                .with_detail(e.to_string()));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let result = update
            .download_and_install(
                |_chunk, _total| {},
                || {
                    // 下载完成、开始安装(阶段级进度,与获取流程同一诚实粒度)
                },
            )
            .await;
        if let Err(e) = result {
            ready_state().abort_stage();
            return Err(
                AppError::new("UPDATE_INSTALL_FAILED", "应用更新安装失败,已保持当前版本")
                    .with_detail(e.to_string()),
            );
        }
        ready_state().finish_stage(&version);
        let _ = app.emit("app-update://progress", "installed");
        tracing::info!(%version, "应用更新已安装,等待重启生效");
    }

    Ok(Staged::Fresh(version))
}

#[tauri::command]
pub async fn app_update_install(app: tauri::AppHandle) -> Result<(), AppError> {
    let staged = stage_app_update(&app).await?;
    if matches!(staged, Staged::NoUpdate) {
        return Err(AppError::new("UPDATE_GONE", "当前已是最新版本,无需安装"));
    }
    // 手动装完也发同一个就绪信号:pill 挂在它上面,只有自动轮次发的话,
    // 从设置页装的那条路永远不出 pill——同一件事两条路两种表现(2026-08-06 实测)。
    // 设置页手动点装:后台已就绪或正在装都算"这事有人管了",不报错。
    if let Some(version) = ready_state().ready_version() {
        let _ = app.emit("app-update://ready", &version);
    }
    Ok(())
}

/// 重启应用让新版本生效。
///
/// **macOS 上不能直接用 `app.restart()`**:它 spawn 包内可执行文件、绕开 LaunchServices,
/// 新进程在父进程随即退出时拿不到激活权——窗口建出来了却沉在所有应用后面,
/// 用户看到的是"重启完没有界面,点程序坞图标才出来"(2026-08-06 实测,对照见
/// `app_update::macos_bundle_path` 的文档)。改走 `open -n -a <bundle>`。
///
/// 认不出 `.app`(dev 构建)或 `open` 起不来时,回退到 `app.restart()`
/// ——重启不成比激活不了严重得多。
///
/// **Windows 上这里还兼着"安装"**:新版只下载了没装(见 `stage_app_update` 的说明),
/// 用户按下重启按钮才是安装时机。`install()` 成功的话进程在它内部就退出了,
/// 后面的重启代码根本执行不到——这是 tauri 的既定行为,不是漏写。
#[tauri::command]
pub async fn app_restart(app: tauri::AppHandle) {
    // Windows:先把下载好的新版装上。装的过程会退出应用,由 NSIS 接手。
    #[cfg(target_os = "windows")]
    if let Some(bytes) = ready_state().take_pending_install() {
        // install 要 Update 对象,而下载那一轮的对象早就 drop 了;重新 check 一次拿回来
        // (内网一次轻量请求)。拿不到就照常重启旧版——不能因为更新装不上就不让用户重启。
        match app_updater(&app) {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    tracing::info!("重启:先安装已下载的新版(安装程序会接管并退出本进程)");
                    if let Err(err) = update.install(bytes) {
                        // 走到这说明没退出成:装失败了。不把用户卡住,照常重启旧版。
                        tracing::warn!(error = %err, "新版安装失败,按普通重启继续");
                    }
                }
                Ok(None) => tracing::warn!("重启前远端已无更新信息,按普通重启继续"),
                Err(err) => tracing::warn!(error = %err, "重启前查更新失败,按普通重启继续"),
            },
            Err(err) => tracing::warn!(code = %err.code, "重启前拿不到 updater,按普通重启继续"),
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe()
        .ok()
        .and_then(|exe| app_update::macos_bundle_path(&exe))
    {
        match std::process::Command::new("open").arg("-n").arg("-a").arg(&bundle).spawn() {
            Ok(_) => {
                tracing::info!(bundle = %bundle.display(), "重启:已交给 LaunchServices 拉起新实例");
                // code=Some(0):防退出只挡 code=None,这一条走得通(见 lib.rs 的 ExitRequested)
                app.exit(0);
                return;
            }
            Err(err) => {
                tracing::warn!(error = %err, "open 拉起失败,回退到 tauri restart");
            }
        }
    }
    app.restart();
}

/// 启动时的一次性 App 更新检查(config.autoUpdate.app 开着且更新源已配置才跑)。
/// 假设:每次启动至多提醒一次,不做"忽略此版本"记忆——那是 M3 打磨项。
/// 起本地技能目录的文件监听(M4 任务 6c 级别 3)。
///
/// 三条不可让步的姿态,理由都在 `core::watcher` 模块头:
/// 1. **本应用自己的写入不上报**——`Installer::install` 是清空重建,那期间上报会让
///    前端读到半写状态(靠 `watcher::app_write()` 守卫 + 静默期);
/// 2. **起不来只记日志,不拦启动**——与托盘图标同款姿态,降级到级别 1 与 2;
/// 3. **绝不创建用户没要求的目录**——canonical 不在就盯父目录,父目录也不在就不起。
pub fn spawn_watcher(app: tauri::AppHandle) {
    use notify::{RecursiveMode, Watcher};

    let registry = AgentRegistry::builtin();
    let Some(canonical) = registry.canonical_global_dir(&SystemEnv) else {
        tracing::info!("跳过技能目录监听: 找不到用户主目录");
        return;
    };
    let Some(root) = watcher::watch_root(&canonical) else {
        tracing::info!(
            path = %canonical.display(),
            "跳过技能目录监听: 目录还不存在(装第一个技能后重启即可生效)"
        );
        return;
    };

    std::thread::spawn(move || {
        // 先钉死单调时钟的基准,再开始收事件——否则第一次调用 now_ms() 的地方
        // 会拿到 0,静音判定整个失准(见 core::watcher::now_ms 的文档)
        watcher::init_clock();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut w = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!(error = %e, "技能目录监听起不来,降级到窗口焦点刷新");
                return;
            }
        };
        if let Err(e) = w.watch(&root, RecursiveMode::Recursive) {
            tracing::warn!(error = %e, path = %root.display(), "技能目录监听注册失败");
            return;
        }
        tracing::info!(path = %root.display(), "技能目录监听已启动");

        let mut debouncer = watcher::Debouncer::default();
        loop {
            // 收事件用 TICK 超时轮询:既能及时收,又能在没有新事件时检查防抖是否到点
            match rx.recv_timeout(watcher::TICK) {
                Ok(Ok(event)) => {
                    if event.paths.iter().any(|p| watcher::is_interesting(&canonical, p)) {
                        debouncer.record(watcher::now_ms());
                    }
                }
                Ok(Err(e)) => tracing::debug!(error = %e, "技能目录监听事件出错"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                // 发送端没了 = watcher 被回收,退出线程
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if debouncer.take_due(watcher::now_ms()) {
                // 判定放在**吐出来的这一刻**而不是记录事件时:一次安装横跨整个防抖窗口,
                // 记录时还没开始写、吐出时才知道这批事件是不是自己造的
                if watcher::should_report() {
                    let _ = app.emit(watcher::CHANGED_EVENT, ());
                } else {
                    tracing::debug!("忽略本应用自己写盘引发的技能目录变更");
                }
            }
        }
    });
}

/// 一轮完整的 App 自更新:检查 → 静默下载安装 → 提示(M6 任务 1,Cursor 式体验)。
/// 启动探测与 scheduler 的每轮技能检查共用它;开关与配置**每轮现读**,
/// 对齐 `spawn_scheduler` 的 cadence 姿态——设置页改完,下一轮立刻生效。
pub async fn run_app_update_round(app: &tauri::AppHandle) {
    if !builtin::update_configured() {
        return;
    }
    let enabled = app_store()
        .and_then(|s| s.load_config())
        .map(|l| l.value.auto_update.app)
        .unwrap_or(true);
    if !enabled {
        return;
    }
    // 三个分支都要留痕:0.2.2 端到端验证时这里没日志,只能靠
    // "既无已最新也无失败"反推出"检出了新版",不该让人这么猜
    match stage_app_update(app).await {
        Ok(Staged::Fresh(version)) => {
            tracing::info!(%version, "应用新版本已在后台就绪,等待重启");
            let _ = app.emit("app-update://ready", &version);
            // 窗口可见时左下角 pill 已经在,系统通知只给缩进托盘的场景(2026-08-06 拍板)
            let visible = app
                .get_webview_window("main")
                .map(|w| w.is_visible().unwrap_or(false));
            if app_update::should_notify(visible) {
                use tauri_plugin_notification::NotificationExt;
                let (title, body) = app_update::ready_notification(&version);
                if let Err(err) = app.notification().builder().title(&title).body(&body).show() {
                    tracing::warn!(error = %err, "应用更新通知发送失败");
                }
            }
        }
        Ok(Staged::AlreadyHandled) => {
            tracing::debug!("应用更新:已就绪或正在下载,本轮不重复处理");
        }
        Ok(Staged::NoUpdate) => {
            tracing::info!("应用更新检查:已是最新");
        }
        Err(err) => {
            // detail 必须进日志:0.2.0 之前只记 code,http 端点被 updater 拒绝
            // 这种"配置问题"披着 NET_UPDATE 的皮装了很久的"网络问题"
            tracing::warn!(
                code = %err.code,
                detail = err.detail.as_deref().unwrap_or(""),
                "应用更新轮次未完成"
            );
        }
    }
}

/// App 自更新的常驻循环:启动后 20 秒查一次,之后每 [`app_update::CHECK_INTERVAL`] 一次。
///
/// **不再寄生技能检查的节拍**(2026-08-06 实测教训):原来 App 检查跟着技能那一拍走,
/// 于是技能档位设「手动」时调度循环根本不 tick,自动检查就只剩启动那一次;
/// 0.3.1 恰好在启动探测之后才发布,用户等到的是"什么都没发生"。
/// 开关每轮现读(`next_check_delay` 只看 `auto_update.app`),设置里关掉就停在下一轮。
pub fn spawn_app_update_probe(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 错开 skill 检查的首轮(10s),也给网络起身时间
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        loop {
            run_app_update_round(&app).await;
            let enabled = app_store()
                .and_then(|s| s.load_config())
                .map(|l| l.value.auto_update.app)
                .unwrap_or(true);
            // 关掉时不退出循环:用户可能在设置里再打开,退出了就要重启应用才恢复
            let delay = app_update::next_check_delay(enabled)
                .unwrap_or(app_update::CHECK_INTERVAL);
            tokio::time::sleep(delay).await;
        }
    });
}

/// 定时检查要遍历的 (源, 技能库) 清单(M4 任务 1)。
///
/// `run_check` 本来就按 owner/repo 过滤账目,**只查主库会漏掉追加库里装的技能**
/// ——那些技能永远等不到更新,而界面上看不出任何异常。清单直接取 [`registry::list`]
/// 的视图,与设置页看到的库列表同一份真相。
///
/// 提成纯函数是为了可测:`run_all_sources_check` 要 app handle 与真实网络,测不了。
fn check_targets(
    builtin: &registry::BuiltinSource,
    registries: &[state::RegistryConfig],
    builtin_extra: &[state::RepoConfig],
    plaza_repos: &[state::RepoConfig],
) -> Vec<(String, Option<String>)> {
    registry::list(builtin, registries, builtin_extra, plaza_repos)
        .into_iter()
        .flat_map(|view| {
            view.repos
                .into_iter()
                .map(move |repo| (view.id.clone(), Some(repo.key)))
        })
        .collect()
}

/// 一轮逐源检查(M3 任务 2):内建 + 全部自定义源 + 广场依次跑,一个源失败不拦其他源。
/// 返回 `None` = 没有任何源成功跑完(全失败或没有可查的源),这一轮不上报
/// ——把"全挂了"报成 `NothingInstalled` 等于撒谎。
///
/// **广场必须走同一条枚举路径**(M9 任务 2):`check_targets` 直接取 [`registry::list`]
/// 的视图,广场行已经在里面——不另写一套"内建 + 自定义"的清单再补一句"顺便查查广场",
/// 那种写法漏一次都不会有任何测试变红(见本函数上方 `check_targets` 的用途注释)。
async fn run_all_sources_check() -> Option<scheduler::CheckReport> {
    let store = app_store().ok()?;
    let (registries_cfg, builtin_extra, plaza_repos) = match store.load_config() {
        Ok(l) => (l.value.registries, l.value.builtin_extra_repos, l.value.plaza_repos),
        Err(err) => {
            tracing::warn!(code = %err.code, "定时检查读不到配置,本轮跳过");
            return None;
        }
    };
    let builtin_src = registry::BuiltinSource::from_build();
    let registry = AgentRegistry::builtin();

    let targets = check_targets(&builtin_src, &registries_cfg, &builtin_extra, &plaza_repos);

    let mut reports = Vec::new();
    for (id, repo_key) in targets {
        let Ok(resolved) = registry::resolve(
            &builtin_src,
            &registries_cfg,
            &builtin_extra,
            &id,
            repo_key.as_deref(),
            &plaza_repos,
        ) else {
            // 内建未注入配置的开发构建每轮都走到这:记 debug 免得刷日志
            tracing::debug!(registry_id = %id, "定时检查跳过该源(解析失败)");
            continue;
        };
        let round = async {
            let (client, repo) = read_source(&id, repo_key.as_deref()).await?;
            scheduler::run_check(
                &client,
                &registry,
                &SystemEnv,
                &store,
                acquire::SourceMeta {
                    registry_id: &id,
                    kind: resolved.kind.as_str(),
                    base_url: &resolved.base_url,
                },
                &repo,
                &now_iso8601(),
                auth::now_unix(),
            )
            .await
        };
        match round.await {
            Ok(report) => reports.push(report),
            Err(err) => {
                // 连不上内网等环境性失败:记日志,继续查别的源(下一轮再试)
                tracing::warn!(registry_id = %id, code = %err.code, detail = ?err.detail, "定时检查未完成");
            }
        }
    }
    (!reports.is_empty()).then(|| scheduler::merge_reports(reports))
}

/// 组装并启动定时更新检查。M3 任务 2 起 scheduler 常驻:哪些源可查在每轮里
/// 现场判断(内建未配置就只查自定义源),不再以"内建已配置"为启动条件。
pub fn spawn_scheduler(app: tauri::AppHandle) -> Option<scheduler::Scheduler> {
    let cadence = || {
        // 每次决策都重读 config:设置页改完频率,下一次决策立刻按新值走
        let auto = app_store()
            .and_then(|s| s.load_config())
            .map(|l| l.value.auto_update)
            .unwrap_or_default();
        scheduler::Cadence {
            enabled: auto.skills.enabled,
            interval_minutes: auto.skills.interval_minutes,
        }
    };

    let check = move || -> scheduler::BoxFuture {
        let app = app.clone();
        Box::pin(async move {
            // App 自更新**不再挂在这一拍上**(2026-08-06 用户拍板解耦):它有自己的
            // 常驻循环(spawn_app_update_probe,每分钟一轮),与技能档位互不影响。
            let Some(report) = run_all_sources_check().await else {
                return;
            };
            let _ = app.emit("scheduler://report", &report);
            // 有实际动作才弹系统通知(M2 任务 4;判定与文案在 core,有单测钉住)
            if let Some((title, body)) = scheduler::notification_copy(&report) {
                use tauri_plugin_notification::NotificationExt;
                if let Err(err) = app.notification().builder().title(&title).body(&body).show() {
                    tracing::warn!(error = %err, "系统通知发送失败");
                }
            }
        })
    };

    let (handle, fut) = scheduler::make(cadence, check);
    tauri::async_runtime::spawn(fut);
    Some(handle)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisabledAgentsArgs {
    pub disabled: Vec<String>,
}

#[tauri::command]
pub fn agents_set_disabled(args: DisabledAgentsArgs) -> Result<(), AppError> {
    app_store()?.save_disabled_agents(&args.disabled)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenUrlArgs {
    pub url: String,
}

/// 在系统浏览器里打开技能库页面(评审链接等)。
/// 白名单:与任一已配置源(内建 + 自定义)同源才放行,判定在 `registry::url_allowed`。
#[tauri::command]
pub fn open_library_url(args: OpenUrlArgs) -> Result<(), AppError> {
    let registries = app_store()?.load_config()?.value.registries;
    if !registry::url_allowed(
        &registry::BuiltinSource::from_build(),
        &registries,
        &args.url,
    ) {
        return Err(AppError::new(
            "REPO_UNTRUSTED_URL",
            "这个链接不属于任何已配置的技能库,已阻止打开",
        )
        .with_detail(args.url));
    }
    session::BrowserOpener::open(&SystemBrowser, &args.url)
}

// ============================================================ 仓库源管理(M3 任务 1)

#[tauri::command]
pub fn registry_list() -> Result<Vec<registry::RegistryView>, AppError> {
    let config = app_store()?.load_config()?.value;
    Ok(registry::list(
        &registry::BuiltinSource::from_build(),
        &config.registries,
        &config.builtin_extra_repos,
        &config.plaza_repos,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAddArgs {
    pub name: String,
    /// `gitea` | `github`(github 源的访问在任务 4 接通前会被拦)。
    pub kind: String,
    pub base_url: String,
    pub owner: String,
    pub repo: String,
    #[serde(default)]
    pub branch: Option<String>,
}

/// 新增自定义源,返回更新后的完整列表(前端直接整份换,免一次往返)。
#[tauri::command]
pub fn registry_add(args: RegistryAddArgs) -> Result<Vec<registry::RegistryView>, AppError> {
    let store = app_store()?;
    let mut config = store.load_config()?.value;
    registry::add(
        &mut config.registries,
        &registry::AddRegistryRequest {
            name: &args.name,
            kind: &args.kind,
            base_url: &args.base_url,
            owner: &args.owner,
            repo: &args.repo,
            branch: args.branch.as_deref(),
        },
    )?;
    store.save_config(&config)?;
    Ok(registry::list(
        &registry::BuiltinSource::from_build(),
        &config.registries,
        &config.builtin_extra_repos,
        &config.plaza_repos,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRemoveArgs {
    pub registry_id: String,
}

/// 移除自定义源(内建源在 core 层被拒)。**已装技能保留**(铁律 7,「我的技能」里
/// 会标"来源已移除");该源的登录凭证与索引缓存一并清掉——凭证是敏感遗产,
/// 缓存则会在同 id 复用时冒充新源的数据(id 不复用,但缓存文件没理由留)。
#[tauri::command]
pub fn registry_remove(args: RegistryRemoveArgs) -> Result<Vec<registry::RegistryView>, AppError> {
    let store = app_store()?;
    let mut config = store.load_config()?.value;
    registry::remove(&mut config.registries, &args.registry_id)?;
    store.save_config(&config)?;
    if let Err(err) = session::logout(&KeyringStore, &args.registry_id) {
        tracing::warn!(registry_id = %args.registry_id, code = %err.code, "移除源时清理凭证失败");
    }
    // 缓存按 (源,仓) 分文件(M4 任务 1):按前缀清掉该源全部仓的缓存,含旧命名。
    store::drop_caches_for_registry(store.dir(), &args.registry_id);
    Ok(registry::list(
        &registry::BuiltinSource::from_build(),
        &config.registries,
        &config.builtin_extra_repos,
        &config.plaza_repos,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAddRepoArgs {
    pub registry_id: String,
    pub owner: String,
    pub repo: String,
    #[serde(default)]
    pub branch: Option<String>,
    /// 可选展示名;空白折成无。
    #[serde(default)]
    pub name: Option<String>,
}

/// 给某个源追加技能库(M4 任务 1)。内建源的追加仓与内建 Gitea 天然同源
/// (base_url 取编译期常量),自定义源落它自己的仓列表。返回更新后的完整列表。
#[tauri::command]
pub fn registry_add_repo(
    args: RegistryAddRepoArgs,
) -> Result<Vec<registry::RegistryView>, AppError> {
    let store = app_store()?;
    let mut config = store.load_config()?.value;
    let builtin_src = registry::BuiltinSource::from_build();
    registry::add_repo(
        &builtin_src,
        &mut config.registries,
        &mut config.builtin_extra_repos,
        &args.registry_id,
        &registry::AddRepoRequest {
            owner: &args.owner,
            repo: &args.repo,
            branch: args.branch.as_deref(),
            name: args.name.as_deref(),
        },
    )?;
    store.save_config(&config)?;
    Ok(registry::list(
        &builtin_src,
        &config.registries,
        &config.builtin_extra_repos,
        &config.plaza_repos,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryRemoveRepoArgs {
    pub registry_id: String,
    /// 仓库寻址键 `owner/repo`(RepoView.key 原样带回)。
    pub repo: String,
}

/// 从源里移除一个技能库。**已装技能保留**(与移除整源同一铁律),该仓的索引缓存清掉;
/// 凭证按源不按仓,不动。
#[tauri::command]
pub fn registry_remove_repo(
    args: RegistryRemoveRepoArgs,
) -> Result<Vec<registry::RegistryView>, AppError> {
    let store = app_store()?;
    let mut config = store.load_config()?.value;
    let builtin_src = registry::BuiltinSource::from_build();
    let removed = registry::remove_repo(
        &builtin_src,
        &mut config.registries,
        &mut config.builtin_extra_repos,
        &args.registry_id,
        &args.repo,
    )?;
    store.save_config(&config)?;
    store::drop_cache(&store::cache_path(
        store.dir(),
        &args.registry_id,
        &RepoRef {
            owner: removed.owner,
            repo: removed.repo,
            branch: removed.branch,
        },
    ));
    Ok(registry::list(
        &builtin_src,
        &config.registries,
        &config.builtin_extra_repos,
        &config.plaza_repos,
    ))
}

// ============================================================ 登录

/// 用 tauri-plugin-opener 打开系统浏览器。
struct SystemBrowser;

impl BrowserOpener for SystemBrowser {
    fn open(&self, url: &str) -> Result<(), AppError> {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| {
            AppError::new("AUTH_OPEN_BROWSER", "无法打开浏览器,请手动复制链接完成登录")
                .with_detail(format!("{e}; url={url}"))
        })
    }
}

/// 解析某个源的某个技能库(不限 kind,github 的闸门由各调用方按需加)。
/// `repo_key = None` 落主仓——登录等仓无关的调用方都走这一档。
/// 写 `.skill-lock.json` 要用的来源标识(kind 与 base_url 都取自解析结果,不猜)。
/// 返回**拥有所有权**的两段字符串,调用方再借出去组 [`acquire::SourceMeta`]。
fn source_meta_parts(
    registry_id: &str,
    repo_key: Option<&str>,
) -> Result<(&'static str, String), AppError> {
    let r = resolve_registry(registry_id, repo_key)?;
    Ok((r.kind.as_str(), r.base_url))
}

fn resolve_registry(
    registry_id: &str,
    repo_key: Option<&str>,
) -> Result<registry::ResolvedRegistry, AppError> {
    let config = app_store()?.load_config()?.value;
    registry::resolve(
        &registry::BuiltinSource::from_build(),
        &config.registries,
        &config.builtin_extra_repos,
        registry_id,
        repo_key,
        &config.plaza_repos,
    )
}

/// 源级解析(M9 终审修复):给不需要具体技能库坐标的操作用——目前只有登录/凭证管理
/// 五个 `auth_*` command。与 [`resolve_registry`] 的区别只在于**不要求任何仓存在**,
/// 广场因此能正常解出源级坐标而不必先挂一个仓(`registry::resolve_source` 文档
/// 详述理由)。仍然只有 `registry::resolve_source` 这一处真正的解析逻辑,这里只是
/// 把 `app_store()` 的读取包一层,与 `resolve_registry` 同款套路。
fn resolve_source(registry_id: &str) -> Result<registry::ResolvedSource, AppError> {
    let config = app_store()?.load_config()?.value;
    registry::resolve_source(
        &registry::BuiltinSource::from_build(),
        &config.registries,
        registry_id,
    )
}

/// 某个源的登录配置。内建:OAuth PKCE;自定义:PAT(client_id 留空,判定在 core)。
fn auth_config(registry_id: &str) -> Result<OAuthConfig, AppError> {
    let resolved = resolve_registry(registry_id, None)?;
    resolved.require_gitea()?;
    resolved.auth_config(builtin::OAUTH_CLIENT_ID)
}

/// 按源选 HTTP client(M3 任务 3):内建源直连内网;外部源跟随系统代理,
/// 公司代理网络下外网只有经代理才通。两档都带统一 UA,策略只在 gitea.rs 一处定义。
fn http_client_for(registry_id: &str) -> Result<reqwest::Client, AppError> {
    if registry_id == BUILTIN_REGISTRY_ID {
        crate::core::gitea::app_http_client()
    } else {
        crate::core::gitea::app_http_client_proxied()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryArg {
    #[serde(default)]
    pub registry_id: Option<String>,
}

impl RegistryArg {
    fn id(&self) -> &str {
        self.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID)
    }
}

#[tauri::command]
pub async fn auth_login_oauth(args: RegistryArg) -> Result<SessionUser, AppError> {
    let resolved = resolve_source(args.id())?;
    resolved.require_gitea()?;
    // OAuth 应用是逐 Gitea 实例注册的,自定义源没有 Client ID 可用——只有 PAT 通道
    if !resolved.builtin {
        return Err(AppError::new(
            "AUTH_TOKEN_ONLY",
            "这个技能库来源不支持一键登录,请改用登录凭证",
        ));
    }
    session::login_oauth(
        &http_client_for(args.id())?,
        &resolved.auth_config(builtin::OAUTH_CLIENT_ID)?,
        &KeyringStore,
        &SystemBrowser,
        args.id(),
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginTokenArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    pub token: String,
}

#[tauri::command]
pub async fn auth_login_token(args: LoginTokenArgs) -> Result<SessionUser, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let resolved = resolve_source(registry_id)?;
    match resolved.kind {
        registry::RegistryKind::Gitea => {
            session::login_with_token(
                &http_client_for(registry_id)?,
                &auth_config(registry_id)?,
                &KeyringStore,
                registry_id,
                &args.token,
            )
            .await
        }
        registry::RegistryKind::Github => {
            session::github_login_token(
                &http_client_for(registry_id)?,
                &resolved.base_url,
                &KeyringStore,
                registry_id,
                &args.token,
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn auth_status(args: RegistryArg) -> Result<SessionStatus, AppError> {
    let resolved = resolve_source(args.id())?;
    match resolved.kind {
        registry::RegistryKind::Gitea => {
            session::status(
                &http_client_for(args.id())?,
                &auth_config(args.id())?,
                &KeyringStore,
                args.id(),
            )
            .await
        }
        registry::RegistryKind::Github => {
            session::github_status(
                &http_client_for(args.id())?,
                &resolved.base_url,
                &KeyringStore,
                args.id(),
            )
            .await
        }
    }
}

// ============================================================ GitHub device flow(M3 任务 5)

/// `auth_device_start` 的返回。`deviceCode` 由前端在 `auth_device_wait` 原样带回,
/// 不落盘不进日志(短命中间凭证)。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartView {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// 发起 GitHub 一键登录:拿用户码并打开授权页。等待段在 `auth_device_wait`。
#[tauri::command]
pub async fn auth_device_start(args: RegistryArg) -> Result<DeviceStartView, AppError> {
    let resolved = resolve_source(args.id())?;
    if resolved.kind != registry::RegistryKind::Github {
        return Err(AppError::new(
            "AUTH_DEVICE_UNSUPPORTED",
            "这个技能库来源请使用原有的登录方式",
        ));
    }
    let client_id = builtin::github_client_id()?;
    let codes = github::start_device_flow(
        &http_client_for(args.id())?,
        &resolved.base_url,
        client_id,
    )
    .await?;
    // 先开授权页再返回:用户看到用户码时浏览器已经在等着输入了
    session::BrowserOpener::open(&SystemBrowser, &codes.verification_uri)?;
    Ok(DeviceStartView {
        device_code: codes.device_code,
        user_code: codes.user_code,
        verification_uri: codes.verification_uri,
        expires_in: codes.expires_in,
        interval: codes.interval,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceWaitArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    pub device_code: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// device flow 的等待段:轮询到用户在浏览器完成授权(或明确失败)为止。
/// 假设:前端取消只是不再等结果,轮询在 core 里跑到过期自然结束——GitHub 的
/// 轮询端点无副作用;若用户随后仍完成了授权,凭证照常入钥匙串,下次查状态即已登录。
#[tauri::command]
pub async fn auth_device_wait(args: DeviceWaitArgs) -> Result<SessionUser, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let resolved = resolve_source(registry_id)?;
    if resolved.kind != registry::RegistryKind::Github {
        return Err(AppError::new(
            "AUTH_DEVICE_UNSUPPORTED",
            "这个技能库来源请使用原有的登录方式",
        ));
    }
    let codes = github::DeviceCodes {
        device_code: args.device_code,
        user_code: String::new(),
        verification_uri: String::new(),
        expires_in: args.expires_in,
        interval: args.interval,
    };
    session::github_login_device(
        &http_client_for(registry_id)?,
        &resolved.base_url,
        builtin::github_client_id()?,
        &KeyringStore,
        registry_id,
        &codes,
    )
    .await
}

#[tauri::command]
pub fn auth_logout(args: RegistryArg) -> Result<(), AppError> {
    session::logout(&KeyringStore, args.id())
}

// ============================================================ 商店

/// 分享链路的来源分发(M3-5b):按源类型构造**已登录**客户端。
/// 写链路刻意不进 trait(见 share.rs 的 ShareClient 注释),这里的枚举
/// 与读链路的 [`SourceClient`] 是同一种分发模式。
enum ShareSource {
    Gitea(GiteaClient),
    Github(github::GithubClient),
}

impl ShareSource {
    fn as_share_client(&self) -> share::ShareClient<'_> {
        match self {
            Self::Gitea(c) => share::ShareClient::Gitea(c),
            Self::Github(c) => share::ShareClient::Github(c),
        }
    }
}

async fn share_source(
    registry_id: &str,
    repo_key: Option<&str>,
) -> Result<(ShareSource, RepoRef), AppError> {
    let resolved = resolve_registry(registry_id, repo_key)?;
    let repo = resolved.repo.clone();
    match resolved.kind {
        registry::RegistryKind::Gitea => {
            let client = authed_client(registry_id).await?;
            Ok((ShareSource::Gitea(client), repo))
        }
        registry::RegistryKind::Github => {
            // 分享必须实名(与读链路"取不到凭证降级匿名"相反):匿名提交无从谈起
            let http = http_client_for(registry_id)?;
            let token = KeyringStore
                .load(registry_id)?
                .map(|c| c.access_token)
                .ok_or_else(|| {
                    AppError::new("AUTH_REQUIRED", "分享前请先在设置中登录这个技能库")
                })?;
            Ok((
                ShareSource::Github(github::GithubClient::new(
                    &resolved.base_url,
                    Some(token),
                    http,
                )),
                repo,
            ))
        }
    }
}

/// 商店索引的缓存落点。与 config/state 同目录(`~/.skillsync`),按 (源,仓) 分文件。
fn index_cache_file(registry_id: &str, repo: &RepoRef) -> Result<std::path::PathBuf, AppError> {
    Ok(store::cache_path(app_store()?.dir(), registry_id, repo))
}

/// 读链路的来源分发(M3 任务 4):store/acquire/scheduler 拿到的都是这个 enum,
/// 具体是 Gitea 还是 GitHub 在此处消化,core 编排对来源类型无感。
enum SourceClient {
    Gitea(GiteaClient),
    Github(github::GithubClient),
}

impl crate::core::gitea::RepoSource for SourceClient {
    async fn branch_head(
        &self,
        r: &RepoRef,
    ) -> Result<crate::core::gitea::BranchHead, AppError> {
        match self {
            Self::Gitea(c) => c.branch_head(r).await,
            Self::Github(c) => c.branch_head(r).await,
        }
    }
    async fn download_archive(
        &self,
        r: &RepoRef,
    ) -> Result<crate::core::gitea::RepoArchive, AppError> {
        match self {
            Self::Gitea(c) => c.download_archive(r).await,
            Self::Github(c) => c.download_archive(r).await,
        }
    }
}

/// GitHub 源的凭证加载:取 keyring 里存的 access token,取不到就降级匿名。
///
/// **只服务 GitHub 分支**(`read_source` 的 Github 臂 + `plaza_detail` 的未挂仓臂,
/// 这是全仓仅有的两处 `CredentialStore::load` 调用点,M9 任务 4 审查发现两处曾是
/// 逐行同构的重复代码)——**不要**为了对称把 Gitea 分支也改成调用它:Gitea 走的是
/// `auth::ensure_access_token`,那条路有令牌刷新语义(过期会用 `refresh_token` 静默
/// 换新并回写存储);**GitHub device flow 令牌当前没有刷新机制**(上游本身如此,
/// `session::github_login_device` 存下的就是一枚长期有效的 token),这里"直接读、
/// 读不到就匿名"的语义与 Gitea 分支不同,不该往它那边对齐,也不该指望它将来长出
/// 同款刷新逻辑就顺手改这里——真要加 GitHub 侧的令牌刷新,那是一次独立的设计决策。
///
/// 失败(钥匙串读不出等)不是硬错误:记日志后返回 `None`,调用方据此构造匿名 client
/// ——与自定义 Gitea 源"取不到凭证降级匿名"同一套姿势。`store` 参数化是为了让这条
/// 路径脱离真实系统钥匙串直接单测(见 `tests` 模块 `load_github_token_*` 系列);
/// 生产两处调用都传 `&KeyringStore`。
fn load_github_token(store: &impl CredentialStore, registry_id: &str) -> Option<String> {
    match store.load(registry_id) {
        Ok(creds) => creds.map(|c| c.access_token),
        Err(err) => {
            tracing::warn!(registry_id, code = %err.code, "读取凭证失败,按匿名访问");
            None
        }
    }
}

/// 读链路入口:解析源 → 构造对应 client,返回访问坐标。
///
/// **刻意不看 OAuth 配置**:技能库公开可匿名读,商店浏览先于登录(产品前提,
/// 测试钉在 registry.rs)。凭证策略按源:内建源一律匿名(公开可读,M1 实测,
/// 带过期令牌反而把能成的匿名请求变成 401);自定义 Gitea 源可能是私有库,
/// 有凭证就带上,取不出来降级匿名;GitHub 源任务 4 先匿名(公共库),
/// 凭证随 device flow(任务 5)接入。
async fn read_source(
    registry_id: &str,
    repo_key: Option<&str>,
) -> Result<(SourceClient, RepoRef), AppError> {
    let resolved = resolve_registry(registry_id, repo_key)?;
    let http = http_client_for(registry_id)?;
    let client = match resolved.kind {
        registry::RegistryKind::Github => {
            // 任务 5 起带上 device flow / PAT 存下的凭证(私有库可读);
            // 取不出来降级匿名,与自定义 Gitea 源同语义
            let token = load_github_token(&KeyringStore, registry_id);
            SourceClient::Github(github::GithubClient::new(&resolved.base_url, token, http))
        }
        registry::RegistryKind::Gitea if resolved.builtin => {
            SourceClient::Gitea(GiteaClient::with_http(resolved.base_url.clone(), None, http))
        }
        registry::RegistryKind::Gitea => {
            let cfg = resolved.auth_config(builtin::OAUTH_CLIENT_ID)?;
            let token =
                match auth::ensure_access_token(&http, &cfg, &KeyringStore, registry_id).await {
                    Ok(t) => t,
                    Err(err) => {
                        // 凭证层故障(钥匙串读不出等)不拦浏览:降级匿名,原因进日志
                        tracing::warn!(registry_id, code = %err.code, "读取凭证失败,按匿名访问");
                        None
                    }
                };
            SourceClient::Gitea(GiteaClient::with_http(resolved.base_url.clone(), token, http))
        }
    };
    Ok((client, resolved.repo))
}

/// 分享是写操作,必须带登录凭证。没登录给一个前端能识别的错误码,引导去登录。
async fn authed_client(registry_id: &str) -> Result<GiteaClient, AppError> {
    let http = http_client_for(registry_id)?;
    let cfg = auth_config(registry_id)?;
    let token = auth::ensure_access_token(&http, &cfg, &KeyringStore, registry_id)
        .await?
        .ok_or_else(|| AppError::new("AUTH_REQUIRED", "分享前请先在设置中登录这个技能库"))?;
    Ok(GiteaClient::with_http(cfg.base_url.clone(), Some(token), http))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreIndexArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    /// 仓库寻址键 `owner/repo`(M4 任务 1),缺省 = 该源主仓。
    #[serde(default)]
    pub repo: Option<String>,
    /// 用户手动点刷新:跳过"版本没变就不下载"的判定。
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub async fn store_index(args: StoreIndexArgs) -> Result<StoreIndexView, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (client, repo) = read_source(registry_id, args.repo.as_deref()).await?;
    let cache = index_cache_file(registry_id, &repo)?;
    let (index, outcome) = store::refresh_index(
        &client,
        &repo,
        registry_id,
        &cache,
        args.force,
        auth::now_unix(),
    )
    .await?;
    Ok(index.to_view(outcome.from_cache, outcome.offline))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDetailArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    /// 仓库寻址键 `owner/repo`,缺省 = 该源主仓。
    #[serde(default)]
    pub repo: Option<String>,
    /// 技能库中的技能目录名(卡片上展示的 slug 后半段)。
    pub dir_slug: String,
}

#[tauri::command]
pub async fn store_skill_detail(args: StoreDetailArgs) -> Result<SkillDetail, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (client, repo) = read_source(registry_id, args.repo.as_deref()).await?;
    let cache = index_cache_file(registry_id, &repo)?;

    // 详情走缓存:打开面板不该再等一次网络往返。
    if let Some(detail) = store::load_cache(&cache)
        .filter(|index| index.is_for(registry_id, &repo))
        .and_then(|index| index.detail(&args.dir_slug))
    {
        return Ok(detail);
    }

    // 缓存里没有(首次进入、或缓存刚被丢弃):刷一次再找。
    let (index, _) = store::refresh_index(
        &client,
        &repo,
        registry_id,
        &cache,
        false,
        auth::now_unix(),
    )
    .await?;
    index.detail(&args.dir_slug).ok_or_else(|| {
        AppError::new(
            "REPO_NOT_FOUND",
            "这个技能已不在公司技能库中,请返回列表刷新后再试",
        )
    })
}

// ============================================================ 获取

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    /// 仓库寻址键 `owner/repo`,缺省 = 该源主仓。商店语境带当前浏览的仓;
    /// 「我的技能」的更新带账上的来源坐标——多仓下缺省会打到主仓,别省。
    #[serde(default)]
    pub repo: Option<String>,
    /// 技能库中的技能目录名。
    pub dir_slug: String,
    /// 要关联到哪些 AI 工具。空数组表示只落到 canonical(universal agent 即可见)。
    #[serde(default)]
    pub agent_ids: Vec<String>,
    /// 长任务进度事件的频道后缀:前端监听 `progress://{taskId}`。
    pub task_id: String,
    /// 冲突时的处置。首次调用不带,由前端拿到 `needsDecision` 后再带上重试。
    #[serde(default)]
    pub resolution: Option<acquire::Resolution>,
}

/// 广场安装走 blob 时,仓库树的进程内缓存(M10 任务 3)。键是 `(owner, repo, sha)`,
/// 值是那次 `git/trees` 响应的解析结果。**这份缓存不需要失效逻辑,也不该加**:
/// key 里带着具体的 commit sha,同一个 sha 对应的树内容是不可变的——不像
/// `plaza_detail_cache`(键只到 owner/repo,同一个键在不同时间点可能对应不同内容,
/// 所以那边要专门论证"为什么不用管失效")。只活在这一次运行的进程里,不落盘,
/// 存在的意义是"同一个仓装多个技能时不必重复拉一次 500KB 级的树"。
type RepoTreeCache = Mutex<HashMap<(String, String, String), github::RepoTree>>;

fn repo_tree_cache() -> &'static RepoTreeCache {
    static CACHE: OnceLock<RepoTreeCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 缓存优先地取某个 `(owner, repo, sha)` 的仓库树:命中直接返回;否则现拉一次
/// (`GithubClient::tree`)并记进缓存。**GitHub 的树 API 也吃匿名 60 次/小时的配额**
/// ——这份缓存是唯一的缓解手段;登录后走带凭证的 client(既有机制,见
/// `read_source`)配额会宽松很多,这里不用额外做什么。
async fn cached_repo_tree(
    cache: &RepoTreeCache,
    github_client: &github::GithubClient,
    repo: &RepoRef,
    sha: &str,
) -> Result<github::RepoTree, AppError> {
    let key = (repo.owner.clone(), repo.repo.clone(), sha.to_string());
    if let Some(hit) = cache.lock().expect("仓库树缓存锁不该中毒").get(&key).cloned() {
        return Ok(hit);
    }
    let tree = github_client.tree(repo, sha).await?;
    cache
        .lock()
        .expect("仓库树缓存锁不该中毒")
        .insert(key, tree.clone());
    Ok(tree)
}

/// 广场安装的 blob 快路径编排(M10 任务 3):`branch_head`(拿 sha)→ blob 取数
/// → 白名单/frontmatter 检查([`plaza::blob_install_candidate`])→ 仓库树
/// (缓存,见 [`cached_repo_tree`])解出真实路径 → 拼成 `acquire::acquire_prefetched`
/// 要的素材。
///
/// 任意一步失败都原样把 `Err` 交还给调用方——调用方([`skill_install`])据此静默
/// 回退到完全不动的 zipball 路径,这里不需要、也不应该替调用方决定"要不要重试"。
async fn install_via_plaza_blob(
    github_client: &github::GithubClient,
    repo: &RepoRef,
    blob_http: &reqwest::Client,
    blob_api_base: &str,
    tree_cache: &RepoTreeCache,
    dir_slug: &str,
) -> Result<(store::IndexedSkill, installer::SkillPayload, String), AppError> {
    let head = github_client.branch_head(repo).await?;
    let files = plaza::fetch_blob(blob_http, blob_api_base, &repo.owner, &repo.repo, dir_slug).await?;
    let candidate = plaza::blob_install_candidate(dir_slug, files)?;
    let tree = cached_repo_tree(tree_cache, github_client, repo, &head.sha).await?;
    let path = github::resolve_skill_path(&tree, dir_slug)
        .ok_or_else(|| plaza::blob_path_unresolved_err(dir_slug, &head.sha))?;
    let (skill, payload) = plaza::finish_blob_install(dir_slug, candidate, path);
    Ok((skill, payload, head.sha))
}

#[tauri::command]
pub async fn skill_install(
    app: tauri::AppHandle,
    args: InstallArgs,
) -> Result<acquire::AcquireOutcome, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (client, repo) = read_source(registry_id, args.repo.as_deref()).await?;
    let (kind, base_url) = source_meta_parts(registry_id, args.repo.as_deref())?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    // core 不认识 Tauri:编排只收一个回调,事件在这一层发。
    let channel = format!("progress://{}", args.task_id);
    let emit = |stage: acquire::Stage| {
        let _ = app.emit(channel.as_str(), stage);
    };

    let req = acquire::AcquireRequest {
        source: acquire::SourceMeta { registry_id, kind, base_url: &base_url },
        repo: &repo,
        dir_slug: &args.dir_slug,
        agent_names: &args.agent_ids,
        resolution: args.resolution,
    };

    // 广场技能优先尝试 blob 快路径(M10 任务 3):不适用的一切情况(见
    // `plaza::blob_install_candidate`/`install_via_plaza_blob` 的判据清单,尤其是
    // "仓内真实路径解不出来"那一条,模块头「path 缺口」有完整说明)一律静默回退到
    // 完全不动的 zipball 路径。只对 `PLAZA_REGISTRY_ID` 尝试——skills.sh 的 blob
    // 端点只收录了广场技能,自定义/内建源没有对应数据,试了也必然 404。
    if registry_id == registry::PLAZA_REGISTRY_ID {
        if let SourceClient::Github(github_client) = &client {
            // 这段窗口(blob + trees,实测 6 秒级)没有阶段性进度可报,先给一个
            // Fetching 让进度条动起来,免得用户以为卡住了;真正回退 zipball 时
            // `acquire::acquire` 会再发一次同样的 Fetching,重复发同一个值无害。
            emit(acquire::Stage::Fetching);
            let blob_http = http_client_for(registry_id)?;
            let attempt = install_via_plaza_blob(
                github_client,
                &repo,
                &blob_http,
                plaza::PLAZA_API_BASE,
                repo_tree_cache(),
                &args.dir_slug,
            )
            .await;
            // 回退本身**不改用户可见行为**(照旧静默走 zipball)——这行日志只服务
            // 线上排查:此前完全没有任何痕迹,"为什么这个技能还是慢"排查不出方向。
            if let Err(err) = &attempt {
                tracing::debug!(
                    dir_slug = %args.dir_slug, code = %err.code,
                    "广场安装 blob 快路径不适用,回退整仓压缩包"
                );
            }
            if let Ok((skill, payload, remote_sha)) = attempt {
                return acquire::acquire_prefetched(
                    &registry,
                    &SystemEnv,
                    &store,
                    req,
                    &skill,
                    payload,
                    &remote_sha,
                    &now_iso8601(),
                    &emit,
                )
                .await;
            }
        }
    }

    acquire::acquire(
        &client,
        &registry,
        &SystemEnv,
        &store,
        req,
        &now_iso8601(),
        auth::now_unix(),
        &emit,
    )
    .await
}

/// 已安装技能的概览,「我的技能」页的整行数据都从这里来。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkillView {
    /// 安装目录名,也是商店卡片的 `dirSlug`。
    pub dir_slug: String,
    pub commit_sha: String,
    /// 安装(或认领)那一刻的内容哈希,是**这个技能这一版**的指纹。
    ///
    /// 「有可用更新」= 它 != 商店卡片的 `contentHash`。**不要改用 commitSha 比**:
    /// 那是整库 HEAD,库里任何一次提交(比如别人分享了另一个技能)都会让
    /// 所有已装技能被判成有更新——2026-08-03 用户实测撞到过。
    /// 用户改过本体时它**保持不变**(acquire 保留改动时刻意不更新),所以判定仍准确。
    pub content_hash: String,
    pub agents: Vec<String>,
    pub installed_at: String,
    pub updated_at: String,
    /// 本体与安装时不一致——用户改过,有未分享的改动。
    pub local_modified: bool,
    /// 来源技能库,展示为 `owner/repo`。
    pub source_owner: String,
    pub source_repo: String,
    /// 来源 registry(更新/回推改动时前端原样带回,不展示给用户)。
    pub registry_id: String,
    /// 来源已解析不出来(自定义源被移除,或该构建没配内建源):
    /// 技能照常可用可移除,但更新与回推没了去处,界面要正面说出来。
    pub source_removed: bool,
    /// **源还在,但这个技能库不在源的库列表里**(M4 任务 2)。
    ///
    /// 两条路径会走到:M3 的 `bind_source` 只比同源不校验库,认领时可能把
    /// `host/someone/other-repo` 的技能绑到该 host 的源上(存量条目);
    /// 或用户后来把这个库从源里移除了。它与 `source_removed` 的去向相同
    /// (更新/回推没有去处),但**说法不同**——把它说成"来源已移除"是假话,源好好的。
    pub library_removed: bool,
    /// 其他工具装的、**尚未纳入管理**(M3 任务 6;M6 任务 4 改名,原称"认领")。
    pub unclaimed: bool,
    /// 仅对 `unclaimed` 有意义:纳入管理后绑不绑得上某个技能库(M6 任务 4)。
    ///
    /// false 时界面**不摆「纳入管理」**——绑不上的纳入只多出"修复关联"与"移除",
    /// 那不值得让用户点。改摆「分享到技能库」,那才是他真正想要的出路。
    pub claim_bindable: bool,
    /// **本地技能**:自己新建的、或手放进 canonical 的。既不在 `state.installed`,
    /// 也不在 `.skill-lock.json` 里,因此没有来源、没有关联记账(M4 任务 6a)。
    ///
    /// 这一档存在的理由:页面叫「我的技能」,用户的直觉是"我拥有的技能",而不是
    /// "我从别处拿来的技能"。新建的技能不进 `state.installed`(会让
    /// `acquire::precheck` 撒谎),但那**不等于**它不该出现在这一页——
    /// `unclaimed` 那一档就是现成的先例,它同样不在 `state.installed` 里。
    ///
    /// 它能做的事诚实地少:看详情 / 在访达中打开 / 去分享。
    /// **更新、修复关联、分享改动、移除都必须抑制**——它没有来源、没建过关联。
    pub local_only: bool,
    /// 这条记账是认领来的,因而可以**取消认领**(只删记账,磁盘一个字节不动)。
    pub claimed: bool,
    /// 各关联目录的健康态(universal agent 不建链,不在此列)。
    pub links: Vec<installer::LinkHealthReport>,
}

/// 一个已装技能的来源还通不通(M4 任务 2)。返回 `(source_removed, library_removed)`。
///
/// 两者都为 true 是**不允许**的组合:源都没了就只说"来源已移除",再补一句
/// "技能库不在列表里"是废话。`library_removed` 专指"源好好的,但这个技能库不在它的
/// 列表里"——M3 的 `bind_source` 只比同源不校验库,存量条目会走到这一档,
/// 说成"来源已移除"是假话。
///
/// 把「内建源 + 自定义源」摊给 core 做来源绑定(M6 任务 4)。
///
/// **内建源必须显式带上**:它锁定且不落 `config.registries`(坐标是编译期常量),
/// 只传 `config.registries` 的话公司库来的技能永远绑不上——那正是"纳入管理没意义"
/// 的根因,M3 起就存在。
fn binding_sources<'a>(
    builtin: &'a registry::BuiltinSource,
    config: &'a state::Config,
) -> acquire::BindingSources<'a> {
    acquire::BindingSources {
        builtin_base_url: builtin.base_url,
        builtin_repo: builtin.repo,
        builtin_extra: &config.builtin_extra_repos,
        custom: &config.registries,
        plaza_repos: &config.plaza_repos,
    }
}

/// 提成纯函数是为了可测:`installed_list` 要 app_store,测不了
/// ——只测两个 helper 而不测这里的组合方式,注入把两者对调也照样绿(实撞过)。
///
/// **广场(`PLAZA_REGISTRY_ID`)必须走独立分支**(M9 任务 2):下面的通用算法用
/// `resolve(id, key=None)` 探测"这个源本身还在不在",这对内建/自定义源成立
/// (它们都有主仓),但广场**没有主仓概念**——`resolve(plaza, None)` 按设计永远
/// `Err(REPO_UNKNOWN)`(见 `registry::resolve`)。不加这个分支的话,任何广场来源的
/// 已装技能都会被判成"来源已移除",即便广场好好的、这个库也明明在 `plaza_repos` 里
/// ——这正是本任务动机段点名的那类"编译通过、逻辑正确,只是没人验证过实际语义"的缺陷。
fn source_state(
    builtin: &registry::BuiltinSource,
    config: &state::Config,
    source: &state::SkillSource,
) -> (bool, bool) {
    let resolve_with = |key: Option<&str>| {
        registry::resolve(
            builtin,
            &config.registries,
            &config.builtin_extra_repos,
            &source.registry_id,
            key,
            &config.plaza_repos,
        )
        .is_ok()
    };
    if source.registry_id == registry::PLAZA_REGISTRY_ID {
        // 广场是锁定源,像内建源一样"永远在"——不存在"来源已移除"这一档,
        // 只看这个具体的库是否还在 plaza_repos 里。
        let key = registry::repo_key(&source.owner, &source.repo);
        return (false, !resolve_with(Some(&key)));
    }
    if !resolve_with(None) {
        return (true, false);
    }
    let key = registry::repo_key(&source.owner, &source.repo);
    (false, !resolve_with(Some(&key)))
}

#[tauri::command]
pub async fn installed_list() -> Result<Vec<InstalledSkillView>, AppError> {
    // local_modified 要对每个技能逐文件读盘算 hash,技能一多就是一次不小的 IO。
    // 同步 command 会在主线程上算,窗口会卡——挪到阻塞线程池,IPC 立即返还。
    tauri::async_runtime::spawn_blocking(|| {
        let store = app_store()?;
        let registry = AgentRegistry::builtin();
        let installer = Installer::new(&registry, &SystemEnv);
        let state = store.load_state()?.value;
        let config = store.load_config()?.value;
        let builtin_src = registry::BuiltinSource::from_build();

        let mut views: Vec<InstalledSkillView> = state
            .installed
            .iter()
            .filter_map(|s| {
                let canonical = match installer.canonical_dir(&s.name) {
                    Ok(c) => c,
                    Err(e) => return Some(Err(e)),
                };
                // 存在性以文件系统为准(M5 任务 2,用户拍板):目录被删就不占行。
                // 记账**保留**——重新获取同名技能时 precheck 按 Fresh 走正常安装,
                // 记账随之对齐(tests/acquire_flow.rs 有测试钉住),孤账无害。
                if !canonical.is_dir() {
                    return None;
                }
                // 认不出 mode 的记账进不了健康检查——那是移除时才需要面对的问题
                let (recorded, _) = remove::state_links_to_recorded(&s.links);
                Some(Ok(InstalledSkillView {
                    dir_slug: s.name.clone(),
                    commit_sha: s.commit_sha.clone(),
                    content_hash: s.content_hash.clone(),
                    agents: s.agents.clone(),
                    installed_at: s.installed_at.clone(),
                    updated_at: s.updated_at.clone(),
                    local_modified: remove::is_locally_modified(&canonical, &s.content_hash),
                    source_owner: s.source.owner.clone(),
                    source_repo: s.source.repo.clone(),
                    registry_id: s.source.registry_id.clone(),
                    // 源没了 与 库不在源的列表里 是**两句不同的话**(M4 任务 2)
                    source_removed: source_state(&builtin_src, &config, &s.source).0,
                    library_removed: source_state(&builtin_src, &config, &s.source).1,
                    unclaimed: false,
                    claim_bindable: false,
                    local_only: false,
                    claimed: acquire::is_claimed(s),
                    links: match installer.link_health(&s.name, &recorded) {
                        Ok(l) => l,
                        Err(e) => return Some(Err(e)),
                    },
                }))
            })
            .collect::<Result<_, AppError>>()?;

        // 其他工具装的、尚未纳入管理的挂在列表尾部:其余字段按"未知"如实留空。
        // `claim_bindable` 决定界面摆「纳入管理」还是「分享到技能库」(M6 任务 4)。
        for u in
            acquire::unclaimed_skills(&SystemEnv, &installer, &state, &binding_sources(&builtin_src, &config))
        {
            let (owner, repo) = u
                .source
                .split_once('/')
                .map(|(o, r)| (o.to_string(), r.to_string()))
                .unwrap_or((u.source.clone(), String::new()));
            views.push(InstalledSkillView {
                dir_slug: u.dir_slug,
                commit_sha: String::new(),
                // 未认领的没有本 app 的记账基线;认领时才建立(见 acquire::claim)
                content_hash: String::new(),
                agents: Vec::new(),
                installed_at: String::new(),
                updated_at: String::new(),
                local_modified: false,
                source_owner: owner,
                source_repo: repo,
                registry_id: String::new(),
                source_removed: false,
                library_removed: false,
                unclaimed: true,
                claim_bindable: matches!(u.binding, acquire::SourceBinding::Bound { .. }),
                local_only: false,
                claimed: false,
                links: Vec::new(),
            });
        }

        // 第三档:本地技能(自己新建的 / 手放进 canonical 的)。
        //
        // 发现逻辑**复用 share::scan_candidates**,不另写一套扫描——两份实现迟早漂移,
        // 那正是本项目记录的空转测试模式 #1。只取 canonical 里的:agent 目录下的
        // 实体目录归分享页收编,在「我的技能」里摆出来会让用户以为它已经归本 app 管。
        for c in share::scan_candidates(&registry, &SystemEnv, &state)?
            .into_iter()
            .filter(|c| c.in_canonical && c.origin == share::CandidateOrigin::Local)
        {
            views.push(InstalledSkillView {
                dir_slug: c.dir_name,
                // 没有来源就一个字段都不编:空串在前端一律走"这一档不显示"的分支
                commit_sha: String::new(),
                content_hash: String::new(),
                agents: Vec::new(),
                installed_at: String::new(),
                updated_at: String::new(),
                local_modified: false,
                source_owner: String::new(),
                source_repo: String::new(),
                registry_id: String::new(),
                source_removed: false,
                library_removed: false,
                unclaimed: false,
                claim_bindable: false,
                local_only: true,
                claimed: false,
                links: Vec::new(),
            });
        }
        Ok(views)
    })
    .await
    .map_err(|e| {
        AppError::new("FS_TASK", "读取已安装列表失败,请重试").with_detail(e.to_string())
    })?
}

/// 本地技能定位:已装技能给 `dirSlug`(core 自己解析 canonical 目录,前端不传路径);
/// 分享页候选给 `path`(它本来就是 core 扫描回传的绝对路径)。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillArgs {
    #[serde(default)]
    pub dir_slug: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

fn resolve_local_skill_dir(args: &LocalSkillArgs) -> Result<std::path::PathBuf, AppError> {
    if let Some(slug) = args.dir_slug.as_deref() {
        let registry = AgentRegistry::builtin();
        let installer = Installer::new(&registry, &SystemEnv);
        return installer.canonical_dir(slug);
    }
    if let Some(path) = args.path.as_deref() {
        return Ok(std::path::PathBuf::from(path));
    }
    Err(AppError::new("FS_NOT_A_SKILL", "没有指定要查看的技能"))
}

#[tauri::command]
pub async fn skill_local_detail(
    args: LocalSkillArgs,
) -> Result<local_detail::LocalSkillDetail, AppError> {
    // 与 installed_list 同理:逐文件读盘,挪到阻塞线程池
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolve_local_skill_dir(&args)?;
        local_detail::local_skill_detail(&dir)
    })
    .await
    .map_err(|e| AppError::new("FS_TASK", "读取技能内容失败,请重试").with_detail(e.to_string()))?
}

/// 在访达/资源管理器中显示技能目录。
/// 守卫与 `open_library_url` 同一种谨慎:这是 webview 通往系统的通道,
/// 只对"确实是技能目录"的路径放行(存在 + 含 SKILL.md)。
#[tauri::command]
pub fn skill_reveal(args: LocalSkillArgs) -> Result<(), AppError> {
    let dir = resolve_local_skill_dir(&args)?;
    local_detail::ensure_skill_dir(&dir)?;
    tauri_plugin_opener::reveal_item_in_dir(&dir).map_err(|e| {
        AppError::new("FS_REVEAL_FAILED", "没能在文件管理器中显示这个技能").with_detail(e.to_string())
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallBatchArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    /// 仓库寻址键 `owner/repo`,缺省 = 该源主仓(向导的 curated 清单只在主仓)。
    #[serde(default)]
    pub repo: Option<String>,
    pub dir_slugs: Vec<String>,
    #[serde(default)]
    pub agent_ids: Vec<String>,
}

/// 首次启动向导的"一键全装":一次下载装多个,冲突一律跳过并说明。
#[tauri::command]
pub async fn skill_install_batch(
    args: InstallBatchArgs,
) -> Result<Vec<acquire::BatchItem>, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (client, repo) = read_source(registry_id, args.repo.as_deref()).await?;
    let (kind, base_url) = source_meta_parts(registry_id, args.repo.as_deref())?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    acquire::acquire_batch(
        &client,
        &registry,
        &SystemEnv,
        &store,
        acquire::SourceMeta { registry_id, kind, base_url: &base_url },
        &repo,
        &args.dir_slugs,
        acquire::BatchAgents::Uniform(&args.agent_ids),
        &now_iso8601(),
        auth::now_unix(),
    )
    .await
}

// ============================================================ 新建技能

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateArgs {
    /// 文件夹名。ASCII kebab,强制,core 侧按 `sanitize_name` 的不动点判定。
    pub dir_slug: String,
    /// 显示名,可中文。
    pub display_name: String,
    pub description: String,
}

/// 新建一个空技能到 canonical 目录(等价上游 `skills init`)。
///
/// 只创建文件,不建链、不进账——理由见 `core::create` 模块头。
#[tauri::command]
pub async fn skill_create(args: SkillCreateArgs) -> Result<create::CreateReport, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app_store()?;
        let registry = AgentRegistry::builtin();
        let installer = Installer::new(&registry, &SystemEnv);
        create::create_skill(
            &installer,
            &store,
            &create::CreateRequest {
                dir_slug: &args.dir_slug,
                display_name: &args.display_name,
                description: &args.description,
            },
        )
    })
    .await
    .map_err(|e| AppError::new("FS_TASK", "新建技能失败,请重试").with_detail(e.to_string()))?
}

// ============================================================ 分享

#[tauri::command]
pub async fn share_candidates() -> Result<Vec<share::ShareCandidate>, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let store = app_store()?;
        let registry = AgentRegistry::builtin();
        let state = store.load_state()?.value;
        share::scan_candidates(&registry, &SystemEnv, &state)
    })
    .await
    .map_err(|e| AppError::new("FS_TASK", "扫描本地技能失败,请重试").with_detail(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillShareArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    /// 分享目标仓的寻址键 `owner/repo`,缺省 = 该源主仓。
    /// 目标仓选择器进分享表单归 M4 任务 2,通道先打通。
    #[serde(default)]
    pub repo: Option<String>,
    /// 候选的本地绝对路径(share_candidates 返回的 `path`,原样带回)。
    pub source_path: String,
    /// 远端目录名(ASCII kebab,表单定)。
    pub share_name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// `local` | `npx-skills`。
    pub origin: String,
    /// 同名冲突时用户确认覆盖。
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub async fn skill_share(args: SkillShareArgs) -> Result<share::ShareOutcome, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (source, repo) = share_source(registry_id, args.repo.as_deref()).await?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    share::share(
        &source.as_share_client(),
        &registry,
        &SystemEnv,
        &store,
        share::ShareRequest {
            registry_id,
            repo: &repo,
            source_path: std::path::Path::new(&args.source_path),
            share_name: &args.share_name,
            display_name: args.display_name.as_deref(),
            description: args.description.as_deref(),
            origin: &args.origin,
            overwrite: args.overwrite,
        },
        &now_iso8601(),
    )
    .await
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreviewArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    /// 目标库的寻址键 `owner/repo`,缺省 = 该源主库。
    #[serde(default)]
    pub repo: Option<String>,
}

/// 分享前的路径预告(M4 任务 2)。**永不失败**:探不到就是 `unknown`,界面不显示预告,
/// 分享流程一步不受影响。
///
/// 走的是**带凭证**的 `share_source`,不是读链路的 `read_source`——后者对内建源
/// 硬编码匿名,而匿名与只读用户的 permissions 完全相同(录制结论 5),
/// 用它探出来的永远是"无权限"。未登录时同样返回 `unknown`(分享本来就要求先登录)。
#[tauri::command]
pub async fn share_preview(args: SharePreviewArgs) -> Result<share::SharePath, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    match share_source(registry_id, args.repo.as_deref()).await {
        Ok((source, repo)) => Ok(share::preview_permission(&source.as_share_client(), &repo).await),
        // 未登录 / 源解析不出来:不预告,也不报错——它只是个提示
        Err(err) => {
            tracing::debug!(registry_id, code = %err.code, "分享路径预告未取到");
            Ok(share::SharePath::Unknown)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareChangesArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    pub dir_slug: String,
    /// 冲突档确认后的第二跳:跳过远端变更检测,强制走「开分支 + 提交审核」。
    #[serde(default)]
    pub force_review: bool,
}

/// 回推目标仓的寻址键,取**账上**的来源坐标(M4 任务 1)。
///
/// `share_installed` 的仓库 owner/repo 本来就取账上,但 **branch 由调用方给**
/// ——按主仓给会把追加仓技能的改动推到主仓的默认分支上去。
/// 账上找不到时返回 `None`(缺省落主仓),让 `share_installed` 给出既有的
/// `FS_NOT_INSTALLED`,而不是在这层多造一条错误码。
fn installed_repo_key(state: &state::State, dir_slug: &str) -> Option<String> {
    state
        .installed
        .iter()
        .find(|s| s.name == dir_slug)
        .map(|s| registry::repo_key(&s.source.owner, &s.source.repo))
}

/// 把本 app 安装、用户改过的技能推回来源仓库(冲突弹窗承诺的那条路)。
///
/// 远端变更检测走**读链路**(内建源匿名),提交走**写链路**(实名)——
/// 两个 client 的凭证策略不同,不能顺手复用一个。
#[tauri::command]
pub async fn skill_share_changes(
    args: ShareChangesArgs,
) -> Result<share::ShareInstalledOutcome, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let repo_key = installed_repo_key(&app_store()?.load_state()?.value, &args.dir_slug);
    let (source, repo) = share_source(registry_id, repo_key.as_deref()).await?;
    let (read, _) = read_source(registry_id, repo_key.as_deref()).await?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();
    share::share_installed(
        &source.as_share_client(),
        &read,
        &registry,
        &SystemEnv,
        &store,
        &args.dir_slug,
        &repo.branch,
        args.force_review,
        &now_iso8601(),
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRepairArgs {
    pub dir_slug: String,
    /// 前端确认弹窗的结果:占位的实体目录会被替换,原内容无法找回。
    #[serde(default)]
    pub replace_occupied: bool,
}

#[tauri::command]
pub async fn skill_repair(args: SkillRepairArgs) -> Result<InstallReport, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app_store()?;
        let registry = AgentRegistry::builtin();
        let installer = Installer::new(&registry, &SystemEnv);
        acquire::repair_links(&installer, &store, &args.dir_slug, args.replace_occupied)
    })
    .await
    .map_err(|e| AppError::new("FS_TASK", "修复操作未能完成,请重试").with_detail(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLinkAgentsArgs {
    pub dir_slug: String,
    /// 要补关联的工具(通常是安装结果面板里失败的那一条)。
    pub agent_ids: Vec<String>,
    /// 前端确认弹窗的结果:占位的实体目录会被替换,原内容无法找回。
    #[serde(default)]
    pub replace_occupied: bool,
}

/// 安装结果面板里逐条重试:把技能补关联到当时没建成的那个工具上。
#[tauri::command]
pub async fn skill_link_agents(args: SkillLinkAgentsArgs) -> Result<InstallReport, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app_store()?;
        let registry = AgentRegistry::builtin();
        let installer = Installer::new(&registry, &SystemEnv);
        acquire::link_agents(
            &installer,
            &store,
            &args.dir_slug,
            &args.agent_ids,
            args.replace_occupied,
        )
    })
    .await
    .map_err(|e| AppError::new("FS_TASK", "重试未能完成,请重试").with_detail(e.to_string()))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillClaimArgs {
    pub dir_slug: String,
}

/// 认领上游(npx skills)装的技能(M3 任务 6):补 state 记账并收编既有链接,
/// 此后更新/修复/移除走本 app 既有流程。lock 一个字节不动。
#[tauri::command]
pub async fn skill_claim(args: SkillClaimArgs) -> Result<acquire::ClaimReport, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app_store()?;
        let registry = AgentRegistry::builtin();
        let installer = Installer::new(&registry, &SystemEnv);
        let config = store.load_config()?.value;
        acquire::claim(
            &installer,
            &registry,
            &SystemEnv,
            &store,
            &binding_sources(&registry::BuiltinSource::from_build(), &config),
            &args.dir_slug,
            &now_iso8601(),
        )
    })
    .await
    .map_err(|e| AppError::new("FS_TASK", "认领操作未能完成,请重试").with_detail(e.to_string()))?
}

/// 取消认领:[`skill_claim`] 的精确逆操作,只删记账不动磁盘。
///
/// 与「移除」的区别是整条命令存在的理由——移除会解链、删本体、清 lock 条目;
/// 这个一个字节都不动(见 `acquire::unclaim` 的文档)。
#[tauri::command]
pub async fn skill_unclaim(args: SkillClaimArgs) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app_store()?;
        acquire::unclaim(&store, &args.dir_slug)
    })
    .await
    .map_err(|e| {
        AppError::new("FS_TASK", "取消认领未能完成,请重试").with_detail(e.to_string())
    })?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRemoveArgs {
    pub dir_slug: String,
    /// 前端确认弹窗的结果:用户已确认"连本地改动一起删"。
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub async fn skill_remove(args: SkillRemoveArgs) -> Result<remove::RemoveOutcome, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app_store()?;
        let registry = AgentRegistry::builtin();
        let installer = Installer::new(&registry, &SystemEnv);
        remove::remove(&installer, &SystemEnv, &store, &args.dir_slug, args.force)
    })
    .await
    .map_err(|e| AppError::new("FS_TASK", "移除操作未能完成,请重试").with_detail(e.to_string()))?
}

/// 技能广场搜索(M9 任务 1):接入 skills.sh,只做发现。
///
/// 薄壳:client 用 [`crate::core::gitea::app_http_client_proxied`]——skills.sh 是
/// 外部服务,必须跟随系统代理(M3 决策),不能用内建源那支直连 client。
#[tauri::command]
pub async fn plaza_search(query: String) -> Result<Vec<plaza::PlazaSkillCard>, AppError> {
    let http = crate::core::gitea::app_http_client_proxied()?;
    plaza::search(&http, plaza::PLAZA_API_BASE, &query).await
}

/// 广场热门排行榜的进程内缓存(M10 任务 4):同一个道理与 `plaza_detail_cache`
/// 一致——首页 950KB/1.8s,同一进程内多次打开广场空态不该每次都重下;**刻意不记
/// 任何失效时机**(没有现成路径能给它喂"更该刷新了"的信号,理由与
/// `plaza_detail_cache` 文档完全同款,不重复分析一遍)。
///
/// **只缓存非空结果**:`plaza::fetch_leaderboard` 本身已经把失败降级成空列表
/// (见该函数文档),如果空列表也被缓存下来,一次网络抖动就会把"排行榜空态"钉死
/// 一整个进程生命周期——而非空结果没有这个顾虑(缓存的就是"曾经成功过一次"这件事,
/// 不需要过期)。空结果因此每次调用都会重新尝试,给瞬时故障一个自愈的机会。
type PlazaLeaderboardCache = Mutex<Option<Vec<plaza::PlazaSkillCard>>>;

fn plaza_leaderboard_cache() -> &'static PlazaLeaderboardCache {
    static CACHE: OnceLock<PlazaLeaderboardCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// 缓存优先地取热门排行榜:命中直接返回;否则调用 `plaza::fetch_leaderboard` 现拉
/// 一次,非空结果才写回缓存(空结果不缓存的理由见 [`PlazaLeaderboardCache`] 上方文档)。
///
/// 单独抽出来(而不是内联进 `plaza_leaderboard`)是为了让缓存命中/不缓存空结果这两条
/// 规则脱离进程级单例直接单测——与 `cached_plaza_detail` 同一个理由、同一个模式。
async fn cached_plaza_leaderboard(
    cache: &PlazaLeaderboardCache,
    http: &reqwest::Client,
    home_url: &str,
) -> Vec<plaza::PlazaSkillCard> {
    if let Some(cached) = cache.lock().expect("广场排行榜缓存锁不该中毒").clone() {
        return cached;
    }
    let cards = plaza::fetch_leaderboard(http, home_url).await;
    if !cards.is_empty() {
        *cache.lock().expect("广场排行榜缓存锁不该中毒") = Some(cards.clone());
    }
    cards
}

/// 技能广场热门排行榜(M10 任务 4):空态打开就有内容,不再是一行灰字。
///
/// **这个命令永不报错**——`plaza::fetch_leaderboard` 已把网络失败/解析失败统一
/// 降级成空列表(见该函数文档),前端拿到空列表就退回原来的"输入关键词搜索"提示,
/// 不会看到一个突兀的错误弹窗(brief 明确要求:上游改渲染时应当降级成空态提示,
/// 不是错误)。
#[tauri::command]
pub async fn plaza_leaderboard() -> Result<Vec<plaza::PlazaSkillCard>, AppError> {
    let http = crate::core::gitea::app_http_client_proxied()?;
    Ok(cached_plaza_leaderboard(plaza_leaderboard_cache(), &http, plaza::PLAZA_HOME_URL).await)
}

/// 校验广场坐标的形状:必须是恰好一层 `owner/repo`,两段都不能空。
/// 拒绝多段路径(`a/b/c`)——广场只给单层坐标,多一段大概率是把 skills.sh 的
/// `id`(`owner/repo/skill-name`)错传成了 `owner_repo`。
fn parse_owner_repo(owner_repo: &str) -> Result<(&str, &str), AppError> {
    match owner_repo.split_once('/') {
        Some((owner, repo)) if !owner.is_empty() && !repo.is_empty() && !repo.contains('/') => {
            Ok((owner, repo))
        }
        _ => Err(AppError::new(
            "REPO_INVALID_REGISTRY",
            "技能坐标格式不对,应为「拥有者/技能库名」这样的两段式",
        )
        .with_detail(owner_repo.to_string())),
    }
}

/// 幂等挂仓(M9 任务 3):把广场搜索结果的 `owner/repo` 坐标写进
/// `config.plazaRepos`,之后获取/更新走既有获取 IPC(`registryId: "plaza"`)与
/// `acquire` 全链路——本命令只管把坐标挂上,`acquire` 侧零逻辑改动。
///
/// 幂等判定与追加动作都在 `registry::find_plaza_repo`/`record_plaza_repo`(纯逻辑,
/// 已单测);这里只做参数转换、按需发一次 HTTP 探测、原子写回 config,是"薄壳"。
///
/// **绝不经 `registry::add_repo`**:那条入口对 `PLAZA_REGISTRY_ID` 报
/// `REPO_BUILTIN_LOCKED`(M9 任务 2 刻意加的守卫——广场坐标只能由"装了一个搜索结果"
/// 这件事产生,不许手填 owner/repo)。本命令直接操作 `config.plaza_repos`,
/// 是唯一被允许绕过该守卫的调用方。
#[tauri::command]
pub async fn plaza_ensure_repo(owner_repo: String) -> Result<registry::RepoView, AppError> {
    let (owner, repo) = parse_owner_repo(&owner_repo)?;

    let store = app_store()?;
    let mut config = store.load_config()?.value;

    if let Some(view) = registry::find_plaza_repo(&config.plaza_repos, owner, repo) {
        return Ok(view);
    }

    // 外部服务,跟随系统代理(M3 决策),与 plaza_search 同一支 client。
    let http = crate::core::gitea::app_http_client_proxied()?;
    let branch = plaza::default_branch(&http, plaza::PLAZA_GITHUB_API_BASE, owner, repo).await?;

    let view = registry::record_plaza_repo(&mut config.plaza_repos, owner, repo, branch);
    store.save_config(&config)?;
    Ok(view)
}

/// 广场详情的进程内缓存(M9 任务 4):键 `owner/repo`,值该仓全部技能的详情。
/// **只活在这一次运行的进程里,不落盘**——避免为从未安装的仓积累孤儿缓存文件
/// (设计文档 §2.2)。`OnceLock` 首次调用才初始化,不存在"0 恰好是有效值"那类
/// 哨兵坑(watcher::now_ms 的教训在这里不适用:这里的"空"就是字面意义的"没有过
/// 任何写入",`HashMap::new()` 本身就是唯一且正确的初值)。
///
/// **刻意不记 head sha,没有任何失效机制**(2026-08-12 终审裁定,设计文档 §2.2
/// 同步更新过——原文一度写"head sha 一起记",已证明是当时假设了一个并不存在的
/// 失效时机)。别顺手"补全"这个字段:排查过 `plaza_ensure_repo`(只给分支名,
/// 没有 sha)、acquire/scheduler(走完全独立的 `store_index` 文件缓存,且只在
/// 挂仓之后才生效)、`retryDetail`(没有强制刷新入口),**没有任何现成路径会给
/// 这份缓存喂入"更新的 sha"**;唯一能让它派上用场的做法是每次命中都主动探一次
/// `branch_head`——但 GitHub 匿名配额只有 60 次/小时,缓存存在的首要意义就是省它,
/// 每次命中都多发一次探测请求是净损失。后果:同一进程内点开过的仓,详情
/// **可能短暂陈旧**,但**安装永远是新的**(走 `acquire` 独立路径,与这份缓存无关,
/// 会重新拉取当前内容)——这个差别是刻意接受的,不是遗漏。
type PlazaDetailCache = Mutex<HashMap<String, Vec<SkillDetail>>>;

fn plaza_detail_cache() -> &'static PlazaDetailCache {
    static CACHE: OnceLock<PlazaDetailCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 缓存优先地取某个广场仓的详情:命中直接返回;否则调用 `plaza::fetch_repo_skills`
/// 现拉一次并记进缓存。**不碰 config、不碰 HOME**——仓库坐标与访问 client 都由调用方
/// 给定,这个函数只管"要不要再发一次请求"。
///
/// 单独抽出来(而不是内联进 `plaza_detail`)是为了让缓存命中这件事本身可以脱离
/// `app_store()`(真实 HOME)直接单测——见下面 `tests` 模块:`cached_plaza_detail_*`
/// 系列用一个统计调用次数的假 `RepoSource` 验证"同 key 二次调用不再发请求"与
/// "不同 key 各自现拉、不会互相顶替"(后者正是"缓存键写错"这类缺陷的靶子)。
async fn cached_plaza_detail(
    cache: &PlazaDetailCache,
    cache_key: &str,
    client: &impl crate::core::gitea::RepoSource,
    repo: &RepoRef,
) -> Result<Vec<SkillDetail>, AppError> {
    if let Some(hit) = cache
        .lock()
        .expect("广场详情缓存锁不该中毒")
        .get(cache_key)
        .cloned()
    {
        return Ok(hit);
    }
    let skills = plaza::fetch_repo_skills(client, repo).await?;
    cache
        .lock()
        .expect("广场详情缓存锁不该中毒")
        .insert(cache_key.to_string(), skills.clone());
    Ok(skills)
}

/// `plaza_detail` 的参数(M10 任务 2 把它从裸字符串升级为结构体)。
///
/// `skill_id`/`wanted_name` 给了才会尝试 blob 快路径:前端在
/// `usePlaza.openDetail(ownerRepo, name, slug)` 调用时点开的那条搜索结果本来就有
/// 这两样(`slug` = `PlazaSkillCard::slug` = skills.sh 的 `id`),原样带过来即可,
/// 不需要现拆。缺任一个都直接走既有 zipball 全仓路径(向后兼容:
/// `tests/plaza_detail.rs` 的既有用例不传这两个字段,行为必须与改动前完全一致)。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlazaDetailArgs {
    pub owner_repo: String,
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub wanted_name: Option<String>,
}

/// blob 快路径(有 `skill_id`+`wanted_name` 才试)命中即返回单项列表;
/// 拿不到 blob 结果的一切情况(缺参数、blob 失败、internal、名字对不上)都静默落到
/// 现拉整仓的 `cached_plaza_detail`——与 `plaza_detail` 改动前**完全同一条路径**,
/// "多技能仓、名字对不上时显示列表"这条 M9 任务 5 的既有行为因此原样保留
/// (见 `core::plaza::fetch_skill_detail_via_blob` 模块文档的判据清单)。
///
/// `blob_api_base` 单独作为参数(生产调用点固定传 [`plaza::PLAZA_API_BASE`]),
/// 不在函数体内写死——这样测试能喂 wiremock 地址,覆盖"blob 命中"与"blob 失败回退"
/// 两条路径,不必真的打 skills.sh(与本文件其余薄壳测试同一套注入风格)。
///
/// `cache` 同样是参数而不是在函数体内直接调 [`plaza_detail_cache`]:那是**进程级**
/// 单例,多个测试用同一个 `cache_key`("vercel-labs/skills"这类字面量在本文件
/// 到处出现)会通过它互相脏读——与 `cached_plaza_detail` 早就是这个注入写法同理
/// (见其函数文档),这里只是保持同一套习惯,不是新规矩。
async fn plaza_detail_for_client(
    client: &impl crate::core::gitea::RepoSource,
    repo_ref: &RepoRef,
    cache: &PlazaDetailCache,
    cache_key: &str,
    blob_api_base: &str,
    skill_id: Option<&str>,
    wanted_name: Option<&str>,
) -> Result<Vec<SkillDetail>, AppError> {
    if let (Some(id), Some(name)) = (skill_id, wanted_name) {
        let http = crate::core::gitea::app_http_client_proxied()?;
        if let Ok(detail) =
            plaza::fetch_skill_detail_via_blob(client, repo_ref, &http, blob_api_base, id, name).await
        {
            return Ok(vec![detail]);
        }
    }
    cached_plaza_detail(cache, cache_key, client, repo_ref).await
}

/// 技能广场详情(M9 任务 4,M10 任务 2 改走 blob):点开搜索结果卡片时现拉该仓内容。
///
/// **这是详情面板"不联网"承诺的唯一破例,范围钉死在广场**:内建源与已有自定义源的
/// `store_skill_detail` 依旧全部来自索引缓存,一行没改;这是新 IPC、新状态槽
/// (`plaza_detail_cache`),只有广场页会调它(设计文档 §2.2)。
///
/// 详情先于安装:仓未挂进 `config.plazaRepos` 时,`read_source` 会报
/// `REPO_UNKNOWN_REPO`(未知仓),此时探测默认分支临时直连,**绝不写 config**
/// ——挂仓只能由「装了一个搜索结果」这件事触发(见 `plaza_ensure_repo`)。这个分支
/// 与 `tests/plaza_detail.rs` 的 `detail_ref_for_unregistered_repo` 逐行同构
/// (那份测试注入的是 `Store`,不依赖真实 `HOME`,断言调用后 `plaza_repos` 仍空)。
///
/// 两个分支各自的 `client` 是不同的具体类型(`SourceClient` 枚举 vs 直接构造的
/// `GithubClient`),`plaza_detail_for_client` 对 `impl RepoSource` 泛型、按调用点
/// 各自单态化,因此这里仍然是两段各自调用而不是先统一成一个变量——与改动前的结构
/// 保持一致,不是遗漏合并。
#[tauri::command]
pub async fn plaza_detail(args: PlazaDetailArgs) -> Result<Vec<SkillDetail>, AppError> {
    let (owner, repo) = parse_owner_repo(&args.owner_repo)?;
    let cache_key = registry::repo_key(owner, repo);
    let skill_id = args.skill_id.as_deref();
    let wanted_name = args.wanted_name.as_deref();

    match read_source(registry::PLAZA_REGISTRY_ID, Some(&cache_key)).await {
        Ok((client, repo_ref)) => {
            plaza_detail_for_client(
                &client,
                &repo_ref,
                plaza_detail_cache(),
                &cache_key,
                plaza::PLAZA_API_BASE,
                skill_id,
                wanted_name,
            )
            .await
        }
        Err(err) if err.code == "REPO_UNKNOWN_REPO" => {
            let http = http_client_for(registry::PLAZA_REGISTRY_ID)?;
            let branch =
                plaza::default_branch(&http, plaza::PLAZA_GITHUB_API_BASE, owner, repo).await?;
            let token = load_github_token(&KeyringStore, registry::PLAZA_REGISTRY_ID);
            let client = github::GithubClient::new(registry::PLAZA_BASE_URL, token, http);
            let repo_ref = RepoRef { owner: owner.to_string(), repo: repo.to_string(), branch };
            plaza_detail_for_client(
                &client,
                &repo_ref,
                plaza_detail_cache(),
                &cache_key,
                plaza::PLAZA_API_BASE,
                skill_id,
                wanted_name,
            )
            .await
        }
        Err(err) => Err(err),
    }
}

fn app_store() -> Result<state::Store, AppError> {
    state::Store::for_env(&SystemEnv)
        .ok_or_else(|| AppError::new("FS_NO_HOME", "找不到用户主目录,无法保存本地数据"))
}

/// ISO-8601(UTC,毫秒),与 `.skill-lock.json` 里上游写的格式一致。
///
/// 不引 chrono:只为一个时间戳多一个依赖不划算,而这个格式是固定的。
fn now_iso8601() -> String {
    let secs = auth::now_unix().max(0) as u64;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

/// unix 天数 → 公历年月日(Howard Hinnant 的 civil_from_days)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_matches_the_lock_files_format() {
        assert_eq!(civil_from_days(20_664), (2026, 7, 30));
        // 闰年 2 月末与年初年末各查一处,这类手写历法最容易在边界上错
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(59), (1970, 3, 1));
        assert_eq!(civil_from_days(19_051), (2022, 2, 28));
        assert_eq!(civil_from_days(18_686), (2021, 2, 28));
        assert_eq!(civil_from_days(18_321), (2020, 2, 29));
    }

    #[test]
    fn iso8601_shape_is_what_the_external_contract_expects() {
        let now = now_iso8601();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with(".000Z"), "{now}");
        assert_eq!(now.as_bytes()[10], b'T', "{now}");
    }

    // store_target 的两条测试(不依赖 OAuth 配置 / 未配置的人话报错)随解析层
    // 一起迁去了 core/registry.rs——resolve 就是它的继任者,守的是同一件事。

    #[test]
    fn local_skill_args_need_a_target() {
        let err = resolve_local_skill_dir(&LocalSkillArgs { dir_slug: None, path: None })
            .unwrap_err();
        assert_eq!(err.code, "FS_NOT_A_SKILL");
    }

    #[test]
    fn local_skill_args_pass_path_through() {
        let dir = resolve_local_skill_dir(&LocalSkillArgs {
            dir_slug: None,
            path: Some("/tmp/some-skill".into()),
        })
        .unwrap();
        assert_eq!(dir, std::path::PathBuf::from("/tmp/some-skill"));
    }

    #[test]
    fn a_library_missing_from_a_live_source_is_not_the_same_as_a_removed_source() {
        // M3 的 bind_source 只比同源不校验库,认领时可能把 host/someone/other-repo
        // 的技能绑到该 host 的源上(存量条目);或用户后来把库从源里移除了。
        // 两种情况下更新与回推都没了去处,但**说法不同**:源好好的,
        // 说成"来源已移除"是假话。
        let builtin = registry::BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "main",
        };
        let config = state::Config::default();
        let src = |registry_id: &str, owner: &str, repo: &str| state::SkillSource {
            registry_id: registry_id.into(),
            owner: owner.into(),
            repo: repo.into(),
            path: "skills/x".into(),
            git_ref: "aaa1111".into(),
        };

        // 主库:两个标记都不亮
        assert_eq!(
            source_state(&builtin, &config, &src("company", "skills", "skills")),
            (false, false)
        );
        // 源在,但这个库不在它的列表里 —— 只有 library_removed 该亮
        assert_eq!(
            source_state(&builtin, &config, &src("company", "someone", "other-repo")),
            (false, true),
            "源好好的,说成「来源已移除」是假话"
        );
        // 源本身不在:只说"来源已移除",不再补一句库不在列表里(那是废话)
        assert_eq!(
            source_state(&builtin, &config, &src("custom-99", "a", "b")),
            (true, false)
        );
    }

    /// 广场(M9 任务 2)必须走独立分支:通用算法用 `resolve(id, key=None)` 探测
    /// "源本身还在不在",这对内建/自定义源成立(它们都有主仓),但广场**没有主仓**,
    /// `resolve(plaza, None)` 按设计永远出错。不特殊处理的话,任何广场来源的已装技能
    /// 都会被判成"来源已移除",即便广场好好的、库也明明在 `plaza_repos` 里。
    #[test]
    fn plaza_sourced_skills_are_never_reported_as_source_removed() {
        let builtin = registry::BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "main",
        };
        let mut config = state::Config::default();
        config.plaza_repos.push(state::RepoConfig {
            owner: "vercel-labs".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        });
        let src = |owner: &str, repo: &str| state::SkillSource {
            registry_id: "plaza".into(),
            owner: owner.into(),
            repo: repo.into(),
            path: "skills/x".into(),
            git_ref: "aaa1111".into(),
        };

        // 库在 plaza_repos 里:两个标记都不亮
        assert_eq!(
            source_state(&builtin, &config, &src("vercel-labs", "skills")),
            (false, false)
        );
        // 库不在 plaza_repos 里:只有 library_removed 亮,绝不是 source_removed
        // ——广场这个"源"本身从未移除过。
        assert_eq!(
            source_state(&builtin, &config, &src("someone", "other-skills")),
            (false, true),
            "广场是锁定源,永远不该被判成「来源已移除」"
        );
    }

    #[test]
    fn scheduled_check_visits_every_library_not_just_the_primary_one() {
        // 只查主库会让追加库里装的技能永远等不到更新,而界面上看不出任何异常。
        let builtin = registry::BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "main",
        };
        let extras = vec![state::RepoConfig {
            owner: "design".into(),
            repo: "design-skills".into(),
            branch: "main".into(),
            name: None,
        }];
        let custom = state::RegistryConfig {
            id: "custom-1".into(),
            name: "部门工具库".into(),
            kind: "gitea".into(),
            base_url: "http://tools.example:8080".into(),
            builtin: false,
            repos: vec![
                state::RepoConfig {
                    owner: "ai-skills".into(),
                    repo: "dept-skills".into(),
                    branch: "release".into(),
                    name: None,
                },
                state::RepoConfig {
                    owner: "ai-skills".into(),
                    repo: "qa-skills".into(),
                    branch: "main".into(),
                    name: None,
                },
            ],
        };

        let targets = check_targets(&builtin, &[custom], &extras, &[]);
        let keys: Vec<(String, String)> = targets
            .into_iter()
            .map(|(id, k)| (id, k.unwrap_or_default()))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("company".to_string(), "skills/skills".to_string()),
                ("company".to_string(), "design/design-skills".to_string()),
                ("custom-1".to_string(), "ai-skills/dept-skills".to_string()),
                ("custom-1".to_string(), "ai-skills/qa-skills".to_string()),
            ]
        );

        // 内建未注入配置的开发构建:那个源一个目标都不产出,自定义源照常
        let unconfigured = registry::BuiltinSource { base_url: None, repo: None, branch: "main" };
        let targets = check_targets(&unconfigured, &[], &extras, &[]);
        assert!(targets.is_empty(), "没有主库时追加库也无从查起: {targets:?}");
    }

    /// 广场(M9 任务 2)必须走同一条枚举路径:`plaza_repos` 非空时,
    /// 定时检查的目标清单里必须含广场——它没有主仓,不会被"只查主库"那类
    /// 老逻辑意外覆盖到,必须显式验证。**这条测试是本任务里被点名的注入验证重点**:
    /// 删掉 `check_targets`/`registry::list` 里的广场行,这条测试必须变红。
    #[test]
    fn scheduled_check_visits_the_plaza_source_when_it_has_repos() {
        let builtin = registry::BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "main",
        };
        let plaza_repos = vec![state::RepoConfig {
            owner: "vercel-labs".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        }];

        let targets = check_targets(&builtin, &[], &[], &plaza_repos);
        let keys: Vec<(String, String)> = targets
            .into_iter()
            .map(|(id, k)| (id, k.unwrap_or_default()))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("company".to_string(), "skills/skills".to_string()),
                ("plaza".to_string(), "vercel-labs/skills".to_string()),
            ],
            "plaza_repos 非空时,目标清单必须含广场"
        );

        // 对照组:plaza_repos 为空时,广场这一行仍在(list() 的既有契约),
        // 但它没有仓,自然产不出任何目标——不是"广场消失了",是"广场没有仓可查"。
        let targets = check_targets(&builtin, &[], &[], &[]);
        assert!(
            targets.iter().all(|(id, _)| id != "plaza"),
            "空 plaza_repos 不该产出任何广场目标: {targets:?}"
        );
    }

    #[test]
    fn share_changes_targets_the_repo_on_record_not_the_primary() {
        let installed = |name: &str, owner: &str, repo: &str| state::InstalledSkill {
            name: name.into(),
            source: state::SkillSource {
                registry_id: "company".into(),
                owner: owner.into(),
                repo: repo.into(),
                path: format!("skills/{name}"),
                git_ref: "aaa1111".into(),
            },
            commit_sha: "aaa1111".into(),
            content_hash: "sha256:x".into(),
            origin: None,
            agents: vec![],
            links: vec![],
            installed_at: "2026-08-04T00:00:00.000Z".into(),
            updated_at: "2026-08-04T00:00:00.000Z".into(),
        };
        let st = state::State {
            installed: vec![
                installed("weekly-report", "skills", "skills"),
                installed("design-tokens", "design", "design-skills"),
            ],
            ..Default::default()
        };
        // 追加库装的技能必须回推到追加库,不是主库
        assert_eq!(
            installed_repo_key(&st, "design-tokens").as_deref(),
            Some("design/design-skills")
        );
        assert_eq!(
            installed_repo_key(&st, "weekly-report").as_deref(),
            Some("skills/skills")
        );
        // 账上没有:留给 share_installed 报 FS_NOT_INSTALLED,不在这层另造错误
        assert_eq!(installed_repo_key(&st, "never-installed"), None);
    }

    // ============================================================ 广场挂仓(M9 任务 3)

    #[test]
    fn parse_owner_repo_accepts_a_single_level_pair() {
        assert_eq!(parse_owner_repo("vercel-labs/skills").unwrap(), ("vercel-labs", "skills"));
    }

    #[test]
    fn parse_owner_repo_rejects_missing_slash_or_empty_segments() {
        for bad in ["no-slash", "/repo", "owner/", "/", ""] {
            let err = parse_owner_repo(bad).unwrap_err();
            assert_eq!(err.code, "REPO_INVALID_REGISTRY", "input={bad:?}");
        }
    }

    /// 广场只给单层坐标;三段路径(比如误传了 skills.sh 的 `id`
    /// `owner/repo/skill-name`)必须被拒,不能悄悄把中间段当成 repo 名。
    #[test]
    fn parse_owner_repo_rejects_more_than_one_slash() {
        let err = parse_owner_repo("owner/repo/skill-name").unwrap_err();
        assert_eq!(err.code, "REPO_INVALID_REGISTRY");
    }

    // ============================================================ GitHub 令牌加载(M9 任务 4 fix)
    //
    // `load_github_token` 抽出前,`read_source` 的 Github 臂与 `plaza_detail` 的未挂仓臂
    // 各自内联一份逐行同构的凭证加载逻辑,且**零测试覆盖**(审查发现)。这里补上:
    // 有凭证 → 返回 token;读取失败(钥匙串故障等)→ 返回 None 且不 panic。

    /// 总是返回 `Err` 的假凭证存储,模拟钥匙串读取失败(权限问题/无桌面会话等)
    /// ——`auth::MemoryStore` 只会话到 `Ok`,盖不到这条分支。
    struct FailingStore;

    impl CredentialStore for FailingStore {
        fn save(&self, _account: &str, _creds: &auth::Credentials) -> Result<(), AppError> {
            unreachable!("load_github_token 不调 save")
        }
        fn load(&self, _account: &str) -> Result<Option<auth::Credentials>, AppError> {
            Err(AppError::new("AUTH_KEYRING", "读取凭证失败"))
        }
        fn delete(&self, _account: &str) -> Result<(), AppError> {
            unreachable!("load_github_token 不调 delete")
        }
    }

    #[test]
    fn load_github_token_returns_the_token_when_the_store_has_credentials() {
        let store = auth::MemoryStore::default();
        store
            .save(
                "plaza",
                &auth::Credentials {
                    access_token: "gh-token-abc".into(),
                    refresh_token: String::new(),
                    expires_at: 0,
                },
            )
            .unwrap();

        assert_eq!(load_github_token(&store, "plaza"), Some("gh-token-abc".to_string()));
    }

    #[test]
    fn load_github_token_falls_back_to_anonymous_when_the_store_has_nothing() {
        let store = auth::MemoryStore::default();
        assert_eq!(load_github_token(&store, "plaza"), None);
    }

    /// 注入验证的另一面:钥匙串本身故障(不是"没登录",是"读不出来")不该让调用方
    /// panic 或把错误一路抛出去拦住浏览——必须静默降级匿名,与自定义 Gitea 源同语义。
    #[test]
    fn load_github_token_degrades_to_anonymous_when_the_store_errors() {
        assert_eq!(load_github_token(&FailingStore, "plaza"), None, "读取失败要降级匿名,不能 panic");
    }

    // ============================================================ 广场详情缓存(M9 任务 4)

    /// 造一个像真技能库那样的最小压缩包:一个技能、一个 SKILL.md。
    ///
    /// 这不是任务分解禁止的"发现逻辑复制"——发现算法本身仍只调既有的
    /// `store::build_index`(见 `plaza::fetch_repo_skills`),这里只是喂给它的
    /// 原始压缩包数据,是测试 fixture,不是第二份解析实现。
    fn fake_archive(slug: &str) -> crate::core::gitea::RepoArchive {
        let path = format!("owner-repo-aaa1111/skills/{slug}/SKILL.md");
        let text = format!("---\nname: {slug}\ndescription: {slug} 的说明\n---\n\n正文\n");
        let mut archive = crate::core::gitea::RepoArchive {
            root: "owner-repo-aaa1111".to_string(),
            tree: crate::core::skills::MemTree::new().with_file(&path, &text),
            files: vec![path.clone()],
            entries: Default::default(),
        };
        archive.entries.insert(
            path,
            crate::core::gitea::ArchiveEntry { bytes: text.into_bytes(), unix_mode: None },
        );
        archive
    }

    /// 统计 `download_archive` 被调用次数的假来源,供缓存命中测试用——不碰网络。
    struct CountingSource {
        calls: std::sync::atomic::AtomicUsize,
        slug: &'static str,
    }

    impl crate::core::gitea::RepoSource for CountingSource {
        async fn branch_head(
            &self,
            _r: &RepoRef,
        ) -> Result<crate::core::gitea::BranchHead, AppError> {
            Ok(crate::core::gitea::BranchHead {
                sha: "aaa1111".into(),
                committed_at: "2026-08-12T10:00:00Z".into(),
            })
        }
        async fn download_archive(
            &self,
            _r: &RepoRef,
        ) -> Result<crate::core::gitea::RepoArchive, AppError> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(fake_archive(self.slug))
        }
    }

    fn some_repo() -> RepoRef {
        RepoRef { owner: "vercel-labs".into(), repo: "skills".into(), branch: "main".into() }
    }

    #[tokio::test]
    async fn cached_plaza_detail_hits_cache_on_second_call_with_the_same_key() {
        let cache: PlazaDetailCache = Mutex::new(HashMap::new());
        let client = CountingSource { calls: Default::default(), slug: "weekly-report" };
        let repo = some_repo();

        let first = cached_plaza_detail(&cache, "vercel-labs/skills", &client, &repo)
            .await
            .unwrap();
        let second = cached_plaza_detail(&cache, "vercel-labs/skills", &client, &repo)
            .await
            .unwrap();

        assert_eq!(first, second);
        assert_eq!(
            client.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "第二次同 key 调用不该再发一次请求"
        );
    }

    /// 注入验证的靶子(缓存键写错的典型后果):如果 `cache_key` 算错(比如两个不同仓
    /// 被算成同一个键,或干脆恒定),第二个仓会拿到第一个仓的详情而不是自己现拉一份。
    /// 用两个不同 key + 不同 slug 同时验证"隔离"与"各自都现拉了一次"两件事。
    #[tokio::test]
    async fn cached_plaza_detail_does_not_conflate_different_repos() {
        let cache: PlazaDetailCache = Mutex::new(HashMap::new());
        let client_a = CountingSource { calls: Default::default(), slug: "weekly-report" };
        let client_b = CountingSource { calls: Default::default(), slug: "docx-to-markdown" };
        let repo_a = some_repo();
        let repo_b = RepoRef { owner: "octocat".into(), repo: "hello-world".into(), branch: "main".into() };

        let a = cached_plaza_detail(&cache, "vercel-labs/skills", &client_a, &repo_a)
            .await
            .unwrap();
        let b = cached_plaza_detail(&cache, "octocat/hello-world", &client_b, &repo_b)
            .await
            .unwrap();

        assert_eq!(client_a.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            client_b.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "不同 key 必须各自现拉一次,不能被前一个 key 的缓存顶替"
        );
        assert_eq!(a[0].dir_slug, "weekly-report");
        assert_eq!(b[0].dir_slug, "docx-to-markdown");
    }

    /// 全局单例本身的形状:两次拿到的是同一把锁背后的同一份存储,不是各自新建的空表。
    #[tokio::test]
    async fn plaza_detail_cache_is_a_process_wide_singleton() {
        plaza_detail_cache()
            .lock()
            .expect("广场详情缓存锁不该中毒")
            .insert("probe/singleton".to_string(), Vec::new());
        assert!(
            plaza_detail_cache()
                .lock()
                .expect("广场详情缓存锁不该中毒")
                .contains_key("probe/singleton"),
            "两次调用 plaza_detail_cache() 必须拿到同一份存储"
        );
    }

    // ============================================================ 广场热门排行榜的缓存(M10 任务 4)

    fn test_http_client() -> reqwest::Client {
        reqwest::Client::builder().user_agent("SkillSync/test").build().unwrap()
    }

    async fn mount_leaderboard_home(server: &wiremock::MockServer, body: String, calls_counter: bool) {
        let mock = wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(body));
        if calls_counter {
            mock.expect(1).mount(server).await;
        } else {
            mock.mount(server).await;
        }
    }

    fn one_official_skill_home_body() -> String {
        // 转义态(真实上游同款):真引号写作 \",与 core::plaza 的测试用同一套构造方式
        // ——直接手写裸引号 JSON 喂给这个端点测不出真实场景,locate_initial_skills_array
        // 会在第一个裸引号处判定失败,整批解析落空(这条注释同款教训见
        // tests/plaza_leaderboard.rs)。
        let unescaped = r#"4e:["$","$L55",null,{"initialSkills":[{"source":"a/a","skillId":"one","name":"one","installs":10}]}]"#;
        let escaped = serde_json::to_string(unescaped).unwrap();
        format!("<script>{}</script>", &escaped[1..escaped.len() - 1])
    }

    #[tokio::test]
    async fn cached_plaza_leaderboard_hits_cache_on_second_call() {
        let server = wiremock::MockServer::start().await;
        // `.expect(1)`:第二次调用如果又发了一次请求,mount 校验会在 drop 时 panic
        // ——这比只断言返回值相等更硬,能抓住"缓存形同虚设、其实每次都重拉"这类回归。
        mount_leaderboard_home(&server, one_official_skill_home_body(), true).await;
        let cache: PlazaLeaderboardCache = Mutex::new(None);
        let http = test_http_client();
        let home_url = format!("{}/", server.uri());

        let first = cached_plaza_leaderboard(&cache, &http, &home_url).await;
        let second = cached_plaza_leaderboard(&cache, &http, &home_url).await;

        assert_eq!(first, second);
        assert_eq!(first.len(), 1);
    }

    /// 空结果(降级态)不写缓存:第二次调用应该再尝试一次,而不是永远卡在空列表上
    /// ——见 `PlazaLeaderboardCache` 上方文档"给网络抖动一个自愈机会"那条理由。
    #[tokio::test]
    async fn cached_plaza_leaderboard_does_not_cache_an_empty_result() {
        let server = wiremock::MockServer::start().await;
        // 两次请求都挂:第一次返回坏数据(降级成空),第二次才返回真数据。
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string("<html>上游改版了</html>"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string(one_official_skill_home_body()))
            .mount(&server)
            .await;
        let cache: PlazaLeaderboardCache = Mutex::new(None);
        let http = test_http_client();
        let home_url = format!("{}/", server.uri());

        let first = cached_plaza_leaderboard(&cache, &http, &home_url).await;
        assert!(first.is_empty(), "第一轮应该降级为空列表: {first:?}");

        let second = cached_plaza_leaderboard(&cache, &http, &home_url).await;
        assert_eq!(second.len(), 1, "空结果不该被缓存,第二次应该重新尝试并拿到真数据");
    }

    // ============================================================ blob 快路径的回退编排(M10 任务 2)
    //
    // `fetch_skill_detail_via_blob` 本身"什么条件下该 Err"已经在
    // `tests/plaza_detail_blob.rs` 钉住;这里测的是 `plaza_detail_for_client`
    // 用这个 Err/Ok 做的路由决定——blob 失败必须落到与改动前完全同一条
    // `cached_plaza_detail` 路径,不能凑合出一个只有一项的"列表"。

    async fn mount_weekly_report_blob(server: &wiremock::MockServer, status: u16, body: serde_json::Value) {
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(
                "/api/download/vercel-labs/skills/weekly-report",
            ))
            .respond_with(wiremock::ResponseTemplate::new(status).set_body_json(body))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn plaza_detail_for_client_uses_blob_and_skips_the_zipball_when_it_matches() {
        let skillssh = wiremock::MockServer::start().await;
        mount_weekly_report_blob(
            &skillssh,
            200,
            serde_json::json!({
                "files": [{
                    "path": "SKILL.md",
                    "contents": "---\nname: weekly-report\ndescription: 从 blob 来的\n---\n\n正文\n"
                }]
            }),
        )
        .await;
        let cache: PlazaDetailCache = Mutex::new(HashMap::new());
        let client = CountingSource { calls: Default::default(), slug: "weekly-report" };
        let repo = some_repo();

        let result = plaza_detail_for_client(
            &client,
            &repo,
            &cache,
            "vercel-labs/skills",
            &skillssh.uri(),
            Some("vercel-labs/skills/weekly-report"),
            Some("weekly-report"),
        )
        .await
        .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].description, "从 blob 来的");
        assert_eq!(
            client.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "blob 命中时不该再下整仓压缩包"
        );
    }

    /// 名字对不上是"多技能仓、名字对不上时显示列表"这条既有行为的触发条件
    /// (M9 任务 5)——必须落到能展示**该仓全部技能**的 zipball 路径,不能只返回
    /// 这一个文不对题的结果。
    #[tokio::test]
    async fn plaza_detail_for_client_falls_back_to_the_full_zipball_when_the_blob_name_mismatches() {
        let skillssh = wiremock::MockServer::start().await;
        mount_weekly_report_blob(
            &skillssh,
            200,
            serde_json::json!({
                "files": [{
                    "path": "SKILL.md",
                    "contents": "---\nname: 完全不同的名字\ndescription: 从 blob 来的\n---\n\n正文\n"
                }]
            }),
        )
        .await;
        let cache: PlazaDetailCache = Mutex::new(HashMap::new());
        let client = CountingSource { calls: Default::default(), slug: "weekly-report" };
        let repo = some_repo();

        let result = plaza_detail_for_client(
            &client,
            &repo,
            &cache,
            "vercel-labs/skills",
            &skillssh.uri(),
            Some("vercel-labs/skills/weekly-report"),
            Some("weekly-report"),
        )
        .await
        .unwrap();

        assert_eq!(
            client.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "blob 名字对不上必须回退到现拉整仓这条既有路径"
        );
        // fake_archive 只放了一个技能,断言拿到的是 zipball 路径的产物而不是 blob 的
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].dir_slug, "weekly-report");
        assert_eq!(result[0].description, "weekly-report 的说明", "必须是 fake_archive 的内容,不是 blob 的");
    }

    #[tokio::test]
    async fn plaza_detail_for_client_falls_back_when_blob_404s() {
        let skillssh = wiremock::MockServer::start().await;
        mount_weekly_report_blob(&skillssh, 404, serde_json::json!({"error": "not found"})).await;
        let cache: PlazaDetailCache = Mutex::new(HashMap::new());
        let client = CountingSource { calls: Default::default(), slug: "weekly-report" };
        let repo = some_repo();

        let result = plaza_detail_for_client(
            &client,
            &repo,
            &cache,
            "vercel-labs/skills",
            &skillssh.uri(),
            Some("vercel-labs/skills/weekly-report"),
            Some("weekly-report"),
        )
        .await
        .unwrap();

        assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(result[0].dir_slug, "weekly-report");
    }

    /// 缺 `skill_id`/`wanted_name`(旧调用方/未来其他入口)必须**完全不碰** blob——
    /// 直接走 `cached_plaza_detail`,一次网络请求都不该发到 skills.sh。
    #[tokio::test]
    async fn plaza_detail_for_client_skips_blob_entirely_without_skill_id_or_wanted_name() {
        let skillssh = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(
                "/api/download/vercel-labs/skills/weekly-report",
            ))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({"files": []})))
            .expect(0)
            .mount(&skillssh)
            .await;
        let cache: PlazaDetailCache = Mutex::new(HashMap::new());
        let client = CountingSource { calls: Default::default(), slug: "weekly-report" };
        let repo = some_repo();

        let result = plaza_detail_for_client(
            &client,
            &repo,
            &cache,
            "vercel-labs/skills",
            &skillssh.uri(),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(client.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(result[0].dir_slug, "weekly-report");
    }

    // ============================================================ 安装走 blob(M10 任务 3)
    //
    // `install_via_plaza_blob` 本身"什么条件下该 Err"是这里的重点(白名单/内部标记/
    // 路径解不出来);落盘之后的 DoD(hash 等式、path 与 zipball 路径一致)在下面
    // 那条端到端测试里,用真实的 `acquire::acquire_prefetched`/`acquire::acquire`
    // 两条路径分别落到独立临时 HOME,逐字段比对——两条路径共用同一个 `finish`,
    // 这条测试钉的正是"共用"这件事本身没有名不副实。

    /// 与 `plaza_acquire.rs` 同款的最小 `AgentEnv`:指向临时目录,不碰真实 `$HOME`。
    struct TmpEnv {
        home: std::path::PathBuf,
    }
    impl crate::core::agents::AgentEnv for TmpEnv {
        fn home(&self) -> Option<std::path::PathBuf> {
            Some(self.home.clone())
        }
        fn var(&self, _: &str) -> Option<String> {
            None
        }
        fn path_exists(&self, path: &std::path::Path) -> bool {
            path.exists()
        }
        fn read_to_string(&self, path: &std::path::Path) -> Option<String> {
            std::fs::read_to_string(path).ok()
        }
    }

    async fn mount_branch_head(
        server: &wiremock::MockServer,
        owner: &str,
        repo: &str,
        branch: &str,
        sha: &str,
    ) {
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/api/v3/repos/{owner}/{repo}/branches/{branch}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": branch,
                "commit": { "sha": sha, "commit": { "committer": { "date": "2026-08-17T10:00:00Z" } } }
            })))
            .mount(server)
            .await;
    }

    async fn mount_tree(
        server: &wiremock::MockServer,
        owner: &str,
        repo: &str,
        sha: &str,
        paths: &[&str],
        truncated: bool,
    ) {
        let tree: Vec<_> = paths.iter().map(|p| serde_json::json!({"path": p, "type": "blob"})).collect();
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/api/v3/repos/{owner}/{repo}/git/trees/{sha}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sha": sha, "truncated": truncated, "tree": tree
            })))
            .mount(server)
            .await;
    }

    async fn mount_blob(
        server: &wiremock::MockServer,
        owner: &str,
        repo: &str,
        slug: &str,
        status: u16,
        body: serde_json::Value,
    ) {
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!("/api/download/{owner}/{repo}/{slug}")))
            .respond_with(wiremock::ResponseTemplate::new(status).set_body_json(body))
            .mount(server)
            .await;
    }

    fn nested_repo() -> RepoRef {
        RepoRef { owner: "wshobson".into(), repo: "agents".into(), branch: "main".into() }
    }

    #[tokio::test]
    async fn install_via_plaza_blob_resolves_the_real_nested_path_not_the_dir_slug() {
        let server = wiremock::MockServer::start().await;
        let repo = nested_repo();
        mount_branch_head(&server, "wshobson", "agents", "main", "aaa1111").await;
        mount_tree(
            &server,
            "wshobson",
            "agents",
            "aaa1111",
            &[
                "plugins/developer-essentials/skills/code-review-excellence/SKILL.md",
                "README.md",
            ],
            false,
        )
        .await;
        mount_blob(
            &server,
            "wshobson",
            "agents",
            "code-review-excellence",
            200,
            serde_json::json!({
                "files": [{"path": "SKILL.md", "contents": "---\nname: 代码审查\ndescription: 演示\n---\n\n正文\n"}]
            }),
        )
        .await;

        let github_client = github::GithubClient::new(&server.uri(), None, reqwest::Client::new());
        let cache: RepoTreeCache = Mutex::new(HashMap::new());

        let (skill, payload, sha) = install_via_plaza_blob(
            &github_client,
            &repo,
            &reqwest::Client::new(),
            &server.uri(),
            &cache,
            "code-review-excellence",
        )
        .await
        .unwrap();

        assert_eq!(sha, "aaa1111");
        assert_eq!(
            skill.path,
            "plugins/developer-essentials/skills/code-review-excellence",
            "必须是解出来的真实路径,不能退化成目录名近似值"
        );
        assert_ne!(skill.path, skill.dir_slug);
        assert!(payload.files().contains_key("SKILL.md"));
    }

    /// 白名单不过必须**在发 trees 请求之前**就拒绝——用 `.expect(0)` 硬断言这一点,
    /// 不只是断言最终结果是 Err(那样测不出"有没有多打一次不必要的请求")。
    #[tokio::test]
    async fn install_via_plaza_blob_rejects_before_calling_trees_when_a_script_file_is_present() {
        let server = wiremock::MockServer::start().await;
        let repo = some_repo();
        mount_branch_head(&server, "vercel-labs", "skills", "main", "aaa1111").await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/api/v3/repos/vercel-labs/skills/git/trees/.*",
            ))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"sha": "aaa1111", "truncated": false, "tree": []}),
            ))
            .expect(0)
            .mount(&server)
            .await;
        mount_blob(
            &server,
            "vercel-labs",
            "skills",
            "weekly-report",
            200,
            serde_json::json!({
                "files": [
                    {"path": "SKILL.md", "contents": "---\nname: 周报\ndescription: 演示\n---\n\n正文\n"},
                    {"path": "scripts/run.sh", "contents": "#!/bin/sh\necho hi\n"}
                ]
            }),
        )
        .await;

        let github_client = github::GithubClient::new(&server.uri(), None, reqwest::Client::new());
        let cache: RepoTreeCache = Mutex::new(HashMap::new());

        let err = install_via_plaza_blob(
            &github_client,
            &repo,
            &reqwest::Client::new(),
            &server.uri(),
            &cache,
            "weekly-report",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "NET_PLAZA_BLOB");
    }

    /// 同上,换成二进制文件——白名单挡的不只是脚本。
    #[tokio::test]
    async fn install_via_plaza_blob_rejects_before_calling_trees_when_a_binary_file_is_present() {
        let server = wiremock::MockServer::start().await;
        let repo = some_repo();
        mount_branch_head(&server, "vercel-labs", "skills", "main", "aaa1111").await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(
                r"^/api/v3/repos/vercel-labs/skills/git/trees/.*",
            ))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"sha": "aaa1111", "truncated": false, "tree": []}),
            ))
            .expect(0)
            .mount(&server)
            .await;
        mount_blob(
            &server,
            "vercel-labs",
            "skills",
            "weekly-report",
            200,
            serde_json::json!({
                "files": [
                    {"path": "SKILL.md", "contents": "---\nname: 周报\ndescription: 演示\n---\n\n正文\n"},
                    {"path": "assets/logo.png", "contents": "not really png bytes"}
                ]
            }),
        )
        .await;

        let github_client = github::GithubClient::new(&server.uri(), None, reqwest::Client::new());
        let cache: RepoTreeCache = Mutex::new(HashMap::new());

        let err = install_via_plaza_blob(
            &github_client,
            &repo,
            &reqwest::Client::new(),
            &server.uri(),
            &cache,
            "weekly-report",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "NET_PLAZA_BLOB");
    }

    /// 树被截断(超大仓)必须回退,即便现存路径里恰好只有一个匹配。
    #[tokio::test]
    async fn install_via_plaza_blob_rejects_when_the_tree_is_truncated() {
        let server = wiremock::MockServer::start().await;
        let repo = nested_repo();
        mount_branch_head(&server, "wshobson", "agents", "main", "aaa1111").await;
        mount_tree(
            &server,
            "wshobson",
            "agents",
            "aaa1111",
            &["plugins/developer-essentials/skills/code-review-excellence/SKILL.md"],
            true, // truncated
        )
        .await;
        mount_blob(
            &server,
            "wshobson",
            "agents",
            "code-review-excellence",
            200,
            serde_json::json!({"files": [{"path": "SKILL.md", "contents": "---\nname: 代码审查\ndescription: 演示\n---\n\n正文\n"}]}),
        )
        .await;

        let github_client = github::GithubClient::new(&server.uri(), None, reqwest::Client::new());
        let cache: RepoTreeCache = Mutex::new(HashMap::new());

        let err = install_via_plaza_blob(
            &github_client,
            &repo,
            &reqwest::Client::new(),
            &server.uri(),
            &cache,
            "code-review-excellence",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "NET_PLAZA_BLOB");
    }

    #[tokio::test]
    async fn cached_repo_tree_hits_cache_on_second_call_with_the_same_sha() {
        let server = wiremock::MockServer::start().await;
        // `.expect(1)` 是断言,不是限流:如果代码没走缓存而真发了第二次请求,
        // wiremock 仍会正常应答两次,只有在 server 于测试结束时 drop 校验期望
        // 才会因"实际命中 2 次 != 期望 1 次"而 panic——与本文件其余 `.expect(0)`
        // 用例同一套验证方式。
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(
                "/api/v3/repos/vercel-labs/skills/git/trees/aaa1111",
            ))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"sha": "aaa1111", "truncated": false, "tree": []}),
            ))
            .expect(1)
            .mount(&server)
            .await;

        let github_client = github::GithubClient::new(&server.uri(), None, reqwest::Client::new());
        let cache: RepoTreeCache = Mutex::new(HashMap::new());
        let repo = some_repo();

        let first = cached_repo_tree(&cache, &github_client, &repo, "aaa1111").await.unwrap();
        let second = cached_repo_tree(&cache, &github_client, &repo, "aaa1111").await.unwrap();
        assert_eq!(first.paths, second.paths);
    }

    /// 用 zip crate 构建一个与 blob mock 内容逐字节相同的压缩包,顶层前缀模拟 GitHub
    /// 的 `{owner}-{repo}-{短sha}/` 形态,技能放在与旗舰样本同款的嵌套路径下——
    /// path 缺口那道护栏必须在"嵌套目录"这个真实会发生的场景下验证,顶层技能测不出
    /// 差别(dir_slug 与 path 恰好相等,退化成近似值也不会被抓到)。
    fn nested_zip(owner: &str, repo: &str, sha: &str, slug: &str, skill_md: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            let root = format!("{owner}-{repo}-{sha}");
            w.add_directory(format!("{root}/"), opts).unwrap();
            w.start_file(
                format!("{root}/plugins/developer-essentials/skills/{slug}/SKILL.md"),
                opts,
            )
            .unwrap();
            std::io::Write::write_all(&mut w, skill_md.as_bytes()).unwrap();
            w.finish().unwrap();
        }
        buf
    }

    /// DoD 头号护栏(逐条见任务 3 报告):
    /// 1. 落盘后 `fsops::dir_content_hash` 必须等于索引里的 `content_hash`;
    /// 2. `state.installed[].source.path` 与 `.skill-lock.json` 的 `skillPath`
    ///    必须与走 zipball 装**同一个技能**时写下的值完全相等——这两条护栏此前都
    ///    只存在于报告文字里,这条测试是它们唯一的代码形态。
    #[tokio::test]
    async fn blob_install_matches_the_zipball_install_on_content_hash_and_recorded_path() {
        const NOW: &str = "2026-08-17T12:00:00.000Z";
        let owner = "wshobson";
        let repo_name = "agents";
        let branch = "main";
        let sha = "aaa1111";
        let slug = "code-review-excellence";
        let skill_md = "---\nname: 代码审查\ndescription: 演示\n---\n\n正文,长度无所谓,只要两条路径写的字节相同。\n";
        let nested_path = format!("plugins/developer-essentials/skills/{slug}");

        let server = wiremock::MockServer::start().await;
        mount_branch_head(&server, owner, repo_name, branch, sha).await;
        mount_tree(
            &server,
            owner,
            repo_name,
            sha,
            &[&format!("{nested_path}/SKILL.md"), "README.md"],
            false,
        )
        .await;
        mount_blob(
            &server,
            owner,
            repo_name,
            slug,
            200,
            serde_json::json!({"files": [{"path": "SKILL.md", "contents": skill_md}]}),
        )
        .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path(format!(
                "/api/v3/repos/{owner}/{repo_name}/zipball/{branch}"
            )))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(nested_zip(owner, repo_name, sha, slug, skill_md)))
            .mount(&server)
            .await;

        let github_client = github::GithubClient::new(&server.uri(), None, reqwest::Client::new());
        let repo = RepoRef { owner: owner.into(), repo: repo_name.into(), branch: branch.into() };
        let registry = AgentRegistry::builtin();
        let tmp = tempfile::tempdir().unwrap();

        // ---- 索引侧的 content_hash:与生产完全同一条建索引路径(zipball 是唯一真相源)----
        let head = github_client.branch_head(&repo).await.unwrap();
        let archive = github_client.download_archive(&repo).await.unwrap();
        let index = store::build_index("plaza", &repo, &head, &archive, 0);
        let indexed = index.skills.iter().find(|s| s.dir_slug == slug).expect("zipball 里应发现到这个技能");
        assert_eq!(indexed.path, nested_path, "sanity:索引侧解出的真实路径应与嵌套 fixture 一致");

        // 普通函数而不是闭包:`AcquireRequest<'a>` 要求返回值的生命周期跟着入参走
        // (`for<'a> Fn(&'a RepoRef) -> AcquireRequest<'a>`),闭包类型推导表达不出
        // 这个高阶生命周期,函数的生命周期省略规则天然支持。
        fn req_for<'a>(repo: &'a RepoRef, slug: &'a str) -> acquire::AcquireRequest<'a> {
            acquire::AcquireRequest {
                source: acquire::SourceMeta {
                    registry_id: "plaza",
                    kind: "github",
                    base_url: "https://github.com",
                },
                repo,
                dir_slug: slug,
                agent_names: &[],
                resolution: None,
            }
        }

        // ---- blob 路径:install_via_plaza_blob → acquire_prefetched 落盘 ----
        let tree_cache: RepoTreeCache = Mutex::new(HashMap::new());
        let (skill, payload, remote_sha) = install_via_plaza_blob(
            &github_client,
            &repo,
            &reqwest::Client::new(),
            &server.uri(),
            &tree_cache,
            slug,
        )
        .await
        .unwrap();
        assert_eq!(skill.path, indexed.path);

        let env_blob = TmpEnv { home: tmp.path().join("blob-home") };
        let store_blob = state::Store::new(env_blob.home.join(".skillsync"));
        let outcome = acquire::acquire_prefetched(
            &registry,
            &env_blob,
            &store_blob,
            req_for(&repo, slug),
            &skill,
            payload,
            &remote_sha,
            NOW,
            &|_: acquire::Stage| {},
        )
        .await
        .unwrap();
        let acquire::AcquireOutcome::Installed { report, .. } = outcome else {
            panic!("全新安装不该撞冲突: {outcome:?}")
        };

        // ---- DoD①:落盘后的 hash 必须与索引里的 content_hash 相等 ----
        let canonical = std::path::PathBuf::from(&report.canonical_dir);
        let disk_hash = crate::core::fsops::dir_content_hash(&canonical).unwrap();
        assert_eq!(
            disk_hash, indexed.content_hash,
            "blob 装出来的字节必须与索引里的 content_hash 对得上——不等就是界面永远误报'有更新'"
        );

        let st_blob = store_blob.load_state().unwrap().value;
        assert_eq!(st_blob.installed[0].source.path, indexed.path);

        // ---- 对照:zipball 路径装**同一个技能**,两条路径落到独立的临时 HOME ----
        let env_zip = TmpEnv { home: tmp.path().join("zip-home") };
        let store_zip = state::Store::new(env_zip.home.join(".skillsync"));
        acquire::acquire(
            &github_client,
            &registry,
            &env_zip,
            &store_zip,
            req_for(&repo, slug),
            NOW,
            0,
            &|_: acquire::Stage| {},
        )
        .await
        .unwrap();
        let st_zip = store_zip.load_state().unwrap().value;

        // ---- DoD②:state.installed[].source.path 两条路径必须完全相等 ----
        assert_eq!(
            st_blob.installed[0].source.path, st_zip.installed[0].source.path,
            "blob 装与 zipball 装同一个技能,state.installed[].source.path 必须完全相等"
        );
        assert_eq!(st_blob.installed[0].source.path, nested_path);

        // ---- DoD②(续):.skill-lock.json 的 skillPath 两条路径也必须完全相等 ----
        let lock_blob: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(env_blob.home.join(".agents").join(".skill-lock.json")).unwrap(),
        )
        .unwrap();
        let lock_zip: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(env_zip.home.join(".agents").join(".skill-lock.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            lock_blob["skills"][slug]["skillPath"], lock_zip["skills"][slug]["skillPath"],
            ".skill-lock.json 的 skillPath 两条路径必须完全相等"
        );
        assert_eq!(lock_blob["skills"][slug]["skillPath"], nested_path);
    }
}
