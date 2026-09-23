//! 读单个文件的内容(v8 任务 9):详情面板的文件列表点击预览,以及分享确认屏里
//! 「新增文件」的按需读(v8 任务 8 刻意没把新增文件的内容随清单一起传,见
//! [`crate::core::share::AddedFile`])。
//!
//! 三条取数通道 + 一档"看不了":
//!
//! | 通道 | 版本 | 缓存 |
//! |---|---|---|
//! | 本地([`read_local`]) | 磁盘此刻的字节 | 🔴 **不缓存** |
//! | 公司 Gitea([`read_gitea`]) | 🔴 **按列表那一版的 `commit_sha`**(`?ref=<sha>`) | 键带 sha |
//! | 技能广场([`read_plaza`]) | 复用详情那次拉到的 blob 快照 | 键带 sha(会话键,见下) |
//! | 自定义 GitHub 源 | —— | —— 直接返回 [`FileContent::Unavailable`] |
//!
//! # 为什么本地不缓存
//!
//! 本地内容随时在变(用户正在 Claude Code 里改它是这个项目的常态)。缓存它就是在
//! 撒谎——尤其是分享确认屏那一路:v8 任务 8 的清单指纹绑定就是为了防"看到的不是
//! 要推的",在这里缓存一份旧内容等于把那个窗重新打开。
//!
//! # 缓存只在进程内,不落盘
//!
//! 与广场详情缓存同一取舍:预览的内容"很可能只看一眼",落盘只会积累孤儿缓存文件。
//! 两份缓存都是 `Mutex<HashMap>`,**由调用方传入**——`commands.rs` 里各有一个
//! `OnceLock` 单例;测试用局部实例,互不脏读(与 `cached_plaza_detail` 同一套写法)。

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::core::fsops;
use crate::core::gitea::{GiteaClient, RepoRef};
use crate::core::local_detail;
use crate::core::plaza::{self, BlobFile};
use crate::core::share::{self, DeletedBody, SizeLimit};
use crate::error::AppError;

/// 一个文件的内容。前三档与 [`DeletedBody`] **逐一对应**(同一处判定产出,
/// 见 [`classify`]),多出来的只有 [`FileContent::Unavailable`]。
///
/// **为什么不直接复用 `DeletedBody`**:被删文件的远端内容永远在那一轮快照里,
/// 不存在"拿不到"这回事,那个类型因此没有、也不该有"看不了"这一档;而预览这边
/// 自定义 GitHub 源确实拿不到(设计 Q15)。给 `DeletedBody` 加一档会让分享确认屏
/// 多一个永远走不到的分支。serde 属性逐字抄 T8(`tag = "kind"` + `rename_all_fields`)
/// ——界面拿到的形状与 `DeletedBody` 完全一致,只是多一个 `unavailable`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FileContent {
    Text { text: String },
    /// 非 UTF-8(设计 Q14,按内容判不按扩展名)。文案只能说「这不是文本格式,看不了
    /// 内容」——UTF-16 文本也会落进这一档,不能说"这是图片"。
    Binary,
    /// 超 256KB **或** 2000 行(设计 Q12),`limit` 说清是哪条超了。刻意不带正文。
    TooLarge { limit: SizeLimit, bytes: u64, lines: usize },
    /// 🔴 **这个来源看不了文件内容**(设计 Q15,目前只有自定义 GitHub 源)。
    ///
    /// 是一个明确的变体,**不是错误**(错误让界面去猜"是不是网络坏了、要不要重试"),
    /// **也不是空内容**(空内容会被当成"这是个空文件",那是假话)。
    Unavailable,
}

/// 映射,不是第二份判定:三档一一对应。
impl From<DeletedBody> for FileContent {
    fn from(body: DeletedBody) -> Self {
        match body {
            DeletedBody::Text { text } => Self::Text { text },
            DeletedBody::Binary => Self::Binary,
            DeletedBody::TooLarge { limit, bytes, lines } => Self::TooLarge { limit, bytes, lines },
        }
    }
}

/// 字节 → 内容档。🔴 **二进制与超限的判定只有一处**:[`share::file_body`]
/// (v8 任务 8 给被删文件写的那个函数)。这里只做映射,不另写一份。
pub fn classify(bytes: &[u8]) -> FileContent {
    share::file_body(bytes).into()
}

// ============================================================ 本地

/// 读本机某个技能本体目录下的一个文件。**每次都读盘,不缓存**(见模块头)。
///
/// `skill_dir` 必须来自既有的本体解析出口(`converge::home_of` 那一路,由
/// `commands::resolve_local_skill_dir` 给),**不要按 canonical 拼路径**。
/// 守卫与 [`local_detail`] 同一套:先 `ensure_skill_dir`(存在 + 含 SKILL.md),
/// 再 `fsops::safe_join`(越界拒绝)。
pub fn read_local(skill_dir: &Path, rel: &str) -> Result<FileContent, AppError> {
    local_detail::ensure_skill_dir(skill_dir)?;
    check_rel(rel)?;
    // 分段检查之后再过一道 `safe_join`(词法归一化 + 前缀比对),与 local_detail /
    // 安装落盘同一个原语。它自己的文案是「…已中止安装」,对一次读操作是假话,换掉。
    let file = fsops::safe_join(skill_dir, rel).map_err(|e| unsafe_path(rel).with_detail(
        e.detail.unwrap_or_default(),
    ))?;
    if !file.is_file() {
        return Err(not_found(rel));
    }
    let bytes = std::fs::read(&file).map_err(|e| {
        AppError::new("FS_READ_FAILED", "读取这个文件失败,请重试")
            .with_detail(format!("read {}: {e}", file.display()))
    })?;
    Ok(classify(&bytes))
}

/// 相对技能目录的路径必须老老实实待在目录里:不许空、不许绝对路径、
/// 不许 `.`/`..`/空段、不许反斜杠(Windows 上 `a\..\b` 是另一种越界写法)。
/// 远端两条通道拿它拼 URL 之前先过这一道——越界的请求一个都不发。
fn check_rel(rel: &str) -> Result<(), AppError> {
    let bad = rel.is_empty()
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..");
    if bad {
        return Err(unsafe_path(rel));
    }
    Ok(())
}

fn unsafe_path(rel: &str) -> AppError {
    AppError::new("FS_UNSAFE_PATH", "这个文件路径不在技能文件夹里,不能打开")
        .with_detail(format!("unsafe path: {rel}"))
}

fn not_found(rel: &str) -> AppError {
    AppError::new("FS_FILE_NOT_FOUND", "这个文件已经不在了,请刷新后再看")
        .with_detail(format!("missing: {rel}"))
}

/// 远端(技能库 / 广场)那一版里没有这个文件。**是错误,不是空内容**。
fn remote_not_found(detail: String) -> AppError {
    AppError::new("REPO_FILE_NOT_FOUND", "技能库里的这一版没有这个文件,请刷新后再看")
        .with_detail(detail)
}

// ============================================================ 公司 Gitea

/// Gitea 文件缓存的键。🔴 **带 `commit_sha`**:同一路径在两个版本里是两个文件。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GiteaFileKey {
    pub registry_id: String,
    pub repo_key: String,
    pub commit_sha: String,
    /// 完整远端路径(`skills/<slug>/<rel>`)。
    pub path: String,
}

pub type GiteaFileCache = Mutex<HashMap<GiteaFileKey, FileContent>>;

/// 按**列表那一版**读公司 Gitea 上的一个文件。
///
/// `commit_sha` 取自详情面板那份索引的 `commit_sha`(文件列表就是从它来的)。
/// 按分支头取的后果是"列表里有、拉回来 404",或者更隐蔽的——拉回来的内容与
/// 列表那一版对不上(设计顾问③)。
pub async fn read_gitea(
    client: &GiteaClient,
    cache: &GiteaFileCache,
    registry_id: &str,
    repo: &RepoRef,
    commit_sha: &str,
    skill_path: &str,
    rel: &str,
) -> Result<FileContent, AppError> {
    check_rel(rel)?;
    check_rel(skill_path)?;
    // 空 sha 拼出来的是 `?ref=`,Gitea 会按默认分支取——正是这个任务要堵的那条路。
    // 索引正常总有 sha,空了说明调用方拿错了东西,直说,不退回分支头。
    if commit_sha.is_empty() {
        return Err(AppError::new(
            "REPO_FILE_NO_VERSION",
            "不知道要看的是技能库里的哪一版,请刷新列表后再试",
        ));
    }
    let key = GiteaFileKey {
        registry_id: registry_id.to_string(),
        repo_key: crate::core::registry::repo_key(&repo.owner, &repo.repo),
        commit_sha: commit_sha.to_string(),
        path: format!("{skill_path}/{rel}"),
    };
    if let Some(hit) = cache.lock().expect("文件预览缓存锁不该中毒").get(&key).cloned() {
        return Ok(hit);
    }
    let Some((_, bytes)) = client.file_content_at(repo, &key.path, commit_sha).await? else {
        return Err(remote_not_found(format!("{}@{commit_sha}", key.path)));
    };
    let content = classify(&bytes);
    // 只缓存成功的结果:网络失败、404 不粘住,下次点开还会重试。
    cache.lock().expect("文件预览缓存锁不该中毒").insert(key, content.clone());
    Ok(content)
}

// ============================================================ 技能广场

/// 广场文件缓存的键。`commit_sha` 在这里是**会话键,不是内容承诺**:
/// skills.sh 的 blob 端点没有 ref 参数,拿回来的永远是它"现在"那一版。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PlazaFileKey {
    pub repo_key: String,
    pub commit_sha: String,
    pub dir_slug: String,
}

/// 值是整个技能目录的文件(相对技能目录的路径 → 字节)。blob 一次就拿全了。
pub type PlazaFileCache = Mutex<HashMap<PlazaFileKey, Arc<BTreeMap<String, Vec<u8>>>>>;

/// 把详情那次拉到的 blob 快照记下来,供之后点开文件时复用(零新请求)。
pub fn stash_plaza_files(cache: &PlazaFileCache, key: PlazaFileKey, files: &[BlobFile]) {
    // `contents` 按字节用(见 `BlobFile` 的文档),与落盘/指纹同一口径。
    let map: BTreeMap<String, Vec<u8>> = files
        .iter()
        .map(|f| (f.path.clone(), f.contents.as_bytes().to_vec()))
        .collect();
    cache.lock().expect("文件预览缓存锁不该中毒").insert(key, Arc::new(map));
}

/// 读广场技能的一个文件。命中缓存 → **零请求**;未命中(详情走的是整仓 zipball
/// 回退路径,或进程刚重启)→ 按目录名发**一次**目录级 blob 请求拿全、记下,再取。
pub async fn read_plaza(
    cache: &PlazaFileCache,
    http: &reqwest::Client,
    api_base: &str,
    key: PlazaFileKey,
    rel: &str,
) -> Result<FileContent, AppError> {
    check_rel(rel)?;
    let hit = cache.lock().expect("文件预览缓存锁不该中毒").get(&key).cloned();
    let files = match hit {
        Some(files) => files,
        None => {
            // 按**仓内目录名**取:blob 端点对 skills.sh 的 skillId 与目录名两个键都认
            // (CLAUDE.md「技能广场的 blob 快照」ground truth 5),而这里手上只有
            // 目录名——它来自详情的 `dir_slug`,是仓库树/压缩包算出来的真名。
            let (owner, repo) = key.repo_key.split_once('/').ok_or_else(|| {
                plaza::plaza_blob_err(format!("bad repo key: {}", key.repo_key))
            })?;
            let blob = plaza::fetch_blob(http, api_base, owner, repo, &key.dir_slug).await?;
            stash_plaza_files(cache, key.clone(), &blob);
            cache
                .lock()
                .expect("文件预览缓存锁不该中毒")
                .get(&key)
                .cloned()
                .expect("刚写进去的")
        }
    };
    match files.get(rel) {
        Some(bytes) => Ok(classify(bytes)),
        None => Err(remote_not_found(format!("{}/{}: {rel}", key.repo_key, key.dir_slug))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill_dir(tmp: &tempfile::TempDir) -> std::path::PathBuf {
        let dir = tmp.path().join("weekly-report");
        std::fs::create_dir_all(dir.join("templates")).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: d\n---\n")
            .unwrap();
        std::fs::write(dir.join("templates/dept.md"), "第一版").unwrap();
        dir
    }

    /// 测试清单 1(正向):正常路径读得到。
    #[test]
    fn local_reads_a_file_inside_the_skill_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(&tmp);
        assert_eq!(
            read_local(&dir, "templates/dept.md").unwrap(),
            FileContent::Text { text: "第一版".into() }
        );
    }

    /// 测试清单 1(反向):`../` 越界被拒——哪怕目标文件真的存在。
    #[test]
    fn local_rejects_a_path_that_escapes_the_skill_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(&tmp);
        std::fs::write(tmp.path().join("secret.txt"), "不该被读到").unwrap();
        let err = read_local(&dir, "../secret.txt").unwrap_err();
        assert_eq!(err.code, "FS_UNSAFE_PATH");
        assert!(!err.message.contains("安装"), "读操作不能说「已中止安装」: {}", err.message);
    }

    /// 本体目录不是技能(没有 SKILL.md)→ 与 local_detail 同一道守卫。
    #[test]
    fn local_refuses_a_dir_that_is_not_a_skill() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.md"), "x").unwrap();
        assert_eq!(read_local(tmp.path(), "a.md").unwrap_err().code, "FS_NOT_A_SKILL");
    }

    /// 文件不在了 → 明确错误,不是空内容。
    #[test]
    fn local_missing_file_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(&tmp);
        assert_eq!(read_local(&dir, "nope.md").unwrap_err().code, "FS_FILE_NOT_FOUND");
    }

    /// 🔴 测试清单 2:两次读之间改文件 → 第二次读到**新内容**(钉住"本地不缓存")。
    #[test]
    fn local_reads_are_never_cached() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(&tmp);
        assert_eq!(
            read_local(&dir, "templates/dept.md").unwrap(),
            FileContent::Text { text: "第一版".into() }
        );
        std::fs::write(dir.join("templates/dept.md"), "改过之后").unwrap();
        assert_eq!(
            read_local(&dir, "templates/dept.md").unwrap(),
            FileContent::Text { text: "改过之后".into() }
        );
    }

    /// 测试清单 9:非 UTF-8 → 二进制档(按内容判,扩展名是 .md 也一样)。
    #[test]
    fn non_utf8_is_binary_even_with_a_text_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(&tmp);
        std::fs::write(dir.join("notes.md"), [0xff, 0xfe, 0x00, 0x41]).unwrap();
        assert_eq!(read_local(&dir, "notes.md").unwrap(), FileContent::Binary);
    }

    /// 测试清单 9:超 256KB(行数不超)→ 超限档,说清是字节那条。
    #[test]
    fn over_256kb_is_too_large_by_bytes() {
        let big = "a".repeat(256 * 1024 + 1);
        assert!(matches!(
            classify(big.as_bytes()),
            FileContent::TooLarge { limit: SizeLimit::Bytes, lines: 1, .. }
        ));
    }

    /// 测试清单 9:超 2000 行(字节不超)→ 超限档,说清是行数那条。
    #[test]
    fn over_2000_lines_is_too_large_by_lines() {
        let many = "x\n".repeat(2001);
        assert!(matches!(
            classify(many.as_bytes()),
            FileContent::TooLarge { limit: SizeLimit::Lines, lines: 2001, .. }
        ));
    }

    /// 界面读的是这个形状:`kind` 标签 + camelCase 字段,与 `DeletedBody` 同款。
    #[test]
    fn serializes_as_a_tagged_union() {
        let v = serde_json::to_value(FileContent::TooLarge {
            limit: SizeLimit::Both,
            bytes: 9,
            lines: 8,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"kind":"tooLarge","limit":"both","bytes":9,"lines":8}));
        assert_eq!(
            serde_json::to_value(FileContent::Unavailable).unwrap(),
            serde_json::json!({"kind":"unavailable"})
        );
    }

    // ------------------------------------------------------------ 广场

    fn plaza_key() -> PlazaFileKey {
        PlazaFileKey {
            repo_key: "vercel-labs/skills".into(),
            commit_sha: "aaa1111".into(),
            dir_slug: "weekly-report".into(),
        }
    }

    fn blob(path: &str, contents: &str) -> BlobFile {
        BlobFile { path: path.into(), contents: contents.into() }
    }

    /// 已记下的 blob → 读文件**零请求**(任意路径 `.expect(0)`)。
    #[tokio::test]
    async fn plaza_read_from_a_stashed_blob_sends_no_request() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::any())
            .respond_with(wiremock::ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let cache: PlazaFileCache = Mutex::new(HashMap::new());
        stash_plaza_files(&cache, plaza_key(), &[blob("SKILL.md", "# x"), blob("a/b.md", "正文")]);

        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let got = read_plaza(&cache, &http, &server.uri(), plaza_key(), "a/b.md").await.unwrap();
        assert_eq!(got, FileContent::Text { text: "正文".into() });
        server.verify().await;
    }

    /// 未命中 → 按**目录名**发一次目录级 blob 请求,之后同目录的其它文件零请求。
    #[tokio::test]
    async fn plaza_miss_fetches_the_directory_once() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/api/download/vercel-labs/skills/weekly-report"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "files": [
                    {"path": "SKILL.md", "contents": "# x"},
                    {"path": "a/b.md", "contents": "正文"}
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let cache: PlazaFileCache = Mutex::new(HashMap::new());
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let a = read_plaza(&cache, &http, &server.uri(), plaza_key(), "a/b.md").await.unwrap();
        let b = read_plaza(&cache, &http, &server.uri(), plaza_key(), "SKILL.md").await.unwrap();
        assert_eq!(a, FileContent::Text { text: "正文".into() });
        assert_eq!(b, FileContent::Text { text: "# x".into() });
        server.verify().await;
    }

    /// 快照里没有这个文件 → 明确错误,不是空内容。
    #[tokio::test]
    async fn plaza_file_not_in_the_snapshot_is_an_error() {
        let cache: PlazaFileCache = Mutex::new(HashMap::new());
        stash_plaza_files(&cache, plaza_key(), &[blob("SKILL.md", "# x")]);
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let err = read_plaza(&cache, &http, "http://unused.invalid", plaza_key(), "gone.md")
            .await
            .unwrap_err();
        assert_eq!(err.code, "REPO_FILE_NOT_FOUND");
    }
}
