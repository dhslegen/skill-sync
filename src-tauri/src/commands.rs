//! Tauri IPC command 定义。薄壳:仅做参数转换与调用 core,禁止在此写业务逻辑。

use serde::{Deserialize, Serialize};

use crate::core::agents::{AgentRegistry, DetectedAgent, SystemEnv};
use crate::core::auth::{KeyringStore, OAuthConfig};
use crate::core::builtin;
use crate::core::session::{self, BrowserOpener, SessionStatus, SessionUser};
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
