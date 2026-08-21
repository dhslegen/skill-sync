//! `npx skills` 的**项目级** lock(`<项目根>/skills-lock.json`, schema v1)。
//!
//! 这是**外部契约**,与全局 lock([`crate::core::skill_lock`], `.skill-lock.json` v3)
//! 是两份完全不同的东西,别混:
//!
//! | | 全局 | 项目级 |
//! |---|---|---|
//! | 文件 | `~/.agents/.skill-lock.json`(带点) | `<项目根>/skills-lock.json`(不带点) |
//! | schema | 3 | 1 |
//! | 尾随换行 | 无 | **有** |
//! | 键序 | 保持原样 | **写入前排序** |
//! | 时间戳 | installedAt/updatedAt | **没有**(上游注释:timestamp-free 是为了让两个分支各自加技能时 git 能自动合并) |
//! | 指纹 | `skillFolderHash`(GitHub tree sha,非 GitHub 源填空串) | `computedHash`(**按磁盘内容现算**) |
//!
//! 立场同全局:我们是"客人"——只增删自己那一条,其余原样奉还;**看不懂就一个字节不动**
//! (上游遇到不认识的版本会整份重建,把别人的条目一起抹掉,本 app 不跟进)。
//! 行为由 `tests/project_lock_upstream_fixture.rs` 对着上游真实产出做字节级差分锁定。
//!
//! # 排序口径:必须是 collation,不能是字节序
//!
//! 上游 `computeSkillFolderHash` 用 `relativePath.localeCompare(...)` 排序。
//! 这**不是**字节序:collation 的 primary 级不分大小写,于是真实技能里
//! `metadata.json` 排在 `AGENTS.md` 与 `README.md` **之间**,而字节序把大写全排在
//! 小写前面。任何同时含 `SKILL.md`(大写)与小写文件的技能——也就是几乎全部——
//! 两种排法都不同。按字节序算出的 hash 与 npx 永不相等,后果是 npx 每次 `update`
//! 都把我们装的技能当成"改过了"重装一遍。
//!
//! 实测规则(2026-08-21,Node 22 full-icu):CLDR 根排序,标点 non-ignorable,
//! 大小写是**第三级**权重(全串比完 primary 再逐位比大小写,`aB < Ab`)。
//!
//! ⚠️ **非 ASCII 文件名上游自己就不确定**:`localeCompare` 不带 locale 参数时用
//! **系统默认 locale**,中文名在 `zh-CN` 下按拼音排、在 `en-US` 下按另一种顺序
//! ——同一个技能在两台机器上算出的 hash 都不同。这是上游的缺陷,我们**不去匹配**:
//! 非 ASCII 段按码点序兜底。后果可控——我方自己算、自己比,**永远自洽不会误报**;
//! 只有 npx 看我们装的这类技能时可能多重装一次,而它看自己装的也一样不稳。

use std::cmp::Ordering;
use std::path::Path;

use sha2::{Digest, Sha256};

/// 我们认识的 schema 版本。上游 `local-lock.ts` 的 `CURRENT_VERSION`。
pub const LOCAL_LOCK_SCHEMA_VERSION: u64 = 1;

/// 项目级 lock 的文件名。**没有点前缀**,而且上游有意让它进版本控制。
pub const LOCAL_LOCK_FILE: &str = "skills-lock.json";

/// 上游 `collectFiles` 跳过的目录。**只有这两个**——注意 `metadata.json` 是参与 hash 的,
/// 与 [`crate::core::fsops`] 的排除名单不同,两把尺子绝不混用。
const HASH_SKIP_DIRS: [&str; 2] = [".git", "node_modules"];

/// 一条项目级记账。字段顺序即写入 JSON 的键序(对齐上游 `add.ts` 的对象构造顺序)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalEntry {
    pub source: String,
    /// 归一化过 source 时的原始远端 URL。
    ///
    /// **Gitea(`sourceType: "git"`)必须给**:上游 `getLocalSource` 对 git/gitlab 档的
    /// 裸 `owner/repo` 简写直接返回 null,更新时报"missing sourceUrl for this generic
    /// Git source"——不给等于这条记账在 npx 那边根本没法还原。
    pub source_url: Option<String>,
    pub git_ref: Option<String>,
    pub source_type: String,
    /// 技能 SKILL.md 在来源仓里的路径,如 `skills/pdf/SKILL.md`。
    pub skill_path: Option<String>,
    pub computed_hash: String,
}

/// 双写结果。**任何一种都不该阻断主流程**——技能已经装好了,记账失败只该记日志。
#[derive(Debug)]
pub enum LocalLockOutcome {
    Written,
    Skipped { reason: String },
    Failed { reason: String },
}

/// lock 文件落点:项目根下的 `skills-lock.json`。
pub fn lock_path(project_root: &Path) -> std::path::PathBuf {
    project_root.join(LOCAL_LOCK_FILE)
}

/// 写入或更新一条记账。
pub fn upsert(path: &Path, key: &str, entry: &LocalEntry) -> LocalLockOutcome {
    let mut doc = match load(path) {
        Ok(doc) => doc,
        Err(outcome) => return outcome,
    };

    let mut obj = serde_json::Map::new();
    obj.insert("source".into(), entry.source.clone().into());
    // 上游把这三个声明为可选:值为 None 时**不出现**这个键,而不是写 null。
    if let Some(v) = &entry.source_url {
        obj.insert("sourceUrl".into(), v.clone().into());
    }
    if let Some(v) = &entry.git_ref {
        obj.insert("ref".into(), v.clone().into());
    }
    obj.insert("sourceType".into(), entry.source_type.clone().into());
    if let Some(v) = &entry.skill_path {
        obj.insert("skillPath".into(), v.clone().into());
    }
    obj.insert("computedHash".into(), entry.computed_hash.clone().into());

    doc["skills"][key] = serde_json::Value::Object(obj);
    write(path, &doc)
}

/// 移除一条记账。不存在则什么都不做(仍算成功,与上游 `removeSkillFromLocalLock` 一致)。
///
/// ⚠️ 上游在"要删的键不存在"时**提前 return、根本不写文件**;我们跟进这一点,
/// 否则会把一份内容相同、但键序被我们重排过的文件写回去。
pub fn remove(path: &Path, key: &str) -> LocalLockOutcome {
    let mut doc = match load(path) {
        Ok(doc) => doc,
        Err(outcome) => return outcome,
    };
    let present = doc["skills"]
        .as_object()
        .is_some_and(|m| m.contains_key(key));
    if !present {
        return LocalLockOutcome::Written;
    }
    if let Some(skills) = doc["skills"].as_object_mut() {
        skills.shift_remove(key);
    }
    write(path, &doc)
}

/// 读出全部条目。**任何看不懂都返回空**——读侧与写侧同一立场。
pub fn read_entries(path: &Path) -> Vec<(String, LocalEntry)> {
    let Ok(doc) = load(path) else {
        return Vec::new();
    };
    let Some(skills) = doc["skills"].as_object() else {
        return Vec::new();
    };
    skills
        .iter()
        .map(|(key, v)| {
            let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
            let opt = |k: &str| v[k].as_str().map(str::to_string);
            (
                key.clone(),
                LocalEntry {
                    source: s("source"),
                    source_url: opt("sourceUrl"),
                    git_ref: opt("ref"),
                    source_type: s("sourceType"),
                    skill_path: opt("skillPath"),
                    computed_hash: s("computedHash"),
                },
            )
        })
        .collect()
}

/// 读出可安全写回的文档。任何"看不懂"都转成 [`LocalLockOutcome::Skipped`] 从 `Err` 返回。
fn load(path: &Path) -> Result<serde_json::Value, LocalLockOutcome> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty_lock()),
        Err(e) => {
            return Err(LocalLockOutcome::Failed {
                reason: format!("读取 {} 失败: {e}", path.display()),
            })
        }
    };

    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Err(LocalLockOutcome::Skipped {
            reason: "文件不是合法 JSON,跳过与 npx skills 的记账同步".into(),
        });
    };

    // 上游遇到 version < 1 会整份丢弃重建,更高版本照写不误——两者都会破坏用户数据
    // (这份文件通常进了版本控制,抹掉别人的条目是能被 review 看见的破坏)。
    if doc["version"].as_u64() != Some(LOCAL_LOCK_SCHEMA_VERSION) || !doc["skills"].is_object() {
        return Err(LocalLockOutcome::Skipped {
            reason: format!(
                "记账文件的格式版本是 {},本应用只认识 {LOCAL_LOCK_SCHEMA_VERSION},已跳过同步",
                doc.get("version")
                    .map_or("(缺失)".into(), |v| v.to_string())
            ),
        });
    }
    Ok(doc)
}

fn empty_lock() -> serde_json::Value {
    serde_json::json!({ "version": LOCAL_LOCK_SCHEMA_VERSION, "skills": {} })
}

fn write(path: &Path, doc: &serde_json::Value) -> LocalLockOutcome {
    // 上游 writeLocalLock:键**排序**后 JSON.stringify(_, null, 2) + "\n"。
    // serde_json 开了 preserve_order,所以排序要我们自己做。
    let mut sorted = serde_json::Map::new();
    if let Some(skills) = doc["skills"].as_object() {
        let mut keys: Vec<&String> = skills.keys().collect();
        keys.sort();
        for k in keys {
            sorted.insert(k.clone(), skills[k].clone());
        }
    }
    let out = serde_json::json!({
        "version": LOCAL_LOCK_SCHEMA_VERSION,
        "skills": serde_json::Value::Object(sorted),
    });

    let Ok(text) = serde_json::to_string_pretty(&out) else {
        return LocalLockOutcome::Failed {
            reason: "记账内容无法序列化".into(),
        };
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return LocalLockOutcome::Failed {
                reason: format!("创建 {} 失败: {e}", parent.display()),
            };
        }
    }
    match std::fs::write(path, text + "\n") {
        Ok(()) => LocalLockOutcome::Written,
        Err(e) => LocalLockOutcome::Failed {
            reason: format!("写入 {} 失败: {e}", path.display()),
        },
    }
}

// ============================================================ computedHash

/// 上游 `computeSkillFolderHash` 的等价实现。
///
/// sha256,按相对路径的 **collation 序**(见模块头)排序,逐文件
/// `update(相对路径)` + `update(内容)`。跳过 `.git` 与 `node_modules`。
///
/// ⚠️ 与 [`crate::core::fsops::dir_content_hash`] 是**两把不同的尺子**
/// (那把排除 `metadata.json` 等、口径也不同),互串会让"有可用更新"永远误报。
pub fn upstream_folder_hash(dir: &Path) -> std::io::Result<String> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    collect(dir, dir, &mut files)?;
    files.sort_by(|a, b| upstream_path_cmp(&a.0, &b.0));

    let mut hasher = Sha256::new();
    for (rel, content) in &files {
        // 上游是**裸拼**路径与内容,没有长度前缀。
        // `fsops::ContentHasher` 会喂长度前缀(更严谨),但这里必须逐字节照抄上游
        // ——"顺手改好"就等于换了一把尺子,hash 与 npx 永不相等。
        hasher.update(rel.as_bytes());
        hasher.update(content);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{b:02x}");
    }
    Ok(hex)
}

fn collect(base: &Path, current: &Path, out: &mut Vec<(String, Vec<u8>)>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            let name = entry.file_name();
            if HASH_SKIP_DIRS.iter().any(|d| name == *d) {
                continue;
            }
            collect(base, &path, out)?;
        } else if file_type.is_file() {
            // 上游 `relative(baseDir, fullPath).split("\\").join("/")`:一律用 `/`。
            let rel = path
                .strip_prefix(base)
                .expect("collect 只会走 base 之下")
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            out.push((rel, std::fs::read(&path)?));
        }
    }
    Ok(())
}

// ============================================================ collation

/// 可打印 ASCII 的 primary 全序(实测导出,见模块头)。
///
/// 大小写字母在 primary 级**同权**(`a` 与 `A` 相同),差别落到第三级。
const PRIMARY_ORDER: &str =
    " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz";

/// 一个字符的 primary 权重。非 ASCII 一律排在最后并按码点比(见模块头的说明)。
fn primary(c: char) -> u32 {
    let folded = c.to_ascii_lowercase();
    match PRIMARY_ORDER.chars().position(|p| p == folded) {
        Some(i) => i as u32,
        // 控制字符等 PRIMARY_ORDER 里没有的 ASCII:排在可打印之前,按码点。
        None if c.is_ascii() => u32::from(c),
        // 非 ASCII:整体排在 ASCII 之后,按码点。上游此处依赖系统 locale,
        // 无从匹配,只保证我方自洽。
        None => PRIMARY_ORDER.chars().count() as u32 + u32::from(c),
    }
}

/// 第三级(大小写)权重:小写在前。
fn tertiary(c: char) -> u8 {
    if c.is_ascii_uppercase() {
        1
    } else {
        0
    }
}

/// 上游 `localeCompare` 的等价比较(ASCII 范围内实测一致,见模块头)。
///
/// UCA 的层级语义:**先把整串的 primary 权重比完**,全等才比第三级。
/// 逐字符地"先比 primary 再比大小写"是错的——那样 `aB` 会大于 `Ab`,与上游相反。
pub fn upstream_path_cmp(a: &str, b: &str) -> Ordering {
    let primary_cmp = a
        .chars()
        .map(primary)
        .cmp(b.chars().map(primary));
    if primary_cmp != Ordering::Equal {
        return primary_cmp;
    }
    a.chars().map(tertiary).cmp(b.chars().map(tertiary))
}
