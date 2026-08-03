//! 登录态编排:把 auth 的各个环节串成「登录 / 查状态 / 退出」三件事。
//!
//! 单独一层的原因:auth 只提供不带副作用的原语(生成 PKCE、拼 URL、等回调、换令牌),
//! 谁来打开浏览器、凭证存哪儿、失败了怎么收场属于流程编排,放在这里便于独立测试。

use crate::core::auth::{
    self, Credentials, CredentialStore, LoopbackServer, OAuthConfig, PkcePair,
};
use crate::core::gitea::{GiteaClient, GiteaUser};
use crate::error::AppError;

/// 打开系统浏览器的方式。生产走 tauri-plugin-opener,测试里换成记录调用的假实现。
pub trait BrowserOpener: Send + Sync {
    fn open(&self, url: &str) -> Result<(), AppError>;
}

/// 登录成功后返回给界面的信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUser {
    pub login: String,
    pub display_name: String,
    pub avatar_url: String,
}

impl From<GiteaUser> for SessionUser {
    fn from(u: GiteaUser) -> Self {
        Self {
            // 没填全名就退回登录名,界面上总要有个称呼
            display_name: if u.full_name.trim().is_empty() {
                u.login.clone()
            } else {
                u.full_name.clone()
            },
            login: u.login,
            avatar_url: u.avatar_url,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<SessionUser>,
}

/// 走完一次完整的 OAuth 登录:开监听 → 开浏览器 → 等回调 → 换令牌 → 存凭证 → 取用户信息。
pub async fn login_oauth(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    store: &dyn CredentialStore,
    opener: &dyn BrowserOpener,
    account: &str,
) -> Result<SessionUser, AppError> {
    let server = LoopbackServer::bind()?;
    let redirect_uri = server.redirect_uri();
    let pkce = PkcePair::generate();
    let state = auth::generate_state();

    let url = auth::authorize_url(cfg, &redirect_uri, &state, &pkce.challenge)?;
    opener.open(&url)?;

    // 等回调是阻塞操作,挪到专用阻塞线程池,别占住异步运行时的工作线程
    let wait_state = state.clone();
    let callback = tokio::task::spawn_blocking(move || server.wait_for_callback(&wait_state))
        .await
        .map_err(|e| {
            AppError::new("AUTH_LOOPBACK", "登录流程异常中断,请重试").with_detail(e.to_string())
        })??;

    let creds = auth::exchange_code(http, cfg, &callback.code, &pkce.verifier, &redirect_uri).await?;
    finish_login(http, cfg, store, account, creds).await
}

/// 个人令牌登录(备用通道):校验令牌有效性后存下来。
pub async fn login_with_token(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    store: &dyn CredentialStore,
    account: &str,
    token: &str,
) -> Result<SessionUser, AppError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(AppError::new("AUTH_EMPTY_TOKEN", "请填写登录凭证"));
    }
    let creds = Credentials {
        access_token: token.to_string(),
        refresh_token: String::new(),
        expires_at: 0,
    };
    finish_login(http, cfg, store, account, creds).await
}

/// 校验凭证可用后再落盘。校验不过就不写——避免存进一份用不了的凭证。
async fn finish_login(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    store: &dyn CredentialStore,
    account: &str,
    creds: Credentials,
) -> Result<SessionUser, AppError> {
    let client = GiteaClient::with_http(
        cfg.base_url.clone(),
        Some(creds.access_token.clone()),
        http.clone(),
    );
    let user = client.current_user().await.map_err(|e| {
        if e.code == "AUTH_INVALID" {
            AppError::new("AUTH_INVALID_TOKEN", "登录凭证无效,请检查后重新填写")
                .with_detail(e.detail.unwrap_or(e.message))
        } else {
            e
        }
    })?;
    store.save(account, &creds)?;
    Ok(user.into())
}

/// 查询登录态。必要时静默续期;续期失败视为未登录,由界面引导重新登录。
pub async fn status(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    store: &dyn CredentialStore,
    account: &str,
) -> Result<SessionStatus, AppError> {
    let token = match auth::ensure_access_token(http, cfg, store, account).await {
        Ok(Some(t)) => t,
        Ok(None) => return Ok(SessionStatus { logged_in: false, user: None }),
        // 续期失败不是错误弹窗,而是"没登录"——凭证此时已被清掉
        Err(e) if e.code == "AUTH_REFRESH_FAILED" => {
            return Ok(SessionStatus { logged_in: false, user: None })
        }
        Err(e) => return Err(e),
    };

    let client = GiteaClient::with_http(cfg.base_url.clone(), Some(token), http.clone());
    match client.current_user().await {
        Ok(user) => Ok(SessionStatus {
            logged_in: true,
            user: Some(user.into()),
        }),
        // 令牌被服务端吊销(改密码、管理员撤销)时本地并不知情,按未登录处理并清掉
        Err(e) if e.code == "AUTH_INVALID" => {
            store.delete(account)?;
            Ok(SessionStatus { logged_in: false, user: None })
        }
        Err(e) => Err(e),
    }
}

pub fn logout(store: &dyn CredentialStore, account: &str) -> Result<(), AppError> {
    store.delete(account)
}

// ============================================================ GitHub 源(M3 任务 5)
//
// 与 Gitea 三件事平行的一套:登录(device flow / PAT)、查状态、退出(退出共用
// [`logout`],凭证本来就按 registryId 分开存)。不并进上面的函数——两家取用户
// 信息的端点与响应形状完全不同,硬参数化只会让两边都难读。

use crate::core::github::{self, GithubClient};

impl From<github::GithubUser> for SessionUser {
    fn from(u: github::GithubUser) -> Self {
        let name = u.name.unwrap_or_default();
        Self {
            // 没填全名就退回登录名,界面上总要有个称呼(与 Gitea 同规则)
            display_name: if name.trim().is_empty() {
                u.login.clone()
            } else {
                name
            },
            login: u.login,
            avatar_url: u.avatar_url,
        }
    }
}

/// device flow 的等待段:按 GitHub 给的间隔轮询,直到拿到令牌或明确失败。
/// `slow_down` 按 RFC 8628 把间隔加 5 秒;超过 `expires_in` 报超时。
pub async fn github_login_device(
    http: &reqwest::Client,
    base_url: &str,
    client_id: &str,
    store: &dyn CredentialStore,
    account: &str,
    codes: &github::DeviceCodes,
) -> Result<SessionUser, AppError> {
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(codes.expires_in);
    let mut interval = codes.interval.max(1);
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::new(
                "AUTH_DEVICE_EXPIRED",
                "这次登录等待太久已过期,请重新发起",
            ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        match github::poll_device_token(http, base_url, client_id, &codes.device_code).await? {
            github::DevicePoll::Pending => {}
            github::DevicePoll::SlowDown => interval += 5,
            github::DevicePoll::Token(token) => {
                return github_finish_login(http, base_url, store, account, token).await
            }
        }
    }
}

/// GitHub 的个人令牌登录(备用通道,与 Gitea 的 [`login_with_token`] 同语义)。
pub async fn github_login_token(
    http: &reqwest::Client,
    base_url: &str,
    store: &dyn CredentialStore,
    account: &str,
    token: &str,
) -> Result<SessionUser, AppError> {
    let token = token.trim();
    if token.is_empty() {
        return Err(AppError::new("AUTH_EMPTY_TOKEN", "请填写登录凭证"));
    }
    github_finish_login(http, base_url, store, account, token.to_string()).await
}

/// 校验凭证可用后再落盘;校验不过就不写(与 Gitea 的 finish_login 同规则)。
async fn github_finish_login(
    http: &reqwest::Client,
    base_url: &str,
    store: &dyn CredentialStore,
    account: &str,
    token: String,
) -> Result<SessionUser, AppError> {
    let client = GithubClient::new(base_url, Some(token.clone()), http.clone());
    let user = client.current_user().await.map_err(|e| {
        if e.code == "AUTH_INVALID" {
            AppError::new("AUTH_INVALID_TOKEN", "登录凭证无效,请检查后重新填写")
                .with_detail(e.detail.unwrap_or(e.message))
        } else {
            e
        }
    })?;
    store.save(
        account,
        &Credentials {
            access_token: token,
            refresh_token: String::new(),
            expires_at: 0,
        },
    )?;
    Ok(user.into())
}

/// GitHub 源的登录态。令牌被吊销时清掉凭证按未登录报,与 Gitea 的 [`status`] 同语义。
pub async fn github_status(
    http: &reqwest::Client,
    base_url: &str,
    store: &dyn CredentialStore,
    account: &str,
) -> Result<SessionStatus, AppError> {
    let Some(creds) = store.load(account)? else {
        return Ok(SessionStatus {
            logged_in: false,
            user: None,
        });
    };
    let client = GithubClient::new(base_url, Some(creds.access_token), http.clone());
    match client.current_user().await {
        Ok(user) => Ok(SessionStatus {
            logged_in: true,
            user: Some(user.into()),
        }),
        Err(e) if e.code == "AUTH_INVALID" => {
            store.delete(account)?;
            Ok(SessionStatus {
                logged_in: false,
                user: None,
            })
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::auth::MemoryStore;
    use std::sync::Mutex;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Default)]
    struct RecordingOpener {
        opened: Mutex<Vec<String>>,
    }

    impl BrowserOpener for RecordingOpener {
        fn open(&self, url: &str) -> Result<(), AppError> {
            self.opened.lock().unwrap().push(url.to_string());
            Ok(())
        }
    }

    fn cfg(server: &MockServer) -> OAuthConfig {
        OAuthConfig {
            base_url: server.uri(),
            client_id: "a59f664a-test".into(),
        }
    }

    async fn mock_user(server: &MockServer, login: &str, full_name: &str) {
        Mock::given(method("GET"))
            .and(path("/api/v1/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "login": login,
                "full_name": full_name,
                "avatar_url": "http://gitea/avatars/x"
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn pat_login_validates_then_stores() {
        let server = MockServer::start().await;
        mock_user(&server, "zhaowenhao", "赵文浩").await;
        let store = MemoryStore::default();

        let user = login_with_token(
            &reqwest::Client::new(),
            &cfg(&server),
            &store,
            "company",
            "  the-token  ",
        )
        .await
        .unwrap();

        assert_eq!(user.login, "zhaowenhao");
        assert_eq!(user.display_name, "赵文浩");
        // 令牌两端的空白应被去掉再存
        assert_eq!(store.load("company").unwrap().unwrap().access_token, "the-token");
    }

    #[tokio::test]
    async fn display_name_falls_back_to_login() {
        let server = MockServer::start().await;
        mock_user(&server, "zhaowenhao", "   ").await;
        let store = MemoryStore::default();
        let user = login_with_token(&reqwest::Client::new(), &cfg(&server), &store, "c", "t")
            .await
            .unwrap();
        assert_eq!(user.display_name, "zhaowenhao");
    }

    #[tokio::test]
    async fn invalid_pat_is_not_stored_and_gets_readable_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/user"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "invalid username, password or token"
            })))
            .mount(&server)
            .await;
        let store = MemoryStore::default();

        let err = login_with_token(&reqwest::Client::new(), &cfg(&server), &store, "c", "bad")
            .await
            .unwrap_err();
        assert_eq!(err.code, "AUTH_INVALID_TOKEN");
        assert!(err.message.contains("重新填写"), "{}", err.message);
        // 校验没过就不该留下任何凭证
        assert!(store.load("c").unwrap().is_none());
    }

    #[tokio::test]
    async fn empty_token_is_rejected_before_any_request() {
        let store = MemoryStore::default();
        let cfg = OAuthConfig {
            base_url: "http://unused".into(),
            client_id: "x".into(),
        };
        let err = login_with_token(&reqwest::Client::new(), &cfg, &store, "c", "   ")
            .await
            .unwrap_err();
        assert_eq!(err.code, "AUTH_EMPTY_TOKEN");
    }

    #[tokio::test]
    async fn status_is_logged_out_without_credentials() {
        let server = MockServer::start().await;
        let store = MemoryStore::default();
        let st = status(&reqwest::Client::new(), &cfg(&server), &store, "c")
            .await
            .unwrap();
        assert!(!st.logged_in && st.user.is_none());
    }

    #[tokio::test]
    async fn status_survives_restart() {
        // 存储里已有凭证 = 重启后的场景,应直接恢复登录态
        let server = MockServer::start().await;
        mock_user(&server, "zhaowenhao", "赵文浩").await;
        let store = MemoryStore::default();
        store
            .save(
                "company",
                &Credentials {
                    access_token: "t".into(),
                    refresh_token: "r".into(),
                    expires_at: auth::now_unix() + 3600,
                },
            )
            .unwrap();

        let st = status(&reqwest::Client::new(), &cfg(&server), &store, "company")
            .await
            .unwrap();
        assert!(st.logged_in);
        assert_eq!(st.user.unwrap().login, "zhaowenhao");
    }

    #[tokio::test]
    async fn expired_token_is_refreshed_silently() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "fresh-token",
                "refresh_token": "fresh-refresh",
                "expires_in": 3600
            })))
            .mount(&server)
            .await;
        mock_user(&server, "zhaowenhao", "赵文浩").await;

        let store = MemoryStore::default();
        store
            .save(
                "company",
                &Credentials {
                    access_token: "stale".into(),
                    refresh_token: "r".into(),
                    expires_at: auth::now_unix() - 10, // 已过期
                },
            )
            .unwrap();

        let st = status(&reqwest::Client::new(), &cfg(&server), &store, "company")
            .await
            .unwrap();
        assert!(st.logged_in, "续期应对用户无感");
        // 新令牌要写回存储,否则每次调用都要续期一遍
        let saved = store.load("company").unwrap().unwrap();
        assert_eq!(saved.access_token, "fresh-token");
        assert_eq!(saved.refresh_token, "fresh-refresh");
    }

    #[tokio::test]
    async fn failed_refresh_becomes_logged_out_not_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(400).set_body_string("invalid_grant"))
            .mount(&server)
            .await;

        let store = MemoryStore::default();
        store
            .save(
                "company",
                &Credentials {
                    access_token: "stale".into(),
                    refresh_token: "r".into(),
                    expires_at: auth::now_unix() - 10,
                },
            )
            .unwrap();

        // 续期失败要表现为"没登录"并引导重登,而不是弹一个裸错误
        let st = status(&reqwest::Client::new(), &cfg(&server), &store, "company")
            .await
            .unwrap();
        assert!(!st.logged_in);
        assert!(store.load("company").unwrap().is_none(), "失效凭证应被清掉");
    }

    #[tokio::test]
    async fn revoked_token_is_treated_as_logged_out() {
        // 令牌在服务端被吊销时本地并不知情
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/user"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "message": "invalid username, password or token"
            })))
            .mount(&server)
            .await;

        let store = MemoryStore::default();
        store
            .save(
                "company",
                &Credentials {
                    access_token: "revoked".into(),
                    refresh_token: String::new(),
                    expires_at: 0,
                },
            )
            .unwrap();

        let st = status(&reqwest::Client::new(), &cfg(&server), &store, "company")
            .await
            .unwrap();
        assert!(!st.logged_in);
        assert!(store.load("company").unwrap().is_none());
    }

    #[tokio::test]
    async fn logout_clears_credentials() {
        let store = MemoryStore::default();
        store
            .save(
                "company",
                &Credentials {
                    access_token: "t".into(),
                    refresh_token: String::new(),
                    expires_at: 0,
                },
            )
            .unwrap();
        logout(&store, "company").unwrap();
        assert!(store.load("company").unwrap().is_none());
    }

    #[tokio::test]
    async fn oauth_flow_opens_browser_and_exchanges_code_without_secret() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .and(body_string_contains("code_verifier="))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "refresh_token": "rt", "expires_in": 3600
            })))
            .mount(&server)
            .await;
        mock_user(&server, "zhaowenhao", "赵文浩").await;

        let opener = RecordingOpener::default();
        let store = MemoryStore::default();
        let cfg = cfg(&server);
        let http = reqwest::Client::new();

        // login_oauth 会阻塞等回调,这里并发地扮演"用户在浏览器里完成授权"
        let flow = login_oauth(&http, &cfg, &store, &opener, "company");
        let driver = async {
            // 等 opener 记录下授权 URL
            let url = loop {
                let first = opener.opened.lock().unwrap().first().cloned();
                match first {
                    Some(u) => break u,
                    None => tokio::time::sleep(std::time::Duration::from_millis(10)).await,
                }
            };
            let parsed = url::Url::parse(&url).unwrap();
            let q: std::collections::HashMap<String, String> =
                parsed.query_pairs().into_owned().collect();
            // 公共客户端:必须是 S256,且 URL 里不得出现任何 secret
            assert_eq!(q["code_challenge_method"], "S256");
            assert!(!url.to_lowercase().contains("secret"));

            let redirect = url::Url::parse(&q["redirect_uri"]).unwrap();
            let addr = format!("127.0.0.1:{}", redirect.port().unwrap());
            // 用裸 TCP 回调,绕开测试环境里的代理设置
            use std::io::Write;
            let mut s = std::net::TcpStream::connect(addr).unwrap();
            let req = format!(
                "GET /?code=the-code&state={} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                q["state"]
            );
            s.write_all(req.as_bytes()).unwrap();
        };

        let (user, ()) = tokio::join!(flow, driver);
        let user = user.unwrap();
        assert_eq!(user.login, "zhaowenhao");
        let saved = store.load("company").unwrap().unwrap();
        assert_eq!(saved.access_token, "at");
        assert_eq!(saved.refresh_token, "rt");
    }
}

#[cfg(test)]
mod github_tests {
    use super::*;
    use crate::core::auth::MemoryStore;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn user_json() -> &'static str {
        r#"{"login":"wang","name":"王工","avatar_url":"http://x/a.png"}"#
    }

    fn codes(interval: u64, expires_in: u64) -> github::DeviceCodes {
        github::DeviceCodes {
            device_code: "dev-123".into(),
            user_code: "ABCD-1234".into(),
            verification_uri: "https://github.example/login/device".into(),
            expires_in,
            interval,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn device_flow_wins_through_pending_and_slow_down() {
        let server = MockServer::start().await;
        // 前两轮:等待授权;第三轮:要求放慢;第四轮:发令牌。
        // GitHub 对轮询期错误回 200 + {"error": ...},不是非 2xx——形状按官方文档。
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .and(body_string_contains("device_code=dev-123"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"error":"authorization_pending"}"#),
            )
            .up_to_n_times(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"error":"slow_down"}"#))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"access_token":"gho_tok","token_type":"bearer"}"#),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v3/user"))
            .respond_with(ResponseTemplate::new(200).set_body_string(user_json()))
            .mount(&server)
            .await;

        let store = MemoryStore::default();
        // expires_in 不能用真实的 900:paused 虚拟时钟遇到真实网络 IO 时,
        // 运行时会把时间自动快进到下一个定时器(reqwest 连接池的 90s 空闲定时器),
        // 几轮快进就能跳穿 900 秒,在慢 runner 上偶发误报过期(776f8bf 的 Windows CI)。
        // 放大到快进撞不到的量级,让这个测试只测"轮询序列",过期由下面的用例专测。
        let user = github_login_device(
            &reqwest::Client::new(),
            &server.uri(),
            "client-gh",
            &store,
            "custom-2",
            &codes(1, 100_000_000),
        )
        .await
        .expect("pending → slow_down → token 应最终成功");

        assert_eq!(user.display_name, "王工");
        let saved = store.load("custom-2").unwrap().expect("令牌应入凭证库");
        assert_eq!(saved.access_token, "gho_tok");
        // GitHub OAuth App 令牌默认长期有效:不设过期、无续期令牌
        assert_eq!(saved.expires_at, 0);
        assert!(saved.refresh_token.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn denied_and_expired_become_readable_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"error":"access_denied"}"#),
            )
            .mount(&server)
            .await;
        let store = MemoryStore::default();
        let err = github_login_device(
            &reqwest::Client::new(),
            &server.uri(),
            "client-gh",
            &store,
            "custom-2",
            &codes(1, 900),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AUTH_DEVICE_DENIED");
        assert!(store.load("custom-2").unwrap().is_none(), "拒绝授权不得落任何凭证");

        // expires_in=0:一次都不该去轮询,直接超时(deadline 在首轮 sleep 前就到了)
        let err = github_login_device(
            &reqwest::Client::new(),
            "http://127.0.0.1:1", // 真发请求就会连接失败,报错码会不一样——这正是判别器
            "client-gh",
            &store,
            "custom-2",
            &codes(1, 0),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AUTH_DEVICE_EXPIRED");
    }

    #[tokio::test]
    async fn github_pat_login_validates_before_storing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/user"))
            .respond_with(
                ResponseTemplate::new(401).set_body_string(r#"{"message":"Bad credentials"}"#),
            )
            .mount(&server)
            .await;

        let store = MemoryStore::default();
        let err = github_login_token(
            &reqwest::Client::new(),
            &server.uri(),
            &store,
            "custom-2",
            "ghp_bad",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AUTH_INVALID_TOKEN");
        assert!(store.load("custom-2").unwrap().is_none(), "校验不过的凭证绝不落盘");

        // 空凭证在本地就拦下,不发请求
        let err = github_login_token(&reqwest::Client::new(), &server.uri(), &store, "custom-2", "  ")
            .await
            .unwrap_err();
        assert_eq!(err.code, "AUTH_EMPTY_TOKEN");
    }

    #[tokio::test]
    async fn github_status_clears_revoked_credentials() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/user"))
            .respond_with(
                ResponseTemplate::new(401).set_body_string(r#"{"message":"Bad credentials"}"#),
            )
            .mount(&server)
            .await;

        let store = MemoryStore::default();
        store
            .save(
                "custom-2",
                &Credentials {
                    access_token: "gho_revoked".into(),
                    refresh_token: String::new(),
                    expires_at: 0,
                },
            )
            .unwrap();

        let status = github_status(&reqwest::Client::new(), &server.uri(), &store, "custom-2")
            .await
            .unwrap();
        assert!(!status.logged_in);
        assert!(
            store.load("custom-2").unwrap().is_none(),
            "被吊销的凭证应当场清掉,而不是每次查询都再撞一次 401"
        );

        // 没有凭证:未登录,不发请求(没有 mock 命中断言,靠 wiremock 校验器兜底)
        let status = github_status(&reqwest::Client::new(), &server.uri(), &store, "custom-9")
            .await
            .unwrap();
        assert!(!status.logged_in);
    }
}
