//! Tauri IPC command 定义。薄壳:仅做参数转换与调用 core,禁止在此写业务逻辑。

use serde::Serialize;

use crate::core::agents::{AgentRegistry, DetectedAgent, SystemEnv};
use crate::core::builtin;
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
