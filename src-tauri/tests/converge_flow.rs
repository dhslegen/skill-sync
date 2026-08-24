//! `converge` 原语的集成测试(v6 二期任务 3):本体定位、写盘前收敛、
//! 版本拍板、工具启用(勾选)。
//!
//! 姿态与其余编排层测试一致:能断言"磁盘上的字节有没有变",就不要只断言
//! 函数返回了哪个枚举——尤其是"内容不同必须停下"这一档,正面断言磁盘零写入。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::converge::{self, Converged, KeepReport, Located, SetAgentsOutcome};
use skillsync_lib::core::fsops::{self, OnOccupied};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::state::{self, State};

const NOW: &str = "2026-08-24T12:00:00.000Z";

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
    registry: AgentRegistry,
    store: state::Store,
    /// **绝不用默认的 `SYSTEM_TRASH`**:凡是走 `converge`/`keep_version` 覆盖或
    /// 收编已有实体目录的测试,都会真的调用 trasher——不注入的话会把测试产物
    /// 丢进这台机器真实的系统废纸篓。
    sandbox: fsops::SandboxTrash,
}

impl Ctx {
    /// installer 已挂 `sandbox` 当废纸篓。`Installer<'a>` 同时借用 `self` 与
    /// 外部传入的 `env`,不能作为 `Ctx` 自身的字段(会是自引用结构),故按需现造。
    fn installer<'a>(&'a self, env: &'a TmpEnv) -> Installer<'a> {
        Installer::new(&self.registry, env).with_trasher(&self.sandbox)
    }
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = state::Store::new(home.join(".skillsync"));
    let sandbox = fsops::SandboxTrash::new(home.join(".test-trash"));
    (
        Ctx {
            _tmp: tmp,
            registry: AgentRegistry::builtin(),
            store,
            sandbox,
        },
        env,
    )
}

/// 造一个含 SKILL.md 的实体技能目录,`v` 写进正文用来区分版本/内容。
fn skill_dir(home: &Path, rel: &str, v: &str) -> PathBuf {
    let dir = home.join(rel);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), skill_md(v)).unwrap();
    dir
}

fn skill_md(v: &str) -> String {
    format!("---\nname: s\ndescription: d\n---\n{v}\n")
}

/// 建一条指向 `target` 的链接。走 `fsops::link_dir`(跨平台:unix 走 symlink,
/// windows 走 junction),不直接调 `std::os::unix::fs::symlink`——这样测试不必
/// `#[cfg(unix)]` 就能在 CI 的 Windows job 上跑。
fn link(target: &Path, at: &Path) {
    fsops::link_dir(target, at, fsops::default_link_chain(), OnOccupied::Fail).unwrap();
}

fn state_with_body(name: &str, body: &Path) -> State {
    State {
        schema_version: state::SCHEMA_VERSION,
        installed: vec![state::InstalledSkill {
            name: name.to_string(),
            source: state::SkillSource {
                registry_id: "company".into(),
                owner: "skills".into(),
                repo: "skills".into(),
                path: format!("skills/{name}"),
                git_ref: "main".into(),
            },
            commit_sha: "sha1".into(),
            content_hash: fsops::dir_content_hash(body).unwrap(),
            origin: None,
            body: Some(body.to_string_lossy().into_owned()),
            agents: vec!["claude-code".into()],
            links: Vec::new(),
            installed_at: NOW.into(),
            updated_at: NOW.into(),
        }],
        shared: Vec::new(),
    }
}

// ============================================================ converge

#[test]
fn converge_links_when_target_is_absent_or_dangling() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let target = env.home.join(".trae/skills/s");
    assert!(matches!(
        converge::converge(&inst, &target, &body).unwrap(),
        Converged::Linked { .. }
    ));
    assert_eq!(fsops::read_link_target(&target), Some(fsops::normalize(&body)));

    // 悬空:目标指向的东西没了(还改指向了另一个本体)。
    std::fs::remove_dir_all(&body).unwrap();
    let body2 = skill_dir(&env.home, ".agents/skills/s", "v1");
    assert!(matches!(
        converge::converge(&inst, &target, &body2).unwrap(),
        Converged::Linked { .. }
    ));
    assert_eq!(fsops::read_link_target(&target), Some(fsops::normalize(&body2)));
}

#[test]
fn converge_silently_replaces_an_identical_real_dir_with_a_link_via_trash() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let target = skill_dir(&env.home, ".agents/skills/s", "v1"); // 同名同内容的实体

    assert!(matches!(
        converge::converge(&inst, &target, &body).unwrap(),
        Converged::Linked { .. }
    ));
    assert_eq!(c.sandbox.trashed(), vec![target.clone()], "副本进废纸篓,不是删除");
    assert_eq!(fsops::read_link_target(&target), Some(fsops::normalize(&body)));
}

#[test]
fn converge_stops_without_touching_disk_when_contents_differ() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let target = skill_dir(&env.home, ".agents/skills/s", "v2");
    let before = fsops::dir_content_hash(&target).unwrap();

    let r = converge::converge(&inst, &target, &body).unwrap();

    assert_eq!(
        r,
        Converged::Differs {
            existing: target.to_string_lossy().into_owned()
        }
    );
    assert_eq!(fsops::dir_content_hash(&target).unwrap(), before, "磁盘零写入");
    assert!(c.sandbox.trashed().is_empty());
}

#[test]
fn ds_store_does_not_break_silent_convergence() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let target = skill_dir(&env.home, ".agents/skills/s", "v1");
    std::fs::write(target.join(".DS_Store"), b"\x00").unwrap();

    assert!(matches!(
        converge::converge(&inst, &target, &body).unwrap(),
        Converged::Linked { .. }
    ));
}

// ============================================================ locate / scan_all

#[test]
fn locate_prefers_the_recorded_body_then_non_canonical_then_registry_order() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let claude = skill_dir(&env.home, ".claude/skills/s", "v1");
    let trae = skill_dir(&env.home, ".trae/skills/s", "v1");
    let canon = skill_dir(&env.home, ".agents/skills/s", "v1");

    // 无账 + 三处同内容:非 canonical 优先,claude-code 目录字典序排在 trae 前。
    let l = converge::locate(&inst, &c.registry, &env, &State::default(), "s").unwrap();
    assert_eq!(
        l,
        Located::Body {
            body: claude.clone(),
            others: vec![canon.clone(), trae.clone()],
        }
    );

    // 有账:账上说了算,哪怕账上是 canonical。
    let state = state_with_body("s", &canon);
    let l = converge::locate(&inst, &c.registry, &env, &state, "s").unwrap();
    assert!(matches!(l, Located::Body { body, .. } if body == canon));

    // 有账 + 一份内容不同的杂散副本:仍是 Body(账上),副本不进 others、也不变成 Differs。
    std::fs::write(trae.join("SKILL.md"), skill_md("v9")).unwrap();
    let l = converge::locate(&inst, &c.registry, &env, &state, "s").unwrap();
    assert_eq!(
        l,
        Located::Body {
            body: canon.clone(),
            others: vec![claude.clone()],
        }
    );
}

#[test]
fn locate_reports_versions_when_contents_differ_and_never_writes() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let a = skill_dir(&env.home, ".claude/skills/s", "v1");
    let b = skill_dir(&env.home, ".agents/skills/s", "v2");

    let l = converge::locate(&inst, &c.registry, &env, &State::default(), "s").unwrap();

    let Located::Differs(vs) = l else { panic!("expected Differs") };
    assert_eq!(vs.len(), 2);
    assert!(vs.iter().all(|v| v.files == 1 && !v.modified_at.is_empty()));
    assert!(a.is_dir() && b.is_dir() && c.sandbox.trashed().is_empty(), "扫描绝不写盘");
}

#[test]
fn locate_ignores_links_and_dirs_without_skill_md() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".agents/skills/s", "v1");
    link(&body, &env.home.join(".claude/skills/s"));
    std::fs::create_dir_all(env.home.join(".trae/skills/s")).unwrap(); // 没有 SKILL.md

    let l = converge::locate(&inst, &c.registry, &env, &State::default(), "s").unwrap();

    assert_eq!(
        l,
        Located::Body {
            body,
            others: Vec::new(),
        }
    );
}

// ============================================================ keep_version / set_agents

#[test]
fn keep_version_keeps_the_chosen_dir_in_place_and_links_the_rest() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let a = skill_dir(&env.home, ".claude/skills/s", "v1");
    let b = skill_dir(&env.home, ".agents/skills/s", "v2");

    let r: KeepReport = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &a, NOW).unwrap();

    assert_eq!(r.body, a.to_string_lossy());
    assert_eq!(c.sandbox.trashed(), vec![b.clone()]);
    assert_eq!(
        fsops::read_link_target(&b),
        Some(fsops::normalize(&a)),
        "canonical 变成指向 body 的链接"
    );
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    assert_eq!(rec.body.as_deref(), Some(a.to_str().unwrap()));
    assert_eq!(rec.origin.as_deref(), Some(state::ORIGIN_ADOPTED));
    assert_eq!(
        rec.content_hash,
        fsops::dir_content_hash(&a).unwrap(),
        "基线 = 拍板那一刻的 body"
    );
}

#[test]
fn set_agents_adds_links_removes_links_and_never_removes_the_body_tool() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");

    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();
    let SetAgentsOutcome::Done { results, .. } = out else {
        panic!("expected Done")
    };
    assert!(matches!(&results[0], (a, Converged::Linked { .. }) if a == "trae"));
    assert_eq!(
        fsops::read_link_target(&env.home.join(".agents/skills/s")),
        Some(fsops::normalize(&body)),
        "首次勾就把 canonical 链接补上"
    );

    // 取消 trae:只摘链接。
    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &[], NOW).unwrap();
    let SetAgentsOutcome::Done { unlinked, .. } = out else {
        panic!("expected Done")
    };
    assert_eq!(unlinked, vec!["trae".to_string()]);
    assert!(std::fs::symlink_metadata(env.home.join(".trae/skills/s")).is_err());
    assert!(body.join("SKILL.md").is_file(), "本体不动");

    // 试图取消本体所在的 claude-code:静默保留,账上 agents 仍含 claude-code。
    let st = c.store.load_state().unwrap().value;
    assert!(st
        .installed
        .iter()
        .find(|s| s.name == "s")
        .unwrap()
        .agents
        .contains(&"claude-code".to_string()));
}

#[test]
fn set_agents_returns_version_choice_instead_of_guessing() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    skill_dir(&env.home, ".claude/skills/s", "v1");
    skill_dir(&env.home, ".agents/skills/s", "v2");

    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();

    assert!(matches!(out, SetAgentsOutcome::NeedsVersionChoice { .. }));
    assert!(c.sandbox.trashed().is_empty());
}

/// 协调者裁定(补测):`set_agents` 必须对 `wanted` 里**每一个**目标都跑一次
/// `converge`,不能只跑本次新增的差集——否则一个**已经在账上**的工具被人改指
/// 之后,用户再怎么重新点同一个勾都修不好它(旧的 `repair_links` 这条自愈路径
/// 已经删除,断链自愈只能靠这里落地)。
#[test]
fn set_agents_self_heals_a_link_that_was_repointed_elsewhere() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");

    converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();
    let trae_link = env.home.join(".trae/skills/s");
    assert_eq!(fsops::read_link_target(&trae_link), Some(fsops::normalize(&body)));

    // 有人把 trae 的关联改指到了别处(比如另一个技能的目录)——trae 一直都在账上,
    // 不属于"本次新增"的差集。
    let elsewhere = skill_dir(&env.home, ".elsewhere/whatever", "v9");
    fsops::unlink_dir(&trae_link).unwrap();
    link(&elsewhere, &trae_link);
    assert_eq!(fsops::read_link_target(&trae_link), Some(fsops::normalize(&elsewhere)));

    // 再次勾选同样的 trae:应当自愈,重新指回本体,而不是因为它"已经在账上"就被跳过。
    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();
    let SetAgentsOutcome::Done { results, .. } = out else {
        panic!("expected Done")
    };
    assert!(matches!(&results[0], (a, Converged::Linked { .. }) if a == "trae"));
    assert_eq!(
        fsops::read_link_target(&trae_link),
        Some(fsops::normalize(&body)),
        "断链应自愈回指本体"
    );
}

/// 同上一条的另一种形状:位置被换成了一个内容不同的实体目录(不再是我们建的
/// 链接)。这一档不敢猜,如实报告 `Differs`,磁盘零写入——"全量收敛"不等于
/// "全量覆盖"。
#[test]
fn set_agents_reports_differs_without_touching_disk_when_a_wanted_position_holds_different_content() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    skill_dir(&env.home, ".claude/skills/s", "v1");

    converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();
    let trae_link = env.home.join(".trae/skills/s");
    fsops::unlink_dir(&trae_link).unwrap();
    std::fs::create_dir_all(&trae_link).unwrap();
    std::fs::write(trae_link.join("SKILL.md"), skill_md("v9")).unwrap();
    let before = fsops::dir_content_hash(&trae_link).unwrap();

    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();

    let SetAgentsOutcome::Done { results, .. } = out else {
        panic!("expected Done")
    };
    let (agent, outcome) = &results[0];
    assert_eq!(agent, "trae");
    assert_eq!(
        outcome,
        &Converged::Differs {
            existing: trae_link.to_string_lossy().into_owned()
        }
    );
    assert_eq!(fsops::dir_content_hash(&trae_link).unwrap(), before, "磁盘零写入");
    assert!(c.sandbox.trashed().is_empty());
}
