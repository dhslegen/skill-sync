//! Gitea REST API client。
//!
//! 纯 REST,不嵌入 git(架构铁律 2):用户机器上无需安装 git,认证只是一个 header。
//! 目标版本 Gitea 1.25.3(决策 C1);多文件单次提交要求 ≥1.20。
//!
//! 下列状态码与错误文案均来自 fixtures 实例上的真实响应录制,不是照文档推测的:
//! - 401 `{"message":"invalid username, password or token"}`
//! - 403 `{"message":"user should have a permission to write to the target branch"}`(只读用户直推)
//! - 404 `{"errors":[…],"message":"GetContentsOrList"}`
//! - 422 `{"message":"sha does not match [given: …, expected: …]"}`(提交瞬间的竞态)
//!
//! # 分享路径的权限矩阵(实测,任务 11 据此编排)
//!
//! | 用户在目标库的权限 | 直推默认分支 | 开新分支 + 提交审核 |
//! |---|---|---|
//! | 只读(pull) | 403 | **403**——建分支同样被拒,只能先 fork 再从 fork 提交审核 |
//! | 可写(push)且默认分支受保护 | 403 | 201 + 201 ✓ |
//! | 可写且默认分支未受保护 | 201 ✓ | 201 ✓ |
//!
//! 决策 C3 写的"无写权限自动走 PR(new_branch + pulls)"只在**可写 + 分支受保护**时成立;
//! 纯只读用户走这条路会 403。因此本模块同时提供 [`GiteaClient::fork_repo`],
//! 由任务 11 按 `permissions.push` 选择路径:可写→直推或开分支,只读→fork 后提交审核。
//!
//! # 系统代理:按源分两档(M1 任务 13 拍板"一律直连",M3 任务 3 修订)
//!
//! 企业机器普遍配 `http_proxy` 访问外网;内网 Gitea 若不在 `NO_PROXY`,reqwest 的
//! 默认行为会把请求转给代理——代理连不到内网,用户在登录第一步就拿到看不懂的失败
//! (开发机实测:得到的是代理的 5xx,不是"连接被拒")。
//!
//! - **内建源**一定在内网:[`app_http_client`] 完全禁用代理,直连即正确语义。
//!   极端环境(全流量强制走代理、无透明例外)下直连会失败,部署文档要求 IT 放行该域名。
//! - **外部源**(自定义 Gitea / GitHub,M3 起)在公司代理网络下恰恰相反——不走代理
//!   就连不上外网:[`app_http_client_proxied`] 跟随系统代理(reqwest 默认行为)。
//!   用户拍板(2026-07-31):不加每源"直连/代理"开关,保持设置页简单。
//!
//! 选择在 `commands::http_client_for` 一处:内建 id → 直连,其余 → 跟随系统代理。

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// 内建源的 HTTP client:带 UA、**不走系统代理**(理由见模块头)。
///
/// 所有对技能库的请求都应从这里或 [`app_http_client_proxied`] 构造 client,
/// 别在各处散落 `Client::builder()`——那会让代理策略悄悄回到 reqwest 默认值。
pub fn app_http_client() -> Result<reqwest::Client, AppError> {
    build_client(true, None)
}

/// 外部源(自定义 Gitea / GitHub)的 HTTP client:带同一 UA、**跟随系统代理**。
/// 公司代理网络下外网只有经代理才通(M3 任务 3,模块头有完整理由)。
pub fn app_http_client_proxied() -> Result<reqwest::Client, AppError> {
    build_client(false, None)
}

/// 内建源的 HTTP client,带一个**短超时**——只给"查不到就当没有"的锦上添花式
/// 查询用(v7 任务 2「审核态」):`installed_list` 会被 `useLocalRefresh` 在窗口
/// 重获焦点/切页/文件变更三处触发,而这次查询失败本就有既定的降级路。不给超时
/// 的话,用户不在内网(或撞上黑洞网关)时整页数据会挂在一次无超时的请求上
/// ——这是本任务新引入的暴露面,`app_http_client()`/`app_http_client_proxied()`
/// 两个既有函数的默认无超时行为**不受影响**(`build_client` 的 `timeout` 参数
/// 缺省给 `None`)。
pub fn app_http_client_with_timeout(timeout: std::time::Duration) -> Result<reqwest::Client, AppError> {
    build_client(true, Some(timeout))
}

fn build_client(no_proxy: bool, timeout: Option<std::time::Duration>) -> Result<reqwest::Client, AppError> {
    let mut builder =
        reqwest::Client::builder().user_agent(concat!("SkillSync/", env!("CARGO_PKG_VERSION")));
    if no_proxy {
        builder = builder.no_proxy();
    }
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }
    builder.build().map_err(|e| {
        AppError::new("NET_CLIENT_INIT", "网络组件初始化失败,请重启应用")
            .with_detail(e.to_string())
    })
}

/// 判断一个链接是否与技能库同源(scheme + host + port 全等)。
///
/// 「在系统浏览器里打开」的白名单:只放行技能库自己的页面(评审链接等)。
/// 这是从 webview 通往系统的通道,放行任意 URL 等于让技能库内容(或未来的
/// 自定义源)能把用户带去任何地方——宁可保守。
pub fn is_same_origin(base_url: &str, candidate: &str) -> bool {
    let (Ok(base), Ok(url)) = (url::Url::parse(base_url), url::Url::parse(candidate)) else {
        return false;
    };
    // 只认 http(s):javascript:/file: 这类 scheme 即便"同源"也绝不放行
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    base.scheme() == url.scheme()
        && base.host_str() == url.host_str()
        && base.port_or_known_default() == url.port_or_known_default()
}

/// 仓库坐标。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// Gitea 发的是 snake_case,前端要的是 camelCase:只在序列化方向改名,
// 否则反序列化会去找 htmlUrl 这种字段而拿到默认值(静默失真)。
#[serde(rename_all(serialize = "camelCase"))]
pub struct GiteaUser {
    pub login: String,
    #[serde(default)]
    pub full_name: String,
    #[serde(default)]
    pub avatar_url: String,
}

/// 仓库权限。决定分享走直推还是提交审核(决策 C3)。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct RepoPermissions {
    #[serde(default)]
    pub admin: bool,
    #[serde(default)]
    pub push: bool,
    #[serde(default)]
    pub pull: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// Gitea 发的是 snake_case,前端要的是 camelCase:只在序列化方向改名,
// 否则反序列化会去找 htmlUrl 这种字段而拿到默认值(静默失真)。
#[serde(rename_all(serialize = "camelCase"))]
pub struct RepoInfo {
    pub default_branch: String,
    #[serde(default)]
    pub permissions: RepoPermissions,
    #[serde(default)]
    pub empty: bool,
}

/// `GET /repos/{o}/{r}/branches/{branch}` 里与权限有关的部分(M4 任务 2 录制)。
///
/// **字段名保持 snake_case,不加 `rename_all`**:Gitea 发的就是 `user_can_push`,
/// 驼峰化后反序列化会去找 `userCanPush` 拿不到,配上 `serde(default)` 静默变成
/// `false`——落进"无权限"档,方向恰好是反的(与 M3 的 `new_branch`→`newBranch` 同型)。
#[derive(Debug, Clone, Deserialize)]
pub struct BranchAccess {
    #[serde(default)]
    pub protected: bool,
    /// 当前登录用户能否直推这个分支。**它把仓库写权限与分支保护合并成一个答案**,
    /// 是预检唯一准确的判据(`permissions.push` 在受保护时仍是 true)。
    /// 旧版 Gitea 没有这个字段,故用 `Option` 区分"说了 false"与"根本没说"。
    pub user_can_push: Option<bool>,
}

/// 分支当前指向的提交。商店索引靠它判断"远端有没有变",避免每次都下载压缩包。
/// git tree 里的一个文件:仓库相对路径 + blob sha。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeFile {
    pub path: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchHead {
    pub sha: String,
    pub committed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileOperation {
    Create,
    Update,
    Delete,
}

/// 一次提交里的单个文件改动。
///
/// **不加 `rename_all`**:这是发给 Gitea 的请求体,它的字段名是 snake_case。
/// 现有字段恰好都是单个单词、驼峰化后不变,所以加了也看不出问题
/// ——直到有人加一个带下划线的字段(见 [`ChangeFilesRequest`] 上的教训)。
#[derive(Debug, Clone, Serialize)]
pub struct FileChange {
    pub operation: FileOperation,
    pub path: String,
    /// base64 编码后的内容;删除操作不需要。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// 更新与删除必须带上文件当前的 sha,Gitea 据此拒绝覆盖他人的改动。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
}

impl FileChange {
    pub fn create(path: impl Into<String>, content: &[u8]) -> Self {
        Self {
            operation: FileOperation::Create,
            path: path.into(),
            content: Some(base64::engine::general_purpose::STANDARD.encode(content)),
            sha: None,
        }
    }

    pub fn update(path: impl Into<String>, content: &[u8], sha: impl Into<String>) -> Self {
        Self {
            operation: FileOperation::Update,
            path: path.into(),
            content: Some(base64::engine::general_purpose::STANDARD.encode(content)),
            sha: Some(sha.into()),
        }
    }
}

/// 多文件单次提交的请求体。
///
/// **不加 `rename_all`**:Gitea 收的是 snake_case。这里原本写着
/// `rename_all = "camelCase"`,`new_branch` 因此被发成 `newBranch`;Gitea 对不认识的字段
/// 静默忽略,于是"先开分支再提交审核"会**悄悄退化成直推 main**(决策 C3 的主路径失效)。
/// 当时的单测只断 `json.get("new_branch").is_none()` —— 那句话在字段被拼成 `newBranch` 时
/// 同样成立,所以拼错完全没被拦住。任务 8 对真 Gitea 灌数据时才撞出来。
#[derive(Debug, Clone, Serialize)]
pub struct ChangeFilesRequest {
    pub branch: String,
    /// 目标分支不存在时先从 branch 开出来——走提交审核时用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_branch: Option<String>,
    pub message: String,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// Gitea 发的是 snake_case,前端要的是 camelCase:只在序列化方向改名,
// 否则反序列化会去找 htmlUrl 这种字段而拿到默认值(静默失真)。
#[serde(rename_all(serialize = "camelCase"))]
pub struct CommitResult {
    pub sha: String,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// Gitea 发的是 snake_case,前端要的是 camelCase:只在序列化方向改名,
// 否则反序列化会去找 htmlUrl 这种字段而拿到默认值(静默失真)。
#[serde(rename_all(serialize = "camelCase"))]
pub struct PullResult {
    pub number: u64,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResult {
    pub owner: String,
    pub repo: String,
    /// 之前就存在同名副本(重复分享时的常态,不是错误)。
    pub already_existed: bool,
}

/// [`GiteaClient::list_open_pulls`] 单页条数,同时用于生成请求参数与判断该不该
/// 继续翻页(修复轮 2:公开出来是为了测试能直接引用这个数字,而不是在
/// `tests/review_state.rs` 里另抄一份 20/50 的字面量——两边一旦漂移,测试守的
/// 就是一个错误的边界)。Gitea 的 `[api] MAX_RESPONSE_ITEMS` 默认也是 50,
/// 不同部署可能改过,所以显式给出而不依赖服务端默认值。
pub const PULLS_PAGE_SIZE: u32 = 50;

/// [`GiteaClient::list_open_pulls`] 翻页的硬上限(修复轮 2 新增)。配合
/// [`PULLS_PAGE_SIZE`],最多请求 `PULLS_MAX_PAGES * PULLS_PAGE_SIZE` = 1000 条
/// ——公司库开放的提交审核数量到不了这个量级,超出即视为异常(服务端不尊重
/// `page` 参数、每页都原样回同一批数据),当作查询失败交回调用方走既有降级路。
pub const PULLS_MAX_PAGES: u32 = 20;

/// [`GiteaClient::list_open_pulls`] 整趟查询(含全部翻页)的总耗时上限(修复轮 2
/// 新增)。单次请求各自还有调用方给的 `app_http_client_with_timeout`,但那管不住
/// 翻页反复调用的总时长——这条查询按设计只是"查不到就当没有"的锦上添花,
/// 不该让 `installed_list` 挂在一次可能要转二十页的查询上。
pub const PULLS_QUERY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15);

/// 一个开放的合并请求(v7 任务 2「审核态」用)。
///
/// 只取解析用得上的三个字段,不 1:1 照搬 Gitea 的完整 PR 形状。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct PullBrief {
    pub number: u64,
    pub html_url: String,
    /// 源分支名(不带 `owner:` 前缀——本模块的评审分支都开在目标库自己身上,
    /// fork 提交才会是那种形状,而列表查询问的是目标库,`head.ref` 就是纯分支名)。
    pub head_ref: String,
}

/// Gitea 响应的原始形状:`head` 嵌套着 `ref`(Rust 关键字,需要 `rename`)。
/// 只在这个函数内部用,不对外暴露——外部只该看到扁平的 [`PullBrief`]。
#[derive(Debug, Deserialize)]
struct RawPull {
    number: u64,
    html_url: String,
    head: RawPullHead,
}

#[derive(Debug, Deserialize)]
struct RawPullHead {
    #[serde(rename = "ref")]
    git_ref: String,
}

/// 评审分支名的前缀,与 [`crate::core::share::review_branch`] 共用同一份实现
/// (它内部就调用这个函数再拼时间戳)——两把尺子不能各自维护一份字面量,
/// 一旦分支名的格式变了而这里没跟着变,「审核中」会永远匹配不上(见
/// `tests/review_state.rs` 的同源断言)。
pub fn review_branch_prefix(share_name: &str) -> String {
    format!("skillsync/{share_name}-")
}

/// 压缩包里的一个文件。
#[derive(Debug, Clone)]
pub struct ArchiveEntry {
    pub bytes: Vec<u8>,
    /// zip 里记录的 unix 权限位。
    ///
    /// **2026-07-30 对 Gitea 1.25.3 实测**(fixture:`tests/fixtures/gitea-archive-modes.zip`,
    /// 由真实 push + archive 下载得到):Gitea **只给可执行文件写 `0o755`,普通文件的
    /// external_attr 高位是 `0`**——是"没记 mode",不是 `0o644`。
    /// 所以判定必须是"带 `0o111` 任一位才算可执行",不能拿 `0o644` 当基准去比。
    pub unix_mode: Option<u32>,
}

impl ArchiveEntry {
    /// 是否该以可执行位落盘。
    pub fn is_executable(&self) -> bool {
        self.unix_mode.is_some_and(|m| m & 0o111 != 0)
    }
}

/// 下载下来的仓库压缩包解开后的内容。
pub struct RepoArchive {
    /// 压缩包顶层目录名。Gitea 用仓库名(`team-skills/`),GitHub 用
    /// `{owner}-{repo}-{短sha}/`(2026-07-31 实测,曾猜错为 `<repo>-<ref>/`),
    /// 因此扫描技能时的起始路径必须以此为准,不能写死。
    pub root: String,
    /// 仅文本文件,供 [`crate::core::skills::discover_skills`] 扫描。
    pub tree: crate::core::skills::MemTree,
    /// 全部文件的逻辑路径,用于文件树展示与"含可执行脚本"判断。
    pub files: Vec<String>,
    /// 全部文件的原始字节与权限位。
    ///
    /// 安装要靠它:`tree` 里没有二进制文件(带图片或模板包的技能会被装成残缺品),
    /// 也没有权限位(`run.sh` 会被装成不可执行)。展示只用 `tree` 就够,落盘必须用这里。
    pub entries: std::collections::BTreeMap<String, ArchiveEntry>,
}

pub struct GiteaClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl GiteaClient {
    pub fn new(base_url: impl Into<String>, token: Option<String>) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("SkillSync/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| {
                AppError::new("NET_CLIENT_INIT", "网络组件初始化失败,请重启应用")
                    .with_detail(e.to_string())
            })?;
        Ok(Self::with_http(base_url, token, http))
    }

    /// 复用已有的 HTTP 客户端。连接池与代理配置跟着复用,登录流程与后续 API 调用共用一份。
    pub fn with_http(
        base_url: impl Into<String>,
        token: Option<String>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            token,
            http,
        }
    }

    fn api(&self, path: &str) -> String {
        format!("{}/api/v1{}", self.base_url, path)
    }

    /// 该目录在目标分支上的提交历史页(web UI,回推冲突档的「查看对方改动」链接)。
    ///
    /// 路由 `/{owner}/{repo}/commits/branch/{branch}/{path}` 已对本地 docker
    /// Gitea 1.25.3 实测(2026-08-05,curl 200;`commits/{branch}/…` 形式是 303 跳转)。
    pub fn history_url(&self, r: &RepoRef, path: &str) -> String {
        format!(
            "{}/{}/{}/commits/branch/{}/{}",
            self.base_url, r.owner, r.repo, r.branch, path
        )
    }

    fn request(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        let req = self.http.request(method, url);
        match &self.token {
            Some(t) => req.header("Authorization", format!("token {t}")),
            None => req,
        }
    }

    /// 当前登录用户。也用作令牌有效性检查。
    pub async fn current_user(&self) -> Result<GiteaUser, AppError> {
        let resp = self
            .send(self.request(reqwest::Method::GET, self.api("/user")))
            .await?;
        parse_json(resp).await
    }

    pub async fn repo_info(&self, owner: &str, repo: &str) -> Result<RepoInfo, AppError> {
        let resp = self
            .send(self.request(
                reqwest::Method::GET,
                self.api(&format!("/repos/{owner}/{repo}")),
            ))
            .await?;
        parse_json(resp).await
    }

    /// 读分支的保护状态与"我能不能推"。只读用户也读得到(不像 `branch_protections`
    /// 端点要 admin 权限)——录制结论见 `tests/fixtures/gitea-permissions/NOTES.md`。
    pub async fn branch_access(&self, r: &RepoRef) -> Result<BranchAccess, AppError> {
        let resp = self
            .send(self.request(
                reqwest::Method::GET,
                self.api(&format!(
                    "/repos/{}/{}/branches/{}",
                    r.owner, r.repo, r.branch
                )),
            ))
            .await?;
        parse_json(resp).await
    }

    pub async fn branch_head(&self, r: &RepoRef) -> Result<BranchHead, AppError> {
        #[derive(Deserialize)]
        struct Branch {
            commit: Commit,
        }
        #[derive(Deserialize)]
        struct Commit {
            id: String,
            timestamp: String,
        }
        let resp = self
            .send(self.request(
                reqwest::Method::GET,
                self.api(&format!(
                    "/repos/{}/{}/branches/{}",
                    r.owner, r.repo, r.branch
                )),
            ))
            .await?;
        let branch: Branch = parse_json(resp).await?;
        Ok(BranchHead {
            sha: branch.commit.id,
            committed_at: branch.commit.timestamp,
        })
    }

    /// 下载并解开仓库压缩包。
    pub async fn download_archive(&self, r: &RepoRef) -> Result<RepoArchive, AppError> {
        let resp = self
            .send(self.request(
                reqwest::Method::GET,
                self.api(&format!(
                    "/repos/{}/{}/archive/{}.zip",
                    r.owner, r.repo, r.branch
                )),
            ))
            .await?;
        let bytes = resp.bytes().await.map_err(|e| {
            AppError::new("NET_DOWNLOAD", "技能库下载中断,请重试").with_detail(e.to_string())
        })?;
        unzip_archive(&bytes)
    }

    /// 取文件当前 sha。文件不存在返回 `None`——用于区分"新建"与"更新"。
    pub async fn file_sha(&self, r: &RepoRef, path: &str) -> Result<Option<String>, AppError> {
        #[derive(Deserialize)]
        struct Content {
            sha: String,
        }
        let url = self.api(&format!(
            "/repos/{}/{}/contents/{}?ref={}",
            r.owner, r.repo, path, r.branch
        ));
        let resp = self
            .http_send(self.request(reqwest::Method::GET, url))
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = check_status(resp).await?;
        let content: Content = parse_json(resp).await?;
        Ok(Some(content.sha))
    }

    /// 读单个文件的内容与 blob sha(contents API)。404 → None。
    ///
    /// M7 任务 5:分享时要拿库根 authors.json 的现值做归因修订——
    /// `tree_files` 只给 sha 不给内容,`download_archive` 又是整库 zip,按单文件取最省。
    pub async fn file_content(
        &self,
        r: &RepoRef,
        path: &str,
    ) -> Result<Option<(String, Vec<u8>)>, AppError> {
        #[derive(Deserialize)]
        struct Content {
            sha: String,
            #[serde(default)]
            content: String,
            #[serde(default)]
            encoding: String,
        }
        let url = self.api(&format!(
            "/repos/{}/{}/contents/{}?ref={}",
            r.owner, r.repo, path, r.branch
        ));
        let resp = self
            .http_send(self.request(reqwest::Method::GET, url))
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = check_status(resp).await?;
        let content: Content = parse_json(resp).await?;
        if content.encoding != "base64" {
            return Err(AppError::new("REPO_BAD_RESPONSE", "技能库返回了无法识别的文件编码")
                .with_detail(format!("encoding={}", content.encoding)));
        }
        // Gitea 的 base64 带换行分段,解码前先剥掉空白
        let compact: String = content.content.chars().filter(|c| !c.is_whitespace()).collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(compact.as_bytes())
            .map_err(|e| {
                AppError::new("REPO_BAD_RESPONSE", "技能库返回的文件内容无法解码")
                    .with_detail(e.to_string())
            })?;
        Ok(Some((content.sha, bytes)))
    }

    /// 多文件单次提交。`new_branch` 非空时会先开分支——走提交审核的路径。
    pub async fn change_files(
        &self,
        owner: &str,
        repo: &str,
        req: &ChangeFilesRequest,
    ) -> Result<CommitResult, AppError> {
        #[derive(Deserialize)]
        struct Response {
            commit: CommitResult,
        }
        let resp = self
            .send(
                self.request(
                    reqwest::Method::POST,
                    self.api(&format!("/repos/{owner}/{repo}/contents")),
                )
                .json(req),
            )
            .await?;
        let parsed: Response = parse_json(resp).await?;
        Ok(parsed.commit)
    }

    /// 列出某个提交下的全部文件及其 blob sha(git trees API,一次递归拿全)。
    ///
    /// 更新分享时用:`contents` API 的 update 操作要求携带旧文件的 blob sha,
    /// 逐文件 GET 一次太慢,trees 一趟就够。
    pub async fn tree_files(
        &self,
        owner: &str,
        repo: &str,
        commit_sha: &str,
    ) -> Result<Vec<TreeFile>, AppError> {
        #[derive(Deserialize)]
        struct Tree {
            #[serde(default)]
            tree: Vec<TreeNode>,
            #[serde(default)]
            truncated: bool,
        }
        #[derive(Deserialize)]
        struct TreeNode {
            path: String,
            sha: String,
            #[serde(rename = "type")]
            kind: String,
        }
        let resp = self
            .send(self.request(
                reqwest::Method::GET,
                self.api(&format!(
                    "/repos/{owner}/{repo}/git/trees/{commit_sha}?recursive=true&per_page=100000"
                )),
            ))
            .await?;
        let tree: Tree = parse_json(resp).await?;
        if tree.truncated {
            // 树被截断意味着 sha 清单不完整,拿着残缺清单去 update 会把 create/update 判错
            return Err(AppError::new(
                "REPO_TOO_LARGE",
                "技能库内容过多,暂时无法完成这次操作",
            )
            .with_detail("git tree truncated"));
        }
        Ok(tree
            .tree
            .into_iter()
            .filter(|n| n.kind == "blob")
            .map(|n| TreeFile {
                path: n.path,
                sha: n.sha,
            })
            .collect())
    }

    /// 复刻一份仓库到自己名下。
    ///
    /// 只读用户想贡献内容时唯一可走的路:实测只读用户在原库里连分支都建不了(403),但可以 fork。
    /// 已存在同名 fork 时 Gitea 返回 409,此处按"已就绪"处理。
    pub async fn fork_repo(&self, owner: &str, repo: &str) -> Result<ForkResult, AppError> {
        let resp = self
            .http_send(
                self.request(
                    reqwest::Method::POST,
                    self.api(&format!("/repos/{owner}/{repo}/forks")),
                )
                .json(&serde_json::json!({})),
            )
            .await?;
        if resp.status() == reqwest::StatusCode::CONFLICT {
            let user = self.current_user().await?;
            return Ok(ForkResult {
                owner: user.login,
                repo: repo.to_string(),
                already_existed: true,
            });
        }
        let resp = check_status(resp).await?;

        #[derive(Deserialize)]
        struct Fork {
            name: String,
            owner: ForkOwner,
        }
        #[derive(Deserialize)]
        struct ForkOwner {
            login: String,
        }
        let fork: Fork = parse_json(resp).await?;
        Ok(ForkResult {
            owner: fork.owner.login,
            repo: fork.name,
            already_existed: false,
        })
    }

    /// 开一个待评审的合并请求。界面上叫「提交审核」,不出现 PR 字样。
    ///
    /// `head` 在同库分支时写分支名;从 fork 提交时写 `<fork 拥有者>:<分支名>`。
    pub async fn create_pull(
        &self,
        owner: &str,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
    ) -> Result<PullResult, AppError> {
        let resp = self
            .send(
                self.request(
                    reqwest::Method::POST,
                    self.api(&format!("/repos/{owner}/{repo}/pulls")),
                )
                .json(&serde_json::json!({
                    "head": head, "base": base, "title": title, "body": body
                })),
            )
            .await?;
        parse_json(resp).await
    }

    /// 关闭一个评审。界面暂无入口,live 测试清理与将来的"撤回提交审核"共用。
    pub async fn close_pull(&self, owner: &str, repo: &str, number: u64) -> Result<(), AppError> {
        self.send(
            self.request(
                reqwest::Method::PATCH,
                self.api(&format!("/repos/{owner}/{repo}/pulls/{number}")),
            )
            .json(&serde_json::json!({ "state": "closed" })),
        )
        .await?;
        Ok(())
    }

    /// 目标库当前开放的合并请求(v7 任务 2「审核态」)。
    ///
    /// **翻页到空**,不赌"开放 PR 数永远小于某个默认页大小"——躺久的审核请求
    /// 掉出第一页会静默截断,表现是「审核中」凭空消失、分享按钮回来、用户重复
    /// 提交,恰是这整个功能存在的理由。每页 [`PULLS_PAGE_SIZE`] 条。
    ///
    /// 🔴 **停止条件是"这一页空了"(`raw.is_empty()`),不是"这一页比页大小少"**
    /// (修复轮 2 改,原实现的教训):按数量比较在服务端把 `limit` 截得比我们要求
    /// 的更小时(比如某个部署把响应硬上限设成 20)会提前判定"到底了"——第一页
    /// 拿到 20 条(< 50)就 `break`,后面的页再也不会去要,静默截断原样重演一次。
    /// 空页判据对"服务端到底给多大一页"不敏感,只要 `page` 参数被服务端尊重,
    /// 迟早会拿到一页真正的空数组。
    ///
    /// 🔴 **代价:正常情况下恒定多发一趟请求**——哪怕开放 PR 只有几条、一页就
    /// 装得下,也必须再问一次第 2 页确认它是空的才敢停,不能靠"这一页没装满"
    /// 就推断"后面没有了"(那正是上一条要消灭的静默截断)。典型场景(几条开放
    /// 提交审核)因此是 **2 次**请求,不是修复轮 1 那版按数量比较时的 1 次——
    /// 调用方(`commands::list_open_builtin_pulls` 的文档)按这个真实次数写,
    /// 不要照抄"一次请求"这句已经不成立的旧说法。
    ///
    /// 🔴 **两层止损,防的是"服务端不尊重 `page` 参数"这个相反的极端**:如果服务端
    /// 完全忽略 `page`(反向代理丢了 query string、或部署本身有 bug),每一页都会
    /// 原样返回同一批非空数据,空页判据永远等不到——翻页会**转到 [`PULLS_MAX_PAGES`]
    /// 页就止损**,同时整趟查询包着 [`PULLS_QUERY_DEADLINE`] 的**总耗时**上限
    /// (单次请求各自还有调用方给的 `app_http_client_with_timeout`,但那管不住
    /// 翻页反复调用的总时长)。两条中任一条命中都当作"这次查询失败",交回调用方
    /// 走既有的按本地证据降级的路——这条路本来就是为"拿不到真实 PR 状态"准备的
    /// 语义,不是新开一个错误分支。
    ///
    /// **不筛选**——筛选是调用方的事(按 [`review_branch_prefix`] 把 `head_ref`
    /// 匹配回具体的技能,这样连存量分享(那些从没落过 PR 坐标的)也认得出,
    /// 不必依赖本地记账里的 `review_number`)。
    pub async fn list_open_pulls(&self, owner: &str, repo: &str) -> Result<Vec<PullBrief>, AppError> {
        match tokio::time::timeout(PULLS_QUERY_DEADLINE, self.list_open_pulls_paged(owner, repo)).await {
            Ok(result) => result,
            Err(_) => Err(AppError::new("NET_PULLS_TIMEOUT", "查询提交审核状态超时,请稍后重试").with_detail(
                format!("list_open_pulls exceeded overall deadline of {PULLS_QUERY_DEADLINE:?}"),
            )),
        }
    }

    async fn list_open_pulls_paged(&self, owner: &str, repo: &str) -> Result<Vec<PullBrief>, AppError> {
        let base = self.api(&format!("/repos/{owner}/{repo}/pulls"));
        let mut out = Vec::new();
        let mut page = 1u32;
        loop {
            let resp = self
                .send(self.request(
                    reqwest::Method::GET,
                    format!("{base}?state=open&limit={PULLS_PAGE_SIZE}&page={page}"),
                ))
                .await?;
            let raw: Vec<RawPull> = parse_json(resp).await?;
            if raw.is_empty() {
                break;
            }
            out.extend(raw.into_iter().map(|p| PullBrief {
                number: p.number,
                html_url: p.html_url,
                head_ref: p.head.git_ref,
            }));
            if page >= PULLS_MAX_PAGES {
                return Err(AppError::new(
                    "NET_PULLS_TOO_MANY",
                    "开放的提交审核数量过多,已停止查询,请稍后重试",
                )
                .with_detail(format!(
                    "list_open_pulls exceeded {PULLS_MAX_PAGES} pages of {PULLS_PAGE_SIZE} items each"
                )));
            }
            page += 1;
        }
        Ok(out)
    }

    async fn http_send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, AppError> {
        req.send().await.map_err(|e| {
            if is_unreachable(&e) {
                AppError::new(
                    "NET_UNREACHABLE",
                    "连不上公司技能库,请确认已接入公司内网或 VPN",
                )
                .with_detail(e.to_string())
            } else {
                AppError::new("NET_REQUEST", "网络请求失败,请稍后重试").with_detail(e.to_string())
            }
        })
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, AppError> {
        let resp = self.http_send(req).await?;
        check_status(resp).await
    }
}

/// 读链路的最小抽象(M3 任务 4):商店索引、获取与定时检查只需要这两件事,
/// Gitea 与 GitHub client 各自实现,store/acquire/scheduler 对来源类型无感。
/// 写链路(分享)刻意不进这个 trait——两家的提交/评审 API 形状完全不同,
/// 硬抽成一个接口只会得到谁都不像的东西(GitHub 侧分享归任务 5)。
pub trait RepoSource: Sync {
    fn branch_head(
        &self,
        r: &RepoRef,
    ) -> impl std::future::Future<Output = Result<BranchHead, AppError>> + Send;
    fn download_archive(
        &self,
        r: &RepoRef,
    ) -> impl std::future::Future<Output = Result<RepoArchive, AppError>> + Send;
}

impl RepoSource for GiteaClient {
    async fn branch_head(&self, r: &RepoRef) -> Result<BranchHead, AppError> {
        GiteaClient::branch_head(self, r).await
    }
    async fn download_archive(&self, r: &RepoRef) -> Result<RepoArchive, AppError> {
        GiteaClient::download_archive(self, r).await
    }
}

/// "根本没连上"的判定。这一类要提示"确认已接入内网或 VPN",不能含糊成"稍后重试"。
///
/// `is_connect()` **不涵盖 DNS 解析失败**(任务 13 的测试实测):员工不在内网时,
/// 解析不了内网域名恰恰是最常见的失败形态。顺着 source 链找 io 层错误与
/// hyper 的 dns 措辞把它们补进来。
pub(crate) fn is_unreachable(e: &reqwest::Error) -> bool {
    if e.is_timeout() || e.is_connect() {
        return true;
    }
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        if s.downcast_ref::<std::io::Error>().is_some() {
            return true;
        }
        let text = s.to_string();
        if text.contains("dns error") || text.contains("failed to lookup") {
            return true;
        }
        src = s.source();
    }
    false
}

/// Gitea 的错误响应体。两种形状都出现过,`errors` 只在部分端点上有。
#[derive(Debug, Default, Deserialize)]
struct GiteaError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    errors: Vec<String>,
}

/// 把 HTTP 状态映射成用户看得懂、且带下一步动作的错误(文案规范见 docs/terminology.md)。
async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, AppError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let parsed: GiteaError = serde_json::from_str(&body).unwrap_or_default();
    let detail = if parsed.errors.is_empty() {
        parsed.message.clone()
    } else {
        format!("{} {}", parsed.message, parsed.errors.join("; "))
    };

    let err = match status.as_u16() {
        401 => AppError::new("AUTH_INVALID", "登录已失效,请重新登录"),
        403 => AppError::new("REPO_FORBIDDEN", "你没有该技能库的操作权限"),
        404 => AppError::new("REPO_NOT_FOUND", "找不到对应的技能库或文件"),
        // Gitea 在文件 sha 不匹配时返回 422,意味着预检之后有人改动了同一个文件;
        // "已存在"同理——预检说不存在、提交时却在了,也是预检之后被人抢了先。
        // 两者都该回到预检重新确认,不该当成"技能库拒绝"让用户干瞪眼。
        422 if parsed.message.contains("sha does not match")
            || parsed.message.contains("already exists") =>
        {
            AppError::new(
                "CONFLICT_STALE",
                "这个技能在你操作期间被其他人改过了,请重新确认后再提交",
            )
        }
        422 => AppError::new("REPO_REJECTED", "技能库拒绝了这次改动"),
        s if s >= 500 => AppError::new("NET_SERVER", "技能库服务暂时不可用,请稍后重试"),
        _ => AppError::new("NET_REQUEST", "请求未能完成,请稍后重试"),
    };
    Err(err.with_detail(format!("HTTP {status}: {detail}")))
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

/// 解开仓库压缩包。二进制文件不进内存树(技能内容都是文本),但路径仍记入文件清单。
pub fn unzip_archive(bytes: &[u8]) -> Result<RepoArchive, AppError> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| {
        AppError::new("REPO_BAD_ARCHIVE", "技能库内容已损坏,请重试或联系管理员")
            .with_detail(e.to_string())
    })?;

    let mut tree = crate::core::skills::MemTree::new();
    let mut files = Vec::new();
    let mut entries: std::collections::BTreeMap<String, ArchiveEntry> = Default::default();
    let mut root: Option<String> = None;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| {
            AppError::new("REPO_BAD_ARCHIVE", "技能库内容已损坏,请重试或联系管理员")
                .with_detail(e.to_string())
        })?;
        // enclosed_name 会拒绝 `../` 之类越界路径
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        let path = path.to_string_lossy().replace('\\', "/");
        if path.is_empty() {
            continue;
        }
        if root.is_none() {
            root = path.split('/').next().map(str::to_string);
        }
        if entry.is_dir() {
            continue;
        }
        files.push(path.clone());

        // 两处都不能省:
        // 1. `& 0o777` —— zip crate 给的是完整 st_mode(可执行文件是 0o100755,高位是文件类型),
        //    不掩掉就会把 0o100755 一路传给 set_permissions,且记进日志的值也是错的;
        // 2. `filter(!= 0)` —— Gitea 只对可执行文件写 mode,普通文件给 0(实测)。
        //    那是"未记录",要当成 None;当成 0o000 落盘,文件会连读都读不了。
        let unix_mode = entry.unix_mode().map(|m| m & 0o777).filter(|m| *m != 0);

        use std::io::Read;
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_err() {
            continue;
        }
        // 文本文件同时进 tree,供技能发现扫描;二进制只进 entries
        if let Ok(text) = std::str::from_utf8(&bytes) {
            tree = tree.with_file(&path, text);
        }
        entries.insert(path, ArchiveEntry { bytes, unix_mode });
    }

    Ok(RepoArchive {
        root: root.unwrap_or_default(),
        tree,
        files,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两把尺子必须同源:`review_branch_prefix`(这个文件)与
    /// `share::review_branch`(实际生成分支名的地方)如果各自维护一份字面量,
    /// 分支名格式一变、这里没跟着变,「审核中」就会永远匹配不上。
    /// `review_branch` 内部就调用这个函数,所以这条断言在正确实现下是必然成立的
    /// ——它守的是"将来别把两者拆开各写一份"这件事。
    #[test]
    fn the_prefix_matches_what_review_branch_actually_produces() {
        let branch = crate::core::share::review_branch("weekly-report", "2026-08-28T10:00:00Z");
        assert!(branch.starts_with(&review_branch_prefix("weekly-report")));
    }

    #[test]
    fn same_origin_accepts_only_the_library_itself() {
        let base = "http://gitea.internal.example:3000";

        // 同源的不同路径都放行(评审链接就长这样)
        assert!(is_same_origin(base, "http://gitea.internal.example:3000/skills/skills/pulls/7"));

        // 异 host / 异端口 / 异 scheme 一律拒绝
        assert!(!is_same_origin(base, "http://evil.example/skills"));
        assert!(!is_same_origin(base, "http://gitea.internal.example:8080/x"));
        assert!(!is_same_origin(base, "https://gitea.internal.example:3000/x"));

        // 非 http(s) 的 scheme 绝不放行,哪怕字符串上"同域"
        assert!(!is_same_origin(base, "javascript:alert(1)"));
        assert!(!is_same_origin(base, "file:///etc/hosts"));

        // 默认端口等价:https 的 443 显式与省略等价
        assert!(is_same_origin("https://g.example", "https://g.example:443/pulls/1"));

        // 解析不动的输入按不放行处理
        assert!(!is_same_origin(base, "不是链接"));
        assert!(!is_same_origin("也不是", "http://g.example/"));
    }

    #[test]
    fn file_change_encodes_content_as_base64() {
        let change = FileChange::create("skills/a/SKILL.md", "内容".as_bytes());
        assert_eq!(change.operation, FileOperation::Create);
        assert_eq!(change.content.as_deref(), Some("5YaF5a65"));
        assert!(change.sha.is_none());

        let update = FileChange::update("a.md", b"x", "abc123");
        assert_eq!(update.operation, FileOperation::Update);
        assert_eq!(update.sha.as_deref(), Some("abc123"));
    }

    #[test]
    fn change_files_request_omits_new_branch_when_absent() {
        let req = ChangeFilesRequest {
            branch: "main".into(),
            new_branch: None,
            message: "保存".into(),
            files: vec![FileChange::create("a.md", b"x")],
        };
        let json = serde_json::to_value(&req).unwrap();
        assert!(json.get("new_branch").is_none());
        assert_eq!(json["files"][0]["operation"], "create");
        // 新建文件不带 sha,否则 Gitea 会拒绝
        assert!(json["files"][0].get("sha").is_none());
        // 请求体里除了这四个键不该多出别的(拼错的字段名会以"多出一个键"的形式露出来)
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["branch", "message", "files"]);
    }

    #[test]
    fn change_files_request_spells_new_branch_the_way_gitea_expects() {
        // 这条测试是补上来的:原先只有上面那句 `get("new_branch").is_none()`,
        // 它在字段被序列化成 `newBranch` 时**同样通过**,于是 rename_all 把
        // "开分支提交审核"悄悄变成"直推 main"却没有任何测试变红。
        // 断言必须查"键在、且正是这个拼法"。
        let req = ChangeFilesRequest {
            branch: "main".into(),
            new_branch: Some("share/weekly-report".into()),
            message: "保存".into(),
            files: vec![FileChange::create("a.md", b"x")],
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["new_branch"], "share/weekly-report");
        assert!(
            json.get("newBranch").is_none(),
            "驼峰拼法会被 Gitea 静默忽略,提交审核会退化成直推 main"
        );
    }

    #[test]
    fn base_url_trailing_slash_is_normalized() {
        let c = GiteaClient::new("http://example.internal:3000/", None).unwrap();
        assert_eq!(c.api("/user"), "http://example.internal:3000/api/v1/user");
    }

    #[test]
    fn unzip_uses_archive_root_and_skips_binary() {
        // Gitea 压缩包的顶层目录是仓库名
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.add_directory("team-skills/", opts).unwrap();
            w.start_file("team-skills/skills/a/SKILL.md", opts).unwrap();
            std::io::Write::write_all(&mut w, b"---\nname: a\ndescription: d\n---\n").unwrap();
            w.start_file("team-skills/logo.png", opts).unwrap();
            std::io::Write::write_all(&mut w, &[0xff, 0xd8, 0xff, 0xe0]).unwrap();
            w.finish().unwrap();
        }

        let archive = unzip_archive(&buf).unwrap();
        assert_eq!(archive.root, "team-skills");
        assert!(archive.files.contains(&"team-skills/logo.png".to_string()));
        // 二进制文件记入清单但不进内存树
        use crate::core::skills::SkillTree;
        assert!(archive.tree.is_file("team-skills/skills/a/SKILL.md"));
        assert!(!archive.tree.is_file("team-skills/logo.png"));
    }
}
