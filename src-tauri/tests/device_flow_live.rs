//! 对**真实 GitHub** 跑一次 device flow 全流程(M3 任务 5a 的真实联调,
//! 之前欠外部条件:GitHub OAuth App 的 Client ID,2026-08-03 用户已注册交付)。
//!
//! 需要人在浏览器里点授权,**默认跳过**,手动跑:
//! ```
//! SKILLSYNC_GITHUB_LIVE=1 SKILLSYNC_GITHUB_CLIENT_ID=Ov23li… \
//!   cargo test --test device_flow_live -- --nocapture
//! ```
//! 跑起来后 stderr 会打出 用户码 与 验证地址,在浏览器完成授权后测试自动继续:
//! 轮询换到令牌 → 调 current_user 验证身份。令牌只留在进程内存,不入钥匙串
//! 不落盘;输出里只打印令牌长度,不打印内容(与 app 的"token 不落日志"同一条纪律)。

use skillsync_lib::core::github::{self, DevicePoll};

#[tokio::test]
async fn device_flow_against_real_github() {
    if std::env::var("SKILLSYNC_GITHUB_LIVE").as_deref() != Ok("1") {
        eprintln!("跳过:设 SKILLSYNC_GITHUB_LIVE=1 才对真实 GitHub 跑");
        return;
    }
    let Ok(client_id) = std::env::var("SKILLSYNC_GITHUB_CLIENT_ID") else {
        eprintln!("跳过:未设 SKILLSYNC_GITHUB_CLIENT_ID(OAuth App 的 Client ID)");
        return;
    };

    let http = reqwest::Client::new();
    let codes = github::start_device_flow(&http, "https://github.com", &client_id)
        .await
        .expect("发起 device flow 失败");

    eprintln!("==================================================");
    eprintln!("请在浏览器打开:{}", codes.verification_uri);
    eprintln!("输入用户码:{}", codes.user_code);
    eprintln!("(等待授权,最长 {} 秒)", codes.expires_in);
    eprintln!("==================================================");

    let mut interval = codes.interval.max(1);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(codes.expires_in);
    let token = loop {
        assert!(std::time::Instant::now() < deadline, "等待授权超时");
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        match github::poll_device_token(&http, "https://github.com", &client_id, &codes.device_code)
            .await
            .expect("轮询失败")
        {
            DevicePoll::Pending => continue,
            DevicePoll::SlowDown => {
                interval += 5; // RFC 8628 §3.5
                continue;
            }
            DevicePoll::Token(t) => break t,
        }
    };

    assert!(!token.is_empty());
    eprintln!("已换到令牌(长度 {},内容不打印)", token.len());

    let gh = github::GithubClient::new("https://github.com", Some(token.clone()), http.clone());
    let user = gh.current_user().await.expect("current_user 失败");
    assert!(!user.login.is_empty());
    eprintln!("身份确认:{}(显示名 {:?})", user.login, user.name);
}
