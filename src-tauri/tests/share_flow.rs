//! 分享流程编排测试。
//!
//! 断言纪律与 acquire_flow 一致:守卫类断言盯**磁盘与请求体**,不盯枚举——
//! "没确认就不动手"要靠"没发出过 POST"来证明,不是靠返回值好看。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::share::{self, CandidateOrigin, ShareMode, ShareOutcome, SharePrecheck};
use skillsync_lib::core::state::{InstalledSkill, LinkRecord, SharedSkill, SkillSource, Store};
use wiremock::matchers::{body_partial_json, method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-07-31T09:00:00.000Z";

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

fn canonical(c: &Ctx) -> PathBuf {
    c.home.join(".agents").join("skills")
}

fn write_skill(dir: &Path, name: &str, desc: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {desc}\n---\n正文\n"),
    )
    .unwrap();
}

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

fn state_of(c: &Ctx) -> skillsync_lib::core::state::State {
    c.store.load_state().map(|l| l.value).unwrap_or_default()
}

// ============================================================ 候选扫描

#[test]
fn scans_canonical_dirs_that_we_did_not_install() {
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("my-notes"), "我的笔记", "记点东西");

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c)).unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].dir_name, "my-notes");
    assert!(found[0].in_canonical);
    assert_eq!(found[0].origin, CandidateOrigin::Local);
    assert_eq!(found[0].name.as_deref(), Some("我的笔记"));
    assert!(found[0].problem.is_none());
    assert!(found[0].dir_name_usable);
}

#[test]
fn skills_installed_by_this_app_are_excluded() {
    // 排除法的核心:团队库装的东西"再分享"回去只会造重复
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("weekly-report"), "周报", "d");
    let mut state = state_of(&c);
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "aaa".into(),
        },
        commit_sha: "aaa".into(),
        content_hash: String::new(),
        agents: vec![],
        links: vec![],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });

    let found = share::scan_candidates(&c.registry, &env, &state).unwrap();
    assert!(found.is_empty(), "本 app 安装的不该出现在分享列表: {found:?}");
}

#[test]
fn npx_installed_skills_carry_their_original_source() {
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("email-polish"), "邮件润色", "d");
    std::fs::write(
        c.home.join(".agents").join(".skill-lock.json"),
        serde_json::json!({
            "version": 3,
            "skills": { "email-polish": { "source": "acme/skills", "sourceType": "github" } }
        })
        .to_string(),
    )
    .unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c)).unwrap();
    assert_eq!(
        found[0].origin,
        CandidateOrigin::NpxSkills { source: "acme/skills".into() }
    );
}

#[test]
fn real_dirs_in_agent_folders_are_candidates_but_links_are_not() {
    let (c, env) = ctx();
    // 用户直接手建在 Claude Code 目录里的技能:候选,且标记"要收编"
    write_skill(&c.home.join(".claude").join("skills").join("hand-made"), "手搓的", "d");
    // canonical 的技能 + 指向它的链接:链接那份不该再列一遍
    let body = canonical(&c).join("my-notes");
    write_skill(&body, "我的笔记", "d");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&body, c.home.join(".claude").join("skills").join("my-notes"))
        .unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c)).unwrap();

    let names: Vec<&str> = found.iter().map(|f| f.dir_name.as_str()).collect();
    assert!(names.contains(&"hand-made"));
    let hand = found.iter().find(|f| f.dir_name == "hand-made").unwrap();
    assert!(!hand.in_canonical);
    // my-notes 只出现一次(canonical 的那份)
    assert_eq!(names.iter().filter(|n| **n == "my-notes").count(), 1);
    assert!(found.iter().find(|f| f.dir_name == "my-notes").unwrap().in_canonical);
}

#[test]
fn dirs_without_skill_md_are_not_skills() {
    let (c, env) = ctx();
    std::fs::create_dir_all(canonical(&c).join("random-stuff")).unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c)).unwrap();
    assert!(found.is_empty());
}

#[test]
fn broken_frontmatter_and_chinese_dir_names_are_flagged_for_the_form() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("周报生成器");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: 周报\n---\n没有描述\n").unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c)).unwrap();

    assert_eq!(found.len(), 1);
    assert!(found[0].problem.as_deref().unwrap().contains("description"));
    // 纯中文目录名 sanitize 后信息全丢,表单必须让用户另起英文名
    assert!(!found[0].dir_name_usable);
}

#[test]
fn previously_shared_skills_report_whether_local_changed_since() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "d");
    let mut state = state_of(&c);
    state.shared.push(SharedSkill {
        name: "my-notes".into(),
        local_path: dir.to_string_lossy().into_owned(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/my-notes".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "abc".into(),
        content_hash: fsops::dir_content_hash(&dir).unwrap(),
    });

    let found = share::scan_candidates(&c.registry, &env, &state).unwrap();
    assert!(found[0].shared.as_ref().unwrap().up_to_date);

    // 改一笔 → 未分享的改动
    std::fs::write(dir.join("SKILL.md"), "---\nname: 我的笔记\ndescription: 改了\n---\n").unwrap();
    let found = share::scan_candidates(&c.registry, &env, &state).unwrap();
    assert!(!found[0].shared.as_ref().unwrap().up_to_date);
}

// ============================================================ 预检三分支

async fn mount_skill_exists(server: &MockServer, name: &str, exists: bool) {
    let m = Mock::given(method("GET"))
        .and(path(format!("/api/v1/repos/skills/skills/contents/skills/{name}/SKILL.md")));
    if exists {
        m.respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"sha": "aaa"})))
            .mount(server)
            .await;
    } else {
        m.respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"message": "GetContentsOrList"})))
            .mount(server)
            .await;
    }
}

#[tokio::test]
async fn precheck_fresh_when_remote_has_no_such_skill() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = share::precheck(&share::ShareClient::Gitea(&client), &repo_ref(), &state_of(&c), "my-notes").await.unwrap();
    assert_eq!(got, SharePrecheck::Fresh);
}

#[tokio::test]
async fn precheck_mine_when_we_shared_it_before() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    let mut state = state_of(&c);
    state.shared.push(SharedSkill {
        name: "my-notes".into(),
        local_path: "/x".into(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/my-notes".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "abc".into(),
        content_hash: String::new(),
    });
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = share::precheck(&share::ShareClient::Gitea(&client), &repo_ref(), &state, "my-notes").await.unwrap();
    assert_eq!(got, SharePrecheck::Mine);
}

#[tokio::test]
async fn precheck_taken_when_someone_else_owns_the_name() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = share::precheck(&share::ShareClient::Gitea(&client), &repo_ref(), &state_of(&c), "my-notes").await.unwrap();
    assert_eq!(got, SharePrecheck::Taken);
}

// ============================================================ 提交

async fn mount_repo_info(server: &MockServer, push: bool) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main",
            "permissions": { "admin": false, "push": push, "pull": true },
            "empty": false
        })))
        .mount(server)
        .await;
}

async fn mount_commit_ok(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "newsha1", "html_url": "http://x/commit/newsha1" }
        })))
        .mount(server)
        .await;
}

fn share_req<'a>(repo: &'a RepoRef, source: &'a Path, name: &'a str) -> share::ShareRequest<'a> {
    share::ShareRequest {
        registry_id: "company",
        repo,
        source_path: source,
        share_name: name,
        display_name: None,
        description: None,
        origin: "local",
        overwrite: false,
    }
}

#[tokio::test]
async fn fresh_share_pushes_creates_and_records_the_books() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "记点东西");
    std::fs::write(dir.join("logo.png"), [0x89u8, 0x50]).unwrap();

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, share_req(&repo, &dir, "my-notes"), NOW)
        .await
        .unwrap();

    let ShareOutcome::Shared { mode, commit_sha, adopted, .. } = outcome else {
        panic!("Fresh 不该要求拍板");
    };
    assert_eq!(mode, ShareMode::Pushed);
    assert_eq!(commit_sha, "newsha1");
    assert!(!adopted);

    // 请求体:全部 create、无 new_branch、二进制走 base64
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    assert_eq!(posted.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    assert!(body.get("new_branch").is_none());
    assert_eq!(body["branch"], "main");
    let files = body["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|f| f["operation"] == "create"));
    assert!(files.iter().any(|f| f["path"] == "skills/my-notes/SKILL.md"));
    assert!(files.iter().any(|f| f["path"] == "skills/my-notes/logo.png"));

    // 记账:有 content_hash(未分享改动判据)与 commit sha
    let state = state_of(&c);
    assert_eq!(state.shared.len(), 1);
    assert_eq!(state.shared[0].name, "my-notes");
    assert_eq!(state.shared[0].last_pushed_sha, "newsha1");
    assert_eq!(state.shared[0].content_hash, fsops::dir_content_hash(&dir).unwrap());
}

#[tokio::test]
async fn taken_without_confirmation_sends_nothing() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, share_req(&repo, &dir, "my-notes"), NOW)
        .await
        .unwrap();

    assert!(matches!(
        outcome,
        ShareOutcome::NeedsDecision { precheck: SharePrecheck::Taken }
    ));
    // 真正的守卫断言:一个提交都没发出去
    let reqs = server.received_requests().await.unwrap();
    assert!(reqs.iter().all(|r| r.method.as_str() != "POST"), "未确认就发了提交");
    assert!(state_of(&c).shared.is_empty(), "没分享成还记了账");
}

#[tokio::test]
async fn overwriting_a_taken_name_updates_with_remote_shas() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [
                { "path": "skills/my-notes/SKILL.md", "sha": "oldsha", "type": "blob" },
                { "path": "skills/other/SKILL.md", "sha": "x", "type": "blob" }
            ],
            "truncated": false
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let mut req = share_req(&repo, &dir, "my-notes");
    req.overwrite = true;
    share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, req, NOW).await.unwrap();

    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    let skill_md = body["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "skills/my-notes/SKILL.md")
        .unwrap();
    // 远端已有 → update 且带旧 blob sha;发 create 会被 Gitea 422 拒掉
    assert_eq!(skill_md["operation"], "update");
    assert_eq!(skill_md["sha"], "oldsha");
}

#[tokio::test]
async fn protected_branch_falls_back_to_review_request() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    // 第一次(直推)403;之后(带 new_branch)201
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "message": "user should have a permission to write to the target branch"
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    mount_commit_ok(&server).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "html_url": "http://x/pulls/7", "number": 7
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, share_req(&repo, &dir, "my-notes"), NOW)
        .await
        .unwrap();

    let ShareOutcome::Shared { mode, review_url, .. } = outcome else { panic!() };
    assert_eq!(mode, ShareMode::ReviewRequested);
    assert_eq!(review_url.as_deref(), Some("http://x/pulls/7"));

    let reqs = server.received_requests().await.unwrap();
    let contents: Vec<serde_json::Value> = reqs
        .iter()
        .filter(|r| r.url.path().ends_with("/contents") && r.method.as_str() == "POST")
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    assert_eq!(contents.len(), 2);
    assert!(contents[0].get("new_branch").is_none(), "第一次应尝试直推");
    let branch = contents[1]["new_branch"].as_str().unwrap();
    assert!(branch.starts_with("skillsync/my-notes-"), "降级后要开分支: {branch}");
    // 提交审核的 head 用的就是那个分支
    let pull = reqs.iter().find(|r| r.url.path().ends_with("/pulls")).unwrap();
    let pull_body: serde_json::Value = serde_json::from_slice(&pull.body).unwrap();
    assert_eq!(pull_body["head"], branch);
    assert_eq!(pull_body["base"], "main");
}

#[tokio::test]
async fn read_only_users_go_through_a_fork() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, false).await; // 只读
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/forks"))
        .respond_with(ResponseTemplate::new(202).set_body_json(serde_json::json!({
            "name": "skills", "owner": { "login": "zhang-san" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/zhang-san/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "forksha", "html_url": "http://x" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "html_url": "http://x/pulls/9", "number": 9
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, share_req(&repo, &dir, "my-notes"), NOW)
        .await
        .unwrap();

    let ShareOutcome::Shared { mode, .. } = outcome else { panic!() };
    assert_eq!(mode, ShareMode::ReviewRequested);

    let reqs = server.received_requests().await.unwrap();
    // 原库一个 contents POST 都不该有(只读连开分支都是 403)
    assert!(
        !reqs.iter().any(|r| r.url.path() == "/api/v1/repos/skills/skills/contents"),
        "只读用户不该往原库直接提交"
    );
    // 跨库提交审核:head 是 fork 拥有者:分支
    let pull = reqs.iter().find(|r| r.url.path().ends_with("/pulls")).unwrap();
    let body: serde_json::Value = serde_json::from_slice(&pull.body).unwrap();
    let head = body["head"].as_str().unwrap();
    assert!(head.starts_with("zhang-san:skillsync/my-notes-"), "head: {head}");
}

#[tokio::test]
async fn sharing_from_an_agent_dir_adopts_it_into_canonical() {
    let (c, env) = ctx();
    let orig = c.home.join(".claude").join("skills").join("hand-made");
    write_skill(&orig, "手搓的", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "hand-made", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, share_req(&repo, &orig, "hand-made"), NOW)
        .await
        .unwrap();

    let ShareOutcome::Shared { adopted, .. } = outcome else { panic!() };
    assert!(adopted);
    // 本体进了 canonical
    let body = canonical(&c).join("hand-made");
    assert!(body.join("SKILL.md").is_file(), "本体没收编进 canonical");
    // 原位仍能读到内容(链接或降级副本都行),agent 不受影响
    assert!(orig.join("SKILL.md").is_file(), "原位置读不到技能了");
    // 记账指向 canonical 里的那份
    assert_eq!(state_of(&c).shared[0].local_path, body.to_string_lossy());
}

#[tokio::test]
async fn the_form_fixes_frontmatter_before_it_is_pushed() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: 我的笔记\n---\n正文还在\n").unwrap();

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let mut req = share_req(&repo, &dir, "my-notes");
    req.description = Some("补上的描述");
    share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, req, NOW).await.unwrap();

    // 本地文件已补齐
    let local = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
    assert!(local.contains("补上的描述"));
    assert!(local.contains("正文还在"));
    // 推上去的就是补齐后的内容
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    let content = body["files"][0]["content"].as_str().unwrap();
    let decoded = String::from_utf8(
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, content).unwrap(),
    )
    .unwrap();
    assert!(decoded.contains("补上的描述"), "推的不是补齐后的内容: {decoded}");
}

#[tokio::test]
async fn a_race_at_submit_time_surfaces_as_conflict_stale() {
    // DoD:sha 竞态返回 CONFLICT_STALE,UI 拿它回到预检
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "repository file already exists [path: skills/my-notes/SKILL.md]"
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, share_req(&repo, &dir, "my-notes"), NOW)
        .await
        .unwrap_err();

    assert_eq!(err.code, "CONFLICT_STALE");
    assert!(state_of(&c).shared.is_empty(), "提交失败还记了账");
}

#[tokio::test]
async fn a_chinese_share_name_is_rejected_up_front() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("周报");
    write_skill(&dir, "周报", "d");
    let server = MockServer::start().await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = share::share(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, share_req(&repo, &dir, "周报"), NOW)
        .await
        .unwrap_err();

    assert_eq!(err.code, "FS_UNUSABLE_NAME");
    // 一个网络请求都不该发
    assert!(server.received_requests().await.unwrap().is_empty());
}

// ============================================================ 回推已装技能的改动

fn install_record(c: &Ctx, dir: &Path) -> InstalledSkill {
    InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "aaa".into(),
        },
        commit_sha: "aaa".into(),
        content_hash: fsops::dir_content_hash(dir).unwrap(),
        agents: vec![],
        links: vec![LinkRecord { dir: c.home.join(".claude/skills").to_string_lossy().into_owned(), mode: "symlink".into() }],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

#[tokio::test]
async fn pushing_local_changes_back_updates_the_books() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "周报", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    // 用户改本体 → contentHash 不符
    std::fs::write(dir.join("SKILL.md"), "---\nname: 周报\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [ { "path": "skills/weekly-report/SKILL.md", "sha": "oldsha", "type": "blob" } ],
            "truncated": false
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let submitted = share::share_installed(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, "weekly-report", "main", NOW)
        .await
        .unwrap();

    assert_eq!(submitted.mode, ShareMode::Pushed);
    // 记账更新:contentHash = 当前本地(「已改动」消失),commitSha = 新提交
    let state = state_of(&c);
    assert_eq!(state.installed[0].commit_sha, "newsha1");
    assert_eq!(state.installed[0].content_hash, fsops::dir_content_hash(&dir).unwrap());
    // 请求体:已有文件是 update + 旧 sha
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    assert_eq!(body["files"][0]["operation"], "update");
    assert_eq!(body["files"][0]["sha"], "oldsha");
}

#[tokio::test]
async fn review_requested_changes_do_not_touch_the_install_books() {
    // 走了评审 = 改动还没进 main。此时更新 contentHash 等于把「已改动」标记藏起来,
    // 评审被拒后用户的改动就在界面上彻底隐形了。
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "周报", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    let before = state_of(&c).installed[0].clone();
    std::fs::write(dir.join("SKILL.md"), "---\nname: 周报\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [], "truncated": false
        })))
        .mount(&server)
        .await;
    // 直推 403 → 分支 + 评审
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .and(body_partial_json(serde_json::json!({"branch": "main"})))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "message": "protected"
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    mount_commit_ok(&server).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "html_url": "http://x/pulls/3", "number": 3
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let submitted = share::share_installed(&share::ShareClient::Gitea(&client), &c.registry, &env, &c.store, "weekly-report", "main", NOW)
        .await
        .unwrap();

    assert_eq!(submitted.mode, ShareMode::ReviewRequested);
    let after = state_of(&c).installed[0].clone();
    assert_eq!(after.commit_sha, before.commit_sha, "评审未合入就推进了版本记账");
    assert_eq!(after.content_hash, before.content_hash, "评审未合入就清了「已改动」标记");
}
