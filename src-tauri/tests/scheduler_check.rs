//! scheduler 单轮检查(M2 任务 3)的编排断言。
//!
//! 重点:①head 未变**不下载压缩包** ②更新用**账上的 agents**(自动流程不改写关联)
//! ③用户改过的技能跳过且**磁盘一字不动**(冲突保护即 batch 的跳过语义)④没装任何
//! 技能时一个请求都不发。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::scheduler::{self, CheckReport};
use skillsync_lib::core::state::{InstalledSkill, SkillSource, Store};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-07-31T12:00:00.000Z";
const REGISTRY: &str = "company";

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

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

fn zip_repo(skills: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (slug, body) in skills {
            zip.start_file(format!("repo/skills/{slug}/SKILL.md"), opts).unwrap();
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
        .and(path_regex(r"/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": sha, "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(server)
        .await;
}

/// 在 canonical 里放好本体,并按当前内容记账。返回 canonical 路径。
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
            registry_id: REGISTRY.into(),
            owner: "skills".into(),
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
    let client = GiteaClient::new(server.uri(), None).unwrap();
    scheduler::run_check(
        &client,
        &c.registry,
        env,
        &c.store,
        skillsync_lib::core::acquire::SourceMeta {
            registry_id: REGISTRY,
            kind: "gitea",
            base_url: &server.uri(),
        },
        &repo_ref(),
        NOW,
        1_753_900_000,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn nothing_installed_sends_no_requests_at_all() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(".*"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let (c, env) = ctx();

    let report = run(&server, &c, &env).await;

    assert!(matches!(report, CheckReport::NothingInstalled));
}

#[tokio::test]
async fn an_unchanged_head_never_downloads_the_archive() {
    let server = MockServer::start().await;
    mount_head(&server, "sha-1").await;
    // 压缩包端点必须一次都不被打到——head 没变还下载,就是把"比对"做成了摆设
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/archive/.*"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let (c, env) = ctx();
    seed_installed(&c, "alpha", "正文", "sha-1", &["claude-code"]);

    let report = run(&server, &c, &env).await;

    match report {
        CheckReport::UpToDate { head_sha } => assert_eq!(head_sha, "sha-1"),
        other => panic!("该报 UpToDate,得到 {other:?}"),
    }
}

#[tokio::test]
async fn updates_link_with_the_accounted_agents_not_a_uniform_list() {
    let server = MockServer::start().await;
    mount_head(&server, "sha-2").await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/archive/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_repo(&[("alpha", "新正文")])))
        .mount(&server)
        .await;
    let (c, env) = ctx();
    seed_installed(&c, "alpha", "正文", "sha-1", &["claude-code"]);

    let report = run(&server, &c, &env).await;

    let CheckReport::Checked { updated, skipped, failed, .. } = report else {
        panic!("该走批量更新");
    };
    assert_eq!(updated, vec!["alpha".to_string()]);
    assert!(skipped.is_empty(), "{skipped:?}");
    assert!(failed.is_empty(), "{failed:?}");

    // 记账:commit_sha 跟上远端,agents 保持账上的原样
    let state = c.store.load_state().unwrap().value;
    let record = state.installed.iter().find(|s| s.name == "alpha").unwrap();
    assert_eq!(record.commit_sha, "sha-2");
    assert_eq!(record.agents, vec!["claude-code".to_string()]);

    // 建链发生在账上 agent 的目录(claude-code 需要建链),证明没拿空列表糊弄
    let linked = c.home.join(".claude/skills/alpha");
    assert!(
        env.path_exists(&linked),
        "账上的 claude-code 该有链接:{}",
        linked.display()
    );

    // 本体确实换成了新版
    let body = std::fs::read_to_string(c.home.join(".agents/skills/alpha/SKILL.md")).unwrap();
    assert!(body.contains("新正文"));
}

#[tokio::test]
async fn a_locally_modified_skill_is_skipped_and_its_files_stay_byte_identical() {
    let server = MockServer::start().await;
    mount_head(&server, "sha-2").await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/archive/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_repo(&[("alpha", "新正文")])))
        .mount(&server)
        .await;
    let (c, env) = ctx();
    let canonical = seed_installed(&c, "alpha", "正文", "sha-1", &["claude-code"]);
    // 记账之后用户改了本体
    std::fs::write(canonical.join("SKILL.md"), "用户自己的心血改动").unwrap();
    let before = std::fs::read_to_string(canonical.join("SKILL.md")).unwrap();

    let report = run(&server, &c, &env).await;

    let CheckReport::Checked { updated, skipped, .. } = report else {
        panic!("该走批量更新");
    };
    assert!(updated.is_empty());
    assert_eq!(skipped.len(), 1);
    assert!(skipped[0].reason.contains("本地改动"), "{}", skipped[0].reason);
    assert_eq!(
        std::fs::read_to_string(canonical.join("SKILL.md")).unwrap(),
        before,
        "用户改过的本体必须一字不动"
    );
    // commit_sha 也不能被偷偷推进——那会把「有可用更新」的标记抹掉
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed[0].commit_sha, "sha-1");
}
