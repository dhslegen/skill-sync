//! agent 注册表加载与探测。
//!
//! 数据在 `resources/agents.json`(移植自 vercel-labs/skills v1.5.20,MIT),编译期嵌入随 App 分发。
//! 上游把目录路径在模块加载时求值成绝对路径、把"是否已安装"写成 JS 函数;此处统一为
//! 「模板 + 声明式规则」,由本模块在运行时按 [`AgentEnv`] 展开,从而可在单测里注入假环境。
//!
//! 全局安装语义(据上游 installer.ts 核实,任务 6 依此实现):
//! - canonical 全局目录恒为 `~/.agents/skills`;
//! - universal agent(`skillsDir == ".agents/skills"`)的技能落在 canonical 即可见,**不建链**;
//! - 其余 agent 需从 canonical 链接到各自 `globalSkillsDir`。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf, MAIN_SEPARATOR_STR};

use serde::{Deserialize, Serialize};

/// 上游用于判定 universal agent 的项目级目录常量。
const UNIVERSAL_SKILLS_DIR: &str = ".agents/skills";

/// 变量默认值展开的最大递归深度,防御畸形数据(正常数据只有 1 层:default 引用 `{home}`)。
const MAX_VAR_DEPTH: usize = 8;

const BUILTIN_REGISTRY_JSON: &str = include_str!("../../../resources/agents.json");

fn default_true() -> bool {
    true
}

/// 运行环境抽象。生产走 [`SystemEnv`],单测注入假环境以覆盖 env var / XDG / 路径存在性分支。
/// `Send + Sync` 是必需的:获取流程是 async command,`&dyn AgentEnv` 要跨 await 存活,
/// 而 `&T` 只在 `T: Sync` 时才是 `Send`。缺了它 Tauri 会拒绝注册整个 command,
/// 报错只说 "future cannot be sent between threads"、指向宏,很难顺藤摸回这里。
/// `session::BrowserOpener` 出于同样原因也带这两个约束。
pub trait AgentEnv: Send + Sync {
    fn home(&self) -> Option<PathBuf>;
    /// 当前项目根目录。MVP 只做全局技能(决策 C7),返回 `None`,project 作用域规则随之全部跳过。
    fn cwd(&self) -> Option<PathBuf> {
        None
    }
    fn var(&self, name: &str) -> Option<String>;
    fn path_exists(&self, path: &Path) -> bool;
    fn read_to_string(&self, path: &Path) -> Option<String>;
}

/// 真实系统环境。
pub struct SystemEnv;

impl AgentEnv for SystemEnv {
    fn home(&self) -> Option<PathBuf> {
        dirs::home_dir()
    }

    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum VarSpec {
    Home,
    Cwd,
    Env {
        name: String,
        /// 上游多数变量是 `env.X?.trim() || 默认`;唯独 XDG_CONFIG_HOME 走 xdg-basedir 的
        /// `env.X || 默认`(不 trim),故此处可关。
        #[serde(default = "default_true")]
        trim: bool,
        #[serde(default)]
        default: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum DirSpec {
    /// 单一模板,如 `{claudeHome}/skills`。
    Template(String),
    /// 按序取首个 `probe` 存在的候选(仅 openclaw 使用)。
    FirstExisting {
        candidates: Vec<DirCandidate>,
        default: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
struct DirCandidate {
    probe: String,
    path: String,
}

/// 探测规则。同一 agent 的多条规则之间是「任一命中即已安装」。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum DetectRule {
    /// 简写:全局作用域的路径存在性判断。
    GlobalPath(String),
    Tagged(TaggedRule),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaggedRule {
    ProjectPath {
        path: String,
    },
    ProjectPackageJsonDependency {
        path: String,
        dependency: String,
    },
    All {
        rules: Vec<DetectRule>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub name: String,
    pub display_name: String,
    pub skills_dir: String,
    global_skills_dir: Option<DirSpec>,
    #[serde(default = "default_true")]
    pub show_in_universal_list: bool,
    #[serde(default = "default_true")]
    pub show_in_universal_prompt: bool,
    #[serde(default)]
    pub detect: Vec<DetectRule>,
}

impl AgentDef {
    /// 是否使用 universal 的 `.agents/skills` 目录。全局安装时这类 agent 无需建链。
    pub fn is_universal(&self) -> bool {
        self.skills_dir == UNIVERSAL_SKILLS_DIR
    }

    /// 全局安装该 agent 时是否需要从 canonical 建链(据上游 installer.ts:365)。
    pub fn global_install_needs_link(&self) -> bool {
        !self.is_universal()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegistry {
    canonical_global_skills_dir: String,
    vars: BTreeMap<String, VarSpec>,
    agents: Vec<AgentDef>,
}

/// 探测结果,供 IPC 返回前端。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub name: String,
    pub display_name: String,
    pub installed: bool,
    /// 该 agent 的全局技能目录;`None` 表示它不支持全局安装(eve / promptscript)。
    pub global_skills_dir: Option<String>,
    pub is_universal: bool,
    pub needs_link: bool,
    /// 用户在设置页关掉了这个 agent(config.disabledAgents)。
    /// 只影响默认勾选,不拦手动勾选,也不动既有关联。
    pub disabled: bool,
}

/// 把 config 里的禁用名单标到探测结果上。不认识的名字直接忽略——
/// 注册表随版本演进,旧 config 里残留的名字不该让整个探测报错。
pub fn mark_disabled(agents: &mut [DetectedAgent], disabled: &[String]) {
    for agent in agents.iter_mut() {
        agent.disabled = disabled.iter().any(|d| d == &agent.name);
    }
}

impl AgentRegistry {
    /// 加载编译期嵌入的内建注册表。
    pub fn builtin() -> Self {
        serde_json::from_str(BUILTIN_REGISTRY_JSON).expect("内建 agents.json 必须可解析")
    }

    pub fn from_json(json: &str) -> serde_json::Result<Self> {
        serde_json::from_str(json)
    }

    pub fn agents(&self) -> &[AgentDef] {
        &self.agents
    }

    pub fn get(&self, name: &str) -> Option<&AgentDef> {
        self.agents.iter().find(|a| a.name == name)
    }

    /// canonical 全局技能目录(`~/.agents/skills`),skill 本体的落盘位置。
    pub fn canonical_global_dir(&self, env: &dyn AgentEnv) -> Option<PathBuf> {
        self.resolve_template(&self.canonical_global_skills_dir, env)
    }

    /// 展开某 agent 的全局技能目录。
    pub fn global_dir(&self, agent: &AgentDef, env: &dyn AgentEnv) -> Option<PathBuf> {
        match agent.global_skills_dir.as_ref()? {
            DirSpec::Template(t) => self.resolve_template(t, env),
            DirSpec::FirstExisting { candidates, default } => {
                for c in candidates {
                    if let Some(probe) = self.resolve_template(&c.probe, env) {
                        if env.path_exists(&probe) {
                            return self.resolve_template(&c.path, env);
                        }
                    }
                }
                self.resolve_template(default, env)
            }
        }
    }

    /// 按展开后的全局目录分组。
    ///
    /// 多个 agent 共用同一目录是常态(如 cline / dexto / warp / zed 等均指向 `~/.agents/skills`,
    /// zencoder 与 zenflow 同指 `~/.zencoder/skills`),因此建链与解链必须以「目录」为单位操作:
    /// 按 agent 逐个解链会删掉其他 agent 仍在使用的目录,违反"绝不静默删除用户文件"。
    pub fn group_by_global_dir(&self, env: &dyn AgentEnv) -> BTreeMap<PathBuf, Vec<String>> {
        let mut out: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
        for agent in &self.agents {
            if let Some(dir) = self.global_dir(agent, env) {
                out.entry(dir).or_default().push(agent.name.clone());
            }
        }
        out
    }

    /// 探测本机已安装的 agent。`universal` 是上游的伪 agent(恒不可探测),不出现在结果中。
    pub fn detect_all(&self, env: &dyn AgentEnv) -> Vec<DetectedAgent> {
        self.agents
            .iter()
            .filter(|a| a.name != "universal")
            .map(|agent| DetectedAgent {
                name: agent.name.clone(),
                display_name: agent.display_name.clone(),
                installed: self.is_installed(agent, env),
                global_skills_dir: self
                    .global_dir(agent, env)
                    .map(|p| p.to_string_lossy().into_owned()),
                is_universal: agent.is_universal(),
                needs_link: agent.global_install_needs_link(),
                disabled: false,
            })
            .collect()
    }

    pub fn is_installed(&self, agent: &AgentDef, env: &dyn AgentEnv) -> bool {
        agent.detect.iter().any(|r| self.rule_matches(r, env))
    }

    fn rule_matches(&self, rule: &DetectRule, env: &dyn AgentEnv) -> bool {
        match rule {
            DetectRule::GlobalPath(t) => self
                .resolve_template(t, env)
                .is_some_and(|p| env.path_exists(&p)),
            DetectRule::Tagged(TaggedRule::ProjectPath { path }) => self
                .resolve_template(path, env)
                .is_some_and(|p| env.path_exists(&p)),
            DetectRule::Tagged(TaggedRule::ProjectPackageJsonDependency { path, dependency }) => {
                let Some(p) = self.resolve_template(path, env) else {
                    return false;
                };
                let Some(text) = env.read_to_string(&p) else {
                    return false;
                };
                let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
                    return false;
                };
                ["dependencies", "devDependencies"]
                    .iter()
                    .any(|k| !json[k][dependency].is_null())
            }
            DetectRule::Tagged(TaggedRule::All { rules }) => {
                !rules.is_empty() && rules.iter().all(|r| self.rule_matches(r, env))
            }
        }
    }

    /// 展开模板。任一变量不可解析(如未设 APPDATA、MVP 下没有 cwd)则整条路径视为"不适用",返回 `None`
    /// ——而不是拼出一条畸形路径去做存在性判断。
    fn resolve_template(&self, template: &str, env: &dyn AgentEnv) -> Option<PathBuf> {
        let expanded = self.expand(template, env, 0)?;
        // JSON 里一律用 `/` 书写,落地时换成平台原生分隔符。
        Some(PathBuf::from(expanded.replace('/', MAIN_SEPARATOR_STR)))
    }

    fn expand(&self, template: &str, env: &dyn AgentEnv, depth: usize) -> Option<String> {
        if depth > MAX_VAR_DEPTH {
            return None;
        }
        let mut out = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let close = rest[open..].find('}')? + open;
            let value = self.resolve_var(&rest[open + 1..close], env, depth + 1)?;
            out.push_str(&value);
            rest = &rest[close + 1..];
        }
        out.push_str(rest);
        Some(out)
    }

    fn resolve_var(&self, name: &str, env: &dyn AgentEnv, depth: usize) -> Option<String> {
        match self.vars.get(name)? {
            VarSpec::Home => env.home().map(|p| p.to_string_lossy().into_owned()),
            VarSpec::Cwd => env.cwd().map(|p| p.to_string_lossy().into_owned()),
            VarSpec::Env {
                name: env_name,
                trim,
                default,
            } => {
                if let Some(raw) = env.var(env_name) {
                    let value = if *trim { raw.trim() } else { raw.as_str() };
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
                self.expand(default.as_ref()?, env, depth)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// 假环境:可指定 home、env 变量、存在的路径与文件内容。
    #[derive(Default)]
    struct FakeEnv {
        home: Option<PathBuf>,
        cwd: Option<PathBuf>,
        vars: HashMap<String, String>,
        existing: HashSet<PathBuf>,
        files: HashMap<PathBuf, String>,
    }

    impl FakeEnv {
        fn with_home(home: &str) -> Self {
            Self {
                home: Some(PathBuf::from(home)),
                ..Default::default()
            }
        }
        fn var(mut self, k: &str, v: &str) -> Self {
            self.vars.insert(k.into(), v.into());
            self
        }
        fn exists(mut self, p: &str) -> Self {
            self.existing.insert(PathBuf::from(p.replace('/', MAIN_SEPARATOR_STR)));
            self
        }
    }

    impl AgentEnv for FakeEnv {
        fn home(&self) -> Option<PathBuf> {
            self.home.clone()
        }
        fn cwd(&self) -> Option<PathBuf> {
            self.cwd.clone()
        }
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).cloned()
        }
        fn path_exists(&self, path: &Path) -> bool {
            self.existing.contains(path)
        }
        fn read_to_string(&self, path: &Path) -> Option<String> {
            self.files.get(path).cloned()
        }
    }

    fn reg() -> AgentRegistry {
        AgentRegistry::builtin()
    }

    /// 断言辅助:比较时把平台分隔符归一化为 `/`。
    fn dir_of(r: &AgentRegistry, env: &dyn AgentEnv, name: &str) -> Option<String> {
        r.global_dir(r.get(name).unwrap(), env)
            .map(|p| p.to_string_lossy().replace(MAIN_SEPARATOR_STR, "/"))
    }

    // ---- 数据完整性 ----

    #[test]
    fn registry_has_75_agents_without_duplicates() {
        let r = reg();
        assert_eq!(r.agents().len(), 75, "上游 v1.5.20 恰好 75 个 agent");
        let unique: HashSet<_> = r.agents().iter().map(|a| a.name.as_str()).collect();
        assert_eq!(unique.len(), 75, "agent name 不得重复");
    }

    #[test]
    fn every_agent_has_required_fields() {
        for a in reg().agents() {
            assert!(!a.name.is_empty() && !a.display_name.is_empty() && !a.skills_dir.is_empty());
        }
    }

    #[test]
    fn only_eve_and_promptscript_lack_global_dir() {
        let r = reg();
        let env = FakeEnv::with_home("/h");
        let without: Vec<_> = r
            .agents()
            .iter()
            .filter(|a| r.global_dir(a, &env).is_none())
            .map(|a| a.name.as_str())
            .collect();
        assert_eq!(without, vec!["eve", "promptscript"]);
    }

    #[test]
    fn no_dangling_template_vars() {
        // 用一个把所有 env 变量都设满、cwd 也给定的环境展开全部模板,任何一处 None 都意味着变量名写错。
        let r = reg();
        let mut env = FakeEnv::with_home("/h");
        env.cwd = Some(PathBuf::from("/proj"));
        for name in ["APPDATA", "FLATPAK_XDG_CONFIG_HOME"] {
            env.vars.insert(name.into(), format!("/v/{name}"));
        }
        let mut templates: Vec<String> = vec![r.canonical_global_skills_dir.clone()];
        for a in r.agents() {
            match &a.global_skills_dir {
                Some(DirSpec::Template(t)) => templates.push(t.clone()),
                Some(DirSpec::FirstExisting { candidates, default }) => {
                    templates.push(default.clone());
                    for c in candidates {
                        templates.push(c.probe.clone());
                        templates.push(c.path.clone());
                    }
                }
                None => {}
            }
            collect_rule_templates(&a.detect, &mut templates);
        }
        for t in templates {
            assert!(
                r.resolve_template(&t, &env).is_some(),
                "模板含未定义变量: {t}"
            );
        }
    }

    fn collect_rule_templates(rules: &[DetectRule], out: &mut Vec<String>) {
        for rule in rules {
            match rule {
                DetectRule::GlobalPath(t) => out.push(t.clone()),
                DetectRule::Tagged(TaggedRule::ProjectPath { path }) => out.push(path.clone()),
                DetectRule::Tagged(TaggedRule::ProjectPackageJsonDependency { path, .. }) => {
                    out.push(path.clone())
                }
                DetectRule::Tagged(TaggedRule::All { rules }) => collect_rule_templates(rules, out),
            }
        }
    }

    #[test]
    fn ci_matrix_agents_match_upstream_verbatim() {
        let r = reg();
        let env = FakeEnv::with_home("/h");
        // 保障矩阵四个 agent(决策 C10),字段与上游逐字一致
        let claude = r.get("claude-code").unwrap();
        assert_eq!(claude.display_name, "Claude Code");
        assert_eq!(claude.skills_dir, ".claude/skills");
        assert_eq!(dir_of(&r, &env, "claude-code").unwrap(), "/h/.claude/skills");
        assert!(claude.global_install_needs_link());

        let cursor = r.get("cursor").unwrap();
        assert_eq!(cursor.skills_dir, ".agents/skills");
        assert_eq!(dir_of(&r, &env, "cursor").unwrap(), "/h/.cursor/skills");
        assert!(cursor.is_universal() && !cursor.global_install_needs_link());

        let codex = r.get("codex").unwrap();
        assert_eq!(dir_of(&r, &env, "codex").unwrap(), "/h/.codex/skills");
        assert!(codex.is_universal());

        let trae = r.get("trae").unwrap();
        assert_eq!(trae.skills_dir, ".trae/skills");
        assert_eq!(dir_of(&r, &env, "trae").unwrap(), "/h/.trae/skills");
        assert!(trae.global_install_needs_link());
    }

    // ---- 路径展开 ----

    #[test]
    fn canonical_dir_is_agents_skills_under_home() {
        let env = FakeEnv::with_home("/h");
        let got = reg().canonical_global_dir(&env).unwrap();
        assert_eq!(
            got.to_string_lossy().replace(MAIN_SEPARATOR_STR, "/"),
            "/h/.agents/skills"
        );
    }

    #[test]
    fn xdg_config_home_defaults_and_overrides() {
        let r = reg();
        let default_env = FakeEnv::with_home("/h");
        assert_eq!(
            dir_of(&r, &default_env, "goose").unwrap(),
            "/h/.config/goose/skills"
        );

        let xdg = FakeEnv::with_home("/h").var("XDG_CONFIG_HOME", "/xdg");
        assert_eq!(dir_of(&r, &xdg, "goose").unwrap(), "/xdg/goose/skills");
    }

    #[test]
    fn xdg_is_identical_on_all_platforms_and_ignores_appdata() {
        // 上游 configHome 来自 xdg-basedir,Windows 也不走 APPDATA。设了 APPDATA 也不得影响 configHome。
        let r = reg();
        let env = FakeEnv::with_home("/h").var("APPDATA", "/appdata");
        assert_eq!(dir_of(&r, &env, "amp").unwrap(), "/h/.config/agents/skills");
    }

    #[test]
    fn agent_specific_env_vars_take_effect() {
        let r = reg();
        let cases = [
            ("CODEX_HOME", "codex"),
            ("CLAUDE_CONFIG_DIR", "claude-code"),
            ("VIBE_HOME", "mistral-vibe"),
            ("HERMES_HOME", "hermes-agent"),
            ("AUTOHAND_HOME", "autohand-code"),
            ("GROK_HOME", "grok"),
        ];
        for (var, agent) in cases {
            let env = FakeEnv::with_home("/h").var(var, "/e");
            assert_eq!(dir_of(&r, &env, agent).unwrap(), "/e/skills", "{var} 未生效");
        }
    }

    #[test]
    fn blank_env_var_falls_back_but_blank_xdg_is_used_verbatim() {
        let r = reg();
        // 六个 agent 专用变量:上游 `env.X?.trim() || 默认`,纯空白回退默认
        let blank = FakeEnv::with_home("/h").var("CODEX_HOME", "   ");
        assert_eq!(dir_of(&r, &blank, "codex").unwrap(), "/h/.codex/skills");
        // XDG_CONFIG_HOME:上游 `env.X || 默认`,不 trim,空白值被原样采用
        let blank_xdg = FakeEnv::with_home("/h").var("XDG_CONFIG_HOME", "  ");
        assert_eq!(dir_of(&r, &blank_xdg, "goose").unwrap(), "  /goose/skills");
        // 空串对两者都是"未设置"
        let empty_xdg = FakeEnv::with_home("/h").var("XDG_CONFIG_HOME", "");
        assert_eq!(
            dir_of(&r, &empty_xdg, "goose").unwrap(),
            "/h/.config/goose/skills"
        );
    }

    #[test]
    fn padded_env_var_is_trimmed_and_used() {
        let r = reg();
        let env = FakeEnv::with_home("/h").var("CODEX_HOME", "  /padded  ");
        assert_eq!(dir_of(&r, &env, "codex").unwrap(), "/padded/skills");
    }

    #[test]
    fn unset_var_without_default_makes_path_not_applicable() {
        // zed 的三条探测路径里,APPDATA / FLATPAK_XDG_CONFIG_HOME 无默认值。
        // 未设置时对应路径必须判为"不适用",而不是展开成 "/Zed" 这种畸形路径。
        let r = reg();
        let env = FakeEnv::with_home("/h").exists("/Zed").exists("/zed");
        assert!(!r.is_installed(r.get("zed").unwrap(), &env));
    }

    #[test]
    fn templates_expand_to_native_separators() {
        let env = FakeEnv::with_home("/h");
        let p = reg().canonical_global_dir(&env).unwrap();
        assert!(p.ends_with("skills"));
        assert_eq!(
            p.components().count(),
            PathBuf::from("/h/.agents/skills".replace('/', MAIN_SEPARATOR_STR))
                .components()
                .count()
        );
        // 非 POSIX 平台上不得残留正斜杠
        assert!(MAIN_SEPARATOR_STR == "/" || !p.to_string_lossy().contains('/'));
    }

    // ---- 探测 ----

    #[test]
    fn single_path_rule_detects_installed_agent() {
        let r = reg();
        let env = FakeEnv::with_home("/h").exists("/h/.claude");
        assert!(r.is_installed(r.get("claude-code").unwrap(), &env));
    }

    #[test]
    fn nothing_exists_means_not_installed() {
        let r = reg();
        let env = FakeEnv::with_home("/h");
        assert!(r.agents().iter().all(|a| !r.is_installed(a, &env)));
    }

    #[test]
    fn any_of_multiple_paths_detects() {
        let r = reg();
        // codex:{codexHome} 或 /etc/codex
        let via_etc = FakeEnv::with_home("/h").exists("/etc/codex");
        assert!(r.is_installed(r.get("codex").unwrap(), &via_etc));
        // kimi-code-cli:~/.kimi-code 或 ~/.kimi
        let via_kimi = FakeEnv::with_home("/h").exists("/h/.kimi");
        assert!(r.is_installed(r.get("kimi-code-cli").unwrap(), &via_kimi));
    }

    #[test]
    fn zed_detects_via_appdata_only() {
        let r = reg();
        let env = FakeEnv::with_home("/h")
            .var("APPDATA", "/appdata")
            .exists("/appdata/Zed");
        assert!(r.is_installed(r.get("zed").unwrap(), &env));
    }

    #[test]
    fn project_scoped_rules_are_skipped_in_global_detection() {
        // MVP 无 cwd:replit / promptscript / eve 只有 project 规则,恒为未检出(与上游全局行为一致)
        let r = reg();
        let env = FakeEnv::with_home("/h")
            .exists("/h/.replit")
            .exists("/h/.promptscript")
            .exists("/h/agent");
        for name in ["replit", "promptscript", "eve"] {
            assert!(
                !r.is_installed(r.get(name).unwrap(), &env),
                "{name} 不应在全局探测中命中"
            );
        }
    }

    #[test]
    fn universal_pseudo_agent_is_never_reported() {
        let r = reg();
        let env = FakeEnv::with_home("/h");
        let detected = r.detect_all(&env);
        assert!(detected.iter().all(|a| a.name != "universal"));
        assert_eq!(detected.len(), 74);
    }

    #[test]
    fn mark_disabled_flags_only_the_listed_agents_and_ignores_unknown_names() {
        let r = reg();
        let env = FakeEnv::with_home("/h");
        let mut detected = r.detect_all(&env);
        assert!(detected.iter().all(|a| !a.disabled), "探测结果默认全部启用");

        mark_disabled(&mut detected, &["trae".into(), "早已下架的名字".into()]);

        assert!(detected.iter().find(|a| a.name == "trae").unwrap().disabled);
        assert!(
            detected.iter().filter(|a| a.disabled).count() == 1,
            "不认识的名字必须被忽略,而不是波及别人"
        );

        // 再标一次空名单 = 全部恢复启用(开关是幂等的整体覆盖,不是增量)
        mark_disabled(&mut detected, &[]);
        assert!(detected.iter().all(|a| !a.disabled));
    }

    // ---- openclaw 目录择一 ----

    #[test]
    fn openclaw_global_dir_picks_first_existing() {
        let r = reg();
        let none = FakeEnv::with_home("/h");
        assert_eq!(dir_of(&r, &none, "openclaw").unwrap(), "/h/.openclaw/skills");

        let clawdbot = FakeEnv::with_home("/h").exists("/h/.clawdbot");
        assert_eq!(
            dir_of(&r, &clawdbot, "openclaw").unwrap(),
            "/h/.clawdbot/skills"
        );

        let moltbot = FakeEnv::with_home("/h").exists("/h/.moltbot");
        assert_eq!(
            dir_of(&r, &moltbot, "openclaw").unwrap(),
            "/h/.moltbot/skills"
        );

        // 多个同时存在时按 .openclaw → .clawdbot → .moltbot 的声明顺序取首个
        let both = FakeEnv::with_home("/h")
            .exists("/h/.openclaw")
            .exists("/h/.moltbot");
        assert_eq!(dir_of(&r, &both, "openclaw").unwrap(), "/h/.openclaw/skills");
    }

    // ---- 目录分组(任务 6 的前置契约) ----

    #[test]
    fn multiple_agents_share_one_global_dir() {
        // 这条测试的意义是钉死"目标目录并非一 agent 一个":
        // 解链必须按目录判断是否还有其他 agent 在用,否则会删掉别人的目录。
        let r = reg();
        let env = FakeEnv::with_home("/h");
        let groups = r.group_by_global_dir(&env);

        let canonical = r.canonical_global_dir(&env).unwrap();
        let sharing_canonical = groups.get(&canonical).expect("必有 agent 直接指向 canonical");
        assert!(
            sharing_canonical.len() >= 6,
            "共用 ~/.agents/skills 的 agent 应有 6 个以上,实际 {sharing_canonical:?}"
        );
        for name in ["cline", "dexto", "kimi-code-cli", "loaf", "warp", "zed"] {
            assert!(
                sharing_canonical.contains(&name.to_string()),
                "{name} 应共用 canonical"
            );
        }

        let zencoder = PathBuf::from("/h/.zencoder/skills".replace('/', MAIN_SEPARATOR_STR));
        assert_eq!(groups.get(&zencoder).unwrap(), &["zencoder", "zenflow"]);
    }

    /// 实机探测。结果随开发者机器而变,故默认不跑;
    /// 手动执行:`cargo test detect_on_this_machine -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn detect_on_this_machine() {
        let r = reg();
        let env = SystemEnv;
        println!("canonical: {:?}", r.canonical_global_dir(&env));
        let installed: Vec<_> = r
            .detect_all(&env)
            .into_iter()
            .filter(|a| a.installed)
            .collect();
        for a in &installed {
            println!(
                "  {:<16} {:<22} needs_link={:<5} {}",
                a.name,
                a.display_name,
                a.needs_link,
                a.global_skills_dir.as_deref().unwrap_or("-")
            );
        }
        assert!(!installed.is_empty(), "本机至少应检出一个 agent");
    }

    #[test]
    fn universal_agents_need_no_link_on_global_install() {
        let r = reg();
        for name in ["cursor", "codex", "amp", "zed"] {
            assert!(
                !r.get(name).unwrap().global_install_needs_link(),
                "{name} 无需建链"
            );
        }
        for name in ["claude-code", "trae", "windsurf", "roo"] {
            assert!(
                r.get(name).unwrap().global_install_needs_link(),
                "{name} 需要建链"
            );
        }
    }
}
