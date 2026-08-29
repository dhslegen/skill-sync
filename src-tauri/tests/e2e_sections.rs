//! 端到端(v7 任务 9):**一个"安装自公司技能库"的技能被本地改过、贡献回库**的完整一圈。
//!
//! `my_skills::build`(三区判据)→ `acquire::acquire`(取回)→ 本地编辑 →
//! `share::share_installed`(贡献更改,恒 `force_review: true`)→ 再回 `my_skills::build`
//! → 模拟 PR 合并(库里内容变成用户贡献的那一版)→ 再回 `my_skills::build`。
//!
//! # 🔴 与任务书叙述的两处偏离(写在最前面,交复审核验)
//!
//! 任务书(`docs/v7-任务分解.md` 任务 9)的伪代码写着"提交走评审 → 再次
//! `installed_list` 时该行显示审核中 → 模拟 PR 合并 → 回到"安装自 · 有更新""。
//! 逐条查证后,这句叙述与已拍板的设计**在两处对不上**,本测试按**设计文档 + 已实现的
//! 代码**走,不按任务书的叙述走(与本期 Task 1/3/8 已发生过的"实现者纠正任务书缺陷"
//! 同一种处置,证据链如下):
//!
//! 1. **"审核中"是「可分享到」区专属,不适用于「安装自」区**。
//!    `docs/设计-v7-我的技能重设计.md` 决策 #4 逐字写着「审核中 → 留在**「可分享到」**」,
//!    决策 #7 的"安装自"那一行只有三种主按钮(更新/库里有新版.../贡献更改),没有"审核中"这一档;
//!    `docs/v7-任务分解.md` 第 33 行(任务 2 的范围裁定)明写
//!    「**「贡献更改」不新造路**:… 前端对 `relation == "installed"` 的行**恒传 `true`**」
//!    ——即"贡献更改"只是给已有的 `skill_share_changes`/`force_review` 传参,不新增任何
//!    候选/网络查询/DTO 字段。代码现状与设计一致:`my_skills::has_review_candidates` /
//!    `fill_review_from_pulls` / `fill_review_from_records`(`src/core/my_skills.rs`)三处
//!    都显式 `.filter(|r| r.section == ownership::Section::Shareable)`,`share_installed`
//!    走评审时也不写任何 `state.shared` 记录(模块头原文「走了评审 → **记账一个字不动**」)。
//!    在最后一个任务里把"审核中"扩到「安装自」区,需要新增候选闸 + 前端 `rowAction` 分支
//!    ——这是一次会改变已批准设计的跨任务改动,不该由收尾任务顺手做。
//! 2. **"回到安装自·有更新"这个终态在当前实现下不可达,真实终态是"库里有新版…"
//!    (三选一冲突档)那一档,即 `RowAction::conflict` 而非 `update`**。
//!    `local_modified` 与 `remoteChanged` 判的都是"disk/library 相对 `content_hash`
//!    这个安装基线"(`my_skills.rs:620` / `src/store/my-skills.ts::remoteContentDiffers`
//!    比的都是 `record.content_hash`/`skill.contentHash`,不是彼此)。`share_installed`
//!    对 `ShareMode::ReviewRequested` 明确**不更新**这个基线(同一处注释:「改动没进
//!    main,标记消失等于把它藏起来」)。PR 合并后,库里的新内容与用户本地内容相同,
//!    但两者都与"未编辑前"的旧基线不同——`local_modified` 与 `remoteChanged` 因此
//!    **同时为真**,`rowAction`(`src/lib/ownership.ts:110`)的短路顺序是
//!    `localModified && remoteChanged → conflict` 排在单纯 `remoteChanged → update`
//!    之前,故终态是 `conflict`。本测试断言的正是这个真实元组,而不是任务书写的那句话。
//!
//! 两处偏离都已交给用户/复审核验(见任务报告),**不是自行悄悄改写测试意图**。
//!
//! # 断言口径(与 `e2e_author_loop.rs` 同一套纪律)
//!
//! 磁盘层与账本层分开断言——只断言磁盘的话,"内容对了但账本没有对应记录"照样能过;
//! 只断言账本的话,"账本说贡献成功但本体其实没改"也一样能过。步骤③额外多断言一层
//! **网络请求本身**(head 分支前缀、提交矩阵砍掉直推),这是本任务书唯一点名要测的东西。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireOutcome, AcquireRequest, Stage};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{self, GiteaClient, RepoRef};
use skillsync_lib::core::my_skills;
use skillsync_lib::core::ownership::{Identity, Relation, Section};
use skillsync_lib::core::registry;
use skillsync_lib::core::share::{self, ShareClient, ShareInstalledOutcome, ShareMode};
use skillsync_lib::core::state::{Config, State, Store};
use skillsync_lib::core::store as store_index;
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
        .respond_with(ResponseTemplate::new(200).set_body_bytes(library_zip("库里的初版正文", "李四")))
        .up_to_n_times(1)
        .mount(server)
        .await;
}

/// 库的第二版:「贡献更改」开出的合并请求被同事合并了 —— 库里的内容与用户本地贡献的
/// 一致。挂载时机**必须晚于**步骤③(v1 的两次配额届时已经用完,见 [`mount_library_v1`])。
async fn mount_library_v2(server: &MockServer, merged_body: &str) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": "sha-v2", "timestamp": "2026-08-29T09:30:00+08:00" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(wiremock::matchers::path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(library_zip(merged_body, "李四")))
        .mount(server)
        .await;
}

/// 「贡献更改」(`share::share_installed`,`force_review: true`)要用到的端点:
/// 仓库信息(有推权限)、`git/trees`(更新路径要拿远端 blob sha)、当前登录用户
/// 与库根 `authors.json`(归因维护,读 404 = 库里还没有这份文件)、提交、开合并请求。
async fn mount_contribute_endpoints(server: &MockServer) {
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
        .and(wiremock::matchers::path_regex(r"^/api/v1/repos/skills/skills/git/trees/sha-v1$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [
                { "path": format!("skills/{SLUG}/SKILL.md"), "sha": "old-blob-sha", "type": "blob" }
            ],
            "truncated": false
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
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/contents/authors.json"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"message": "GetContentsOrList"})))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "commit-with-my-edit", "html_url": "http://x/commit/commit-with-my-edit" }
        })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "html_url": "http://x/pulls/42", "number": 42
        })))
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

/// 取回 → 三区落"安装自" → 本地改 → 贡献更改(恒走评审)→ 再回「我的技能」→
/// 模拟 PR 合并 → 再回「我的技能」。
#[tokio::test]
async fn a_skill_installed_from_the_company_library_can_be_edited_and_contributed_back() {
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
    // `review` 恒 None 是 `my_skills::build` 自身的构造行为(三处构造点都是如此,
    // 与 section 无关),这条断言只是走查这个字段确实存在、值符合预期——它**不是**
    // "安装自区不参与审核候选"这个判据的证明,那件事有专门的正面测试
    // (`tests/review_state.rs::an_installed_from_row_with_a_shared_record_is_never_marked_under_review`,
    // 直接调 `fill_review_from_records`,只有那条测试删掉候选闸才会变红)。
    assert!(row.review.is_none());
    assert!(row.share_blocked.is_none());
    assert_eq!(row.content_hash, baseline_hash);

    // ────────────── ② 本地改
    write_skill(&c.body(), "我贡献的正文");
    let edited_hash = fsops::dir_content_hash(&c.body()).unwrap();
    assert_ne!(edited_hash, baseline_hash);

    let rows = c.rows(&env);
    let row = &rows[0];
    // 这一元组就是前端 rowAction 判定表(installedFrom 分支)选中「贡献更改」的全部依据:
    // localModified 为真、这一刻 remoteChanged 为假(库还没变)、没有被分享闸拦住。
    assert!(row.local_modified, "编辑之后必须被认出来");
    assert_eq!(row.content_hash, baseline_hash, "基线不因本地编辑而动");
    assert!(row.share_blocked.is_none(), "编辑后内容仍合规");
    assert_eq!(row.section, Section::InstalledFrom, "本地改动不改变这一行归属的区");

    // ────────────── ③ 贡献更改(恒 `force_review: true`,不看权限矩阵)
    mount_contribute_endpoints(&server).await;
    let outcome = share::share_installed(
        &ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        SLUG,
        &repo.branch,
        true, // force_review
        NOW,
    )
    .await
    .unwrap();
    let ShareInstalledOutcome::Submitted(submitted) = outcome else {
        panic!("远端内容基线为空则跳过变更检测,应当直接提交:{outcome:?}");
    };
    assert_eq!(submitted.mode, ShareMode::ReviewRequested, "force_review 恒走评审,不许直推");

    // 🔴 断言请求本身:head 是 `skillsync/` 打头的分支;直推路径(不带 new_branch 的
    // /contents 请求)一个都不该出现 —— 这是「提交矩阵砍掉直推」这条硬约束唯一的
    // 正面证据,只断言返回值的 mode 分不清"没试直推"与"试了直推、被拒后才降级"。
    let reqs = server.received_requests().await.unwrap();
    let contents_posts: Vec<serde_json::Value> = reqs
        .iter()
        .filter(|r| r.url.path().ends_with("/contents") && r.method.as_str() == "POST")
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    assert_eq!(contents_posts.len(), 1, "force_review 下不该先尝试直推再降级:{contents_posts:?}");
    let branch = contents_posts[0]["new_branch"].as_str().expect("提交审核必须带 new_branch");
    assert!(
        branch.starts_with(&gitea::review_branch_prefix(SLUG)),
        "分支名必须是 skillsync/{{name}}- 打头:{branch}"
    );
    let pull_body: serde_json::Value = reqs
        .iter()
        .find(|r| r.url.path().ends_with("/pulls"))
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .expect("应当开出一个合并请求");
    assert_eq!(pull_body["head"], branch, "PR 的 head 必须是同一条分支");
    assert_eq!(pull_body["base"], "main");

    // ────────────── ④ 再次读「我的技能」:如实反映当前状态,不是"审核中"
    //
    // 见文件头偏离说明第 1 点:`share_installed` 走评审时刻意不写任何 `state.shared`
    // 记录、也不改 `content_hash` 基线("记账一个字不动"),而 `Section::InstalledFrom`
    // 从来不参与审核候选闸 —— 所以这一行此刻**磁盘与账本都没有变化**,和提交之前一样。
    let after_submit = c.state();
    assert_eq!(after_submit.installed[0].content_hash, baseline_hash, "走评审,记账一个字不动");
    // 🔴 这才是 `share.rs` 那道"记账不动"承诺**真正**控制的量(复审 Important-1):
    // `share_installed` 走评审时不写任何 `state.shared` 记录——它与 `share()`
    // (首次分享草稿)长得像,但没有那一份"落一条 shared 账"的动作。这条断言与
    // `content_hash` 那条断言合起来,才共同封死了"审核中候选"在这条路径上
    // 连前提(有一条挂着的 shared 记录)都不成立的事实,而不是靠"review 恒为
    // None"这种在任何 section 上都为真的空话。
    assert!(after_submit.shared.is_empty(), "走评审不写任何 state.shared 记录");
    assert!(skill_md(&c).contains("我贡献的正文"), "本体是我们自己刚编辑的那一份,提交不碰本体");

    let rows = c.rows(&env);
    let row = &rows[0];
    assert_eq!(row.relation, Relation::Installed);
    assert_eq!(row.section, Section::InstalledFrom, "仍在「安装自」区,贡献更改不搬区");
    assert!(row.local_modified, "本地改动仍未进 main,如实显示为「本地改」");
    // 同上:这里只是复述 `build()` 的恒定行为,真正验证候选闸的测试在
    // `tests/review_state.rs`(见上面的注释)。
    assert!(row.review.is_none());

    // ────────────── ⑤ 模拟 PR 被合并:库里现在是我贡献的那一版
    mount_library_v2(&server, "我贡献的正文").await;
    let index = refresh_index(&server, &c).await;
    assert_eq!(index.commit_sha, "sha-v2", "第二版的 mock 没有盖住第一版的配额");
    let merged_hash = index.skills.iter().find(|s| s.dir_slug == SLUG).unwrap().content_hash.clone();
    assert_eq!(merged_hash, edited_hash, "合并进主线的内容应当与我们贡献的完全一致");

    let rows = c.rows(&env);
    let row = &rows[0];
    assert_eq!(row.relation, Relation::Installed);
    assert_eq!(row.section, Section::InstalledFrom, "合并之后仍是「安装自」区的这一行");
    // 见文件头偏离说明第 2 点:基线从未更新过,合并后 local_modified 与 remoteChanged
    // 同时为真 —— 这不是缺陷,是"贡献更改不改基线"这个既定取舍的直接推论,真实终态是
    // `RowAction::conflict`(库里有新版…三选一)而不是任务书写的 `update`。
    assert!(row.local_modified, "基线仍是编辑前的旧值,本地相对基线仍算「改过」");
    assert_ne!(
        merged_hash, row.content_hash,
        "库里内容相对基线也变了 = remoteChanged;两者同真 → 前端会渲染成冲突档,不是「有更新」"
    );
    assert_eq!(row.content_hash, baseline_hash, "基线从始至终没被贡献流程动过");
}
