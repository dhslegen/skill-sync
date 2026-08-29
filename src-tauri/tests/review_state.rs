//! 「审核态」的集成测试(v7 任务 2,修复轮 2)。
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
//! 五个场景:
//! - 前缀匹配:`list_open_pulls` 解析不筛选,筛选按 `review_branch_prefix` 是调用方的事;
//! - 端到端标记:候选行命中开放 PR 后被正确标记,且**只标真正的候选**——夹带一个
//!   无关的开放 PR 与一个**它自己的前缀也会命中同一个无关 PR** 的候选行,证明
//!   候选闸真的在挡而不是摆设(修复轮 2 的 C1 附带修复,详见下面
//!   `a_candidate_row_gets_marked_under_review_when_its_pull_is_open` 的注释);
//! - 网络失败降级:整张列表不报错,按 `state.shared` 的本地记录兜底;
//! - GitHub 库不发请求:`shared_record_of` 只认**公司库主仓**(`registry_id` 与
//!   `owner/repo` 都要对得上)的记录,记着别的来源的分享记录根本不会成为候选,
//!   自然也不会触发任何查询——这条真的走 `installed_list_with`(而不是只调
//!   `has_review_candidates` 这半步),`.expect(0)` 才是在守一条本来**可能**被拨通
//!   的电话(修复轮 1 M1:旧版没有任何 client 指向那台 server,`.expect(0)` 恒过)。
//! - 翻页止损(修复轮 2 新增):服务端如果不尊重 `page` 参数、每一页都原样回满页,
//!   `list_open_pulls` 必须在 `PULLS_MAX_PAGES` 次请求后止损,不能转到把
//!   `installed_list` 挂死。
//!
//! 🔴 **本文件两处直接命中 `list_open_pulls`(不经过 `my_skills`)的 mock 现在必须
//! 按页响应**:2026-08-28 把翻页停止条件从"这一页比页大小少"改成"这一页空了"
//! (`raw.is_empty()`)之后,只用 `path()` 匹配、不区分 `page` 查询参数的 mock 会让
//! 每一页都拿到同一批非空数据,永远等不到空页——用 `query_param("page", "1")` /
//! `("page", "2")` 精确区分,第 2 页给空数组才能让循环正常停下,不然会一路转到
//! `PULLS_MAX_PAGES` 才因为止损报错,而不是原本要测的那件事。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::{review_branch_prefix, GiteaClient, PULLS_MAX_PAGES, PULLS_PAGE_SIZE};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::my_skills::{self, InstalledRow};
use skillsync_lib::core::ownership::Section;
use skillsync_lib::core::registry;
use skillsync_lib::core::state::{Config, InstalledSkill, SharedSkill, SkillSource, State, Store};

use wiremock::matchers::{method, path, query_param};
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
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "number": 7, "html_url": "http://x/pulls/7", "head": { "ref": "skillsync/weekly-report-20260828" } },
            { "number": 8, "html_url": "http://x/pulls/8", "head": { "ref": "feature/unrelated" } }
        ])))
        .mount(&server)
        .await;
    // 第 2 页给空数组,翻页判据(修复轮 2:"这一页空了")才会正常停下——不这样配的话
    // 每一页都会拿到第 1 页那份非空数据,循环会一路转到 `PULLS_MAX_PAGES` 才止损。
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
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

/// 端到端 + 鉴别力(修复轮 1 C1 的护栏,修复轮 2 补真了对照行的信号):候选行在
/// 开放 PR 列表命中对应分支前缀后被正确标记,同时验证两条容易被空转掉的边:
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
/// 3. 🔴 **对照行 `other-skill` 必须是"闸没了就会真的被误标"那一种,不能是摆设**
///    (修复轮 2 复审抓到的原缺陷:此前对照行叫 `another-draft`,它自己的前缀
///    `skillsync/another-draft-` 跟列表里两条 PR 都不匹配,有闸无闸这条断言恒真,
///    没有任何鉴别力)。现在改名成 `other-skill`——它的目录名与 frontmatter
///    `name` 都是 `other-skill`,前缀 `skillsync/other-skill-` **恰好命中列表里那条
///    无关 PR** `skillsync/other-skill-2026`。它自己没有 `state.shared` 记录,
///    正确实现下候选闸(`shared_record_of`)会先拦住它,压根不参与前缀扫描,
///    `review` 仍是 `None`;闸一旦被去掉、退化成对每个 `Shareable` 行都直接扫描
///    (哪怕换掉键),这一行就会被误标上 `#99` 的链接——见下面
///    `a_candidate_row_gets_marked_under_review_when_its_pull_is_open` 的鉴别力
///    注入(报告里的记录):去掉候选闸退回兜底键时,这条测试**会真的变红**。
#[tokio::test]
async fn a_candidate_row_gets_marked_under_review_when_its_pull_is_open() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "number": 99, "html_url": "http://gitea.internal:3000/skills/skills/pulls/99",
              "head": { "ref": "skillsync/other-skill-2026" } },
            { "number": 7, "html_url": "http://gitea.internal:3000/skills/skills/pulls/7",
              "head": { "ref": "skillsync/weekly-report-20260828100000" } }
        ])))
        .mount(&server)
        .await;
    // 第 2 页给空数组,理由同上一条测试:修复轮 2 的翻页判据是"这一页空了"。
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&server)
        .await;

    let rows = installed_list_with(&server, |ctx| {
        // 本体叶子名与 `share_name` 都是 weekly-report。
        let body = write_shareable_draft(ctx, "weekly-report");
        // 另一个从没分享过的草稿,前缀恰好命中列表里那条无关 PR(#99)——
        // 候选闸如果被去掉,这一行会被误标,是真正有鉴别力的对照(修复轮 2)。
        write_shareable_draft(ctx, "other-skill");

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

    let unrelated = row(&rows, "other-skill");
    assert_eq!(unrelated.section, Section::Shareable);
    assert!(
        unrelated.review.is_none(),
        "从没分享过的草稿不该被任何 PR 命中,即便它自己的前缀能命中列表里的无关 PR"
    );
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

/// 翻页止损(2026-08-28 新增,对应复审提出的"新 Important"):服务端如果不尊重
/// `page` 参数——反向代理丢了 query string、或部署本身有 bug——每一页都会原样
/// 回同一批**非空**数据,"这一页空了才停"的判据(同日改的,见 `list_open_pulls`
/// 文档)永远等不到空页,会一路转下去。`list_open_pulls` 因此必须在
/// [`PULLS_MAX_PAGES`] 次请求后止损,把这次查询当"失败"交回调用方(既有降级路
/// 本来就是为"拿不到真实 PR 状态"准备的)。
///
/// `.expect(PULLS_MAX_PAGES as u64)` 是这条测试的核心断言:直接引用实现里的常量,
/// 不在这里另抄一份数字——常量与断言必须是同一把尺子,否则测试守的会是一个
/// 错误的边界(参见 `review_branch`/`review_branch_prefix` 那条"两把尺子必须
/// 同源"的既有教训)。如果页数上限这层止损被去掉或改错,有两种可能的表现:
/// 要么请求次数超出预期让 `server.verify()` 失败,要么这一层失效但
/// `PULLS_QUERY_DEADLINE` 兜底(15 秒后返回超时错误,而不是页数上限的
/// 那个错误码)——`assert_eq!(err.code, ...)` 那句会因为拿到不同的错误码而红
/// (已用注入验证过这条:去掉页数上限判断,`err.code` 从 `NET_PULLS_TOO_MANY`
/// 变成 `NET_PULLS_TIMEOUT`)。⚠️ 如果两层止损**都**被去掉,循环会真的转不停,
/// 这条测试会一直挂住而不是变红——那是止损机制整体失效的场景,不是这条测试
/// 单独能兜住的,靠的是两层止损各自独立、不会同时失效这条假设。
#[tokio::test]
async fn a_server_that_ignores_the_page_parameter_does_not_loop_forever() {
    let server = MockServer::start().await;
    // 无论请求几次都原样返回同一批非空数据,模拟"page 参数被服务端忽略"。
    let full_page: Vec<_> = (0..PULLS_PAGE_SIZE)
        .map(|i| {
            serde_json::json!({
                "number": i,
                "html_url": format!("http://x/pulls/{i}"),
                "head": { "ref": format!("feature/unrelated-{i}") }
            })
        })
        .collect();
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!(full_page)))
        .expect(PULLS_MAX_PAGES as u64)
        .mount(&server)
        .await;

    let err = client(&server).list_open_pulls("skills", "skills").await.unwrap_err();
    assert_eq!(err.code, "NET_PULLS_TOO_MANY", "止损后应当按查询失败处理,交回调用方走既有降级路");

    server.verify().await; // 请求次数确实有上限(恰好 PULLS_MAX_PAGES 次),不是无限转下去
}

// ============================================================ v7 任务 9 修复轮 2

/// 复审 Important-1:`tests/e2e_sections.rs` 原先用 `my_skills::build()` 的输出
/// 断言「安装自区的行 `review` 恒为 `None`」,而 `build()` 在三处构造点(`my_skills.rs`
/// 里普通行/无本体行/占位行三条路径)**无条件**填 `review: None`——那条断言对任何
/// `section` 都恒真,把 `fill_review_from_pulls`/`fill_review_from_records`/
/// `has_review_candidates` 的 `Section::Shareable` 过滤全部删掉,它也不会红。
///
/// 这里改成直接调 `fill_review_from_records`(真正带着候选闸的那个纯函数):
/// 构造一个记账指向公司库主仓的「安装自」行(`builtin_record` 判据成立,
/// `section == InstalledFrom`),并给它挂上一条本该只属于「可分享到」区候选的
/// `state.shared` 记录——这在现实中不会发生(`share_installed` 走评审从不写
/// `state.shared`,`tests/e2e_sections.rs` 的新断言 `after_submit.shared.is_empty()`
/// 钉的正是这一点),这里是刻意构造的反例,专门用来检验候选闸本身。
///
/// 断言:即便有这样一条记录挂着,`fill_review_from_records` 也绝不会把
/// `InstalledFrom` 行标成审核中——候选闸的第一道门槛是 `section == Shareable`,
/// 这条行连这道门槛都过不了。
#[tokio::test]
async fn an_installed_from_row_with_a_shared_record_is_never_marked_under_review() {
    let ctx = ctx();
    // 复用「写一个真实技能目录」的辅助:这里没有"草稿"的语义,只是需要磁盘上有
    // 一份真实内容,`build()` 才会把它算进行里。
    let body = write_shareable_draft(&ctx, "weekly-report");

    let mut state = State::default();
    // `source.registry_id == BUILTIN_REGISTRY_ID` 是 `in_builtin_library` 三支判据的
    // 第一支(`builtin_record`),单独成立即可让这一行落进 `InstalledFrom`,
    // 不需要额外配置作者/索引。
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: registry::BUILTIN_REGISTRY_ID.into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
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

    let mut rows = build_rows(&ctx, &state);
    let r = row(&rows, "weekly-report");
    assert_eq!(
        r.section,
        Section::InstalledFrom,
        "记账指向公司库主仓,builtin_record 判据成立 = 安装自区"
    );
    assert!(r.review.is_none(), "build() 本身零网络,恒为 None(与本测试要钉的候选闸无关)");

    my_skills::fill_review_from_records(&mut rows, &state, ctx.builtin.repo);
    let r = row(&rows, "weekly-report");
    assert!(
        r.review.is_none(),
        "「安装自」区的行即便挂着一条 state.shared 记录,候选闸也不该放行——\
         审核态是「可分享到」区专属(设计决策 #4)"
    );
}
