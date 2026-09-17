//! 端到端(v7 任务 9):**一个"安装自公司技能库"的技能被本地改过、贡献回库**的完整一圈。
//!
//! `my_skills::build`(三区判据)→ `acquire::acquire`(取回)→ 本地编辑 →
//! `share::share_installed`(贡献更改,v8 起直推)→ 再回 `my_skills::build`
//! → 库里内容变成用户贡献的那一版 → 再回 `my_skills::build`。
//!
//! # 🔴 v8 任务 3 起这条链路只剩直推(D1)
//!
//! 这个文件原先记着 v7 的两处"与任务书叙述的偏离",两处的根都是**「贡献更改」恒走
//! 提交审核**:①"审核中"只属于「可分享到」区,所以贡献完这一行不显示审核中;
//! ②走评审刻意不更新 `content_hash` 基线,于是 PR 合并后 `local_modified` 与
//! `remoteChanged` **同时**为真,终态是冲突档而不是「有更新」。
//!
//! **v8 把那条路整个删了,两处偏离随之作废**——而②描述的那个死循环正是 v8 的起因
//! (内网实测:同事点「分享改动」开出空 PR,合并后行上仍显示"库里有新版",再点又
//! 一个)。现在贡献更改直推进库、**当场更新基线**(D3),所以这条端到端的终态变成
//! 了它本该有的样子:**推完就一致了,行上什么都不用做**。下面第 ④/⑤ 步正面断言
//! 这件事——它同时是"基线在内容确实进库时才更新"这条承诺的端到端护栏。
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
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
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
        // 配额 3:① 取回一次;③ 贡献更改的**预览轮**一次(算差集 + 覆盖闸);
        // ③' 用户确认后的**执行轮**再一次(v8 任务 5 起两轮各自下载一次压缩包,
        // 两轮之间用户可能等了很久,拿上一轮的旧快照提交才是真的危险)
        .respond_with(ResponseTemplate::new(200).set_body_bytes(library_zip("库里的初版正文", "李四")))
        .up_to_n_times(3)
        .mount(server)
        .await;
}

/// 库的第二版:贡献更改已经直推进库 —— 库里的内容与用户本地贡献的
/// 一致。挂载时机**必须晚于**步骤③(v1 的配额届时已经用完,见 [`mount_library_v1`])。
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

/// 「贡献更改」(`share::share_installed`,v8 起直推)要用到的端点:
/// 仓库信息(有推权限)、`git/trees`(更新路径要拿远端 blob sha)、当前登录用户
/// 与库根 `authors.json`(归因维护,读 404 = 库里还没有这份文件)、提交。
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

    // ────────────── ③ 贡献更改(v8 任务 3 起:直推,不再开合并请求)
    mount_contribute_endpoints(&server).await;
    // v8 任务 5:先走一轮预览(确认屏打开时发的那一跳),拿到这次会改动哪些文件。
    let preview = share::share_installed(
        &ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        SLUG,
        &repo.branch,
        false,
        NOW,
    )
    .await
    .unwrap();
    let ShareInstalledOutcome::NeedsConfirm { plan, overwrite } = preview else {
        panic!("预览轮应当回一份清单:{preview:?}");
    };
    assert_eq!(plan.modified, vec!["SKILL.md".to_string()], "只改了正文");
    assert!(plan.added.is_empty() && plan.deleted.is_empty(), "{plan:?}");
    assert!(overwrite.is_none(), "远端内容与基线一致,没有人会被顶掉");

    // 用户在确认屏上按了确认 → 这一跳才真的提交。
    let outcome = share::share_installed(
        &ShareClient::Gitea(&client),
        &client,
        &c.registry,
        &env,
        &c.store,
        SLUG,
        &repo.branch,
        true,
        NOW,
    )
    .await
    .unwrap();
    let ShareInstalledOutcome::Submitted(submitted) = outcome else {
        panic!("确认之后应当直接提交:{outcome:?}");
    };
    assert_eq!(submitted.mode, ShareMode::Pushed);

    // 🔴 断言请求本身:只有一笔**不带 `new_branch`** 的 /contents,且**没有**任何
    // /pulls ——这是 D1「提交审核整条下线」在这条路径上唯一的正面证据。只断言
    // 返回值的 mode 分不清"直推成功"与"顺手又开了个没人看的审核请求"。
    let reqs = server.received_requests().await.unwrap();
    let contents_posts: Vec<serde_json::Value> = reqs
        .iter()
        .filter(|r| r.url.path().ends_with("/contents") && r.method.as_str() == "POST")
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    assert_eq!(contents_posts.len(), 1, "只发一笔提交:{contents_posts:?}");
    assert!(
        contents_posts[0].get("new_branch").and_then(|v| v.as_str()).is_none(),
        "不该再开分支:{:?}",
        contents_posts[0]
    );
    assert!(
        !reqs.iter().any(|r| r.url.path().ends_with("/pulls")),
        "不该再开合并请求:{:?}",
        reqs.iter().map(|r| r.url.path().to_string()).collect::<Vec<_>>()
    );

    // ────────────── ④ 内容确实进库了 → **基线当场对齐**(D3)
    //
    // 这一条正是 v8 的起因那个死循环的反面:旧实现走评审时刻意不动基线,于是
    // 合并之后 `local_modified` 与 `remoteChanged` 同时为真,用户点一次开一个空 PR,
    // 自己出不来。
    let after_submit = c.state();
    assert_eq!(
        after_submit.installed[0].content_hash, edited_hash,
        "内容确实进库了,基线必须跟上——这是 v8 那个死循环的根因所在"
    );
    assert_ne!(after_submit.installed[0].content_hash, baseline_hash);
    assert!(after_submit.shared.is_empty(), "贡献更改不写 state.shared 记录");
    assert!(skill_md(&c).contains("我贡献的正文"), "提交不碰本体");

    let rows = c.rows(&env);
    let row = &rows[0];
    assert_eq!(row.section, Section::InstalledFrom, "贡献更改不搬区");
    assert!(!row.local_modified, "推上去了,本地相对新基线不再算「改过」");

    // ────────────── ⑤ 库里也是这一版了:两侧指纹相等,行上什么都不用做
    mount_library_v2(&server, "我贡献的正文").await;
    let index = refresh_index(&server, &c).await;
    assert_eq!(index.commit_sha, "sha-v2", "第二版的 mock 没有盖住第一版的配额");
    let merged_hash = index.skills.iter().find(|s| s.dir_slug == SLUG).unwrap().content_hash.clone();
    assert_eq!(merged_hash, edited_hash, "进主线的内容应当与我们贡献的完全一致");

    let rows = c.rows(&env);
    let row = &rows[0];
    assert_eq!(row.relation, Relation::Installed);
    assert_eq!(row.section, Section::InstalledFrom);
    assert!(!row.local_modified, "本地与基线一致");
    assert_eq!(
        merged_hash, row.content_hash,
        "库里内容 == 基线 == 本地 —— 前端三个判据全为假,这一行不摆任何按钮"
    );
}
