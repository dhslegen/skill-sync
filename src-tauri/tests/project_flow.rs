//! 项目级事后改选(`core::project::set_agents` / `current_agents`)——v7 任务 3。
//!
//! v5 只在安装那一刻选一次「让哪些工具能用」,装完就没有入口能改。这里补的是
//! 那个"事后改选"工具,以及顺带修的一个既有缺陷:`project_skill_update` 此前会
//! 用当下的探测/禁用状态重建关联,而不是沿用这个项目当初装的那批——见
//! `current_agents` 的用途。
//!
//! 与 `tests/project_install.rs` 分工:那边管安装/卸载/预检的编排不变量,
//! 这里只管"装完之后再改选"这一件事。

use std::path::{Path, PathBuf};

use skillsync_lib::core::installer::SkillPayload;
use skillsync_lib::core::project::{self, SetAgentsDone};
use skillsync_lib::core::project_lock::{self, LocalEntry};

fn payload(name: &str, body: &str) -> SkillPayload {
    SkillPayload::new().with_file(
        "SKILL.md",
        format!("---\nname: {name}\ndescription: 测试用\n---\n\n{body}\n"),
    )
}

fn entry(hash: &str) -> LocalEntry {
    LocalEntry {
        source: "skills/skills".into(),
        source_url: Some("http://gitea.example.invalid/skills/skills.git".into()),
        git_ref: Some("main".into()),
        source_type: "git".into(),
        skill_path: Some("skills/weekly-report/SKILL.md".into()),
        computed_hash: hash.into(),
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

/// 造一个已经装好某个技能、且关联了指定 agent 的项目。
///
/// `project` 参数只是让测试读起来贴近真实场景(哪个项目),不影响任何路径计算
/// ——项目根本身就是一个独立的临时目录。
///
/// ⚠️ **agent 选择刻意避开共享同一个 `skillsDir` 的名字**(如 trae/trae-cn、
/// qoder/qoder-cn、zencoder/zenflow):项目级建链以「目录」为单位,共享目录的
/// agent 天然同进同退,拿它们做"精确断言恰好摘掉这一个、留下另一个"的测试
/// 用例只会测出一个巧合值,不是真实行为。`claude-code` / `windsurf` / `junie`
/// 在注册表里都是各自独占一个目录,断言才有确定性。
fn project_with_skill(project: &str, key: &str, agents: &[&str]) -> PathBuf {
    let _ = project;
    let root = tempfile::tempdir().unwrap().keep();
    let agent_names: Vec<String> = agents.iter().map(|a| a.to_string()).collect();
    project::install(&root, key, &payload(key, "正文"), &agent_names, &entry("x")).unwrap();
    root
}

/// 在某个工具的技能目录下手工放一个**实体目录**(不是链接),模拟用户自己的东西
/// 或另一个工具留下的、内容与本体不同的副本。
fn write_real_dir(dir: &Path, content: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), content).unwrap();
}

/// 缺的补上、多的摘掉——目标集合是全量,不是增量。
#[test]
fn setting_agents_links_the_missing_ones_and_unlinks_the_extra_ones() {
    let p = project_with_skill("erp", "weekly-report", &["claude-code", "windsurf"]);

    let done: SetAgentsDone = project::set_agents(
        &p,
        "weekly-report",
        &["claude-code".to_string(), "junie".to_string()],
    )
    .unwrap();

    assert_eq!(done.linked, vec!["junie".to_string()]);
    assert_eq!(done.unlinked, vec!["windsurf".to_string()]);
    assert!(done.kept.is_empty());
    assert!(p.join(".claude/skills/weekly-report").exists(), "claude-code 本来就在,应保留");
    assert!(
        !p.join(".windsurf/skills/weekly-report").exists(),
        "windsurf 不在新目标里,应被摘掉"
    );
    assert!(p.join(".junie/skills/weekly-report").exists(), "junie 是新加的,应建链");
}

/// 🔴 铁律 7:该摘的位置是内容不同的实体目录——不知道那是不是用户自己的东西,
/// 一个字节都不许动,并如实回报,不能悄悄吞掉。
#[test]
fn a_foreign_directory_in_a_tool_folder_is_kept_and_reported_not_deleted() {
    let p = project_with_skill("erp", "weekly-report", &["claude-code"]);
    write_real_dir(&p.join(".windsurf/skills/weekly-report"), "别人的东西");

    let done =
        project::set_agents(&p, "weekly-report", &["claude-code".to_string()]).unwrap();

    assert!(
        done.kept.contains(&"windsurf".to_string()),
        "应把留下的目录报告给调用方,实际 {:?}",
        done.kept
    );
    assert!(
        p.join(".windsurf/skills/weekly-report").join("SKILL.md").is_file(),
        "内容不同的实体目录绝不能删"
    );
    assert_eq!(
        read(&p.join(".windsurf/skills/weekly-report/SKILL.md")),
        "别人的东西",
        "内容必须原封不动"
    );
}

/// `project_skill_update` 该沿用这个项目当初装的那批,不是灌探测出来的默认值
/// ——`current_agents` 就是从磁盘反推那批的唯一实现。
#[test]
fn update_reuses_what_is_actually_linked_today_not_the_detected_defaults() {
    let p = project_with_skill("erp", "weekly-report", &["claude-code"]);

    assert_eq!(
        project::current_agents(&p, "weekly-report").unwrap(),
        vec!["claude-code".to_string()]
    );
}

/// `set_agents` 管的是"这个技能对哪些工具生效",与 `skills-lock.json`(来源 + 内容
/// hash)毫无关系——lock 没有 links 字段(对齐上游 schema,不能擅自加),事后改选
/// 因此必须是纯粹的建链/摘链动作,lock 文件一个字节都不该变。
#[test]
fn set_agents_never_touches_the_lock_file() {
    let p = project_with_skill("erp", "weekly-report", &["claude-code"]);
    let lock_before = read(&project_lock::lock_path(&p));

    project::set_agents(
        &p,
        "weekly-report",
        &["claude-code".to_string(), "junie".to_string()],
    )
    .unwrap();

    assert_eq!(
        read(&project_lock::lock_path(&p)),
        lock_before,
        "set_agents 不该碰 lock 文件"
    );
}
