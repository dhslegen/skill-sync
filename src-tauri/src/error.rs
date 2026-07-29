//! IPC 统一错误模型(契约见 docs/开发交接包 3.3)。
//!
//! 所有 Tauri command 返回 `Result<T, AppError>`。
//! `message` 必须是用户可读中文(且不含 git 术语),`detail` 面向日志/诊断包。
//! 错误码前缀约定:`AUTH_*` / `NET_*` / `REPO_*` / `FS_*` / `CONFLICT_*`。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    /// 稳定的机器可读错误码,如 `NET_UNREACHABLE`、`CONFLICT_STALE`。
    pub code: String,
    /// 用户可读中文信息,须给出下一步动作提示。
    pub message: String,
    /// 技术细节,仅用于日志与"导出诊断包"。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), detail: None }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_ipc_contract_shape() {
        let err = AppError::new("NET_UNREACHABLE", "无法连接公司技能库,请检查内网/VPN 连接");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "NET_UNREACHABLE");
        assert_eq!(json["message"], "无法连接公司技能库,请检查内网/VPN 连接");
        // detail 为空时不应出现在序列化结果里
        assert!(json.get("detail").is_none());
    }

    #[test]
    fn detail_included_when_present() {
        let err = AppError::new("FS_LINK_FAILED", "技能启用失败,请重试")
            .with_detail("symlink -> junction fallback failed: os error 1314");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["detail"], "symlink -> junction fallback failed: os error 1314");
    }
}
