//! 「与库里不同」的逐文件比较(0.8.0 任务 2)。
//!
//! 钉四件事:①本地按 `converge::locate` 定位(本体在工具目录里也比对得上);
//! ②库里取的是**索引那一版**(按 commit sha 下压缩包,不是分支名);③库内路径用
//! 索引的真实路径(fixture 故意不放在 `skills/` 下,与目录名是两个概念);
//! ④回传的 `remoteHash` 就是调用方给的那一版指纹(下游「已保留」记它)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::compare::{compare_with_library, LibraryVersion};
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::share::FileDiff;
use skillsync_lib::core::state::Store;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct TmpEnv {
    home: PathBuf,
    vars: HashMap<String, String>,
}

impl AgentEnv for TmpEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

/// 分段 join(Windows 上 `join("a/b")` 会保留字面斜杠,见 CLAUDE.md)。
fn join_rel<P: AsRef<Path>>(base: P, rel: &str) -> PathBuf {
    rel.split('/').filter(|s| !s.is_empty()).fold(base.as_ref().to_path_buf(), |p, s| p.join(s))
}

const SHA: &str = "abc123def456";
/// 库内真实路径——**故意不是** `skills/<目录名>`。
const SKILL_PATH: &str = "catalog/my-notes";

fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
    use std::io::Write as _;
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (p, body) in files {
            w.start_file(format!("repo/{p}"), opts).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }
    buf
}

/// 只在 **commit sha** 那个地址上挂压缩包:实现若按分支名取,拿到的是 404。
async fn mount_archive_at_sha(server: &MockServer, files: &[(&str, &str)]) {
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/repos/skills/skills/archive/{SHA}.zip")))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_of(files)))
        .mount(server)
        .await;
}

fn write(dir: &Path, rel: &str, body: &str) {
    let p = join_rel(dir, rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn at() -> RepoRef {
    RepoRef { owner: "skills".into(), repo: "skills".into(), branch: SHA.into() }
}

const MD_LOCAL: &str = "---\nname: my-notes\ndescription: 笔记\n---\n本地这一版\n";
const MD_LIB: &str = "---\nname: my-notes\ndescription: 笔记\n---\n库里这一版\n";

#[tokio::test]
async fn compares_the_body_in_a_tool_dir_against_the_indexed_library_version() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone(), vars: HashMap::new() };
    let store = Store::new(home.join(".skillsync"));
    // 本体住在 Claude Code 的目录里,没有任何记账——canonical 上什么都没有
    let body = join_rel(&home, ".claude/skills/my-notes");
    write(&body, "SKILL.md", MD_LOCAL);
    write(&body, "mine-only.md", "只有我有\n");
    write(&body, "same.md", "两边一样\n");

    let server = MockServer::start().await;
    mount_archive_at_sha(
        &server,
        &[
            (&format!("{SKILL_PATH}/SKILL.md"), MD_LIB),
            (&format!("{SKILL_PATH}/same.md"), "两边一样\n"),
            (&format!("{SKILL_PATH}/lib-only.md"), "只有库里有\n"),
            ("catalog/other/SKILL.md", "别的技能,不该混进来\n"),
        ],
    )
    .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = compare_with_library(
        &client,
        &AgentRegistry::builtin(),
        &env,
        &store,
        "my-notes",
        LibraryVersion { at: &at(), skill_path: SKILL_PATH, content_hash: "h-lib" },
    )
    .await
    .expect("应当比得出来");

    assert_eq!(PathBuf::from(&got.local_path), body, "必须比的是工具目录里的本体");
    assert_eq!(got.remote_hash, "h-lib", "回传的就是调用方给的那一版指纹");
    assert!(!got.identical);
    let added: Vec<_> = got.plan.added.iter().map(|f| f.path.as_str()).collect();
    let modified: Vec<_> = got.plan.modified.iter().map(|f| f.path.as_str()).collect();
    let deleted: Vec<_> = got.plan.deleted.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(added, ["mine-only.md"]);
    assert_eq!(modified, ["SKILL.md"]);
    assert_eq!(deleted, ["lib-only.md"], "别的技能的文件不该混进来");
    assert!(matches!(got.plan.modified[0].diff, FileDiff::Hunks { .. }));
}

#[tokio::test]
async fn identical_content_is_reported_as_identical() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone(), vars: HashMap::new() };
    let store = Store::new(home.join(".skillsync"));
    write(&join_rel(&home, ".agents/skills/my-notes"), "SKILL.md", MD_LIB);

    let server = MockServer::start().await;
    mount_archive_at_sha(&server, &[(&format!("{SKILL_PATH}/SKILL.md"), MD_LIB)]).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = compare_with_library(
        &client,
        &AgentRegistry::builtin(),
        &env,
        &store,
        "my-notes",
        LibraryVersion { at: &at(), skill_path: SKILL_PATH, content_hash: "h" },
    )
    .await
    .unwrap();
    assert!(got.identical);
    assert!(got.plan.added.is_empty() && got.plan.modified.is_empty() && got.plan.deleted.is_empty());
}

#[tokio::test]
async fn a_library_version_without_this_skill_is_a_refresh_error_not_an_all_added_plan() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone(), vars: HashMap::new() };
    let store = Store::new(home.join(".skillsync"));
    write(&join_rel(&home, ".agents/skills/my-notes"), "SKILL.md", MD_LOCAL);

    let server = MockServer::start().await;
    mount_archive_at_sha(&server, &[("catalog/other/SKILL.md", "x\n")]).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let err = compare_with_library(
        &client,
        &AgentRegistry::builtin(),
        &env,
        &store,
        "my-notes",
        LibraryVersion { at: &at(), skill_path: SKILL_PATH, content_hash: "h" },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "REPO_NOT_FOUND");
    // 错误码与"压缩包 404"撞同一个值(注入验证实测:按分支名取时这条照样绿),
    // 所以正面断言是**这一版里没有这个技能**那句话,不是下载失败
    assert!(err.message.contains("那一版里找不到"), "{err:?}");
}

#[tokio::test]
async fn no_local_body_is_reported_before_any_network_request() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone(), vars: HashMap::new() };
    let store = Store::new(home.join(".skillsync"));

    let server = MockServer::start().await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let err = compare_with_library(
        &client,
        &AgentRegistry::builtin(),
        &env,
        &store,
        "my-notes",
        LibraryVersion { at: &at(), skill_path: SKILL_PATH, content_hash: "h" },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "FS_NOT_FOUND");
    assert!(server.received_requests().await.unwrap().is_empty(), "本地都没有,不该去下压缩包");
}
