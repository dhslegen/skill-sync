//! 端到端:**作者在自己的工具目录里开发技能**的完整一圈。
//!
//! 这是 v6 二期的存在理由,也是唯一一条把六个模块串起来跑的测试:
//! `my_skills::build` → `share::share` → `store::refresh_index` → `acquire::precheck`
//! → `acquire::acquire` → 再回 `my_skills::build`。
//!
//! # 场景(用户 2026-08-24 的原话)
//!
//! 「我在 Claude Code 的 skill 目录下开发 skill,没有通过 app 分享、或者关系断了,
//! 我还想取回,并且还在 Claude Code 中继续维护迭代」。
//!
//! # 🔴 这条测试真正要钉住的东西
//!
//! **取回之后本体仍在 `~/.claude/skills/<slug>`**,不是被搬进 canonical。
//! 「本体只有一份、住在它现在所在的地方、永不搬动」是整期对用户的核心承诺,
//! 而它在任何单模块测试里都看不见——`acquire` 那侧只知道 `home.body` 是个路径,
//! `share` 那侧只知道自己往 canonical 补了条链接,谁都不负责回答"用户在
//! Claude Code 里打开的还是不是同一个文件夹"。
//!
//! 断言分两层,缺一层都能被绕过:
//! - **磁盘层**:`~/.claude/skills/<slug>/SKILL.md` 里是库里那一版的内容,
//!   `~/.agents/skills/<slug>` 仍是一条指向它的链接;
//! - **账本层**:`state.installed[].body` 仍指着 `.claude` 那个路径。
//!   只断言磁盘的话,"内容对了但账本改指 canonical"照样能过,而下一次
//!   `converge::locate` 就会按账本把本体解析到别处。
//!
//! # 状态断言的口径
//!
//! 「我的技能」每一行的状态(草稿 / 库里有新版 / 有改动没分享)是**前端**
//! `src/lib/ownership.ts::sharedState` 算出来的,core 不算第二份。所以这里
//! 断言的是**喂给那张判定表的量**,并在注释里标出它对应表里的哪一档——
//! 在测试里照抄一份判定表反而会造出第二个真相,口径漂了两边照样全绿。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireOutcome, AcquireRequest, Precheck, Stage};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::my_skills;
use skillsync_lib::core::ownership::{Identity, Relation};
use skillsync_lib::core::registry;
use skillsync_lib::core::share::{self, ShareMode, ShareOutcome};
use skillsync_lib::core::state::{Config, State, Store};
use skillsync_lib::core::store as store_index;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-08-26T09:00:00.000Z";
const SLUG: &str = "weekly-report";
/// 作者在 Claude Code 里开发技能的地方。**刻意不是 canonical**。
const TOOL_DIR: &str = ".claude/skills";

// ============================================================ 环境

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
    builtin: registry::BuiltinSource,
    /// **绝不用默认的 `SYSTEM_TRASH`**:这条测试会覆盖一份真实的本体,
    /// 不注入沙盒就会把产物丢进这台机器真实的废纸篓,而"旧版进了废纸篓"
    /// 这半断言也根本写不出来。
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
    // 落点在临时 HOME 之外:废纸篓自己被当成一个技能目录扫进来就毁了整条断言
    let trash = fsops::SandboxTrash::new(home.join("..").join("e2e-author-loop-trash"));
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
            builtin: registry::BuiltinSource {
                base_url: Some("http://gitea.internal:3000"),
                repo: Some(("skills", "skills")),
                branch: "main",
            },
            trash,
        },
        env,
    )
}

impl Ctx {
    /// 本体所在:`~/.claude/skills/<slug>`。
    fn body(&self) -> PathBuf {
        self.home.join(TOOL_DIR).join(SLUG)
    }
    /// canonical 上那条(应当是)指向本体的链接。
    fn canonical(&self) -> PathBuf {
        self.home.join(".agents/skills").join(SLUG)
    }
    fn state(&self) -> State {
        self.store.load_state().map(|l| l.value).unwrap_or_default()
    }
    fn config(&self) -> Config {
        self.store.load_config().map(|l| l.value).unwrap_or_default()
    }
    fn rows(&self, env: &TmpEnv) -> Vec<my_skills::InstalledRow> {
        let installer = Installer::new(&self.registry, env).with_trasher(&self.trash);
        my_skills::build(
            &installer,
            &self.registry,
            env,
            &self.store,
            &self.builtin,
            &self.config(),
            &self.state(),
        )
        .unwrap()
    }
}

fn me() -> Identity {
    Identity {
        login: "zhaowh".into(),
        display_name: "赵文浩".into(),
    }
}

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

/// 写一份**合规**的技能:`name` 必须等于文件夹名(Agent Skills 标准,
/// 也是 v6 二期分享闸的判据),否则第 2 步会被 `ShareBlock::NameMismatch` 拦下,
/// 整条闭环就走不到取回那一步。
fn write_skill(dir: &Path, body: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {SLUG}\ndescription: 汇总本周工作\n---\n\n{body}\n"),
    )
    .unwrap();
}

fn skill_md(c: &Ctx) -> String {
    std::fs::read_to_string(c.body().join("SKILL.md")).unwrap()
}

// ============================================================ 假技能库

/// 技能库的压缩包:`skills/<slug>/SKILL.md` + 库根 `authors.json`。
///
/// `authors.json` 是「这是不是我分享的」的**唯一判据**(`ownership::relation`),
/// 分享那一步真实的 Gitea 会由 `share::share` 自己写进去;这里的 wiremock 直接
/// 把它摆进压缩包,等价于"同事的审核已经合并了,归因也在里面"。
fn library_zip(body: &str, author: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let plain: zip::write::SimpleFileOptions = Default::default();
        w.add_directory("skills/", plain).unwrap();
        w.start_file("skills/authors.json", plain).unwrap();
        std::io::Write::write_all(
            &mut w,
            serde_json::json!({ "authors": { SLUG: { "author": author } } })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        w.start_file(format!("skills/skills/{SLUG}/SKILL.md"), plain).unwrap();
        std::io::Write::write_all(
            &mut w,
            format!("---\nname: {SLUG}\ndescription: 汇总本周工作\n---\n\n{body}\n").as_bytes(),
        )
        .unwrap();
        w.finish().unwrap();
    }
    buf
}

/// 分享那一步要用的四个端点:同名预检(404 = 库里还没有)、库信息(可直推)、
/// 当前登录用户、提交。`authors.json` 的读取一并给 404(库里还没有归因文件)。
///
/// ⚠️ **刻意不挂 `branches/main`**:分享判"能不能直推"读的是
/// `repo_info.permissions.push`,整条路一次都不问分支头。挂一份 v1 的分支头
/// 只会与下面 [`mount_library_v2`] 那份撞在一起——**wiremock 按先注册优先匹配**,
/// 先挂的那份会永远赢,索引就再也刷不到第二版(第一版实现真踩了这个,
/// 报错是「第二版的 mock 没有盖住第一版」)。
async fn mount_share_endpoints(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path(format!("/api/v1/repos/skills/skills/contents/skills/{SLUG}/SKILL.md")))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"message": "GetContentsOrList"})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/contents/authors.json"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"message": "GetContentsOrList"})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main",
            "permissions": { "admin": false, "push": true, "pull": true },
            "empty": false
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "login": "zhaowh", "full_name": "赵文浩"
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "sha-v1", "html_url": "http://x/commit/sha-v1" }
        })))
        .mount(server)
        .await;
}

/// 同事经审核把库里那份改成了 v2:分支头换了 sha,压缩包换了内容。
///
/// 这是全局**唯一**一份 `branches/main`(理由见 [`mount_share_endpoints`])。
/// 为免读者靠猜,调用点有一条正面断言:刷新索引之后 `commit_sha` 必须是 `sha-v2`。
async fn mount_library_v2(server: &MockServer, author: &str) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": "sha-v2", "timestamp": "2026-08-26T09:30:00+08:00" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(library_zip("第二版正文", author)))
        .mount(server)
        .await;
}

async fn refresh_index(server: &MockServer, c: &Ctx) -> store_index::StoreIndex {
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();
    let cache = store_index::cache_path(c.store.dir(), registry::BUILTIN_REGISTRY_ID, &repo);
    let (index, _) = store_index::refresh_index(&client, &repo, registry::BUILTIN_REGISTRY_ID, &cache, false, 0)
        .await
        .unwrap();
    index
}

// ============================================================ 闭环

/// 作者闭环:在 `~/.claude/skills` 里开发 → 出现在「我的技能」→ 分享 →
/// 库里被同事改过 → 取回 → **继续在原地编辑同一份文件**。
#[tokio::test]
async fn author_develops_in_a_tool_dir_shares_gets_edited_pulls_back_and_keeps_editing_in_place() {
    let (c, env) = ctx();
    let server = MockServer::start().await;
    mount_share_endpoints(&server).await;

    // 登录:身份落 config.identities,`share`/`precheck` 都从这里离线取
    let mut config = Config::default();
    config.identities.insert(registry::BUILTIN_REGISTRY_ID.into(), me());
    c.store.save_config(&config).unwrap();

    // ────────────── ① 在 Claude Code 的技能目录下开发
    write_skill(&c.body(), "第一版正文");
    assert!(!c.canonical().exists(), "开发阶段 canonical 上什么都不该有");

    let rows = c.rows(&env);
    assert_eq!(rows.len(), 1, "工具目录里的技能就该直接出现在「我的技能」:{rows:?}");
    let row = &rows[0];
    assert_eq!(row.dir_slug, SLUG);
    // → 前端判定表第 2 档 `draft`「尚未分享」:关系是草稿,且没有多版本抢在前面
    assert_eq!(row.relation, Relation::Draft);
    assert!(row.versions.len() <= 1, "只有一份实体,不该要求拍板:{:?}", row.versions);
    // 「这台电脑上」那一栏指的是本体现在住的地方,不是 canonical
    assert_eq!(Path::new(&row.body), c.body(), "「在哪」必须如实指向工具目录里的本体");
    assert!(row.share_blocked.is_none(), "合规技能不该被分享闸拦住:{:?}", row.share_blocked);

    // ────────────── ② 分享
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();
    let outcome = share::share(
        &share::ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        &c.trash,
        share::ShareRequest {
            registry_id: registry::BUILTIN_REGISTRY_ID,
            repo: &repo,
            dir_slug: SLUG,
            confirmed: true,
        },
        NOW,
    )
    .await
    .unwrap();
    let ShareOutcome::Shared { mode, commit_sha, .. } = outcome else { panic!("应当分享成功,不该落进覆盖确认档") };
    assert_eq!(mode, ShareMode::Pushed);
    assert_eq!(commit_sha, "sha-v1");

    // 🔴 本体没有搬家,canonical 上只多了一条指向它的链接
    assert!(c.body().join("SKILL.md").is_file(), "分享不许动本体");
    assert_eq!(
        fsops::read_link_target(&c.canonical()),
        Some(fsops::normalize(&c.body())),
        "canonical 该是一条指向本体的链接,不是一份复制品"
    );
    // 分享同时建起了记账基线(没有它,作者取回时会落进"没有基线"那一档)
    let recorded = c.state();
    assert_eq!(recorded.installed.len(), 1);
    assert_eq!(recorded.installed[0].commit_sha, "sha-v1");
    assert_eq!(
        recorded.installed[0].body.as_deref().map(Path::new),
        Some(c.body().as_path()),
        "账上要如实记着本体不在 canonical"
    );
    assert!(c.trash.trashed().is_empty(), "分享全程不该删掉任何东西:{:?}", c.trash.trashed());

    // ────────────── ③ 同事经审核把库里那份改成了第二版
    mount_library_v2(&server, "赵文浩").await;
    let index = refresh_index(&server, &c).await;
    assert_eq!(index.commit_sha, "sha-v2", "第二版的 mock 没有盖住第一版");
    let remote_hash = index.skills.iter().find(|s| s.dir_slug == SLUG).unwrap().content_hash.clone();

    let rows = c.rows(&env);
    let row = &rows[0];
    // → 前端判定表第 7 档 `remoteAhead`「库里有新版」:有基线、本地没改、库里变了
    assert_eq!(row.relation, Relation::Shared, "库里记的作者是我,这就是「我分享的」");
    assert!(row.local_present);
    assert!(!row.content_hash.is_empty(), "有基线才轮得到第 5–8 档");
    assert!(!row.local_modified, "本地一个字没改");
    assert_ne!(remote_hash, row.content_hash, "库里那一版与基线不同 = remoteChanged");

    // ────────────── ④ 取回
    let checked = {
        let installer = Installer::new(&c.registry, &env).with_trasher(&c.trash);
        acquire::precheck(
            &installer,
            &c.registry,
            &env,
            &c.state(),
            SLUG,
            "sha-v2",
            Some(&repo),
            acquire::PrecheckContext {
                me: Some(&me()),
                author: Some("赵文浩"),
                remote_content_hash: Some(&remote_hash),
            },
        )
        .unwrap()
    };
    // 🔴 作者取回自己分享的技能,永远不许落进"这个目录不是本应用装的"那一档
    assert_eq!(
        checked,
        Precheck::Mine {
            local_changed: false,
            remote_changed: true
        },
        "作者 + 本地没改 + 库里有新版 = 直接可以装,不该弹拍板"
    );

    let stages = std::sync::Mutex::new(Vec::new());
    let sink = |s: Stage| stages.lock().unwrap().push(s);
    let out = acquire::acquire(
        &client,
        &c.registry,
        &env,
        &c.store,
        AcquireRequest {
            source: acquire::SourceMeta {
                registry_id: registry::BUILTIN_REGISTRY_ID,
                kind: "gitea",
                base_url: &server.uri(),
            },
            repo: &repo,
            dir_slug: SLUG,
            agent_names: &["claude-code".to_string()],
            resolution: None,
        },
        NOW,
        0,
        &c.trash,
        &sink,
    )
    .await
    .unwrap();
    assert!(
        matches!(out, AcquireOutcome::Installed { local_kept: false, .. }),
        "作者本地没改动,取回就该直接装下来:{out:?}"
    );

    // ────────────── ⑤ 🔴 整期的核心承诺:同一份文件,原地更新
    assert!(
        skill_md(&c).contains("第二版正文"),
        "取回之后 ~/.claude/skills 里那份就该是库里的新版"
    );
    assert_eq!(
        fsops::read_link_target(&c.canonical()),
        Some(fsops::normalize(&c.body())),
        "canonical 仍是一条指向本体的链接——本体没有被搬进 canonical"
    );
    assert!(
        !fsops::normalize(&c.body()).starts_with(fsops::normalize(&c.home.join(".agents/skills"))),
        "本体的位置一个字都不许变"
    );
    // 账本层:只断言磁盘的话,"内容对了但账改指 canonical"照样能过,
    // 而下一次 locate 就会按账本把本体解析到别处。
    let after = c.state();
    assert_eq!(
        after.installed[0].body.as_deref().map(Path::new),
        Some(c.body().as_path()),
        "账上记的本体位置也不许变"
    );
    assert_eq!(after.installed[0].commit_sha, "sha-v2");
    // 旧版进了废纸篓,不是被直接删掉
    let trashed = c.trash.trashed();
    assert_eq!(trashed.len(), 1, "旧版应当整份进废纸篓:{trashed:?}");
    assert_eq!(fsops::normalize(&trashed[0]), fsops::normalize(&c.body()));

    // ────────────── ⑥ 继续在原地编辑
    write_skill(&c.body(), "我又改了一版");
    let rows = c.rows(&env);
    let row = &rows[0];
    // → 前端判定表第 6 档 `localAhead`「有改动没分享」
    assert_eq!(row.relation, Relation::Shared);
    assert!(!row.content_hash.is_empty());
    assert!(row.local_modified, "在原地编辑的内容必须被认出来");
    assert_eq!(
        row.content_hash, remote_hash,
        "库里没再变,所以 remoteChanged 为假——这一档才是 localAhead 而不是 both"
    );
    assert_eq!(Path::new(&row.body), c.body(), "一圈下来,本体始终是同一个文件夹");
}
