//! `core::plaza::fetch_leaderboard`(M10 任务 4)的 wiremock 集成测试。
//!
//! 真实 fixture(`fixtures/skillssh-leaderboard-home.html`)来自 2026-08-17 对
//! `https://skills.sh/` 首页的真实 GET 请求捕获(跟随 308 重定向落到
//! `https://www.skills.sh/`),裁到只留 `initialSkills` 数组的前 6 个真实条目
//! ——裁剪细节与"为什么可以只留这一段"见该文件顶部的注释。
//!
//! 这里测三件事:(1) 真实 fixture 端到端解析正确;(2) **必须跟随重定向**这条
//! ground truth(brief 明确点名的坑);(3) 网络/解析失败一律降级成空列表、
//! **函数本身不返回 `Err`**——这是本任务的核心容错语义,DoD 要求测试钉住。

use skillsync_lib::core::plaza::{self, PlazaSkillCard};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FIXTURE: &str = include_str!("fixtures/skillssh-leaderboard-home.html");

fn http() -> reqwest::Client {
    // 不关闭重定向策略:reqwest 默认策略即跟随(最多 10 跳),与生产用的
    // `app_http_client_proxied()` 同一档——这正是要测的东西,不能悄悄关掉。
    reqwest::Client::builder()
        .user_agent("SkillSync/test")
        .build()
        .unwrap()
}

fn card(name: &str, slug: &str, owner_repo: &str, installs: u64, is_official: bool) -> PlazaSkillCard {
    PlazaSkillCard { name: name.into(), slug: slug.into(), owner_repo: owner_repo.into(), installs, is_official }
}

// ---------------------------------------------------------------- 1. 真实 fixture

#[tokio::test]
async fn real_fixture_parses_into_six_cards_sorted_desc_with_is_official() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(FIXTURE))
        .mount(&server)
        .await;

    let got = plaza::fetch_leaderboard(&http(), &format!("{}/", server.uri())).await;

    assert_eq!(
        got,
        vec![
            card(
                "find-skills",
                "vercel-labs/skills/find-skills",
                "vercel-labs/skills",
                2_981_876,
                true,
            ),
            card(
                "grill-me",
                "mattpocock/skills/grill-me",
                "mattpocock/skills",
                877_815,
                false,
            ),
            card(
                "frontend-design",
                "anthropics/skills/frontend-design",
                "anthropics/skills",
                784_708,
                true,
            ),
            card(
                "grill-with-docs",
                "mattpocock/skills/grill-with-docs",
                "mattpocock/skills",
                746_680,
                false,
            ),
            card(
                "improve-codebase-architecture",
                "mattpocock/skills/improve-codebase-architecture",
                "mattpocock/skills",
                719_937,
                false,
            ),
            card("tdd", "mattpocock/skills/tdd", "mattpocock/skills", 695_860, false),
        ]
    );
}

// ---------------------------------------------------------------- 2. 必须跟随重定向

/// `skills.sh` 308 到 `www.skills.sh` 是 brief 点名的 ground truth
/// ——不跟随重定向拿到的是一个空跳转页,解析必然失败,退化成空列表。
/// 这里用同一台 wiremock 服务器模拟"根路径 308 到另一条路径"来验证客户端策略,
/// 不依赖真实外网(真实跳转另有 `tests/plaza_live.rs` 之类的 live 用例把关,
/// 这里只测"给了 308,我们的 client 有没有跟"这件事本身)。
#[tokio::test]
async fn follows_a_308_redirect_before_parsing() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(308).insert_header("Location", format!("{}/redirected", server.uri())),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/redirected"))
        .respond_with(ResponseTemplate::new(200).set_body_string(FIXTURE))
        .mount(&server)
        .await;

    let got = plaza::fetch_leaderboard(&http(), &format!("{}/", server.uri())).await;

    assert_eq!(got.len(), 6, "跟随重定向后应正常解析出真实 fixture 的 6 条:{got:?}");
}

// ---------------------------------------------------------------- 3. 降级语义(核心)

/// 上游改了渲染实现、`initialSkills` 锚点消失——这是"上游改版"的典型现场。
/// **必须返回空列表,不是 `Err`**(`fetch_leaderboard` 的函数签名本身就不允许
/// 调用方处理错误,这条断言等价于验证降级语义确实生效)。
#[tokio::test]
async fn a_page_without_the_leaderboard_anchor_degrades_to_an_empty_list() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string("<html><body>上游改版了</body></html>"))
        .mount(&server)
        .await;

    let got = plaza::fetch_leaderboard(&http(), &format!("{}/", server.uri())).await;

    assert!(got.is_empty(), "解析失败应静默降级为空列表,不是错误:{got:?}");
}

/// 非 200(比如上游临时限流/维护页)同样降级成空列表。
#[tokio::test]
async fn a_non_200_status_degrades_to_an_empty_list() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(503).set_body_string("maintenance"))
        .mount(&server)
        .await;

    let got = plaza::fetch_leaderboard(&http(), &format!("{}/", server.uri())).await;

    assert!(got.is_empty());
}

/// 连不上(skills.sh 挂了/断网)同样降级成空列表——风险表里"skills.sh 挂了→
/// 排行榜回退空态"这条就是这里钉住的。保留域名(RFC 2606),DNS 必然解析失败,
/// 不靠 `drop(MockServer)` 空出端口那套(见 CLAUDE.md 测试要求一节)。
#[tokio::test]
async fn an_unreachable_host_degrades_to_an_empty_list() {
    let got = plaza::fetch_leaderboard(&http(), "https://plaza-leaderboard.invalid/").await;

    assert!(got.is_empty());
}

// ---------------------------------------------------------------- 4. 脏数据不拖垮整批

/// 上游首页把整份载荷当一个 JS 字符串塞进 `<script>`,真实字节因此是**转义态**
/// (真引号写作 `\"`)——直接手写裸引号 JSON 喂给 `fetch_leaderboard` 测不出真实场景,
/// `locate_initial_skills_array` 会在第一个裸引号处判定"配对失败"整体落空
/// (这正是本测试在开发阶段被"注入"抓到过的:写成裸引号时 `got` 是空的,不是
/// "跳过一条、留两条")。这里复现真实转义:构造未转义 JSON 文本,再用
/// `serde_json::to_string` 套一层 JSON 字符串转义,得到与上游同款的转义态字节。
fn escaped_html_body(unescaped_json: &str) -> String {
    let escaped = serde_json::to_string(unescaped_json).unwrap();
    // to_string 给字符串加了首尾引号,转义态本身不需要这两个引号
    // (上游 <script> 里也没有,是我们的扫描器自己套引号反转义)。
    format!("<script>{}</script>", &escaped[1..escaped.len() - 1])
}

#[tokio::test]
async fn a_dirty_entry_among_real_data_is_skipped_without_failing_the_batch() {
    let server = MockServer::start().await;
    let unescaped = r#"4e:["$","$L55",null,{"initialSkills":[{"source":"a/a","skillId":"one","name":"one","installs":10},{"source":"b/b","name":"missing-skill-id","installs":20},{"source":"c/c","skillId":"three","name":"three","installs":5}]}]"#;
    let body = escaped_html_body(unescaped);
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let got = plaza::fetch_leaderboard(&http(), &format!("{}/", server.uri())).await;

    let names: Vec<&str> = got.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["one", "three"], "{got:?}");
}

// ------------------------------------------- 5. owner/repo 形状过滤(2026-08-17 审查修复)

/// 2026-08-17 真机实测抓到的真实样本:`open.feishu.cn` 下的 `lark-doc` 技能,
/// `source` 是域名式来源、没有斜杠,不是 `owner/repo` 两段式。
///
/// 这不是假想的边界情况——用户提供的官网截图第 13 条就是这一条。点开它会在
/// `commands::parse_owner_repo` 那一层直接报"技能坐标格式不对"(压根到不了
/// GitHub API),摆出这张卡片等于主动把一个必然报错、且报错内容与"点了一张
/// 热门技能卡片"毫不相关的入口推给用户,必须在解析这一步就过滤掉。
#[tokio::test]
async fn an_entry_whose_source_is_not_owner_repo_shaped_is_filtered_out() {
    let server = MockServer::start().await;
    let unescaped = r#"4e:["$","$L55",null,{"initialSkills":[{"source":"vercel-labs/skills","skillId":"find-skills","name":"find-skills","installs":100},{"source":"open.feishu.cn","skillId":"lark-doc","name":"lark-doc","installs":90},{"source":"mattpocock/skills","skillId":"grill-me","name":"grill-me","installs":80}]}]"#;
    let body = escaped_html_body(unescaped);
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let got = plaza::fetch_leaderboard(&http(), &format!("{}/", server.uri())).await;

    assert_eq!(got.len(), 2, "{got:?}");
    assert!(
        got.iter().all(|c| c.owner_repo != "open.feishu.cn"),
        "域名式来源不该出现在渲染给用户的结果里: {got:?}"
    );
    let names: Vec<&str> = got.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["find-skills", "grill-me"]);
}
