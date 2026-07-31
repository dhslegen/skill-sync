//! Tauri IPC command 定义。薄壳:仅做参数转换与调用 core,禁止在此写业务逻辑。

use serde::{Deserialize, Serialize};

use tauri::{Emitter, Manager};

use crate::core::acquire;
use crate::core::agents::{AgentRegistry, DetectedAgent, SystemEnv};
use crate::core::auth::{self, CredentialStore, KeyringStore, OAuthConfig};
use crate::core::builtin;
use crate::core::gitea::{GiteaClient, RepoRef};
use crate::core::github;
use crate::core::installer::{self, InstallReport, Installer};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum AppUpdateStatus {
    UpToDate,
    Available { version: String },
}

#[tauri::command]
pub async fn app_update_check(app: tauri::AppHandle) -> Result<AppUpdateStatus, AppError> {
    match app_updater(&app)?.check().await.map_err(update_err)? {
        Some(update) => Ok(AppUpdateStatus::Available {
            version: update.version.clone(),
        }),
        None => Ok(AppUpdateStatus::UpToDate),
    }
}

/// 下载并安装新版本。签名校验在插件内完成:校验不过整个安装终止,不会落半个字节。
/// 安装完成**不自动重启**——用户可能正开着别的操作,由前端提示后调 `app_restart`。
#[tauri::command]
pub async fn app_update_install(app: tauri::AppHandle) -> Result<(), AppError> {
    let Some(update) = app_updater(&app)?.check().await.map_err(update_err)? else {
        return Err(AppError::new("UPDATE_GONE", "当前已是最新版本,无需安装"));
    };
    let channel = "app-update://progress";
    update
        .download_and_install(
            |_chunk, _total| {},
            || {
                // 下载完成、开始安装(阶段级进度,与获取流程同一诚实粒度)
            },
        )
        .await
        .map_err(|e| {
            AppError::new("UPDATE_INSTALL_FAILED", "应用更新安装失败,已保持当前版本")
                .with_detail(e.to_string())
        })?;
    let _ = app.emit(channel, "installed");
    tracing::info!(version = %update.version, "应用更新已安装,等待重启生效");
    Ok(())
}

#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) {
    app.restart();
}

/// 启动时的一次性 App 更新检查(config.autoUpdate.app 开着且更新源已配置才跑)。
/// 假设:每次启动至多提醒一次,不做"忽略此版本"记忆——那是 M3 打磨项。
pub fn spawn_app_update_probe(app: tauri::AppHandle) {
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
    tauri::async_runtime::spawn(async move {
        // 错开 skill 检查的首轮(10s),也给网络起身时间
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        match app_update_check(app.clone()).await {
            Ok(AppUpdateStatus::Available { version }) => {
                let _ = app.emit("app-update://available", &version);
                use tauri_plugin_notification::NotificationExt;
                let body = format!("SkillSync {version} 已发布,可到「设置」页安装。");
                if let Err(err) = app
                    .notification()
                    .builder()
                    .title("应用更新")
                    .body(&body)
                    .show()
                {
                    tracing::warn!(error = %err, "应用更新通知发送失败");
                }
            }
            Ok(AppUpdateStatus::UpToDate) => {
                tracing::info!("启动检查:应用已是最新");
            }
            Err(err) => {
                tracing::warn!(code = %err.code, "启动时应用更新检查未完成");
            }
        }
    });
}

/// 一轮逐源检查(M3 任务 2):内建 + 全部自定义源依次跑,一个源失败不拦其他源。
/// 返回 `None` = 没有任何源成功跑完(全失败或没有可查的源),这一轮不上报
/// ——把"全挂了"报成 `NothingInstalled` 等于撒谎。
async fn run_all_sources_check() -> Option<scheduler::CheckReport> {
    let store = app_store().ok()?;
    let registries_cfg = match store.load_config() {
        Ok(l) => l.value.registries,
        Err(err) => {
            tracing::warn!(code = %err.code, "定时检查读不到配置,本轮跳过");
            return None;
        }
    };
    let builtin_src = registry::BuiltinSource::from_build();
    let registry = AgentRegistry::builtin();

    let mut ids = vec![BUILTIN_REGISTRY_ID.to_string()];
    ids.extend(registries_cfg.iter().map(|r| r.id.clone()));

    let mut reports = Vec::new();
    for id in ids {
        if registry::resolve(&builtin_src, &registries_cfg, &id).is_err() {
            // 内建未注入配置的开发构建每轮都走到这:记 debug 免得刷日志
            tracing::debug!(registry_id = %id, "定时检查跳过该源(解析失败)");
            continue;
        }
        let round = async {
            let (client, repo) = read_source(&id).await?;
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
    let registries = app_store()?.load_config()?.value.registries;
    Ok(registry::list(
        &registry::BuiltinSource::from_build(),
        &registries,
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
    if let Ok(cache) = index_cache_file(&args.registry_id) {
        store::drop_cache(&cache);
    }
    Ok(registry::list(
        &registry::BuiltinSource::from_build(),
        &config.registries,
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

/// 解析某个源(不限 kind,github 的闸门由各调用方按需加)。
fn resolve_registry(registry_id: &str) -> Result<registry::ResolvedRegistry, AppError> {
    let registries = app_store()?.load_config()?.value.registries;
    registry::resolve(
        &registry::BuiltinSource::from_build(),
        &registries,
        registry_id,
    )
}

/// 某个源的登录配置。内建:OAuth PKCE;自定义:PAT(client_id 留空,判定在 core)。
fn auth_config(registry_id: &str) -> Result<OAuthConfig, AppError> {
    let resolved = resolve_registry(registry_id)?;
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
    let resolved = resolve_registry(args.id())?;
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
    let resolved = resolve_registry(registry_id)?;
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
    let resolved = resolve_registry(args.id())?;
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
    let resolved = resolve_registry(args.id())?;
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
    let resolved = resolve_registry(registry_id)?;
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

/// 解析某个源的技能库坐标。**分享链路专用**(Gitea-only,GitHub 分享归任务 5);
/// 读链路走 [`read_source`],对来源类型无感。
fn registry_target(registry_id: &str) -> Result<(String, RepoRef), AppError> {
    let resolved = resolve_registry(registry_id)?;
    resolved.require_gitea()?;
    Ok((resolved.base_url, resolved.repo))
}

/// 商店索引的缓存落点。与 config/state 同目录(`~/.skillsync`)。
fn index_cache_file(registry_id: &str) -> Result<std::path::PathBuf, AppError> {
    Ok(store::cache_path(app_store()?.dir(), registry_id))
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
async fn read_source(registry_id: &str) -> Result<(SourceClient, RepoRef), AppError> {
    let resolved = resolve_registry(registry_id)?;
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
    /// 用户手动点刷新:跳过"版本没变就不下载"的判定。
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub async fn store_index(args: StoreIndexArgs) -> Result<StoreIndexView, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (client, repo) = read_source(registry_id).await?;
    let cache = index_cache_file(registry_id)?;
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
    /// 技能库中的技能目录名(卡片上展示的 slug 后半段)。
    pub dir_slug: String,
}

#[tauri::command]
pub async fn store_skill_detail(args: StoreDetailArgs) -> Result<SkillDetail, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let (client, repo) = read_source(registry_id).await?;
    let cache = index_cache_file(registry_id)?;

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
    let (client, repo) = read_source(registry_id).await?;
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
    /// 技能本体是否还在 canonical 目录里。不在 = 残缺,界面要正面说出来。
    pub body_present: bool,
    /// 各关联目录的健康态(universal agent 不建链,不在此列)。
    pub links: Vec<installer::LinkHealthReport>,
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
        let registries_cfg = store.load_config()?.value.registries;
        let builtin_src = registry::BuiltinSource::from_build();

        state
            .installed
            .iter()
            .map(|s| {
                let canonical = installer.canonical_dir(&s.name)?;
                // 认不出 mode 的记账进不了健康检查——那是移除时才需要面对的问题
                let (recorded, _) = remove::state_links_to_recorded(&s.links);
                Ok(InstalledSkillView {
                    dir_slug: s.name.clone(),
                    commit_sha: s.commit_sha.clone(),
                    agents: s.agents.clone(),
                    installed_at: s.installed_at.clone(),
                    updated_at: s.updated_at.clone(),
                    local_modified: remove::is_locally_modified(&canonical, &s.content_hash),
                    source_owner: s.source.owner.clone(),
                    source_repo: s.source.repo.clone(),
                    registry_id: s.source.registry_id.clone(),
                    source_removed: registry::resolve(
                        &builtin_src,
                        &registries_cfg,
                        &s.source.registry_id,
                    )
                    .is_err(),
                    body_present: canonical.is_dir(),
                    links: installer.link_health(&s.name, &recorded)?,
                })
            })
            .collect()
    })
    .await
    .map_err(|e| {
        AppError::new("FS_TASK", "读取已安装列表失败,请重试").with_detail(e.to_string())
    })?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallBatchArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
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
    let (client, repo) = read_source(registry_id).await?;
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
    let (_, repo) = registry_target(registry_id)?;
    let client = authed_client(registry_id).await?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    share::share(
        &client,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareChangesArgs {
    #[serde(default)]
    pub registry_id: Option<String>,
    pub dir_slug: String,
}

/// 把本 app 安装、用户改过的技能推回来源仓库(冲突弹窗承诺的那条路)。
#[tauri::command]
pub async fn skill_share_changes(args: ShareChangesArgs) -> Result<share::Submitted, AppError> {
    let registry_id = args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID);
    let client = authed_client(registry_id).await?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();
    let (_, repo) = registry_target(registry_id)?;
    share::share_installed(
        &client,
        &registry,
        &SystemEnv,
        &store,
        &args.dir_slug,
        &repo.branch,
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
}
