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
    /// 显式注入沙盒废纸篓:`share()` 内部的 `ensure_canonical_link` 有删除路径,
    /// 而 `Installer` 的默认实现是这台机器真实的系统废纸篓。
    trash: skillsync_lib::core::fsops::SandboxTrash,
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = Store::new(home.join(".skillsync"));
    let trash = skillsync_lib::core::fsops::SandboxTrash::new(
        home.join("..").join("share-github-trash"),
    );
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
            trash,
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
    write_skill(&dir, "my-notes");

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
    let outcome = confirmed_share(
        &ShareClient::Github(&gh),
        &gh,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        "gh-src",
        &repo,
        "my-notes",
        NOW,
    )
    .await
    .unwrap();

    let ShareOutcome::Shared { mode, commit_sha, .. } = outcome else { panic!("应当分享成功,不该落进覆盖确认档") };
    assert_eq!(mode, ShareMode::Pushed);
    assert_eq!(commit_sha, "e0ecf23eea0efcc72f5cbb54a96150dfbe3efd36");
    // 记账落了 shared
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.shared.len(), 1);
    assert_eq!(state.shared[0].name, "my-notes");
}

/// 🔴 **v8 任务 3:提交撞上保护规则 → 一句人话,不再降级开分支 + 提交审核**(D1)。
///
/// GitHub 的保护规则要 admin 权限才读得到,所以 `branch_protected` 那道先探已经
/// 删掉——提交时的 `BRANCH_PROTECTION_RULE_VIOLATION` 就是唯一也是最终的真相。
/// 断言的是**请求条数**不只是错误码:降级那条路会再发 `git/refs` 与 `pulls`。
#[tokio::test]
async fn protection_violation_on_submit_is_reported_not_downgraded() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "my-notes");

    let server = MockServer::start().await;
    mount_basics(&server, true, false).await;
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .respond_with(gql_error(
            "BRANCH_PROTECTION_RULE_VIOLATION",
            "protected branch 'main' check failed:\n  Changes must be made through a pull request.",
        ))
        .mount(&server)
        .await;

    let gh = client(&server);
    let repo = repo_ref();
    let err = confirmed_share(
        &ShareClient::Github(&gh),
        &gh,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        "gh-src",
        &repo,
        "my-notes",
        NOW,
    )
    .await
    .unwrap_err();

    assert_eq!(err.code, "REPO_PROTECTED");
    let reqs = server.received_requests().await.unwrap();
    assert!(
        !reqs.iter().any(|r| r.url.path().ends_with("/git/refs") || r.url.path().ends_with("/pulls")),
        "不许再开分支/合并请求:{:?}",
        reqs.iter().map(|r| r.url.path().to_string()).collect::<Vec<_>>()
    );
    assert!(c.store.load_state().unwrap().value.shared.is_empty(), "没推成就别记账");
}

/// 🔴 **v8 任务 3 / D8:没有写权限 → 一句人话,而且零写请求**(以前会 fork 一份
/// 到用户名下再跨库提交审核)。
#[tokio::test]
async fn no_push_access_is_told_why_instead_of_getting_a_fork() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "my-notes");

    let server = MockServer::start().await;
    mount_basics(&server, false, false).await;

    let gh = client(&server);
    let repo = repo_ref();
    let err = confirmed_share(
        &ShareClient::Github(&gh),
        &gh,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        "gh-src",
        &repo,
        "my-notes",
        NOW,
    )
    .await
    .unwrap_err();

    // 请求断言排在错误码之前,理由同 `share_flow.rs` 的同名用例。
    let reqs = server.received_requests().await.unwrap();
    assert!(
        reqs.iter().all(|r| r.method.as_str() == "GET"),
        "一个写请求都不该发出去:{:?}",
        reqs.iter().map(|r| format!("{} {}", r.method, r.url.path())).collect::<Vec<_>>()
    );
    assert_eq!(err.code, "REPO_NO_WRITE_ACCESS");
}

// ============================================================ 错误与预检

#[tokio::test]
async fn stale_head_becomes_human_readable_error() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "my-notes");

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
    let err = confirmed_share(
        &ShareClient::Github(&gh),
        &gh,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        "gh-src",
        &repo,
        "my-notes",
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
        // 未登录 + 索引缓存里没有作者信息:归属判定不参与,与 v6 之前逐字等价
        None,
        None,
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
        // 未登录 + 索引缓存里没有作者信息:归属判定不参与,与 v6 之前逐字等价
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(got, SharePrecheck::Fresh);
}

/// 「用户在确认屏上点了确认」的**完整两轮**(终审 C-1:执行轮必须带上"这份清单
/// 基于库里哪一版"的凭据)。预览轮拿 `remote_rev`,执行轮原样带回去——这正是
/// 界面走的路。预览轮就报错 / 直接给出终态时原样回,不硬凑第二跳。
#[allow(clippy::too_many_arguments)]
async fn confirmed_share(
    client: &share::ShareClient<'_>,
    read: &impl skillsync_lib::core::gitea::RepoSource,
    registry: &skillsync_lib::core::agents::AgentRegistry,
    env: &dyn skillsync_lib::core::agents::AgentEnv,
    store: &skillsync_lib::core::state::Store,
    trash: &dyn skillsync_lib::core::fsops::Trasher,
    registry_id: &str,
    repo: &skillsync_lib::core::gitea::RepoRef,
    dir_slug: &str,
    now: &str,
) -> Result<ShareOutcome, skillsync_lib::error::AppError> {
    let first = share::share(
        client,
        read,
        registry,
        env,
        store,
        trash,
        share::ShareRequest { registry_id, repo, dir_slug, confirm: None },
        now,
    )
    .await?;
    let ShareOutcome::NeedsConfirm { remote_rev, plan_rev, .. } = &first else { return Ok(first) };
    let (rev, plan) = (remote_rev.clone(), plan_rev.clone());
    share::share(
        client,
        read,
        registry,
        env,
        store,
        trash,
        share::ShareRequest {
            registry_id,
            repo,
            dir_slug,
            confirm: Some(share::Confirmation { remote_rev: &rev, plan_rev: &plan }),
        },
        now,
    )
    .await
}

// ============================================================ 删除穿到 GitHub 的写请求里(终审 I-6)

/// 🔴 **GitHub 臂的「删除」此前零覆盖**:把 `share.rs` 里 `&changes.delete` 换成
/// `&[]`,全仓没有一条测试会红——也就是说"本地删掉的文件会从技能库里删掉"这条
/// v8 的新承诺,在 GitHub 源上从来没有被证明过。Gitea 侧有同款
/// (`share_flow.rs::a_plan_with_deletions_is_not_committed_until_confirmed` 那一组),
/// 这里补上对称的一条:断言**发出去的那个写请求里真的带着那条删除路径**。
#[tokio::test]
async fn deletions_reach_the_github_write_request() {
    let (c, env) = ctx();
    let dir = c.home.join(".agents/skills/my-notes");
    write_skill(&dir, "my-notes");
    // 账上记着这个技能来自 team/skills;本地**没有**「旧的.md」,而库里有它
    let mut state = c.store.load_state().unwrap().value;
    state
        .installed
        .push(skillsync_lib::core::state::InstalledSkill {
            name: "my-notes".into(),
            source: skillsync_lib::core::state::SkillSource {
                registry_id: "gh-src".into(),
                owner: "team".into(),
                repo: "skills".into(),
                path: "skills/my-notes".into(),
                git_ref: "aaa".into(),
            },
            commit_sha: "aaa".into(),
            content_hash: skillsync_lib::core::fsops::dir_content_hash(&dir).unwrap(),
            origin: None,
            body: None,
            agents: vec![],
            links: vec![],
            installed_at: NOW.into(),
            updated_at: NOW.into(),
        });
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_basics(&server, true, false).await;
    // zipball 顶层目录是 `{owner}-{repo}-{短sha}/`(见 core/github.rs 模块头实测)
    let zip = {
        use std::io::Write as _;
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("team-skills-abc1234/skills/my-notes/SKILL.md", opts)
                .unwrap();
            w.write_all(std::fs::read(dir.join("SKILL.md")).unwrap().as_slice())
                .unwrap();
            w.start_file("team-skills-abc1234/skills/my-notes/旧的.md", opts)
                .unwrap();
            w.write_all(
                b"\xe8\xbf\x99\xe4\xbb\xbd\xe6\x9c\xac\xe5\x9c\xb0\xe5\xb7\xb2\xe5\x88\xa0",
            )
            .unwrap();
            w.finish().unwrap();
        }
        buf
    };
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/team/skills/zipball/main"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .mount(&server)
        .await;
    // 🔴 判据:GraphQL 请求体里必须带着那条删除路径
    Mock::given(method("POST"))
        .and(path("/api/graphql"))
        .and(body_string_contains("skills/my-notes/旧的.md"))
        .respond_with(gql_ok("d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"))
        .expect(1)
        .mount(&server)
        .await;

    let gh = client(&server);
    let repo = repo_ref();
    // 两轮:预览拿凭据,确认带回去(终审 C-1)
    let first = share::share_installed(
        &ShareClient::Github(&gh),
        &gh,
        &c.registry,
        &env,
        &c.store,
        "my-notes",
        &repo.branch,
        None,
        NOW,
    )
    .await
    .unwrap();
    let share::ShareInstalledOutcome::NeedsConfirm {
        plan, remote_rev, plan_rev, ..
    } = first
    else {
        panic!("有文件要删,必须先让用户看一眼:{first:?}");
    };
    let deleted: Vec<String> = plan.deleted.iter().map(|f| f.path.clone()).collect();
    assert_eq!(deleted, vec!["旧的.md".to_string()]);

    let second = share::share_installed(
        &ShareClient::Github(&gh),
        &gh,
        &c.registry,
        &env,
        &c.store,
        "my-notes",
        &repo.branch,
        Some(share::Confirmation { remote_rev: &remote_rev, plan_rev: &plan_rev }),
        NOW,
    )
    .await
    .unwrap();
    assert!(
        matches!(second, share::ShareInstalledOutcome::Submitted(_)),
        "确认之后应当推上去:{second:?}"
    );
    // `expect(1)` 由 MockServer 在 drop 时校验:那一条删除路径真的进了写请求
}
