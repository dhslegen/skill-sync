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
//! # 待处理:系统代理会拦截内网请求
//!
//! 客户端沿用 reqwest 的默认行为,读取系统代理设置。开发机实测:设了
//! `http_proxy` 后,发往内网地址的请求会被转给代理,连不上时拿到的是代理返回的 5xx,
//! 而不是"连接被拒"。企业机器上为访问外网普遍配了代理,若内网 Gitea 域名没进
//! `NO_PROXY`,用户会在登录这一步遇到看不懂的失败。
//!
//! 任务 13(打包分发)需要落实二选一:随包给内建 Gitea 域名设免代理,或在部署文档里
//! 要求 IT 把该域名加进 `NO_PROXY`。诊断包也应带上当前生效的代理配置。

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

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

/// 分支当前指向的提交。商店索引靠它判断"远端有没有变",避免每次都下载压缩包。
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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

/// 下载下来的仓库压缩包解开后的内容。
pub struct RepoArchive {
    /// 压缩包顶层目录名。Gitea 用仓库名(`team-skills/`),GitHub 用 `<repo>-<ref>/`,
    /// 因此扫描技能时的起始路径必须以此为准,不能写死。
    pub root: String,
    pub tree: crate::core::skills::MemTree,
    /// 全部文件的逻辑路径,用于文件树展示与"含可执行脚本"判断。
    pub files: Vec<String>,
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

    async fn http_send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, AppError> {
        req.send().await.map_err(|e| {
            if e.is_timeout() || e.is_connect() {
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
        // Gitea 在文件 sha 不匹配时返回 422,意味着预检之后有人改动了同一个文件
        422 if parsed.message.contains("sha does not match") => AppError::new(
            "CONFLICT_STALE",
            "这个技能在你操作期间被其他人改过了,请重新确认后再提交",
        ),
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

        use std::io::Read;
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_ok() {
            if let Ok(text) = String::from_utf8(buf) {
                tree = tree.with_file(&path, &text);
            }
        }
    }

    Ok(RepoArchive {
        root: root.unwrap_or_default(),
        tree,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
