//! 系统钥匙串的实机读写。
//!
//! 默认不跑:CI 与无桌面会话的环境里钥匙串不可用,且真跑会在开发者的钥匙串里留条目。
//! 手动执行:`cargo test --test auth_keyring -- --ignored --nocapture`
//!
//! 这条测试的意义在于:keyring 漏配平台后端时会**静默**退化成进程内存储——
//! 单测用的是 MemoryStore,永远发现不了;只有真写一次钥匙串才能确认凭证真的落了盘。

use skillsync_lib::core::auth::{CredentialStore, Credentials, KeyringStore};

#[test]
#[ignore]
fn credentials_survive_in_system_keyring() {
    let store = KeyringStore;
    let account = "skillsync-test-account";

    // 先清干净,避免上次残留影响判断
    store.delete(account).unwrap();
    assert!(store.load(account).unwrap().is_none(), "起始应为空");

    let creds = Credentials {
        access_token: "test-access-token".into(),
        refresh_token: "test-refresh-token".into(),
        expires_at: 1_800_000_000,
    };
    store.save(account, &creds).unwrap();

    // 换一个 store 实例读,确保读到的是钥匙串里的东西而不是实例内的缓存
    let reloaded = KeyringStore.load(account).unwrap().expect("应能读回");
    assert_eq!(reloaded, creds);
    println!("✓ 凭证已写入系统钥匙串并读回");

    store.delete(account).unwrap();
    assert!(store.load(account).unwrap().is_none(), "退出登录应清干净");
    println!("✓ 清理完成");
}
