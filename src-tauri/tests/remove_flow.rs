//! 移除流程编排测试。与 acquire_flow 同一条断言纪律:
//! 破坏性守卫的断言口径是**磁盘上的字节有没有变**,不是函数返回了哪个枚举。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::installer::{Installer, LinkHealth, SkillPayload};
use skillsync_lib::core::remove::{self, RemoveOutcome};
use skillsync_lib::core::fsops::OnOccupied;
use skillsync_lib::core::state::{InstalledSkill, LinkRecord, SkillSource, Store};

const NOW: &str = "2026-07-30T12:00:00.000Z";

struct TmpEnv {
    home: PathBuf,
    vars: HashMap<String, String>,
}

impl AgentEnv for TmpEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

struct Ctx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    registry: AgentRegistry,
    store: Store,
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = Store::new(home.join(".skillsync"));
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
        },
        env,
    )
}

fn payload(body: &str) -> SkillPayload {
    SkillPayload::new().with_file(
        "SKILL.md",
        format!("---\nname: 技能·{body}\ndescription: 说明\n---\n{body}\n"),
    )
}

/// 装一个技能并把账记全:canonical 落盘 + 建链 + state + lock。
/// 不走 acquire(那需要 wiremock);移除编排消费的只是 state 里的记账,形状一致即可。
fn install_one(c: &Ctx, env: &TmpEnv, slug: &str) {
    let installer = Installer::new(&c.registry, env);
    let report = installer
        .install(slug, &payload(slug), &["claude-code".to_string()], OnOccupied::Fail)
        .unwrap();
    assert!(report.links.iter().all(|l| !matches!(
        l.result,
        skillsync_lib::core::installer::LinkResult::Failed { .. }
    )));

    let canonical = c.home.join(".agents").join("skills").join(slug);
    let mut state = c.store.load_state().map(|l| l.value).unwrap_or_default();
    state.installed.push(InstalledSkill {
        name: slug.to_string(),
        source: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: format!("skills/{slug}"),
            git_ref: "aaa1111".into(),
        },
        commit_sha: "aaa1111".into(),
        content_hash: fsops::dir_content_hash(&canonical).unwrap(),
        origin: None,
        agents: vec!["claude-code".into()],
        links: report
            .links
            .iter()
            .filter_map(|l| match &l.result {
                skillsync_lib::core::installer::LinkResult::Linked { mode }
                | skillsync_lib::core::installer::LinkResult::Unchanged { mode } => {
                    Some(LinkRecord { dir: l.dir.clone(), mode: mode.clone() })
                }
                _ => None,
            })
            .collect(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    c.store.save_state(&state).unwrap();

    std::fs::write(
        c.home.join(".agents").join(".skill-lock.json"),
        serde_json::json!({
            "version": 3,
            "skills": {
                slug: { "source": "skills/skills", "sourceType": "gitea" },
                "someone-elses": { "source": "acme/skills", "sourceType": "github" }
            }
        })
        .to_string(),
    )
    .unwrap();
}

fn do_remove(c: &Ctx, env: &TmpEnv, slug: &str, force: bool) -> Result<RemoveOutcome, skillsync_lib::error::AppError> {
    let installer = Installer::new(&c.registry, env);
    remove::remove(&installer, env, &c.store, slug, force)
}

fn canonical(c: &Ctx, slug: &str) -> PathBuf {
    c.home.join(".agents").join("skills").join(slug)
}

fn link(c: &Ctx, slug: &str) -> PathBuf {
    c.home.join(".claude").join("skills").join(slug)
}

/// 删掉一条关联,模拟"链接丢了"。
///
/// 必须两种都试:POSIX 上关联是 symlink,只有 `remove_file` 删得动;Windows 上是
/// **junction**(目录重解析点),`remove_file` 会直接 `Access is denied`
/// ——`repair_rebuilds_a_lost_link…` 就是因为只写了 `remove_file(..).unwrap()`,
/// 在 Windows CI 上从 M1 任务 10 起连红了五个提交(macOS 一直绿,所以一直没人看见)。
///
/// 用 `remove_dir` 而不是 `remove_dir_all`:对 junction 前者只摘掉重解析点,
/// 后者有把**技能本体**连锅端掉的风险——那正是这个测试接下来要断言还在的东西。
///
/// 结尾断言"真的没了":只写 `let _ = remove_file` 会让"其实没删掉"变成静默通过,
/// 于是 repair 什么都不用做也能绿——测试就空转了。
fn drop_link(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir(path);
    assert!(
        std::fs::symlink_metadata(path).is_err(),
        "没能删掉关联,后面的断言就不算数了: {}",
        path.display()
    );
}

// ============================================================ 正常移除

#[test]
fn removing_cleans_body_links_state_and_lock() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    assert!(link(&c, "weekly-report").exists(), "前置:链接已建立");

    let outcome = do_remove(&c, &env, "weekly-report", false).unwrap();

    let RemoveOutcome::Removed { report, lock } = outcome else {
        panic!("没改过的技能移除不该再问");
    };
    assert!(report.canonical_removed);
    assert_eq!(lock, "written");
    // 磁盘:本体与链接都没了
    assert!(!canonical(&c, "weekly-report").exists(), "本体还在");
    assert!(
        std::fs::symlink_metadata(link(&c, "weekly-report")).is_err(),
        "关联还在"
    );
    // 账:state 条目没了
    assert!(c.store.load_state().unwrap().value.installed.is_empty());
    // 外部契约:自己的条目没了,别人的一个字都不动
    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(c.home.join(".agents").join(".skill-lock.json")).unwrap(),
    )
    .unwrap();
    assert!(lock["skills"]["weekly-report"].is_null());
    assert_eq!(lock["skills"]["someone-elses"]["source"], "acme/skills");
}

#[test]
fn removing_one_skill_leaves_the_other_untouched() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    install_one(&c, &env, "meeting-notes");

    do_remove(&c, &env, "weekly-report", false).unwrap();

    assert!(canonical(&c, "meeting-notes").join("SKILL.md").is_file());
    assert!(link(&c, "meeting-notes").exists());
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed.len(), 1);
    assert_eq!(state.installed[0].name, "meeting-notes");
}

// ============================================================ 改过的技能

#[test]
fn a_modified_skill_is_not_removed_without_confirmation() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let dir = canonical(&c, "weekly-report");
    std::fs::write(dir.join("SKILL.md"), "我的改动\n").unwrap();
    let mine = std::fs::read(dir.join("SKILL.md")).unwrap();

    let outcome = do_remove(&c, &env, "weekly-report", false).unwrap();

    assert!(matches!(outcome, RemoveOutcome::NeedsDecision));
    // 真正要断的是磁盘与账都原封不动
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), mine, "用户的改动被动过了");
    assert!(link(&c, "weekly-report").exists(), "链接被提前摘了");
    assert_eq!(c.store.load_state().unwrap().value.installed.len(), 1, "账被提前清了");
}

#[test]
fn a_modified_skill_is_removed_when_the_user_confirms() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    std::fs::write(canonical(&c, "weekly-report").join("SKILL.md"), "我的改动\n").unwrap();

    let outcome = do_remove(&c, &env, "weekly-report", true).unwrap();

    assert!(matches!(outcome, RemoveOutcome::Removed { .. }));
    assert!(!canonical(&c, "weekly-report").exists());
    assert!(c.store.load_state().unwrap().value.installed.is_empty());
}

#[test]
fn a_record_whose_body_is_already_gone_can_be_cleared_without_asking() {
    // 本体没了,"你改过的内容"无从谈起;拦着不让删只会留下一条永远清不掉的死账
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    std::fs::remove_dir_all(canonical(&c, "weekly-report")).unwrap();

    let outcome = do_remove(&c, &env, "weekly-report", false).unwrap();

    assert!(matches!(outcome, RemoveOutcome::Removed { .. }));
    assert!(c.store.load_state().unwrap().value.installed.is_empty());
}

// ============================================================ 边界

#[test]
fn removing_an_unknown_skill_is_a_readable_error() {
    let (c, env) = ctx();
    let err = do_remove(&c, &env, "never-installed", false).unwrap_err();
    assert_eq!(err.code, "FS_NOT_INSTALLED");
    assert!(!err.message.is_empty());
}

#[test]
fn an_unrecognized_lock_version_skips_the_lock_but_still_removes() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    // 上游写坏/未来版本:一个字节都不动(外部契约),但移除本身照常完成
    let lock_path = c.home.join(".agents").join(".skill-lock.json");
    let alien = serde_json::json!({ "version": 4, "skills": { "weekly-report": {} } }).to_string();
    std::fs::write(&lock_path, &alien).unwrap();

    let outcome = do_remove(&c, &env, "weekly-report", false).unwrap();

    let RemoveOutcome::Removed { lock, .. } = outcome else {
        panic!("移除不该被 lock 拦住")
    };
    assert_eq!(lock, "skipped");
    assert_eq!(std::fs::read_to_string(&lock_path).unwrap(), alien, "不认识的版本被改写了");
    assert!(!canonical(&c, "weekly-report").exists());
}

#[test]
fn an_unrecognized_link_mode_is_skipped_not_guessed() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    // 手改 state:把 mode 写成未来版本的值
    let mut state = c.store.load_state().unwrap().value;
    state.installed[0].links[0].mode = "hardlink-farm".into();
    c.store.save_state(&state).unwrap();

    let outcome = do_remove(&c, &env, "weekly-report", false).unwrap();

    let RemoveOutcome::Removed { report, .. } = outcome else { panic!() };
    // 那条关联没被动:猜着删就是拿删除逻辑动错误的目录形态。
    // canonical 已删,链接此时是断链——exists() 会解引用返回 false,须用 symlink_metadata
    assert!(
        std::fs::symlink_metadata(link(&c, "weekly-report")).is_ok(),
        "认不出 mode 的关联被删了"
    );
    assert!(report.unlinks.iter().any(|u| matches!(
        &u.result,
        skillsync_lib::core::installer::UnlinkResult::Skipped { reason } if reason.contains("hardlink-farm")
    )));
}

// ============================================================ 链接健康

#[test]
fn link_health_reports_healthy_after_install() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let installer = Installer::new(&c.registry, &env);
    let state = c.store.load_state().unwrap().value;
    let (recorded, _) = remove::state_links_to_recorded(&state.installed[0].links);

    let health = installer.link_health("weekly-report", &recorded).unwrap();

    assert_eq!(health.len(), 1);
    assert_eq!(health[0].health, LinkHealth::Healthy);
}

#[cfg(unix)]
#[test]
fn link_health_tells_broken_redirected_and_occupied_apart() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let installer = Installer::new(&c.registry, &env);
    let state = c.store.load_state().unwrap().value;
    let (recorded, _) = remove::state_links_to_recorded(&state.installed[0].links);
    let link_path = link(&c, "weekly-report");

    // 被改指到别处
    let elsewhere = c.home.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::remove_file(&link_path).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &link_path).unwrap();
    let health = installer.link_health("weekly-report", &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Redirected);

    // 被实体目录顶掉
    std::fs::remove_file(&link_path).unwrap();
    std::fs::create_dir_all(&link_path).unwrap();
    let health = installer.link_health("weekly-report", &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Occupied);
    std::fs::remove_dir_all(&link_path).unwrap();

    // 关联整个不见了
    let health = installer.link_health("weekly-report", &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Missing);

    // 链接在、本体没了 → 断链
    std::os::unix::fs::symlink(canonical(&c, "weekly-report"), &link_path).unwrap();
    std::fs::remove_dir_all(canonical(&c, "weekly-report")).unwrap();
    let health = installer.link_health("weekly-report", &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Broken);
}

// ============================================================ 修复关联

#[test]
fn repair_rebuilds_a_lost_link_and_reconciles_the_books() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let link_path = link(&c, "weekly-report");
    drop_link(&link_path);

    let installer = Installer::new(&c.registry, &env);
    let report =
        skillsync_lib::core::acquire::repair_links(&installer, &c.store, "weekly-report", false)
            .unwrap();

    assert!(link_path.join("SKILL.md").is_file(), "链接没修回来");
    assert!(!report.links.iter().any(|l| matches!(
        l.result,
        skillsync_lib::core::installer::LinkResult::Failed { .. }
    )));
    // 账与磁盘一致:links 记回来了,agents 仍是 claude-code
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed[0].links.len(), 1);
    assert_eq!(state.installed[0].agents, ["claude-code"]);
}

#[cfg(unix)]
#[test]
fn repair_replaces_a_redirected_link_without_confirmation() {
    // 被改指的是**链接**,不是用户数据本体——直接换回来,不必打扰用户
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let link_path = link(&c, "weekly-report");
    let elsewhere = c.home.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::remove_file(&link_path).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &link_path).unwrap();

    let installer = Installer::new(&c.registry, &env);
    skillsync_lib::core::acquire::repair_links(&installer, &c.store, "weekly-report", false).unwrap();

    // 链接以相对路径写入(便于整个 home 迁移),比对须走 canonicalize 解析
    assert_eq!(
        std::fs::canonicalize(&link_path).unwrap(),
        std::fs::canonicalize(canonical(&c, "weekly-report")).unwrap(),
        "链接没有指回技能本体"
    );
    assert!(elsewhere.exists(), "被指向的无辜目录不该被动");
}

#[test]
fn repair_does_not_touch_an_occupying_directory_without_confirmation() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let link_path = link(&c, "weekly-report");
    let _ = std::fs::remove_file(&link_path);
    let _ = std::fs::remove_dir_all(&link_path);
    std::fs::create_dir_all(&link_path).unwrap();
    std::fs::write(link_path.join("SKILL.md"), "用户自己放的\n").unwrap();
    let theirs = std::fs::read(link_path.join("SKILL.md")).unwrap();

    let installer = Installer::new(&c.registry, &env);
    let report =
        skillsync_lib::core::acquire::repair_links(&installer, &c.store, "weekly-report", false)
            .unwrap();

    // 修复本身完成,但这一条报失败;用户的目录一个字节没动
    assert!(report.links.iter().any(|l| matches!(
        l.result,
        skillsync_lib::core::installer::LinkResult::Failed { .. }
    )));
    assert_eq!(std::fs::read(link_path.join("SKILL.md")).unwrap(), theirs);
}

#[test]
fn repair_replaces_the_occupant_only_when_the_user_confirmed() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let link_path = link(&c, "weekly-report");
    let _ = std::fs::remove_file(&link_path);
    let _ = std::fs::remove_dir_all(&link_path);
    std::fs::create_dir_all(&link_path).unwrap();
    std::fs::write(link_path.join("SKILL.md"), "用户自己放的\n").unwrap();

    let installer = Installer::new(&c.registry, &env);
    let report =
        skillsync_lib::core::acquire::repair_links(&installer, &c.store, "weekly-report", true)
            .unwrap();

    assert!(!report.links.iter().any(|l| matches!(
        l.result,
        skillsync_lib::core::installer::LinkResult::Failed { .. }
    )));
    assert!(
        link_path.join("SKILL.md").is_file(),
        "替换后应能透过链接读到技能"
    );
    // 读到的是技能本体的内容,不是占位目录的
    let body = std::fs::read_to_string(link_path.join("SKILL.md")).unwrap();
    assert!(body.contains("weekly-report"), "读到的不是技能本体: {body}");
}

// ============================================================ 逐条补关联(安装时没建成的重试)

/// trae 的全局技能目录。安装时只关联了 claude-code,trae 因此**不在账上**
/// ——这正是 repair 够不到、需要 link_agents 的那一档。
fn trae_link(c: &Ctx, slug: &str) -> PathBuf {
    c.home.join(".trae").join("skills").join(slug)
}

#[test]
fn retrying_an_unaccounted_agent_links_it_and_merges_the_books() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let before = c.store.load_state().unwrap().value;
    assert_eq!(before.installed[0].agents, vec!["claude-code".to_string()]);
    let claude_link_count = before.installed[0].links.len();

    let installer = Installer::new(&c.registry, &env);
    skillsync_lib::core::acquire::link_agents(
        &installer,
        &c.store,
        "weekly-report",
        &["trae".to_string()],
        false,
    )
    .unwrap();

    assert!(trae_link(&c, "weekly-report").join("SKILL.md").is_file());

    let after = c.store.load_state().unwrap().value;
    // 并集合并:新的进来了,原有的**一条都不能少**——整份覆盖会让卸载时漏解 claude-code 的链接
    assert!(after.installed[0].agents.contains(&"claude-code".to_string()));
    assert!(after.installed[0].agents.contains(&"trae".to_string()));
    assert_eq!(
        after.installed[0].links.len(),
        claude_link_count + 1,
        "原有关联记账被覆盖掉了: {:?}",
        after.installed[0].links
    );
}

#[test]
fn retrying_does_not_touch_an_occupying_directory_without_confirmation() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let occupied = trae_link(&c, "weekly-report");
    std::fs::create_dir_all(&occupied).unwrap();
    let theirs = "别人放在这里的东西\n";
    std::fs::write(occupied.join("SKILL.md"), theirs).unwrap();

    let installer = Installer::new(&c.registry, &env);
    let report = skillsync_lib::core::acquire::link_agents(
        &installer,
        &c.store,
        "weekly-report",
        &["trae".to_string()],
        false,
    )
    .unwrap();

    assert!(report.links.iter().any(|l| matches!(
        l.result,
        skillsync_lib::core::installer::LinkResult::Failed { .. }
    )));
    assert_eq!(
        std::fs::read_to_string(occupied.join("SKILL.md")).unwrap(),
        theirs,
        "未确认就动了用户的目录"
    );
    // 没建成就不该记进账——记了界面会把它画成已生效
    let after = c.store.load_state().unwrap().value;
    assert!(!after.installed[0].agents.contains(&"trae".to_string()));
}

#[test]
fn retrying_replaces_the_occupant_only_when_the_user_confirmed() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let occupied = trae_link(&c, "weekly-report");
    std::fs::create_dir_all(&occupied).unwrap();
    std::fs::write(occupied.join("SKILL.md"), "别人放在这里的东西\n").unwrap();

    let installer = Installer::new(&c.registry, &env);
    skillsync_lib::core::acquire::link_agents(
        &installer,
        &c.store,
        "weekly-report",
        &["trae".to_string()],
        true,
    )
    .unwrap();

    let body = std::fs::read_to_string(occupied.join("SKILL.md")).unwrap();
    assert!(body.contains("weekly-report"), "读到的不是技能本体: {body}");
    let after = c.store.load_state().unwrap().value;
    assert!(after.installed[0].agents.contains(&"trae".to_string()));
}

#[test]
fn retrying_refuses_for_a_skill_that_is_not_installed() {
    let (c, env) = ctx();
    let installer = Installer::new(&c.registry, &env);

    let err = skillsync_lib::core::acquire::link_agents(
        &installer,
        &c.store,
        "never-installed",
        &["trae".to_string()],
        false,
    )
    .unwrap_err();

    assert_eq!(err.code, "FS_NOT_INSTALLED");
}

#[test]
fn repair_refuses_when_the_skill_body_is_gone() {
    // 本体没了,修复无从谈起——这要走"重新获取",不能默默建一个指向空处的链接
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    std::fs::remove_dir_all(canonical(&c, "weekly-report")).unwrap();

    let installer = Installer::new(&c.registry, &env);
    let err =
        skillsync_lib::core::acquire::repair_links(&installer, &c.store, "weekly-report", false)
            .unwrap_err();
    assert!(err.code.starts_with("FS_"), "{}", err.code);
}

#[test]
fn link_health_treats_a_degraded_copy_as_healthy() {
    // 降级复制的"链接"就是一个实体目录——它不是被占位,是它该有的样子
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let link_path = link(&c, "weekly-report");
    // 把链接换成一份实体副本,并把记账改成 copy
    let _ = std::fs::remove_file(&link_path);
    let _ = std::fs::remove_dir_all(&link_path);
    std::fs::create_dir_all(&link_path).unwrap();
    std::fs::write(link_path.join("SKILL.md"), "副本\n").unwrap();
    let mut state = c.store.load_state().unwrap().value;
    state.installed[0].links[0].mode = "copy".into();
    c.store.save_state(&state).unwrap();

    let installer = Installer::new(&c.registry, &env);
    let state = c.store.load_state().unwrap().value;
    let (recorded, _) = remove::state_links_to_recorded(&state.installed[0].links);
    let health = installer.link_health("weekly-report", &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Healthy);
}
