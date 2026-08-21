//! 与上游 `npx skills` **项目级** lock(`<项目根>/skills-lock.json`, schema v1)的差分测试。
//!
//! ground truth 由 `scripts/verify-project-lock.mjs` 跑**上游真实源码**(v1.5.23 的
//! `src/local-lock.ts`)录制,重新同步上游时执行 `pnpm verify:project-lock` 重生成。
//!
//! 与全局 lock(`tests/skill_lock_upstream_fixture.rs`)是**两份完全不同的契约**,别混:
//! 项目级文件名无点前缀、schema v1、**有尾随换行**、键写入前排序、**不含时间戳**
//! (上游注释:timestamp-free 是为了两个分支各自加技能时 git 能自动合并)。
//!
//! 两类断言:
//! - **lock 字节形状**:合法 v1(或文件不存在)时,我们的产出与上游**逐字节相同**
//!   ——这份文件会进用户的版本控制,格式漂一个字节就是一次无谓的全量改写;
//!   v2 / 无 version / 坏 JSON 时上游**整份重建**(会抹掉他人条目),本 app
//!   **有意分歧**:一个字节都不动。
//! - **computedHash 口径**:排序必须与上游 `localeCompare` 一致。按字节序算的话
//!   `metadata.json` 与 `SKILL.md` 的先后就反了,hash 永远不等,npx 每次 update
//!   都会把我们装的技能当成"改过了"重装。

use std::path::Path;

use skillsync_lib::core::project_lock::{self, LocalEntry, LocalLockOutcome};

const FIXTURE: &str = include_str!("fixtures/upstream-project-lock.json");

fn fixture() -> serde_json::Value {
    serde_json::from_str(FIXTURE).expect("fixture 必须可解析")
}

/// 把 fixture 里的 `files`(相对路径 → 内容)铺到临时目录。
fn materialize(dir: &Path, files: &serde_json::Value) {
    for (rel, content) in files.as_object().expect("files 必须是对象") {
        let full = dir.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, content.as_str().unwrap().as_bytes()).unwrap();
    }
}

/// 上游 hash 的六组场景逐个比对。**这是"安装能走项目级"的地基**:
/// 写进 lock 的 hash 与 npx 算的必须逐位相同。
#[test]
fn folder_hash_matches_upstream_for_every_recorded_case() {
    let doc = fixture();
    let cases = doc["hashCases"].as_array().unwrap();
    assert!(!cases.is_empty(), "fixture 里必须有 hash 场景");

    for case in cases {
        let name = case["name"].as_str().unwrap();
        // 非 ASCII 那组上游自己就依赖系统 locale(中文名在 zh-CN 按拼音排、
        // en-US 按另一种),同一技能在两台机器上 hash 都不同——不去匹配它,
        // 见 core::project_lock 模块头。这里只跳过,不假装通过。
        if case["files"]
            .as_object()
            .unwrap()
            .keys()
            .any(|k| !k.is_ascii())
        {
            continue;
        }

        let tmp = tempfile::tempdir().unwrap();
        materialize(tmp.path(), &case["files"]);

        let ours = project_lock::upstream_folder_hash(tmp.path()).expect("算 hash 不该失败");

        assert_eq!(
            ours,
            case["hash"].as_str().unwrap(),
            "hash 场景「{name}」与上游不一致"
        );
    }
}

/// 真实技能的 hash(取证时从 vercel-labs/agent-skills 装出来的那个)。
///
/// 这条与上一条的区别:上面是合成场景,这条是**真实世界的文件名组合**
/// ——`SKILL.md`(大写)与 `metadata.json`/`rules/*`(小写)混在一起,
/// 正是字节序与 collation 分歧的现场。
#[test]
fn folder_hash_matches_the_real_world_recording() {
    let doc = fixture();
    let Some(real) = doc.get("realWorld") else {
        return; // 录制脚本尚未产出这一段时不拦(见 verify-project-lock.mjs)
    };
    let tmp = tempfile::tempdir().unwrap();
    materialize(tmp.path(), &real["files"]);

    let ours = project_lock::upstream_folder_hash(tmp.path()).unwrap();

    assert_eq!(ours, real["hash"].as_str().unwrap(), "真实技能的 hash 不一致");
}

/// 排序口径本身:逐对比较必须与上游 `localeCompare` 同号。
#[test]
fn path_ordering_matches_upstream_collation() {
    // 取自 fixture 的排序分歧探针那组,外加真实技能的顶层文件名。
    let names = [
        "a-b.md",
        "ab.md",
        "a_b.md",
        "a.md",
        "A.md",
        "a1.md",
        "a10.md",
        "a2.md",
        "a-.md",
        "a b.md",
        "-a.md",
        "_a.md",
        "1.md",
        "SKILL.md",
        "metadata.json",
        "AGENTS.md",
        "README.md",
        "rules/_template.md",
    ];
    let mut sorted: Vec<&str> = names.to_vec();
    sorted.sort_by(|a, b| project_lock::upstream_path_cmp(a, b));

    // 上游 localeCompare 的实测结果(node -e 'names.sort((a,b)=>a.localeCompare(b))')。
    assert_eq!(
        sorted,
        vec![
            "_a.md",
            "-a.md",
            "1.md",
            "a b.md",
            "a_b.md",
            "a-.md",
            "a-b.md",
            "a.md",
            "A.md",
            "a1.md",
            "a10.md",
            "a2.md",
            "ab.md",
            "AGENTS.md",
            "metadata.json",
            "README.md",
            "rules/_template.md",
            "SKILL.md",
        ]
    );
}

/// 大小写是**第三级**权重:全串比完 primary 才逐位比大小写。
/// 逐位比较的实现会把 `aB` 判成大于 `Ab`(第一位 a<A 先出结果),与上游相反。
#[test]
fn case_difference_is_a_tertiary_weight_not_a_per_character_one() {
    use std::cmp::Ordering;
    assert_eq!(project_lock::upstream_path_cmp("aB", "Ab"), Ordering::Less);
    assert_eq!(project_lock::upstream_path_cmp("Ab", "aB"), Ordering::Greater);
    assert_eq!(project_lock::upstream_path_cmp("ab", "ab"), Ordering::Equal);
}

// ============================================================ lock 字节形状

/// 本 app 是否会真的写这份 lock:仅当文件不存在,或存在且是合法的 v1。
fn we_would_write(initial: Option<&str>) -> bool {
    match initial {
        None => true,
        Some(text) => serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .is_some_and(|v| v["version"].as_u64() == Some(1) && v["skills"].is_object()),
    }
}

fn entry_from(json: &serde_json::Value) -> LocalEntry {
    let s = |k: &str| json[k].as_str().unwrap_or_default().to_string();
    let opt = |k: &str| json[k].as_str().map(|v| v.to_string());
    LocalEntry {
        source: s("source"),
        source_url: opt("sourceUrl"),
        git_ref: opt("ref"),
        source_type: s("sourceType"),
        skill_path: opt("skillPath"),
        computed_hash: s("computedHash"),
    }
}

fn run_ops(path: &Path, ops: &serde_json::Value) -> Vec<LocalLockOutcome> {
    ops.as_array()
        .unwrap()
        .iter()
        .map(|op| {
            if let Some(add) = op.get("add") {
                project_lock::upsert(path, add[0].as_str().unwrap(), &entry_from(&add[1]))
            } else {
                project_lock::remove(path, op["remove"].as_str().unwrap())
            }
        })
        .collect()
}

#[test]
fn lock_bytes_match_upstream_on_writable_scenarios() {
    let doc = fixture();
    for scenario in doc["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let initial = scenario["initial"].as_str();
        if !we_would_write(initial) {
            continue; // 有意分歧的档由下一条测试断言
        }

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("skills-lock.json");
        if let Some(text) = initial {
            std::fs::write(&path, text).unwrap();
        }

        run_ops(&path, &scenario["ops"]);

        let ours = std::fs::read_to_string(&path).unwrap_or_default();
        let upstream = scenario["bytes"].as_str().unwrap_or_default();
        assert_eq!(ours, upstream, "场景「{name}」的字节与上游不一致");
    }
}

/// 看不懂的版本 / 坏 JSON:上游整份重建(会抹掉他人条目),本 app 一个字节不动。
#[test]
fn unreadable_lock_is_left_untouched_unlike_upstream() {
    let doc = fixture();
    let mut checked = 0;
    for scenario in doc["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let Some(initial) = scenario["initial"].as_str() else {
            continue;
        };
        if we_would_write(Some(initial)) {
            continue;
        }

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("skills-lock.json");
        std::fs::write(&path, initial).unwrap();

        let outcomes = run_ops(&path, &scenario["ops"]);

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            initial,
            "场景「{name}」:本 app 必须一个字节都不动"
        );
        assert!(
            outcomes
                .iter()
                .all(|o| matches!(o, LocalLockOutcome::Skipped { .. })),
            "场景「{name}」应全部报 Skipped,实际 {outcomes:?}"
        );
        // 上游在这些档确实会改写文件——录下来的字节与原文不同,正是分歧的证据。
        assert_ne!(
            scenario["bytes"].as_str().unwrap_or_default(),
            initial,
            "场景「{name}」若上游也没改写,这条测试就没有对照价值了"
        );
        checked += 1;
    }
    assert!(checked >= 4, "有意分歧的场景至少应有四个,实际 {checked}");
}
