//! `converge` 原语的集成测试(v6 二期任务 3):本体定位、写盘前收敛、
//! 版本拍板、工具启用(勾选)。
//!
//! 姿态与其余编排层测试一致:能断言"磁盘上的字节有没有变",就不要只断言
//! 函数返回了哪个枚举——尤其是"内容不同必须停下"这一档,正面断言磁盘零写入。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::converge::{self, Converged, KeepReport, Located, SetAgentsOutcome};
use skillsync_lib::core::fsops::{self, LinkKind};
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
    fsops::link_dir(target, at, fsops::default_link_chain()).unwrap();
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
    // 审查修复轮 4:每条 links 必须认得出是哪个位置、并带成败。只回一串
    // 无名的 `Converged` 时,调用方分不清"哪个位置成了、哪个没成"。
    assert_eq!(
        r.links,
        vec![(b.to_string_lossy().into_owned(), Ok(Converged::Linked { mode: "symlink".into() }))],
        "落选位置要按 (路径, 结果) 逐条回报"
    );
    assert_eq!(
        r.canonical,
        Ok(Converged::Unchanged),
        "canonical 这一步在候选循环里已经收敛过,第二次是幂等早退"
    );
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
    assert!(matches!(&results[0], (a, Ok(Converged::Linked { .. })) if a == "trae"));
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
    assert!(matches!(&results[0], (a, Ok(Converged::Linked { .. })) if a == "trae"));
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
        &Ok(Converged::Differs {
            existing: trae_link.to_string_lossy().into_owned()
        })
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
        Ok(Converged::Differs {
            existing: canonical.to_string_lossy().into_owned()
        })
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
    assert!(matches!(&results[0], (a, Ok(Converged::Linked { .. })) if a == "trae-cn"));
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


// ============================================================ 审查修复轮 3(R11:结构性)

/// R11 主犯,复审者已复现:`.trae-cn` 本身被造成一个**普通文件**(不是目录)——
/// 建链时 `link_dir` 内部的 `create_dir_all(parent)` 必然失败。此前建链循环里
/// 的 `converge(...)?` 会让整个 `set_agents` 在这里中途夭折:trae 的链接已经
/// 落盘,却因为函数提前返回 `Err` 而永远没机会 `save_state`,账上一条记录都没有
/// ——`remove::remove` 只认账,那条 trae 链接会永远留在磁盘上摘不掉。
#[test]
fn set_agents_does_not_abort_when_one_targets_link_dir_is_blocked_by_a_file() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    // .trae-cn 本身是一个普通文件,不是目录——建链时 create_dir_all(parent) 必失败。
    std::fs::write(env.home.join(".trae-cn"), b"not a directory").unwrap();

    let out = converge::set_agents(
        &inst,
        &c.registry,
        &env,
        &c.store,
        "s",
        &["trae".into(), "trae-cn".into()],
        NOW,
    )
    .unwrap();

    let SetAgentsOutcome::Done { results, .. } = out else {
        panic!("expected Done, not an error——一个目标建链失败不该拖垮整个调用")
    };

    // 两条都必须如实出现在 results 里:trae 成功、trae-cn 失败——不是"trae-cn
    // 没被处理",是"处理过了但没成功"。
    assert!(
        results.iter().any(|(a, r)| a == "trae" && matches!(r, Ok(Converged::Linked { .. }))),
        "{results:?}"
    );
    assert!(
        results.iter().any(|(a, r)| a == "trae-cn" && r.is_err()),
        "trae-cn 的失败必须如实回报,不能只进日志: {results:?}"
    );

    // 成功的那条(trae)确实进了账,否则 remove 永远摘不掉它。
    let trae_link = env.home.join(".trae/skills/s");
    assert_eq!(
        fsops::read_link_target(&trae_link),
        Some(fsops::normalize(&body)),
        "trae 的链接应当已经落盘"
    );
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    assert!(
        rec.links.iter().any(|l| Path::new(&l.dir) == env.home.join(".trae/skills")),
        "trae 的链接必须进账: {:?}",
        rec.links
    );
}

/// R11:无账新建那一档的 `dir_content_hash` 必须挪到任何写盘调用之前算——
/// 原先排在写盘全部完成之后,一旦这里失败,磁盘已经全部写完却建不出账,新技能
/// 会永久停留在"我的技能"里看不到的状态。
#[test]
#[cfg(unix)]
fn set_agents_computes_the_fresh_hash_before_touching_disk_for_a_new_account() {
    use std::os::unix::fs::PermissionsExt;

    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    let secret = body.join("secret.txt");
    std::fs::write(&secret, b"top secret").unwrap();
    // 权限拒读,让 dir_content_hash 必然失败(不依赖磁盘满/断电这类难构造的故障)。
    std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();

    let err = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap_err();

    assert_eq!(err.code, "FS_HASH_FAILED");
    // 磁盘零写入:hash 失败必须发生在任何 converge/canonical 调用之前。
    assert!(
        fsops::read_link_target(&env.home.join(".agents/skills/s")).is_none(),
        "canonical 不该被建"
    );
    assert!(
        std::fs::symlink_metadata(env.home.join(".trae/skills/s")).is_err(),
        "trae 不该被建"
    );
    assert!(c.store.load_state().unwrap().value.installed.is_empty(), "账不该被写");

    std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o644)).unwrap();
}

/// R11 位置②:`link_targets_for(&home, &wanted)` 这个**调用本身**失败
/// (`wanted` 里混进注册表不认识的 agent 名)也不能中断——同样按 agent 名收进
/// `results`,不拖垮整次调用。
#[test]
fn set_agents_does_not_abort_when_an_unknown_agent_name_is_requested() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");

    // trae:正常需要建链的工具;cursor:universal(skillsDir 就是 canonical,
    // 正常路径里 `link_targets` 本就跳过它、它从不出现在 results);
    // 不存在的工具:注册表不认识的坏名字。
    let out = converge::set_agents(
        &inst,
        &c.registry,
        &env,
        &c.store,
        "s",
        &["trae".into(), "cursor".into(), "不存在的工具".into()],
        NOW,
    )
    .unwrap();

    let SetAgentsOutcome::Done { results, .. } = out else {
        panic!("expected Done, not an error")
    };
    // ① 坏名字自己一条 Err。
    assert!(
        results
            .iter()
            .any(|(a, r)| a == "不存在的工具" && r.as_ref().err().map(|e| e.code.as_str()) == Some("FS_UNKNOWN_AGENT")),
        "{results:?}"
    );
    // ② 坏名字**只坑它自己**:合法的 trae 必须是 Ok,且链接真的建上了。
    assert!(
        matches!(results.iter().find(|(a, _)| a == "trae"), Some((_, Ok(Converged::Linked { .. })))),
        "一个坏名字不得把 trae 一起判死: {results:?}"
    );
    assert_eq!(
        fsops::read_link_target(&env.home.join(".trae/skills/s")),
        Some(fsops::normalize(&body)),
        "trae 的链接必须真的落盘,不能只是回报了个 Ok"
    );
    // ③ universal 工具不得被冤枉:它压根不需要建链,正常路径里不出现在 results,
    //    回退路径也不许给它记一条它根本走不到的失败。
    assert!(
        !results.iter().any(|(a, _)| a == "cursor"),
        "cursor 落在 canonical 即可见、从不需要建链目标,不该出现在 results 里: {results:?}"
    );
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "s").unwrap();
    // ④ 账不得被毒化:垃圾名写进 `rec.agents` 之后,若界面回显勾选态再原样传回,
    //    它会循环存在,而每一轮都被判进 `removed`,关联状态永远稳定不下来。
    assert!(
        !rec.agents.contains(&"不存在的工具".to_string()),
        "注册表不认识的 agent 名不得写进账: {:?}",
        rec.agents
    );
    assert!(
        rec.agents.contains(&"trae".to_string()) && rec.agents.contains(&"cursor".to_string()),
        "合法的两个都要在账上: {:?}",
        rec.agents
    );
    assert!(body.join("SKILL.md").is_file());
}

/// R11 位置④:`link_targets_for(&home, &removed)` 这个调用本身失败(账上留着
/// 注册表已经不认识的陈旧 agent 名,典型场景是跨版本注册表变化)也不能中断。
#[test]
fn set_agents_does_not_abort_when_the_account_has_a_stale_unknown_agent_name() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    // trae 是一条真实的、账上有记录的健康链接:它必须照常被摘掉,不能因为
    // 同一份 `removed` 里混着一个陈旧名字就整批作废(审查修复轮 4:摘链侧
    // 与建链侧是同一个结构问题,一起按 agent 逐个 resolve)。
    let trae_link = env.home.join(".trae/skills/s");
    link(&body, &trae_link);
    let mut state = state_with_body("s", &body);
    state.installed[0].agents = vec!["claude-code".into(), "trae".into(), "早已下线的工具".into()];
    state.installed[0].links = vec![state::LinkRecord {
        dir: env.home.join(".trae/skills").to_string_lossy().into_owned(),
        mode: "symlink".into(),
    }];
    c.store.save_state(&state).unwrap();

    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &[], NOW).unwrap();

    let SetAgentsOutcome::Done {
        unlink_failed, unlinked, ..
    } = out
    else {
        panic!("expected Done, not an error")
    };
    assert!(
        unlink_failed
            .iter()
            .any(|(a, e)| a == "早已下线的工具" && e.code == "FS_UNKNOWN_AGENT"),
        "{unlink_failed:?}"
    );
    // 坏名字只坑它自己:合法的 trae 照常摘掉,磁盘上那条链接真的没了。
    assert!(unlinked.contains(&"trae".to_string()), "{unlinked:?} / {unlink_failed:?}");
    assert!(
        std::fs::symlink_metadata(&trae_link).is_err(),
        "trae 的链接应当已经被摘掉"
    );
    assert!(body.join("SKILL.md").is_file(), "本体不动");
    let st = c.store.load_state().unwrap().value;
    let rec = st
        .installed
        .iter()
        .find(|s| s.name == "s")
        .expect("账应当已经落地,没有中途夭折");
    assert!(
        !rec.agents.contains(&"早已下线的工具".to_string()),
        "注册表不认识的陈旧名字不得再被写回账上: {:?}",
        rec.agents
    );
}

/// R11 位置①:`ensure_canonical_link`(本函数**第一处写盘**)自己失败也不能
/// 中断——即便危害相对轻(`installer::uninstall` 对 canonical 是无条件摘、
/// 不依赖 `state.links`),为了这条判据的完整性也一并收。
#[test]
fn set_agents_does_not_abort_when_the_canonical_link_itself_fails() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/s", "v1");
    // ~/.agents 本身是一个普通文件——canonical 链接的父目录建不出来。
    std::fs::write(env.home.join(".agents"), b"not a directory").unwrap();

    let out = converge::set_agents(&inst, &c.registry, &env, &c.store, "s", &["trae".into()], NOW).unwrap();

    let SetAgentsOutcome::Done { canonical, results, .. } = out else {
        panic!("expected Done, not an error")
    };
    assert!(canonical.is_err(), "{canonical:?}");
    // trae 仍然成功建链、进账——不能因为 canonical 那一步失败就中途夭折。
    assert!(
        results
            .iter()
            .any(|(a, r)| a == "trae" && matches!(r, Ok(Converged::Linked { .. }))),
        "{results:?}"
    );
    let trae_link = env.home.join(".trae/skills/s");
    assert_eq!(fsops::read_link_target(&trae_link), Some(fsops::normalize(&body)));
    let st = c.store.load_state().unwrap().value;
    assert!(st.installed.iter().any(|s| s.name == "s"), "账应当已经落地,没有中途夭折");
}

// ============================================================ R11:keep_version(审查修复轮 4)
//
// 判据(裁定 R11):**从第一次写磁盘到 `save_state` 之间,任何失败都不得让函数
// 带着"磁盘已动、账未存"的状态返回。** 修复轮 3 只在 `set_agents` 上做到了这条,
// `keep_version` 漏了,而它的现场更险——循环里第一处写盘就是破坏性的
// `trash_tree`,内容指纹却排在全部写盘之后。

/// R11 前移②:基线指纹必须在**任何**写盘之前算。原先它排在候选循环与
/// `ensure_canonical_link` 全跑完之后,一旦 hash 失败,落选版本已进废纸篓、
/// 落选位置与 canonical 都已换成链接,函数却带着 `Err` 返回,账上一条都没有。
#[cfg(unix)]
#[test]
fn keep_version_computes_the_baseline_hash_before_touching_disk() {
    use std::os::unix::fs::PermissionsExt;

    let (c, env) = ctx();
    let inst = c.installer(&env);
    let keep = skill_dir(&env.home, ".claude/skills/s", "v1");
    let loser = skill_dir(&env.home, ".trae/skills/s", "v2");
    let canonical = env.home.join(".agents/skills/s");

    // 让 `dir_content_hash(keep)` 必然失败:目录里放一个读不了的文件。
    let secret = keep.join("secret.txt");
    std::fs::write(&secret, b"x").unwrap();
    std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();

    let err = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &keep, NOW).unwrap_err();

    assert_eq!(err.code, "FS_HASH_FAILED", "{err:?}");
    assert!(c.sandbox.trashed().is_empty(), "报错之前一个字节都不该动: {:?}", c.sandbox.trashed());
    assert!(
        loser.join("SKILL.md").is_file() && fsops::read_link_target(&loser).is_none(),
        "落选版本必须原封不动地留在原地,不能已经进了废纸篓、换成了链接"
    );
    assert!(!canonical.exists(), "canonical 也不该被抢先建出链接");
    let st = c.store.load_state().unwrap().value;
    assert!(st.installed.is_empty(), "账应当一条都没有: {:?}", st.installed);

    std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o600)).unwrap();
}

/// R11 收集①:候选循环内的写盘失败必须**收集**,不能 `?` 中断——中断会把
/// 同一轮里已经成功收敛的其余位置连同记账一起拖没了(它们的链接已落盘,
/// `remove::remove` 却按 `state.links` 摘链,从此摘不掉)。
#[cfg(unix)]
#[test]
fn keep_version_keeps_going_when_one_losing_position_cannot_be_converged() {
    use std::os::unix::fs::PermissionsExt;

    let (c, env) = ctx();
    let inst = c.installer(&env);
    let keep = skill_dir(&env.home, ".claude/skills/s", "v1");
    // 候选按路径排序:.agents(先,正常) → .claude(keep,跳过) → .trae(后,失败)
    let ok_loser = skill_dir(&env.home, ".agents/skills/s", "v2");
    let bad_loser = skill_dir(&env.home, ".trae/skills/s", "v3");

    // 父目录只读 → 挪进废纸篓(rename)必然失败。
    let bad_parent = env.home.join(".trae/skills");
    std::fs::set_permissions(&bad_parent, std::fs::Permissions::from_mode(0o555)).unwrap();

    let r = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &keep, NOW).unwrap();

    assert!(
        r.links
            .iter()
            .any(|(p, res)| Path::new(p) == bad_loser.as_path() && res.is_err()),
        "失败的位置要如实回报,不能吞: {:?}",
        r.links
    );
    assert!(
        r.links
            .iter()
            .any(|(p, res)| Path::new(p) == ok_loser.as_path() && matches!(res, Ok(Converged::Linked { .. }))),
        "同一轮里本该成功的位置必须照常收敛: {:?}",
        r.links
    );
    assert_eq!(c.sandbox.trashed(), vec![ok_loser.clone()]);
    assert_eq!(fsops::read_link_target(&ok_loser), Some(fsops::normalize(&keep)));
    assert!(
        bad_loser.join("SKILL.md").is_file() && fsops::read_link_target(&bad_loser).is_none(),
        "摘不动的位置原样留着——绝不静默删除用户文件"
    );
    let st = c.store.load_state().unwrap().value;
    let rec = st
        .installed
        .iter()
        .find(|s| s.name == "s")
        .expect("账必须已经落地,不能因为一个位置失败就整次夭折");
    assert_eq!(rec.body.as_deref(), Some(keep.to_str().unwrap()));
    assert!(
        rec.links
            .iter()
            .any(|l| Path::new(&l.dir) == env.home.join(".agents/skills")),
        "成功那条链接必须进账(remove 才摘得掉): {:?}",
        rec.links
    );

    std::fs::set_permissions(&bad_parent, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// R11 收集③:候选循环里 **`link_dir` 失败**那一支(v6 二期任务 4 补,裁定 R13)。
///
/// 上一条钉的是"腾位置失败(`trash_tree`)→ 收集并 `continue`",本条钉的是它的
/// 兄弟分支:**位置已经腾空了、链接却没建成**。这一支此前一条测试都没有
/// (任务 3 复审注入之后 31 条全绿 = 真没抓到)。它必须被如实回报:位置已经空了,
/// 装作没事的话用户看到的是"已完成",而那个工具目录里从此什么都没有。
///
/// 构造很便宜:给 installer 一条**空降级链**,`link_dir` 走完 `for kind in chain`
/// 一个候选都没有,必然报错——而它前面的 `trash_tree` 照常成功。
#[test]
fn keep_version_reports_a_losing_position_that_was_emptied_but_not_linked() {
    let (c, env) = ctx();
    let inst = Installer::new(&c.registry, &env)
        .with_trasher(&c.sandbox)
        .with_chain(vec![]);
    let keep = skill_dir(&env.home, ".claude/skills/s", "v1");
    let loser = skill_dir(&env.home, ".trae/skills/s", "v2");

    let r = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &keep, NOW).unwrap();

    assert_eq!(c.sandbox.trashed(), vec![loser.clone()], "位置确实腾空了");
    assert!(!loser.exists(), "腾空之后那个位置该是空的");
    assert!(
        r.links
            .iter()
            .any(|(p, res)| Path::new(p) == loser.as_path() && res.is_err()),
        "腾空了却没建成链接,必须如实回报: {:?}",
        r.links
    );
    let st = c.store.load_state().unwrap().value;
    let rec = st
        .installed
        .iter()
        .find(|s| s.name == "s")
        .expect("账必须已经落地,不能因为一个位置建链失败就整次夭折");
    assert_eq!(rec.body.as_deref(), Some(keep.to_str().unwrap()));
    assert!(
        !rec.links
            .iter()
            .any(|l| Path::new(&l.dir) == env.home.join(".trae/skills")),
        "没建成的链接绝不能进账——记了 remove 会拿它去动那个位置: {:?}",
        rec.links
    );
}

/// R11 收集②:`ensure_canonical_link` 失败也不能 `?` 中断——它排在候选循环
/// **之后**,中断会把整轮已经落盘的收敛全部丢掉记账。
#[test]
fn keep_version_reports_a_failing_canonical_link_instead_of_swallowing_it() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let keep = skill_dir(&env.home, ".claude/skills/s", "v1");
    let loser = skill_dir(&env.home, ".trae/skills/s", "v2");
    // canonical 的祖先被占成一个普通文件 → 建链时 `create_dir_all` 必然失败。
    std::fs::write(env.home.join(".agents"), b"not a directory").unwrap();

    let r = converge::keep_version(&inst, &c.registry, &env, &c.store, "s", &keep, NOW).unwrap();

    assert!(r.canonical.is_err(), "canonical 建链失败要如实回报: {:?}", r.canonical);
    assert_eq!(c.sandbox.trashed(), vec![loser.clone()], "循环里的活照常干完");
    assert_eq!(fsops::read_link_target(&loser), Some(fsops::normalize(&keep)));
    let st = c.store.load_state().unwrap().value;
    let rec = st
        .installed
        .iter()
        .find(|s| s.name == "s")
        .expect("账必须已经落地,不能因为 canonical 那一步失败就整次夭折");
    assert_eq!(rec.body.as_deref(), Some(keep.to_str().unwrap()));
}

// ============================================================ 查账键(I-1,修复轮 1)
//
// 记账写的是**清洗后**的目录名(`sanitize_name` 会小写化),而调用方手上的
// `dir_slug` 可能是技能库里带大写的原始目录名。全小写 fixture 下两把尺子恰好相同
// ——**所以这两条必须用大写 slug**,否则等于没测。

const MIXED: &str = "Weekly-Report";
const MIXED_KEY: &str = "weekly-report";

/// `set_agents` 查账/落账都用 `record_key`,不是 `dir_slug`。
///
/// 用错的后果:已有的那条账查不到 → 走"无账首次勾选"那一档 → **往
/// `state.installed` 里推第二条同一个技能的记录**(键还是原始大写名),
/// 从此这个技能在账上有两条、彼此覆盖不到,`remove` 只清得掉一条。
#[test]
fn set_agents_finds_the_existing_record_for_a_mixed_case_slug() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let body = skill_dir(&env.home, ".claude/skills/weekly-report", "v1");
    let mut state = state_with_body(MIXED_KEY, &body);
    state.installed[0].commit_sha = "aaa1111".into();
    c.store.save_state(&state).unwrap();

    let r = converge::set_agents(&inst, &c.registry, &env, &c.store, MIXED, &["trae".into()], NOW).unwrap();
    assert!(matches!(r, SetAgentsOutcome::Done { .. }), "{r:?}");

    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1, "查账键错位会推出第二条重复记录: {:?}", st.installed);
    assert_eq!(st.installed[0].name, MIXED_KEY, "记账键必须是清洗后的名字");
    assert_eq!(
        st.installed[0].commit_sha, "aaa1111",
        "命中的应当是原来那条账(它的 sha 还在),不是新建的一条"
    );
}

/// `keep_version` 同理:查账/落账都用 `record_key`。
#[test]
fn keep_version_finds_the_existing_record_for_a_mixed_case_slug() {
    let (c, env) = ctx();
    let inst = c.installer(&env);
    let keep = skill_dir(&env.home, ".claude/skills/weekly-report", "v1");
    let loser = skill_dir(&env.home, ".agents/skills/weekly-report", "v2");
    let mut state = state_with_body(MIXED_KEY, &keep);
    state.installed[0].commit_sha = "aaa1111".into();
    c.store.save_state(&state).unwrap();

    let r = converge::keep_version(&inst, &c.registry, &env, &c.store, MIXED, &keep, NOW).unwrap();
    assert_eq!(r.body, keep.to_string_lossy());
    assert_eq!(c.sandbox.trashed(), vec![loser.clone()]);

    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1, "查账键错位会推出第二条重复记录: {:?}", st.installed);
    assert_eq!(st.installed[0].name, MIXED_KEY);
    assert_eq!(st.installed[0].commit_sha, "aaa1111", "命中的应当是原来那条账");
}

// ============================================================ IPC 序列化形状

/// 🔴 `#[serde(rename_all = ...)]` 挂在**枚举**上只改 variant 名,**不改
/// struct variant 的字段名**——本项目 IPC 一律驼峰,少了 `rename_all_fields`
/// 就会把 `home_body` / `unlink_failed` 这样的蛇形键发给前端。任务 4 接线时
/// 这条是唯一的护栏(core 侧没有任何别的地方会碰到序列化形状)。
///
/// 同时正面记录 `Result` 的既定形状:serde 内建 impl 给的是**大写**键
/// `{"Ok": …}` / `{"Err": …}`,`rename_all` 管不到;元组序列化成 JSON 数组。
#[test]
fn set_agents_outcome_serializes_its_fields_in_camel_case() {
    let out = SetAgentsOutcome::Done {
        home_body: "/home/u/.claude/skills/s".into(),
        canonical: Ok(Converged::Unchanged),
        results: vec![(
            "trae".into(),
            Ok(Converged::Linked {
                mode: "symlink".into(),
            }),
        )],
        unlinked: vec!["trae-cn".into()],
        unlink_failed: vec![(
            "zed".into(),
            skillsync_lib::error::AppError::new("FS_NOT_A_LINK", "该位置是一个实体技能目录,不会被自动删除"),
        )],
    };

    let v = serde_json::to_value(&out).unwrap();

    assert_eq!(v["outcome"], "done", "{v}");
    assert_eq!(v["homeBody"], "/home/u/.claude/skills/s", "{v}");
    assert!(v.get("home_body").is_none(), "蛇形键不得出现: {v}");
    assert_eq!(v["unlinkFailed"][0][0], "zed", "{v}");
    assert!(v.get("unlink_failed").is_none(), "蛇形键不得出现: {v}");
    // 既定形状(不改实现,前端类型照这个写):元组 → 数组,Result → 大写键。
    assert_eq!(v["results"][0][0], "trae", "{v}");
    assert_eq!(v["results"][0][1]["Ok"]["kind"], "linked", "{v}");
    assert_eq!(v["canonical"]["Ok"]["kind"], "unchanged", "{v}");
    assert_eq!(v["unlinkFailed"][0][1]["code"], "FS_NOT_A_LINK", "{v}");
}

/// 🔴 v6 二期任务 5 的第三条同轴缺陷:`scan_all` 的分组键必须与 `locate` 的
/// 查表键(`record_key` = 清洗后的目录名)**同尺**。
///
/// 现场是用户在 `~/.claude/skills/` 下手建的 `Weekly-Report` 目录:
/// 按字面名分组的话键是 `Weekly-Report`,而 `locate` 查的是 `weekly-report`
/// ——**这个技能永远发现不了**,`locate` 恒返回 `None`,于是「勾选工具」
/// 报"本体不在了"、`precheck` 也看不见它。
///
/// fixture 刻意用**大写**目录名:全小写现场里两把尺子恰好相同,
/// 这条规则改坏了照样全绿(本项目记录的空转模式 ③)。
#[test]
fn scan_all_groups_by_the_record_key_so_uppercase_dirs_are_found() {
    let (ctx, env) = ctx();
    let body = skill_dir(&env.home, ".claude/skills/Weekly-Report", "v1");

    let all = converge::scan_all(&ctx.registry, &env).unwrap();
    assert_eq!(
        all.keys().collect::<Vec<_>>(),
        vec!["weekly-report"],
        "分组键必须是清洗后的名字,否则 locate 永远查不到它"
    );
    assert_eq!(all["weekly-report"], vec![body.clone()], "值保持字面路径:本体不改名不搬家");

    let installer = ctx.installer(&env);
    let located = converge::locate(&installer, &ctx.registry, &env, &State::default(), "weekly-report").unwrap();
    assert_eq!(
        located,
        Located::Body { body, others: Vec::new() },
        "定位得到那个大写目录本身"
    );
}

/// 清洗后会塌成 `unnamed-skill` 的名字(纯中文目录名)**保留字面键**:
/// 合并到同一个 `unnamed-skill` 键下只会让两个不同的技能互相遮蔽。
#[test]
fn names_that_collapse_to_unnamed_skill_keep_their_literal_key() {
    let (ctx, env) = ctx();
    skill_dir(&env.home, ".agents/skills/测试", "v1");
    skill_dir(&env.home, ".agents/skills/周报", "v2");

    let all = converge::scan_all(&ctx.registry, &env).unwrap();
    let mut keys: Vec<&String> = all.keys().collect();
    keys.sort();
    assert_eq!(keys, vec!["周报", "测试"], "两个中文目录各占一个键,不许互相遮蔽");
}
