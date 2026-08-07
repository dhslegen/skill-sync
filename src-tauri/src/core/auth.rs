//! 登录:OAuth2 授权码 + PKCE(主通道)与个人令牌(备用),凭证存系统钥匙串。
//!
//! 规格见交接包附录 A。要点:
//! - Gitea 上的应用注册为**公共客户端**,不存在可用的 secret,代码与配置中也不得出现任何 secret;
//!   安全性由 PKCE 保证:每次登录随机生成 `code_verifier`,只把它的 SHA-256 摘要发给授权端点,
//!   换令牌时才出示原文。回调里的 `code` 即使被截获,没有 verifier 也换不到令牌,
//!   而 verifier 自始至终没离开过本机内存。
//! - 回调按 RFC 8252 走 `http://127.0.0.1:{随机端口}`(用 IP 而非 localhost,
//!   后者可能解析到 IPv6 或被 hosts 改写)。
//! - access_token 过期用 refresh_token 静默续期,续期失败才引导重新登录。
//!
//! **诊断日志(2026-08-07 加)**:这条链路横跨"本机监听 / 系统浏览器 / 授权服务器 /
//! 企业网络策略"四方,任一环断掉在界面上都长成同一句"没反应",而此前**整条链路
//! 一行日志都没有**——Windows 首个真机版就撞上登录失败且无从判断断在哪。
//! 现在每个组件边界都有一条 info,关键是 `收到回调连接`:
//! **它出现 = 浏览器的回调确实到达了本机**(此后的失败在解析/换令牌);
//! **它不出现 = 回调根本没回来**(代理把 127.0.0.1 也代理走了、防火墙、
//! 或授权服务器压根没重定向)。
//! ⚠️ 日志**绝不记 code / token / verifier / state 的值**——日志文件会被随手发出来
//! 排障,授权码与令牌一旦进去就等于泄漏。只记长度、参数名集合与匹配与否。

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// 钥匙串里的服务名。同一台机器上多个技能库源各存一份,用 registryId 区分账户。
///
/// ⚠️ **故意与 `tauri.conf.json` 的 `identifier` 不一致,不要"顺手对齐"**。
/// bundle id 在 2026-08-04 改成了 `com.dhslegen.skillsync`(原值以 `.app` 结尾,
/// 与 macOS 应用包扩展名冲突),而这里保持旧值:keyring 是**按 service 名查凭证**的,
/// 改掉它等于让所有已登录用户的凭证突然读不到,得重新登录一次。
/// service 名是纯内部标识,与 bundle id 解耦本就合理。
const KEYRING_SERVICE: &str = "com.skillsync.app";

/// 等待浏览器回调的上限。用户可能要在浏览器里登录、过 SSO,给足时间。
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// 令牌剩余寿命低于此值就提前续期,避免请求发到一半过期。
const REFRESH_SKEW_SECS: i64 = 60;

// ============================================================ PKCE

/// 一对 PKCE 值。`verifier` 是秘密,只在换令牌时发出;`challenge` 可公开。
#[derive(Debug, Clone)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
}

fn base64url_nopad(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    // 熵直接取自操作系统。取不到属于系统级异常,宁可停下也不能退化成弱随机——
    // verifier 与 state 的不可预测性是整个流程的安全前提。
    getrandom::fill(&mut buf).expect("系统随机数不可用");
    base64url_nopad(&buf)
}

impl PkcePair {
    /// 生成一对新的 PKCE 值。verifier 取 32 字节熵,base64url 后 43 个字符,
    /// 正好落在 RFC 7636 要求的 43–128 区间内且全是 unreserved 字符。
    pub fn generate() -> Self {
        let verifier = random_token(32);
        let digest = Sha256::digest(verifier.as_bytes());
        Self {
            challenge: base64url_nopad(&digest),
            verifier,
        }
    }
}

/// 防 CSRF 的 state 值。
pub fn generate_state() -> String {
    random_token(16)
}

// ============================================================ 授权 URL

#[derive(Debug, Clone)]
pub struct OAuthConfig {
    pub base_url: String,
    pub client_id: String,
}

/// 拼授权 URL。参数转义交给 url crate,不手工拼字符串。
pub fn authorize_url(
    cfg: &OAuthConfig,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String, AppError> {
    let base = cfg.base_url.trim_end_matches('/');
    let mut url = url::Url::parse(&format!("{base}/login/oauth/authorize")).map_err(|e| {
        AppError::new("AUTH_BAD_CONFIG", "技能库地址配置有误,请联系管理员")
            .with_detail(e.to_string())
    })?;
    url.query_pairs_mut()
        .append_pair("client_id", &cfg.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url.into())
}

// ============================================================ loopback 回调

/// 浏览器回调带回来的参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Callback {
    pub code: String,
    pub state: String,
}

/// 本机回环监听器。绑定随机端口,`redirect_uri` 据此生成。
pub struct LoopbackServer {
    listener: TcpListener,
    port: u16,
}

impl LoopbackServer {
    pub fn bind() -> Result<Self, AppError> {
        let loopback_err = |e: std::io::Error| {
            AppError::new(
                "AUTH_LOOPBACK",
                "无法在本机开启登录回调端口,请检查防火墙设置",
            )
            .with_detail(e.to_string())
        };
        // 端口给 0 由系统分配;Gitea 对公共客户端的回环地址允许任意端口
        let listener =
            TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).map_err(loopback_err)?;
        let port = listener.local_addr().map_err(loopback_err)?.port();
        tracing::info!(port, "登录回调端口已监听");
        Ok(Self { listener, port })
    }

    /// RFC 8252 要求用 127.0.0.1 而不是 localhost。
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// 等浏览器回调。只处理第一个带参数的请求,处理完即关闭监听。
    pub fn wait_for_callback(self, expected_state: &str) -> Result<Callback, AppError> {
        self.wait_for_callback_with_timeout(expected_state, CALLBACK_TIMEOUT)
    }

    /// `expected_state` 不匹配时拒绝——否则别的网页可以诱导浏览器往这个端口塞一个伪造的 code。
    pub fn wait_for_callback_with_timeout(
        self,
        expected_state: &str,
        timeout: Duration,
    ) -> Result<Callback, AppError> {
        let deadline = std::time::Instant::now() + timeout;
        self.listener.set_nonblocking(true).map_err(|e| {
            AppError::new("AUTH_LOOPBACK", "登录回调异常").with_detail(e.to_string())
        })?;
        tracing::info!(port = self.port, timeout_secs = timeout.as_secs(), "开始等待登录回调");

        loop {
            if std::time::Instant::now() >= deadline {
                // 这条是最有诊断价值的一行:等到超时却一次连接都没收到,说明浏览器的
                // 回调根本没回到本机——去查代理是否把 127.0.0.1 也代理走了
                tracing::warn!(
                    port = self.port,
                    "登录等待超时,期间未收到有效回调(回调没回到本机:检查浏览器代理是否绕过 127.0.0.1)"
                );
                return Err(AppError::new(
                    "AUTH_TIMEOUT",
                    "登录等待超时。请重新点击登录,并在打开的浏览器页面中完成登录",
                ));
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    tracing::info!(port = self.port, "收到回调连接");
                    stream.set_nonblocking(false).ok();
                    match handle_callback_request(stream, expected_state)? {
                        // 浏览器可能先来一个 /favicon.ico 之类的请求,忽略继续等
                        None => continue,
                        Some(cb) => return Ok(cb),
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(AppError::new("AUTH_LOOPBACK", "登录回调异常")
                        .with_detail(e.to_string()))
                }
            }
        }
    }
}

/// 处理一个回调请求。返回 `Ok(None)` 表示这不是要等的回调,继续等下一个。
fn handle_callback_request(
    mut stream: TcpStream,
    expected_state: &str,
) -> Result<Option<Callback>, AppError> {
    let Ok(clone) = stream.try_clone() else {
        return Ok(None);
    };
    let mut request_line = String::new();
    if BufReader::new(clone).read_line(&mut request_line).is_err() || request_line.is_empty() {
        return Ok(None);
    }

    // "GET /?code=…&state=… HTTP/1.1"
    let target = request_line.split_whitespace().nth(1).unwrap_or("/");
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
    // 只记参数**名**:值里有授权码,日志会被随手发出来排障
    let mut names: Vec<&str> = params.keys().map(String::as_str).collect();
    names.sort_unstable();
    tracing::info!(
        path = target.split('?').next().unwrap_or("/"),
        params = names.join(","),
        "回调请求已解析"
    );

    if let Some(error) = params.get("error") {
        respond(
            &mut stream,
            &page("登录未完成", "你在浏览器中取消了登录,可以关闭此页面。"),
        );
        let hint = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| error.clone());
        return Err(
            AppError::new("AUTH_DENIED", "登录未完成。如需继续,请重新点击登录").with_detail(hint),
        );
    }

    let (Some(code), Some(state)) = (params.get("code"), params.get("state")) else {
        respond(&mut stream, &page("SkillSync", "正在等待登录结果…"));
        return Ok(None);
    };

    if state != expected_state {
        tracing::warn!("回调的 state 与本次登录不匹配,已拒绝");
        respond(
            &mut stream,
            &page("登录未完成", "登录校验未通过,请回到应用重新登录。"),
        );
        return Err(
            AppError::new("AUTH_STATE_MISMATCH", "登录校验未通过,请重新登录")
                .with_detail("state 与本次登录不匹配,可能是过期的回调或伪造请求"),
        );
    }

    tracing::info!(code_len = code.len(), "回调校验通过,已取得授权码");
    respond(
        &mut stream,
        &page("登录成功", "已完成登录,可以关闭此页面回到 SkillSync。"),
    );
    Ok(Some(Callback {
        code: code.clone(),
        state: state.clone(),
    }))
}

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
<title>{title}</title><style>body{{font-family:-apple-system,\"PingFang SC\",\
\"Microsoft YaHei UI\",system-ui,sans-serif;background:#f7f6f3;color:#1f1e1c;\
display:grid;place-items:center;height:100vh;margin:0}}\
div{{text-align:center}}h1{{font-size:16px;font-weight:600;margin:0 0 6px}}\
p{{font-size:13px;color:#6f6c66;margin:0}}</style></head>\
<body><div><h1>{title}</h1><p>{body}</p></div></body></html>"
    )
}

fn respond(stream: &mut TcpStream, html: &str) {
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

// ============================================================ 令牌

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Unix 秒。0 表示没有有效期(个人令牌就是这种),不做主动续期。
    #[serde(default)]
    pub expires_at: i64,
}

impl Credentials {
    /// 是否已过期或即将过期。
    pub fn needs_refresh(&self, now: i64) -> bool {
        self.expires_at != 0 && now + REFRESH_SKEW_SECS >= self.expires_at
    }
}

/// Gitea 令牌端点的响应。
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_in: i64,
}

impl TokenResponse {
    fn into_credentials(self, now: i64) -> Credentials {
        Credentials {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            expires_at: if self.expires_in > 0 {
                now + self.expires_in
            } else {
                0
            },
        }
    }
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// 用授权码换令牌。请求体里带 `code_verifier` 而**没有任何 secret**——公共客户端的关键。
pub async fn exchange_code(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Credentials, AppError> {
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", cfg.client_id.as_str()),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ];
    post_token(http, cfg, &form, "AUTH_EXCHANGE_FAILED", "登录未能完成,请重试").await
}

/// 用 refresh_token 静默续期。
pub async fn refresh_credentials(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    refresh_token: &str,
) -> Result<Credentials, AppError> {
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", cfg.client_id.as_str()),
        ("refresh_token", refresh_token),
    ];
    post_token(
        http,
        cfg,
        &form,
        "AUTH_REFRESH_FAILED",
        "登录状态已过期,请重新登录",
    )
    .await
}

async fn post_token(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    form: &[(&str, &str)],
    error_code: &str,
    error_message: &str,
) -> Result<Credentials, AppError> {
    let base = cfg.base_url.trim_end_matches('/');
    let resp = http
        .post(format!("{base}/login/oauth/access_token"))
        .form(form)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                AppError::new(
                    "NET_UNREACHABLE",
                    "连不上公司技能库,请确认已接入公司内网或 VPN",
                )
                .with_detail(e.to_string())
            } else {
                AppError::new("NET_REQUEST", "网络请求失败,请稍后重试").with_detail(e.to_string())
            }
        })?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::new(error_code, error_message).with_detail(format!(
            "HTTP {status}: {}",
            body.chars().take(300).collect::<String>()
        )));
    }
    let parsed: TokenResponse = serde_json::from_str(&body).map_err(|e| {
        AppError::new(error_code, error_message).with_detail(format!("响应无法解析: {e}"))
    })?;
    Ok(parsed.into_credentials(now_unix()))
}

// ============================================================ 凭证存储

/// 凭证存储抽象。生产走系统钥匙串,单测走内存——钥匙串在 CI 与无桌面会话的环境里不可用。
pub trait CredentialStore: Send + Sync {
    fn save(&self, account: &str, creds: &Credentials) -> Result<(), AppError>;
    fn load(&self, account: &str) -> Result<Option<Credentials>, AppError>;
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

/// 单个钥匙串条目允许的 UTF-16 码元数上限。
///
/// **这个数字来自 Windows,不是我们定的**:Windows 凭据管理器的 `CredentialBlob`
/// 硬上限是 `CRED_MAX_CREDENTIAL_BLOB_SIZE = 5*512 = 2560` **字节**,而
/// `windows-native-keyring-store` 写入前会把密码转成 **UTF-16**
/// (`utils.rs`:`blob = vec![0; blob_u16.len() * 2]`,超了返回 `Error::TooLong`)。
/// 于是实际能存的只有 **1280 个 ASCII 字符**。
///
/// 而 Gitea 的一对 JWT 令牌序列化出来约 1778 字符(实测:access 859、refresh 859,
/// 加上 JSON 结构)——**每次登录必然超限**,macOS 钥匙串没有这个限制,
/// 所以只有 Windows 中招。2026-08-07 Windows 首个真机版(v0.3.10)登录失败的根因就是它。
///
/// 取 1200 而不是顶格 1280:留出余量,令牌长度由 Gitea 决定、随配置浮动,
/// 贴着上限写等于把"下次 Gitea 多发几十个字符"变成同一个故障。
const MAX_UTF16_UNITS_PER_CHUNK: usize = 1200;

/// 主条目在**新格式**下存的清单。旧格式主条目直接就是 `Credentials` 的 JSON。
#[derive(Debug, Serialize, Deserialize)]
struct ChunkManifest {
    /// 分片数量;分片存在 `{account}.part{i}`
    chunks: usize,
}

/// 把凭证 JSON 切成若干片,**保证每片编码成 UTF-16 后不超过 Windows 的上限**。
///
/// 按 `char` 边界切并按 `len_utf16()` 累计——不能按字节数切:UTF-8 的字节数与
/// UTF-16 的码元数没有固定比例(ASCII 1:1,中文 3:1,BMP 外 4:2),
/// 按字节估会在非 ASCII 内容上估错方向。
fn split_secret(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut units = 0usize;
    for ch in s.chars() {
        let n = ch.len_utf16();
        if units + n > MAX_UTF16_UNITS_PER_CHUNK && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur));
            units = 0;
        }
        cur.push(ch);
        units += n;
    }
    // 空串也要留一片,否则清单里 chunks=0,读回来拼不出东西
    if !cur.is_empty() || parts.is_empty() {
        parts.push(cur);
    }
    parts
}

/// 主条目内容的两种可能形态。
///
/// **旧格式必须继续读得出来**:v0.3.10 及更早在 macOS 上写进钥匙串的凭证就是
/// 整份 `Credentials` JSON,升级后不该把已登录用户踢下线。
enum StoredForm {
    /// 整份凭证就在主条目里(旧格式)
    Legacy(Box<Credentials>),
    /// 主条目是清单,内容在 `{account}.part{i}`(新格式)
    Chunked(usize),
}

fn parse_primary(raw: &str) -> Option<StoredForm> {
    // 先试旧格式:它有 accessToken 字段,而清单没有,两者不会互相误判
    if let Ok(creds) = serde_json::from_str::<Credentials>(raw) {
        return Some(StoredForm::Legacy(Box::new(creds)));
    }
    serde_json::from_str::<ChunkManifest>(raw)
        .ok()
        .map(|m| StoredForm::Chunked(m.chunks))
}

/// 系统钥匙串(macOS Keychain / Windows 凭据管理器)。凭证不落明文盘。
pub struct KeyringStore;

impl KeyringStore {
    fn entry(account: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| {
            AppError::new("AUTH_KEYRING", "无法访问系统凭据存储,请重试或重新登录")
                .with_detail(e.to_string())
        })
    }

    fn part_key(account: &str, i: usize) -> String {
        format!("{account}.part{i}")
    }

    /// 删掉所有分片。从 0 连续删到第一个不存在的为止——写入是连续的,不会有空洞。
    fn delete_parts(account: &str) {
        for i in 0.. {
            let Ok(entry) = Self::entry(&Self::part_key(account, i)) else {
                return;
            };
            match entry.delete_credential() {
                Ok(()) => continue,
                // 删到头了,或这台机器上根本没有分片
                Err(_) => return,
            }
        }
    }
}

impl CredentialStore for KeyringStore {
    fn save(&self, account: &str, creds: &Credentials) -> Result<(), AppError> {
        let json = serde_json::to_string(creds).map_err(|e| {
            AppError::new("AUTH_KEYRING", "凭据保存失败").with_detail(e.to_string())
        })?;
        let parts = split_secret(&json);
        let save_err = |e: keyring::Error| {
            AppError::new("AUTH_KEYRING", "凭据保存失败,请重新登录").with_detail(e.to_string())
        };

        // 先清旧分片:上一次可能存了更多片,残留会让下次读到拼接错误的内容
        Self::delete_parts(account);
        for (i, part) in parts.iter().enumerate() {
            Self::entry(&Self::part_key(account, i))?
                .set_password(part)
                .map_err(save_err)?;
        }
        // 分片全部写成功后才更新主条目——反过来的话中途失败会留下指向半份内容的清单
        let manifest = serde_json::to_string(&ChunkManifest { chunks: parts.len() })
            .map_err(|e| AppError::new("AUTH_KEYRING", "凭据保存失败").with_detail(e.to_string()))?;
        Self::entry(account)?.set_password(&manifest).map_err(save_err)
    }

    fn load(&self, account: &str) -> Result<Option<Credentials>, AppError> {
        let raw = match Self::entry(account)?.get_password() {
            Ok(raw) => raw,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => {
                return Err(AppError::new("AUTH_KEYRING", "无法读取已保存的登录信息")
                    .with_detail(e.to_string()))
            }
        };
        match parse_primary(&raw) {
            Some(StoredForm::Legacy(creds)) => Ok(Some(*creds)),
            Some(StoredForm::Chunked(n)) => {
                let mut joined = String::new();
                for i in 0..n {
                    match Self::entry(&Self::part_key(account, i))?.get_password() {
                        Ok(part) => joined.push_str(&part),
                        // 分片缺失 = 这份凭证不完整,当作未登录重新走一次登录,不报错吓人
                        Err(_) => return Ok(None),
                    }
                }
                Ok(serde_json::from_str(&joined).ok())
            }
            None => Ok(None),
        }
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        Self::delete_parts(account);
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::new("AUTH_KEYRING", "退出登录时清理凭据失败")
                .with_detail(e.to_string())),
        }
    }
}

/// 仅用于测试的内存存储。
#[derive(Default)]
pub struct MemoryStore {
    inner: std::sync::Mutex<std::collections::HashMap<String, Credentials>>,
}

impl CredentialStore for MemoryStore {
    fn save(&self, account: &str, creds: &Credentials) -> Result<(), AppError> {
        self.inner
            .lock()
            .unwrap()
            .insert(account.to_string(), creds.clone());
        Ok(())
    }

    fn load(&self, account: &str) -> Result<Option<Credentials>, AppError> {
        Ok(self.inner.lock().unwrap().get(account).cloned())
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        self.inner.lock().unwrap().remove(account);
        Ok(())
    }
}

/// 取一个可用的 access_token:必要时静默续期并回写存储。
///
/// 续期失败会清掉本地凭证并返回 `AUTH_REFRESH_FAILED`,由界面引导重新登录,
/// 而不是把 401 原文抛给用户;留着一份已失效的凭证只会让之后每次请求都先失败一次。
pub async fn ensure_access_token(
    http: &reqwest::Client,
    cfg: &OAuthConfig,
    store: &dyn CredentialStore,
    account: &str,
) -> Result<Option<String>, AppError> {
    let Some(creds) = store.load(account)? else {
        return Ok(None);
    };
    if !creds.needs_refresh(now_unix()) {
        return Ok(Some(creds.access_token));
    }
    if creds.refresh_token.is_empty() {
        store.delete(account)?;
        return Err(AppError::new(
            "AUTH_REFRESH_FAILED",
            "登录状态已过期,请重新登录",
        ));
    }
    match refresh_credentials(http, cfg, &creds.refresh_token).await {
        Ok(fresh) => {
            store.save(account, &fresh)?;
            Ok(Some(fresh.access_token))
        }
        Err(e) => {
            store.delete(account)?;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- PKCE ----

    #[test]
    fn verifier_length_and_charset_follow_rfc7636() {
        let p = PkcePair::generate();
        assert!(
            (43..=128).contains(&p.verifier.len()),
            "长度 {} 超出 RFC 7636 的 43–128",
            p.verifier.len()
        );
        // unreserved 字符集:A-Z a-z 0-9 - . _ ~
        assert!(p
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~')));
    }

    #[test]
    fn each_login_gets_fresh_secrets() {
        let (a, b) = (PkcePair::generate(), PkcePair::generate());
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, b.challenge);
        assert_ne!(generate_state(), generate_state());
    }

    #[test]
    fn challenge_is_unpadded_base64url_of_sha256() {
        // RFC 7636 附录 B 的官方测试向量
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            base64url_nopad(&Sha256::digest(verifier.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        // 自己生成的那对也必须自洽且不带 padding
        let p = PkcePair::generate();
        assert_eq!(
            p.challenge,
            base64url_nopad(&Sha256::digest(p.verifier.as_bytes()))
        );
        assert!(!p.challenge.contains('='));
    }

    // ---- 授权 URL ----

    #[test]
    fn authorize_url_carries_all_required_params() {
        let cfg = OAuthConfig {
            base_url: "http://gitea.internal:3000/".into(),
            client_id: "client-abc".into(),
        };
        let url = authorize_url(&cfg, "http://127.0.0.1:54321", "st4te", "ch4llenge").unwrap();
        let parsed = url::Url::parse(&url).unwrap();
        assert_eq!(parsed.path(), "/login/oauth/authorize");

        let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "client-abc");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:54321");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["state"], "st4te");
        assert_eq!(q["code_challenge"], "ch4llenge");
        assert_eq!(q["code_challenge_method"], "S256");
        // 公共客户端:任何形式的 secret 都不得出现
        assert!(!url.to_lowercase().contains("secret"));
    }

    #[test]
    fn authorize_url_escapes_parameters() {
        let cfg = OAuthConfig {
            base_url: "http://gitea.internal:3000".into(),
            client_id: "a b&c".into(),
        };
        let url = authorize_url(&cfg, "http://127.0.0.1:1/cb", "s+t", "c/h").unwrap();
        assert!(!url.contains("a b&c"), "参数未转义: {url}");
        let q: std::collections::HashMap<_, _> = url::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(q["client_id"], "a b&c");
        assert_eq!(q["state"], "s+t");
    }

    // ---- 钥匙串分片(Windows 凭据管理器的 2560 字节上限)----

    /// Windows 的硬上限,与 `CRED_MAX_CREDENTIAL_BLOB_SIZE` 一致。
    /// 测试里独立写一遍常量:与实现共用的话,把实现改坏成 10000 时测试会跟着放宽,
    /// 那道守卫就是空转的(空转测试模式 #1)。
    const WINDOWS_BLOB_LIMIT_BYTES: usize = 2560;

    fn utf16_bytes(s: &str) -> usize {
        s.encode_utf16().count() * 2
    }

    /// 核心守卫:**任何**输入切出来的每一片,UTF-16 编码后都不得超过 Windows 上限。
    /// 这一条红了就意味着 Windows 上登录会再次失败。
    #[test]
    fn every_chunk_fits_windows_credential_blob_limit() {
        let cases = [
            String::new(),
            "short".to_string(),
            // 真实量级:Gitea 一对 JWT 序列化后约 1778 字符(实测 access 859 + refresh 859)
            "a".repeat(1778),
            "b".repeat(10_000),
            // 非 ASCII:UTF-8 字节数与 UTF-16 码元数不成比例,按字节估会估错方向
            "中".repeat(3000),
            // BMP 外字符每个占 2 个 UTF-16 码元,最容易把分片顶爆
            "😀".repeat(2000),
        ];
        for case in &cases {
            for (i, part) in split_secret(case).iter().enumerate() {
                assert!(
                    utf16_bytes(part) <= WINDOWS_BLOB_LIMIT_BYTES,
                    "第 {i} 片 {} 字节,超过 Windows 上限 {WINDOWS_BLOB_LIMIT_BYTES}——Windows 上会存不进钥匙串",
                    utf16_bytes(part)
                );
            }
        }
    }

    /// 切了还要能拼回来,且**一个字符都不能丢**(包括切在 emoji 上时)。
    #[test]
    fn split_then_join_round_trips_exactly() {
        for case in [
            String::new(),
            "short".to_string(),
            "a".repeat(1778),
            "中".repeat(3000),
            "😀".repeat(2000),
            format!("{}{}", "x".repeat(1199), "😀"),
        ] {
            let joined: String = split_secret(&case).concat();
            assert_eq!(joined, case, "分片拼接后与原文不一致");
        }
    }

    /// 真实量级的凭证必须被切开——不切就是没修好。
    #[test]
    fn realistic_credentials_are_actually_split() {
        let creds = Credentials {
            access_token: "a".repeat(859),
            refresh_token: "r".repeat(859),
            expires_at: 1_786_095_579,
        };
        let json = serde_json::to_string(&creds).unwrap();
        assert!(
            utf16_bytes(&json) > WINDOWS_BLOB_LIMIT_BYTES,
            "前提失效:这份凭证本来就没超限,这个测试就白测了(实测应为 {} 字节)",
            utf16_bytes(&json)
        );
        assert!(
            split_secret(&json).len() > 1,
            "超限的凭证必须被切成多片,否则 Windows 上原样存不进去"
        );
    }

    /// 旧格式(整份 Credentials 在主条目里)必须继续读得出来:
    /// v0.3.10 及更早在 macOS 上登录的用户,升级后不该被踢下线。
    #[test]
    fn legacy_single_entry_format_is_still_readable() {
        let creds = Credentials {
            access_token: "tok".into(),
            refresh_token: "ref".into(),
            expires_at: 42,
        };
        let raw = serde_json::to_string(&creds).unwrap();
        match parse_primary(&raw) {
            Some(StoredForm::Legacy(got)) => assert_eq!(*got, creds),
            _ => panic!("旧格式没被认出来——升级会让已登录用户全部掉线"),
        }
    }

    /// 新格式的清单不能被误判成旧凭证,反之亦然。
    #[test]
    fn manifest_and_legacy_forms_are_not_confused() {
        let manifest = serde_json::to_string(&ChunkManifest { chunks: 3 }).unwrap();
        match parse_primary(&manifest) {
            Some(StoredForm::Chunked(3)) => {}
            _ => panic!("清单没被认出来"),
        }
        assert!(parse_primary("not json at all").is_none());
    }

    // ---- loopback ----

    /// 起一个监听器,在后台线程里发一个请求,返回等待结果。
    fn run_callback(query: &str, expected_state: &str) -> Result<Callback, AppError> {
        let server = LoopbackServer::bind().unwrap();
        let uri = server.redirect_uri();
        assert!(uri.starts_with("http://127.0.0.1:"), "须用 IP 而非 localhost");
        let target = format!("{uri}/{query}");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            // 直接用 TCP 发一个最小 GET,避开测试环境里的代理设置
            if let Ok(parsed) = url::Url::parse(&target) {
                let addr = format!("127.0.0.1:{}", parsed.port().unwrap_or(80));
                if let Ok(mut s) = std::net::TcpStream::connect(addr) {
                    let path = format!(
                        "{}{}",
                        parsed.path(),
                        parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
                    );
                    let _ = s.write_all(
                        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                            .as_bytes(),
                    );
                }
            }
        });
        server.wait_for_callback_with_timeout(expected_state, Duration::from_secs(5))
    }

    #[test]
    fn accepts_matching_callback() {
        let got = run_callback("?code=the-code&state=st4te", "st4te").unwrap();
        assert_eq!(
            got,
            Callback {
                code: "the-code".into(),
                state: "st4te".into()
            }
        );
    }

    #[test]
    fn rejects_state_mismatch() {
        // 别的网页诱导浏览器往这个端口塞一个伪造 code 时必须被挡下
        let err = run_callback("?code=c&state=forged", "st4te").unwrap_err();
        assert_eq!(err.code, "AUTH_STATE_MISMATCH");
    }

    #[test]
    fn reports_user_denial() {
        let err =
            run_callback("?error=access_denied&error_description=User+denied", "st").unwrap_err();
        assert_eq!(err.code, "AUTH_DENIED");
        assert!(err.message.contains("重新点击登录"), "{}", err.message);
    }

    #[test]
    fn times_out_without_callback() {
        let server = LoopbackServer::bind().unwrap();
        let err = server
            .wait_for_callback_with_timeout("st", Duration::from_millis(300))
            .unwrap_err();
        assert_eq!(err.code, "AUTH_TIMEOUT");
        assert!(err.message.contains("重新点击登录"), "{}", err.message);
    }

    #[test]
    fn each_server_gets_its_own_port() {
        let (a, b) = (LoopbackServer::bind().unwrap(), LoopbackServer::bind().unwrap());
        assert_ne!(a.port(), b.port());
        assert!(a.port() > 0);
    }

    // ---- 令牌与续期 ----

    #[test]
    fn expiry_is_computed_from_expires_in() {
        let creds = TokenResponse {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_in: 3600,
        }
        .into_credentials(1_000_000);
        assert_eq!(creds.expires_at, 1_003_600);
        assert!(!creds.needs_refresh(1_000_000));
        // 到期前 60 秒内就该提前续期,避免请求发到一半失效
        assert!(creds.needs_refresh(1_003_560));
        assert!(creds.needs_refresh(1_003_600));
    }

    #[test]
    fn tokens_without_expiry_never_auto_refresh() {
        // 个人令牌没有有效期,不应被误判为过期
        let creds = TokenResponse {
            access_token: "pat".into(),
            refresh_token: String::new(),
            expires_in: 0,
        }
        .into_credentials(1_000_000);
        assert_eq!(creds.expires_at, 0);
        assert!(!creds.needs_refresh(9_999_999_999));
    }

    #[test]
    fn memory_store_round_trips_and_deletes() {
        let store = MemoryStore::default();
        assert!(store.load("company").unwrap().is_none());

        let creds = Credentials {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 42,
        };
        store.save("company", &creds).unwrap();
        assert_eq!(store.load("company").unwrap().unwrap(), creds);

        store.delete("company").unwrap();
        assert!(store.load("company").unwrap().is_none());
        // 重复删除不报错
        store.delete("company").unwrap();
    }

    #[test]
    fn credentials_serialize_to_camel_case() {
        let json = serde_json::to_value(Credentials {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 1,
        })
        .unwrap();
        assert_eq!(json["accessToken"], "a");
        assert_eq!(json["expiresAt"], 1);
    }
}
