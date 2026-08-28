//! 「审核态」的集成测试(v7 任务 2,修复轮 1)。
//!
//! 与 `tests/installed_list.rs` 同一种姿势(见该文件模块头):`commands::installed_list`
//! 依赖真实 `HOME`(`app_store()`)与编译期注入的公司库坐标(`BuiltinSource::from_build()`
//! 读的是构建期环境变量,测试构建里根本没有),所以这里不去调那个 `#[tauri::command]`,
//! 而是原样复演它在 v7 任务 2 之后的编排:`my_skills::build`(同步、零网络)→
//! 按候选行发一次 `GiteaClient::list_open_pulls`(指向 wiremock,不是真内网)→
//! 把 `Result` 交给 `my_skills::apply_review`(成功/失败怎么填的**唯一**分派点,
//! 修复轮 1 M2 下沉出来的纯函数,`installed_list_with` 因此不再自己重写一份
//! `match`)。
//!
//! 四个场景:
//! - 前缀匹配:`list_open_pulls` 解析不筛选,筛选按 `review_branch_prefix` 是调用方的事;
//! - 端到端标记:候选行命中开放 PR 后被正确标记,且**只标真正的候选**——夹带一个
//!   无关的开放 PR 与一个无关的候选行,证明匹配不是"随便抓一条"(修复轮 1 抓到
//!   `fill_review_from_pulls` 原先没有 `shared_record_of` 这道候选闸,详见下面
//!   `a_candidate_row_gets_marked_under_review_when_its_pull_is_open` 的注释);
//! - 网络失败降级:整张列表不报错,按 `state.shared` 的本地记录兜底;
//! - GitHub 库不发请求:`shared_record_of` 只认**公司库主仓**(`registry_id` 与
//!   `owner/repo` 都要对得上)的记录,记着别的来源的分享记录根本不会成为候选,
//!   自然也不会触发任何查询——这条真的走 `installed_list_with`(而不是只调
//!   `has_review_candidates` 这半步),`.expect(0)` 才是在守一条本来**可能**被拨通
//!   的电话(修复轮 1 M1:旧版没有任何 client 指向那台 server,`.expect(0)` 恒过)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::{review_branch_prefix, GiteaClient};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::my_skills::{self, InstalledRow};
use skillsync_lib::core::ownership::Section;
use skillsync_lib::core::registry;
use skillsync_lib::core::state::{Config, InstalledSkill, SharedSkill, SkillSource, State, Store};

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-08-28T00:00:00.000Z";

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
    sandbox: skillsync_lib::core::fsops::SandboxTrash,
}

impl Ctx {
    fn canonical(&self, slug: &str) -> PathBuf {
        self.home.join(".agents/skills").join(slug)
    }
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
    Ctx { _tmp: tmp, home, env, registry: AgentRegistry::builtin(), store, builtin, sandbox }
}

/// 一个「可分享到」的本地草稿:canonical 目录下有 SKILL.md,没有 `state.installed`
/// 记账,索引缓存里也查不到它——三支判据(`my_skills::in_builtin_library`)都不成立,
/// `relation == Draft`、`section == Shareable`。
fn write_shareable_draft(ctx: &Ctx, slug: &str) -> PathBuf {
    let dir = ctx.canonical(slug);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {slug}\ndescription: 用于测试\n---\n正文\n"),
    )
    .unwrap();
    dir
}

/// 一条挂在 `body` 上、走过评审的 `state.shared` 记录(目标是公司库主仓)。
fn shared_record_under_review(body: &Path, share_name: &str) -> SharedSkill {
    SharedSkill {
        name: share_name.into(),
        local_path: body.to_string_lossy().into_owned(),
        origin: "local".into(),
        target: SkillSource {
            registry_id: registry::BUILTIN_REGISTRY_ID.into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: format!("skills/{share_name}"),
            git_ref: "main".into(),
        },
        last_pushed_sha: "abc1111".into(),
        content_hash: "sha256:whatever".into(),
        review_url: Some("http://gitea.internal:3000/skills/skills/pulls/7".into()),
        review_number: Some(7),
    }
}

fn build_rows(ctx: &Ctx, state: &State) -> Vec<InstalledRow> {
    let installer = Installer::new(&ctx.registry, &ctx.env).with_trasher(&ctx.sandbox);
    my_skills::build(&installer, &ctx.registry, &ctx.env, &ctx.store, &ctx.builtin, &Config::default(), state)
        .unwrap()
}

fn row<'a>(rows: &'a [InstalledRow], dir_slug: &str) -> &'a InstalledRow {
    rows.iter().find(|r| r.dir_slug == dir_slug).unwrap_or_else(|| {
        panic!("期望能找到 {dir_slug},实际列表:{:?}", rows.iter().map(|r| &r.dir_slug).collect::<Vec<_>>())
    })
}

/// 原样复演 `commands::installed_list` 在 `my_skills::build` 之后的编排(见模块头):
/// 发不发请求由 `has_review_candidates` 决定,拿到的 `Result` 原样交给
/// `apply_review`——不在测试里重写一份 `match`(修复轮 1 M2)。
async fn installed_list_with(server: &MockServer, seed: impl FnOnce(&Ctx) -> State) -> Vec<InstalledRow> {
    let ctx = ctx();
    let state = seed(&ctx);
    let mut rows = build_rows(&ctx, &state);
    let builtin_repo = ctx.builtin.repo;

    if my_skills::has_review_candidates(&rows, &state, builtin_repo) {
        let client = GiteaClient::new(server.uri(), None).unwrap();
        let result = client.list_open_pulls("skills", "skills").await;
        my_skills::apply_review(&mut rows, &state, builtin_repo, result);
    }
    rows
}

fn client(server: &MockServer) -> GiteaClient {
    GiteaClient::new(server.uri(), None).unwrap()
}

/// Step 1:`list_open_pulls` 一次请求取回全部、不筛选;筛选按分支名前缀是调用方的事,
/// 存量分享(从没落过 PR 坐标的旧记录)也认得出——匹配的判据只是分支名,不依赖
/// 本地记着的 `review_number`。
#[tokio::test]
async fn open_pulls_are_matched_to_skills_by_branch_prefix() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "number": 7, "html_url": "http://x/pulls/7", "head": { "ref": "skillsync/weekly-report-20260828" } },
            { "number": 8, "html_url": "http://x/pulls/8", "head": { "ref": "feature/unrelated" } }
        ])))
        .mount(&server)
        .await;

    let pulls = client(&server).list_open_pulls("skills", "skills").await.unwrap();
    assert_eq!(pulls.len(), 2, "解析不筛选,筛选是调用方的事");

    let mine: Vec<_> = pulls
        .iter()
        .filter(|p| p.head_ref.starts_with(&review_branch_prefix("weekly-report")))
        .collect();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].number, 7);
}

/// 端到端 + 鉴别力(修复轮 1 C1 的护栏):候选行在开放 PR 列表命中对应分支前缀后
/// 被正确标记,同时验证两条容易被空转掉的边:
///
/// 1. **候选闸真的在挡**:`weekly-report` 这一行是**带外源记账**的(`state.installed`
///    的 `source.path` 是 `skills/zhoubao`,与本体的字面叶子名 `weekly-report`
///    刻意不同)——`InstalledRow::dir_slug` 因此是 `zhoubao`(取
///    `library_dir_slug()`),而 `state.shared[].name`(= `share()` 拼分支名用的
///    `share_name`)与本体叶子名都是 `weekly-report`。四个概念此前在同一份 fixture
///    里全部取值 `weekly-report`(空转测试模式③),`fill_review_from_pulls` 用错键
///    (`row.dir_slug`)一样能"凑巧"匹配上,看不出问题。这里把它们拆开:如果实现
///    退回用 `row.dir_slug` 当前缀键,这条会因为找不到任何以 `skillsync/zhoubao-`
///    开头的分支而红。
/// 2. **匹配的是 `find`,不是"抓第一条"**:PR 列表里**先摆一个无关的**
///    (`skillsync/other-skill-2026`),真正命中的那条排第二。断言的是**精确的
///    URL**,不是"有没有命中"——如果实现退化成 `pulls.first()`,这一行会被错误
///    标上无关 PR 的链接,断言会红(已手工验证:见任务报告的注入记录)。
/// 3. 同时摆一个**没有分享过**的 `Shareable` 行(`another-draft`)作对照:候选闸
///    (`shared_record_of`)如果被去掉,任何 `Shareable` 行都会参与前缀扫描,
///    这一行不该被扫描到任何东西、`review` 恒 `None`。
#[tokio::test]
async fn a_candidate_row_gets_marked_under_review_when_its_pull_is_open() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "number": 99, "html_url": "http://gitea.internal:3000/skills/skills/pulls/99",
              "head": { "ref": "skillsync/other-skill-2026" } },
            { "number": 7, "html_url": "http://gitea.internal:3000/skills/skills/pulls/7",
              "head": { "ref": "skillsync/weekly-report-20260828100000" } }
        ])))
        .mount(&server)
        .await;

    let rows = installed_list_with(&server, |ctx| {
        // 本体叶子名与 `share_name` 都是 weekly-report。
        let body = write_shareable_draft(ctx, "weekly-report");
        // 另一个从没分享过的草稿,dir_slug 恰好排在同一份列表里。
        write_shareable_draft(ctx, "another-draft");

        let mut state = State::default();
        // 带外源记账:`dir_slug` 走 `library_dir_slug()` = "zhoubao",与
        // `weekly-report` 这个字面名 / share_name 刻意不同。
        state.installed.push(InstalledSkill {
            name: "weekly-report".into(),
            source: SkillSource {
                registry_id: "github-personal".into(),
                owner: "acme".into(),
                repo: "other".into(),
                path: "skills/zhoubao".into(),
                git_ref: "main".into(),
            },
            commit_sha: "abc1111".into(),
            content_hash: String::new(),
            origin: None,
            body: None,
            agents: Vec::new(),
            links: Vec::new(),
            installed_at: NOW.into(),
            updated_at: NOW.into(),
        });
        state.shared.push(shared_record_under_review(&body, "weekly-report"));
        state
    })
    .await;

    let r = row(&rows, "zhoubao");
    assert_eq!(r.section, Section::Shareable);
    let review = r.review.as_ref().expect("命中开放 PR,应当标为审核中");
    assert_eq!(
        review.url.as_deref(),
        Some("http://gitea.internal:3000/skills/skills/pulls/7"),
        "必须是精确匹配到的那条 PR,不是列表里排第一的那条"
    );

    let unrelated = row(&rows, "another-draft");
    assert_eq!(unrelated.section, Section::Shareable);
    assert!(unrelated.review.is_none(), "从没分享过的草稿不该被任何 PR 命中");
}

/// Step 2:网络查询失败(500)不拖垮整张列表;有 `state.shared` 记录且这个技能
/// 还不在公司库里 → 仍按本地证据算作审核中。
#[tokio::test]
async fn a_failing_pull_query_keeps_the_list_and_falls_back_to_local_evidence() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let rows = installed_list_with(&server, |ctx| {
        let body = write_shareable_draft(ctx, "weekly-report");
        let mut state = State::default();
        state.shared.push(shared_record_under_review(&body, "weekly-report"));
        state
    })
    .await;

    let r = row(&rows, "weekly-report");
    assert_eq!(r.section, Section::Shareable, "整张列表不报错");
    assert!(r.review.is_some(), "降级判据:有 shared 记录且不在库里 → 仍算审核中");
}

/// GitHub 库不发这个请求:`state.shared` 记录如果指向公司库主仓以外的来源
/// (自定义 Gitea / GitHub 源,或公司源下的追加仓),`shared_record_of` 按
/// `registry_id == BUILTIN_REGISTRY_ID && (owner,repo) == 主仓坐标` 收窄候选
/// ——这条记录根本不会成为候选,`has_review_candidates` 恒 `false`,`installed_list_with`
/// 因此**根本不构造指向这台 server 的 client**。挂在 server 上的 `.expect(0)`
/// 守的正是这件事:如果候选闸被放宽,这次调用会真的拨过去、断言会红。
#[tokio::test]
async fn a_shared_record_pointing_at_another_registry_never_triggers_a_pulls_request() {
    let server = MockServer::start().await;
    // 摆一个会命中的 responder,但断言它**从未被调用**——真出问题时这条会失败,
    // 而不是因为没配 responder 才连不上。
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .expect(0)
        .mount(&server)
        .await;

    let rows = installed_list_with(&server, |ctx| {
        let body = write_shareable_draft(ctx, "weekly-report");
        let mut state = State::default();
        let mut record = shared_record_under_review(&body, "weekly-report");
        // 指向一个 GitHub 源(既不是公司库,也没有 `list_open_pulls` 这个能力——
        // github.rs 的 PullView 连 number 都没有,GitHub 侧压根实现不了这个查询)。
        record.target.registry_id = "github-personal".into();
        state.shared.push(record);
        state
    })
    .await;

    let r = row(&rows, "weekly-report");
    assert_eq!(r.section, Section::Shareable);
    assert!(r.review.is_none(), "没有候选就不该有任何网络结果");

    server.verify().await; // 触发 `.expect(0)` 的断言:一次请求都没发生
}

/// I2 的对照组:`registry_id` 对得上公司库,但 `owner/repo` 是**追加仓**
/// (`config.builtinExtraRepos` 那一档),不是主仓——同样不该成为候选,一次请求
/// 都不该发生。与上一条的区别在于这里连 `registry_id` 都是 `BUILTIN_REGISTRY_ID`,
/// 专门钉住"只比 `registry_id` 不比 `owner/repo`"这条退化实现。
#[tokio::test]
async fn a_shared_record_pointing_at_a_builtin_extra_repo_never_triggers_a_pulls_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .expect(0)
        .mount(&server)
        .await;

    let rows = installed_list_with(&server, |ctx| {
        let body = write_shareable_draft(ctx, "weekly-report");
        let mut state = State::default();
        let mut record = shared_record_under_review(&body, "weekly-report");
        // 同一个内建源,但目标是追加仓而不是主仓 skills/skills。
        record.target.owner = "skills".into();
        record.target.repo = "extra-repo".into();
        state.shared.push(record);
        state
    })
    .await;

    let r = row(&rows, "weekly-report");
    assert_eq!(r.section, Section::Shareable);
    assert!(r.review.is_none(), "追加仓不是主仓,不该成为候选");

    server.verify().await;
}
