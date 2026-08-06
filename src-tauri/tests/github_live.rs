//! 对**真实 GitHub**(github.com)跑通一次完整读链路:索引 → 发现 → 获取 →
//! 建链 → 记账 → 双写 lock(M3 任务 4 的 DoD)。
//!
//! 走真实外网且吃 GitHub 匿名限流(60 次/小时/IP),**默认跳过**:
//! `SKILLSYNC_GITHUB_LIVE=1 cargo test --test github_live -- --nocapture` 手动跑。
//! 目标是 `dhslegen/skills`(本项目作者的公开技能库,`skills/<slug>/SKILL.md`
//! 布局与公司内建库同构)。
//!
//! wiremock 验的是"我们怎么处理响应",这里验的是真实 GitHub 的 302 跟随、
//! codeload 压缩包、限流头这些只有真跑才见得到的东西。

use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireRequest, Stage};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::RepoRef;
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::state::Store;
use skillsync_lib::core::store;

const NOW: &str = "2026-07-31T12:00:00.000Z";

struct TmpEnv {
    home: PathBuf,
}

impl AgentEnv for TmpEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, _: &str) -> Option<String> {
        None
    }
    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

#[tokio::test]
async fn browses_and_installs_a_real_skill_from_github() {
    if std::env::var("SKILLSYNC_GITHUB_LIVE").as_deref() != Ok("1") {
        eprintln!("跳过:设 SKILLSYNC_GITHUB_LIVE=1 才对真实 GitHub 跑(匿名限流 60 次/时)");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let env = TmpEnv {
        home: tmp.path().to_path_buf(),
    };
    let registry_id = "custom-1";
    let repo = RepoRef {
        owner: "dhslegen".into(),
        repo: "skills".into(),
        branch: "main".into(),
    };
    // 生产语义:外部源跟随系统代理
    let http = skillsync_lib::core::gitea::app_http_client_proxied().unwrap();
    let client = GithubClient::new("https://github.com", None, http);

    // 浏览:真实索引应发现至少一个技能
    let cache = tmp.path().join("index-github-live.json");
    let (index, outcome) =
        store::refresh_index(&client, &repo, registry_id, &cache, true, 1_753_900_000)
            .await
            .expect("真实 GitHub 索引失败");
    assert!(!outcome.offline, "联网跑却报离线");
    assert!(
        !index.skills.is_empty(),
        "dhslegen/skills 里应至少发现一个技能"
    );
    let target = index.skills[0].dir_slug.clone();
    eprintln!("发现 {} 个技能,取第一个安装:{target}", index.skills.len());

    // 获取:落盘 + 记账 + lock 双写(不关联具体 agent,canonical 即可见)
    let agent_registry = AgentRegistry::builtin();
    let store_db = Store::for_env(&env).unwrap();
    let outcome = acquire::acquire(
        &client,
        &agent_registry,
        &env,
        &store_db,
        AcquireRequest {
            source: acquire::SourceMeta {
                registry_id,
                kind: "github",
                base_url: "https://github.com",
            },
            repo: &repo,
            dir_slug: &target,
            agent_names: &[],
            resolution: None,
        },
        NOW,
        1_753_900_000,
        &|_: Stage| {},
    )
    .await
    .expect("真实 GitHub 获取失败");

    let acquire::AcquireOutcome::Installed { report, .. } = outcome else {
        panic!("全新安装不该撞冲突");
    };
    let skill_md = env
        .home
        .join(".agents/skills")
        .join(&report.dir_name)
        .join("SKILL.md");
    assert!(skill_md.is_file(), "SKILL.md 应已落盘: {}", skill_md.display());

    let lock = std::fs::read_to_string(env.home.join(".agents/.skill-lock.json")).unwrap();
    assert!(lock.contains(&target), "lock 双写里应有刚装的技能");
    eprintln!("真实 GitHub e2e 通过:{target} 已落盘并记账");
}
