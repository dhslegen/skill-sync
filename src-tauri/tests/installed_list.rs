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
    Ctx {
        _tmp: tmp,
        home,
        env,
        registry: AgentRegistry::builtin(),
        store,
        builtin,
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
    let installer = Installer::new(&ctx.registry, &ctx.env);
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
    write_index_cache(
        &ctx,
        vec![
            indexed_skill("shared-present", Some("赵文浩")),
            indexed_skill("library-only", Some("赵文浩")),
        ],
    );

    let mut config = Config::default();
    config.identities.insert(registry::BUILTIN_REGISTRY_ID.into(), me());

    let rows = build(&ctx, &config, &state);

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
}
