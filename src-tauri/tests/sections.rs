//! 「我的技能」页三区判据(`core::my_skills::in_builtin_library` / `core::ownership::section`,
//! v7 任务 1)的集成测试。
//!
//! 与 `tests/installed_list.rs` 同一种姿势(见该文件模块头):`core::my_skills::build`
//! 才是真正的编排逻辑,这里用注入的 `Store` + 临时 HOME 原样复演,不测
//! `commands::installed_list` 这层依赖真实 `HOME` 的薄壳。
//!
//! 五个场景对应 brief 的三支判据 + 两条对照:
//! - `a_skill_whose_content_matches_the_company_library_is_in_it_even_without_a_record`:
//!   第三支(内容逐字节相同)单独成立,即便**没有** `state.installed` 记账。
//! - `a_same_named_but_different_skill_is_shareable_not_installed_from`:上一条的对照组
//!   ——名字撞上但内容不同,三支都不成立,不许谎称"安装自"。
//! - `a_record_pointing_at_the_company_library_stays_installed_from_after_local_edits`:
//!   第一支(记账直接指向公司库)单独成立,本地改过也不跳区。
//! - `a_skill_installed_from_the_plaza_is_shareable_not_installed_from`:上一条的对照组
//!   ——记账指向的不是公司库(广场),名字/内容都对不上公司库索引,三区只认公司库。
//! - `my_own_shared_skill_lands_in_shared_to`:第二支(公司库索引查得到作者)单独成立,
//!   且作者与登录身份匹配,直接落 `SharedTo`。
//!
//! 内容 hash 的构造方式:测试不手写字面 hash 字符串(那样"HASH1"这个词本身没有意义,
//! 只是两处巧合相等的标签)——[`hash_for_marker`] 用与 [`skill_dir_with_hash`] 完全
//! 相同的写盘逻辑,在一次性 scratch 目录里现算 `fsops::dir_content_hash`,
//! 保证"标记相同 ⇒ 真实 hash 相同、标记不同 ⇒ 真实 hash 不同"这条关系是真的算出来的,
//! 不是凑巧摆对的两个字符串常量。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::my_skills;
use skillsync_lib::core::ownership::{Identity, Section};
use skillsync_lib::core::registry::{self, BUILTIN_REGISTRY_ID};
use skillsync_lib::core::skill_lock::{self, LockEntry};
use skillsync_lib::core::state::{Config, InstalledSkill, SkillSource, State, Store, ORIGIN_ADOPTED};
use skillsync_lib::core::store::{self, IndexedSkill, SkillAttribution, SkillFile, StoreIndex};

/// 把 `"a/b/c"` 这种**字面带斜杠**的相对路径按段 join 到 `base` 上。
/// `Path::join` 会原样保留那个斜杠,Windows 上与 core 分段拼出来的路径字符串不等。
fn join_rel<P: AsRef<Path>>(base: P, rel: &str) -> PathBuf {
    rel.split('/').filter(|s| !s.is_empty()).fold(base.as_ref().to_path_buf(), |p, s| p.join(s))
}

const NOW: &str = "2026-08-27T00:00:00.000Z";

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
    /// 🔴 绝不用默认的 `SYSTEM_TRASH`(同 `tests/installed_list.rs` 的教训):
    /// `build` 只读,但不注入沙盒的话产物会进这台机器真实的废纸篓。
    sandbox: fsops::SandboxTrash,
}

fn me() -> Identity {
    Identity { login: "zhaowenhao".into(), display_name: "赵文浩".into() }
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
    let sandbox = fsops::SandboxTrash::new(home.join(".test-trash"));
    Ctx { _tmp: tmp, home, env, registry: AgentRegistry::builtin(), store, builtin, sandbox }
}

/// 往一个目录里写一份内容由 `marker` 决定的 SKILL.md——[`hash_for_marker`] 与
/// [`skill_dir_with_hash`] 共用这个函数,保证同一个标记在两处产出逐字节相同的内容。
fn write_marked_skill(dir: &Path, marker: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: 测试技能\ndescription: 用于测试\n---\n内容标记: {marker}\n"),
    )
    .unwrap();
}

/// 一个内容标记对应的真实 `fsops::dir_content_hash`——在一次性 scratch 目录里
/// 用与本体完全相同的写入路径现算,而不是手写一个巧合相等的字符串常量。
fn hash_for_marker(marker: &str) -> String {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("scratch");
    write_marked_skill(&dir, marker);
    fsops::dir_content_hash(&dir).unwrap()
}

/// 在 `home` 下的 `rel` 路径写一份内容与 `marker` 对应的技能目录,返回该目录路径。
fn skill_dir_with_hash(home: &Path, rel: &str, marker: &str) -> PathBuf {
    let dir = join_rel(home, rel);
    write_marked_skill(&dir, marker);
    dir
}

fn indexed_skill(dir_slug: &str, author: Option<&str>, content_hash: &str) -> IndexedSkill {
    IndexedSkill {
        name: dir_slug.into(),
        dir_slug: dir_slug.into(),
        description: "测试技能".into(),
        path: format!("skills/{dir_slug}"),
        skill_md: String::new(),
        files: vec![SkillFile { path: "SKILL.md".into(), size: Some(1) }],
        has_scripts: false,
        content_hash: content_hash.into(),
        tags: Vec::new(),
        attribution: author.map(|a| SkillAttribution { author: a.into(), contributors: Vec::new() }),
    }
}

/// 往任意 `(registry_id, owner, repo)` 的索引缓存里写入若干技能——
/// [`write_index_cache`](公司库那一份)与修复轮 1 新增的"自定义源"测试共用这一份实现。
fn write_index_cache_for(ctx: &Ctx, registry_id: &str, owner: &str, repo: &str, skills: Vec<IndexedSkill>) {
    let repo_ref =
        skillsync_lib::core::gitea::RepoRef { owner: owner.into(), repo: repo.into(), branch: "main".into() };
    let path = store::cache_path(ctx.store.dir(), registry_id, &repo_ref);
    let index = StoreIndex {
        schema_version: store::INDEX_SCHEMA_VERSION,
        registry_id: registry_id.into(),
        owner: owner.into(),
        repo: repo.into(),
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

/// 往公司库(`BUILTIN_REGISTRY_ID`,坐标即 `ctx().builtin` 的 `skills/skills`)的索引
/// 缓存里写入若干技能。`entries` = `(dir_slug, marker)`,`content_hash` 用
/// [`hash_for_marker`] 现算,不带作者。
fn write_index_cache(ctx: &Ctx, skills: Vec<IndexedSkill>) {
    write_index_cache_for(ctx, BUILTIN_REGISTRY_ID, "skills", "skills", skills);
}

fn ctx_with_builtin_index(entries: &[(&str, &str)]) -> Ctx {
    let ctx = ctx();
    let skills = entries.iter().map(|(slug, marker)| indexed_skill(slug, None, &hash_for_marker(marker))).collect();
    write_index_cache(&ctx, skills);
    ctx
}

fn ctx_with_builtin_index_and_author(entries: &[(&str, &str, &str)]) -> Ctx {
    let ctx = ctx();
    let skills = entries
        .iter()
        .map(|(slug, marker, author)| indexed_skill(slug, Some(author), &hash_for_marker(marker)))
        .collect();
    write_index_cache(&ctx, skills);
    ctx
}

/// 一条 `state.installed` 记账,内容基线 = `hash_for_marker(marker)`。
///
/// 真实获取会**同时**双写 `state.installed` 与 `.skill-lock.json`(`acquire.rs`
/// 模块头「落盘→预检→落盘→建链→记账+双写」),这里同步补一条 lock 记录——不然
/// `source_label` 这类只从 lock 取数的字段在测试里恒为 `None`,"外源行要能标出来源"
/// 这条断言就成了"lock 是空的所以恰好是 None"的巧合通过,而不是真的算出来的。
fn state_with_record(ctx: &Ctx, dir_slug: &str, registry_id: &str, marker: &str) -> State {
    let mut state = State::default();
    state.installed.push(InstalledSkill {
        name: dir_slug.into(),
        source: SkillSource {
            registry_id: registry_id.into(),
            owner: "owner".into(),
            repo: "repo".into(),
            path: format!("skills/{dir_slug}"),
            git_ref: "sha1".into(),
        },
        commit_sha: "sha1".into(),
        content_hash: hash_for_marker(marker),
        origin: Some("acquired".into()),
        body: None,
        agents: Vec::new(),
        links: Vec::new(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    let lock_path = skill_lock::lock_path(&ctx.env).unwrap();
    skill_lock::upsert(
        &lock_path,
        dir_slug,
        &LockEntry {
            source: format!("{registry_id}/{dir_slug}"),
            source_type: "gitea".into(),
            source_url: format!("http://example.internal/{registry_id}/{dir_slug}"),
            git_ref: None,
            skill_path: None,
            skill_folder_hash: String::new(),
        },
        NOW,
    );
    state
}

/// 一条**空来源**的 `state.installed` 记账(`converge::set_agents`/`keep_version`
/// 给纯本地技能建的 `adopted` 账同款:三个坐标字段都是空串)。`body` 可以显式指定
/// ——真实的 adopted 账把它填成本体的实际路径,不像 [`state_with_record`] 那样
/// 靠 `body: None` 退回 canonical,I2 的回归测试需要这一点(本体住在字面大小写
/// 与记账键不同的工具目录下)。
fn state_with_sourceless_record(dir_slug: &str, body: Option<&Path>, content_hash: &str) -> State {
    let mut state = State::default();
    state.installed.push(InstalledSkill {
        name: dir_slug.into(),
        source: SkillSource {
            registry_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            path: String::new(),
            git_ref: String::new(),
        },
        commit_sha: String::new(),
        content_hash: content_hash.into(),
        origin: Some(ORIGIN_ADOPTED.into()),
        body: body.map(|p| p.to_string_lossy().into_owned()),
        agents: Vec::new(),
        links: Vec::new(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    state
}

fn config_with_identity(registry_id: &str, login: &str, display_name: &str) -> Config {
    let mut config = Config::default();
    config.identities.insert(registry_id.into(), Identity { login: login.into(), display_name: display_name.into() });
    config
}

fn build(ctx: &Ctx, config: &Config, state: &State) -> Vec<my_skills::InstalledRow> {
    let installer = Installer::new(&ctx.registry, &ctx.env).with_trasher(&ctx.sandbox);
    my_skills::build(&installer, &ctx.registry, &ctx.env, &ctx.store, &ctx.builtin, config, state).unwrap()
}

fn build_rows(ctx: &Ctx) -> Vec<my_skills::InstalledRow> {
    build(ctx, &Config::default(), &State::default())
}

fn build_rows_with_state(ctx: &Ctx, state: &State) -> Vec<my_skills::InstalledRow> {
    build(ctx, &Config::default(), state)
}

fn build_rows_with_config(ctx: &Ctx, config: &Config) -> Vec<my_skills::InstalledRow> {
    build(ctx, config, &State::default())
}

fn row<'a>(rows: &'a [my_skills::InstalledRow], dir_slug: &str) -> &'a my_skills::InstalledRow {
    rows.iter().find(|r| r.dir_slug == dir_slug).unwrap_or_else(|| {
        panic!("期望能找到 {dir_slug},实际列表:{:?}", rows.iter().map(|r| &r.dir_slug).collect::<Vec<_>>())
    })
}

#[test]
fn a_skill_whose_content_matches_the_company_library_is_in_it_even_without_a_record() {
    // hash 相等那支:磁盘上有实体、无记账,但内容与公司库索引里的同名技能逐字节相同。
    let ctx = ctx_with_builtin_index(&[("weekly-report", "HASH1")]);
    skill_dir_with_hash(&ctx.home, ".agents/skills/weekly-report", "HASH1");
    let rows = build_rows(&ctx);
    assert_eq!(row(&rows, "weekly-report").section, Section::InstalledFrom);
}

#[test]
fn a_same_named_but_different_skill_is_shareable_not_installed_from() {
    // 疑虑 4:名字撞上但三支都不成立 → 可分享到(而不是谎称"安装自")
    let ctx = ctx_with_builtin_index(&[("weekly-report", "HASH1")]);
    skill_dir_with_hash(&ctx.home, ".agents/skills/weekly-report", "OTHER");
    let rows = build_rows(&ctx);
    assert_eq!(row(&rows, "weekly-report").section, Section::Shareable);
}

#[test]
fn a_record_pointing_at_the_company_library_stays_installed_from_after_local_edits() {
    // 第二支:有获取记录 → 本地改过、hash 已不等,仍属"安装自"(否则一改就跳区)
    let ctx = ctx_with_builtin_index(&[("weekly-report", "HASH1")]);
    let state = state_with_record(&ctx, "weekly-report", BUILTIN_REGISTRY_ID, "HASH1");
    skill_dir_with_hash(&ctx.home, ".agents/skills/weekly-report", "EDITED");
    let rows = build_rows_with_state(&ctx, &state);
    assert_eq!(row(&rows, "weekly-report").section, Section::InstalledFrom);
    assert!(row(&rows, "weekly-report").local_modified);
}

#[test]
fn a_skill_installed_from_the_plaza_is_shareable_not_installed_from() {
    // Q1-A:三区只看公司库,广场装的落"可分享到"并带来源标签
    let ctx = ctx_with_builtin_index(&[]);
    let state = state_with_record(&ctx, "react-best-practices", "plaza", "HASH2");
    skill_dir_with_hash(&ctx.home, ".agents/skills/react-best-practices", "HASH2");
    let rows = build_rows_with_state(&ctx, &state);
    let r = row(&rows, "react-best-practices");
    assert_eq!(r.section, Section::Shareable);
    assert!(r.source_label.is_some(), "外源行要能标出来源");
}

#[test]
fn my_own_shared_skill_lands_in_shared_to() {
    let ctx = ctx_with_builtin_index_and_author(&[("rcs-generator", "HASH3", "赵文浩")]);
    let config = config_with_identity(BUILTIN_REGISTRY_ID, "zhaowenhao", "赵文浩");
    // M3(修复轮 1):本地内容故意与索引里的 marker 不同,让 hash 那支必然不成立
    // ——只留"公司库索引查得到作者"这一支单独把这一行判成 `SharedTo`,不让它与
    // 第三支(hash 相等)重复满足同一个断言。
    skill_dir_with_hash(&ctx.home, ".agents/skills/rcs-generator", "HASH3-LOCAL-EDIT");
    let rows = build_rows_with_config(&ctx, &config);
    assert_eq!(row(&rows, "rcs-generator").section, Section::SharedTo);
}

#[test]
fn a_custom_source_author_does_not_count_toward_the_company_library() {
    // C1(修复轮 1):`author` 的判据必须是 `builtin_record`,不是 `has_source()`
    // ——否则自定义源(甚至广场)索引里凑巧带的作者信息会被当成"公司库的作者"喂进
    // 三支判据第二支,把一个装自别处的技能判成「安装自公司库」,作者恰好是本人时
    // 更是直接说成「已分享到公司技能库」。公司库索引本身是空的,如果这一行不是
    // `Shareable`,说明自定义源的作者信息漏进了公司库判据。
    let ctx = ctx_with_builtin_index(&[]);
    write_index_cache_for(
        &ctx,
        "custom-1",
        "owner",
        "repo",
        vec![indexed_skill("weekly-report", Some("赵文浩"), "")],
    );
    let state = state_with_record(&ctx, "weekly-report", "custom-1", "HASH1");
    // 身份只登记在 custom-1 下:如果连 C2 那类"identity 键取错"的缺陷也在,
    // 这里同样会被误判成「已分享到」——两条修复分开验证,这里只钉 C1。
    let mut config = Config::default();
    config.identities.insert("custom-1".into(), me());
    skill_dir_with_hash(&ctx.home, ".agents/skills/weekly-report", "HASH1");
    let rows = build(&ctx, &config, &state);
    assert_eq!(row(&rows, "weekly-report").section, Section::Shareable);
}

#[test]
fn a_sourceless_record_credited_to_me_in_the_company_library_is_shared() {
    // C2(修复轮 1):`author` 来自公司库坐标(记账没有来源)时,identity 必须用
    // `BUILTIN_REGISTRY_ID` 查——用记账自己的(空)registry_id 查恒 `None`,作者
    // 本人分享的技能会被判成「安装自」而不是「已分享到」。这不是边角场景:
    // 普通员工对公司库是"写权限 + main 受保护",走评审的分享不会留下带来源的
    // 记账,只要在「我的技能」勾过任何工具就会建一条 `origin: adopted` 的
    // 空来源账(`state_with_sourceless_record` 同款)。
    let ctx = ctx_with_builtin_index_and_author(&[("rcs-generator", "HASH3", "赵文浩")]);
    skill_dir_with_hash(&ctx.home, ".agents/skills/rcs-generator", "HASH3");
    let state = state_with_sourceless_record("rcs-generator", None, &hash_for_marker("HASH3"));
    let config = config_with_identity(BUILTIN_REGISTRY_ID, "zhaowenhao", "赵文浩");
    let rows = build(&ctx, &config, &state);
    assert_eq!(row(&rows, "rcs-generator").section, Section::SharedTo);
}

#[test]
fn a_sourceless_record_keeps_its_bodys_original_case_when_matched_against_the_company_index() {
    // I2(修复轮 1):公司库索引按库里的**原始**目录名建键(大小写不清洗)。
    // 无来源记账查索引时不能用清洗后的 `home.dir_name`(账本身的清洗键),
    // 必须用本体的**字面**目录名——否则 `Weekly-Report` 这样的技能永远查空,
    // 即便公司库里恰好就是同名同内容的那一份。
    //
    // 现场:账键(`state.installed[].name`)是清洗后的 `weekly-report`,但
    // `body` 显式指向一个字面大小写为 `Weekly-Report` 的工具目录——与真实的
    // `adopted` 账(`converge::set_agents`)同款,`home.dir_name` 与本体的字面
    // 目录名因此不同,正是 I2 要处理的那道裂缝。
    let ctx = ctx_with_builtin_index_and_author(&[("Weekly-Report", "HASH4", "赵文浩")]);
    let body = skill_dir_with_hash(&ctx.home, ".claude/skills/Weekly-Report", "HASH4");
    let state =
        state_with_sourceless_record("weekly-report", Some(&body), &hash_for_marker("HASH4"));
    let config = config_with_identity(BUILTIN_REGISTRY_ID, "zhaowenhao", "赵文浩");
    let rows = build(&ctx, &config, &state);
    assert_eq!(row(&rows, "weekly-report").section, Section::SharedTo);
}
