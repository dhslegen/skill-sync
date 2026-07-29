//! 与上游 vercel-labs/skills 的差分测试。
//!
//! fixture 由 `node scripts/verify-agents-registry.mjs` 生成——它在多组 env 场景下**实际执行**上游
//! agents.ts 并记录算出的路径。本测试断言我们的解析器逐条与之一致。
//! 这样 ground truth 来自上游真实行为,而非我们对上游的第二次解读,单点误读无法同时骗过两边。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf, MAIN_SEPARATOR_STR};

use serde::Deserialize;
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry, DetectRule};

const FIXTURE: &str = include_str!("fixtures/upstream-agents-resolved.json");

/// 需要真实目录存在的场景里,fixture 用该占位符代替临时 HOME。
const HOME_PLACEHOLDER: &str = "{HOME}";
const FAKE_HOME: &str = "/skillsync-fixture-home";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    scenarios: Vec<Scenario>,
    /// 探测反查时子进程的 env。XDG 特意错开 `~/.config`,以便区分"写死 ~/.config"与"走 configHome"。
    detect_probe_env: HashMap<String, String>,
    detect_probes: Vec<DetectProbe>,
}

/// 上游确认过的探测路径:造出 `paths` 里的目录后,上游确实检出了该 agent。
/// `paths` 为空 = 该 agent 没有全局作用域的探测路径(经确认的事实)。
#[derive(Deserialize)]
struct DetectProbe {
    agent: String,
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    name: String,
    home: String,
    env: HashMap<String, String>,
    existing_dirs: Vec<String>,
    agents: HashMap<String, ExpectedAgent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedAgent {
    display_name: String,
    skills_dir: String,
    global_skills_dir: Option<String>,
}

struct FixtureEnv {
    home: PathBuf,
    vars: HashMap<String, String>,
    existing: HashSet<PathBuf>,
}

impl AgentEnv for FixtureEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
    fn path_exists(&self, path: &Path) -> bool {
        self.existing.contains(path)
    }
    fn read_to_string(&self, _path: &Path) -> Option<String> {
        None
    }
}

fn native(p: &str) -> PathBuf {
    PathBuf::from(p.replace('/', MAIN_SEPARATOR_STR))
}

/// 探测路径回归。
///
/// 路径解析由上一个测试覆盖,但 `detect` 规则本身不在其中——改错探测路径(例如把 kimchi/crush
/// 写死的 `~/.config` "修正"成 configHome)不会影响任何 globalSkillsDir,靠上一个测试拦不住。
/// 这里用上游裁决过的路径回归:标记这些目录存在,本地探测必须检出该 agent。
#[test]
fn detect_rules_match_upstream_probes() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture 可解析");
    let registry = AgentRegistry::builtin();
    assert_eq!(
        fixture.detect_probes.len(),
        registry.agents().len(),
        "每个 agent 都应有一条探测记录"
    );

    for probe in &fixture.detect_probes {
        let agent = registry
            .get(&probe.agent)
            .unwrap_or_else(|| panic!("注册表缺少 agent {}", probe.agent));

        if probe.paths.is_empty() {
            // 上游确认无全局探测路径:本地数据里也不得存在全局作用域规则
            assert!(
                !agent
                    .detect
                    .iter()
                    .any(|r| matches!(r, DetectRule::GlobalPath(_))),
                "{} 上游无全局探测路径,本地却有",
                probe.agent
            );
            continue;
        }

        let env = FixtureEnv {
            home: native(FAKE_HOME),
            vars: fixture
                .detect_probe_env
                .iter()
                .map(|(k, v)| (k.clone(), v.replace(HOME_PLACEHOLDER, FAKE_HOME)))
                .collect(),
            existing: probe
                .paths
                .iter()
                .map(|p| native(&p.replace(HOME_PLACEHOLDER, FAKE_HOME)))
                .collect(),
        };
        assert!(
            registry.is_installed(agent, &env),
            "{} 的探测路径 {:?} 经上游确认有效,本地却未检出",
            probe.agent,
            probe.paths
        );
    }
}

#[test]
fn resolved_paths_match_upstream_execution() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture 可解析");
    let registry = AgentRegistry::builtin();
    assert!(!fixture.scenarios.is_empty());

    for scenario in &fixture.scenarios {
        // fixture 里 home 为占位符的场景需要真实目录存在,用本地假 home 顶替后再换回占位符比对
        let uses_placeholder = scenario.home == HOME_PLACEHOLDER;
        let home = if uses_placeholder {
            FAKE_HOME
        } else {
            scenario.home.as_str()
        };

        let env = FixtureEnv {
            home: native(home),
            vars: scenario.env.clone(),
            existing: scenario
                .existing_dirs
                .iter()
                .map(|d| native(&format!("{home}/{d}")))
                .collect(),
        };

        assert_eq!(
            registry.agents().len(),
            scenario.agents.len(),
            "场景 {} 的 agent 条数与上游不一致",
            scenario.name
        );

        for agent in registry.agents() {
            let expected = scenario
                .agents
                .get(&agent.name)
                .unwrap_or_else(|| panic!("场景 {} 缺少 agent {}", scenario.name, agent.name));

            assert_eq!(
                agent.display_name, expected.display_name,
                "{} / {} displayName",
                scenario.name, agent.name
            );
            assert_eq!(
                agent.skills_dir, expected.skills_dir,
                "{} / {} skillsDir",
                scenario.name, agent.name
            );

            let got = registry.global_dir(agent, &env).map(|p| {
                let s = p.to_string_lossy().replace(MAIN_SEPARATOR_STR, "/");
                if uses_placeholder {
                    s.replace(FAKE_HOME, HOME_PLACEHOLDER)
                } else {
                    s
                }
            });
            assert_eq!(
                got.as_deref(),
                expected.global_skills_dir.as_deref(),
                "{} / {} globalSkillsDir",
                scenario.name,
                agent.name
            );
        }
    }
}
