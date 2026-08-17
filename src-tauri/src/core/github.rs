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
    /// 网页地址(用户配置的源地址原样,只去尾斜杠)——历史页链接从它拼,
    /// 不能从 api_base 反推(api.github.com 反推不回 github.com)。
    web_base: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl GithubClient {
    pub fn new(base_url: &str, token: Option<String>, http: reqwest::Client) -> Self {
        Self {
            api_base: api_base_for(base_url),
            web_base: base_url.trim_end_matches('/').to_string(),
            token,
            http,
        }
    }

    /// 该目录在目标分支上的提交历史页(web UI,回推冲突档的「查看对方改动」链接)。
    pub fn history_url(&self, r: &RepoRef, path: &str) -> String {
        format!(
            "{}/{}/{}/commits/{}/{}",
            self.web_base, r.owner, r.repo, r.branch, path
        )
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

    /// 递归拉某个 commit 的完整目录树,只回路径不回内容(M10 任务 3)。
    ///
    /// **必须传 blob 那次请求拿到的同一个 commit sha**,不能传分支名——树与
    /// blob 内容要是同一个快照,否则会出现"树是新的、blob 内容是旧的"这种撕裂
    /// (见 `core::plaza` 模块头「安装走 blob」一节)。存在的意义是把
    /// skills.sh blob 端点只给的"技能目录名"换算回仓库内的真实相对路径
    /// (`resolve_skill_path`),同一个仓库装多个技能时,调用方应按
    /// `(owner, repo, sha)` 缓存这次响应——同一个 sha 的树内容不可变,
    /// 不需要任何失效逻辑(见 `commands.rs` 的 `cached_repo_tree`)。
    pub async fn tree(&self, r: &RepoRef, sha: &str) -> Result<RepoTree, AppError> {
        #[derive(Deserialize)]
        struct Entry {
            path: String,
        }
        #[derive(Deserialize)]
        struct Response {
            #[serde(default)]
            tree: Vec<Entry>,
            #[serde(default)]
            truncated: bool,
        }
        let url = format!(
            "{}/repos/{}/{}/git/trees/{}?recursive=1",
            self.api_base, r.owner, r.repo, sha
        );
        let resp = self.send(url).await?;
        let parsed: Response = parse_json(resp).await?;
        Ok(RepoTree {
            paths: parsed.tree.into_iter().map(|e| e.path).collect(),
            truncated: parsed.truncated,
        })
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

// ============================================================ git trees(M10 任务 3)

/// 一次 `git/trees?recursive=1` 响应,只保留后续路径匹配需要的部分。
#[derive(Debug, Clone)]
pub struct RepoTree {
    /// 树里每一条(文件与目录)的仓库根相对路径。GitHub 响应里还有个 `type`
    /// (`blob`/`tree`)字段,这里用不上——[`resolve_skill_path`] 只关心哪些路径
    /// 以 `/SKILL.md` 结尾,那已经足够定位到技能目录,不需要区分文件与目录节点。
    pub paths: Vec<String>,
    /// 仓库太大,GitHub 把这次递归结果截断了——**这份树不完整,不可信**。
    /// 调用方必须视为"找不到",不能因为凑巧没用到被截掉的部分就假装安全:
    /// 没办法知道被截掉的那部分里是否还有一个同名目录,会让"唯一匹配"变成误判。
    pub truncated: bool,
}

/// 在仓库树里为"技能目录名"(`dir_slug`)找出仓库根相对的真实路径(M10 任务 3)。
///
/// skills.sh 的 blob 端点(`core::plaza::fetch_blob`)只按目录名取内容,不给仓内
/// 路径——但 `state.installed[].source.path`/`.skill-lock.json` 的 `skillPath`
/// 都要这个真实路径(`share.rs` 还拿它去定位"分享改动"要提交到仓库的哪个目录,
/// 见 `core::plaza` 模块头「安装走 blob」一节)。这个函数把"目录名"换算回"路径":
/// 在全部 `SKILL.md` 条目里找"直接父目录名等于 `dir_slug`"的那些,**必须恰好一个**
/// ——树被截断、零匹配、同名目录不止一处,任何一种都不敢猜,一律 `None` 交给调用方
/// 回退 zipball。
pub fn resolve_skill_path(tree: &RepoTree, dir_slug: &str) -> Option<String> {
    if tree.truncated {
        return None;
    }
    let suffix = format!("/{}", crate::core::skills::SKILL_FILE);
    let mut candidates: Vec<&str> = tree
        .paths
        .iter()
        .filter_map(|p| {
            let dir = p.strip_suffix(&suffix)?;
            let leaf = dir.rsplit('/').next().unwrap_or(dir);
            (leaf == dir_slug).then_some(dir)
        })
        .collect();
    candidates.dedup();
    match candidates.as_slice() {
        [only] => Some((*only).to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tree_tests {
    use super::*;

    fn tree(paths: &[&str]) -> RepoTree {
        RepoTree {
            paths: paths.iter().map(|s| s.to_string()).collect(),
            truncated: false,
        }
    }

    #[test]
    fn resolves_a_uniquely_nested_skill_directory() {
        let t = tree(&[
            "plugins/developer-essentials/skills/code-review-excellence/SKILL.md",
            "plugins/developer-essentials/skills/code-review-excellence/references/checklist.md",
            "README.md",
        ]);
        assert_eq!(
            resolve_skill_path(&t, "code-review-excellence"),
            Some("plugins/developer-essentials/skills/code-review-excellence".to_string())
        );
    }

    #[test]
    fn resolves_a_skill_directory_one_level_deep() {
        let t = tree(&["skills/weekly-report/SKILL.md"]);
        assert_eq!(
            resolve_skill_path(&t, "weekly-report"),
            Some("skills/weekly-report".to_string())
        );
    }

    #[test]
    fn returns_none_when_there_is_no_match() {
        let t = tree(&["skills/weekly-report/SKILL.md"]);
        assert_eq!(resolve_skill_path(&t, "does-not-exist"), None);
    }

    #[test]
    fn returns_none_when_the_same_leaf_name_appears_in_two_places() {
        // 同名目录出现在两处:绑谁都是猜,一律不敢定。
        let t = tree(&[
            "plugins/a/skills/demo/SKILL.md",
            "plugins/b/skills/demo/SKILL.md",
        ]);
        assert_eq!(resolve_skill_path(&t, "demo"), None);
    }

    #[test]
    fn returns_none_when_the_tree_was_truncated_even_with_an_exact_single_match() {
        // 截断发生在响应层面:哪怕现存路径里恰好只有一个匹配,也不能信——
        // 被截掉的那部分完全可能藏着另一个同名目录。
        let mut t = tree(&["skills/weekly-report/SKILL.md"]);
        t.truncated = true;
        assert_eq!(resolve_skill_path(&t, "weekly-report"), None);
    }

    #[test]
    fn does_not_match_a_skill_md_sitting_at_the_repo_root() {
        // 根层的 SKILL.md 没有"父目录名"可比——不该匹配任何 dir_slug,
        // 这是刻意的边界(极罕见的仓库布局,交给调用方回退 zipball)。
        let t = tree(&["SKILL.md"]);
        assert_eq!(resolve_skill_path(&t, "SKILL.md"), None);
    }
}

// ============================================================ 写链路(M3-5b)
//
// 全部形状录制自真实 GitHub(tests/fixtures/github-write/,2026-08-03),要点:
// - 多文件一次提交走 GraphQL `createCommitOnBranch`(REST contents 一次一个文件,
//   一个技能会被拆成多笔提交且中途失败留半成品);无 mode 字段,脚本可执行位
//   落 100644——与 Gitea 的 ChangeFilesRequest 同款限制,两侧一致,接受;
// - GraphQL 的错误在 HTTP 200 里,判定用 `errors[].type`:陈旧头 `STALE_DATA`、
//   分支保护 `BRANCH_PROTECTION_RULE_VIOLATION`,不 grep message;
// - fork 是 202 异步受理,实测约 3 秒可用,响应体自带 full_name;
// - 权限矩阵判据 `GET /repos` 的 `permissions.push`(匿名/无权限时字段整个缺席)。

/// 权限矩阵要用的仓库视图(录制 01/01b)。
#[derive(Debug, Clone, Deserialize)]
pub struct RepoView {
    #[serde(default)]
    pub permissions: RepoPermissions,
    #[serde(default)]
    pub default_branch: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RepoPermissions {
    #[serde(default)]
    pub push: bool,
}

/// `GET {api_base}/repos/{owner}/{repo}` 的共享读取(M9 任务 3 审查后抽出)。
///
/// **这是唯一实现这个外部契约的地方**:URL 构造、鉴权头、状态码分档(`check_status`)、
/// JSON 解析(`parse_json` 反序列化进 [`RepoView`],含 `default_branch` 字段)全部只
/// 维护这一份。两个调用方**只在拿到结果之后的错误处理上分叉**,分叉发生在调用方,
/// 不在这个函数里:
/// - [`GithubClient::repo_view`] 原样把这里给出的分档错误码(401/403/404/5xx,
///   由 [`check_status`] 决定)透给用户——它的权限矩阵判断需要知道具体是哪一种;
/// - `core::plaza::default_branch` 把任意 `Err`(不论原始错误码)统一改写成
///   `NET_PLAZA_REPO`——广场挂仓探测只需要一种"探测失败,请稍后重试"的降级展示,
///   不需要用户分辨是 404 还是限流还是网络问题。
///
/// `token` 为 `None` 时匿名请求(广场技能公开可读,同内建源"读永远匿名"的先例)。
pub(crate) async fn fetch_repo_view(
    http: &reqwest::Client,
    token: Option<&str>,
    api_base: &str,
    owner: &str,
    repo: &str,
) -> Result<RepoView, AppError> {
    let url = format!("{api_base}/repos/{owner}/{repo}");
    let mut req = http
        .get(url)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28");
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| {
        if gitea::is_unreachable(&e) {
            AppError::new("NET_UNREACHABLE", "连不上 GitHub,请检查网络或代理设置")
                .with_detail(e.to_string())
        } else {
            AppError::new("NET_REQUEST", "网络请求失败,请稍后重试").with_detail(e.to_string())
        }
    })?;
    let resp = check_status(resp).await?;
    parse_json(resp).await
}

/// fork 的落点。202 响应体自带 full_name(录制 11)。
#[derive(Debug, Clone)]
pub struct ForkTarget {
    pub owner: String,
    pub repo: String,
}

/// 开好的评审入口。
#[derive(Debug, Clone, Deserialize)]
pub struct PullView {
    pub html_url: String,
}

impl GithubClient {
    /// GraphQL 端点。github.com 是 api 域根下的 /graphql;GHE 是 {base}/api/graphql
    /// (REST 的 api_base 带 /v3,GraphQL 不带)。
    fn graphql_url(&self) -> String {
        match self.api_base.strip_suffix("/api/v3") {
            Some(base) => format!("{base}/api/graphql"),
            None => format!("{}/graphql", self.api_base),
        }
    }

    fn request(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        let mut req = self
            .http
            .request(method, url)
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        req
    }

    async fn send_built(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, AppError> {
        let resp = req.send().await.map_err(|e| {
            if gitea::is_unreachable(&e) {
                AppError::new("NET_UNREACHABLE", "连不上 GitHub,请检查网络或代理设置")
                    .with_detail(e.to_string())
            } else {
                AppError::new("NET_REQUEST", "网络请求失败,请稍后重试").with_detail(e.to_string())
            }
        })?;
        check_status(resp).await
    }

    /// 仓库视图(权限矩阵判据)。薄壳:实际请求在 [`fetch_repo_view`](共享读取,
    /// 与 `core::plaza::default_branch` 共用同一个外部契约,见其文档)。
    pub async fn repo_view(&self, owner: &str, repo: &str) -> Result<RepoView, AppError> {
        fetch_repo_view(&self.http, self.token.as_deref(), &self.api_base, owner, repo).await
    }

    /// 分支是否受保护(录制 08b 的 `protected` 字段)。
    /// 只作先探:保护规则可能只拦部分人,提交时的
    /// `BRANCH_PROTECTION_RULE_VIOLATION` 才是最终真相。
    pub async fn branch_protected(&self, r: &RepoRef) -> Result<bool, AppError> {
        #[derive(Deserialize)]
        struct Branch {
            #[serde(default)]
            protected: bool,
        }
        let url = format!(
            "{}/repos/{}/{}/branches/{}",
            self.api_base, r.owner, r.repo, r.branch
        );
        let resp = self.send_built(self.request(reqwest::Method::GET, url)).await?;
        let branch: Branch = parse_json(resp).await?;
        Ok(branch.protected)
    }

    /// 远端是否已有该文件(分享预检)。404 是"没有",不是错误。
    pub async fn file_exists(&self, r: &RepoRef, path: &str) -> Result<bool, AppError> {
        let url = format!(
            "{}/repos/{}/{}/contents/{}?ref={}",
            self.api_base, r.owner, r.repo, path, r.branch
        );
        let req = self.request(reqwest::Method::GET, url);
        let resp = req.send().await.map_err(|e| {
            AppError::new("NET_REQUEST", "网络请求失败,请稍后重试").with_detail(e.to_string())
        })?;
        if resp.status().as_u16() == 404 {
            return Ok(false);
        }
        check_status(resp).await?;
        Ok(true)
    }

    /// 从 `sha` 开出新分支(录制 05,REST git/refs)。
    pub async fn create_branch(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        sha: &str,
    ) -> Result<(), AppError> {
        let url = format!("{}/repos/{owner}/{repo}/git/refs", self.api_base);
        let body = serde_json::json!({ "ref": format!("refs/heads/{branch}"), "sha": sha });
        self.send_built(self.request(reqwest::Method::POST, url).json(&body))
            .await?;
        Ok(())
    }

    /// 多文件一次提交(录制 03/04/06/09)。返回新提交的 oid。
    pub async fn create_commit_on_branch(
        &self,
        name_with_owner: &str,
        branch: &str,
        expected_head_oid: &str,
        headline: &str,
        additions: &[(String, Vec<u8>)],
    ) -> Result<String, AppError> {
        use base64::Engine;
        const QUERY: &str = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }";
        let files: Vec<serde_json::Value> = additions
            .iter()
            .map(|(path, bytes)| {
                serde_json::json!({
                    "path": path,
                    "contents": base64::engine::general_purpose::STANDARD.encode(bytes),
                })
            })
            .collect();
        let body = serde_json::json!({
            "query": QUERY,
            "variables": { "input": {
                "branch": { "repositoryNameWithOwner": name_with_owner, "branchName": branch },
                "expectedHeadOid": expected_head_oid,
                "message": { "headline": headline },
                "fileChanges": { "additions": files },
            }},
        });

        let url = self.graphql_url();
        let resp = self.send_built(self.request(reqwest::Method::POST, url).json(&body)).await?;

        #[derive(Deserialize)]
        struct GqlResp {
            #[serde(default)]
            data: Option<GqlData>,
            #[serde(default)]
            errors: Vec<GqlError>,
        }
        #[derive(Deserialize)]
        struct GqlData {
            #[serde(rename = "createCommitOnBranch")]
            create: Option<GqlCreate>,
        }
        #[derive(Deserialize)]
        struct GqlCreate {
            commit: GqlCommit,
        }
        #[derive(Deserialize)]
        struct GqlCommit {
            oid: String,
        }
        #[derive(Deserialize)]
        struct GqlError {
            #[serde(rename = "type", default)]
            kind: String,
            #[serde(default)]
            message: String,
        }

        let parsed: GqlResp = parse_json(resp).await?;
        if let Some(err) = parsed.errors.first() {
            // GraphQL 的错误在 HTTP 200 里;判定用 type,不 grep message(录制 04/09)
            return Err(match err.kind.as_str() {
                "STALE_DATA" => {
                    AppError::new("REPO_STALE", "技能库刚刚有新变化,请刷新后重试")
                }
                "BRANCH_PROTECTION_RULE_VIOLATION" => AppError::new(
                    "REPO_PROTECTED",
                    "这个技能库不允许直接保存,需要提交审核",
                ),
                _ => AppError::new("NET_REQUEST", "保存未能完成,请稍后重试"),
            }
            .with_detail(format!("{}: {}", err.kind, err.message)));
        }
        parsed
            .data
            .and_then(|d| d.create)
            .map(|c| c.commit.oid)
            .ok_or_else(|| {
                AppError::new("NET_BAD_RESPONSE", "技能库返回了无法识别的内容")
                    .with_detail("createCommitOnBranch 无 commit")
            })
    }

    /// 发起评审(录制 07)。跨库时 `head` 用 `{owner}:{branch}` 形式。
    pub async fn create_pull(
        &self,
        owner: &str,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
    ) -> Result<PullView, AppError> {
        let url = format!("{}/repos/{owner}/{repo}/pulls", self.api_base);
        let body = serde_json::json!({ "title": title, "head": head, "base": base, "body": "" });
        let resp = self
            .send_built(self.request(reqwest::Method::POST, url).json(&body))
            .await?;
        parse_json(resp).await
    }

    /// fork 到自己名下(只读用户的评审路径)。202 异步受理,就绪用
    /// [`Self::wait_fork_ready`] 轮询(实测约 3 秒,录制 11)。
    pub async fn fork_repo(&self, owner: &str, repo: &str) -> Result<ForkTarget, AppError> {
        #[derive(Deserialize)]
        struct Fork {
            full_name: String,
        }
        let url = format!("{}/repos/{owner}/{repo}/forks", self.api_base);
        let body = serde_json::json!({ "default_branch_only": true });
        let resp = self
            .send_built(self.request(reqwest::Method::POST, url).json(&body))
            .await?;
        let fork: Fork = parse_json(resp).await?;
        let (fork_owner, fork_repo) = fork.full_name.split_once('/').ok_or_else(|| {
            AppError::new("NET_BAD_RESPONSE", "技能库返回了无法识别的内容")
                .with_detail(format!("fork full_name: {}", fork.full_name))
        })?;
        Ok(ForkTarget {
            owner: fork_owner.to_string(),
            repo: fork_repo.to_string(),
        })
    }

    /// 轮询 fork 就绪(分支头可读即就绪)。`delay` 注入以便测试不真等。
    pub async fn wait_fork_ready(
        &self,
        r: &RepoRef,
        attempts: u32,
        delay: std::time::Duration,
    ) -> Result<BranchHead, AppError> {
        let mut last_detail = String::new();
        for _ in 0..attempts {
            match self.branch_head(r).await {
                Ok(head) => return Ok(head),
                Err(e) if e.code == "REPO_NOT_FOUND" => {
                    // 还在准备中;原样抛会误导成"技能库不存在"
                    last_detail = e.detail.unwrap_or(e.message);
                    tokio::time::sleep(delay).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err(
            AppError::new("REPO_FORK_PENDING", "技能库副本还没准备好,请稍后重试")
                .with_detail(last_detail),
        )
    }
}
