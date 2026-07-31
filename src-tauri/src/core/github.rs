//! GitHub client(M3 任务 4:读链路——branch head 比对 + zipball 下载)。
//!
//! # Ground truth(2026-07-31 对真实 GitHub 录制,纪律 1)
//!
//! 对 `junegunn/fzf@master` 实测(裁剪产物在 `tests/fixtures/github-zipball-modes.zip`,
//! 保留了原始 central directory 的 external_attr):
//! - `GET /repos/{o}/{r}/zipball/{branch}` 302 → codeload 的 `legacy.zip`,reqwest 自动跟随;
//! - 压缩包顶层前缀是 **`{owner}-{repo}-{短sha}/`**(`junegunn-fzf-e365764/`)——
//!   gitea.rs 老注释猜的 `<repo>-<ref>/` 是错的,以录制为准;解析不写死前缀,
//!   [`gitea::unzip_archive`] 本来就取第一段,直接复用;
//! - mode 语义与 Gitea archive 完全一致:可执行文件 `0o100755`,**其余一律 0(没记录)**,
//!   既有"带 `0o111` 任一位才算可执行"的判定与 `& 0o777` 掩码原样适用。
//!
//! # 与 Gitea client 的关系
//!
//! 读链路走同一个 [`RepoSource`] trait,店面(store/acquire/scheduler)对来源无感。
//! 错误映射 GitHub 有两处自己的形态:限流(403/429 + `x-ratelimit-remaining: 0`)
//! 要给"稍后再试"的人话;连不上的下一步动作是"检查网络或代理",不是内建源的
//! "接入内网或 VPN"。
//!
//! # 假设(文档未覆盖,显式标注)
//! - api base:`github.com` → `https://api.github.com`;其他主机按 GitHub Enterprise
//!   的官方约定 `{base}/api/v3`——**未对真实 GHE 实测**,有真实需求时再校正。
//! - 任务 4 一律匿名读(公共库);凭证(device flow)与私有库归任务 5。

use serde::Deserialize;

use crate::core::gitea::{self, BranchHead, RepoArchive, RepoRef, RepoSource};
use crate::error::AppError;

/// 从源的 base_url 推导 API 地址。
pub fn api_base_for(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let host = url::Url::parse(trimmed)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned));
    if host.as_deref() == Some("github.com") {
        "https://api.github.com".to_string()
    } else {
        format!("{trimmed}/api/v3")
    }
}

#[derive(Debug, Clone)]
pub struct GithubClient {
    api_base: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl GithubClient {
    pub fn new(base_url: &str, token: Option<String>, http: reqwest::Client) -> Self {
        Self {
            api_base: api_base_for(base_url),
            token,
            http,
        }
    }

    pub async fn branch_head(&self, r: &RepoRef) -> Result<BranchHead, AppError> {
        // 形状录制自真实响应:sha 在 commit.sha,提交时间在 commit.commit.committer.date
        #[derive(Deserialize)]
        struct Branch {
            commit: TopCommit,
        }
        #[derive(Deserialize)]
        struct TopCommit {
            sha: String,
            commit: InnerCommit,
        }
        #[derive(Deserialize)]
        struct InnerCommit {
            committer: Committer,
        }
        #[derive(Deserialize)]
        struct Committer {
            date: String,
        }

        let url = format!(
            "{}/repos/{}/{}/branches/{}",
            self.api_base, r.owner, r.repo, r.branch
        );
        let resp = self.send(url).await?;
        let branch: Branch = parse_json(resp).await?;
        Ok(BranchHead {
            sha: branch.commit.sha,
            committed_at: branch.commit.commit.committer.date,
        })
    }

    pub async fn download_archive(&self, r: &RepoRef) -> Result<RepoArchive, AppError> {
        // 302 → codeload 的 legacy.zip,reqwest 自动跟随(实测见模块头)
        let url = format!(
            "{}/repos/{}/{}/zipball/{}",
            self.api_base, r.owner, r.repo, r.branch
        );
        let resp = self.send(url).await?;
        let bytes = resp.bytes().await.map_err(|e| {
            AppError::new("NET_DOWNLOAD", "技能库下载中断,请重试").with_detail(e.to_string())
        })?;
        gitea::unzip_archive(&bytes)
    }

    async fn send(&self, url: String) -> Result<reqwest::Response, AppError> {
        let mut req = self
            .http
            .get(url)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.map_err(|e| {
            if gitea::is_unreachable(&e) {
                // 外部源的下一步动作与内建源相反:不是"接入内网",而是检查外网/代理
                AppError::new("NET_UNREACHABLE", "连不上 GitHub,请检查网络或代理设置")
                    .with_detail(e.to_string())
            } else {
                AppError::new("NET_REQUEST", "网络请求失败,请稍后重试").with_detail(e.to_string())
            }
        })?;
        check_status(resp).await
    }
}

/// 把 GitHub 的 HTTP 状态映射成人话。限流是 GitHub 独有的形态:
/// 403/429 且 `x-ratelimit-remaining: 0`——还有余量的 403 是权限问题,不能错报成限流。
async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, AppError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let exhausted = resp
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == "0");
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<GithubError>(&body)
        .map(|e| e.message)
        .unwrap_or_default();

    let err = match status.as_u16() {
        401 => AppError::new("AUTH_INVALID", "登录已失效,请重新登录"),
        403 | 429 if exhausted => AppError::new(
            "NET_RATE_LIMITED",
            "GitHub 接口的调用次数暂时用完了,请稍后再试",
        ),
        403 => AppError::new("REPO_FORBIDDEN", "你没有该技能库的操作权限"),
        404 => AppError::new("REPO_NOT_FOUND", "找不到对应的技能库或文件"),
        s if s >= 500 => AppError::new("NET_SERVER", "技能库服务暂时不可用,请稍后重试"),
        _ => AppError::new("NET_REQUEST", "请求未能完成,请稍后重试"),
    };
    Err(err.with_detail(format!("HTTP {status}: {detail}")))
}

#[derive(Debug, Default, Deserialize)]
struct GithubError {
    #[serde(default)]
    message: String,
}

async fn parse_json<T: serde::de::DeserializeOwned>(resp: reqwest::Response) -> Result<T, AppError> {
    let body = resp.text().await.map_err(|e| {
        AppError::new("NET_REQUEST", "读取响应失败,请稍后重试").with_detail(e.to_string())
    })?;
    serde_json::from_str(&body).map_err(|e| {
        AppError::new("NET_BAD_RESPONSE", "技能库返回了无法识别的内容").with_detail(format!(
            "{e}; body={}",
            body.chars().take(400).collect::<String>()
        ))
    })
}

/// GitHub 的用户信息(`GET /user`)。
#[derive(Debug, Clone, Deserialize)]
pub struct GithubUser {
    pub login: String,
    /// 全名可以没填(GitHub 返回 null)。
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: String,
}

impl GithubClient {
    /// 当前凭证对应的用户。用于登录校验与状态查询。
    pub async fn current_user(&self) -> Result<GithubUser, AppError> {
        let resp = self.send(format!("{}/user", self.api_base)).await?;
        parse_json(resp).await
    }
}

// ============================================================ device flow(M3 任务 5)
//
// RFC 8628 + GitHub 的具体端点(挂在 base_url,不是 api base):
//   POST {base}/login/device/code            → 设备码 + 用户码
//   POST {base}/login/oauth/access_token     → 轮询换令牌
// 公共客户端无 secret;GitHub OAuth App 的令牌默认长期有效(refresh 为空、
// expires_at=0),`ensure_access_token` 对这类凭证永不触发续期端点。
// 假设:scope 取 `repo`——私有库读取与(任务 5b)分享回推都需要它,
// 一次授权覆盖全部用途,避免功能逐个再弹授权。

/// `login/device/code` 的响应。字段名对齐 GitHub(snake_case),
/// 前端展示走 commands 层的 camelCase DTO,不共用这个类型。
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCodes {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// 发起 device flow:拿用户码与轮询参数。
pub async fn start_device_flow(
    http: &reqwest::Client,
    base_url: &str,
    client_id: &str,
) -> Result<DeviceCodes, AppError> {
    let url = format!("{}/login/device/code", base_url.trim_end_matches('/'));
    let resp = http
        .post(url)
        .header("accept", "application/json")
        .form(&[("client_id", client_id), ("scope", "repo")])
        .send()
        .await
        .map_err(|e| {
            AppError::new("NET_UNREACHABLE", "连不上 GitHub,请检查网络或代理设置")
                .with_detail(e.to_string())
        })?;
    let resp = check_status(resp).await?;
    parse_json(resp).await
}

/// 一次轮询的结果。
#[derive(Debug)]
pub enum DevicePoll {
    /// 用户还没在浏览器里完成授权,按原间隔继续。
    Pending,
    /// GitHub 要求放慢(间隔 +5 秒,RFC 8628 §3.5)。
    SlowDown,
    /// 拿到令牌。
    Token(String),
}

/// 轮询一次令牌端点。`access_denied`/`expired_token` 直接成为人话错误。
pub async fn poll_device_token(
    http: &reqwest::Client,
    base_url: &str,
    client_id: &str,
    device_code: &str,
) -> Result<DevicePoll, AppError> {
    #[derive(Deserialize)]
    struct Poll {
        #[serde(default)]
        access_token: Option<String>,
        #[serde(default)]
        error: Option<String>,
    }

    let url = format!("{}/login/oauth/access_token", base_url.trim_end_matches('/'));
    let resp = http
        .post(url)
        .header("accept", "application/json")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| {
            AppError::new("NET_UNREACHABLE", "连不上 GitHub,请检查网络或代理设置")
                .with_detail(e.to_string())
        })?;
    // GitHub 对轮询期的"错误"也回 200 + {"error": ...},不能只看状态码
    let resp = check_status(resp).await?;
    let poll: Poll = parse_json(resp).await?;
    if let Some(token) = poll.access_token.filter(|t| !t.is_empty()) {
        return Ok(DevicePoll::Token(token));
    }
    match poll.error.as_deref() {
        Some("authorization_pending") => Ok(DevicePoll::Pending),
        Some("slow_down") => Ok(DevicePoll::SlowDown),
        Some("access_denied") => Err(AppError::new(
            "AUTH_DEVICE_DENIED",
            "你在授权页取消了这次登录",
        )),
        Some("expired_token") => Err(AppError::new(
            "AUTH_DEVICE_EXPIRED",
            "这次登录等待太久已过期,请重新发起",
        )),
        other => Err(
            AppError::new("AUTH_DEVICE_FAILED", "登录未能完成,请重试")
                .with_detail(format!("error={other:?}")),
        ),
    }
}

impl RepoSource for GithubClient {
    async fn branch_head(&self, r: &RepoRef) -> Result<BranchHead, AppError> {
        GithubClient::branch_head(self, r).await
    }
    async fn download_archive(&self, r: &RepoRef) -> Result<RepoArchive, AppError> {
        GithubClient::download_archive(self, r).await
    }
}
