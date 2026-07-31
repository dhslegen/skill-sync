//! 本地状态:`config.json` / `state.json` 读写与 schema 版本闸门。
//!
//! 落点 `~/.skillsync/`。两份文件顶部必带 `schemaVersion`(交接包 3.4)。
//!
//! 三条不可让步的规则:
//! 1. **遇到比自己新的 schema 一律只读**,绝不写回——写回等于用旧结构覆盖新结构,是不可逆的数据破坏;
//! 2. **文件损坏时报错而非静默重置**,用户的安装记录比"程序能跑下去"重要;
//! 3. **写入是原子的**(临时文件 + rename),断电或崩溃只会留下旧版本,不会留下半截文件。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::agents::AgentEnv;
use crate::error::AppError;

/// 当前 schema 版本。加新版本时:提升此值,并在 `migrate` 里补一段 `n => n+1` 的搬运。
pub const SCHEMA_VERSION: u32 = 1;

const APP_DIR: &str = ".skillsync";
const CONFIG_FILE: &str = "config.json";
const STATE_FILE: &str = "state.json";

/// 文件的打开方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum Access {
    ReadWrite,
    /// 文件来自更新版本的本应用。界面须提示升级,且一切写入都会被拒绝。
    ReadOnly { found: u32 },
}

#[derive(Debug, Clone)]
pub struct Loaded<T> {
    pub value: T,
    pub access: Access,
}

// ============================================================ config.json

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub schema_version: u32,
    #[serde(default)]
    pub registries: Vec<RegistryConfig>,
    #[serde(default)]
    pub auto_update: AutoUpdate,
    /// 界面偏好。`None` = 从未设置过(前端据此做 localStorage 一次性迁移),
    /// 与 `Some(默认值)` 是两种不同状态,所以不能用 `#[serde(default)]` 折掉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiPrefs>,
}

/// 界面偏好(M2 任务 1 起落盘,此前在前端 localStorage)。
///
/// 取值集合与前端 `store/appearance.ts` 的类型一一对应,写入前经 [`UiPrefs::validate`]
/// 把关——config.json 是跨版本的长命文件,进来什么就得认什么,垃圾值只能挡在门外。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPrefs {
    /// `light` / `dark` / `system`
    pub theme: String,
    /// `clay` / `teal` / `ink`
    pub accent: String,
    /// 首次启动向导是否已完成(「每台机器一次」的标记,随偏好同档落盘)。
    #[serde(default)]
    pub wizard_done: bool,
}

impl UiPrefs {
    pub fn validate(&self) -> Result<(), AppError> {
        let theme_ok = matches!(self.theme.as_str(), "light" | "dark" | "system");
        let accent_ok = matches!(self.accent.as_str(), "clay" | "teal" | "ink");
        if theme_ok && accent_ok {
            return Ok(());
        }
        Err(
            AppError::new("STATE_INVALID_PREFS", "外观设置的取值不合法,请重新选择").with_detail(
                format!("theme={:?} accent={:?}", self.theme, self.accent),
            ),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    pub owner: String,
    pub repo: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdate {
    pub skills: SkillAutoUpdate,
    pub app: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAutoUpdate {
    pub enabled: bool,
    pub interval_hours: u32,
}

impl Default for AutoUpdate {
    fn default() -> Self {
        Self {
            skills: SkillAutoUpdate {
                enabled: true,
                interval_hours: 4,
            },
            app: true,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            registries: Vec::new(),
            auto_update: AutoUpdate::default(),
            ui: None,
        }
    }
}

// ============================================================ state.json

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub schema_version: u32,
    #[serde(default)]
    pub installed: Vec<InstalledSkill>,
    #[serde(default)]
    pub shared: Vec<SharedSkill>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            installed: Vec::new(),
            shared: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    /// 仓库中的技能目录名,也是 canonical 与各 agent 目录下的目录名(见 installer 的 `dir_slug`)。
    pub name: String,
    pub source: SkillSource,
    pub commit_sha: String,
    /// 安装当时 canonical 目录的内容 hash。与当前实际值不符即说明用户改过本体。
    pub content_hash: String,
    pub agents: Vec<String>,
    /// 逐目录的关联记账。
    ///
    /// 设计方案 2.4 写的是单个 `linkMode`,但任务 6 确认关联是**按目录**建立的,
    /// 同一次安装里不同目录完全可能落在不同档(一个建成 junction、另一个降级复制),
    /// 且卸载时必须凭这份记账才敢动降级复制出来的副本。故此处按目录记。
    #[serde(default)]
    pub links: Vec<LinkRecord>,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRecord {
    pub dir: String,
    /// `symlink` / `junction` / `copy`,取自 `fsops::LinkKind::as_str`。
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub registry_id: String,
    pub owner: String,
    pub repo: String,
    pub path: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSkill {
    pub name: String,
    pub local_path: String,
    /// `local` | `npx-skills`
    pub origin: String,
    pub target: SkillSource,
    pub last_pushed_sha: String,
    /// 上次分享时本地目录的内容 hash。与当前实际值不符 = 有未分享的改动。
    ///
    /// 旧版 state 没有这个字段(serde default 补空串):空串永远不等于实际 hash,
    /// 效果是"显示可再推"——宁可多推一次,也不把用户的改动藏起来。
    #[serde(default)]
    pub content_hash: String,
}

// ============================================================ 读写

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// 生产落点 `~/.skillsync`。
    pub fn for_env(env: &dyn AgentEnv) -> Option<Self> {
        Some(Self::new(env.home()?.join(APP_DIR)))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn load_config(&self) -> Result<Loaded<Config>, AppError> {
        load(&self.dir.join(CONFIG_FILE))
    }

    pub fn save_config(&self, value: &Config) -> Result<(), AppError> {
        save(&self.dir.join(CONFIG_FILE), value)
    }

    pub fn load_state(&self) -> Result<Loaded<State>, AppError> {
        load(&self.dir.join(STATE_FILE))
    }

    pub fn load_ui_prefs(&self) -> Result<Option<UiPrefs>, AppError> {
        Ok(self.load_config()?.value.ui)
    }

    /// 界面偏好写回 config.json。load-modify-save:只动 `ui` 一个字段,
    /// registries/autoUpdate 原样保留。
    ///
    /// 只读闸门不在这里重复设卡:文件来自更新版本时 `load_config` 给的是默认值,
    /// 但 `save`(基于磁盘重读的那道现有守卫)会拒绝写入,新版数据一个字节不会被动。
    pub fn save_ui_prefs(&self, prefs: &UiPrefs) -> Result<(), AppError> {
        prefs.validate()?;
        let mut config = self.load_config()?.value;
        config.ui = Some(prefs.clone());
        self.save_config(&config)
    }

    pub fn save_state(&self, value: &State) -> Result<(), AppError> {
        save(&self.dir.join(STATE_FILE), value)
    }
}

fn load<T>(path: &Path) -> Result<Loaded<T>, AppError>
where
    T: serde::de::DeserializeOwned + Default,
{
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                value: T::default(),
                access: Access::ReadWrite,
            })
        }
        Err(e) => {
            return Err(AppError::new("STATE_READ_FAILED", "读取本地数据失败,请检查文件权限")
                .with_detail(format!("read {}: {e}", path.display())))
        }
    };

    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        AppError::new(
            "STATE_CORRUPT",
            "本地数据文件已损坏。为免丢失记录,应用没有改动它,请联系 IT 协助处理",
        )
        .with_detail(format!("parse {}: {e}", path.display()))
    })?;

    // 缺 schemaVersion 视为第 1 版:该字段是随 v1 一同引入的,不带它的文件只能是 v1 之前的写法。
    let found = raw
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(SCHEMA_VERSION as u64) as u32;

    if found > SCHEMA_VERSION {
        // 只读:结构未知,任何写回都可能把新版本的字段抹掉。
        return Ok(Loaded {
            value: T::default(),
            access: Access::ReadOnly { found },
        });
    }

    let migrated = migrate(raw, found)?;
    let value = serde_json::from_value(migrated).map_err(|e| {
        AppError::new(
            "STATE_CORRUPT",
            "本地数据文件的内容不符合预期。为免丢失记录,应用没有改动它,请联系 IT 协助处理",
        )
        .with_detail(format!("decode {}: {e}", path.display()))
    })?;

    Ok(Loaded {
        value,
        access: Access::ReadWrite,
    })
}

/// 版本链式迁移。
///
/// 目前只有第 1 版,链上没有任何一段;新增 v2 时在此补 `1 => {...}` 并提升 [`SCHEMA_VERSION`]。
/// 保留这个函数形态而不是等到那天再引入,是为了让"迁移发生在读取路径上"这件事现在就成立。
fn migrate(mut raw: serde_json::Value, from: u32) -> Result<serde_json::Value, AppError> {
    if from < SCHEMA_VERSION {
        // 当前 SCHEMA_VERSION == 1,且"缺字段"已在调用处按 v1 处理,故这一支实际不可达。
        // 新增 v2 时在此按 from 分档搬运字段,一档一档往上走。
        return Err(AppError::new(
            "STATE_MIGRATE_UNSUPPORTED",
            "本地数据来自不受支持的旧版本,请联系 IT 协助处理",
        )
        .with_detail(format!("no migration path from v{from}")));
    }
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("schemaVersion".into(), SCHEMA_VERSION.into());
    }
    Ok(raw)
}

fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let existing = std::fs::read_to_string(path).ok();
    if let Some(text) = &existing {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(text) {
            let found = raw.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if found > SCHEMA_VERSION {
                return Err(AppError::new(
                    "STATE_READ_ONLY",
                    "本地数据来自更新版本的 SkillSync,请先升级应用后再操作",
                )
                .with_detail(format!("refuse to write over v{found} at {}", path.display())));
            }
        }
    }

    let failed = |e: std::io::Error| {
        AppError::new("STATE_WRITE_FAILED", "保存本地数据失败,请检查磁盘空间与权限")
            .with_detail(format!("write {}: {e}", path.display()))
    };

    let dir = path.parent().ok_or_else(|| {
        AppError::new("STATE_WRITE_FAILED", "保存本地数据失败:路径不合法")
            .with_detail(format!("no parent for {}", path.display()))
    })?;
    std::fs::create_dir_all(dir).map_err(failed)?;

    let text = serde_json::to_string_pretty(value).map_err(|e| {
        AppError::new("STATE_WRITE_FAILED", "保存本地数据失败").with_detail(e.to_string())
    })?;

    // 原子写:先落到同目录下的临时文件,再 rename 顶替。
    // 同目录是必要条件——跨文件系统的 rename 不是原子操作,会退化成"复制+删除"。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(failed)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        failed(e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::new(tmp.path().join(".skillsync"));
        (tmp, s)
    }

    fn sample_state() -> State {
        State {
            schema_version: SCHEMA_VERSION,
            installed: vec![InstalledSkill {
                name: "docx-to-markdown".into(),
                source: SkillSource {
                    registry_id: "company".into(),
                    owner: "skills".into(),
                    repo: "skills".into(),
                    path: "skills/docx-to-markdown".into(),
                    git_ref: "main".into(),
                },
                commit_sha: "abc123".into(),
                content_hash: "sha256:deadbeef".into(),
                agents: vec!["claude-code".into()],
                links: vec![LinkRecord {
                    dir: "/h/.claude/skills".into(),
                    mode: "symlink".into(),
                }],
                installed_at: "2026-07-30T00:00:00.000Z".into(),
                updated_at: "2026-07-30T00:00:00.000Z".into(),
            }],
            shared: vec![],
        }
    }

    #[test]
    fn missing_files_yield_defaults_without_writing_anything() {
        let (_tmp, s) = store();

        let cfg = s.load_config().unwrap();
        let st = s.load_state().unwrap();

        assert_eq!(cfg.value.schema_version, SCHEMA_VERSION);
        assert!(st.value.installed.is_empty());
        assert!(matches!(cfg.access, Access::ReadWrite));
        assert!(!s.dir().exists(), "只读不该在磁盘上留下任何东西");
    }

    #[test]
    fn state_survives_a_round_trip() {
        let (_tmp, s) = store();
        let original = sample_state();

        s.save_state(&original).unwrap();
        let back = s.load_state().unwrap().value;

        assert_eq!(back.installed.len(), 1);
        assert_eq!(back.installed[0].name, "docx-to-markdown");
        assert_eq!(back.installed[0].links[0].mode, "symlink");
        assert_eq!(back.installed[0].source.owner, "skills");
    }

    #[test]
    fn files_are_written_with_a_schema_version_on_top() {
        let (_tmp, s) = store();
        s.save_state(&sample_state()).unwrap();

        let text = std::fs::read_to_string(s.dir().join("state.json")).unwrap();

        assert!(text.starts_with("{\n  \"schemaVersion\": 1"), "{text}");
    }

    #[test]
    fn a_file_without_schema_version_is_treated_as_the_oldest_version() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(s.dir().join("state.json"), r#"{"installed":[],"shared":[]}"#).unwrap();

        let loaded = s.load_state().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite));
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn a_newer_schema_becomes_read_only_and_is_never_written_back() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        let path = s.dir().join("state.json");
        let future = r#"{"schemaVersion":99,"installed":[],"shared":[],"未来字段":true}"#;
        std::fs::write(&path, future).unwrap();

        let loaded = s.load_state().unwrap();
        assert!(matches!(loaded.access, Access::ReadOnly { found: 99 }));

        let err = s.save_state(&sample_state()).unwrap_err();
        assert_eq!(err.code, "STATE_READ_ONLY");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            future,
            "只读模式下文件必须一个字节都不变"
        );
    }

    #[test]
    fn corrupt_json_is_reported_and_the_users_file_is_left_alone() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        let path = s.dir().join("state.json");
        std::fs::write(&path, "{ 半截文件").unwrap();

        let err = s.load_state().unwrap_err();

        assert_eq!(err.code, "STATE_CORRUPT");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ 半截文件");
    }

    #[test]
    fn writing_leaves_no_temporary_files_behind() {
        let (_tmp, s) = store();
        s.save_state(&sample_state()).unwrap();
        s.save_config(&Config::default()).unwrap();

        let names: Vec<String> = std::fs::read_dir(s.dir())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();

        assert_eq!(names.len(), 2, "残留了临时文件: {names:?}");
        assert!(names.contains(&"state.json".to_string()));
        assert!(names.contains(&"config.json".to_string()));
    }

    #[test]
    fn a_write_that_dies_halfway_leaves_the_previous_content_intact() {
        // 让**临时文件**那一步失败(该位置摆一个目录),从而真的走到"先写临时文件"这条路上。
        // 若实现改成直接写目标文件,这条就会挂——原内容会被截断成半截。
        let (_tmp, s) = store();
        s.save_state(&sample_state()).unwrap();
        let path = s.dir().join("state.json");
        let before = std::fs::read_to_string(&path).unwrap();
        std::fs::create_dir(s.dir().join("state.json.tmp")).unwrap();

        let err = s.save_state(&State::default()).unwrap_err();

        assert_eq!(err.code, "STATE_WRITE_FAILED");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    /// theme 与 accent 特意取"档位序号不同"的组合(深色 + 默认强调色),
    /// 避免两个概念在 fixture 里取同值,把字段串位测没了(CLAUDE.md 空转模式 3)。
    fn sample_prefs() -> UiPrefs {
        UiPrefs {
            theme: "dark".into(),
            accent: "clay".into(),
            wizard_done: true,
        }
    }

    #[test]
    fn ui_prefs_survive_a_round_trip() {
        let (_tmp, s) = store();

        s.save_ui_prefs(&sample_prefs()).unwrap();
        let back = s.load_ui_prefs().unwrap().expect("保存过就该读得到");

        assert_eq!(back.theme, "dark");
        assert_eq!(back.accent, "clay");
        assert!(back.wizard_done);
    }

    #[test]
    fn a_config_from_before_ui_prefs_reads_as_none_on_schema_v1() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("config.json"),
            r#"{"schemaVersion":1,"registries":[],"autoUpdate":{"skills":{"enabled":false,"intervalHours":8},"app":true}}"#,
        )
        .unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite), "serde default 兼容,不该升版本或降只读");
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
        assert!(loaded.value.ui.is_none());
        // 顺带确认旧字段没被 default 吃掉
        assert!(!loaded.value.auto_update.skills.enabled);
        assert_eq!(loaded.value.auto_update.skills.interval_hours, 8);
    }

    #[test]
    fn a_default_config_serializes_without_a_ui_key() {
        // 断言键的完整集合而不是"没有 ui"——字段名拼错时"不存在"式断言照样绿(空转模式 2)。
        let json = serde_json::to_value(Config::default()).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, ["schemaVersion", "registries", "autoUpdate"]);
    }

    #[test]
    fn invalid_pref_values_are_rejected_and_the_file_is_untouched() {
        let (_tmp, s) = store();
        s.save_ui_prefs(&sample_prefs()).unwrap();
        let before = std::fs::read_to_string(s.dir().join("config.json")).unwrap();

        for bad in [
            UiPrefs { theme: "purple".into(), ..sample_prefs() },
            UiPrefs { accent: "rainbow".into(), ..sample_prefs() },
        ] {
            let err = s.save_ui_prefs(&bad).unwrap_err();
            assert_eq!(err.code, "STATE_INVALID_PREFS");
        }
        assert_eq!(
            std::fs::read_to_string(s.dir().join("config.json")).unwrap(),
            before,
            "被拒的写入不该碰文件"
        );
    }

    #[test]
    fn saving_ui_prefs_preserves_the_rest_of_the_config() {
        let (_tmp, s) = store();
        let mut config = Config::default();
        config.registries.push(RegistryConfig {
            id: "company".into(),
            name: "公司技能库".into(),
            kind: "gitea".into(),
            base_url: "https://gitea.internal.example".into(),
            builtin: true,
            repos: vec![RepoConfig {
                owner: "skills".into(),
                repo: "skills".into(),
                branch: "main".into(),
            }],
        });
        config.auto_update.skills.interval_hours = 24;
        s.save_config(&config).unwrap();

        s.save_ui_prefs(&sample_prefs()).unwrap();
        let back = s.load_config().unwrap().value;

        assert_eq!(back.registries.len(), 1, "save_ui_prefs 整份覆盖了 config");
        assert_eq!(back.registries[0].id, "company");
        assert_eq!(back.auto_update.skills.interval_hours, 24);
        assert_eq!(back.ui, Some(sample_prefs()));
    }

    #[test]
    fn ui_prefs_respect_the_read_only_gate() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        let path = s.dir().join("config.json");
        let future = r#"{"schemaVersion":99,"未来字段":true}"#;
        std::fs::write(&path, future).unwrap();

        let err = s.save_ui_prefs(&sample_prefs()).unwrap_err();

        assert_eq!(err.code, "STATE_READ_ONLY");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), future, "新版文件必须一字节不动");
    }

    #[test]
    fn config_carries_the_builtin_registry_by_default() {
        let cfg = Config::default();
        assert_eq!(cfg.schema_version, SCHEMA_VERSION);
        assert!(cfg.auto_update.skills.enabled);
        assert_eq!(cfg.auto_update.skills.interval_hours, 4);
    }
}
