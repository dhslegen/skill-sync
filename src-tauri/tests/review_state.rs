//! 「审核态」的集成测试(v7 任务 2)。
//!
//! 与 `tests/installed_list.rs` 同一种姿势(见该文件模块头):`commands::installed_list`
//! 依赖真实 `HOME`(`app_store()`)与编译期注入的公司库坐标(`BuiltinSource::from_build()`
//! 读的是构建期环境变量,测试构建里根本没有),所以这里不去调那个 `#[tauri::command]`,
//! 而是原样复演它在 v7 任务 2 之后的编排:`my_skills::build`(同步、零网络)→
//! 按候选行发一次 `GiteaClient::list_open_pulls`(指向 wiremock,不是真内网)→
//! 成功走 `fill_review_from_pulls`,失败走 `fill_review_from_records`。
//!
//! 三个场景:
//! - 前缀匹配:`list_open_pulls` 解析不筛选,筛选按 `review_branch_prefix` 是调用方的事;
//! - 网络失败降级:整张列表不报错,按 `state.shared` 的本地记录兜底;
//! - GitHub 库不发请求:`shared_record_of` 只认公司库(`registry_id == BUILTIN_REGISTRY_ID`)
//!   的记录,记着别的来源的分享记录根本不会成为候选,自然也不会触发任何查询。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::{review_branch_prefix, GiteaClient};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::my_skills::{self, InstalledRow};
use skillsync_lib::core::ownership::Section;
use skillsync_lib::core::registry;
use skillsync_lib::core::state::{Config, SharedSkill, SkillSource, State, Store};

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

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

/// 一条挂在 `body` 上、走过评审的 `state.shared` 记录(目标是公司库)。
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

/// 原样复演 `commands::installed_list` 在 `my_skills::build` 之后的编排(见模块头),
/// 只是把「公司库」换成 wiremock 地址。
async fn installed_list_with(server: &MockServer, seed: impl FnOnce(&Ctx) -> State) -> Vec<InstalledRow> {
    let ctx = ctx();
    let state = seed(&ctx);
    let mut rows = build_rows(&ctx, &state);

    if my_skills::has_review_candidates(&rows, &state) {
        let client = GiteaClient::new(server.uri(), None).unwrap();
        match client.list_open_pulls("skills", "skills").await {
            Ok(pulls) => my_skills::fill_review_from_pulls(&mut rows, &pulls),
            Err(_) => my_skills::fill_review_from_records(&mut rows, &state),
        }
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

/// 端到端:候选行(可分享到 + 挂着一条公司库的 `state.shared` 记录)在开放 PR 列表
/// 命中对应分支前缀后,`review` 被正确填上;不相关的候选(没有记录、或已经装自
/// 公司库)不受影响。
#[tokio::test]
async fn a_candidate_row_gets_marked_under_review_when_its_pull_is_open() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "number": 7, "html_url": "http://gitea.internal:3000/skills/skills/pulls/7",
              "head": { "ref": "skillsync/weekly-report-20260828100000" } }
        ])))
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
    assert_eq!(r.section, Section::Shareable);
    let review = r.review.as_ref().expect("命中开放 PR,应当标为审核中");
    assert_eq!(review.url, "http://gitea.internal:3000/skills/skills/pulls/7");
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

/// GitHub 库不发这个请求:`state.shared` 记录如果指向公司库以外的来源(自定义
/// Gitea / GitHub 源),`shared_record_of` 按 `registry_id == BUILTIN_REGISTRY_ID`
/// 收窄候选——这条记录根本不会成为候选,`has_review_candidates` 恒 `false`,
/// 自然也就不会对**任何**服务器发起查询(哪怕那台服务器是公司库自己)。
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

    let ctx = ctx();
    let body = write_shareable_draft(&ctx, "weekly-report");
    let mut state = State::default();
    let mut record = shared_record_under_review(&body, "weekly-report");
    // 指向一个 GitHub 源(既不是公司库,也没有 `list_open_pulls` 这个能力——
    // github.rs 的 PullView 连 number 都没有,GitHub 侧压根实现不了这个查询)。
    record.target.registry_id = "github-personal".into();
    state.shared.push(record);

    let rows = build_rows(&ctx, &state);
    assert!(
        !my_skills::has_review_candidates(&rows, &state),
        "指向公司库以外的记录不该成为候选"
    );

    let r = row(&rows, "weekly-report");
    assert_eq!(r.section, Section::Shareable);
    assert!(r.review.is_none(), "没有候选就不该有任何网络结果");

    server.verify().await; // 触发 `.expect(0)` 的断言:一次请求都没发生
}
