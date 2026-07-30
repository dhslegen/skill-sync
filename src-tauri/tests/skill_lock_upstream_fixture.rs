//! 与上游 `npx skills` 全局 lock(`.skill-lock.json`, schema v3)的差分测试。
//!
//! ground truth 由 `scripts/verify-skill-lock.mjs` 跑**上游真实源码**录制,
//! 重新同步上游时执行 `pnpm verify:lock` 重生成。
//!
//! 这个文件是外部契约:`npx skills` 与本 app 会同时读写它。因此比对到**字节级**——
//! 缩进、键序、有无末尾换行任何一处不同,都会让另一个工具看到一份被无谓改写过的文件。
//!
//! 两类场景:
//! - lock 本就是合法 v3(或不存在)→ 我们的产出必须与上游**逐字节相同**;
//! - lock 是 v2 / v4 / 无 version / 坏 JSON → 上游会**改写甚至整体抹掉**用户数据,
//!   本 app **有意分歧**:一个字节都不动(交接包 3.4:非 3 则跳过双写并记日志,不得报错阻断主流程)。

use std::path::Path;

use skillsync_lib::core::skill_lock::{self, LockEntry, LockOutcome};

const FIXTURE: &str = include_str!("fixtures/upstream-skill-lock.json");

struct Scenario {
    name: String,
    initial: Option<String>,
    ops: serde_json::Value,
    lock_path_under_home: String,
    expected_bytes: Option<String>,
}

fn scenarios() -> (String, Vec<Scenario>) {
    let doc: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture 必须可解析");
    let fixed_now = doc["fixedNow"].as_str().unwrap().to_string();
    let list = doc["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| Scenario {
            name: s["name"].as_str().unwrap().to_string(),
            initial: s["initial"].as_str().map(|v| v.to_string()),
            ops: s["ops"].clone(),
            lock_path_under_home: s["lockPathUnderHome"].as_str().unwrap().to_string(),
            expected_bytes: s["bytes"].as_str().map(|v| v.to_string()),
        })
        .collect();
    (fixed_now, list)
}

/// 本 app 是否会真的写这份 lock:仅当文件不存在,或存在且是合法的 v3。
fn we_would_write(initial: Option<&str>) -> bool {
    match initial {
        None => true,
        Some(text) => serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .is_some_and(|v| v["version"].as_u64() == Some(3) && v["skills"].is_object()),
    }
}

fn entry_from(json: &serde_json::Value) -> LockEntry {
    let s = |k: &str| json[k].as_str().unwrap_or_default().to_string();
    let opt = |k: &str| json[k].as_str().map(|v| v.to_string());
    LockEntry {
        source: s("source"),
        source_type: s("sourceType"),
        source_url: s("sourceUrl"),
        git_ref: opt("ref"),
        skill_path: opt("skillPath"),
        skill_folder_hash: s("skillFolderHash"),
    }
}

fn run_ops(path: &Path, ops: &serde_json::Value, now: &str) -> Vec<LockOutcome> {
    ops.as_array()
        .unwrap()
        .iter()
        .map(|op| {
            if let Some(add) = op.get("add") {
                let key = add[0].as_str().unwrap();
                skill_lock::upsert(path, key, &entry_from(&add[1]), now)
            } else {
                skill_lock::remove(path, op["remove"].as_str().unwrap())
            }
        })
        .collect()
}

#[test]
fn matches_upstream_byte_for_byte_on_valid_v3_locks() {
    let (fixed_now, list) = scenarios();
    let mut checked = 0;
    for sc in list.iter().filter(|s| we_would_write(s.initial.as_deref())) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(&sc.lock_path_under_home);
        if let Some(initial) = &sc.initial {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, initial).unwrap();
        }

        let outcomes = run_ops(&path, &sc.ops, &fixed_now);
        assert!(
            outcomes.iter().all(|o| matches!(o, LockOutcome::Written)),
            "[{}] 合法 v3 上的双写不该被跳过: {outcomes:?}",
            sc.name
        );

        let actual = std::fs::read_to_string(&path).ok();
        assert_eq!(
            actual.as_deref(),
            sc.expected_bytes.as_deref(),
            "[{}] 与上游产出的字节不一致",
            sc.name
        );
        checked += 1;
    }
    assert!(checked >= 7, "合法 v3 场景应有 7 个以上,实际 {checked}");
}

#[test]
fn refuses_to_touch_locks_whose_schema_we_do_not_understand() {
    let (fixed_now, list) = scenarios();
    let mut checked = 0;
    for sc in list.iter().filter(|s| !we_would_write(s.initial.as_deref())) {
        let initial = sc.initial.as_ref().expect("不可写的场景必有初始内容");
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(&sc.lock_path_under_home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, initial).unwrap();

        let outcomes = run_ops(&path, &sc.ops, &fixed_now);
        assert!(
            outcomes
                .iter()
                .all(|o| matches!(o, LockOutcome::Skipped { .. })),
            "[{}] 不认识的 schema 必须跳过而不是写入: {outcomes:?}",
            sc.name
        );

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            *initial,
            "[{}] 文件被改动了——上游在此会改写甚至整体抹掉用户数据,本 app 绝不跟进",
            sc.name
        );
        // 反过来确认上游确实动了它,否则这条"有意分歧"就名不副实
        assert_ne!(
            sc.expected_bytes.as_deref(),
            Some(initial.as_str()),
            "[{}] 上游并未改动该文件,场景失去意义",
            sc.name
        );
        checked += 1;
    }
    assert!(checked >= 5, "不可写场景应有 5 个以上,实际 {checked}");
}
