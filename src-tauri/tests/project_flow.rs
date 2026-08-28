//! 项目级事后改选(`core::project::set_agents` / `current_agents`)——v7 任务 3。
//!
//! v5 只在安装那一刻选一次「让哪些工具能用」,装完就没有入口能改。这里补的是
//! 那个"事后改选"工具,以及顺带修的一个既有缺陷:`project_skill_update` 此前会
//! 用当下的探测/禁用状态重建关联,而不是沿用这个项目当初装的那批——见
//! `current_agents` 的用途(那条接线本身由 `tests/project_update_agent_wiring.rs`
//! 文本级守卫钉住,这里测的是纯逻辑)。
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
/// 返回值持有 `TempDir`——**必须让调用方把它跟路径一起绑定住**(`let (_tmp, p) = ...`),
/// 不能只取路径:`TempDir` 一 drop 就删目录,只取路径会让每条测试各自泄漏一个
/// 临时目录(复审 M4;`tests/project_install.rs::project_dir` 是同款持有写法)。
///
/// `project` 参数只是让测试读起来贴近真实场景(哪个项目),不影响任何路径计算
/// ——项目根本身就是一个独立的临时目录。
///
/// ⚠️ **agent 选择刻意避开共享同一个 `skillsDir` 的名字**(如 trae/trae-cn、
/// qoder/qoder-cn、zencoder/zenflow):项目级建链以「目录」为单位,共享目录的
/// agent 天然同进同退,拿它们做"精确断言恰好摘掉这一个、留下另一个"的测试
/// 用例只会测出一个巧合值,不是真实行为。`claude-code` / `windsurf` / `junie`
/// 在注册表里都是各自独占一个目录,断言才有确定性。
fn project_with_skill(project: &str, key: &str, agents: &[&str]) -> (tempfile::TempDir, PathBuf) {
    let _ = project;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let agent_names: Vec<String> = agents.iter().map(|a| a.to_string()).collect();
    project::install(&root, key, &payload(key, "正文"), &agent_names, &entry("x")).unwrap();
    (tmp, root)
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
    let (_tmp, p) = project_with_skill("erp", "weekly-report", &["claude-code", "windsurf"]);

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
///
/// ⚠️ **这条测试的证明力其实来自 `fsops::unlink_dir`,不是来自 `set_agents` 自己
/// 新增的判断**(复审 I2):`unlink_dir` 对实体目录直接返回 `FS_NOT_A_LINK` 早退,
/// 就算把 `set_agents` 里"先判 Real/Foreign 才不摘"的那道分支整个删掉,这个用例
/// 照样因为 `unlink_dir` 的 `?` 早退而红,文件依旧完好——铁律 7 在这一档并不是靠
/// 本函数的判断力兜住的。真正吃力的是下面那条 `a_hand_made_symlink_...`。
#[test]
fn a_foreign_directory_in_a_tool_folder_is_kept_and_reported_not_deleted() {
    let (_tmp, p) = project_with_skill("erp", "weekly-report", &["claude-code"]);
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

/// 🔴 铁律 7 真正吃力的那一档(复审 I2):位置是**用户手工建的、指向别处的符号
/// 链接**,不是实体目录。`fsops::unlink_dir` 对这种东西"认得出是一条链接、照删
/// 不误"(`fsops.rs:198-207`,与上面那条实体目录的早退路径不同)——所以"不删"
/// 必须是 `set_agents` 自己判断出来的,不能指望下层帮忙兜底。
#[cfg(unix)]
#[test]
fn a_hand_made_symlink_pointing_elsewhere_is_kept_and_reported_not_unlinked() {
    let (_tmp, p) = project_with_skill("erp", "weekly-report", &["claude-code"]);

    let elsewhere = p.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let link = p.join(".windsurf/skills/weekly-report");
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &link).unwrap();

    let done =
        project::set_agents(&p, "weekly-report", &["claude-code".to_string()]).unwrap();

    assert!(
        done.kept.contains(&"windsurf".to_string()),
        "指向别处的手工链接应留下并回报,实际 {:?}",
        done.kept
    );
    assert!(!done.unlinked.contains(&"windsurf".to_string()));
    assert_eq!(
        std::fs::read_link(&link).unwrap(),
        elsewhere,
        "链接必须原样保留,指向不能被改写"
    );
}

/// `project_skill_update` 该沿用这个项目当初装的那批,不是灌探测出来的默认值
/// ——`current_agents` 就是从磁盘反推那批的唯一实现。
#[test]
fn update_reuses_what_is_actually_linked_today_not_the_detected_defaults() {
    let (_tmp, p) = project_with_skill("erp", "weekly-report", &["claude-code"]);

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
    let (_tmp, p) = project_with_skill("erp", "weekly-report", &["claude-code"]);
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

/// 🔴 铁律 7 的入口守卫(复审 I3):`key` 对应的本体不存在时(比如技能已经被
/// `project::remove` 移除、界面的行还没来得及刷新)绝不能照样往项目里的各个
/// 工具目录下建出指向"不存在的本体"的悬空链接——`set_agents` 直通前端 IPC,
/// 拍板全靠界面,core 这一层必须自己把住这道闸。
#[test]
fn set_agents_refuses_to_run_against_a_missing_body() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    // 没有 project::install 过,`.agents/skills/weekly-report` 从不存在。

    let err =
        project::set_agents(&root, "weekly-report", &["claude-code".to_string()]).unwrap_err();

    assert_eq!(err.code, "FS_MISSING_SKILL");
    assert!(
        !root.join(".claude").exists(),
        "本体不存在时不该在项目里建出任何东西,实际已建出 .claude"
    );
}

/// Windows 降级链是 `[Junction, Copy]`,junction 建链失败时留下的就是**实体目录**
/// (对齐 `remove` 处理"降级复制副本"的既有姿态)。这份副本如果与本体内容相同,
/// 必须能被摘掉——否则:①用户取消勾选该工具没有任何效果,技能继续对它生效;
/// ②`current_agents` 只认 `Linked(_)`,这份副本会从名单里悄悄消失,更新时永远
/// 不会被刷新成最新内容(复审 I4)。
#[test]
fn a_copied_directory_identical_to_the_body_is_treated_as_unlinkable() {
    let (_tmp, p) = project_with_skill("erp", "weekly-report", &["claude-code"]);
    // 从本体现读内容再原样复制,保证"逐字节相同"这个前提是真的,不是巧合凑出来的
    // 两段字面量——`payload()` 的措辞将来一改,手写字面量的版本就会悄悄失真。
    let body_skill_md = read(&p.join(".agents/skills/weekly-report/SKILL.md"));
    // 模拟降级复制:内容与本体逐字节相同,但落地成了实体目录而非链接。
    write_real_dir(&p.join(".windsurf/skills/weekly-report"), &body_skill_md);

    let done =
        project::set_agents(&p, "weekly-report", &["claude-code".to_string()]).unwrap();

    assert!(
        done.unlinked.contains(&"windsurf".to_string()),
        "内容与本体相同的降级副本应被当作摘掉处理,实际 {:?}",
        done
    );
    assert!(done.kept.is_empty());
    assert!(
        !p.join(".windsurf/skills/weekly-report").exists(),
        "内容相同的副本应被删除"
    );
}
