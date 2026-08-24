//! 移除流程编排测试。与 acquire_flow 同一条断言纪律:
//! 破坏性守卫的断言口径是**磁盘上的字节有没有变**,不是函数返回了哪个枚举。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::installer::{Installer, LinkHealth, SkillPayload};
use skillsync_lib::core::remove::{self, RemoveOutcome};
use skillsync_lib::core::state::{InstalledSkill, LinkRecord, SharedSkill, SkillSource, Store};

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
    /// 移除会把本体经 `Installer::uninstall` 送进废纸篓——不注入的话,
    /// 这个文件的每一条"移除"用例都会把测试产物丢进真实的系统废纸篓。
    trash: fsops::SandboxTrash,
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = Store::new(home.join(".skillsync"));
    let trash = fsops::SandboxTrash::new(home.join(".test-trash"));
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
            trash,
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
    let installer = Installer::new(&c.registry, env).with_trasher(&c.trash);
    let home = installer.home(slug, None).unwrap();
    let report = installer
        .install(&home, &payload(slug), &["claude-code".to_string()])
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
        body: None,
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

fn do_remove(c: &Ctx, env: &TmpEnv, slug: &str) -> Result<RemoveOutcome, skillsync_lib::error::AppError> {
    let installer = Installer::new(&c.registry, env).with_trasher(&c.trash);
    remove::remove(&installer, env, &c.store, slug)
}

fn canonical(c: &Ctx, slug: &str) -> PathBuf {
    c.home.join(".agents").join("skills").join(slug)
}

fn link(c: &Ctx, slug: &str) -> PathBuf {
    c.home.join(".claude").join("skills").join(slug)
}

// ============================================================ 正常移除

#[test]
fn removing_cleans_body_links_state_and_lock() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    assert!(link(&c, "weekly-report").exists(), "前置:链接已建立");

    let outcome = do_remove(&c, &env, "weekly-report").unwrap();

    let RemoveOutcome::Removed { report, lock } = outcome;
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

    do_remove(&c, &env, "weekly-report").unwrap();

    assert!(canonical(&c, "meeting-notes").join("SKILL.md").is_file());
    assert!(link(&c, "meeting-notes").exists());
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed.len(), 1);
    assert_eq!(state.installed[0].name, "meeting-notes");
}

// ============================================================ 改过的技能

/// v6 二期:改过本体**不再二次确认**——本体进的是废纸篓,用户随时能捞回来。
/// 断言口径因此从"停下来问"换成"东西确实在废纸篓里可找回"。
#[test]
fn a_modified_skill_is_removed_in_one_step_and_stays_recoverable() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let dir = canonical(&c, "weekly-report");
    std::fs::write(dir.join("SKILL.md"), "我的改动\n").unwrap();

    let outcome = do_remove(&c, &env, "weekly-report").unwrap();

    assert!(matches!(outcome, RemoveOutcome::Removed { .. }), "改过的技能也一步移除");
    assert!(!dir.exists(), "本体还在原地");
    assert_eq!(c.trash.trashed(), vec![dir.clone()], "本体必须经废纸篓,不能直接删");
    assert!(
        c.store.load_state().unwrap().value.installed.is_empty(),
        "账没清干净"
    );
    // 关键:用户的改动仍能从废纸篓里捞回来
    let recovered = c.trash.into.join("weekly-report").join("SKILL.md");
    assert_eq!(
        std::fs::read_to_string(&recovered).unwrap(),
        "我的改动\n",
        "改动没能在废纸篓里找回: {}",
        recovered.display()
    );
}

/// 🔴 纯本地技能(勾选工具时顺手建的 `adopted` 账,来源坐标全空)**照样能移除**
/// (修复轮 1,R16 —— 撤回了上一版加的 `has_source()` 闸)。
///
/// 拦住它就是把已经做过的事做成死路:用户自己建的、勾过工具的技能在 app 里删不掉。
/// 而这个动作本来就是可逆的(本体进废纸篓)。另外 v0.5.0 的 `acquire::claim` 在
/// 绑不上来源时写的就是全空来源账,拦住会**误伤存量用户**。
#[test]
fn a_skill_with_no_library_source_can_still_be_removed() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let dir = canonical(&c, "weekly-report");
    let mut state = c.store.load_state().unwrap().value;
    state.installed[0].source = SkillSource {
        registry_id: String::new(),
        owner: String::new(),
        repo: String::new(),
        path: String::new(),
        git_ref: String::new(),
    };
    state.installed[0].origin = Some(skillsync_lib::core::state::ORIGIN_ADOPTED.into());
    c.store.save_state(&state).unwrap();

    let RemoveOutcome::Removed { report, .. } = do_remove(&c, &env, "weekly-report").unwrap();

    assert!(report.canonical_removed, "本体没被送走");
    assert_eq!(c.trash.trashed(), vec![dir.clone()], "本体必须经废纸篓,不能直接删");
    assert!(!dir.exists(), "本体还在原地");
    assert!(
        std::fs::symlink_metadata(link(&c, "weekly-report")).is_err(),
        "关联没摘掉——这正是拦住它会让用户没辙的那一条"
    );
    assert!(
        c.store.load_state().unwrap().value.installed.is_empty(),
        "账没清干净"
    );
}

#[test]
fn a_record_whose_body_is_already_gone_can_be_cleared_without_asking() {
    // 本体没了,"你改过的内容"无从谈起;拦着不让删只会留下一条永远清不掉的死账
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    std::fs::remove_dir_all(canonical(&c, "weekly-report")).unwrap();

    let outcome = do_remove(&c, &env, "weekly-report").unwrap();

    assert!(matches!(outcome, RemoveOutcome::Removed { .. }));
    assert!(c.store.load_state().unwrap().value.installed.is_empty());
}

// ============================================================ 本体住在工具目录里(v6 二期任务 4)

/// 本体住在 `~/.claude/skills/` 时,移除要:摘掉每个工具的关联 + 摘掉 canonical
/// 那条链接 + 把**本体**送进废纸篓(不是 canonical 那条链接所指的位置)。
#[test]
fn remove_trashes_the_body_unlinks_every_tool_and_the_canonical_link() {
    let (c, env) = ctx();
    let installer = Installer::new(&c.registry, &env).with_trasher(&c.trash);
    let body = c.home.join(".claude").join("skills").join("weekly-report");
    let home = installer.home("weekly-report", Some(&body)).unwrap();
    let report = installer
        .install(&home, &payload("weekly-report"), &["claude-code".to_string(), "trae".to_string()])
        .unwrap();

    let mut state = c.store.load_state().map(|l| l.value).unwrap_or_default();
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "aaa1111".into(),
        },
        commit_sha: "aaa1111".into(),
        content_hash: fsops::dir_content_hash(&body).unwrap(),
        origin: None,
        body: Some(body.to_string_lossy().into_owned()),
        agents: vec!["claude-code".into(), "trae".into()],
        // 🔴 **刻意把 canonical 那条链接从账上剔掉**:`uninstall` 有两条路会摘它
        // ——按账走的那条,和"本体不在 canonical 时无条件摘一次"那条。账上留着
        // 的话两条都会命中,注入验证时把后者改坏测试照样绿(同一条规则查了两遍,
        // 空转模式 ①)。剔掉之后,canonical 那条链接只可能由后者摘掉。
        // 这也是真实会发生的形状:npx skills 或用户自己在 canonical 建的那条链接
        // 从来不在我们的账上。
        links: report
            .links
            .iter()
            .filter(|l| Path::new(&l.dir) != c.home.join(".agents").join("skills"))
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

    // 分享基线记的是**本体**所在(`seed_shared_baseline` 的口径)。移除要按同一把
    // 尺子把它清掉——按 canonical 比的话这条孤儿永远清不掉。
    let mut state = c.store.load_state().unwrap().value;
    state.shared.push(SharedSkill {
        name: "weekly-report".into(),
        local_path: body.to_string_lossy().into_owned(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "aaa1111".into(),
        content_hash: fsops::dir_content_hash(&body).unwrap(),
    });
    c.store.save_state(&state).unwrap();

    // 前置:canonical 那条链接确实建起来了,而且确实不在账上
    assert!(
        std::fs::symlink_metadata(c.home.join(".agents").join("skills").join("weekly-report")).is_ok(),
        "前置不成立:canonical 链接没建起来"
    );

    // 改过也不再二次确认——本体进的是废纸篓,捞得回来
    std::fs::write(body.join("notes.md"), "edited").unwrap();

    let RemoveOutcome::Removed { report, .. } = do_remove(&c, &env, "weekly-report").unwrap();

    assert!(report.canonical_removed, "本体没被送走");
    assert_eq!(c.trash.trashed(), vec![body.clone()], "进废纸篓的必须是**本体**");
    assert!(
        std::fs::symlink_metadata(c.home.join(".agents").join("skills").join("weekly-report")).is_err(),
        "canonical 那条链接没摘掉"
    );
    assert!(
        std::fs::symlink_metadata(c.home.join(".trae").join("skills").join("weekly-report")).is_err(),
        "trae 那条链接没摘掉"
    );
    assert!(
        c.trash.into.join("weekly-report").join("notes.md").is_file(),
        "改动应当能从废纸篓里找回"
    );
    assert!(
        c.store.load_state().unwrap().value.shared.is_empty(),
        "指向本体的分享基线没被清掉,会留下一条谁也清不掉的孤儿"
    );
}

// ============================================================ 边界

#[test]
fn removing_an_unknown_skill_is_a_readable_error() {
    let (c, env) = ctx();
    let err = do_remove(&c, &env, "never-installed").unwrap_err();
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

    let outcome = do_remove(&c, &env, "weekly-report").unwrap();

    let RemoveOutcome::Removed { lock, .. } = outcome;
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

    let outcome = do_remove(&c, &env, "weekly-report").unwrap();

    let RemoveOutcome::Removed { report, .. } = outcome;
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
    let installer = Installer::new(&c.registry, &env).with_trasher(&c.trash);
    let home = installer.home("weekly-report", None).unwrap();
    let state = c.store.load_state().unwrap().value;
    let (recorded, _) = remove::state_links_to_recorded(&state.installed[0].links);

    let health = installer.link_health(&home, &recorded).unwrap();

    assert_eq!(health.len(), 1);
    assert_eq!(health[0].health, LinkHealth::Healthy);
}

#[cfg(unix)]
#[test]
fn link_health_tells_broken_redirected_and_occupied_apart() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    let installer = Installer::new(&c.registry, &env).with_trasher(&c.trash);
    let home = installer.home("weekly-report", None).unwrap();
    let state = c.store.load_state().unwrap().value;
    let (recorded, _) = remove::state_links_to_recorded(&state.installed[0].links);
    let link_path = link(&c, "weekly-report");

    // 被改指到别处
    let elsewhere = c.home.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::remove_file(&link_path).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &link_path).unwrap();
    let health = installer.link_health(&home, &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Redirected);

    // 被实体目录顶掉
    std::fs::remove_file(&link_path).unwrap();
    std::fs::create_dir_all(&link_path).unwrap();
    let health = installer.link_health(&home, &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Occupied);
    std::fs::remove_dir_all(&link_path).unwrap();

    // 关联整个不见了
    let health = installer.link_health(&home, &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Missing);

    // 链接在、本体没了 → 断链
    std::os::unix::fs::symlink(canonical(&c, "weekly-report"), &link_path).unwrap();
    std::fs::remove_dir_all(canonical(&c, "weekly-report")).unwrap();
    let health = installer.link_health(&home, &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Broken);
}

// ============================================================ 修复关联(v6 二期已撤销)
//
// `repair_links` / `link_agents` 连同「修复关联」这个概念一起删除了(任务 4),
// 原先挂在这里的九条用例随之作废。它们守的行为并没有消失,而是搬到了
// `converge::set_agents`——`tests/converge_flow.rs` 逐条覆盖:断链自愈、
// 被改指的链接换回来、占位实体目录同内容进废纸篓换链接/不同内容一个字节不动、
// 记账并集合并、本体缺失时拒绝建链。**不要在这里重建一套平行的断言。**

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

    let installer = Installer::new(&c.registry, &env).with_trasher(&c.trash);
    let home = installer.home("weekly-report", None).unwrap();
    let state = c.store.load_state().unwrap().value;
    let (recorded, _) = remove::state_links_to_recorded(&state.installed[0].links);
    let health = installer.link_health(&home, &recorded).unwrap();
    assert_eq!(health[0].health, LinkHealth::Healthy);
}

/// 移除必须把 `state.shared` 里指着这个目录的记账一并清掉(v6 任务 3 修复轮 1)。
///
/// 留着它就是一条谁也清不掉的孤儿:`create::create_skill` 曾经拿它拒绝同名新建,
/// 于是「取回我分享的 → 移除 → 重新起草一个同名的」撞进死胡同,而报错说的
/// 「已经被一个分享过的技能占用了」在本体已经删掉之后是假话。
///
/// v6 任务 3 给 `state.shared` 加了一个新的产生源(取回自己分享的技能时建内容基线),
/// 把这条路径的命中率从"用户主动分享过"抬到了"取回过自己的技能"——后者是主线动作。
///
/// 断言的是**记账真的没了**,不是"移除成功"——后者分不出是哪一条规则在起作用。
///
/// ⚠️ 这里的 `local_path` 用 `join(".agents/skills")` 拼,在 Windows 上是
/// `.agents/skills\x`,而 core 走分段 join 得到 `.agents\skills\x`——同一个目录、
/// 字符串却不等(2026-08-04 CI 真红过,当时栽在 create.rs 上)。清理按 `Path` 比,
/// 这条用例在 Windows runner 上就是它的护栏。
#[test]
fn removing_also_clears_the_shared_baseline_it_leaves_behind() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    install_one(&c, &env, "meeting-notes");

    let mut state = c.store.load_state().unwrap().value;
    for slug in ["weekly-report", "meeting-notes"] {
        state.shared.push(SharedSkill {
            // 远端目录名与本地目录名**刻意不同**(中文名技能就是这样分享的):
            // 按 `name` 匹配的实现会一条都清不掉,这条用例就是它的照妖镜。
            name: format!("remote-{slug}"),
            local_path: canonical(&c, slug).to_string_lossy().into_owned(),
            origin: "local".into(),
            target: SkillSource {
                registry_id: "company".into(),
                owner: "skills".into(),
                repo: "skills".into(),
                path: format!("skills/remote-{slug}"),
                git_ref: "main".into(),
            },
            last_pushed_sha: "aaa1111".into(),
            content_hash: "hash".into(),
        });
    }
    c.store.save_state(&state).unwrap();

    do_remove(&c, &env, "weekly-report").unwrap();

    let after = c.store.load_state().unwrap().value;
    assert!(
        !after.shared.iter().any(|s| Path::new(&s.local_path) == canonical(&c, "weekly-report")),
        "移除之后不该留下指着已删目录的分享记账:{:?}",
        after.shared.iter().map(|s| &s.local_path).collect::<Vec<_>>()
    );
    // 只清自己那条:别的技能的记账不许被误伤
    assert_eq!(after.shared.len(), 1);
    assert_eq!(after.shared[0].local_path, canonical(&c, "meeting-notes").to_string_lossy());
}

// ============================================================ 查账键(I-1,修复轮 1)

/// `remove` 查账用的是**清洗后**的目录名,不是调用方手上的 `dir_slug`。
///
/// 今天界面传过来的一直是记账名(「我的技能」那一行就是 `state.installed[].name`),
/// 所以这条错位在生产上还碰不到;但同一把钥匙在 `locate`/`home_of`/批量更新那三处
/// **已经真的错过**(见 acquire_flow / converge_flow 的 mixed_case 用例)。
/// 四处用同一个 `converge::record_key`,这条把 remove 那一处钉住。
#[test]
fn removing_by_a_mixed_case_dir_slug_still_finds_the_record() {
    let (c, env) = ctx();
    install_one(&c, &env, "weekly-report");
    assert_eq!(
        c.store.load_state().unwrap().value.installed[0].name,
        "weekly-report",
        "前置:记账键是清洗后的名字"
    );

    // 技能库里的目录名带大写,调用方原样传进来
    let RemoveOutcome::Removed { report, .. } = do_remove(&c, &env, "Weekly-Report").unwrap();

    assert!(report.canonical_removed);
    assert!(!canonical(&c, "weekly-report").exists(), "本体还在");
    assert!(
        std::fs::symlink_metadata(link(&c, "weekly-report")).is_err(),
        "关联还在"
    );
    assert!(c.store.load_state().unwrap().value.installed.is_empty(), "账没清");
}

// ============================================================ IPC 序列化形状

/// M-3(修复轮 1):`RemoveOutcome` 的字段今天是 `report`/`lock` 两个单词,不会变形
/// ——但**将来加一个带下划线的字段时会静默复发**任务 4 抓到的那个缺陷
/// (`rename_all` 挂在枚举上只改 variant 名,不改 struct variant 的字段名)。
/// 补一条正面断言把 `rename_all_fields` 钉住,别等下一个人再踩一遍。
#[test]
fn remove_outcome_serializes_with_camel_case_field_names() {
    let v = serde_json::to_value(RemoveOutcome::Removed {
        report: skillsync_lib::core::installer::UninstallReport {
            dir_name: "weekly-report".into(),
            unlinks: Vec::new(),
            canonical_removed: true,
        },
        lock: "written".into(),
    })
    .unwrap();

    assert_eq!(v["outcome"], "removed", "{v}");
    assert_eq!(v["lock"], "written", "{v}");
    // 嵌套的 UninstallReport 是 struct,`rename_all` 在 struct 上确实改字段名
    assert_eq!(v["report"]["dirName"], "weekly-report", "{v}");
    assert_eq!(v["report"]["canonicalRemoved"], true, "{v}");
    // 键的完整集合:多一个少一个都要有人知道(避免"只断言存在"那种空转)
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, vec!["lock", "outcome", "report"], "{v}");
}
