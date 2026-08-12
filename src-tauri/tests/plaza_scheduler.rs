//! `scheduler::run_check` 对广场源真跑一轮(M9 任务 3,brief 测试清单 5)。
//!
//! `run_check` 本身是既有代码(M2 任务 3),对来源类型无感——它只吃
//! `impl RepoSource`(`gitea::RepoSource` trait)与一份 `SourceMeta`。这份测试
//! 换上 `GithubClient` + `registry_id: "plaza"`,复用 `tests/scheduler_check.rs`
//! 与 `tests/github_client.rs` 已经验证过的两套基建(轮次编排 / GitHub wiremock 挂法),
//! 证明"定时检查覆盖到广场"这件事——`commands::check_targets` 已经把广场行纳入枚举
//! (M9 任务 2),这里补的是"真跑一轮、走到 FromAccount 批量路径"这个事实。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire;
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::gitea::RepoRef;
use skillsync_lib::core::registry::PLAZA_REGISTRY_ID;
use skillsync_lib::core::scheduler::{self, CheckReport};
use skillsync_lib::core::state::{InstalledSkill, SkillSource, Store};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-08-12T12:00:00.000Z";

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
    let env = TmpEnv { home: home.clone(), vars: HashMap::new() };
    let store = Store::new(home.join(".skillsync"));
    (Ctx { _tmp: tmp, home, registry: AgentRegistry::builtin(), store }, env)
}

fn repo_ref() -> RepoRef {
    RepoRef { owner: "vercel-labs".into(), repo: "skills".into(), branch: "main".into() }
}

fn zip_repo(skills: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (slug, body) in skills {
            zip.start_file(format!("vercel-labs-skills-bbb2222/skills/{slug}/SKILL.md"), opts)
                .unwrap();
            zip.write_all(
                format!("---\nname: {slug} 展示名\ndescription: 新版说明\n---\n{body}\n").as_bytes(),
            )
            .unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

async fn mount_head(server: &MockServer, sha: &str) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "sha": sha, "commit": { "committer": { "date": "2026-08-12T08:00:00Z" } } }
        })))
        .mount(server)
        .await;
}

/// 在 canonical 里放好本体,并按当前内容记账,来源写成广场坐标。
fn seed_installed(c: &Ctx, slug: &str, body: &str, sha: &str, agents: &[&str]) -> PathBuf {
    let canonical = c.home.join(".agents/skills").join(slug);
    std::fs::create_dir_all(&canonical).unwrap();
    std::fs::write(
        canonical.join("SKILL.md"),
        format!("---\nname: {slug} 展示名\ndescription: 旧版说明\n---\n{body}\n"),
    )
    .unwrap();
    let content_hash = fsops::dir_content_hash(&canonical).unwrap();

    let mut state = c.store.load_state().map(|l| l.value).unwrap_or_default();
    state.installed.push(InstalledSkill {
        name: slug.to_string(),
        source: SkillSource {
            registry_id: PLAZA_REGISTRY_ID.into(),
            owner: "vercel-labs".into(),
            repo: "skills".into(),
            path: format!("skills/{slug}"),
            git_ref: "main".into(),
        },
        commit_sha: sha.to_string(),
        content_hash,
        origin: None,
        agents: agents.iter().map(|s| s.to_string()).collect(),
        links: vec![],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    c.store.save_state(&state).unwrap();
    canonical
}

async fn run(server: &MockServer, c: &Ctx, env: &TmpEnv) -> CheckReport {
    let client = GithubClient::new(&server.uri(), None, reqwest::Client::new());
    scheduler::run_check(
        &client,
        &c.registry,
        env,
        &c.store,
        acquire::SourceMeta {
            registry_id: PLAZA_REGISTRY_ID,
            kind: "github",
            // 与生产一致地用真实常量,而不是 server.uri():这条测试顺带钉住
            // "SourceMeta.base_url 与网络端点解耦"这件事——lock/记账落的是常量,
            // 网络仍打到 wiremock(见 tests/plaza_acquire.rs 模块头的同款说明)。
            base_url: "https://github.com",
        },
        &repo_ref(),
        NOW,
        1_755_000_000,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_changed_head_on_the_plaza_source_triggers_a_from_account_batch_update() {
    let server = MockServer::start().await;
    mount_head(&server, "sha-2").await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/zipball/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_repo(&[("alpha", "新正文")])))
        .mount(&server)
        .await;
    let (c, env) = ctx();
    seed_installed(&c, "alpha", "正文", "sha-1", &["claude-code"]);

    let report = run(&server, &c, &env).await;

    let CheckReport::Checked { updated, skipped, failed, head_sha } = report else {
        panic!("head 变了该走批量更新: {report:?}");
    };
    assert_eq!(head_sha, "sha-2");
    assert_eq!(updated, vec!["alpha".to_string()]);
    assert!(skipped.is_empty(), "{skipped:?}");
    assert!(failed.is_empty(), "{failed:?}");

    // 记账仍是广场坐标,commit_sha 跟上远端
    let state = c.store.load_state().unwrap().value;
    let record = state.installed.iter().find(|s| s.name == "alpha").unwrap();
    assert_eq!(record.commit_sha, "sha-2");
    assert_eq!(record.source.registry_id, PLAZA_REGISTRY_ID);
    assert_eq!(record.agents, vec!["claude-code".to_string()], "自动流程不改写账上的 agents");

    let body = std::fs::read_to_string(c.home.join(".agents/skills/alpha/SKILL.md")).unwrap();
    assert!(body.contains("新正文"));
}

#[tokio::test]
async fn an_unchanged_head_on_the_plaza_source_never_downloads_the_archive() {
    let server = MockServer::start().await;
    mount_head(&server, "sha-1").await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/zipball/.*$"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let (c, env) = ctx();
    seed_installed(&c, "alpha", "正文", "sha-1", &["claude-code"]);

    let report = run(&server, &c, &env).await;

    match report {
        CheckReport::UpToDate { head_sha } => assert_eq!(head_sha, "sha-1"),
        other => panic!("该报 UpToDate: {other:?}"),
    }
}
