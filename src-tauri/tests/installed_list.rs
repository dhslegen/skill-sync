//! 「我的技能」列表编排(`core::my_skills::build`,v6 任务 2)的集成测试。
//!
//! 与 `tests/plaza_ensure_repo.rs` 同一种姿势(见该文件模块头):`commands::installed_list`
//! 依赖真实 `HOME`(`app_store()`),这个仓库一贯不直接单测这类"薄壳"——真正的编排
//! 逻辑已经下沉到 `core::my_skills::build`,这里用注入的 `Store` + 临时 HOME 原样复演。
//!
//! 三个场景对应设计文档「三路合并」的三档:
//! - A:`state.installed` 里的记账,canonical 目录还在,索引缓存里查不到作者
//!   ——`relation == installed`(不管有没有登录,state.installed 强制 `in_library=true`,
//!   但作者未知就落在"installed"这一档)。
//! - B:canonical 目录下的实体目录(有 SKILL.md),没有 `state.installed` 记账,
//!   `.skill-lock.json` 里有条目(装自别的工具),索引缓存里作者是「我」
//!   ——登录后 `relation == shared && local_present`,登出后退化成 `installed`。
//! - C:只在索引缓存里、这台电脑没有本体、作者是「我」
//!   ——登录后 `relation == shared && !local_present`,登出后**整行都不出现**。
//! - D:只在索引缓存里、这台电脑没有本体、**作者是别人**——任何时候都不出现。
//!   D 是 C 的**对照组**,不是可有可无的补充:没有它,"未登录"与"作者是别人"
//!   在这份 fixture 里取了同值(全是作者是我的技能),第三档那道闸门
//!   `relation != Shared` 换成 `identity.is_none()` 照样全绿——本项目记录的
//!   空转测试模式 ③(fixture 让两个不同概念取了同值)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::my_skills;
use skillsync_lib::core::ownership::{Identity, Relation};
use skillsync_lib::core::registry;
use skillsync_lib::core::skill_lock::{self, LockEntry};
use skillsync_lib::core::state::{Config, InstalledSkill, SkillSource, State, Store};
use skillsync_lib::core::store::{self, IndexedSkill, SkillAttribution, SkillFile, StoreIndex};

const NOW: &str = "2026-08-23T00:00:00.000Z";

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
    env: TmpEnv,
    registry: AgentRegistry,
    store: Store,
    builtin: registry::BuiltinSource,
    /// 🔴 **绝不用默认的 `SYSTEM_TRASH`**(修复轮 1 I-2):`build` 眼下只读,
    /// 但不注入沙盒的话,"扫描之后废纸篓里什么都没有"这半断言**根本写不出来**
    /// ——而那正是"发现是只读的"这条承诺里最容易破、也最贵的一半。
    /// 与 `tests/converge_flow.rs` 同一姿势。
    sandbox: skillsync_lib::core::fsops::SandboxTrash,
}

impl Ctx {
    fn canonical(&self, slug: &str) -> PathBuf {
        self.home.join(".agents/skills").join(slug)
    }
}

fn write_skill_md(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: 测试技能\ndescription: 用于测试\n---\n正文\n")
        .unwrap();
}

fn ctx() -> Ctx {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone(), vars: HashMap::new() };
    let store = Store::new(home.join(".skillsync"));
    let builtin = registry::BuiltinSource {
        base_url: Some("http://gitea.internal:3000"),
        repo: Some(("skills", "skills")),
        branch: "main",
    };
    let sandbox = skillsync_lib::core::fsops::SandboxTrash::new(home.join(".test-trash"));
    Ctx {
        _tmp: tmp,
        home,
        env,
        registry: AgentRegistry::builtin(),
        store,
        builtin,
        sandbox,
    }
}

fn me() -> Identity {
    Identity { login: "zhaowh".into(), display_name: "赵文浩".into() }
}

fn indexed_skill(dir_slug: &str, author: Option<&str>) -> IndexedSkill {
    IndexedSkill {
        name: dir_slug.into(),
        dir_slug: dir_slug.into(),
        description: "测试技能".into(),
        path: format!("skills/{dir_slug}"),
        skill_md: String::new(),
        files: vec![SkillFile { path: "SKILL.md".into(), size: Some(1) }],
        has_scripts: false,
        content_hash: String::new(),
        tags: Vec::new(),
        attribution: author.map(|a| SkillAttribution { author: a.into(), contributors: Vec::new() }),
    }
}

/// 往 `registry::BUILTIN_REGISTRY_ID`("company")的 `skills/skills` 索引缓存里
/// 写入若干技能(B、C 的作者信息都从这里来)。
fn write_index_cache(ctx: &Ctx, skills: Vec<IndexedSkill>) {
    let repo = skillsync_lib::core::gitea::RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    };
    let path = store::cache_path(ctx.store.dir(), registry::BUILTIN_REGISTRY_ID, &repo);
    let index = StoreIndex {
        schema_version: store::INDEX_SCHEMA_VERSION,
        registry_id: registry::BUILTIN_REGISTRY_ID.into(),
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
        commit_sha: "abc1111".into(),
        committed_at: NOW.into(),
        fetched_at: 0,
        skills,
        skipped: Vec::new(),
        curated: Vec::new(),
    };
    store::save_cache(&path, &index).unwrap();
}

fn lock_entry_gitea(source: &str) -> LockEntry {
    LockEntry {
        source: source.into(),
        source_type: "gitea".into(),
        source_url: "http://gitea.internal:3000/skills/skills".into(),
        git_ref: None,
        skill_path: None,
        skill_folder_hash: String::new(),
    }
}

fn lock_entry_git(url: &str) -> LockEntry {
    LockEntry {
        source: url.into(),
        source_type: "git".into(),
        source_url: url.into(),
        git_ref: None,
        skill_path: None,
        skill_folder_hash: String::new(),
    }
}

fn build(ctx: &Ctx, config: &Config, state: &State) -> Vec<my_skills::InstalledRow> {
    let installer = Installer::new(&ctx.registry, &ctx.env).with_trasher(&ctx.sandbox);
    my_skills::build(&installer, &ctx.registry, &ctx.env, &ctx.store, &ctx.builtin, config, state)
        .unwrap()
}

fn row<'a>(rows: &'a [my_skills::InstalledRow], dir_slug: &str) -> &'a my_skills::InstalledRow {
    rows.iter().find(|r| r.dir_slug == dir_slug).unwrap_or_else(|| {
        panic!("期望能找到 {dir_slug},实际列表:{:?}", rows.iter().map(|r| &r.dir_slug).collect::<Vec<_>>())
    })
}

/// 完整场景:A(state.installed)、B(canonical 实体目录 + lock 条目、索引作者是我)、
/// C(只在索引缓存里、本地没有、作者是我),登录后三档各自的 relation/local_present/
/// source_label 都对。
#[test]
fn three_way_merge_relation_and_source_label_when_signed_in() {
    let ctx = ctx();

    // A:state.installed 记账,canonical 目录还在,索引缓存里没有它(作者未知)。
    write_skill_md(&ctx.canonical("installed-skill"));
    let mut state = State::default();
    state.installed.push(InstalledSkill {
        name: "installed-skill".into(),
        source: SkillSource {
            registry_id: registry::BUILTIN_REGISTRY_ID.into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/installed-skill".into(),
            git_ref: "abc1111".into(),
        },
        commit_sha: "abc1111".into(),
        content_hash: "deadbeef".into(),
        origin: Some("acquired".into()),
        body: None,
        agents: Vec::new(),
        links: Vec::new(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    ctx.store.save_state(&state).unwrap();

    let lock_path = skill_lock::lock_path(&ctx.env).unwrap();
    skill_lock::upsert(&lock_path, "installed-skill", &lock_entry_gitea("skills/skills"), NOW);

    // B:canonical 有本体、没有 state.installed 记账,lock 里是 git 型条目
    // (装自别的工具),索引缓存里作者是我。
    write_skill_md(&ctx.canonical("shared-present"));
    skill_lock::upsert(
        &lock_path,
        "shared-present",
        &lock_entry_git("http://g.internal:3000/skills/skills.git"),
        NOW,
    );

    // C:索引缓存里作者是我,这台电脑没有本体,也没有 lock 条目。
    // D:同样只在索引缓存里,但作者是别人——第三档的对照组(见模块头)。
    write_index_cache(
        &ctx,
        vec![
            indexed_skill("shared-present", Some("赵文浩")),
            indexed_skill("library-only", Some("赵文浩")),
            indexed_skill("library-only-by-someone-else", Some("李四")),
        ],
    );

    let mut config = Config::default();
    config.identities.insert(registry::BUILTIN_REGISTRY_ID.into(), me());

    let rows = build(&ctx, &config, &state);

    // 🔴 **行数是承重断言**(修复轮 2,复审探针实测):`row()` 用 `.find()` 取**首个**
    // 匹配,没有这一句的话"同一个技能重复成两行"完全测不出来——去掉第 2/3 源里那句
    // `seen_keys.insert(key)`,`shared-present` 会既出现在第 2 源、又被第 4 源当成
    // "这台电脑上没有"再摆一行,而所有既有断言照样全绿。
    assert_eq!(
        rows.len(),
        3,
        "A/B/C 各一行,一行都不许重复:{:?}",
        rows.iter().map(|r| (&r.dir_slug, r.local_present)).collect::<Vec<_>>()
    );

    let a = row(&rows, "installed-skill");
    assert_eq!(a.relation, Relation::Installed);
    assert!(a.local_present);
    assert_eq!(a.source_label.as_deref(), Some("skills/skills"), "A 的来源应归一化成 skills/skills");

    let b = row(&rows, "shared-present");
    assert_eq!(b.relation, Relation::Shared);
    assert!(b.local_present);
    assert_eq!(
        b.source_label.as_deref(),
        Some("skills/skills"),
        "B 是 git 型 lock 条目,来源应从 URL 解析成 skills/skills"
    );

    let c = row(&rows, "library-only");
    assert_eq!(c.relation, Relation::Shared);
    assert!(!c.local_present, "C 这台电脑上没有本体");
    assert_eq!(c.source_label, None, "C 没有 lock 条目,不摆来源");
    // 🔴 承重断言(修复轮 1):C 档唯一的存在理由是"换电脑/数据丢"场景,
    // 主动作是「取回」,取回要带库坐标——正面断言等于索引缓存里的那对
    // owner/repo,不能只断言"非空",分不出填对了还是填错了库。
    assert_eq!(c.registry_id, registry::BUILTIN_REGISTRY_ID);
    assert_eq!(c.source_owner, "skills", "C 的取回坐标必须是它实际所在库的 owner");
    assert_eq!(c.source_repo, "skills", "C 的取回坐标必须是它实际所在库的 repo");

    // 🔴 D 是第三档闸门的对照组:**已登录**,但库里记的作者是别人。既不在这台
    // 电脑上、又不是我分享的技能,没有任何理由出现在「我的技能」里。
    // 这条断言与下面 signed_out 那条合起来,才把闸门的判据钉成
    // "作者是不是我"而不是"有没有登录"。
    assert!(
        rows.iter().all(|r| r.dir_slug != "library-only-by-someone-else"),
        "D 在库里但作者是别人,本地也没有本体,不该出现在列表里"
    );
}

/// 未登录(或身份被清空):B 退化成 installed(它仍是真实存在的本地目录,不会消失);
/// C 因为"既不在本地、又不是我分享的"而**整行不出现**。
#[test]
fn signed_out_downgrades_b_and_drops_c() {
    let ctx = ctx();

    write_skill_md(&ctx.canonical("installed-skill"));
    let mut state = State::default();
    state.installed.push(InstalledSkill {
        name: "installed-skill".into(),
        source: SkillSource {
            registry_id: registry::BUILTIN_REGISTRY_ID.into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/installed-skill".into(),
            git_ref: "abc1111".into(),
        },
        commit_sha: "abc1111".into(),
        content_hash: "deadbeef".into(),
        origin: Some("acquired".into()),
        body: None,
        agents: Vec::new(),
        links: Vec::new(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    ctx.store.save_state(&state).unwrap();

    write_skill_md(&ctx.canonical("shared-present"));
    write_index_cache(
        &ctx,
        vec![
            indexed_skill("shared-present", Some("赵文浩")),
            indexed_skill("library-only", Some("赵文浩")),
            indexed_skill("library-only-by-someone-else", Some("李四")),
        ],
    );

    // 未登录:identities 是空的
    let config = Config::default();

    let rows = build(&ctx, &config, &state);

    let a = row(&rows, "installed-skill");
    assert_eq!(a.relation, Relation::Installed);

    let b = row(&rows, "shared-present");
    assert_eq!(b.relation, Relation::Installed, "未登录时 B 应退化成 installed,而不是消失");
    assert!(b.local_present);

    assert!(
        rows.iter().all(|r| r.dir_slug != "library-only"),
        "C 既不在本地、未登录又判不出是不是我分享的,不该出现在列表里"
    );
    assert!(
        rows.iter().all(|r| r.dir_slug != "library-only-by-someone-else"),
        "D 作者是别人,未登录时同样不该出现"
    );
}


// ============================================================ v6 二期任务 5 的补充装置

/// 在 `home` 之下按相对路径造一个技能目录,frontmatter 的 `name` 取**叶子名**,
/// `description` 非空(所以默认是"可以分享"的形状),正文用 `content` 区分版本。
fn skill_dir(home: &Path, rel: &str, content: &str) -> PathBuf {
    let leaf = rel.rsplit('/').next().unwrap().to_string();
    skill_dir_named(home, rel, &leaf).tap_write(content)
}

/// 同上,但 frontmatter 的 `name` 由调用方指定(用来造 `name != 文件夹名` 那一档)。
fn skill_dir_named(home: &Path, rel: &str, name: &str) -> PathBuf {
    let dir = home.join(rel);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: 用于测试\n---\n正文\n"),
    )
    .unwrap();
    dir
}

/// `skill_dir` 用的小尾巴:往正文里写一段可区分的内容。
trait TapWrite {
    fn tap_write(self, content: &str) -> PathBuf;
}
impl TapWrite for PathBuf {
    fn tap_write(self, content: &str) -> PathBuf {
        let raw = std::fs::read_to_string(self.join("SKILL.md")).unwrap();
        std::fs::write(self.join("SKILL.md"), format!("{raw}{content}\n")).unwrap();
        self
    }
}

/// 整棵 home 的内容快照:(相对路径, 内容)。用来正面断言"扫描/构建没有写盘"。
fn snapshot(home: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            let meta = std::fs::symlink_metadata(&p).unwrap();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
            if meta.is_dir() {
                out.push((format!("{rel}/"), Vec::new()));
                walk(root, &p, out);
            } else if meta.is_symlink() {
                out.push((format!("{rel}@"), std::fs::read_link(&p).unwrap().to_string_lossy().into_owned().into_bytes()));
            } else {
                out.push((rel, std::fs::read(&p).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(home, home, &mut out);
    out.sort();
    out
}

fn tool_state(row: &my_skills::InstalledRow, agent: &str) -> Option<my_skills::ToolState> {
    row.tools.iter().find(|t| t.agent == agent).map(|t| t.state)
}

fn installed_record(name: &str, path: &str, content_hash: &str) -> InstalledSkill {
    InstalledSkill {
        name: name.into(),
        source: SkillSource {
            registry_id: registry::BUILTIN_REGISTRY_ID.into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: path.into(),
            git_ref: "abc1111".into(),
        },
        commit_sha: "abc1111".into(),
        content_hash: content_hash.into(),
        origin: Some("acquired".into()),
        body: None,
        agents: Vec::new(),
        links: Vec::new(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

/// 第 2 源:本体住在**工具目录**里(用户在 `~/.claude/skills/` 下开发技能),
/// 没有任何记账。它必须出现在这一页上,`body` 指向真实位置,`tools` 里
/// claude-code 是 `Body`、没启用过的 trae 是 `Off`,并且**没有记账基线**。
#[test]
fn tool_dir_bodies_appear_with_body_path_tools_and_no_baseline() {
    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".claude/skills/s", "v1");

    let rows = build(&ctx, &Config::default(), &State::default());
    let r = row(&rows, "s");

    assert_eq!(r.body, body.to_string_lossy(), "本体就住在用户开发它的那个目录里");
    assert_eq!(r.content_hash, "", "无账无基线");
    assert!(!r.local_hash.is_empty(), "实时指纹照样要算得出来(R4)");
    assert!(!r.local_modified, "没有基线就无从判断改没改过,不能误报");
    assert!(r.local_present);
    assert_eq!(r.relation, Relation::Draft, "库里没有它、本地有本体 = 草稿");
    assert_eq!(tool_state(r, "claude-code"), Some(my_skills::ToolState::Body));
    assert_eq!(tool_state(r, "trae"), Some(my_skills::ToolState::Off));
    assert!(r.versions.is_empty(), "只有一份实体,没有版本要拍板");
    assert_eq!(r.share_blocked, None, "名字与描述都合标准,可以分享");
}

/// R27:**无记账但库里有同名条目的行,必须带上来源坐标**。
///
/// 🔴 这一档的坐标只有一个来源——库里那条索引条目。丢掉它的后果不在 core 里,
/// 而在前端:`lib/ownership.ts` 的第 4 档(无安装基线)靠 `localEqualsRemote`
/// 分 `synced` / `differs`,而那个函数开头有一道**坐标闸**(防止拿另一个库的
/// 索引去比)。坐标是空串就必然不等 → 恒返回 `null` → **`synced` 那个出口在
/// 真实数据上永远走不到**,每一个内容其实逐字节一致的无记账技能都会显示
/// 「本地和库里不一样」。那正是 v6 二期的旗舰场景(在 `~/.claude/skills/` 下
/// 开发、经 git 直推进库),对它说假话是这个项目最忌讳的失败模式。
///
/// 另外两个受害者同根:`pull` 与 `confirmShare` 都按这三个字段定位去处,
/// 空串会让它们缺省打到**内建源主库**。
#[test]
fn a_row_without_an_account_still_carries_the_library_coordinates() {
    let ctx = ctx();
    skill_dir(&ctx.home, ".claude/skills/s", "v1");
    write_index_cache(&ctx, vec![indexed_skill("s", Some("赵文浩"))]);
    let mut config = Config::default();
    config.identities.insert(registry::BUILTIN_REGISTRY_ID.into(), me());

    let rows = build(&ctx, &config, &State::default());
    let r = row(&rows, "s");

    assert_eq!(r.relation, Relation::Shared, "库里记的分享者是我");
    assert_eq!(r.content_hash, "", "仍然没有安装基线——坐标与基线是两回事");
    assert_eq!(r.registry_id, registry::BUILTIN_REGISTRY_ID, "来源 registry 必须填");
    assert_eq!(r.source_owner, "skills", "来源 owner 必须填");
    assert_eq!(r.source_repo, "skills", "来源 repo 必须填");
}

/// 上一条的对照组:**库里没有同名条目时坐标保持空串**。
///
/// 那种行 `relation` 恒为 `Draft`(库里没有它),前端在第 2 档就短路了,
/// 根本走不到用坐标的第 4 档——填一个猜出来的坐标反而会让 `pull`/`confirmShare`
/// 把它推向一个与它毫无关系的库。
#[test]
fn a_draft_that_is_not_in_the_library_gets_no_coordinates() {
    let ctx = ctx();
    skill_dir(&ctx.home, ".claude/skills/s", "v1");
    // 索引缓存里是**别的**技能:库存在,但没有这一个
    write_index_cache(&ctx, vec![indexed_skill("other", Some("赵文浩"))]);
    let mut config = Config::default();
    config.identities.insert(registry::BUILTIN_REGISTRY_ID.into(), me());

    let rows = build(&ctx, &config, &State::default());
    let r = row(&rows, "s");

    assert_eq!(r.relation, Relation::Draft, "库里没有它 = 草稿");
    assert_eq!(r.registry_id, "", "草稿没有来源,不许猜一个出来");
    assert_eq!(r.source_owner, "");
    assert_eq!(r.source_repo, "");
}

/// 第 3 源:同名实体在两处、内容不同——**只占一行**,分歧摆进 `versions`
/// (含本体自己,否则用户没法选"就留我现在这份")。
///
/// 🔴 同时正面断言**磁盘一个字节都没动**:发现是只读的,写入一律交给
/// `converge`/`keep_version`(铁律 7 在这一层的落点)。
#[test]
fn differing_copies_merge_into_one_row_with_versions_and_nothing_is_written() {
    let ctx = ctx();
    let claude = skill_dir(&ctx.home, ".claude/skills/s", "v1");
    let canonical = skill_dir(&ctx.home, ".agents/skills/s", "v2");

    let before = snapshot(&ctx.home);
    let rows = build(&ctx, &Config::default(), &State::default());
    assert_eq!(snapshot(&ctx.home), before, "扫描与构建绝不写盘:目录内容必须一字不变");
    // I-2:另一半——**废纸篓里也必须什么都没有**。没有沙盒 trasher 的话这句写不出来。
    assert!(ctx.sandbox.trashed().is_empty(), "发现是只读的:一个字节都不该进废纸篓");
    assert!(!ctx.home.join(".test-trash").exists(), "废纸篓目录本身都不该被建出来");

    assert_eq!(rows.iter().filter(|r| r.dir_slug == "s").count(), 1, "一个技能只占一行");
    let r = row(&rows, "s");
    assert_eq!(r.versions.len(), 2, "两份内容不同的实体都要摆出来给用户拍板");
    let paths: Vec<&str> = r.versions.iter().map(|v| v.path.as_str()).collect();
    assert!(paths.contains(&canonical.to_string_lossy().as_ref()));
    assert!(
        paths.contains(&claude.to_string_lossy().as_ref()),
        "本体自己必须在选项里,否则「就留我现在这份」没法选"
    );
}

/// 内容**相同**的第二份不是"另一个版本",是待收成链接的重复品——不该摆进 `versions`
/// (摆了等于让用户在两个一模一样的东西之间做一次没有意义的选择)。
#[test]
fn identical_copies_are_not_offered_as_a_version_choice() {
    let ctx = ctx();
    skill_dir(&ctx.home, ".claude/skills/s", "same");
    skill_dir(&ctx.home, ".agents/skills/s", "same");

    let rows = build(&ctx, &Config::default(), &State::default());
    let r = row(&rows, "s");
    assert!(r.versions.is_empty(), "内容一样就没有版本分歧");
}

/// 分享前的标准校验逐行给出:`name != 文件夹名` 这一档(广场实测 47 个里 8 个)。
#[test]
fn share_block_is_reported_per_row() {
    let ctx = ctx();
    skill_dir_named(
        &ctx.home,
        ".agents/skills/react-best-practices",
        "vercel-react-best-practices",
    );

    let rows = build(&ctx, &Config::default(), &State::default());
    assert_eq!(
        row(&rows, "react-best-practices").share_blocked,
        Some(skillsync_lib::core::skills::ShareBlock::NameMismatch)
    );
}

/// 🔴 同轴缺陷 ①:**尺子是 `home.body`,不是 canonical**。
///
/// 本体住在 `~/.claude/skills/` 且 canonical 链接**根本没建成**(建链失败、
/// 或用户把它删了)时,这一行必须照样在——按 canonical 判的话整行会从页面上
/// 消失,用户看着技能装上了却连移除入口都没有。`local_modified` 同理:
/// 按 canonical 算在 Windows 降级复制那一档会漏报。
#[test]
fn rows_and_local_modified_follow_the_body_not_canonical() {
    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".claude/skills/x", "v1");
    let hash = skillsync_lib::core::fsops::dir_content_hash(&body).unwrap();

    let mut state = State::default();
    let mut rec = installed_record("x", "skills/x", &hash);
    rec.body = Some(body.to_string_lossy().into_owned());
    state.installed.push(rec);
    ctx.store.save_state(&state).unwrap();

    assert!(!ctx.canonical("x").exists(), "现场前提:canonical 链接不存在");

    let rows = build(&ctx, &Config::default(), &state);
    let r = row(&rows, "x");
    assert_eq!(r.body, body.to_string_lossy());
    assert_eq!(r.local_hash, hash, "实时指纹算的是本体,不是 canonical");
    assert!(!r.local_modified, "内容与基线一致");

    // 改本体 → 必须报"改过了"(按 canonical 算的话这里恒为 false)
    std::fs::write(body.join("SKILL.md"), "---\nname: x\ndescription: 用于测试\n---\n改过了\n").unwrap();
    let rows = build(&ctx, &Config::default(), &state);
    assert!(row(&rows, "x").local_modified, "改过本体就要如实报出来");
}

/// 🔴 同轴缺陷 ②:发给前端的 `dir_slug` 是**技能库里的原始目录名**,
/// 不是清洗过的记账名。
///
/// fixture 刻意用大写目录名 `Weekly-Report`:全小写现场里记账名与库里目录名
/// 恰好相同,两把尺子的差别整个测没了(本项目记录的空转模式 ③)。
/// 承重断言有两条,缺一不可:①`dir_slug` 本身;②作者查索引也走这把尺子
/// ——查错了作者就查不到,`relation` 会从「我分享的」退成「我安装的」。
#[test]
fn dir_slug_and_author_lookup_use_the_library_directory_name() {
    let ctx = ctx();
    // 记账名是清洗后的(sanitize 会小写化),canonical 目录同名
    write_skill_md(&ctx.canonical("weekly-report"));
    let mut state = State::default();
    state.installed.push(installed_record(
        "weekly-report",
        "skills/Weekly-Report",
        "deadbeef",
    ));
    ctx.store.save_state(&state).unwrap();

    // 索引缓存按**库里的原始目录名**建键
    write_index_cache(&ctx, vec![indexed_skill("Weekly-Report", Some("赵文浩"))]);
    let mut config = Config::default();
    config.identities.insert(registry::BUILTIN_REGISTRY_ID.into(), me());

    let rows = build(&ctx, &config, &state);
    let r = row(&rows, "Weekly-Report");
    assert_eq!(r.dir_slug, "Weekly-Report", "商店索引按这把尺子建键,hasUpdate 才对得上");
    assert_eq!(
        r.relation,
        Relation::Shared,
        "作者也要按库里的原始目录名查——查错了「我分享的」就变成「我安装的」"
    );
}

/// 🔴 同轴缺陷 ③:工具目录里**手建**的大写目录必须被发现。
///
/// `scan_all` 原先按字面名分组、`locate` 按清洗名查,这个目录永远发现不了。
/// 附带钉住两件事:①本体叶子名**保持字面**(不改名不搬家);
/// ②它诚实地报 `DirFormat`——app 不替用户改名,但要告诉他哪不合标准。
#[test]
fn a_hand_made_uppercase_directory_in_a_tool_dir_is_discovered() {
    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".claude/skills/Weekly-Report", "v1");

    let rows = build(&ctx, &Config::default(), &State::default());
    let r = row(&rows, "Weekly-Report");
    assert_eq!(r.body, body.to_string_lossy(), "本体住在原地,叶子名一个字符不改");
    assert_eq!(tool_state(r, "claude-code"), Some(my_skills::ToolState::Body));
    assert_eq!(
        r.share_blocked,
        Some(skillsync_lib::core::skills::ShareBlock::DirFormat),
        "大写文件夹名不合 Agent Skills 标准,分享要拦下并说清楚"
    );
}

/// 🔴 R10:**空来源的记账既不是「来源已移除」也不是「库不在源里」**——
/// 它从来就没有来源(`converge::keep_version`/`set_agents` 给纯本地技能建的
/// `adopted` 账,三个坐标字段都是空串)。两句话对它都不成立,说哪句都是假话。
#[test]
fn an_adopted_account_without_a_source_is_not_reported_as_removed() {
    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".claude/skills/local-one", "v1");

    let mut state = State::default();
    state.installed.push(InstalledSkill {
        name: "local-one".into(),
        source: SkillSource {
            registry_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            path: String::new(),
            git_ref: String::new(),
        },
        commit_sha: String::new(),
        content_hash: skillsync_lib::core::fsops::dir_content_hash(&body).unwrap(),
        origin: Some("adopted".into()),
        body: Some(body.to_string_lossy().into_owned()),
        agents: vec!["claude-code".into()],
        links: Vec::new(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    ctx.store.save_state(&state).unwrap();

    let rows = build(&ctx, &Config::default(), &state);
    let r = row(&rows, "local-one");
    assert!(!r.source_removed, "它从来就没有来源,说「来源已移除」是假话");
    assert!(!r.library_removed, "同上,说「技能库不在源的列表里」也是假话");
    assert_eq!(
        r.relation,
        Relation::Draft,
        "空来源账压根没经过任何技能库,in_library 硬填 true 会把手写草稿判成「我安装的」"
    );
}

/// `tools` 的成员口径(修复轮 1 R19 之后):**建链会碰到的 + 本体所在的那个**。
///
/// 这条现场里本体住 `~/.claude/skills/`(claude-code,非 universal),所以并集的
/// 第二半没有引入任何额外 agent——正好把第一半单独钉住:
/// - universal agent(cursor/codex/cline/zed/warp…)不该出现:`link_targets` 按设计
///   跳过它们,勾了什么也不会发生,摆出来就是**永远点不亮的死勾**;
/// - canonical 自身也不该出现:它永不作为建链目标,否则"取消关联"等于删本体。
///
/// 本体**恰好住在** universal 工具目录里的那一档,由下面那条测试单独钉。
#[test]
fn tools_only_lists_agents_that_linking_would_actually_touch() {
    let ctx = ctx();
    skill_dir(&ctx.home, ".claude/skills/s", "v1");

    let rows = build(&ctx, &Config::default(), &State::default());
    let r = row(&rows, "s");
    let names: Vec<&str> = r.tools.iter().map(|t| t.agent.as_str()).collect();

    for needs_link in ["claude-code", "trae", "trae-cn", "zencoder"] {
        assert!(names.contains(&needs_link), "{needs_link} 需要建链,必须有一个勾");
    }
    // universal:落 canonical 即可见(cursor/codex 的全局目录并不是 canonical,
    // 所以这条**不是** "dir != canonical" 那一条的重复)
    for universal in ["cursor", "codex", "universal", "cline", "zed", "warp"] {
        assert!(
            !names.contains(&universal),
            "{universal} 是 universal agent,勾了什么也不会发生,不该摆出来"
        );
    }
    assert!(!names.is_empty());
    // 账上那份名单是"期望态",不是勾的真相——这里连一条记账都没有,勾照样算得出来
    assert!(r.agents.is_empty());
}

/// 健康的链接显示 `Linked`;账上有这个目录、磁盘上却对不上账的显示 `Missing`
/// ——**绝不因为账上写着就显示成已启用**,那是撒谎。
#[test]
fn tool_state_comes_from_disk_not_from_the_account() {
    use skillsync_lib::core::fsops;

    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".agents/skills/s", "v1");

    // claude-code:真的建一条链接过去
    let claude_dir = ctx.home.join(".claude/skills");
    std::fs::create_dir_all(&claude_dir).unwrap();
    fsops::link_dir(&body, &claude_dir.join("s"), fsops::default_link_chain()).unwrap();

    // trae:账上记着,磁盘上什么都没有(建链失败 / 被别的工具删了)
    let trae_dir = ctx.home.join(".trae/skills");

    let mut state = State::default();
    let mut rec = installed_record("s", "skills/s", &fsops::dir_content_hash(&body).unwrap());
    rec.links = vec![
        skillsync_lib::core::state::LinkRecord {
            dir: claude_dir.to_string_lossy().into_owned(),
            mode: "symlink".into(),
        },
        skillsync_lib::core::state::LinkRecord {
            dir: trae_dir.to_string_lossy().into_owned(),
            mode: "symlink".into(),
        },
    ];
    state.installed.push(rec);
    ctx.store.save_state(&state).unwrap();

    let rows = build(&ctx, &Config::default(), &state);
    let r = row(&rows, "s");
    assert_eq!(tool_state(r, "claude-code"), Some(my_skills::ToolState::Linked));
    assert_eq!(
        tool_state(r, "trae"),
        Some(my_skills::ToolState::Missing),
        "账上有、磁盘上没有 = 用户以为启用着其实读不到,必须如实说 Missing"
    );
    assert_eq!(tool_state(r, "trae-cn"), Some(my_skills::ToolState::Off), "账上都没有 = 没启用过");
}

/// 序列化形状(前端类型照这个写):断言**键的完整集合**,不是"某个键存在"
/// ——后者区分不了"字段被省略"与"字段名拼错"(本项目记过的空转模式 ②)。
#[test]
fn installed_row_serializes_with_camel_case_keys() {
    let ctx = ctx();
    skill_dir(&ctx.home, ".claude/skills/s", "v1");
    let rows = build(&ctx, &Config::default(), &State::default());
    let value = serde_json::to_value(row(&rows, "s")).unwrap();
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "agents",
            "body",
            "commitSha",
            "contentHash",
            "dirSlug",
            "installedAt",
            "libraryRemoved",
            "links",
            "localHash",
            "localModified",
            "localPresent",
            "registryId",
            "relation",
            "shareBlocked",
            "sourceLabel",
            "sourceOwner",
            "sourceRemoved",
            "sourceRepo",
            "tools",
            "updatedAt",
            "versions",
        ]
    );

    // ToolView / ToolState 的字面量同样是对外契约
    let tools = value["tools"].as_array().unwrap();
    let claude = tools.iter().find(|t| t["agent"] == "claude-code").unwrap();
    let mut tool_keys: Vec<&str> = claude.as_object().unwrap().keys().map(String::as_str).collect();
    tool_keys.sort();
    assert_eq!(tool_keys, vec!["agent", "state"]);
    assert_eq!(claude["state"], serde_json::json!("body"));
}

/// 🔴 同轴缺陷 ③ 在这一页上的可见后果:**同一个技能不许占两行**。
///
/// 记账名是清洗后的 `weekly-report`,而磁盘上的本体目录是字面的
/// `Weekly-Report`。`scan_all` 若按字面名分组,第 2 源的键就与 `seen` 里的
/// 记账键对不上,同一个技能会被摆成两行——一行有账(能移除、能更新),
/// 一行没账(什么都做不了),用户根本分不清该点哪个。
#[test]
fn one_skill_never_takes_two_rows_when_the_directory_name_is_not_lowercase() {
    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".claude/skills/Weekly-Report", "v1");

    let mut state = State::default();
    let mut rec = installed_record(
        "weekly-report",
        "skills/Weekly-Report",
        &skillsync_lib::core::fsops::dir_content_hash(&body).unwrap(),
    );
    rec.body = Some(body.to_string_lossy().into_owned());
    state.installed.push(rec);
    ctx.store.save_state(&state).unwrap();

    let rows = build(&ctx, &Config::default(), &state);
    assert_eq!(
        rows.len(),
        1,
        "同一个技能只占一行,实际:{:?}",
        rows.iter().map(|r| (&r.dir_slug, &r.body)).collect::<Vec<_>>()
    );
    let r = &rows[0];
    assert_eq!(r.dir_slug, "Weekly-Report");
    assert!(!r.content_hash.is_empty(), "留下的那一行必须是有账的那一行(能移除、能更新)");
}

/// 🔴 R19(修复轮 1,审查者探针实测):**本体所在的那个工具必须出现在勾里**,
/// 哪怕它是 universal、`link_targets` 从不碰它。
///
/// 现场:本体住 `~/.cursor/skills/s`。修之前那一行 56 个勾全是 `Off`、
/// **cursor 根本不在勾里、没有任何 `Body`——而 cursor 此刻正读着它**。
/// 产品模型承诺「各个工具里,每个工具一个勾」,本体所在的那个恰恰是最该看见的。
/// `Body` 这一档按既定语义恒勾且不可取消,所以并进来不引入任何死动作。
#[test]
fn the_tool_that_hosts_the_body_is_always_shown_even_if_it_is_universal() {
    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".cursor/skills/s", "v1");

    let rows = build(&ctx, &Config::default(), &State::default());
    let r = row(&rows, "s");
    assert_eq!(r.body, body.to_string_lossy());
    assert_eq!(
        tool_state(r, "cursor"),
        Some(my_skills::ToolState::Body),
        "本体就住在 cursor 的技能目录里,它此刻正读着这个技能"
    );
    // 并集的第一半照旧:建链会碰到的仍然在,别的 universal 仍然不在
    assert_eq!(tool_state(r, "claude-code"), Some(my_skills::ToolState::Off));
    assert_eq!(tool_state(r, "codex"), None, "codex 也是 universal,但本体不在它那儿");
    assert!(r.tools.iter().any(|t| t.state == my_skills::ToolState::Body), "必须有且只有本体那一档是 Body");
    assert_eq!(r.tools.iter().filter(|t| t.state == my_skills::ToolState::Body).count(), 1);
}

/// 🔴 R20(修复轮 1,审查者探针实测):**清洗后撞名、字面名不同的两个文件夹是
/// 两个技能,各占一行**。
///
/// Claude Code 按**字面目录名**调用技能,所以 `Weekly Report` 与 `weekly-report`
/// 的调用名不同 = 两个不同的东西。合并成一行的后果是:app 弹一次"留哪个"、
/// 落选那份进废纸篓——**让用户在两个不同的技能之间二选一**。设计原文那一行写得
/// 很清楚:「不同 + 异名 → 这是两个东西」。
///
/// ⚠️ fixture 里两个字面名必须**真的不同**(空格 vs 连字符),否则这条规则的
/// 两个概念取了同值,改坏了照样绿(本项目记录的空转模式 ③)。
#[test]
fn folders_that_only_collide_after_sanitizing_stay_two_separate_rows() {
    let ctx = ctx();
    let spaced = skill_dir_named(&ctx.home, ".claude/skills/Weekly Report", "Weekly Report");
    let dashed = skill_dir(&ctx.home, ".trae/skills/weekly-report", "另一个技能");

    // 前提:两者清洗后确实同名(否则这条测试测的根本不是撞名)
    assert_eq!(
        skillsync_lib::core::skills::sanitize_name("Weekly Report"),
        skillsync_lib::core::skills::sanitize_name("weekly-report"),
        "fixture 前提:两个字面名清洗后必须撞在一起"
    );

    let before = snapshot(&ctx.home);
    let rows = build(&ctx, &Config::default(), &State::default());
    assert_eq!(snapshot(&ctx.home), before, "只读:一个字节都不该动");
    assert!(ctx.sandbox.trashed().is_empty(), "更不该有东西进废纸篓");

    assert_eq!(rows.len(), 2, "两个不同的技能,两行:{:?}", rows.iter().map(|r| &r.dir_slug).collect::<Vec<_>>());
    let a = row(&rows, "Weekly Report");
    let b = row(&rows, "weekly-report");
    assert_eq!(a.body, spaced.to_string_lossy(), "各自的本体是各自那个文件夹");
    assert_eq!(b.body, dashed.to_string_lossy());
    assert!(
        a.versions.is_empty() && b.versions.is_empty(),
        "它们不是同一个技能的两个副本,绝不能弹「留哪个」让用户销毁其中一个"
    );
    // 字面名可辨:界面要能把冲突说清楚(话术交任务 7,A-3 已拍板由用户在本地改名)
    assert_eq!(a.dir_slug, "Weekly Report");
    assert_eq!(b.dir_slug, "weekly-report");
}

/// R20 的对照组:**字面名相同**的两份(同一个技能在两处)仍然合并成一行。
/// 没有它,把合并判据整个删掉也照样绿——那条规则就是空转的。
#[test]
fn the_same_literal_name_in_two_places_is_still_one_row() {
    let ctx = ctx();
    skill_dir(&ctx.home, ".claude/skills/weekly-report", "v1");
    skill_dir(&ctx.home, ".trae/skills/weekly-report", "v2");

    let rows = build(&ctx, &Config::default(), &State::default());
    assert_eq!(rows.len(), 1, "同一个字面名 = 同一个技能的两个副本,只占一行");
    assert_eq!(rows[0].versions.len(), 2, "内容不同,摆出来让用户拍板留哪份");
}

/// `InstalledSkillView`(IPC DTO 本身)的键完整集合守卫。
///
/// `InstalledRow` 那条守卫钉的是 core 的形状,但**真正发给前端的是这个类型**
/// ——`From` 实现漏搬一个字段、或 DTO 上少写一个 `pub`,core 侧那条测试一个字
/// 都不会红(修复轮 1 Minor)。
#[test]
fn installed_skill_view_serializes_with_the_same_camel_case_keys() {
    let ctx = ctx();
    skill_dir(&ctx.home, ".claude/skills/s", "v1");
    let rows = build(&ctx, &Config::default(), &State::default());
    let row = rows.into_iter().find(|r| r.dir_slug == "s").unwrap();

    let core_keys = {
        let v = serde_json::to_value(&row).unwrap();
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let view = skillsync_lib::commands::InstalledSkillView::from(row);
    let value = serde_json::to_value(&view).unwrap();
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, core_keys, "DTO 与 core 行的键必须逐个对应,From 漏搬一个就在这里红");
    assert_eq!(keys.len(), 21);
}

/// R20 的第二半:**有账那一行的 `versions` 也只跟同字面名的实体比**。
///
/// 上面那条只覆盖了"两边都没账"的形状(第 2/3 源),`literal_group` 这条路
/// 根本没走到——账上那份的版本比对是另一段代码,漏了它的话:作者的
/// `Weekly Report` 一装上账,旁边那个**完全不同的** `weekly-report` 就会被摆进
/// 「留哪个」的选项里,选错一次就把它送进废纸篓。
#[test]
fn an_accounted_row_only_compares_versions_within_its_own_literal_name() {
    let ctx = ctx();
    let body = skill_dir_named(&ctx.home, ".claude/skills/Weekly Report", "Weekly Report");
    let dashed = skill_dir(&ctx.home, ".trae/skills/weekly-report", "另一个完全不同的技能");

    let mut state = State::default();
    // 记账名是清洗后的;本体是那个带空格的字面目录
    let mut rec = installed_record(
        "weekly-report",
        "skills/Weekly-Report",
        &skillsync_lib::core::fsops::dir_content_hash(&body).unwrap(),
    );
    rec.body = Some(body.to_string_lossy().into_owned());
    state.installed.push(rec);
    ctx.store.save_state(&state).unwrap();

    let rows = build(&ctx, &Config::default(), &state);
    assert_eq!(rows.len(), 2, "两个不同的技能:{:?}", rows.iter().map(|r| &r.dir_slug).collect::<Vec<_>>());

    let accounted = rows.iter().find(|r| !r.content_hash.is_empty()).unwrap();
    assert_eq!(accounted.body, body.to_string_lossy());
    assert!(
        accounted.versions.is_empty(),
        "旁边那个 weekly-report 是另一个技能,绝不能摆进「留哪个」的选项里"
    );
    // 🔴 无账那一行的 `body` 必须是**它自己**那个文件夹(修复轮 2,复审探针实测)。
    // `unmanaged_row` 里 `group.contains(body)` 那道闸正是 R20 自己的守卫:去掉它,
    // `locate` 会把账上那份(另一个技能的本体)返回给这一行,于是它的
    // `body`/`local_hash`/`share_blocked`/`tools`/`versions` **全部算自别的技能**
    // ——而只断言 `dir_slug` 与 `content_hash.is_empty()` 的话,这一切照样全绿。
    let unmanaged = rows
        .iter()
        .find(|r| r.dir_slug == "weekly-report")
        .expect("另一个字面名要单独占一行");
    assert!(unmanaged.content_hash.is_empty(), "它没有记账基线");
    assert_eq!(
        unmanaged.body,
        dashed.to_string_lossy(),
        "它的本体是它自己那个文件夹,不是账上那个属于另一个技能的本体"
    );
    assert!(unmanaged.versions.is_empty(), "它只有一份实体,没有版本要拍板");
}

/// 🔴 `literal_group` 的**正向**半(修复轮 2,复审顺着 #18 查出来的):
/// 有账那一行**该提示的时候必须真的提示**「有两个版本」。
///
/// #18 钉的是"比多了"(跨字面组比),这条钉"比少了"——把 `literal_group` 注入成
/// 恒空,`installed_list` 与 `--lib core::my_skills` 当时**全绿**,后果是有账行
/// **永远不提示有两个版本**,用户在两个真实副本之间无从选择。
///
/// 现场与 R20 那条刻意相反:两处的字面名**相同**(同一个技能的两份副本),
/// 内容不同,且有账。
#[test]
fn an_accounted_row_does_offer_versions_when_the_same_literal_name_differs() {
    let ctx = ctx();
    let body = skill_dir(&ctx.home, ".claude/skills/weekly-report", "v1");
    let other = skill_dir(&ctx.home, ".trae/skills/weekly-report", "v2");

    let mut state = State::default();
    let mut rec = installed_record(
        "weekly-report",
        "skills/weekly-report",
        &skillsync_lib::core::fsops::dir_content_hash(&body).unwrap(),
    );
    rec.body = Some(body.to_string_lossy().into_owned());
    state.installed.push(rec);
    ctx.store.save_state(&state).unwrap();

    let rows = build(&ctx, &Config::default(), &state);
    assert_eq!(rows.len(), 1, "字面名相同 = 同一个技能的两份副本,只占一行");
    let r = &rows[0];
    assert!(!r.content_hash.is_empty(), "这一行是有账的那一档(走 literal_group 那条路)");
    assert_eq!(r.versions.len(), 2, "两份内容不同的副本都要摆出来给用户拍板");
    let paths: Vec<&str> = r.versions.iter().map(|v| v.path.as_str()).collect();
    assert!(paths.contains(&body.to_string_lossy().as_ref()), "本体自己必须在选项里");
    assert!(paths.contains(&other.to_string_lossy().as_ref()));
}
