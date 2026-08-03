//! GitHub 分享写路径(M3-5b)的权限矩阵测试。
//!
//! 全部响应形状取自真实录制(tests/fixtures/github-write/,2026-08-03):
//! 请求体断言对齐录制 03 的输入格式(expectedHeadOid / base64 contents),
//! 错误分支对齐录制 04/09 的 `errors[].type`。
//! 断言纪律与 share_flow 一致:守卫类断言盯请求体,不只盯返回值。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::gitea::RepoRef;
use skillsync_lib::core::share::{self, ShareMode, ShareOutcome, SharePrecheck, ShareClient};
use skillsync_lib::core::state::Store;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-08-03T09:00:00.000Z";
// review_branch 由 NOW 派生:数字全拼
const REVIEW_BRANCH: &str = "skillsync/my-notes-20260803090000000";

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

struct Ctx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    registry: AgentRegistry,
    store: Store,
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = Store::new(home.join(".skillsync"));
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
        },
        env,
    )
}

fn write_skill(dir: &Path, name: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: 说明\n---\n正文\n"),
    )
    .unwrap();
}

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "team".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

fn client(server: &MockServer) -> GithubClient {
    GithubClient::new(&server.uri(), Some("t0ken".into()), reqwest::Client::new())
}

fn share_req<'a>(repo: &'a RepoRef, dir: &'a Path, name: &'a str) -> share::ShareRequest<'a> {
    share::ShareRequest {
        registry_id: "gh-src",
        repo,
        source_path: dir,
        share_name: name,
        display_name: None,
        description: None,
        origin: "local",
        overwrite: false,
    }
}

/// 录制 01/02/03 形状的基础 mock:可写仓、未保护 main、精检查无同名。
async fn mount_basics(server: &MockServer, push: bool, protected: bool) {
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/team/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "full_name": "team/skills",
            "permissions": { "admin": false, "push": push, "pull": true },
            "default_branch": "main",
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/team/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "protected": protected,
            "commit": { "sha": "facd0e5854ab8106e300e3f2933e5afbb48d736a",
                        "commit": { "committer": { "date": "2026-08-03T08:00:00Z" } } },
        })))
        .mount(server)
        .await;
    // 预检:远端没有同名技能
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/team/skills/contents/skills/my-notes/SKILL.md"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "message": "Not Found"
        })))
        .mount(server)
        .await;
}

fn gql_ok(oid: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(serde_json::json!({
        "data": { "createCommitOnBranch": { "commit": { "oid": oid } } }
    }))
}

fn gql_error(kind: &str, message: &str) -> ResponseTemplate {
    // 录制 04/09:错误在 HTTP 200 里,data 为 null
    ResponseTemplate::new(200).set_body_json(serde_json::json!({
        "data": { "createCommitOnBranch": null },
        "errors": [{ "type": kind, "path": ["createCommitOnBranch"], "message": message }]
    }))
}

// ============================================================ 权限矩阵

#[tokio::test]
async fn push_and_unprotected_saves_directly() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "我的笔记");

    let server = MockServer::start().await;
    mount_basics(&server, true, false).await;
    // 断言输入形状对齐录制 03:期望头、分支名、base64 后的文件内容
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .and(body_string_contains("facd0e5854ab8106e300e3f2933e5afbb48d736a"))
        .and(body_string_contains("\"branchName\":\"main\""))
        .and(body_string_contains("skills/my-notes/SKILL.md"))
        .respond_with(gql_ok("e0ecf23eea0efcc72f5cbb54a96150dfbe3efd36"))
        .expect(1)
        .mount(&server)
        .await;

    let gh = client(&server);
    let repo = repo_ref();
    let outcome = share::share(
        &ShareClient::Github(&gh),
        &c.registry,
        &env,
        &c.store,
        share_req(&repo, &dir, "my-notes"),
        NOW,
    )
    .await
    .unwrap();

    match outcome {
        ShareOutcome::Shared { mode, commit_sha, review_url, .. } => {
            assert_eq!(mode, ShareMode::Pushed);
            assert_eq!(commit_sha, "e0ecf23eea0efcc72f5cbb54a96150dfbe3efd36");
            assert!(review_url.is_none());
        }
        other => panic!("expected Shared, got {other:?}"),
    }
    // 记账落了 shared
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.shared.len(), 1);
    assert_eq!(state.shared[0].name, "my-notes");
}

#[tokio::test]
async fn push_but_protected_goes_review() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "我的笔记");

    let server = MockServer::start().await;
    mount_basics(&server, true, true).await;
    // 保护先探为 true:不应对 main 发过任何提交,直接开分支
    Mock::given(method("POST"))
        .and(path("/api/v3/repos/team/skills/git/refs"))
        .and(body_string_contains(REVIEW_BRANCH))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "ref": format!("refs/heads/{REVIEW_BRANCH}"),
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .and(body_string_contains(REVIEW_BRANCH))
        .respond_with(gql_ok("367cf1e2116316eca0dea34a4d1acd9e2a731820"))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v3/repos/team/skills/pulls"))
        .and(body_string_contains(REVIEW_BRANCH))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "number": 1,
            "html_url": "https://github.example/team/skills/pull/1",
        })))
        .expect(1)
        .mount(&server)
        .await;

    let gh = client(&server);
    let repo = repo_ref();
    let outcome = share::share(
        &ShareClient::Github(&gh),
        &c.registry,
        &env,
        &c.store,
        share_req(&repo, &dir, "my-notes"),
        NOW,
    )
    .await
    .unwrap();

    match outcome {
        ShareOutcome::Shared { mode, review_url, .. } => {
            assert_eq!(mode, ShareMode::ReviewRequested);
            assert_eq!(review_url.as_deref(), Some("https://github.example/team/skills/pull/1"));
        }
        other => panic!("expected Shared, got {other:?}"),
    }
}

#[tokio::test]
async fn protection_violation_on_submit_degrades_to_review() {
    // protected 先探是 false,但提交撞上 BRANCH_PROTECTION_RULE_VIOLATION(录制 09):
    // 保护规则可能只拦部分人,错误类型才是最终真相
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "我的笔记");

    let server = MockServer::start().await;
    mount_basics(&server, true, false).await;
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .and(body_string_contains("\"branchName\":\"main\""))
        .respond_with(gql_error(
            "BRANCH_PROTECTION_RULE_VIOLATION",
            "protected branch 'main' check failed:\n  Changes must be made through a pull request.",
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v3/repos/team/skills/git/refs"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .and(body_string_contains(REVIEW_BRANCH))
        .respond_with(gql_ok("367cf1e2116316eca0dea34a4d1acd9e2a731820"))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v3/repos/team/skills/pulls"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "number": 2,
            "html_url": "https://github.example/team/skills/pull/2",
        })))
        .mount(&server)
        .await;

    let gh = client(&server);
    let repo = repo_ref();
    let outcome = share::share(
        &ShareClient::Github(&gh),
        &c.registry,
        &env,
        &c.store,
        share_req(&repo, &dir, "my-notes"),
        NOW,
    )
    .await
    .unwrap();

    match outcome {
        ShareOutcome::Shared { mode, .. } => assert_eq!(mode, ShareMode::ReviewRequested),
        other => panic!("expected Shared, got {other:?}"),
    }
}

#[tokio::test]
async fn no_push_forks_then_cross_repo_review() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "我的笔记");

    let server = MockServer::start().await;
    mount_basics(&server, false, false).await;
    // 录制 11:202 受理,响应体自带 full_name
    Mock::given(method("POST"))
        .and(path("/api/v3/repos/team/skills/forks"))
        .respond_with(ResponseTemplate::new(202).set_body_json(serde_json::json!({
            "full_name": "zhang-san/skills",
        })))
        .expect(1)
        .mount(&server)
        .await;
    // fork 就绪轮询:第一次 404(还在准备),之后可读
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/zhang-san/skills/branches/main"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "message": "Not Found"
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/zhang-san/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "sha": "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
                        "commit": { "committer": { "date": "2026-08-03T08:00:00Z" } } },
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v3/repos/zhang-san/skills/git/refs"))
        .and(body_string_contains(REVIEW_BRANCH))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .and(body_string_contains("zhang-san/skills"))
        .respond_with(gql_ok("aaaa60b01f91b314f59955a4e4d4e80d8edf11d0"))
        .expect(1)
        .mount(&server)
        .await;
    // 跨库评审:head 必须是 {fork_owner}:{branch} 形式,发到上游仓
    Mock::given(method("POST"))
        .and(path("/api/v3/repos/team/skills/pulls"))
        .and(body_string_contains(format!("zhang-san:{REVIEW_BRANCH}")))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "number": 7,
            "html_url": "https://github.example/team/skills/pull/7",
        })))
        .expect(1)
        .mount(&server)
        .await;

    let gh = client(&server);
    let repo = repo_ref();
    let outcome = share::share(
        &ShareClient::Github(&gh),
        &c.registry,
        &env,
        &c.store,
        share_req(&repo, &dir, "my-notes"),
        NOW,
    )
    .await
    .unwrap();

    match outcome {
        ShareOutcome::Shared { mode, review_url, .. } => {
            assert_eq!(mode, ShareMode::ReviewRequested);
            assert_eq!(review_url.as_deref(), Some("https://github.example/team/skills/pull/7"));
        }
        other => panic!("expected Shared, got {other:?}"),
    }
}

// ============================================================ 错误与预检

#[tokio::test]
async fn stale_head_becomes_human_readable_error() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "我的笔记");

    let server = MockServer::start().await;
    mount_basics(&server, true, false).await;
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .respond_with(gql_error(
            "STALE_DATA",
            "Expected branch to point to \"facd0e58\" but it did not.",
        ))
        .mount(&server)
        .await;

    let gh = client(&server);
    let repo = repo_ref();
    let err = share::share(
        &ShareClient::Github(&gh),
        &c.registry,
        &env,
        &c.store,
        share_req(&repo, &dir, "my-notes"),
        NOW,
    )
    .await
    .unwrap_err();

    assert_eq!(err.code, "REPO_STALE");
    // 记账没落:提交没成,不能记成已分享
    assert!(c.store.load_state().unwrap().value.shared.is_empty());
}

#[tokio::test]
async fn precheck_taken_when_remote_has_file() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/team/skills/contents/skills/my-notes/SKILL.md"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "SKILL.md", "sha": "abc",
        })))
        .mount(&server)
        .await;

    let gh = client(&server);
    let got = share::precheck(
        &ShareClient::Github(&gh),
        &repo_ref(),
        &c.store.load_state().unwrap().value,
        "my-notes",
    )
    .await
    .unwrap();
    assert_eq!(got, SharePrecheck::Taken);
}

#[tokio::test]
async fn precheck_fresh_on_404() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/team/skills/contents/skills/my-notes/SKILL.md"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "message": "Not Found"
        })))
        .mount(&server)
        .await;

    let gh = client(&server);
    let got = share::precheck(
        &ShareClient::Github(&gh),
        &repo_ref(),
        &c.store.load_state().unwrap().value,
        "my-notes",
    )
    .await
    .unwrap();
    assert_eq!(got, SharePrecheck::Fresh);
}
