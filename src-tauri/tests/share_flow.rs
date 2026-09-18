//! 分享流程编排测试。
//!
//! 断言纪律与 acquire_flow 一致:守卫类断言盯**磁盘与请求体**,不盯枚举——
//! "没确认就不动手"要靠"没发出过 POST"来证明,不是靠返回值好看。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::ownership::{Identity, LibraryEntry, Relation};
use skillsync_lib::core::share::{self, CandidateOrigin, ShareMode, ShareOutcome, SharePrecheck};
use skillsync_lib::core::state::{InstalledSkill, LinkRecord, SharedSkill, SkillSource, Store};
use wiremock::matchers::{body_string_contains, method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// 这台机器上"建链成功"时 `LinkRecord.mode` / `Converged::Linked.mode` 的取值。
///
/// 🔴 **不能硬编码 `"symlink"`**(2026-09-14 第三轮 Windows CI 实测):实际降级链
/// **Windows 是 `[Junction, Copy]`(不试 symlink)、POSIX 是 `[Symlink, Copy]`**
/// (见 CLAUDE.md「建链与解链」)。写死 symlink 的断言在 macOS 上恒绿、
/// 在 Windows 上必红,而这与路径分隔符那件事是**两个互相独立的平台差异**
/// ——同一条测试可以同时踩中两个。
#[cfg(windows)]
const LINK_MODE: &str = "junction";
#[cfg(not(windows))]
const LINK_MODE: &str = "symlink";

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

const NOW: &str = "2026-07-31T09:00:00.000Z";

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
    /// 🔴 **必须显式注入**:`share()` 里的 `ensure_canonical_link` 会在 canonical
    /// 上遇到一份同内容实体副本时把它送进废纸篓,而 `Installer` 的默认实现是
    /// **这台机器真实的系统废纸篓**。落点刻意放在临时 HOME 之外的独立目录,
    /// 免得它自己被当成一个技能目录扫进来。
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
    let trash = fsops::SandboxTrash::new(home.join("..").join("share-flow-trash"));
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

fn canonical(c: &Ctx) -> PathBuf {
    c.home.join(".agents").join("skills")
}

fn write_skill(dir: &Path, name: &str, desc: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {desc}\n---\n正文\n"),
    )
    .unwrap();
}

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

fn state_of(c: &Ctx) -> skillsync_lib::core::state::State {
    c.store.load_state().map(|l| l.value).unwrap_or_default()
}

// ============================================================ 候选扫描

#[test]
fn scans_canonical_dirs_that_we_did_not_install() {
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("my-notes"), "我的笔记", "记点东西");

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c), &Default::default(), &Default::default()).unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].dir_name, "my-notes");
    assert!(found[0].in_canonical);
    assert_eq!(found[0].origin, CandidateOrigin::Local);
    assert_eq!(found[0].name.as_deref(), Some("我的笔记"));
    assert!(found[0].problem.is_none());
    assert!(found[0].dir_name_usable);
}

#[test]
fn skills_installed_by_this_app_are_excluded() {
    // 排除法的核心:团队库装的东西"再分享"回去只会造重复
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("weekly-report"), "周报", "d");
    let mut state = state_of(&c);
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "aaa".into(),
        },
        commit_sha: "aaa".into(),
        content_hash: String::new(),
        origin: None,
        body: None,
        agents: vec![],
        links: vec![],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });

    let found = share::scan_candidates(&c.registry, &env, &state, &Default::default(), &Default::default()).unwrap();
    assert!(found.is_empty(), "本 app 安装的不该出现在分享列表: {found:?}");
}

/// 🔴 **空来源账不该被排除**(v6 二期任务 6,欠账 6)。
///
/// 用户在 `~/.claude/skills/` 下开发一个技能,点过一次工具勾——`converge::set_agents`
/// 会顺手给它建一条 `adopted` 账,三个来源字段全是空占位。排除法原先无差别按
/// `state.installed` 的名字排除,于是这个技能**从分享候选里凭空消失**,
/// 而"在 Claude Code 里开发 skill、还想分享出去"正是这一期的主线场景。
///
/// 与上一条 `skills_installed_by_this_app_are_excluded` 互为对照组:两条的磁盘
/// 与记账形状**只差 `source` 三个字段有没有值**,判据只能是
/// `InstalledSkill::has_source()`(全仓唯一判据),不是"账上有没有这个名字"。
#[test]
fn a_record_without_a_source_is_still_shareable() {
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("weekly-report"), "周报", "d");
    let mut state = state_of(&c);
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        // 勾一次工具建出来的 `adopted` 账就是这个形状:三个坐标字段都是空串
        source: SkillSource {
            registry_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            path: String::new(),
            git_ref: String::new(),
        },
        commit_sha: String::new(),
        content_hash: "sha256:x".into(),
        origin: Some("adopted".into()),
        body: None,
        agents: vec!["claude-code".into()],
        links: vec![],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });

    let found = share::scan_candidates(&c.registry, &env, &state, &Default::default(), &Default::default()).unwrap();
    assert_eq!(
        found.iter().map(|f| f.dir_name.as_str()).collect::<Vec<_>>(),
        vec!["weekly-report"],
        "没有来源的记账不代表它是从技能库装来的,不该把它挡在分享之外",
    );
}

/// 🔴 **`state.shared` 的查找按 `Path` 比,不按字符串比**(项目铁律)。
///
/// fixture 刻意让两者**字符串不同、`Path` 相同**(尾随分隔符):按字符串比的实现
/// 会判成"从没分享过",于是界面上一个已经分享过的技能永远显示成没分享过。
/// 今天靠"两侧都出自 `canonical_global_dir`"才碰巧一致,那是巧合不是保证
/// ——本体现在完全可以不在 canonical,`local_path` 由别处写下。
#[test]
fn the_shared_record_is_matched_by_path_not_by_string() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "d");
    let mut state = state_of(&c);
    let with_trailing_sep = format!("{}{}", dir.to_string_lossy(), std::path::MAIN_SEPARATOR);
    assert_ne!(with_trailing_sep, dir.to_string_lossy(), "前提:两者字符串不同");
    assert_eq!(Path::new(&with_trailing_sep), dir.as_path(), "前提:两者 Path 相同");
    state.shared.push(SharedSkill {
        name: "my-notes".into(),
        local_path: with_trailing_sep,
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/my-notes".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "abc".into(),
        content_hash: fsops::dir_content_hash(&dir).unwrap(),
    });

    let found = share::scan_candidates(&c.registry, &env, &state, &Default::default(), &Default::default()).unwrap();
    let shared = found[0].shared.as_ref().expect("应当认出这个技能分享过");
    assert!(shared.up_to_date);
    assert_eq!(shared.share_name, "my-notes");
}

/// `ShareCandidate.relation` 直接断言(修复轮 1,`commands::share_candidates` 这条
/// IPC 的返回值此前没有任何测试走过——只被 `my_skills.rs` 间接覆盖过 relation 判定,
/// 但那条路走的是另一个函数(`InstalledRow`),`ShareCandidate` 自己的 relation
/// 字段从未被正面断言过)。库里记的作者是我 → Shared;换一个不是我的人 → Installed。
#[test]
fn candidate_relation_reflects_library_attribution() {
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("mine"), "我的技能", "d");
    write_skill(&canonical(&c).join("someone-elses"), "别人的技能", "d");

    let me = Identity { login: "zhaowh".into(), display_name: "赵文浩".into() };
    let mut identities = std::collections::BTreeMap::new();
    identities.insert("company".to_string(), me);

    let mut library = skillsync_lib::core::ownership::LibraryAttribution::new();
    library.insert(
        "mine".to_string(),
        LibraryEntry {
            path: String::new(),
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            branch: "main".into(),
            author: Some("赵文浩".into()),
        },
    );
    library.insert(
        "someone-elses".to_string(),
        LibraryEntry {
            path: String::new(),
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            branch: "main".into(),
            author: Some("李四".into()),
        },
    );

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c), &identities, &library).unwrap();

    let mine = found.iter().find(|f| f.dir_name == "mine").unwrap();
    assert_eq!(mine.relation, Relation::Shared, "库里记的作者是我,应判成 Shared");

    let theirs = found.iter().find(|f| f.dir_name == "someone-elses").unwrap();
    assert_eq!(theirs.relation, Relation::Installed, "库里记的作者不是我,不该判成 Shared");
}

#[test]
fn npx_installed_skills_carry_their_original_source() {
    let (c, env) = ctx();
    write_skill(&canonical(&c).join("email-polish"), "邮件润色", "d");
    std::fs::write(
        c.home.join(".agents").join(".skill-lock.json"),
        serde_json::json!({
            "version": 3,
            "skills": { "email-polish": { "source": "acme/skills", "sourceType": "github" } }
        })
        .to_string(),
    )
    .unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c), &Default::default(), &Default::default()).unwrap();
    assert_eq!(
        found[0].origin,
        CandidateOrigin::NpxSkills { source: "acme/skills".into() }
    );
}

#[test]
fn real_dirs_in_agent_folders_are_candidates_but_links_are_not() {
    let (c, env) = ctx();
    // 用户直接手建在 Claude Code 目录里的技能:候选,且标记"要收编"
    write_skill(&c.home.join(".claude").join("skills").join("hand-made"), "手搓的", "d");
    // canonical 的技能 + 指向它的链接:链接那份不该再列一遍
    let body = canonical(&c).join("my-notes");
    write_skill(&body, "我的笔记", "d");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&body, c.home.join(".claude").join("skills").join("my-notes"))
        .unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c), &Default::default(), &Default::default()).unwrap();

    let names: Vec<&str> = found.iter().map(|f| f.dir_name.as_str()).collect();
    assert!(names.contains(&"hand-made"));
    let hand = found.iter().find(|f| f.dir_name == "hand-made").unwrap();
    assert!(!hand.in_canonical);
    // my-notes 只出现一次(canonical 的那份)
    assert_eq!(names.iter().filter(|n| **n == "my-notes").count(), 1);
    assert!(found.iter().find(|f| f.dir_name == "my-notes").unwrap().in_canonical);
}

#[test]
fn dirs_without_skill_md_are_not_skills() {
    let (c, env) = ctx();
    std::fs::create_dir_all(canonical(&c).join("random-stuff")).unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c), &Default::default(), &Default::default()).unwrap();
    assert!(found.is_empty());
}

#[test]
fn broken_frontmatter_and_chinese_dir_names_are_flagged_for_the_form() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("周报生成器");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: 周报\n---\n没有描述\n").unwrap();

    let found = share::scan_candidates(&c.registry, &env, &state_of(&c), &Default::default(), &Default::default()).unwrap();

    assert_eq!(found.len(), 1);
    assert!(found[0].problem.as_deref().unwrap().contains("description"));
    // 纯中文目录名 sanitize 后信息全丢,表单必须让用户另起英文名
    assert!(!found[0].dir_name_usable);
}

#[test]
fn previously_shared_skills_report_whether_local_changed_since() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "我的笔记", "d");
    let mut state = state_of(&c);
    state.shared.push(SharedSkill {
        name: "my-notes".into(),
        local_path: dir.to_string_lossy().into_owned(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/my-notes".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "abc".into(),
        content_hash: fsops::dir_content_hash(&dir).unwrap(),
    });

    let found = share::scan_candidates(&c.registry, &env, &state, &Default::default(), &Default::default()).unwrap();
    assert!(found[0].shared.as_ref().unwrap().up_to_date);

    // 改一笔 → 未分享的改动
    std::fs::write(dir.join("SKILL.md"), "---\nname: 我的笔记\ndescription: 改了\n---\n").unwrap();
    let found = share::scan_candidates(&c.registry, &env, &state, &Default::default(), &Default::default()).unwrap();
    assert!(!found[0].shared.as_ref().unwrap().up_to_date);
}

// ============================================================ 预检三分支

async fn mount_skill_exists(server: &MockServer, name: &str, exists: bool) {
    let m = Mock::given(method("GET"))
        .and(path(format!("/api/v1/repos/skills/skills/contents/skills/{name}/SKILL.md")));
    if exists {
        m.respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"sha": "aaa"})))
            .mount(server)
            .await;
    } else {
        m.respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"message": "GetContentsOrList"})))
            .mount(server)
            .await;
    }
}

/// `share::precheck` 的薄壳:两个归属入参默认都是 None(= 未登录 / 库里没有作者信息),
/// 与 v6 之前的行为逐字等价——旧用例因此一个断言都不用改。
async fn precheck_of(
    client: &GiteaClient,
    state: &skillsync_lib::core::state::State,
    me: Option<&Identity>,
    library_author: Option<&str>,
) -> SharePrecheck {
    share::precheck(
        &share::ShareClient::Gitea(client),
        &repo_ref(),
        state,
        "my-notes",
        me,
        library_author,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn precheck_fresh_when_remote_has_no_such_skill() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = precheck_of(&client, &state_of(&c), None, None).await;
    assert_eq!(got, SharePrecheck::Fresh);
}

#[tokio::test]
async fn precheck_mine_when_we_shared_it_before() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    let mut state = state_of(&c);
    state.shared.push(SharedSkill {
        name: "my-notes".into(),
        local_path: "/x".into(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/my-notes".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "abc".into(),
        content_hash: String::new(),
    });
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = precheck_of(&client, &state, None, None).await;
    assert_eq!(got, SharePrecheck::Mine);
}

#[tokio::test]
async fn precheck_taken_when_someone_else_owns_the_name() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let got = precheck_of(&client, &state_of(&c), None, None).await;
    assert_eq!(got, SharePrecheck::Taken);
}

/// 🔴 场景 3(v6 终审修复的 C1):我是这个技能的**第一作者**,当初直接推进了技能库、
/// 从没经过本应用——所以这台机器的 `state.shared` 是空的。只看本地记账会把作者本人
/// 判成外人,弹出一整套写给外人看的三选(换个名称 / 看看对方的版本 / 用我的版本覆盖),
/// 而这条路是这个场景**唯一的出路**(「我的技能」里 `noBaseline` 档的「分享更新」
/// 也只通向分享页)。判据必须是技能库里记的作者,不是本机记账。
#[tokio::test]
async fn precheck_mine_when_the_library_credits_me_even_without_any_local_record() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let me = Identity { login: "zhaowh".into(), display_name: "赵文浩".into() };

    let state = state_of(&c);
    assert!(state.shared.is_empty(), "场景 3 的前提就是本机一条分享记账都没有");

    let got = precheck_of(&client, &state, Some(&me), Some("赵文浩")).await;
    assert_eq!(got, SharePrecheck::Mine, "库里记的作者是我,就该按「更新我分享的技能」走");
}

/// 上一条的**对照组**:同样没有本机记账,但库里记的作者是别人——这才是真的被占用,
/// 三选文案说的每一句都成立。没有这条,把归属判定放宽成"登录了就算我的"照样全绿。
#[tokio::test]
async fn precheck_still_taken_when_the_library_credits_someone_else() {
    let (c, _env) = ctx();
    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let me = Identity { login: "zhaowh".into(), display_name: "赵文浩".into() };

    let got = precheck_of(&client, &state_of(&c), Some(&me), Some("李四")).await;
    assert_eq!(got, SharePrecheck::Taken, "库里记的是别人,登录了也不该判成我的");
}

// ============================================================ 提交

async fn mount_repo_info(server: &MockServer, push: bool) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main",
            "permissions": { "admin": false, "push": push, "pull": true },
            "empty": false
        })))
        .mount(server)
        .await;
}

async fn mount_commit_ok(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "newsha1", "html_url": "http://x/commit/newsha1" }
        })))
        .mount(server)
        .await;
}

/// 往 `("company", skills/skills)` 的索引缓存里写一条带作者的技能。
/// 落点必须与 `share::share()` 自己算出来的完全一致(`store::cache_path` 同一个函数)
/// ——否则这条用例测的就不是胶水层,而是"缓存读不到时退回 state.shared"那条路。
fn write_index_cache_with_author(c: &Ctx, dir_slug: &str, author: &str) {
    use skillsync_lib::core::store as index_store;
    let repo = repo_ref();
    let path = index_store::cache_path(c.store.dir(), "company", &repo);
    let index = index_store::StoreIndex {
        schema_version: index_store::INDEX_SCHEMA_VERSION,
        registry_id: "company".into(),
        owner: repo.owner.clone(),
        repo: repo.repo.clone(),
        branch: repo.branch.clone(),
        commit_sha: "head1".into(),
        committed_at: NOW.into(),
        fetched_at: 0,
        skills: vec![index_store::IndexedSkill {
            name: dir_slug.into(),
            dir_slug: dir_slug.into(),
            description: String::new(),
            path: format!("skills/{dir_slug}"),
            skill_md: String::new(),
            files: Vec::new(),
            has_scripts: false,
            content_hash: String::new(),
            tags: Vec::new(),
            attribution: Some(index_store::SkillAttribution {
                author: author.into(),
                contributors: Vec::new(),
            }),
            updated_at: index_store::SkillUpdatedAt::Unknown,
        }],
        skipped: Vec::new(),
        curated: Vec::new(),
    };
    index_store::save_cache(&path, &index).unwrap();
}

fn share_req<'a>(repo: &'a RepoRef, dir_slug: &'a str) -> share::ShareRequest<'a> {
    share::ShareRequest {
        registry_id: "company",
        repo,
        dir_slug,
        confirm: None,
    }
}

/// 「用户在确认屏上点了确认」那一跳的**完整两轮**(终审 C-1 起执行轮必须带凭据)。
///
/// 预览轮拿到 `remote_rev`,执行轮原样带回去——这正是界面走的路。预览轮就报错
/// (校验没过、没装过……)时原样往上抛,断言不变;预览轮直接给出终态
/// (`AlreadyInSync`)时也原样回,不硬凑第二跳。
async fn confirmed_share(
    client: &GiteaClient,
    c: &Ctx,
    env: &TmpEnv,
    repo: &RepoRef,
    dir_slug: &str,
) -> Result<ShareOutcome, skillsync_lib::error::AppError> {
    let first = share::share(&share::ShareClient::Gitea(client), client, &c.registry, env, &c.store, &c.trash, share_req(repo, dir_slug), NOW).await?;
    let ShareOutcome::NeedsConfirm { remote_rev, .. } = &first else { return Ok(first) };
    let rev = remote_rev.clone();
    share::share(
        &share::ShareClient::Gitea(client),
        client,
        &c.registry,
        env,
        &c.store,
        &c.trash,
        share::ShareRequest { registry_id: "company", repo, dir_slug, confirm: Some(&rev) },
        NOW,
    )
    .await
}

/// 同上,「分享改动」那条通道的两轮。
async fn confirmed_push(
    client: &GiteaClient,
    c: &Ctx,
    env: &TmpEnv,
    dir_slug: &str,
) -> Result<share::ShareInstalledOutcome, skillsync_lib::error::AppError> {
    let first = share::share_installed(&share::ShareClient::Gitea(client), client, &c.registry, env, &c.store, dir_slug, "main", None, NOW).await?;
    let share::ShareInstalledOutcome::NeedsConfirm { remote_rev, .. } = &first else { return Ok(first) };
    let rev = remote_rev.clone();
    share::share_installed(&share::ShareClient::Gitea(client), client, &c.registry, env, &c.store, dir_slug, "main", Some(&rev), NOW).await
}

#[tokio::test]
async fn fresh_share_pushes_creates_and_records_the_books() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");
    std::fs::write(dir.join("logo.png"), [0x89u8, 0x50]).unwrap();

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();

    // `ShareOutcome` 现在只剩 `Shared` 一档,解构是不可反驳的
    let ShareOutcome::Shared { mode, commit_sha, .. } = outcome else { panic!("应当分享成功,不该落进覆盖确认档") };
    assert_eq!(mode, ShareMode::Pushed);
    assert_eq!(commit_sha, "newsha1");

    // 请求体:全部 create、无 new_branch、二进制走 base64
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    assert_eq!(posted.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    assert!(body.get("new_branch").is_none());
    assert_eq!(body["branch"], "main");
    let files = body["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|f| f["operation"] == "create"));
    assert!(files.iter().any(|f| f["path"] == "skills/my-notes/SKILL.md"));
    assert!(files.iter().any(|f| f["path"] == "skills/my-notes/logo.png"));

    // 记账:有 content_hash(未分享改动判据)与 commit sha
    let state = state_of(&c);
    assert_eq!(state.shared.len(), 1);
    assert_eq!(state.shared[0].name, "my-notes");
    assert_eq!(state.shared[0].last_pushed_sha, "newsha1");
    assert_eq!(state.shared[0].content_hash, fsops::dir_content_hash(&dir).unwrap());
}

// ============================================================ 归因维护(M7 任务 5)

async fn mount_current_user(server: &MockServer) {
    // full_name 优先于 login 的口径靠这份 fixture 钉住:两个字段故意不同值
    Mock::given(method("GET"))
        .and(path("/api/v1/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "login": "lisi", "full_name": "李四"
        })))
        .mount(server)
        .await;
}

async fn mount_authors_json(server: &MockServer, existing: Option<&str>) {
    use base64::Engine;
    let m = Mock::given(method("GET")).and(path("/api/v1/repos/skills/skills/contents/authors.json"));
    match existing {
        Some(text) => {
            m.respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sha": "authsha",
                "encoding": "base64",
                "content": base64::engine::general_purpose::STANDARD.encode(text)
            })))
            .mount(server)
            .await;
        }
        None => {
            m.respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(serde_json::json!({"message": "GetContentsOrList"})),
            )
            .mount(server)
            .await;
        }
    }
}

/// 从提交请求体里挑出 authors.json 那个条目并解码内容。
fn authors_change(body: &serde_json::Value) -> Option<(String, serde_json::Value)> {
    use base64::Engine;
    let f = body["files"].as_array()?.iter().find(|f| f["path"] == "authors.json")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(f["content"].as_str()?)
        .unwrap();
    let doc = serde_json::from_slice(&bytes).unwrap();
    Some((f["operation"].as_str().unwrap().to_string(), doc))
}

/// M7 任务 5:归因跟着分享动作走——条目已存在时分享者进 contributors,author 一个字不动,
/// 其余条目原样保住;修订与技能文件在**同一笔提交**里。
#[tokio::test]
async fn share_appends_sharer_as_contributor_in_the_same_commit() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    mount_current_user(&server).await;
    mount_authors_json(
        &server,
        Some(r#"{"authors":{"other-skill":{"author":"张三"},"my-notes":{"author":"张三"}}}"#),
    )
    .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();

    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    assert_eq!(posted.len(), 1, "归因修订必须在同一笔提交里,不另发请求");
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    let (op, doc) = authors_change(&body).expect("提交里必须带 authors.json");
    assert_eq!(op, "update");
    // author 一个字不动;分享者(full_name 优先,不是 login)进 contributors
    assert_eq!(doc["authors"]["my-notes"]["author"], "张三");
    assert_eq!(doc["authors"]["my-notes"]["contributors"][0], "李四");
    // 其他条目原样保住
    assert_eq!(doc["authors"]["other-skill"]["author"], "张三");
}

/// 库里还没有 authors.json:新增分享创建它,author = 分享者。
#[tokio::test]
async fn share_creates_authors_json_when_library_has_none() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    mount_current_user(&server).await;
    mount_authors_json(&server, None).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();

    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    let (op, doc) = authors_change(&body).expect("提交里必须带 authors.json");
    assert_eq!(op, "create");
    assert_eq!(doc["authors"]["my-notes"]["author"], "李四");
}

/// 存量 authors.json 按 **Gitea 登录名** 记(初版手工填的、gen-authors 从 git 历史
/// 算的都是这个口径),而 App 分享时用 full_name。别名比对必须认出这是同一个人,
/// 否则作者本人一分享就把自己追加进自己的 contributors。
#[tokio::test]
async fn an_entry_recorded_under_the_login_name_recognizes_the_same_person() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    mount_current_user(&server).await; // login: lisi / full_name: 李四
    mount_authors_json(&server, Some(r#"{"authors":{"my-notes":{"author":"lisi"}}}"#)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();

    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    assert!(
        authors_change(&body).is_none(),
        "author 记的 lisi 就是分享者本人(full_name 李四),不该改动 authors.json"
    );
}

/// 「归因绝不拦分享」必须在**提交边界**也成立,不只在读取边界。
///
/// authors.json 现在每次分享都写,两个人同时分享**不同**技能也会撞在这一个文件的
/// blob sha 上;而 Gitea 的多文件提交是原子的,归因一条过期就把技能文件一起拖垮,
/// 用户看到一句与归因毫无关系的冲突错误、分享根本没进去。所以提交被拒时要剥掉
/// 归因重试一次:归因丢了无所谓(下次分享补上),用户的技能必须进得去。
#[tokio::test]
async fn a_stale_attribution_entry_is_dropped_so_the_skill_still_lands() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_current_user(&server).await;
    mount_authors_json(&server, Some(r#"{"authors":{"other":{"author":"张三"}}}"#)).await;
    // 带 authors.json 的提交被拒(模拟并发下 blob sha 过期);不带的放行。
    // 顺序很重要:wiremock 按注册顺序取**第一个**匹配上的 Mock,所以更具体的"拒绝"
    // 必须先挂,通用的"放行"挂在后面兜住重试那一次。
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .and(body_string_contains("authors.json"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "message": "sha does not match"
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "newsha1", "html_url": "http://x/commit/newsha1" }
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .expect("归因过期不该让整个分享失败");

    let ShareOutcome::Shared { commit_sha, .. } = outcome else { panic!("应当分享成功,不该落进覆盖确认档") };
    assert_eq!(commit_sha, "newsha1");

    // 第二次提交(重试)里不带 authors.json,技能文件照旧
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs
        .iter()
        .filter(|r| r.url.path() == "/api/v1/repos/skills/skills/contents" && r.method.as_str() == "POST")
        .collect();
    assert_eq!(posted.len(), 2, "应当剥掉归因重试一次");
    let retry: serde_json::Value = serde_json::from_slice(&posted[1].body).unwrap();
    assert!(authors_change(&retry).is_none(), "重试不该再带归因");
    assert!(
        retry["files"].as_array().unwrap().iter().any(|f| f["path"] == "skills/my-notes/SKILL.md"),
        "技能文件必须还在"
    );
    // 记账照常落下——分享确实成功了
    assert_eq!(state_of(&c).shared.len(), 1);
}

// ⚠️ **v8 任务 3 删掉了 `attribution_on_the_fork_path_reads_the_fork_not_the_upstream`**:
// 它验的是"只读用户走副本时,归因的 blob sha 必须取自副本仓",而副本那条路已整体
// 下线(D1)。**"按实际提交目标仓取 sha"这条约束本身没有作废**——只是眼下只剩一个
// 目标仓,`attribution_change` 的文档里留着它的原委。只读用户现在的行为由
// `a_read_only_user_is_told_why_instead_of_getting_a_personal_copy` 钉住。


/// 归因是锦上添花:身份/文件读不到(此处连 /user 都没 mock,404)绝不拦分享,
/// 提交里也不夹带半个 authors.json。上面 fresh 用例的 files.len()==2 断言
/// 是这条纪律的另一道护栏。
#[tokio::test]
async fn attribution_failure_never_blocks_the_share() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();
    assert!(matches!(outcome, ShareOutcome::Shared { .. }));

    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    assert!(authors_change(&body).is_none(), "拿不到身份就不该动 authors.json");
}

/// 分享的闭环(M6 任务 5):直推进库之后,这个技能要有一条**记账基线**
/// ——没有它,刚分享出去的技能立刻落进 `noBaseline` 档,「分享更新」与「移除」
/// 都摆不出来。
#[tokio::test]
async fn a_skill_pushed_straight_into_the_library_gets_a_baseline_record() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();

    let state = state_of(&c);
    assert_eq!(state.installed.len(), 1, "直推成功后应自动建起记账基线");
    let s = &state.installed[0];
    assert_eq!(s.name, "my-notes");
    assert_eq!(
        (s.source.registry_id.as_str(), s.source.owner.as_str(), s.source.repo.as_str()),
        ("company", "skills", "skills"),
        "来源坐标要记成刚推进去的那个库,更新与回推才有去处",
    );
    assert_eq!(s.commit_sha, "newsha1");
    assert_eq!(
        s.content_hash,
        fsops::dir_content_hash(&dir).unwrap(),
        "基线取刚推上去的内容——不等就会立刻误报「有可用更新」",
    );
    // 文件是用户自己的,本 app 只记了账——`origin` 现在只读,留一份显式来历
    assert_eq!(s.origin.as_deref(), Some("claimed"));
    // 本体就住在 canonical:`body` 留空,不写成同一件事的第二种写法
    assert_eq!(s.body, None, "本体在 canonical 时 body 该留空");
}

/// 走了提交审核就**不能**记成已入库:改动还在评审分支上,库里根本没有这个技能。
/// 记了的话「更新」会去库里找一个不存在的技能,而且用户会以为已经生效了。
#[tokio::test]
async fn taken_by_someone_else_is_an_error_not_a_three_way_dialog() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap_err();

    // 「覆盖别人的技能」这条路整体取消了,所以这不再是"等用户三选一"的拍板档,
    // 而是一个如实的错误:改名由用户在本地完成(A-3)。
    assert_eq!(err.code, "REPO_NAME_TAKEN");
    // 真正的守卫断言:一个提交都没发出去
    let reqs = server.received_requests().await.unwrap();
    assert!(reqs.iter().all(|r| r.method.as_str() != "POST"), "被占用还发了提交");
    assert!(state_of(&c).shared.is_empty(), "没分享成还记了账");
}

/// 🔴 **场景 3 的真实执行路径**(v6 终审第二轮补):裸 `precheck()` 那两条用例是
/// 手工传参的,而用户真正走的是 `share::share()` —— 由它自己从 `config.identities`
/// 取身份、从**目标库**的索引缓存取作者,再传给 `precheck`。这段胶水此前
/// **没有任何测试正面走过**:参数取错字段(registryId 取成别的、dir_slug 取成
/// share 之外的字段)现有测试矩阵一条都抓不到,而它服务的正是用户点名的第三个场景。
///
/// 形状与 `taken_without_confirmation_sends_nothing` 完全相同(远端已有同名技能、
/// 本机 `state.shared` 空、`overwrite = false`),**唯一的差别是这台机器上有身份、
/// 库里记的作者是我** —— 那一条判 `Taken` 停在 `NeedsDecision`,这一条必须判 `Mine`
/// 并直接提交。两条互为对照组。
#[tokio::test]
async fn share_reads_identity_and_library_author_itself_so_the_author_is_never_a_stranger() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "d");

    // 这台机器上的身份(登录那一刻落的盘)+ 目标库索引缓存里记的作者 = 同一个人。
    // 两者都由 share() 自己去取,测试只负责把它们放到真实位置上。
    let mut config = skillsync_lib::core::state::Config::default();
    config.identities.insert(
        "company".into(),
        Identity { login: "zhaowh".into(), display_name: "赵文浩".into() },
    );
    c.store.save_config(&config).unwrap();
    write_index_cache_with_author(&c, "my-notes", "赵文浩");

    assert!(state_of(&c).shared.is_empty(), "场景 3 的前提:本机一条分享记账都没有");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [{ "path": "skills/my-notes/SKILL.md", "sha": "oldsha", "type": "blob" }],
            "truncated": false
        })))
        .mount(&server)
        .await;
    // 覆盖闸(v8 任务 4)与差集(任务 5)共用这次压缩包下载。这条用例测的是别的
    // 命题,所以 ①库里那一版与本地**不同**——相同的话任务 5 起会短路成
    // 「库里已与本地一致」、一个请求都不发,原命题就测不到了;②请求带
    // `confirmed_share` 走的是真实的两轮:预览轮拿凭据、执行轮带回去(终审 C-1)。
    mount_archive_of(&server, "my-notes", "---\nname: my-notes\ndescription: 库里那一版\n---\n正文\n").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    // overwrite 保持 false:判成 Taken 就会停在 NeedsDecision、一个 POST 都不发
    let outcome = confirmed_share(&client, &c, &env, &repo, "my-notes")
    .await
    .unwrap();

    assert!(
        matches!(outcome, ShareOutcome::Shared { .. }),
        "库里记的作者是我,share() 就该按「更新我分享的技能」直接提交,而不是弹三选:{outcome:?}",
    );
    // 再钉一层:提交信息必须是「更新技能」——`Fresh` 走的是「新增技能」,
    // 只断言 Shared 分不出这两档(远端明明已有同名技能)。
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    assert_eq!(body["message"], "更新技能:my-notes");
}

/// 「更新我分享的技能」这一档的请求体形状:远端已有 → 必须 `update` 且带旧 blob sha,
/// 发 `create` 会被 Gitea 422 拒掉。
///
/// ⚠️ 它原先叫 `overwriting_a_taken_name_updates_with_remote_shas`,靠「已确认」那一跳
/// 走到这条路;`overwrite` 这个字段已随「覆盖别人的技能」一起删掉,现在的前提换成
/// **本机有一条分享记账**(= `SharePrecheck::Mine`)——被测的请求体形状一个字没变。
#[tokio::test]
async fn updating_a_skill_i_shared_before_uses_remote_shas() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "d");
    let mut state = state_of(&c);
    state.shared.push(SharedSkill {
        name: "my-notes".into(),
        // 尾随分隔符:与本体路径**字符串不同、`Path` 相同**。写记账时按 `Path`
        // 找这一行才找得到;按字符串找会另推一条,同一个本地目录留下两条记账
        // ——CLAUDE.md 记着的 `state.shared` 读写双键不一致就是这个形状。
        local_path: format!("{}{}", dir.to_string_lossy(), std::path::MAIN_SEPARATOR),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/my-notes".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "oldcommit".into(),
        content_hash: String::new(),
    });
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [
                { "path": "skills/my-notes/SKILL.md", "sha": "oldsha", "type": "blob" },
                { "path": "skills/other/SKILL.md", "sha": "x", "type": "blob" }
            ],
            "truncated": false
        })))
        .mount(&server)
        .await;
    // 覆盖闸(v8 任务 4)与差集(任务 5)共用这次压缩包下载。这条用例测的是别的
    // 命题,所以 ①库里那一版与本地**不同**——相同的话任务 5 起会短路成
    // 「库里已与本地一致」、一个请求都不发,原命题就测不到了;②请求带
    // `confirmed_share` 走的是真实的两轮:预览轮拿凭据、执行轮带回去(终审 C-1)。
    mount_archive_of(&server, "my-notes", "---\nname: my-notes\ndescription: 库里那一版\n---\n正文\n").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();

    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    let skill_md = body["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "skills/my-notes/SKILL.md")
        .unwrap();
    // 远端已有 → update 且带旧 blob sha;发 create 会被 Gitea 422 拒掉
    assert_eq!(skill_md["operation"], "update");
    assert_eq!(skill_md["sha"], "oldsha");

    // 记账被**替换**而不是又推一条:同一个本地目录只该有一行
    let state = state_of(&c);
    assert_eq!(state.shared.len(), 1, "同一个本体留下了两条分享记账:{:?}", state.shared);
    assert_eq!(state.shared[0].last_pushed_sha, "newsha1");
}

/// 🔴 **v8 任务 3:直推被 403 挡下 → 一句人话,不再降级开分支 + 提交审核**(D1)。
///
/// 断言的是**请求条数**不只是错误码:降级那条路会再发一笔带 `new_branch` 的
/// contents 与一笔 pulls,只断言错误码的话,"报了错但顺手又开了个没人看的审核
/// 请求"照样能过。
#[tokio::test]
async fn a_protected_branch_is_reported_not_downgraded_to_a_review() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "message": "user should have a permission to write to the target branch"
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap_err();

    assert_eq!(err.code, "REPO_PUSH_BLOCKED");
    let reqs = server.received_requests().await.unwrap();
    let contents = reqs
        .iter()
        .filter(|r| r.url.path().ends_with("/contents") && r.method.as_str() == "POST")
        .count();
    assert_eq!(contents, 1, "只试一次直推,不再降级开分支");
    assert!(
        !reqs.iter().any(|r| r.url.path().ends_with("/pulls")),
        "不许再开审核请求:{:?}",
        reqs.iter().map(|r| r.url.path().to_string()).collect::<Vec<_>>()
    );
    assert!(state_of(&c).shared.is_empty(), "没推成就别记账");
}

/// 🔴 **v8 任务 3 / D8:只读用户 → 一句人话,而且零写请求**(以前这一档会复制
/// 一份技能库到用户名下,再跨库提交审核)。
///
/// 断言的是"一个写请求都没发出去"而不只是错误码:早退若放在 `attribution_file_change`
/// 之后,库的 authors.json 会被白读一次;放在 fork 之后,用户账号下会留一个注定
/// 用不上的副本。
#[tokio::test]
async fn a_read_only_user_is_told_why_instead_of_getting_a_personal_copy() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, false).await; // 只读
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap_err();

    // 🔴 **请求断言排在错误码之前**:早退一旦被拿掉,流程会一路走到提交、撞上
    // 没挂的端点,拿到的是另一个错误码——先断言错误码的话,红的原因会变成
    // "码不对",而这条测试真正的命题("一个写请求都不该发出去")永远跑不到。
    let reqs = server.received_requests().await.unwrap();
    assert!(
        reqs.iter().all(|r| r.method.as_str() == "GET"),
        "只读用户这条路一个写请求都不该发出去:{:?}",
        reqs.iter().map(|r| format!("{} {}", r.method, r.url.path())).collect::<Vec<_>>()
    );
    assert_eq!(err.code, "REPO_NO_WRITE_ACCESS");
    assert!(state_of(&c).shared.is_empty(), "没推成就别记账");
}

/// 🔴 **本体永不搬家**(v6 二期任务 6,取代旧的 `sharing_from_an_agent_dir_adopts_it_into_canonical`)。
///
/// 用户在 `~/.claude/skills/` 下开发这个技能——那正是这一期的主线场景。分享之后:
/// 本体**还在原地**(旧行为是整份复制进 canonical、原位换链接),canonical 上多出
/// 一条**指向它**的链接,记账指向本体所在,提交只发一笔。
///
/// ⚠️ 断言用 `read_link_target` 而不是"canonical 下读得到 SKILL.md":后者对
/// "复制了一份过去"同样成立——那正是这条测试要否掉的旧行为(注入验证:把
/// `ensure_canonical_link` 换回 `copy_tree`,"本体留在原地"仍绿、这一条红)。
#[tokio::test]
async fn share_uploads_the_body_in_place_and_links_canonical_without_copying() {
    let (c, env) = ctx();
    let body = c.home.join(".claude").join("skills").join("hand-made");
    write_skill(&body, "hand-made", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "hand-made", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = confirmed_share(&client, &c, &env, &repo, "hand-made")
        .await
        .unwrap();
    assert!(matches!(outcome, ShareOutcome::Shared { .. }));

    assert!(body.join("SKILL.md").is_file(), "本体没留在原地");
    assert_eq!(
        fsops::read_link_target(&canonical(&c).join("hand-made")),
        Some(fsops::normalize(&body)),
        "canonical 上应该是一条指向本体的链接,不是一份副本",
    );

    // 记账指向本体所在,不是 canonical
    let state = state_of(&c);
    assert_eq!(Path::new(&state.shared[0].local_path), body.as_path(), "分享记账应指向本体");
    // 只提交了一笔(skills/hand-made/ 那一笔;这里没 mock /user,不带 authors.json)
    let posted = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posted, 1);
}

/// 本体不在 canonical 时,`state.installed` 的 `body` 必须如实记下它在哪
/// ——记 `None` 等于说"它住在 canonical",而 canonical 上只是一条链接:
/// 之后每一次 `converge::home_of` 都会把那条链接当本体,移除时删的是链接、
/// 本体留在原地成孤儿。
///
/// ⚠️ fixture 刻意让本体**不在** canonical:两者同处时 `body: None` 与
/// `Some(canonical)` 序列化之外的行为完全一样,那样的用例证明不了任何事。
#[tokio::test]
async fn a_body_outside_canonical_is_recorded_by_its_real_location() {
    let (c, env) = ctx();
    let body = c.home.join(".claude").join("skills").join("hand-made");
    write_skill(&body, "hand-made", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "hand-made", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    confirmed_share(&client, &c, &env, &repo, "hand-made")
        .await
        .unwrap();

    let state = state_of(&c);
    assert_eq!(state.installed.len(), 1, "直推进库应当建起记账基线");
    assert_eq!(
        state.installed[0].body.as_deref().map(Path::new),
        Some(body.as_path()),
        "本体不在 canonical 时,账上必须记下它真正在哪",
    );
}

/// 🔴 **分享环节零编辑**(A-1):`share()` 不许碰 SKILL.md 一个字节。
/// 旧行为是"表单给了值就重建 frontmatter",那条链路已整体删除。
#[tokio::test]
async fn share_never_rewrites_skill_md() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "记点东西");
    let before = std::fs::read(dir.join("SKILL.md")).unwrap();

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();

    assert_eq!(
        std::fs::read(dir.join("SKILL.md")).unwrap(),
        before,
        "分享环节零编辑,SKILL.md 一个字节都不该变",
    );
}

/// 🔴 **不合格的技能一次网络请求都不该发**(A-2 的闸摆在 `precheck` 之前)。
///
/// 样本取自真实数据:`~/.claude/skills/react-best-practices/` 的 frontmatter
/// `name` 是 `vercel-react-best-practices`(Claude Code 放行、开放标准不认)。
/// 守卫断言盯的是**请求条数**,不是返回的错误码——把校验挪到 `submit` 之后
/// 时错误码照样对,只有请求条数会红(注入验证钉的就是这一条)。
#[tokio::test]
async fn share_refuses_non_conforming_skills_before_any_network_call() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("react-best-practices");
    write_skill(&dir, "vercel-react-best-practices", "前端规范");

    // 全部端点都挂上:真发了请求就一定拿得到 200,不会因为"没 mock"而失败,
    // 这样这条测试红的时候一定是因为"发了请求",不是因为别的。
    let server = MockServer::start().await;
    mount_skill_exists(&server, "react-best-practices", false).await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = confirmed_share(&client, &c, &env, &repo, "react-best-practices")
        .await
        .unwrap_err();

    assert_eq!(err.code, "FS_SKILL_INVALID");
    assert_eq!(err.detail.as_deref(), Some("nameMismatch"));
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        0,
        "不合格的技能连一次探测都不该发出去",
    );
}

#[tokio::test]
async fn a_race_at_submit_time_surfaces_as_conflict_stale() {
    // DoD:sha 竞态返回 CONFLICT_STALE,UI 拿它回到预检
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "d");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await;
    mount_repo_info(&server, true).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "repository file already exists [path: skills/my-notes/SKILL.md]"
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap_err();

    assert_eq!(err.code, "CONFLICT_STALE");
    assert!(state_of(&c).shared.is_empty(), "提交失败还记了账");
}

/// 大写文件夹名过不了标准的字符集这一条(只许 a-z / 0-9 / 连字符)。
/// 报的是**文件夹名**这一档而不是 `name` 那一档:用户改文件夹名就能一次修好,
/// 让他去改 frontmatter 反而会把「name == 文件夹名」也一起弄坏
/// (判定顺序由 `fixtures/share-validation-samples.json` 钉住)。
///
/// ⚠️ fixture 刻意用**大写**目录名:全小写时"磁盘上的字面目录名"与"清洗后的
/// 记账键"恰好同值,这条路上的两把尺子就分不出来了(`record_key` 会小写化,
/// 校验必须拿**字面**叶子名判——拿清洗名判的话这一档永远判不出来)。
#[tokio::test]
async fn an_uppercase_folder_name_is_rejected_up_front() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("Weekly-Report");
    write_skill(&dir, "Weekly-Report", "d");
    let server = MockServer::start().await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = confirmed_share(&client, &c, &env, &repo, "Weekly-Report")
        .await
        .unwrap_err();

    assert_eq!(err.code, "FS_SKILL_INVALID");
    assert_eq!(err.detail.as_deref(), Some("dirFormat"));
    // 一个网络请求都不该发
    assert!(server.received_requests().await.unwrap().is_empty());
}

/// 纯中文文件夹名连**记账键**都当不了(`sanitize_name` 把它整个折成
/// `unnamed-skill`),所以它在更早的一层——本体定位——就被拦下,报的是
/// `FS_UNUSABLE_NAME` 而不是 `FS_SKILL_INVALID`。
///
/// 这不是不一致:两句话给的是**同一条**建议(改用英文字母/数字/短横线),
/// 而界面上这一行本来就摆着 `shareBlocked = dirFormat`、分享按钮是不可点的
/// ——core 这一层只是backstop。**要紧的是它同样不发任何网络请求**,
/// 这条测试盯的就是这个量。
#[tokio::test]
async fn a_folder_name_that_collapses_entirely_is_rejected_before_any_request() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("周报");
    write_skill(&dir, "周报", "d");
    let server = MockServer::start().await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let err = confirmed_share(&client, &c, &env, &repo, "周报")
        .await
        .unwrap_err();

    assert_eq!(err.code, "FS_UNUSABLE_NAME");
    assert!(server.received_requests().await.unwrap().is_empty());
}

// ============================================================ 回推已装技能的改动

/// 远端压缩包:只含 weekly-report 一个技能,内容由调用方给。
/// 顶层目录名任意(Gitea 的 zip 有一层仓库目录,解包时剥掉)。
/// 任意技能目录的压缩包(覆盖闸要拿库里的实时内容比一比)。
fn zip_of(slug: &str, md: &str) -> Vec<u8> {
    use std::io::Write as _;
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file(format!("repo/skills/{slug}/SKILL.md"), opts).unwrap();
        w.write_all(md.as_bytes()).unwrap();
        w.finish().unwrap();
    }
    buf
}

/// 任意技能库压缩包端点(`mount_archive` 的泛化:落点路径相同,内容由调用方给)。
async fn mount_archive_of(server: &MockServer, slug: &str, md: &str) {
    mount_archive(server, zip_of(slug, md)).await;
}

fn zip_of_weekly(md: &str) -> Vec<u8> {
    use std::io::Write as _;
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("repo/skills/weekly-report/SKILL.md", opts).unwrap();
        w.write_all(md.as_bytes()).unwrap();
        w.finish().unwrap();
    }
    buf
}

/// 同上,但库根多一份 `authors.json` 把 `weekly-report` 记在 `author` 名下
/// (v8 任务 6:`share_installed` 的归属闸就是从这里读作者的,零新增请求)。
/// 库根带一份 `authors.json` 的压缩包(v8 任务 6:`share_installed` 的归属闸
/// 就是从这里读作者的,零新增请求)。
///
/// 🔴 **`library_slug` 与本地那三个概念刻意不同名**(终审 I-8)。此前这份 fixture
/// 让 **frontmatter `name` / `source.path` 末段 / 磁盘目录名 / 入参 `dir_slug`**
/// 四个概念取同一个值 `weekly-report`,于是归属闸的查询键换成其中**任意**一个,
/// 测试照样绿——本项目记着的空转模式 ③。闸真正的键是
/// `InstalledSkill::library_dir_slug()`(= `source.path` 末段,**技能库里的**目录名),
/// 只有让它单独取一个值,换键才会当场红。
fn zip_of_weekly_by(md: &str, author: &str, library_slug: &str) -> Vec<u8> {
    use std::io::Write as _;
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("repo/authors.json", opts).unwrap();
        w.write_all(
            serde_json::json!({ "authors": { library_slug: { "author": author } } })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        w.start_file(format!("repo/skills/{library_slug}/SKILL.md"), opts).unwrap();
        w.write_all(md.as_bytes()).unwrap();
        w.finish().unwrap();
    }
    buf
}

/// 归属闸那两条用例专用:本地叫 `weekly-report`,**库里叫 `zhoubao`**。
/// 账上的 `source.path` 是唯一说得出"库里叫什么"的地方,把它单独摆开。
const LIBRARY_SLUG: &str = "zhoubao";

fn point_record_at_library_slug(c: &Ctx) {
    let mut state = state_of(c);
    state.installed[0].source.path = format!("skills/{LIBRARY_SLUG}");
    c.store.save_state(&state).unwrap();
}

/// 这台机器上的登录身份(赵文浩 / zhaowh)落进 `config.identities["company"]`。
fn login_as_me(c: &Ctx) {
    let mut config = skillsync_lib::core::state::Config::default();
    config.identities.insert(
        "company".into(),
        Identity { login: "zhaowh".into(), display_name: "赵文浩".into() },
    );
    c.store.save_config(&config).unwrap();
}

/// 账上有一条已改过的 `weekly-report`,准备回推。
fn installed_and_edited(c: &Ctx) -> PathBuf {
    let dir = canonical(c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(c);
    state.installed.push(install_record(c, &dir));
    c.store.save_state(&state).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();
    dir
}

/// 🔴 **v8 任务 6 / D7:改**别人**的技能,core 直接拒,而且一个写请求都不发。**
///
/// 界面那侧已经不摆「贡献更改」按钮了(那是**不摆**);这一条钉的是**不许**
/// ——防的是绕过界面的调用。两层职责不同,不是同一条规则查两遍。
#[tokio::test]
async fn contributing_to_someone_elses_skill_is_refused_without_writing_anything() {
    let (c, env) = ctx();
    installed_and_edited(&c);
    point_record_at_library_slug(&c);
    login_as_me(&c);

    let server = MockServer::start().await;
    // 刻意**不挂**任何写端点:闸没生效的话,这条测试红在别的地方也照样是红的,
    // 而下面对错误码与"零 POST"的正面断言保证它只在该红的时候红成这个样子。
    mount_archive(&server, zip_of_weekly_by(WEEKLY_PRISTINE, "李四", LIBRARY_SLUG)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let err = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .expect_err("库里记的作者是李四,不是我 —— 必须拒");
    assert_eq!(err.code, "REPO_NOT_AUTHOR", "{err:?}");
    assert!(err.message.contains("李四"), "要点名作者是谁:{}", err.message);

    let reqs = server.received_requests().await.unwrap();
    assert!(
        !reqs.iter().any(|r| r.method.as_str() != "GET"),
        "拒绝那一档不许发任何写请求:{:?}",
        reqs.iter().map(|r| (r.method.as_str().to_string(), r.url.path().to_string())).collect::<Vec<_>>()
    );
    // 账本也一个字不动(基线还是改之前那份)。
    let state = state_of(&c);
    assert_eq!(state.installed[0].commit_sha, "aaa");
}

/// 对照组一:库里记的作者就是我 → 照常推得上去。
///
/// 没有它,"`share_installed` 一进门无条件报 `REPO_NOT_AUTHOR`"这个坏实现也能
/// 让上一条通过。(对照组二是 `pushing_local_changes_back_updates_the_books`:
/// 库里**没登记作者**时放行——那一刻我们并不知道"这不是你的"。)
#[tokio::test]
async fn my_own_skill_still_pushes_when_the_library_records_me_as_the_author() {
    let (c, env) = ctx();
    let dir = installed_and_edited(&c);
    login_as_me(&c);

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [ { "path": "skills/weekly-report/SKILL.md", "sha": "oldsha", "type": "blob" } ],
            "truncated": false
        })))
        .mount(&server)
        .await;
    // 展示名那一种写法(`Identity::aliases` 两种都认)。
    mount_archive(&server, zip_of_weekly_by(WEEKLY_PRISTINE, "赵文浩", LIBRARY_SLUG)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .unwrap();
    let share::ShareInstalledOutcome::Submitted(submitted) = outcome else {
        panic!("库里记的作者就是我,应当直接提交:{outcome:?}");
    };
    assert_eq!(submitted.mode, ShareMode::Pushed);
    assert_eq!(state_of(&c).installed[0].content_hash, fsops::dir_content_hash(&dir).unwrap());
}

/// `write_skill(dir, "weekly-report", "原版")` 落盘的同一份字节——远端与账上一致的场景用它。
const WEEKLY_PRISTINE: &str = "---\nname: weekly-report\ndescription: 原版\n---\n正文\n";

async fn mount_archive(server: &MockServer, zip: Vec<u8>) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .mount(server)
        .await;
}

fn install_record(c: &Ctx, dir: &Path) -> InstalledSkill {
    InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "aaa".into(),
        },
        commit_sha: "aaa".into(),
        content_hash: fsops::dir_content_hash(dir).unwrap(),
        origin: None,
        body: None,
        agents: vec![],
        links: vec![LinkRecord { dir: join_rel(&c.home, ".claude/skills").to_string_lossy().into_owned(), mode: LINK_MODE.into() }],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    }
}

/// 🔴 **回推也要过 A-2 的标准校验闸,而且同样排在任何网络请求之前**(终审 C-3)。
///
/// A-2 拍板不复议:「分享前按 Agent Skills 标准全量校验,不合格不让分享」。
/// 任务 6 把闸装在 `share()` 并做对了,而 `share_installed` ——**分享的第二条
/// 通道**——一个字的校验都没有。旗舰场景因此整个漏了:用户在
/// `~/.claude/skills/weekly-report` 开发 → 分享(过闸)→ 继续在 Claude Code 里
/// 迭代时把 frontmatter 的 `name` 改成中文 → 点「分享更新」→ 一个
/// `name ≠ 文件夹名`、非 ASCII 的技能直推进公司技能库,全程零提示。
///
/// 守卫盯的是**请求条数**,与 `share_refuses_non_conforming_skills_before_any_network_call`
/// 同款:把校验挪到 `download_archive` 之后时错误码照样对,只有请求条数会红。
#[tokio::test]
async fn pushing_changes_back_refuses_non_conforming_skills_before_any_network_call() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    // 用户在自己的编辑器里把 name 改成了中文:Claude Code 照样加载,
    // 但开放标准两条都犯(不是 ASCII 小写、且不等于文件夹名)。
    std::fs::write(dir.join("SKILL.md"), "---\nname: 周报生成\ndescription: 我改过\n---\n").unwrap();

    // 全部端点都挂上:真发了请求一定拿得到 200,红的时候一定是因为"发了请求"。
    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    mount_archive(&server, zip_of_weekly(WEEKLY_PRISTINE)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let err = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .unwrap_err();

    assert_eq!(err.code, "FS_SKILL_INVALID");
    assert_eq!(err.detail.as_deref(), Some("nameFormat"));
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        0,
        "不合格的技能连一次探测都不该发出去",
    );
}

/// 对照组:合格的改动照常推得上去。
///
/// 没有它,"`share_installed` 一进门无条件报 `FS_SKILL_INVALID`"这个坏实现
/// 也能让上一条通过。这条由 `pushing_local_changes_back_updates_the_books` 承担
/// ——它推的是一个 `name == 文件夹名` 的合格技能。
#[tokio::test]
async fn pushing_local_changes_back_updates_the_books() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    // 用户改本体 → contentHash 不符
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [ { "path": "skills/weekly-report/SKILL.md", "sha": "oldsha", "type": "blob" } ],
            "truncated": false
        })))
        .mount(&server)
        .await;
    mount_archive(&server, zip_of_weekly(WEEKLY_PRISTINE)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .unwrap();

    let share::ShareInstalledOutcome::Submitted(submitted) = outcome else {
        panic!("远端与账上一致,应当直接提交");
    };
    assert_eq!(submitted.mode, ShareMode::Pushed);
    // 记账更新:contentHash = 当前本地(「已改动」消失),commitSha = 新提交
    let state = state_of(&c);
    assert_eq!(state.installed[0].commit_sha, "newsha1");
    assert_eq!(state.installed[0].content_hash, fsops::dir_content_hash(&dir).unwrap());
    // 请求体:已有文件是 update + 旧 sha
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    assert_eq!(body["files"][0]["operation"], "update");
    assert_eq!(body["files"][0]["sha"], "oldsha");
}

/// 🔴 **v8 任务 3:回推撞上目标受保护 → 一句人话,不再降级开分支 + 提交审核。**
///
/// 这条测试取代了 `review_requested_changes_do_not_touch_the_install_books`
/// (它守的是"走评审时记账一个字不动",而走评审这条路已整体下线)。它守的那条
/// 不变量换了形式活着:**没推成就不更新基线**——现在由"报错时磁盘与账本零变化"
/// 表达,下面正面断言。
#[tokio::test]
async fn pushing_changes_into_a_protected_library_is_reported_not_downgraded() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    let before = state_of(&c).installed[0].clone();
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [], "truncated": false
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "message": "protected"
        })))
        .mount(&server)
        .await;
    mount_archive(&server, zip_of_weekly(WEEKLY_PRISTINE)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let err = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .unwrap_err();

    assert_eq!(err.code, "REPO_PUSH_BLOCKED");
    let reqs = server.received_requests().await.unwrap();
    let contents = reqs
        .iter()
        .filter(|r| r.method.as_str() == "POST" && r.url.path().ends_with("/contents"))
        .count();
    assert_eq!(contents, 1, "只试一次直推,不再降级开分支");
    assert!(
        !reqs.iter().any(|r| r.url.path().ends_with("/pulls")),
        "不许再开审核请求:{:?}",
        reqs.iter().map(|r| r.url.path().to_string()).collect::<Vec<_>>()
    );
    // 没推成 = 基线一个字不动(旧测试守的那条不变量,换了形式)
    let after = state_of(&c).installed[0].clone();
    assert_eq!(after.commit_sha, before.commit_sha);
    assert_eq!(after.content_hash, before.content_hash);
}

/// 🔴 **回推读的是本体,不是 canonical**(v6 二期任务 6)。
///
/// 用户在 `~/.claude/skills/` 下开发这个技能,canonical 上只有一条指向它的链接。
/// 旧实现拿 `canonical.join(dir_slug)` 拼路径,那条路径在本体不住 canonical 时
/// 要么根本不存在(于是对用户说「本地技能内容已不存在」——假话),要么是一条链接。
///
/// ⚠️ fixture 刻意**不建** canonical 那条链接:建了的话两条路读出来的内容一样,
/// 这条测试就分不出实现走的是哪一条(本项目记着的"fixture 让两个概念取同值")。
#[tokio::test]
async fn pushing_changes_back_reads_the_body_not_canonical() {
    let (c, env) = ctx();
    let body = c.home.join(".claude").join("skills").join("weekly-report");
    write_skill(&body, "weekly-report", "原版");
    let mut state = state_of(&c);
    let mut record = install_record(&c, &body);
    record.body = Some(body.to_string_lossy().into_owned());
    state.installed.push(record);
    c.store.save_state(&state).unwrap();
    assert!(
        !canonical(&c).join("weekly-report").exists(),
        "前提:canonical 上什么都没有,拿它拼出来的路径必然读不到内容",
    );
    std::fs::write(body.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [ { "path": "skills/weekly-report/SKILL.md", "sha": "oldsha", "type": "blob" } ],
            "truncated": false
        })))
        .mount(&server)
        .await;
    mount_archive(&server, zip_of_weekly(WEEKLY_PRISTINE)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .expect("本体就在 .claude/skills 里,不该报「内容已不存在」");

    let share::ShareInstalledOutcome::Submitted(_) = outcome else {
        panic!("远端与账上一致,应当直接提交");
    };
    // 推上去的是**本体**里那份改过的内容
    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let json: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    let content = json["files"][0]["content"].as_str().unwrap();
    let decoded = String::from_utf8(
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, content).unwrap(),
    )
    .unwrap();
    assert!(decoded.contains("我改过"), "推的不是本体里的内容:{decoded}");
    // 记账基线跟着本体走
    assert_eq!(
        state_of(&c).installed[0].content_hash,
        fsops::dir_content_hash(&body).unwrap()
    );
}

/// 🔴 **查账用清洗后的记账键,不是技能库里的原始目录名**(欠账:`share.rs` 与
/// `commands::installed_repo_key` 同一根轴)。
///
/// `Weekly-Report` 这样的库目录名装到本地会落成 `weekly-report`(记账键小写化),
/// 而前端手上的 `dirSlug` 是库里的原始写法。按 `dir_slug` 查账必然落空,
/// 用户点「分享更新」只会得到「这个技能不在已获取列表中」。
#[tokio::test]
async fn pushing_changes_back_looks_the_record_up_by_the_sanitized_key() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [], "truncated": false
        })))
        .mount(&server)
        .await;
    mount_archive(&server, zip_of_weekly(WEEKLY_PRISTINE)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    // 传的是**库里的原始目录名**(带大写),账上记的是清洗后的 `weekly-report`
    let outcome = confirmed_push(&client, &c, &env, "Weekly-Report")
        .await
        .expect("按记账键查账应当找得到这条记账");
    assert!(matches!(outcome, share::ShareInstalledOutcome::Submitted(_)));
}

/// 🔴 v8 任务 4:**首次分享也有覆盖档**。换过电脑的作者本机一条记账都没有,
/// 而库里已经有他的这个技能——旧行为是 `Mine` → 直接提交,把库里那一版
/// 静默顶掉。基线为空时按「未知」处理,直接比本地实时 vs 库里实时。
#[tokio::test]
async fn first_share_warns_when_the_library_already_has_my_different_version() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "换了台电脑之后写的");

    let mut config = skillsync_lib::core::state::Config::default();
    config.identities.insert(
        "company".into(),
        Identity { login: "zhaowh".into(), display_name: "赵文浩".into() },
    );
    c.store.save_config(&config).unwrap();
    write_index_cache_with_author(&c, "my-notes", "赵文浩");
    assert!(state_of(&c).shared.is_empty(), "换电脑的前提:本机一条分享记账都没有");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    // 三个值互不相同:本地「换了台电脑之后写的」/ 基线空 / 库里「旧电脑上那一版」
    mount_archive_of(&server, "my-notes", "---\nname: my-notes\ndescription: 旧电脑上那一版\n---\n正文\n").await;
    mount_last_commit(&server, "赵文浩", "zhaowh", "2026-08-01T00:00:00Z").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    // `confirm: None` = 预览轮:这正是确认屏打开时发的那一跳。
    let outcome = share::share(
        &share::ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        share::ShareRequest { registry_id: "company", repo: &repo, dir_slug: "my-notes", confirm: None },
        NOW,
    )
    .await
    .unwrap();

    let ShareOutcome::NeedsConfirm { overwrite: Some(warning), .. } = outcome else {
        panic!("库里已有我的另一版,应当先让用户拍板:{outcome:?}");
    };
    assert_eq!(warning.last_author.as_deref(), Some("赵文浩"));
    assert_eq!(warning.last_at.as_deref(), Some("2026-08-01T00:00:00Z"));
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "覆盖确认档不许发任何写请求");
}

/// 对照组:同一个场景,用户按过「仍然覆盖」→ 照推。
#[tokio::test]
async fn first_share_pushes_once_the_overwrite_is_confirmed() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "换了台电脑之后写的");

    let mut config = skillsync_lib::core::state::Config::default();
    config.identities.insert(
        "company".into(),
        Identity { login: "zhaowh".into(), display_name: "赵文浩".into() },
    );
    c.store.save_config(&config).unwrap();
    write_index_cache_with_author(&c, "my-notes", "赵文浩");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_submit_chain(&server).await;
    mount_archive_of(&server, "my-notes", "---\nname: my-notes\ndescription: 旧电脑上那一版\n---\n正文\n").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = confirmed_share(&client, &c, &env, &repo, "my-notes").await.unwrap();

    assert!(matches!(outcome, ShareOutcome::Shared { .. }), "拍过板的覆盖应当推上去");
}

// ============================================================ 回推前的远端变更检测(M5 任务 1)
//
// 乐观锁(CONFLICT_STALE)只拦"拉 sha 与提交之间"的瞬间竞态;提交用的是**当前**
// 远端 blob sha,所以「我基于旧版改、别人早已推新版」会拿最新 sha 通过校验,
// 静默覆盖对方改动。这一节钉住:远端在获取之后变过 → 一个写请求都不许发。

#[tokio::test]
async fn remote_changed_since_install_needs_decision_and_sends_nothing() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    // 我本地改过
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    // 远端也被别人改过:内容既不是账上那版,也不是我本地这版
    mount_archive(&server, zip_of_weekly("---\nname: weekly-report\ndescription: 别人的新版\n---\n正文\n")).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();

    let share::ShareInstalledOutcome::NeedsConfirm { overwrite: Some(warning), .. } = outcome else {
        panic!("远端变过,应当进冲突档而不是提交");
    };
    // Gitea 源给得出改动历史链接:指向该技能目录在目标分支上的提交历史
    // 没挂 commits 端点 = 取不到"谁/什么时候":**如实留空,不拿空串冒充**
    assert_eq!(warning.last_author, None);
    assert_eq!(warning.last_at, None);
    let url = warning.history_url.expect("Gitea 源应给出历史链接");
    assert!(url.starts_with(&server.uri()), "链接应指向来源 Gitea:{url}");
    assert!(url.contains("/skills/skills/commits/"), "应是提交历史页:{url}");
    assert!(url.contains("skills/weekly-report"), "应聚焦该技能目录:{url}");
    // 守卫断言:一个写请求都没发,记账一个字没动
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "冲突档不许发任何写请求");
    let after = state_of(&c).installed[0].clone();
    assert_eq!(after.commit_sha, "aaa", "冲突档不许动记账");
}

#[tokio::test]
async fn remote_changed_blocks_even_when_local_is_pristine() {
    // 本地没改、远端变了:回推的内容是旧版,照样会覆盖别人的新版。
    // UI 上这个状态本就不显示「分享改动」按钮,core 侧保守方向仍是拦(假设:见分解文档)。
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_archive(&server, zip_of_weekly("---\nname: weekly-report\ndescription: 别人的新版\n---\n正文\n")).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();

    assert!(
        matches!(outcome, share::ShareInstalledOutcome::NeedsConfirm { overwrite: Some(_), .. }),
        "远端变过就该拦,与本地改没改无关"
    );
}

/// 往「最后一次提交」端点挂一条应答(覆盖确认屏要点名"谁、什么时候")。
async fn mount_last_commit(server: &MockServer, full_name: &str, login: &str, at: &str) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/commits"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{
            "sha": "othersha",
            "created": at,
            "author": { "login": login, "full_name": full_name },
            "commit": { "author": { "name": "git-name" } }
        }])))
        .mount(server)
        .await;
}

/// 提交成功那条路要挂的一整套(仓库信息、分支头、树、提交)。
async fn mount_submit_chain(server: &MockServer) {
    mount_repo_info(server, true).await;
    mount_commit_ok(server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [], "truncated": false
        })))
        .mount(server)
        .await;
}

#[tokio::test]
async fn overwrite_warning_names_who_changed_it_and_when() {
    // v8 任务 4 第 5 条:拍板信息要点名"最后由谁、什么时候改的"。
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_archive(&server, zip_of_weekly("---\nname: weekly-report\ndescription: 别人的新版\n---\n正文\n")).await;
    mount_last_commit(&server, "李四", "lisi", "2026-09-10T03:04:05Z").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();

    let share::ShareInstalledOutcome::NeedsConfirm { overwrite: Some(warning), .. } = outcome else {
        panic!("远端变过,应当进覆盖确认档");
    };
    // 展示名优先于登录名(与 authors.json 同一把尺子)
    assert_eq!(warning.last_author.as_deref(), Some("李四"));
    assert_eq!(warning.last_at.as_deref(), Some("2026-09-10T03:04:05Z"));
}

#[tokio::test]
async fn empty_baseline_still_warns_when_local_and_library_differ() {
    // 🔴 v8 任务 4 的核心修复:基线为空**不再跳过检测**。换过电脑、或早年经
    // 别的途径分享过的作者,本机根本没有记账——沿用旧行为就是不弹任何警告
    // 直接覆盖库里那一版。基线为空时按「未知」处理,直接比本地实时 vs 库里实时。
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "我这台电脑上的版本");
    let mut state = state_of(&c);
    let mut record = install_record(&c, &dir);
    record.content_hash = String::new();
    state.installed.push(record);
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    // 三个值互不相同:本地「我这台电脑上的版本」/ 基线空 / 库里「别人的新版」
    mount_archive(&server, zip_of_weekly("---\nname: weekly-report\ndescription: 别人的新版\n---\n正文\n")).await;
    mount_last_commit(&server, "", "lisi", "2026-09-10T03:04:05Z").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();

    let share::ShareInstalledOutcome::NeedsConfirm { overwrite: Some(warning), .. } = outcome else {
        panic!("没有基线也要弹覆盖确认,不能直接覆盖库里那一版");
    };
    // full_name 是空串时退到 login——**空串不算一个人名**
    assert_eq!(warning.last_author.as_deref(), Some("lisi"));
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "覆盖确认档不许发任何写请求");
}

/// 🔴 **v8 任务 5 改写了这条的终态**:它原先叫
/// `empty_baseline_submits_when_local_matches_the_library`,断言"照常提交"
/// ——而"照常提交"正是本期要治的病(内容一模一样还发一笔提交,Gitea 照样建
/// 一个零改动的 commit,同事那三个空的合并请求就是这么来的)。现在这一档短路成
/// 「库里已与本地一致」:一个写请求都不发,顺手把空基线对齐。
#[tokio::test]
async fn an_empty_baseline_realigns_instead_of_pushing_an_empty_commit() {
    // 基线为空、但本地与库里逐字节相同。
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    let mut record = install_record(&c, &dir);
    record.content_hash = String::new();
    state.installed.push(record);
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_submit_chain(&server).await;
    mount_archive(&server, zip_of_weekly(WEEKLY_PRISTINE)).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();

    assert!(
        matches!(outcome, share::ShareInstalledOutcome::AlreadyInSync),
        "内容一致时不该发提交:{outcome:?}"
    );
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "「已一致」不许发任何写请求");
    // 顺手把陈旧(这里是空)基线对齐——不对齐的话那一行会永远显示"和库里不一样",
    // 用户只能一遍遍点分享、一遍遍造空提交。
    assert_eq!(
        state_of(&c).installed[0].content_hash,
        fsops::dir_content_hash(&dir).unwrap(),
        "「已一致」要顺手对齐基线"
    );
}

#[tokio::test]
async fn confirmed_overwrite_pushes_and_realigns_the_baseline() {
    // v8 任务 4 第 6 条:用户按过「仍然覆盖」→ 直推成功 → **基线被更新**。
    // 不更新基线正是同事那个死循环的成因(推上去了,界面还说"库里有新版")。
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n正文\n").unwrap();
    let local_hash = fsops::dir_content_hash(&dir).unwrap();

    let server = MockServer::start().await;
    mount_submit_chain(&server).await;
    // 库里仍是别人的新版:不带 overwrite 时这一跳会被拦下(上面的用例钉着)
    mount_archive(&server, zip_of_weekly("---\nname: weekly-report\ndescription: 别人的新版\n---\n正文\n")).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .unwrap();

    assert!(
        matches!(outcome, share::ShareInstalledOutcome::Submitted(_)),
        "拍过板的覆盖应当推上去"
    );
    let after = state_of(&c).installed[0].clone();
    assert_eq!(after.commit_sha, "newsha1");
    assert_eq!(after.content_hash, local_hash, "覆盖成功后基线必须对齐到刚推上去的内容");
}


// ============================================================ 删除远端文件(v8 任务 5 / D5、D6)
//
// 病灶(实证):分享**只上传、从不删除**——`payload_files` 只发"本地有哪些文件",
// 从不算"远端有、本地没有"的差集。用户在本地删过文件之后,远端会一直留着它,
// 于是两边指纹**永不相等** → 行上永远显示"不一样" → 每次点分享都推一遍相同内容。
// 这一节钉住:差集真的算了、删除真的进了请求体、没确认之前一个写请求都不发。

/// 按给定的 `(技能目录内相对路径, 内容)` 造一份技能库压缩包。
fn zip_with(slug: &str, files: &[(&str, &str)]) -> Vec<u8> {
    use std::io::Write as _;
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (rel, body) in files {
            w.start_file(format!("repo/skills/{slug}/{rel}"), opts).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }
    buf
}

/// 远端文件树:删除与修改都要拿它的 blob sha(Gitea 拿 sha 做乐观锁)。
async fn mount_tree(server: &MockServer, entries: &[(&str, &str)]) {
    let tree: Vec<serde_json::Value> = entries
        .iter()
        .map(|(p, sha)| serde_json::json!({ "path": p, "sha": sha, "type": "blob" }))
        .collect();
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({ "tree": tree, "truncated": false })),
        )
        .mount(server)
        .await;
}

/// 本地删掉一个文件之后分享:那个文件必须**从技能库里删掉**,而不是留在那儿
/// 让两边指纹永远不等。
#[tokio::test]
async fn sharing_deletes_the_files_that_are_gone_locally() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_commit_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(&server)
        .await;
    mount_tree(
        &server,
        &[
            ("skills/weekly-report/SKILL.md", "sha-skill"),
            ("skills/weekly-report/踩过的坑.md", "sha-gone"),
            ("skills/weekly-report/一样的.md", "sha-same"),
            // 别的技能的文件:同一棵树里,**一根汗毛都不许碰**
            ("skills/other/SKILL.md", "sha-other"),
        ],
    )
    .await;
    mount_archive(
        &server,
        zip_with(
            "weekly-report",
            &[
                ("SKILL.md", "---\nname: weekly-report\ndescription: 库里那一版\n---\n正文\n"),
                ("踩过的坑.md", "这份本地已经删了"),
                ("一样的.md", "两边一模一样"),
            ],
        ),
    )
    .await;
    // 本地:改了 SKILL.md、删了「踩过的坑.md」、「一样的.md」原样、新增「新写的.md」
    std::fs::write(dir.join("一样的.md"), "两边一模一样").unwrap();
    std::fs::write(dir.join("新写的.md"), "刚写的").unwrap();
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = confirmed_push(&client, &c, &env, "weekly-report")
        .await
        .unwrap();
    assert!(matches!(outcome, share::ShareInstalledOutcome::Submitted(_)), "{outcome:?}");

    let reqs = server.received_requests().await.unwrap();
    let posted: Vec<_> = reqs.iter().filter(|r| r.method.as_str() == "POST").collect();
    let body: serde_json::Value = serde_json::from_slice(&posted[0].body).unwrap();
    let files = body["files"].as_array().unwrap();
    let op_of = |p: &str| {
        files
            .iter()
            .find(|f| f["path"] == p)
            .map(|f| f["operation"].as_str().unwrap_or("?").to_string())
    };
    assert_eq!(op_of("skills/weekly-report/踩过的坑.md").as_deref(), Some("delete"));
    assert_eq!(op_of("skills/weekly-report/SKILL.md").as_deref(), Some("update"));
    assert_eq!(op_of("skills/weekly-report/新写的.md").as_deref(), Some("create"));
    // 🔴 内容相同的一个都不发——今天那几个空的合并请求正是漏了这条判断
    assert_eq!(op_of("skills/weekly-report/一样的.md"), None, "两边一样的文件不该进请求体");
    assert_eq!(op_of("skills/other/SKILL.md"), None, "别的技能的文件不该被碰");
    // 删除要带远端 blob sha(Gitea 拿它做乐观锁,不给会被整笔拒掉)
    let del = files.iter().find(|f| f["path"] == "skills/weekly-report/踩过的坑.md").unwrap();
    assert_eq!(del["sha"], "sha-gone");
    assert!(del.get("content").is_none(), "删除不该带内容");
}

/// 🔴 有删除时**未确认不得提交**(D6:「绝不静默删除用户文件」对服务端同样适用)。
/// 断言的是"一个写请求都没发",不是返回值好看。
#[tokio::test]
async fn a_plan_with_deletions_is_not_committed_until_confirmed() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    // 先让本地与库里完全一致(基线由此算出),再删掉其中一个文件——这样这条用例
    // 测的就只是"删除要先确认",不会顺带撞上覆盖闸(那是任务 4 的命题)。
    std::fs::write(dir.join("踩过的坑.md"), "这份本地已经删了").unwrap();
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    std::fs::remove_file(dir.join("踩过的坑.md")).unwrap();

    let server = MockServer::start().await;
    mount_archive(
        &server,
        zip_with(
            "weekly-report",
            &[("SKILL.md", WEEKLY_PRISTINE), ("踩过的坑.md", "这份本地已经删了")],
        ),
    )
    .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();
    let share::ShareInstalledOutcome::NeedsConfirm { plan, overwrite, .. } = outcome else {
        panic!("有文件要删,必须先让用户看一眼:{outcome:?}");
    };
    assert_eq!(plan.deleted, vec!["踩过的坑.md".to_string()]);
    assert!(plan.added.is_empty() && plan.modified.is_empty(), "SKILL.md 两边一样:{plan:?}");
    // 库里那一版与账上基线一致 → 没有人顶掉谁,顶部不摆覆盖警告
    assert!(overwrite.is_none(), "没被别人改过就不该摆覆盖警告");
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "没确认之前不许发任何写请求");
    assert_eq!(state_of(&c).installed[0].commit_sha, "aaa", "预览轮不许动记账");
}

/// 「可分享到」区那条路(`share()`)同样要先过确认屏——两条分享通道一个尺子。
#[tokio::test]
async fn the_first_channel_also_previews_before_it_commits() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "本地这一版");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", false).await; // Fresh:库里还没有
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = share::share(
        &share::ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        share::ShareRequest { registry_id: "company", repo: &repo, dir_slug: "my-notes", confirm: None },
        NOW,
    )
    .await
    .unwrap();
    let ShareOutcome::NeedsConfirm { plan, overwrite, .. } = outcome else {
        panic!("预览轮应当回一份清单:{outcome:?}");
    };
    // 首次分享:删除清单**恒空**,确认屏只列新增
    assert_eq!(plan.added, vec!["SKILL.md".to_string()]);
    assert!(plan.deleted.is_empty() && plan.modified.is_empty());
    assert!(overwrite.is_none(), "库里还没有这个技能,没有谁会被顶掉");
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "预览轮不许发任何写请求");
}

/// 「可分享到」区:内容与库里逐字节相同 → 零写请求 + 对齐基线(D5 的正解)。
#[tokio::test]
async fn the_first_channel_reports_already_in_sync_without_pushing() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "一模一样");
    let mut state = state_of(&c);
    state.shared.push(SharedSkill {
        name: "my-notes".into(),
        local_path: dir.to_string_lossy().into_owned(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: "company".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/my-notes".into(),
            git_ref: "main".into(),
        },
        last_pushed_sha: "oldcommit".into(),
        // 陈旧基线:这正是同事那几行"永远显示不一样"的成因
        content_hash: "过时的指纹".into(),
    });
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_archive_of(&server, "my-notes", "---\nname: my-notes\ndescription: 一模一样\n---\n正文\n").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let outcome = confirmed_share(&client, &c, &env, &repo, "my-notes")
        .await
        .unwrap();
    assert!(matches!(outcome, ShareOutcome::AlreadyInSync), "{outcome:?}");
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "内容一致时一个写请求都不该发");
    assert_eq!(
        state_of(&c).shared[0].content_hash,
        fsops::dir_content_hash(&dir).unwrap(),
        "「已一致」要顺手把陈旧基线对齐,否则那一行永远显示「和库里不一样」"
    );
}

// ============================================================ 预览轮与执行轮的绑定(终审 C-1)
//
// 确认屏打开到用户点确认这段时间里,同事完全可能往那个技能目录里推一份新文件。
// 执行轮**重新**下载压缩包、**重算**差集,于是那份文件会进删除清单被真的删掉
// ——而它**从未出现在用户看过的清单上**。铁律 7 与本项目命名过的
// 「确认屏说 A、实际做 B」。修法:预览轮把"这份清单基于库里哪一版"的凭据
// (该技能目录的远端内容指纹)回给前端,执行轮带回来比对,不等就不提交。
//
// 两条通道各一条,判据都是**请求条数**——返回值好看证明不了"没动手"。

/// 「分享改动」通道:两轮之间同事往库里推了一份新文件。
#[tokio::test]
async fn share_changes_refuses_to_commit_a_plan_the_user_never_saw() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    // 本地改一笔,才有东西可推
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();

    // 第一轮:库里只有 SKILL.md
    let server = MockServer::start().await;
    mount_archive(&server, zip_with("weekly-report", &[("SKILL.md", WEEKLY_PRISTINE)])).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let first = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();
    let share::ShareInstalledOutcome::NeedsConfirm { plan, remote_rev, stale, .. } = first else {
        panic!("预览轮应当回一份清单:{first:?}");
    };
    assert!(!stale, "第一轮不是重算出来的");
    assert!(plan.deleted.is_empty(), "用户看到的清单里没有任何删除:{plan:?}");

    // 🔴 两轮之间:同事往这个技能目录里推了一份新文件
    server.reset().await;
    mount_archive(
        &server,
        zip_with(
            "weekly-report",
            &[("SKILL.md", WEEKLY_PRISTINE), ("同事刚加的.md", "别删我")],
        ),
    )
    .await;
    mount_submit_chain(&server).await;
    mount_tree(&server, &[("skills/weekly-report/SKILL.md", "sha-md")]).await;

    // 用户点确认,带的是他看过的那一版的凭据
    let second = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", Some(remote_rev.as_str()), NOW)
        .await
        .unwrap();

    let share::ShareInstalledOutcome::NeedsConfirm { plan, stale, remote_rev: rev2, .. } = second else {
        panic!("库里变了就不许提交,应当退回重看:{second:?}");
    };
    assert!(stale, "要如实告诉用户这是重新算出来的清单");
    assert_ne!(rev2, remote_rev, "凭据要跟着库里那一版走");
    // 正是那份"从未出现在用户看过的清单上却会被删掉"的文件
    assert_eq!(plan.deleted, vec!["同事刚加的.md".to_string()]);
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "用户没看过这份清单,一个写请求都不许发");
    assert_eq!(state_of(&c).installed[0].commit_sha, "aaa", "记账也不许动");
}

/// 对照组:两轮之间库里**没变** → 凭据对得上 → 照推。
/// 少了它,上面那条用"永远退回重看"的实现也能过。
#[tokio::test]
async fn share_changes_commits_when_the_library_is_still_what_the_user_saw() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("weekly-report");
    write_skill(&dir, "weekly-report", "原版");
    let mut state = state_of(&c);
    state.installed.push(install_record(&c, &dir));
    c.store.save_state(&state).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: weekly-report\ndescription: 我改过\n---\n").unwrap();

    let server = MockServer::start().await;
    mount_archive(&server, zip_with("weekly-report", &[("SKILL.md", WEEKLY_PRISTINE)])).await;
    mount_submit_chain(&server).await;
    mount_tree(&server, &[("skills/weekly-report/SKILL.md", "sha-md")]).await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let first = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", None, NOW)
        .await
        .unwrap();
    let share::ShareInstalledOutcome::NeedsConfirm { remote_rev, .. } = first else {
        panic!("预览轮应当回一份清单:{first:?}");
    };

    let second = share::share_installed(&share::ShareClient::Gitea(&client), &client, &c.registry, &env, &c.store, "weekly-report", "main", Some(remote_rev.as_str()), NOW)
        .await
        .unwrap();
    assert!(
        matches!(second, share::ShareInstalledOutcome::Submitted(_)),
        "库里没变、凭据对得上,就该照推:{second:?}"
    );
}

/// 「分享」通道(`share()`)同款:两轮之间库里多了一份文件 → 不提交,重看。
#[tokio::test]
async fn share_refuses_to_commit_a_plan_the_user_never_saw() {
    let (c, env) = ctx();
    let dir = canonical(&c).join("my-notes");
    write_skill(&dir, "my-notes", "本地这一版");

    let mut config = skillsync_lib::core::state::Config::default();
    config.identities.insert(
        "company".into(),
        Identity { login: "zhaowh".into(), display_name: "赵文浩".into() },
    );
    c.store.save_config(&config).unwrap();
    write_index_cache_with_author(&c, "my-notes", "赵文浩");

    let server = MockServer::start().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_archive(&server, zip_with("my-notes", &[("SKILL.md", "---\nname: my-notes\ndescription: 库里那一版\n---\n正文\n")])).await;
    mount_last_commit(&server, "赵文浩", "zhaowh", "2026-08-01T00:00:00Z").await;
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();

    let first = share::share(
        &share::ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        share::ShareRequest { registry_id: "company", repo: &repo, dir_slug: "my-notes", confirm: None },
        NOW,
    )
    .await
    .unwrap();
    let ShareOutcome::NeedsConfirm { plan, remote_rev, .. } = first else {
        panic!("预览轮应当回一份清单:{first:?}");
    };
    assert!(plan.deleted.is_empty(), "用户看到的清单里没有任何删除:{plan:?}");

    server.reset().await;
    mount_skill_exists(&server, "my-notes", true).await;
    mount_archive(
        &server,
        zip_with(
            "my-notes",
            &[
                ("SKILL.md", "---\nname: my-notes\ndescription: 库里那一版\n---\n正文\n"),
                ("同事刚加的.md", "别删我"),
            ],
        ),
    )
    .await;
    mount_last_commit(&server, "赵文浩", "zhaowh", "2026-08-01T00:00:00Z").await;
    mount_submit_chain(&server).await;
    mount_tree(&server, &[("skills/my-notes/SKILL.md", "sha-md")]).await;

    let second = share::share(
        &share::ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        share::ShareRequest {
            registry_id: "company",
            repo: &repo,
            dir_slug: "my-notes",
            confirm: Some(remote_rev.as_str()),
        },
        NOW,
    )
    .await
    .unwrap();

    let ShareOutcome::NeedsConfirm { plan, stale, .. } = second else {
        panic!("库里变了就不许提交,应当退回重看:{second:?}");
    };
    assert!(stale, "要如实告诉用户这是重新算出来的清单");
    assert_eq!(plan.deleted, vec!["同事刚加的.md".to_string()]);
    let posts = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 0, "用户没看过这份清单,一个写请求都不许发");
}
