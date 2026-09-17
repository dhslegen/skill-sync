//! 新建技能(M4 任务 4)的编排测试。
//!
//! 断言纪律与 claim_flow 相同:关心磁盘与账本的实际字节,不只看返回枚举。
//! 本任务的铁律级断言有两条:
//!   1. **撞名时磁盘一个字节都没动**——新建走的是"往 canonical 写"的路,覆盖就是毁用户文件;
//!   2. 新建的技能**不进 `state`**,并且能被分享页的排除法扫描列成候选(`origin: local`)
//!      ——分享是它唯一的出路,进了 `state.installed` 就从候选里消失了。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::create::{self, CreateRequest};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::share;
use skillsync_lib::core::skills::parse_skill_md;
use skillsync_lib::core::state::{
    InstalledSkill, SharedSkill, SkillSource, State, Store,
};

/// 把 `"a/b/c"` 这种**字面带斜杠**的相对路径按段 join 到 `base` 上。
///
/// 🔴 **不能直接写成 `base.join` 传一个含斜杠的串**(2026-09-11 与 09-14 两轮
/// Windows CI 实测):`Path::join` 对含 `/` 的字符串**原样保留那个斜杠**,
/// Windows 上产出 `...\.claude/skills\x`,而 core 自己分段拼出来的是
/// `...\.claude\skills\x` ——**同一个目录,字符串却不等**,凡是拿 fixture
/// 路径去和账上字符串比的断言全红。macOS 上两种写法恰好相同,本机怎么跑都是绿的。
fn join_rel<P: AsRef<Path>>(base: P, rel: &str) -> PathBuf {
    rel.split('/').filter(|s| !s.is_empty()).fold(base.as_ref().to_path_buf(), |p, s| p.join(s))
}

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

/// home 为 `None` 的环境,用来验"找不到用户目录"这一档不 panic。
struct NoHomeEnv;

impl AgentEnv for NoHomeEnv {
    fn home(&self) -> Option<PathBuf> {
        None
    }
    fn var(&self, _name: &str) -> Option<String> {
        None
    }
    fn path_exists(&self, _path: &Path) -> bool {
        false
    }
    fn read_to_string(&self, _path: &Path) -> Option<String> {
        None
    }
}

struct Ctx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    registry: AgentRegistry,
    store: Store,
}

impl Ctx {
    fn canonical(&self, slug: &str) -> PathBuf {
        join_rel(&self.home, ".agents/skills").join(slug)
    }
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

fn req<'a>(slug: &'a str, name: &'a str, description: &'a str) -> CreateRequest<'a> {
    CreateRequest {
        dir_slug: slug,
        display_name: name,
        description,
    }
}

// ============================================================ 正常创建

#[test]
fn creates_only_skill_md_and_leaves_state_untouched() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);

    let report = create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周自动汇总工作进展"),
    )
    .expect("新建应当成功");

    let dir = ctx.canonical("weekly-report");
    // 按 `Path` 比:Windows 上 `.agents/skills\x` 与 `.agents\skills\x` 是同一个目录,
    // 字符串却不等(CI 上真实红过一次)
    assert_eq!(PathBuf::from(&report.path), dir);
    assert_eq!(report.dir_slug, "weekly-report");

    // 上游 init 只产出一个文件,我们对齐它:不建子目录、不放 README、不写别的
    let entries: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["SKILL.md".to_string()]);

    // 不写 lock(它记的是"从哪装来的",新建的没有来源)
    assert!(!join_rel(&ctx.home, ".agents/.skill-lock.json").exists(), "不该写 lock");
    // 不进 state:进了 installed 就从分享候选里消失,而分享是它唯一的出路
    let state = ctx.store.load_state().unwrap().value;
    assert!(state.installed.is_empty(), "不该记进 installed");
    assert!(state.shared.is_empty(), "不该记进 shared");
}

#[test]
fn generated_file_parses_back_with_the_form_values() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    // 描述里带冒号:裸写会是 YAML 语法错,必须被引号救回来
    create::create_skill(
        &installer,
        &ctx.store,
        &req("meeting-notes", "会议纪要", "把录音转写整理成: 决议与待办"),
    )
    .unwrap();

    let raw = std::fs::read_to_string(ctx.canonical("meeting-notes").join("SKILL.md")).unwrap();
    let parsed = parse_skill_md(&raw).expect("生成的文件必须能被自己的解析器读回来");
    assert_eq!(parsed.name, "会议纪要");
    assert_eq!(parsed.description, "把录音转写整理成: 决议与待办");
    assert!(!parsed.internal);
}

/// 新建的技能必须出现在分享页候选里——那是它唯一的出路。
/// 同时钉住「ASCII 目录名 + 中文显示名」这组合:目录名可直接作远端名,不必再让用户起一次。
#[test]
fn new_skill_shows_up_as_a_local_share_candidate() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周自动汇总"),
    )
    .unwrap();

    let state = ctx.store.load_state().unwrap().value;
    let candidates = share::scan_candidates(&ctx.registry, &env, &state, &Default::default(), &Default::default()).unwrap();
    let found = candidates
        .iter()
        .find(|c| c.dir_name == "weekly-report")
        .expect("新建的技能应当是分享候选");

    assert!(found.in_canonical);
    assert_eq!(found.origin, share::CandidateOrigin::Local);
    assert_eq!(found.problem, None, "生成的 SKILL.md 不该被判为不合规");
    assert_eq!(found.name.as_deref(), Some("周报生成"));
    assert!(found.dir_name_usable, "ASCII kebab 目录名应当可直接作远端名");
    assert!(found.shared.is_none());
}

// ============================================================ 撞名:三种都拒,且不动磁盘

#[test]
fn refuses_when_directory_already_has_content() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    let dir = ctx.canonical("weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "别人的内容,一个字节都不许动").unwrap();

    let err = create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周汇总"),
    )
    .unwrap_err();

    assert_eq!(err.code, "CONFLICT_NAME_TAKEN");
    assert_eq!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
        "别人的内容,一个字节都不许动",
        "拒绝时必须原样保留"
    );
}

/// 记账还在、本体被用户删了(断链态):目录不存在,但直接建会顶掉那份记账。
/// 这一条**不被"目录已存在"覆盖**,是三条各写一次的理由。
#[test]
fn refuses_when_name_is_taken_by_an_installed_record_without_files() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    let mut state = State::default();
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "builtin".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "abc".into(),
        },
        commit_sha: "abc".into(),
        content_hash: "hash".into(),
        origin: None,
        body: None,
        agents: vec![],
        links: vec![],
        installed_at: "2026-08-01T00:00:00.000Z".into(),
        updated_at: "2026-08-01T00:00:00.000Z".into(),
    });
    ctx.store.save_state(&state).unwrap();

    let err = create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周汇总"),
    )
    .unwrap_err();

    assert_eq!(err.code, "CONFLICT_NAME_TAKEN");
    assert!(!ctx.canonical("weekly-report").exists(), "拒绝时不该建出目录");
    // 记账原样保留
    let after = ctx.store.load_state().unwrap().value;
    assert_eq!(after.installed.len(), 1);
}

/// 造一条"分享过"的记账,指着 `slug` 的 canonical 位置。
fn shared_record_pointing_at(ctx: &Ctx, slug: &str) -> SharedSkill {
    SharedSkill {
        name: slug.into(),
        local_path: ctx.canonical(slug).to_string_lossy().into_owned(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "builtin".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: format!("skills/{slug}"),
            git_ref: "main".into(),
        },
        last_pushed_sha: "abc".into(),
        content_hash: "hash".into(),
    }
}

/// 🔴 **存量孤儿必须放行**(v6 任务 3 修复轮 1,本用例从"拒绝"改成"放行")。
///
/// 老版本的 `adopt_into_management`、以及修复之前的移除流程,都会在 `state.shared` 里
/// 留下指向已不存在目录的记账。create 原先拿它拒绝同名新建:「这个名字已经被一个
/// 分享过的技能占用了」——而那个技能本地已经不在了,**「占用」是假话**,用户被堵在
/// 一条永久的死路上(v5 收尾时用户明确反对过"把已经做过的事做成死路")。
///
/// "有没有被占用"的判据只有一个:磁盘上真的有没有东西。本体不在 = 没被占用。
#[test]
fn a_stale_shared_record_no_longer_blocks_a_new_skill_of_the_same_name() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    let mut state = State::default();
    state.shared.push(shared_record_pointing_at(&ctx, "weekly-report"));
    ctx.store.save_state(&state).unwrap();
    assert!(!ctx.canonical("weekly-report").exists(), "前提:本体确实不在了");

    create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周汇总"),
    )
    .expect("本体已经不在,不该有什么被「占用」");

    assert!(
        ctx.canonical("weekly-report").join("SKILL.md").is_file(),
        "放行了就要真的把文件建出来"
    );
}

/// 对照组:分享过、而且**本体确实还在**的同名技能,照旧拒绝。
///
/// 没有这一条,把撞名判据整个删掉也能让上面那条通过。
///
/// 顺带说明一件事:这一档拒它的是"目录里有东西",不是任何一本账
/// ——`state.shared` 那条判据已经删掉了(见 `create.rs` 的注释),
/// 它在本体还在时从来轮不到、在本体不在时是假话。
#[test]
fn a_shared_skill_whose_files_are_still_here_is_still_refused() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    let mut state = State::default();
    state.shared.push(shared_record_pointing_at(&ctx, "weekly-report"));
    ctx.store.save_state(&state).unwrap();
    // 本体还在
    std::fs::create_dir_all(ctx.canonical("weekly-report")).unwrap();
    std::fs::write(ctx.canonical("weekly-report").join("SKILL.md"), "原来的内容\n").unwrap();

    let err = create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周汇总"),
    )
    .unwrap_err();

    assert_eq!(err.code, "CONFLICT_NAME_TAKEN");
    assert_eq!(
        std::fs::read_to_string(ctx.canonical("weekly-report").join("SKILL.md")).unwrap(),
        "原来的内容\n",
        "拒绝时一个字节都不该动"
    );
}

/// 空目录放行:写 SKILL.md 失败(磁盘满 / 权限)会留下一个空壳,
/// 一律拒就等于同一个名字再也建不成。空目录里没有任何东西会被毁。
#[test]
fn allows_reusing_an_empty_leftover_directory() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    std::fs::create_dir_all(ctx.canonical("weekly-report")).unwrap();

    create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周汇总"),
    )
    .expect("空目录应当可以复用");

    assert!(ctx.canonical("weekly-report").join("SKILL.md").is_file());
}

// ============================================================ 表单校验

#[test]
fn refuses_slugs_that_would_be_silently_renamed() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);

    // 这几个 Installer::canonical_dir 都会**静默清洗**成别的名字:
    // 远端来的目录名那样处理是对的,用户亲手填的不行
    for slug in ["a--b", "trail-", "-lead", "Weekly", "周报", "unnamed-skill", ""] {
        let err = create::create_skill(&installer, &ctx.store, &req(slug, "名称", "说明"))
            .unwrap_err();
        assert_eq!(err.code, "FS_UNUSABLE_NAME", "slug {slug:?} 应当被拒");
    }
    // 一个目录都不该建出来
    let skills_dir = join_rel(&ctx.home, ".agents/skills");
    assert!(
        !skills_dir.exists() || std::fs::read_dir(&skills_dir).unwrap().next().is_none(),
        "被拒的 slug 不该在磁盘上留下痕迹"
    );
}

#[test]
fn refuses_blank_display_name_or_description() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);

    // 全空白与只有换行都算空——sanitize_metadata 会把换行折成空格,trim 后为空
    for (name, description) in [("   ", "说明"), ("名称", "  \n "), ("", "")] {
        let err = create::create_skill(&installer, &ctx.store, &req("ok-name", name, description))
            .unwrap_err();
        assert_eq!(err.code, "FS_UNUSABLE_NAME");
    }
    assert!(!ctx.canonical("ok-name").exists());
}

#[test]
fn missing_home_reports_an_error_instead_of_panicking() {
    let (ctx, _env) = ctx();
    let no_home = NoHomeEnv;
    let installer = Installer::new(&ctx.registry, &no_home);

    let err = create::create_skill(
        &installer,
        &ctx.store,
        &req("weekly-report", "周报生成", "每周汇总"),
    )
    .unwrap_err();
    assert_eq!(err.code, "FS_NO_HOME");
}

/// 「我的技能」第三档的过滤条件(M4 任务 6a):canonical 里的本地技能。
///
/// commands::installed_list 就是拿这两个条件从 `scan_candidates` 里挑第三档。
/// agent 目录下的实体目录**不算**——那些归分享页收编,在「我的技能」里摆出来
/// 会让用户以为它已经归本 app 管了。
#[test]
fn local_tier_filter_picks_the_new_skill_but_not_agent_dir_ones() {
    let (ctx, env) = ctx();
    let installer = Installer::new(&ctx.registry, &env);
    create::create_skill(&installer, &ctx.store, &req("my-draft", "我的草稿", "还没写完"))
        .unwrap();

    // 另放一个在 agent 目录里(模拟别的工具装的实体目录)
    let claude = join_rel(&ctx.home, ".claude/skills/theirs");
    std::fs::create_dir_all(&claude).unwrap();
    std::fs::write(claude.join("SKILL.md"), "---\nname: 别人的\ndescription: x\n---\n正文\n")
        .unwrap();

    let state = ctx.store.load_state().unwrap().value;
    let tier: Vec<String> = share::scan_candidates(&ctx.registry, &env, &state, &Default::default(), &Default::default())
        .unwrap()
        .into_iter()
        .filter(|c| c.in_canonical && c.origin == share::CandidateOrigin::Local)
        .map(|c| c.dir_name)
        .collect();

    assert_eq!(tier, vec!["my-draft".to_string()]);
}
