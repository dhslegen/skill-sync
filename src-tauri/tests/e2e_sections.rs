//! 端到端(v7 任务 9;v8 任务 6 改写终点):**一个"安装自公司技能库"的技能被
//! 本地改过之后会怎样**的完整一圈。
//!
//! `my_skills::build`(三区判据)→ `acquire::acquire`(取回)→ 本地编辑 →
//! `share::share_installed`(**被 core 拒**)→ 再回 `my_skills::build`。
//!
//! # 🔴 v8 任务 6 起「贡献更改」整条下线(D7)
//!
//! 这个文件原先走到底:贡献更改 → 直推进库 → 基线对齐 → 两侧一致。**那条路
//! 已经没有了**。内网实测 38 个技能 / 5 位作者,`authors.json` 里贡献者字段一个
//! 都没有——"改别人的技能"这件事从未真正发生过;而它今天走的是提交审核
//! (v8 任务 3 已砍),留着就是"点了之后什么都不会发生"。用户拍板:**这个 app
//! 的定位是分发,不是协作编辑**;想改别人的技能,说一声比什么机制都快。
//!
//! 所以终态变成:行上如实说一句「和库里的不一样」,出路是「改用库里的版本」
//! 或者直接联系作者。core 这一侧是**不许**(界面那一侧是**不摆**,两层职责
//! 不同,不是同一条规则查两遍)。
//!
//! # 断言口径(与 `e2e_author_loop.rs` 同一套纪律)
//!
//! 磁盘层与账本层分开断言——只断言磁盘的话,"内容对了但账本没有对应记录"照样能过;
//! 只断言账本的话,"账本说成功但本体其实没改"也一样能过。步骤③额外多断言一层
//! **网络请求本身**(零写请求),这是"拒绝那一档磁盘与远端都零动作"唯一的正面证据。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireOutcome, AcquireRequest, Stage};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::my_skills;
use skillsync_lib::core::ownership::{Identity, Relation, Section};
use skillsync_lib::core::registry;
use skillsync_lib::core::share::{self, ShareClient};
use skillsync_lib::core::state::{Config, State, Store};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-08-29T09:00:00.000Z";
const SLUG: &str = "weekly-report";

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
    /// **绝不用默认的 `SYSTEM_TRASH`**(既有教训,见 `e2e_author_loop.rs`):
    /// 这条测试会取回并落盘,不注入沙盒就会写进这台机器真实的系统废纸篓。
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
    let trash = fsops::SandboxTrash::new(home.join("..").join("e2e-sections-trash"));
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
    /// 本次以"取回"(不是"作者在工具目录里开发")为起点,本体因此落在 canonical。
    fn body(&self) -> PathBuf {
        self.home.join(".agents/skills").join(SLUG)
    }
    fn state(&self) -> State {
        self.store.load_state().map(|l| l.value).unwrap_or_default()
    }
    fn config(&self) -> Config {
        self.store.load_config().map(|l| l.value).unwrap_or_default()
    }
    fn rows(&self, env: &TmpEnv) -> Vec<my_skills::InstalledRow> {
        let installer =
            skillsync_lib::core::installer::Installer::new(&self.registry, env).with_trasher(&self.trash);
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

// ============================================================ 假技能库

/// 库里那份技能的压缩包:`skills/skills/<slug>/SKILL.md` + 库根 `authors.json`
/// (归到 `author`,与「我」不同名,保证这一行落在「安装自」而不是「已分享到」区)。
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

fn skill_md(c: &Ctx) -> String {
    std::fs::read_to_string(c.body().join("SKILL.md")).unwrap()
}

fn write_skill(dir: &Path, body: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {SLUG}\ndescription: 汇总本周工作\n---\n\n{body}\n"),
    )
    .unwrap();
}

/// 库的第一版:同事「李四」分享的,主线上还没有任何我贡献过的痕迹。
/// `.up_to_n_times(2)`:分支头恰好被取回(①)与贡献更改的 `submit`(③)各问一次
/// ——两次都还没轮到 PR 合并,所以答案一直是 v1 的 sha。third+ 次请求(④ 的索引刷新)
/// 落到之后才挂的 v2 mock 上(wiremock 按注册顺序匹配,先注册且未耗尽的赢)。
async fn mount_library_v1(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": "sha-v1", "timestamp": "2026-08-29T08:00:00+08:00" }
        })))
        .up_to_n_times(2)
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(wiremock::matchers::path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        // 配额 2:① 取回一次;③ 被拒的那一跳一次(归属闸读的是这份压缩包里的
        // 库根 authors.json —— 零新增请求,闸在下载之后、任何写请求之前)
        .respond_with(ResponseTemplate::new(200).set_body_bytes(library_zip("库里的初版正文", "李四")))
        .up_to_n_times(2)
        .mount(server)
        .await;
}

// ============================================================ 闭环

/// 取回 → 三区落"安装自" → 本地改 → 试着推回去被 core 拒 → 磁盘与账本零变化。
#[tokio::test]
async fn a_skill_installed_from_the_company_library_cannot_be_pushed_back_by_a_non_author() {
    let (c, env) = ctx();
    let server = MockServer::start().await;
    mount_library_v1(&server).await;

    // 登录:身份落 config.identities —— 与库里记的作者「李四」不同名,
    // 这一行才会落进「安装自」而不是「已分享到」。
    let mut config = Config::default();
    config.identities.insert(registry::BUILTIN_REGISTRY_ID.into(), me());
    c.store.save_config(&config).unwrap();

    // ────────────── ① 取回
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let repo = repo_ref();
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
        "首次取回没有本地内容可保留:{out:?}"
    );

    let baseline_hash = fsops::dir_content_hash(&c.body()).unwrap();
    assert!(skill_md(&c).contains("库里的初版正文"));

    let rows = c.rows(&env);
    assert_eq!(rows.len(), 1, "取回之后应该出现在「我的技能」:{rows:?}");
    let row = &rows[0];
    assert_eq!(row.dir_slug, SLUG);
    // 判据三支(设计决策 #3):在库里 ∧ 内容/记录/作者任一命中;作者是「李四」不是我 → Installed
    assert_eq!(row.relation, Relation::Installed, "库里记的作者不是我 = 「安装自」");
    assert_eq!(row.section, Section::InstalledFrom);
    assert!(!row.local_modified, "刚取回,内容与基线相同");
    assert!(row.share_blocked.is_none());
    assert_eq!(row.content_hash, baseline_hash);

    // ────────────── ② 本地改
    write_skill(&c.body(), "我贡献的正文");
    let edited_hash = fsops::dir_content_hash(&c.body()).unwrap();
    assert_ne!(edited_hash, baseline_hash);

    let rows = c.rows(&env);
    let row = &rows[0];
    // 这一元组就是前端 rowAction 判定表(installedFrom 分支)选中
    // 「和库里的不一样」(v8 任务 6 起取代「贡献更改」)的全部依据:
    // localModified 为真、这一刻 remoteChanged 为假(库还没变)。
    assert!(row.local_modified, "编辑之后必须被认出来");
    assert_eq!(row.content_hash, baseline_hash, "基线不因本地编辑而动");
    assert!(row.share_blocked.is_none(), "编辑后内容仍合规");
    assert_eq!(row.section, Section::InstalledFrom, "本地改动不改变这一行归属的区");

    // ────────────── ③ 「贡献更改」已下线:core 直接拒,且一个写请求都不发
    //
    // 🔴 **v8 任务 6 / D7**:内网实测 38 个技能 / 5 位作者,`authors.json` 里贡献者
    // 字段一个都没有——"改别人的技能"这件事从未真正发生过。界面自此不摆那颗按钮
    // (**不摆**),core 这一道是**不许**,防的是绕过界面的调用。两层职责不同,
    // 不是同一条规则查两遍。
    //
    // 刻意**不挂**任何写端点:闸真的生效时,一个写请求都发不出去。
    let err = share::share_installed(
        &ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        SLUG,
        &repo.branch,
        // 作者闸排在确认凭据之前,所以这里给什么值都一样;给 `Some` 而不是 `None`
        // 是为了保住这条用例的鉴别力——闸被拿掉时它必须真的走到"要提交"那一侧
        // (那时 `expect_err` 会当场红,因为拿到的是 `NeedsConfirm`)。
        Some("sha256:the-user-saw-this"),
        NOW,
    )
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

    // ────────────── ④ 磁盘与账本都一个字没动 → 行上仍然是"和库里的不一样"
    //
    // 这就是 D7 给这条路定的终态:主按钮不再是分享,行上如实说一句
    // 「和库里的不一样」,出路是「改用库里的版本」或者直接联系作者李四。
    let after = c.state();
    assert_eq!(after.installed[0].content_hash, baseline_hash, "拒绝那一档不许动基线");
    assert!(after.shared.is_empty());
    assert!(skill_md(&c).contains("我贡献的正文"), "更不许动本体");

    let rows = c.rows(&env);
    let row = &rows[0];
    assert_eq!(row.section, Section::InstalledFrom);
    assert!(row.local_modified, "本地与库里仍然不一样(前端据此显示「和库里的不一样」)");
    assert_eq!(row.relation, Relation::Installed);
}
