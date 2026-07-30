//! 对 docker fixture Gitea 跑通一次完整获取:下载 → 落盘 → 建链 → 记账 → 双写 lock。
//!
//! 需要先 `./fixtures/init.sh`,环境不在时自动跳过(与 gitea_live.rs 同约定)。
//!
//! wiremock 验的是"我们怎么处理响应",这里验的是"真实 Gitea 的压缩包到底能不能装上"
//! ——顶层目录名、路径分隔、编码、以及技能里带脚本时会发生什么,都只有真跑才知道。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireRequest, Stage};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::state::Store;

const NOW: &str = "2026-07-30T12:00:00.000Z";

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

fn fixture_env() -> Option<HashMap<String, String>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("fixtures/.env.local");
    let text = std::fs::read_to_string(path).ok()?;
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    Some(map)
}

#[tokio::test]
async fn installs_a_real_skill_from_the_fixture_registry() {
    let Some(env_vars) = fixture_env() else {
        eprintln!("跳过:未找到 fixtures/.env.local,先跑 ./fixtures/init.sh");
        return;
    };
    let need = ["SKILLSYNC_FIXTURE_GITEA_URL", "SKILLSYNC_FIXTURE_ORG", "SKILLSYNC_FIXTURE_REPO"];
    if let Some(missing) = need.iter().find(|k| !env_vars.contains_key(**k)) {
        eprintln!("跳过:fixtures/.env.local 缺 {missing}");
        return;
    }

    // 匿名读:技能库公开可读,获取流程不需要登录
    let client = GiteaClient::new(env_vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone(), None).unwrap();
    let repo = RepoRef {
        owner: env_vars["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: env_vars["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    };
    if client.branch_head(&repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let registry = AgentRegistry::builtin();
    let stages = std::sync::Mutex::new(Vec::new());
    let sink = |s: Stage| stages.lock().unwrap().push(s);

    // fixture 里 `with-scripts` 带一个 run.sh,正好覆盖"含可执行脚本"的技能
    let outcome = acquire::acquire(
        &client,
        &registry,
        &env,
        &store,
        AcquireRequest {
            registry_id: "fixture",
            repo: &repo,
            dir_slug: "with-scripts",
            agent_names: &["claude-code".to_string()],
            resolution: None,
        },
        NOW,
        1_753_800_000,
        &sink,
    )
    .await
    .expect("获取失败");

    let acquire::AcquireOutcome::Installed { report, .. } = outcome else {
        panic!("首次安装不该需要拍板: {outcome:?}");
    };

    // 1) 本体落在 canonical
    let canonical = home.join(".agents").join("skills").join("with-scripts");
    assert_eq!(report.canonical_dir, canonical.to_string_lossy());
    assert!(canonical.join("SKILL.md").is_file(), "SKILL.md 没落盘");
    assert!(canonical.join("run.sh").is_file(), "run.sh 没落盘");

    // 2) 关联到了 claude-code(它不是通用目录,必须建链)
    let link = home.join(".claude").join("skills").join("with-scripts");
    assert!(link.exists(), "没有关联到 Claude Code");
    assert!(link.join("SKILL.md").is_file(), "关联过去之后读不到技能内容");

    // 3) state 记了账,且立刻回读为"没改过"
    let state = store.load_state().unwrap().value;
    assert_eq!(state.installed.len(), 1);
    assert_eq!(state.installed[0].name, "with-scripts");
    assert!(!state.installed[0].commit_sha.is_empty());
    let installer = skillsync_lib::core::installer::Installer::new(&registry, &env);
    assert!(
        matches!(
            acquire::precheck(&installer, &env, &state, "with-scripts", &state.installed[0].commit_sha).unwrap(),
            acquire::Precheck::Managed { up_to_date: true, .. }
        ),
        "刚装完就被判成改过,说明 contentHash 的口径与落盘不一致"
    );

    // 4) 外部契约:npx skills 的 lock 也写了
    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(home.join(".agents").join(".skill-lock.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(lock["version"], 3);
    assert!(lock["skills"]["with-scripts"]["source"].is_string());

    // 5) 进度按序报全
    assert_eq!(
        stages.into_inner().unwrap(),
        vec![Stage::Fetching, Stage::Checking, Stage::Writing, Stage::Recording, Stage::Done]
    );
}
