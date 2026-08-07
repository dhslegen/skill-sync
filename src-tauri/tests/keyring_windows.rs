//! Windows 凭据管理器的**真机**往返测试(M8,2026-08-07)。
//!
//! 为什么非要有这一条:v0.3.10 是首个 Windows 包,装上后**登录必然失败**,
//! 而当时 Rust 470 + 前端 408 全绿、clippy 干净、双平台 CI 也绿——
//! 因为所有测试要么是纯逻辑,要么走 `MemoryStore`,**没有一条碰过真实的
//! Windows 凭据管理器**。根因是 `CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560` 字节,
//! 而 `windows-native-keyring-store` 写入前把密码转成 UTF-16(字节数翻倍),
//! 于是实际上限只有 1280 个 ASCII 字符;Gitea 的一对 JWT 约 1778 字符,
//! 每次都超。macOS 钥匙串没有这个限制,所以本机怎么跑都是绿的。
//!
//! 这条测试**在修复前必然变红**(1778 字符原样 `set_password` 会得到
//! `Error::TooLong`),是这个缺陷唯一的平台级护栏。它只在 Windows 上编译,
//! 由 CI 的 windows job 执行。
//!
//! ⚠️ 用**测试专用的 account 名**,绝不碰真实登录凭证(`company` 等)。
#![cfg(windows)]

use skillsync_lib::core::auth::{CredentialStore, Credentials, KeyringStore};

/// 与真实 Gitea 令牌同量级:实测 access 859 + refresh 859 + JSON 结构 ≈ 1778 字符。
fn realistic_credentials() -> Credentials {
    Credentials {
        access_token: "a".repeat(859),
        refresh_token: "r".repeat(859),
        expires_at: 1_786_095_579,
    }
}

/// 真实量级的凭证必须能在 Windows 凭据管理器上存进去、原样读回来、干净删掉。
#[test]
fn realistic_credentials_round_trip_through_windows_credential_manager() {
    let store = KeyringStore;
    let account = "skillsync-test-roundtrip";

    // 先清场:上一轮跑挂了可能留下残片
    store.delete(account).ok();

    let creds = realistic_credentials();
    store
        .save(account, &creds)
        .expect("真实量级的凭证存不进 Windows 凭据管理器——分片没生效,登录会失败");

    let got = store
        .load(account)
        .expect("读取凭证失败")
        .expect("刚存进去的凭证读不回来");
    assert_eq!(got.access_token, creds.access_token, "access_token 读回来不一致");
    assert_eq!(got.refresh_token, creds.refresh_token, "refresh_token 读回来不一致");
    assert_eq!(got.expires_at, creds.expires_at, "expires_at 读回来不一致");

    store.delete(account).expect("删除凭证失败");
    assert!(
        store.load(account).expect("删除后读取不该报错").is_none(),
        "删除后还能读到凭证——分片没被清干净,残留会让下次登录读到半份内容"
    );
}

/// 换一份更短的凭证覆盖写:分片数会从多片变一片,旧分片必须被清掉。
///
/// 不清的话,主条目清单说 1 片、磁盘上还留着 part1,虽然读取按清单来不会出错,
/// 但用户的令牌碎片会**长期留在系统凭据管理器里**——这是凭证泄漏面。
#[test]
fn shrinking_credentials_leaves_no_orphan_parts() {
    let store = KeyringStore;
    let account = "skillsync-test-shrink";
    store.delete(account).ok();

    store.save(account, &realistic_credentials()).expect("存长凭证失败");
    let short = Credentials {
        access_token: "short".into(),
        refresh_token: "s".into(),
        expires_at: 1,
    };
    store.save(account, &short).expect("覆盖存短凭证失败");

    let got = store.load(account).expect("读取失败").expect("读不到凭证");
    assert_eq!(got.access_token, "short", "覆盖后读到的仍是旧内容");

    // 旧的 part1 必须已经不在了:直接按分片键探一次
    let orphan = keyring::Entry::new("com.skillsync.app", &format!("{account}.part1"))
        .expect("构造分片条目失败")
        .get_password();
    assert!(
        orphan.is_err(),
        "覆盖写之后旧分片 part1 还在——用户的旧令牌碎片留在了系统凭据管理器里"
    );

    store.delete(account).expect("清理失败");
}
