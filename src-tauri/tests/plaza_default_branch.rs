//! `core::plaza::default_branch`(M9 任务 3)的 wiremock 集成测试。
//!
//! 挂在 `/repos/{owner}/{repo}` 之下(不带 `/api/v3`):`default_branch` 内部委派给
//! `github::fetch_repo_view`(2026-08-12 审查后重构,两者共用同一个外部契约——
//! URL 构造/鉴权头/状态码分档/JSON 解析只有一份实现,详见 `core/plaza.rs` 与
//! `core/github.rs::fetch_repo_view` 的文档)。这里测的是 `default_branch` 对外的
//! **统一错误码**这层契约(`NET_PLAZA_REPO`),不是共享函数内部怎么发请求
//! ——那部分由 `github.rs` 自己的既有测试(`tests/github_client.rs` 等)与
//! `repo_view` 的既有调用方覆盖。

use skillsync_lib::core::plaza;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("SkillSync/test")
        .build()
        .unwrap()
}

// ---------------------------------------------------------------- 1. 正常响应

#[tokio::test]
async fn reads_the_default_branch_from_a_real_shaped_response() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/vercel-labs/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            // 真实响应远不止这几个字段,宽容解析只取要的那一个。
            r#"{"id":1,"name":"skills","full_name":"vercel-labs/skills","default_branch":"main","private":false}"#,
        ))
        .mount(&server)
        .await;

    let branch = plaza::default_branch(&http(), &server.uri(), "vercel-labs", "skills")
        .await
        .expect("正常响应应解析成功");
    assert_eq!(branch, "main");
}

#[tokio::test]
async fn a_non_main_default_branch_is_reported_as_is() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/someorg/legacy"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(r#"{"default_branch":"develop"}"#),
        )
        .mount(&server)
        .await;

    let branch = plaza::default_branch(&http(), &server.uri(), "someorg", "legacy")
        .await
        .unwrap();
    assert_eq!(branch, "develop");
}

/// 200 但响应体缺 `default_branch` 字段(或字段为空串)是广场自己的业务规则
/// ——挂仓必须拿到一个可用的分支名,这条不属于 `github::fetch_repo_view` 共享的
/// 外部契约(那份契约只管"这个端点怎么发请求、状态码怎么分档"),判定留在
/// `default_branch` 自己身上。2026-08-12 审查重构时新增:此前这条由一个独立的纯函数
/// `parse_default_branch` 覆盖,拆掉那个函数后这里补上等价的集成测试,不让业务规则
/// 悄悄失去覆盖。
#[tokio::test]
async fn a_200_missing_the_default_branch_field_is_still_an_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/someorg/no-field"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"full_name":"someorg/no-field"}"#))
        .mount(&server)
        .await;

    let err = plaza::default_branch(&http(), &server.uri(), "someorg", "no-field")
        .await
        .unwrap_err();
    assert_eq!(err.code, "NET_PLAZA_REPO");
}

// ---------------------------------------------------------------- 2. 404 → 中文错误

#[tokio::test]
async fn a_404_maps_to_a_chinese_net_plaza_repo_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/ghost/none"))
        .respond_with(ResponseTemplate::new(404).set_body_string(
            r#"{"message":"Not Found"}"#,
        ))
        .mount(&server)
        .await;

    let err = plaza::default_branch(&http(), &server.uri(), "ghost", "none")
        .await
        .unwrap_err();
    assert_eq!(err.code, "NET_PLAZA_REPO");
    assert!(err.message.chars().any(|c| c as u32 > 127), "{}", err.message);
    assert!(!err.message.contains("ghost"), "错误文案不该带内部标识: {}", err.message);
}

/// 与上一条的区别:响应体本身长得完全像一份能成功解析的正常响应
/// (`default_branch` 字段齐全)——**只有状态码是错的**。这条才真的验到了
/// "非 200 必须报错"这条规则本身;上一条的 404 响应体缺 `default_branch`,
/// 就算状态码检查被删掉,解析阶段照样会报错,那条测试对状态码检查是空转的
/// (注入验证时发现的:见任务报告)。
#[tokio::test]
async fn a_404_with_a_well_formed_body_is_still_rejected_by_status_alone() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/looks/valid"))
        .respond_with(
            ResponseTemplate::new(404).set_body_string(r#"{"default_branch":"main"}"#),
        )
        .mount(&server)
        .await;

    let err = plaza::default_branch(&http(), &server.uri(), "looks", "valid")
        .await
        .unwrap_err();
    assert_eq!(err.code, "NET_PLAZA_REPO");
}

// ---------------------------------------------------------------- 3. 网络错误 / 限流也归一

/// 同上,响应体也是"看起来能成功解析"的形状,专测状态码这一步(不是靠
/// 空响应体侥幸失败)。
#[tokio::test]
async fn a_5xx_also_maps_to_the_unified_error_code() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/vercel-labs/skills"))
        .respond_with(
            ResponseTemplate::new(503).set_body_string(r#"{"default_branch":"main"}"#),
        )
        .mount(&server)
        .await;

    let err = plaza::default_branch(&http(), &server.uri(), "vercel-labs", "skills")
        .await
        .unwrap_err();
    assert_eq!(err.code, "NET_PLAZA_REPO", "5xx 与 404 一样统一归一,不另开分支");
}

#[tokio::test]
async fn an_unreachable_host_maps_to_the_unified_error_code() {
    // 保留域名(RFC 2606),DNS 必然解析失败——不靠 drop(MockServer) 空出端口
    // 那套(并发测试下别的 MockServer 可能立刻绑上,见 CLAUDE.md 的测试要求一节)。
    let err = plaza::default_branch(&http(), "https://plaza-repo.invalid", "a", "b")
        .await
        .unwrap_err();
    assert_eq!(err.code, "NET_PLAZA_REPO");
}
