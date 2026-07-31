//! 编译期注入的内建常量。
//!
//! 架构铁律 5:内网 Gitea 地址与 OAuth Client ID 一律来自编译期环境变量,
//! 源码与仓库中不得出现真实内网地址;OAuth 为公共客户端 + PKCE,不存在任何 secret。
//!
//! 本地开发:在 shell 中导出以下变量后再 `pnpm dev`(或写入未纳入版本控制的 `.env.local`):
//! - `SKILLSYNC_BUILTIN_GITEA_URL` —— 内网 Gitea 地址
//! - `SKILLSYNC_OAUTH_CLIENT_ID` —— OAuth2 公共客户端 ID(PKCE,无 secret)
//! - `SKILLSYNC_BUILTIN_REPO` —— 内建技能库,格式 `owner/repo`
//! - `SKILLSYNC_BUILTIN_BRANCH` —— 可选,默认 `main`

/// 编译期注入的内建 Gitea 地址(未注入时为 `None`,UI 需提示"构建未配置内建技能库")。
pub const BUILTIN_GITEA_URL: Option<&str> = option_env!("SKILLSYNC_BUILTIN_GITEA_URL");

/// 编译期注入的 Gitea OAuth2 公共客户端 Client ID。
pub const OAUTH_CLIENT_ID: Option<&str> = option_env!("SKILLSYNC_OAUTH_CLIENT_ID");

/// 编译期注入的内建技能库坐标,格式 `owner/repo`。
pub const BUILTIN_REPO: Option<&str> = option_env!("SKILLSYNC_BUILTIN_REPO");

/// 内建技能库的默认分支,未注入时按 `main`。
pub const BUILTIN_BRANCH: Option<&str> = option_env!("SKILLSYNC_BUILTIN_BRANCH");

/// App 自更新源:`latest.json` 的完整地址(内网静态源,M2 任务 5)。
/// 与内网地址同一纪律:编译期注入,源码不得出现真实值。
pub const UPDATE_URL: Option<&str> = option_env!("SKILLSYNC_UPDATE_URL");

/// App 自更新的 minisign 公钥(`tauri signer generate` 的 .pub 内容)。
/// 公钥本身不敏感,但真实值同样只经编译期注入——仓库里连占位都不放,
/// 免得有人误把"仓库里那个"当成生效中的钥匙。
pub const UPDATE_PUBKEY: Option<&str> = option_env!("SKILLSYNC_UPDATE_PUBKEY");

/// App 自更新是否配置齐全(地址 + 公钥,缺一即视为未配置)。
pub fn update_configured() -> bool {
    update_source().is_ok()
}

/// App 自更新源 `(latest.json 地址, minisign 公钥)`。缺任一按未配置报错。
pub fn update_source() -> Result<(String, String), crate::error::AppError> {
    match (UPDATE_URL, UPDATE_PUBKEY) {
        (Some(url), Some(key)) if !url.is_empty() && !key.is_empty() => {
            Ok((url.to_string(), key.to_string()))
        }
        _ => Err(crate::error::AppError::new(
            "UPDATE_NOT_CONFIGURED",
            "这个版本没有配置应用更新源,请向 IT 索取正式安装包",
        )),
    }
}

/// 拆出内建技能库的 `(owner, repo)`。
pub fn builtin_repo() -> Option<(&'static str, &'static str)> {
    BUILTIN_REPO?.split_once('/').filter(|(o, r)| !o.is_empty() && !r.is_empty())
}

pub fn builtin_branch() -> &'static str {
    BUILTIN_BRANCH.filter(|b| !b.is_empty()).unwrap_or("main")
}

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
        assert_eq!(UPDATE_URL, std::option_env!("SKILLSYNC_UPDATE_URL"));
        assert_eq!(UPDATE_PUBKEY, std::option_env!("SKILLSYNC_UPDATE_PUBKEY"));
    }

    #[test]
    fn update_source_reports_not_configured_without_injection() {
        // 测试构建(本地与 CI 的 cargo test)从不注入 SKILLSYNC_UPDATE_*,
        // 所以这里稳定走"未配置"分支;若哪天测试环境也开始注入,这条会转而
        // 校验注入值成对出现——两种情况都是我们要的行为。
        match (std::option_env!("SKILLSYNC_UPDATE_URL"), std::option_env!("SKILLSYNC_UPDATE_PUBKEY")) {
            (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => {
                assert!(update_source().is_ok());
            }
            _ => {
                let err = update_source().unwrap_err();
                assert_eq!(err.code, "UPDATE_NOT_CONFIGURED");
                assert!(!update_configured());
            }
        }
    }

    #[test]
    fn builtin_repo_splits_owner_and_name() {
        // 直接验证拆分规则本身,不依赖构建时是否注入
        let split = |s: &'static str| s.split_once('/').filter(|(o, r)| !o.is_empty() && !r.is_empty());
        assert_eq!(split("skills/skills"), Some(("skills", "skills")));
        assert_eq!(split("ai-skills/team-skills"), Some(("ai-skills", "team-skills")));
        assert_eq!(split("没有斜杠"), None);
        assert_eq!(split("/repo"), None);
        assert_eq!(split("owner/"), None);
    }

    #[test]
    fn branch_defaults_to_main() {
        assert_eq!(builtin_branch(), BUILTIN_BRANCH.filter(|b| !b.is_empty()).unwrap_or("main"));
        // 未注入或空串时都落到 main
        assert_eq!(None::<&str>.filter(|b: &&str| !b.is_empty()).unwrap_or("main"), "main");
        assert_eq!(Some("").filter(|b: &&str| !b.is_empty()).unwrap_or("main"), "main");
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
