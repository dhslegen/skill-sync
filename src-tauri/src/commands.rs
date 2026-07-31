//! Tauri IPC command 定义。薄壳:仅做参数转换与调用 core,禁止在此写业务逻辑。

use serde::{Deserialize, Serialize};

use tauri::Emitter;

use crate::core::acquire;
use crate::core::agents::{AgentRegistry, DetectedAgent, SystemEnv};
use crate::core::auth::{self, KeyringStore, OAuthConfig};
use crate::core::builtin;
use crate::core::gitea::{GiteaClient, RepoRef};
use crate::core::installer::{self, InstallReport, Installer};
use crate::core::remove;
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
    Ok(DetectedAgents {
        agents: registry.detect_all(&env),
        canonical_dir: registry
            .canonical_global_dir(&env)
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

// ============================================================ 登录

/// 内建技能库的 registry id。M1 只有这一个源,M3 起支持多源时按 id 区分凭证。
const BUILTIN_REGISTRY_ID: &str = "company";

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

/// 从编译期注入的常量拼出 OAuth 配置。未注入时给出明确提示而不是拿空值去请求。
fn oauth_config() -> Result<OAuthConfig, AppError> {
    let (Some(base_url), Some(client_id)) = (builtin::BUILTIN_GITEA_URL, builtin::OAUTH_CLIENT_ID)
    else {
        return Err(AppError::new(
            "AUTH_NOT_CONFIGURED",
            "这个版本没有配置公司技能库,请向 IT 索取正式安装包",
        ));
    };
    Ok(OAuthConfig {
        base_url: base_url.to_string(),
        client_id: client_id.to_string(),
    })
}

fn http_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .user_agent(concat!("SkillSync/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            AppError::new("NET_CLIENT_INIT", "网络组件初始化失败,请重启应用")
                .with_detail(e.to_string())
        })
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
    session::login_oauth(
        &http_client()?,
        &oauth_config()?,
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
    session::login_with_token(
        &http_client()?,
        &oauth_config()?,
        &KeyringStore,
        args.registry_id.as_deref().unwrap_or(BUILTIN_REGISTRY_ID),
        &args.token,
    )
    .await
}

#[tauri::command]
pub async fn auth_status(args: RegistryArg) -> Result<SessionStatus, AppError> {
    session::status(
        &http_client()?,
        &oauth_config()?,
        &KeyringStore,
        args.id(),
    )
    .await
}

#[tauri::command]
pub fn auth_logout(args: RegistryArg) -> Result<(), AppError> {
    session::logout(&KeyringStore, args.id())
}

// ============================================================ 商店

/// 解析商店要访问的技能库坐标。
///
/// **刻意不看 OAuth 配置**:技能库公开可匿名读(已实测),商店浏览与详情预览先于登录。
/// 若拿 [`builtin::builtin_configured`] 当门,只缺 Client ID 的构建就会连商店都打不开
/// ——那等于把"先逛后登录"这条产品前提废掉。抽成接受参数的纯函数以便单测。
fn store_target(
    gitea_url: Option<&str>,
    repo: Option<(&str, &str)>,
    branch: &str,
) -> Result<(String, RepoRef), AppError> {
    let Some(base_url) = gitea_url.filter(|u| !u.is_empty()) else {
        return Err(AppError::new(
            "REPO_NOT_CONFIGURED",
            "这个版本没有配置公司技能库,请向 IT 索取正式安装包",
        ));
    };
    let Some((owner, repo)) = repo else {
        return Err(AppError::new(
            "REPO_NOT_CONFIGURED",
            "这个版本没有指定公司技能库,请向 IT 索取正式安装包",
        ));
    };
    Ok((
        base_url.to_string(),
        RepoRef {
            owner: owner.to_string(),
            repo: repo.to_string(),
            branch: branch.to_string(),
        },
    ))
}

fn builtin_store_target() -> Result<(String, RepoRef), AppError> {
    store_target(
        builtin::BUILTIN_GITEA_URL,
        builtin::builtin_repo(),
        builtin::builtin_branch(),
    )
}

/// 商店索引的缓存落点。与 config/state 同目录(`~/.skillsync`)。
fn index_cache_file(registry_id: &str) -> Result<std::path::PathBuf, AppError> {
    Ok(store::cache_path(app_store()?.dir(), registry_id))
}

/// M1 商店一律匿名读:内建技能库公开可读(已实测),而带上一个可能已过期的令牌
/// 反而会把本来能成的匿名请求变成 401。私有技能库源到任务 11 支持自定义源时再接凭证。
fn anonymous_client(base_url: String) -> Result<GiteaClient, AppError> {
    Ok(GiteaClient::with_http(base_url, None, http_client()?))
}

/// 分享是写操作,必须带登录凭证。没登录给一个前端能识别的错误码,引导去登录。
async fn authed_client(registry_id: &str) -> Result<GiteaClient, AppError> {
    let http = http_client()?;
    let cfg = oauth_config()?;
    let token = auth::ensure_access_token(&http, &cfg, &KeyringStore, registry_id)
        .await?
        .ok_or_else(|| AppError::new("AUTH_REQUIRED", "分享前请先登录公司技能库"))?;
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
    let (base_url, repo) = builtin_store_target()?;
    let cache = index_cache_file(registry_id)?;
    let (index, outcome) = store::refresh_index(
        &anonymous_client(base_url)?,
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
    let (base_url, repo) = builtin_store_target()?;
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
        &anonymous_client(base_url)?,
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
    let (base_url, repo) = builtin_store_target()?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    // core 不认识 Tauri:编排只收一个回调,事件在这一层发。
    let channel = format!("progress://{}", args.task_id);
    let emit = |stage: acquire::Stage| {
        let _ = app.emit(channel.as_str(), stage);
    };

    acquire::acquire(
        &anonymous_client(base_url)?,
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
    let (base_url, repo) = builtin_store_target()?;
    let store = app_store()?;
    let registry = AgentRegistry::builtin();

    acquire::acquire_batch(
        &anonymous_client(base_url)?,
        &registry,
        &SystemEnv,
        &store,
        registry_id,
        &repo,
        &args.dir_slugs,
        &args.agent_ids,
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
    let (_, repo) = builtin_store_target()?;
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
    let (_, repo) = builtin_store_target()?;
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

    #[test]
    fn store_target_does_not_depend_on_oauth_configuration() {
        // 本函数的签名里根本没有 client_id 这个参数——这就是"商店浏览不依赖登录配置"
        // 这条产品前提的机器可读证据。改成走 builtin_configured() 会让本测试无从表达。
        let (url, repo) = store_target(
            Some("http://gitea.internal:3000"),
            Some(("skills", "skills")),
            "main",
        )
        .unwrap();
        assert_eq!(url, "http://gitea.internal:3000");
        assert_eq!(repo.owner, "skills");
        assert_eq!(repo.repo, "skills");
        assert_eq!(repo.branch, "main");
    }

    #[test]
    fn missing_builtin_config_gives_an_actionable_message() {
        for (url, repo) in [
            (None, Some(("skills", "skills"))),
            (Some(""), Some(("skills", "skills"))),
            (Some("http://gitea.internal:3000"), None),
        ] {
            let err = store_target(url, repo, "main").unwrap_err();
            assert_eq!(err.code, "REPO_NOT_CONFIGURED");
            // 文案规范:必须给下一步动作,且不含 git 术语
            assert!(err.message.contains("IT"), "{}", err.message);
            assert!(!err.message.contains("仓库"), "{}", err.message);
        }
    }
}
