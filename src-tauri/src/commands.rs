//! Tauri IPC command 定义。薄壳:仅做参数转换与调用 core,禁止在此写业务逻辑。

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

/// 下载并安装新版本(公共体)。签名校验在插件内完成:校验不过整个安装终止,不会落半个字节。
/// 安装完成**不自动重启**——用户可能正开着别的操作,由前端提示后调 `app_restart`。
/// 就绪与互斥记账走 `ready_state()`:同版本装过不重复下载,并发轮次只放行一个。
async fn stage_app_update(app: &tauri::AppHandle) -> Result<Staged, AppError> {
    let Some(update) = app_updater(app)?.check().await.map_err(update_err)? else {
        return Ok(Staged::NoUpdate);
    };
    let version = update.version.clone();
    if !ready_state().begin_stage(&version) {
        return Ok(Staged::AlreadyHandled);
    }
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
    Ok(Staged::Fresh(version))
}

#[tauri::command]
pub async fn app_update_install(app: tauri::AppHandle) -> Result<(), AppError> {
    match stage_app_update(&app).await? {
        Staged::NoUpdate => Err(AppError::new("UPDATE_GONE", "当前已是最新版本,无需安装")),
        // 设置页手动点装:后台已就绪或正在装都算"这事有人管了",不报错
        Staged::Fresh(_) | Staged::AlreadyHandled => Ok(()),
    }
}

#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) {
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

pub fn spawn_app_update_probe(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 错开 skill 检查的首轮(10s),也给网络起身时间
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        run_app_update_round(&app).await;
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
) -> Vec<(String, Option<String>)> {
    registry::list(builtin, registries, builtin_extra)
        .into_iter()
        .flat_map(|view| {
            view.repos
                .into_iter()
                .map(move |repo| (view.id.clone(), Some(repo.key)))
        })
        .collect()
}

/// 一轮逐源检查(M3 任务 2):内建 + 全部自定义源依次跑,一个源失败不拦其他源。
/// 返回 `None` = 没有任何源成功跑完(全失败或没有可查的源),这一轮不上报
/// ——把"全挂了"报成 `NothingInstalled` 等于撒谎。
async fn run_all_sources_check() -> Option<scheduler::CheckReport> {
    let store = app_store().ok()?;
    let (registries_cfg, builtin_extra) = match store.load_config() {
        Ok(l) => (l.value.registries, l.value.builtin_extra_repos),
        Err(err) => {
            tracing::warn!(code = %err.code, "定时检查读不到配置,本轮跳过");
            return None;
        }
    };
    let builtin_src = registry::BuiltinSource::from_build();
    let registry = AgentRegistry::builtin();

    let targets = check_targets(&builtin_src, &registries_cfg, &builtin_extra);

    let mut reports = Vec::new();
    for (id, repo_key) in targets {
        if registry::resolve(&builtin_src, &registries_cfg, &builtin_extra, &id, repo_key.as_deref())
            .is_err()
        {
            // 内建未注入配置的开发构建每轮都走到这:记 debug 免得刷日志
            tracing::debug!(registry_id = %id, "定时检查跳过该源(解析失败)");
            continue;
        }
        let round = async {
            let (client, repo) = read_source(&id, repo_key.as_deref()).await?;
            scheduler::run_check(
                &client,
                &registry,
                &SystemEnv,
                &store,
                &id,
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
            interval_hours: auto.skills.interval_hours,
        }
    };

    let check = move || -> scheduler::BoxFuture {
        let app = app.clone();
        Box::pin(async move {
            // App 自更新顺带每轮技能检查的节奏(M6 任务 1 拍板:不为它新增档位)。
            // 放在技能检查前:它自带 update_configured / auto_update.app 双闸,轻且幂等。
            run_app_update_round(&app).await;
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
    let resolved = resolve_registry(args.id(), None)?;
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
    let resolved = resolve_registry(registry_id, None)?;
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
    let resolved = resolve_registry(args.id(), None)?;
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
    let resolved = resolve_registry(args.id(), None)?;
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
    let resolved = resolve_registry(registry_id, None)?;
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
            let token = match KeyringStore.load(registry_id) {
                Ok(creds) => creds.map(|c| c.access_token),
                Err(err) => {
                    tracing::warn!(registry_id, code = %err.code, "读取凭证失败,按匿名访问");
                    None
                }
            };
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

#[tauri::command]
pub async fn skill_install(
    app: tauri::AppHandle,
    args: InstallArgs,
) -> Result<acquire::AcquireOutcome, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (client, repo) = read_source(registry_id, args.repo.as_deref()).await?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    // core 不认识 Tauri:编排只收一个回调,事件在这一层发。
    let channel = format!("progress://{}", args.task_id);
    let emit = |stage: acquire::Stage| {
        let _ = app.emit(channel.as_str(), stage);
    };

    acquire::acquire(
        &client,
        &registry,
        &SystemEnv,
        &store,
        acquire::AcquireRequest {
            registry_id,
            repo: &repo,
            dir_slug: &args.dir_slug,
            agent_names: &args.agent_ids,
            resolution: args.resolution,
        },
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
    /// 上游(npx skills)装的、尚未认领:只有「认领」这一个动作可做(M3 任务 6)。
    pub unclaimed: bool,
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
/// 提成纯函数是为了可测:`installed_list` 要 app_store,测不了
/// ——只测两个 helper 而不测这里的组合方式,注入把两者对调也照样绿(实撞过)。
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
        )
        .is_ok()
    };
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
                    local_only: false,
                    claimed: acquire::is_claimed(s),
                    links: match installer.link_health(&s.name, &recorded) {
                        Ok(l) => l,
                        Err(e) => return Some(Err(e)),
                    },
                }))
            })
            .collect::<Result<_, AppError>>()?;

        // 上游装的未认领技能挂在列表尾部:只有「认领」可做,其余字段按"未知"如实留空
        for u in acquire::unclaimed_skills(&SystemEnv, &installer, &state) {
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
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    acquire::acquire_batch(
        &client,
        &registry,
        &SystemEnv,
        &store,
        registry_id,
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
        let registries = store.load_config()?.value.registries;
        acquire::claim(
            &installer,
            &registry,
            &SystemEnv,
            &store,
            &registries,
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

        let targets = check_targets(&builtin, &[custom], &extras);
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
        let targets = check_targets(&unconfigured, &[], &extras);
        assert!(targets.is_empty(), "没有主库时追加库也无从查起: {targets:?}");
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
}
