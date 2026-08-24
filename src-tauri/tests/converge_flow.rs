//! `converge` 原语的集成测试(v6 二期任务 3):本体定位、写盘前收敛、
//! 版本拍板、工具启用(勾选)。
//!
//! 姿态与其余编排层测试一致:能断言"磁盘上的字节有没有变",就不要只断言
//! 函数返回了哪个枚举——尤其是"内容不同必须停下"这一档,正面断言磁盘零写入。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::converge::{self, Converged, KeepReport, Located, SetAgentsOutcome};
use skillsync_lib::core::fsops::{self, LinkKind, OnOccupied};
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
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    assert!(rec.agents.contains(&"claude-code".to_string()));
    // I2 的反向(审查修复轮 2):trae 被取消之后必须真的从账上 agents 里消失,
    // 不能只删磁盘链接、账上还留着——`rec.agents = wanted` 是覆盖写,这条正面
    // 断言把它钉住(此前只测了"没被覆盖掉的那一半",覆盖语义本身没人守)。
    assert!(
        !rec.agents.contains(&"trae".to_string()),
        "trae 取消之后必须从账上 agents 消失: {:?}",
        rec.agents
    );
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

// ============================================================ 审查修复轮 1

/// C1:`keep` 经 IPC 由前端传入,是不可信输入。必须是这次候选之一,否则在动
/// 任何磁盘之前拒绝——覆盖"存在但无关的目录"与"根本不存在的路径"两种形状。
#[test]
fn keep_version_rejects_a_path_that_is_not_a_candidate() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let a = skill_dir(&env.home, ".claude/skills/s", "v1");
    let b = skill_dir(&env.home, ".agents/skills/s", "v2");
    // ⚠️ 叶子名必须是 "s"(与 dir_slug 同名)——审查修复轮 2:此前叶子名是
    // "other",会被 `installer::home` 既有的叶子名守卫(`FS_BAD_BODY`)先兜住,
    // 注入去掉 C1 判据后依旧报错,测试"看起来"钉住了,实际没测到 C1 本身要挡的
    // 那个洞。真正危险的形状是**同叶子名**的无关目录——那种形状下没有旁的守卫
    // 能兜底,零报错、两处本体全进废纸篓、账上写成无关路径。
    let unrelated = skill_dir(&env.home, ".elsewhere/s", "v9");
    let missing = env.home.join(".nowhere/skills/s");

    let before_a = fsops::dir_content_hash(&a).unwrap();
    let before_b = fsops::dir_content_hash(&b).unwrap();

    let err = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &unrelated, NOW).unwrap_err();
    assert_eq!(err.code, "FS_BAD_VERSION_CHOICE");
    let err2 = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &missing, NOW).unwrap_err();
    assert_eq!(err2.code, "FS_BAD_VERSION_CHOICE");

    // `is_dir()` 单独不是有效断言:被注入的那种破坏恰恰是把 a/b 换成指向
    // `unrelated` 的链接,而 `unrelated` 本身是个真实目录,`is_dir()` 会跟着
    // 链接走、照样返回 true。真正拦得住的是"没被换成链接"+"内容没变"。
    assert!(
        a.is_dir() && fsops::read_link_target(&a).is_none(),
        "a 应当仍是原地的实体目录,没被换成链接"
    );
    assert!(
        b.is_dir() && fsops::read_link_target(&b).is_none(),
        "b 应当仍是原地的实体目录,没被换成链接"
    );
    assert_eq!(fsops::dir_content_hash(&a).unwrap(), before_a);
    assert_eq!(fsops::dir_content_hash(&b).unwrap(), before_b);
    assert!(c.sandbox.trashed().is_empty(), "磁盘零写入");
}

/// C2:`locate` 有账时恒返回 `Body{账上}`,但账上记的本体完全可能已经不在磁盘上。
/// `set_agents` 必须在建任何链接之前判掉这一档,不能对着不存在的目标建出悬空链接
/// 还谎称"已启用"。
#[test]
fn set_agents_errors_instead_of_dangling_when_the_recorded_body_is_gone() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let state = state_with_body("s", &body);
    c.store.save_state(&state).unwrap();
    std::fs::remove_dir_all(&body).unwrap();

    let err = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap_err();

    assert_eq!(err.code, "FS_MISSING_SKILL");
    let trae_link = env.home.join(".trae/skills/s");
    assert!(
        std::fs::symlink_metadata(&trae_link).is_err(),
        "不该在本体缺失的情况下建出悬空链接"
    );
}

/// I1:两个候选都不在 canonical 时(打破任务书 fixture 里"canonical 恰好是候选
/// 之一"的巧合),拍板后 canonical 仍必须被补一条指向 body 的链接——否则技能会
/// 从「我的技能」页整行消失(canonical 是 cursor/codex 与全部 universal 工具
/// 唯一的读取位置)。
#[test]
fn keep_version_links_canonical_even_when_canonical_is_not_a_candidate() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let a = skill_dir(&env.home, ".claude/skills/s", "v1");
    let b = skill_dir(&env.home, ".trae/skills/s", "v2");
    let canonical = env.home.join(".agents/skills/s");
    assert!(!canonical.exists(), "sanity: canonical 一开始没有任何实体或链接");

    let r = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &a, NOW).unwrap();

    assert_eq!(r.body, a.to_string_lossy());
    assert_eq!(c.sandbox.trashed(), vec![b.clone()]);
    assert_eq!(
        fsops::read_link_target(&canonical),
        Some(fsops::normalize(&a)),
        "canonical 不是候选之一,也必须被补链"
    );
}

/// I2:`agents` 必须是并集合并,不是覆盖。一个工具若是通过健康链接关联的(新模型
/// 下的常态),它的目录不会成为 `scan_all` 的候选、不进 `touched_dirs`,整体覆盖
/// 会把它从账上静默抹掉,即便磁盘上那条链接原封不动。
#[test]
fn keep_version_preserves_an_agent_whose_link_is_healthy_and_not_a_candidate() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let claude_body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let trae_link = env.home.join(".trae/skills/s");
    link(&claude_body, &trae_link); // 健康链接,不是 scan_all 的候选

    let mut state = state_with_body("s", &claude_body);
    state.installed[0].agents = vec!["claude-code".into(), "trae".into()];
    state.installed[0].links = vec![state::LinkRecord {
        dir: env.home.join(".trae/skills").to_string_lossy().into_owned(),
        mode: "symlink".into(),
    }];
    c.store.save_state(&state).unwrap();

    // canonical 内容不同,构成第二个候选(账上照旧恒选 claude_body 当本体)。
    let canonical = skill_dir(&env.home, ".agents/skills/s", "v2");

    let r = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &claude_body, NOW).unwrap();

    assert_eq!(r.body, claude_body.to_string_lossy());
    assert_eq!(c.sandbox.trashed(), vec![canonical.clone()]);
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    assert!(
        rec.agents.contains(&"trae".to_string()),
        "trae 是健康链接、不进候选,整体覆盖会把它从账上静默抹掉: {:?}",
        rec.agents
    );
    assert_eq!(
        fsops::read_link_target(&trae_link),
        Some(fsops::normalize(&claude_body)),
        "trae 那条链接磁盘上应当原样健在,没被这次拍板动过"
    );
}

/// I3:有账 + body 不在 canonical + canonical 被一份内容不同的实体目录占着——
/// `locate` 的有账分支会把这份异内容副本直接丢弃、不进 `Located`,到不了
/// `NeedsVersionChoice`。此前 `set_agents` 会在磁盘零写入的前提下悄悄返回
/// `Done`,而 canonical 那条链接的收敛结果一个字都没提。
#[test]
fn set_agents_reports_the_canonical_differs_instead_of_swallowing_it() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let claude_body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let state = state_with_body("s", &claude_body);
    c.store.save_state(&state).unwrap();
    let canonical = skill_dir(&env.home, ".agents/skills/s", "v9");
    let before = fsops::dir_content_hash(&canonical).unwrap();

    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();

    let SetAgentsOutcome::Done { canonical: outcome, .. } = out else {
        panic!("expected Done")
    };
    assert_eq!(
        outcome,
        Converged::Differs {
            existing: canonical.to_string_lossy().into_owned()
        }
    );
    assert_eq!(fsops::dir_content_hash(&canonical).unwrap(), before, "canonical 磁盘零写入");
    assert!(c.sandbox.trashed().is_empty());
}

/// I4a:每一条成功的收敛(含 canonical 那条)都必须并进账上的 `links`,否则
/// `remove::remove` 只按 `state.links` 摘链,找不到就摘不掉;第二次调用换了一个
/// 不相关的目标时,原先的记账不该被覆盖掉(并集合并)。
#[test]
fn set_agents_keeps_every_successful_link_in_the_account_for_remove_to_find_later() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");

    converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();

    let trae_dir = env.home.join(".trae").join("skills");
    let canonical_dir = env.home.join(".agents").join("skills");
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    assert!(
        rec.links.iter().any(|l| Path::new(&l.dir) == trae_dir && l.mode == "symlink"),
        "trae 的链接必须进账,remove 才摘得掉它: {:?}",
        rec.links
    );
    assert!(
        rec.links.iter().any(|l| Path::new(&l.dir) == canonical_dir && l.mode == "symlink"),
        "canonical 那条链接也必须进账: {:?}",
        rec.links
    );

    // 再勾一个不相关的 agent,trae 那条记账不该被覆盖掉。
    converge::set_agents(
        &inst,
        &c.registry,
        &env,
        &c.store,
        "s",
        &["trae".into(), "trae-cn".into()],
        NOW,
    )
    .unwrap();
    let st2 = c.store.load_state().unwrap().value;
    let rec2 = st2.installed.iter().find(|s| s.name == "s").unwrap();
    assert!(
        rec2.links.iter().any(|l| Path::new(&l.dir) == trae_dir),
        "trae 的记账不该在勾选别的 agent 时被覆盖掉: {:?}",
        rec2.links
    );
    assert!(body.join("SKILL.md").is_file(), "本体全程不受这两次勾选影响");
}

/// I4b:账上记的是 `copy` 档(降级复制,目标位置是**实体目录**)时,取消勾选
/// 必须走废纸篓,不能用 `unlink_dir`——它对实体目录一律拒绝(`FS_NOT_A_LINK`),
/// 不特判会让整个 `set_agents` 在这里中途夭折,而前面已建好的链接因为
/// `store.save_state` 还没跑到,一条都不会进账。
#[test]
fn set_agents_removes_a_copy_degraded_link_via_trash_instead_of_crashing() {
    let (c, env) = ctx();
    let inst_copy = Installer::new(&c.registry, &env)
        .with_trasher(&c.sandbox)
        .with_chain(vec![LinkKind::Copy]);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");

    converge::set_agents(&inst_copy, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();

    let trae_link = env.home.join(".trae/skills/s");
    assert!(trae_link.is_dir(), "sanity: 降级复制落盘是实体目录");
    assert!(fsops::read_link_target(&trae_link).is_none(), "sanity: 不是链接");
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    assert_eq!(
        rec.links
            .iter()
            .find(|l| Path::new(&l.dir) == env.home.join(".trae/skills"))
            .map(|l| l.mode.as_str()),
        Some("copy")
    );

    let out = converge::set_agents(&inst_copy, &c.registry, &env, &c.store, "s", &[], NOW).unwrap();

    let SetAgentsOutcome::Done { unlinked, .. } = out else {
        panic!("expected Done, not an error")
    };
    assert_eq!(unlinked, vec!["trae".to_string()]);
    assert!(!trae_link.exists(), "降级复制出来的实体目录应当被摘掉(进废纸篓)");
    assert!(c.sandbox.trashed().iter().any(|p| p == &trae_link));
    assert!(body.join("SKILL.md").is_file(), "本体自己不受这次摘链影响");
}

/// M3:目标位置是普通文件(不是目录)时,早退成 `Differs`、磁盘零写入,而不是
/// 报一句文不对题的「无法读取技能目录内容,请重试」(用户重试多少次都一样)。
#[test]
fn converge_reports_differs_without_touching_disk_when_target_is_a_file() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let target = env.home.join(".agents/skills/s");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, b"not a skill directory").unwrap();

    let r = converge::converge(&inst, &target, &body).unwrap();

    assert_eq!(
        r,
        Converged::Differs {
            existing: target.to_string_lossy().into_owned()
        }
    );
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"not a skill directory",
        "磁盘零写入"
    );
    assert!(c.sandbox.trashed().is_empty());
}

/// M1:`choose_body` 是任务书指定的 `pub` API,直接传空切片违反了它的前置条件。
/// debug 构建下必须 `debug_assert!` 失败(给开发/测试期一道安全网),不能在
/// release 构建的 Tauri command 里 panic——那件事本身在别处已单独确认过
/// (改成 `paths.first().cloned().unwrap_or_default()`,这里只钉住 debug 那一半)。
#[test]
#[should_panic(expected = "choose_body 要求 paths 非空")]
fn choose_body_debug_asserts_on_an_empty_slice() {
    let _ = converge::choose_body(&[], Path::new("/canon"), &[]);
}

// ============================================================ 审查修复轮 2

/// I4③(定向复审抓到的结构性问题,不是 I4 的 Copy 特例):账上记的是
/// `symlink`,但外部(用户自己、或别的工具)把那个位置换成了一个实体目录——
/// `unlink_dir` 一样会报 `FS_NOT_A_LINK`。摘链循环之后还有 `store.save_state`,
/// 若用 `?` 中断,循环里(以及更早的 `wanted` 循环)已经成功建好的链接——包括
/// 这次调用**同时新勾选**的另一个工具——会因为没跑到 `save_state` 而
/// "磁盘已经动了、账却没存"。必须收集失败、不中断,新链接照常进账。
#[test]
fn set_agents_still_records_new_links_when_an_unrelated_removal_fails() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");

    converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();
    let trae_link = env.home.join(".trae/skills/s");
    assert!(fsops::read_link_target(&trae_link).is_some(), "sanity: trae 目前是链接");

    // 外部把这条链接换成了一个实体目录,账上仍记着 symlink。
    fsops::unlink_dir(&trae_link).unwrap();
    std::fs::create_dir_all(&trae_link).unwrap();
    std::fs::write(trae_link.join("SKILL.md"), skill_md("v9")).unwrap();

    // 取消 trae、同时勾上 trae-cn(不同目录的另一个工具)。
    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae-cn".into()], NOW).unwrap();

    let SetAgentsOutcome::Done {
        results,
        unlinked,
        unlink_failed,
        ..
    } = out
    else {
        panic!("expected Done, not an error——不该被这一条摘链失败拖垮整个调用")
    };

    // ① 不 panic、不吞错:trae 的摘链失败如实回报,没有被算进 unlinked。
    assert!(
        unlink_failed.iter().any(|(a, e)| a == "trae" && e.code == "FS_NOT_A_LINK"),
        "trae 摘链失败必须如实出现在结果里: {unlink_failed:?}"
    );
    assert!(!unlinked.contains(&"trae".to_string()));

    // ② 新勾的 trae-cn 已经进账——不能因为 trae 那条失败就中途夭折。
    assert!(matches!(&results[0], (a, Converged::Linked { .. }) if a == "trae-cn"));
    let trae_cn_link = env.home.join(".trae-cn/skills/s");
    assert_eq!(
        fsops::read_link_target(&trae_cn_link),
        Some(fsops::normalize(&body)),
        "trae-cn 的链接应当已经落盘"
    );
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    assert!(
        rec.links
            .iter()
            .any(|l| Path::new(&l.dir) == env.home.join(".trae-cn/skills")),
        "trae-cn 的链接必须进账,否则 remove 找不到它: {:?}",
        rec.links
    );
}

