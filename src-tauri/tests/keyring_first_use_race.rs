//! 系统钥匙串**首次使用**时的并发竞态(0.6.2 发版前,Windows CI 连续偶发红)。
//!
//! keyring 4.1.5 的 `v1::Entry::new` 先用原子 CAS 把"已初始化"标志置真,**之后**才去
//! 构造平台存储并 `set_default_store`。两个线程同时第一次调用时,后到的那个看到标志已真、
//! 跳过初始化,直接 `keyring_core::Entry::new`——默认存储还没设好,拿到 `NoDefaultStore`。
//! 我们的写入闭包把 `entry()` 失败折成 `NoEntry`,于是报出一句驴唇不对马嘴的
//! 「No matching credential found」(`keyring_windows.rs` 两条测试轮流红的真因)。
//!
//! 应用里同样可达:启动时并行查几个技能源的登录态,首次打开钥匙串就是并发的。
//!
//! **必须是独立的测试二进制**:竞态只发生在**进程内第一次**使用钥匙串时,与别的测试
//! 同一个二进制就可能被它们先初始化掉,这条测试便空转。只做读取、账户名测试专用且不存在,
//! 不写入任何条目(macOS 上读不存在的条目不会弹授权框)。
use std::sync::{Arc, Barrier};

use skillsync_lib::core::auth::{CredentialStore, KeyringStore};

#[test]
fn concurrent_first_use_of_the_keychain_never_fails_to_open_the_store() {
    const THREADS: usize = 32;
    let barrier = Arc::new(Barrier::new(THREADS));
    let handles: Vec<_> = (0..THREADS)
        .map(|i| {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                KeyringStore.load(&format!("skillsync-test-first-use-race-{i}"))
            })
        })
        .collect();
    for (i, h) in handles.into_iter().enumerate() {
        let got = h.join().expect("线程 panic");
        assert!(
            matches!(got, Ok(None)),
            "第 {i} 个线程首次打开钥匙串失败:{got:?}(keyring 初始化竞态)"
        );
    }
}
