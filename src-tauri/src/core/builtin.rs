//! 编译期注入的内建常量。
//!
//! 架构铁律 5:内网 Gitea 地址与 OAuth Client ID 一律来自编译期环境变量,
//! 源码与仓库中不得出现真实内网地址;OAuth 为公共客户端 + PKCE,不存在任何 secret。
//!
//! 本地开发:在 shell 中导出以下变量后再 `pnpm dev`(或写入未纳入版本控制的 `.env.local`):
//! - `SKILLSYNC_BUILTIN_GITEA_URL`
//! - `SKILLSYNC_OAUTH_CLIENT_ID`

/// 编译期注入的内建 Gitea 地址(未注入时为 `None`,UI 需提示"构建未配置内建技能库")。
pub const BUILTIN_GITEA_URL: Option<&str> = option_env!("SKILLSYNC_BUILTIN_GITEA_URL");

/// 编译期注入的 Gitea OAuth2 公共客户端 Client ID。
pub const OAUTH_CLIENT_ID: Option<&str> = option_env!("SKILLSYNC_OAUTH_CLIENT_ID");

/// 内建技能库是否在本次构建中完整配置(地址与 Client ID 均已注入)。
pub fn builtin_configured() -> bool {
    matches!((BUILTIN_GITEA_URL, OAUTH_CLIENT_ID), (Some(u), Some(c)) if !u.is_empty() && !c.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_consts_match_build_env() {
        // option_env! 在编译期展开:常量必须与构建时的环境变量一致。
        assert_eq!(BUILTIN_GITEA_URL, std::option_env!("SKILLSYNC_BUILTIN_GITEA_URL"));
        assert_eq!(OAUTH_CLIENT_ID, std::option_env!("SKILLSYNC_OAUTH_CLIENT_ID"));
    }

    #[test]
    fn configured_requires_both_non_empty() {
        // 任一变量缺失或为空串时,内建库都视为未配置。
        let cases = [
            (None, None, false),
            (Some("http://example.internal"), None, false),
            (None, Some("client-id"), false),
            (Some(""), Some("client-id"), false),
            (Some("http://example.internal"), Some(""), false),
            (Some("http://example.internal"), Some("client-id"), true),
        ];
        for (url, id, expect) in cases {
            let got = matches!((url, id), (Some(u), Some(c)) if !u.is_empty() && !c.is_empty());
            assert_eq!(got, expect, "url={url:?} id={id:?}");
        }
    }
}
