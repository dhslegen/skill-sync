//! `npx skills` 的全局 lock(`~/.agents/.skill-lock.json`, schema v3)双写。
//!
//! 这是**外部契约**,不是我们的数据:`npx skills` 与本 app 会同时读写它。
//! 因此本模块的立场是"客人"——只增删自己那一条,其余内容原样奉还。
//! 行为由 `tests/skill_lock_upstream_fixture.rs` 对着上游真实产出做字节级差分锁定。

use std::path::{Path, PathBuf};

use crate::core::agents::AgentEnv;

/// 我们认识的 schema 版本。上游 `skill-lock.ts` 的 `CURRENT_VERSION`。
pub const LOCK_SCHEMA_VERSION: u64 = 3;

const AGENTS_DIR: &str = ".agents";
const LOCK_FILE: &str = ".skill-lock.json";

#[derive(Debug, Clone)]
pub struct LockEntry {
    pub source: String,
    pub source_type: String,
    pub source_url: String,
    pub git_ref: Option<String>,
    pub skill_path: Option<String>,
    pub skill_folder_hash: String,
}

/// 双写结果。**任何一种都不该阻断主流程**——技能已经装好了,记账失败只该记日志。
#[derive(Debug)]
pub enum LockOutcome {
    Written,
    Skipped { reason: String },
    Failed { reason: String },
}

/// lock 文件落点。`XDG_STATE_HOME` 优先(上游 `getSkillLockPath`),否则 `~/.agents/.skill-lock.json`。
///
/// XDG 这一支设计文档没提,是从上游源码里读出来的:漏掉它会在设了该变量的机器上
/// 写到一个 `npx skills` 根本不看的位置——双写等于没写,且悄无声息。
pub fn lock_path(env: &dyn AgentEnv) -> Option<PathBuf> {
    if let Some(xdg) = env.var("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(xdg).join("skills").join(LOCK_FILE));
    }
    Some(env.home()?.join(AGENTS_DIR).join(LOCK_FILE))
}

/// 写入或更新一条记账。`now` 为 ISO-8601 时间戳,由调用方注入以便测试。
///
/// `installedAt` 首次写入时设定、之后一直保留,`updatedAt` 每次刷新(对齐上游 `addSkillToLock`)。
pub fn upsert(path: &Path, key: &str, entry: &LockEntry, now: &str) -> LockOutcome {
    let mut doc = match load(path) {
        Ok(doc) => doc,
        Err(outcome) => return outcome,
    };

    let installed_at = doc["skills"][key]["installedAt"]
        .as_str()
        .unwrap_or(now)
        .to_string();

    let mut obj = serde_json::Map::new();
    obj.insert("source".into(), entry.source.clone().into());
    obj.insert("sourceType".into(), entry.source_type.clone().into());
    obj.insert("sourceUrl".into(), entry.source_url.clone().into());
    // 上游把 ref / skillPath 声明为可选:值为 None 时**不出现**这个键,而不是写 null。
    if let Some(v) = &entry.git_ref {
        obj.insert("ref".into(), v.clone().into());
    }
    if let Some(v) = &entry.skill_path {
        obj.insert("skillPath".into(), v.clone().into());
    }
    obj.insert(
        "skillFolderHash".into(),
        entry.skill_folder_hash.clone().into(),
    );
    obj.insert("installedAt".into(), installed_at.into());
    obj.insert("updatedAt".into(), now.to_string().into());

    doc["skills"][key] = serde_json::Value::Object(obj);
    write(path, &doc)
}

/// lock 里的一条上游记账(读侧,M3 任务 6「认领」用)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamEntry {
    /// `skills` 对象里的键,即 canonical 目录名。
    pub key: String,
    pub source: String,
    pub source_type: String,
    pub source_url: String,
    pub skill_path: String,
    pub git_ref: String,
    pub installed_at: Option<String>,
}

/// 读出 lock 里的全部条目。**任何看不懂都返回空**(文件缺失、坏 JSON、版本不认识)
/// ——读侧与写侧同一立场:这是别人的数据,看不懂就当没有,绝不报错阻断流程。
pub fn read_entries(path: &Path) -> Vec<UpstreamEntry> {
    let Ok(doc) = load(path) else {
        return Vec::new();
    };
    let Some(skills) = doc["skills"].as_object() else {
        return Vec::new();
    };
    skills
        .iter()
        .map(|(key, v)| UpstreamEntry {
            key: key.clone(),
            source: v["source"].as_str().unwrap_or_default().to_string(),
            source_type: v["sourceType"].as_str().unwrap_or_default().to_string(),
            source_url: v["sourceUrl"].as_str().unwrap_or_default().to_string(),
            skill_path: v["skillPath"].as_str().unwrap_or_default().to_string(),
            git_ref: v["ref"].as_str().unwrap_or_default().to_string(),
            installed_at: v["installedAt"].as_str().map(str::to_string),
        })
        .collect()
}

/// 移除一条记账。不存在则什么都不做(仍算成功,与上游 `removeSkillFromLock` 的语义一致)。
pub fn remove(path: &Path, key: &str) -> LockOutcome {
    let mut doc = match load(path) {
        Ok(doc) => doc,
        Err(outcome) => return outcome,
    };
    if let Some(skills) = doc["skills"].as_object_mut() {
        skills.shift_remove(key);
    }
    write(path, &doc)
}

/// 读出可安全写回的文档。任何"看不懂"都转成 [`LockOutcome::Skipped`] 从 `Err` 返回。
fn load(path: &Path) -> Result<serde_json::Value, LockOutcome> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        // 文件不存在是正常起点:建一份空的 v3,形状与上游 createEmptyLockFile 一致。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_lock()),
        Err(e) => {
            return Err(LockOutcome::Failed {
                reason: format!("读取 {} 失败: {e}", path.display()),
            })
        }
    };

    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Err(LockOutcome::Skipped {
            reason: "文件不是合法 JSON,跳过与 npx skills 的记账同步".into(),
        });
    };

    // 上游遇到 version < 3 会把整份文件丢弃重建,遇到更高版本则照写不误(已由 fixture 录实)。
    // 两者都会破坏用户数据,本 app 一律不跟进——我们只在自己认得的 schema 上动手。
    let version = doc["version"].as_u64();
    if version != Some(LOCK_SCHEMA_VERSION) || !doc["skills"].is_object() {
        return Err(LockOutcome::Skipped {
            reason: format!(
                "记账文件的格式版本是 {},本应用只认识 {LOCK_SCHEMA_VERSION},已跳过同步",
                doc.get("version").map_or("(缺失)".into(), |v| v.to_string())
            ),
        });
    }
    Ok(doc)
}

fn empty_lock() -> serde_json::Value {
    serde_json::json!({
        "version": LOCK_SCHEMA_VERSION,
        "skills": {},
        "dismissed": {},
    })
}

fn write(path: &Path, doc: &serde_json::Value) -> LockOutcome {
    // 上游用 JSON.stringify(lock, null, 2),**不带末尾换行**;serde_json 的 pretty 输出与之一致。
    let Ok(text) = serde_json::to_string_pretty(doc) else {
        return LockOutcome::Failed {
            reason: "记账内容无法序列化".into(),
        };
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return LockOutcome::Failed {
                reason: format!("创建 {} 失败: {e}", parent.display()),
            };
        }
    }
    match std::fs::write(path, text) {
        Ok(()) => LockOutcome::Written,
        Err(e) => LockOutcome::Failed {
            reason: format!("写入 {} 失败: {e}", path.display()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Env {
        home: Option<PathBuf>,
        vars: HashMap<String, String>,
    }

    impl Env {
        fn new(home: Option<&str>) -> Self {
            Self {
                home: home.map(PathBuf::from),
                vars: HashMap::new(),
            }
        }
        fn with(mut self, k: &str, v: &str) -> Self {
            self.vars.insert(k.into(), v.into());
            self
        }
    }

    impl AgentEnv for Env {
        fn home(&self) -> Option<PathBuf> {
            self.home.clone()
        }
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).cloned()
        }
        fn path_exists(&self, _path: &Path) -> bool {
            false
        }
        fn read_to_string(&self, _path: &Path) -> Option<String> {
            None
        }
    }

    fn shown(p: Option<PathBuf>) -> String {
        p.unwrap()
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR_STR, "/")
    }

    #[test]
    fn defaults_to_agents_dir_under_home() {
        let env = Env::new(Some("/h"));
        assert_eq!(shown(lock_path(&env)), "/h/.agents/.skill-lock.json");
    }

    #[test]
    fn xdg_state_home_wins_over_home() {
        let env = Env::new(Some("/h")).with("XDG_STATE_HOME", "/xdg");
        assert_eq!(shown(lock_path(&env)), "/xdg/skills/.skill-lock.json");
    }

    #[test]
    fn empty_xdg_state_home_falls_back() {
        let env = Env::new(Some("/h")).with("XDG_STATE_HOME", "");
        assert_eq!(shown(lock_path(&env)), "/h/.agents/.skill-lock.json");
    }

    #[test]
    fn without_home_there_is_no_lock_path() {
        assert!(lock_path(&Env::new(None)).is_none());
    }

    #[test]
    fn unwritable_path_reports_failure_instead_of_panicking() {
        // 父目录位置上是个文件 → create_dir_all 必失败。记账失败绝不能把主流程带崩。
        let tmp = tempfile::tempdir().unwrap();
        let blocker = tmp.path().join("blocker");
        std::fs::write(&blocker, "我是文件不是目录").unwrap();
        let path = blocker.join(".skill-lock.json");

        let outcome = upsert(&path, "x", &sample_entry(), "2026-07-30T00:00:00.000Z");

        assert!(matches!(outcome, LockOutcome::Failed { .. }), "{outcome:?}");
    }

    #[test]
    fn optional_fields_are_omitted_not_nulled() {
        // 上游把 ref / skillPath 声明为可选。写成 null 虽然也是合法 JSON,
        // 但上游的 TS 类型是 `ref?: string`,null 会让读到它的代码拿到一个非 string 值。
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(".skill-lock.json");
        let entry = LockEntry {
            git_ref: None,
            skill_path: None,
            ..sample_entry()
        };

        upsert(&path, "x", &entry, "2026-07-30T00:00:00.000Z");

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("\"ref\""), "{text}");
        assert!(!text.contains("\"skillPath\""), "{text}");
        assert!(!text.contains("null"), "{text}");
    }

    fn sample_entry() -> LockEntry {
        LockEntry {
            source: "skills/skills".into(),
            source_type: "gitea".into(),
            source_url: "http://example.invalid/skills/skills".into(),
            git_ref: Some("main".into()),
            skill_path: Some("skills/x/SKILL.md".into()),
            skill_folder_hash: String::new(),
        }
    }
}
