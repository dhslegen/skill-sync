//! Tauri IPC command 定义。薄壳:仅做参数转换与调用 core,禁止在此写业务逻辑。

use serde::{Deserialize, Serialize};

use crate::core::agents::{AgentRegistry, DetectedAgent, SystemEnv};
use crate::core::auth::{self, KeyringStore, OAuthConfig};
use crate::core::builtin;
use crate::core::gitea::{GiteaClient, RepoRef};
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
    let dir = state::Store::for_env(&SystemEnv).ok_or_else(|| {
        AppError::new("FS_NO_HOME", "找不到用户主目录,无法保存本地数据")
    })?;
    Ok(store::cache_path(dir.dir(), registry_id))
}

/// M1 商店一律匿名读:内建技能库公开可读(已实测),而带上一个可能已过期的令牌
/// 反而会把本来能成的匿名请求变成 401。私有技能库源到任务 11 支持自定义源时再接凭证。
fn anonymous_client(base_url: String) -> Result<GiteaClient, AppError> {
    Ok(GiteaClient::with_http(base_url, None, http_client()?))
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

#[cfg(test)]
mod tests {
    use super::*;

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
