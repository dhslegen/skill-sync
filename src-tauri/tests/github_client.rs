//! GitHub client 的行为测试(M3 任务 4)。
//!
//! zipball fixture 是真实录制的裁剪:2026-07-31 从
//! `GET https://api.github.com/repos/junegunn/fzf/zipball/master`(302 → codeload)
//! 下载后取 5 个代表性条目,**原样保留 central directory 的 external_attr**
//! (裁剪脚本曾把 mode=0 的条目擅自补成 0o600,已修——"0 = 没记录"正是要钉住的事实)。

use skillsync_lib::core::github::{api_base_for, GithubClient};
use skillsync_lib::core::gitea::RepoRef;
use wiremock::matchers::{header, header_exists, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const ZIPBALL: &[u8] = include_bytes!("fixtures/github-zipball-modes.zip");

fn repo() -> RepoRef {
    RepoRef {
        owner: "junegunn".into(),
        repo: "fzf".into(),
        branch: "master".into(),
    }
}

fn client(server: &MockServer, token: Option<&str>) -> GithubClient {
    // 测试直连 wiremock:api_base_for 对非 github.com 主机给 {base}/api/v3,
    // 所以 mock 路径都挂在 /api/v3 下——这同时把 GHE 形态的推导测在真路径上
    GithubClient::new(
        &server.uri(),
        token.map(String::from),
        reqwest::Client::new(),
    )
}

#[test]
fn api_base_matches_dotcom_and_enterprise_conventions() {
    assert_eq!(api_base_for("https://github.com"), "https://api.github.com");
    assert_eq!(api_base_for("https://github.com/"), "https://api.github.com");
    // GHE 官方约定(假设:未实测,见模块头)
    assert_eq!(
        api_base_for("https://ghe.example.com"),
        "https://ghe.example.com/api/v3"
    );
}

#[tokio::test]
async fn branch_head_maps_sha_and_committer_date() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/branches/master"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            // 真实响应的最小子集(2026-07-31 录制的形状):sha 在 commit.sha,
            // 提交时间在 commit.commit.committer.date
            r#"{"name":"master","commit":{"sha":"e36576429dbdcb447b05b999f266e1c2913b543b",
                "commit":{"committer":{"name":"Junegunn Choi","date":"2026-07-30T15:18:30Z"}}}}"#,
        ))
        .mount(&server)
        .await;

    let head = client(&server, None).branch_head(&repo()).await.unwrap();
    assert_eq!(head.sha, "e36576429dbdcb447b05b999f266e1c2913b543b");
    assert_eq!(head.committed_at, "2026-07-30T15:18:30Z");
}

#[tokio::test]
async fn zipball_parsing_matches_recorded_github_behavior() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/zipball/master"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(ZIPBALL))
        .mount(&server)
        .await;

    let archive = client(&server, None)
        .download_archive(&repo())
        .await
        .unwrap();

    // 前缀是 {owner}-{repo}-{短sha} —— 不是 gitea.rs 老注释猜的 <repo>-<ref>
    assert_eq!(archive.root, "junegunn-fzf-e365764");
    let exec = &archive.entries["junegunn-fzf-e365764/install"];
    assert_eq!(exec.unix_mode, Some(0o755), "可执行位必须从 zip 里带出来");
    assert!(exec.is_executable());
    // GitHub 与 Gitea 同语义:普通文件"没记 mode",是 None 而不是脑补出来的 0o644
    let plain = &archive.entries["junegunn-fzf-e365764/README.md"];
    assert_eq!(plain.unix_mode, None);
    assert!(!plain.is_executable());
    assert!(!archive.entries.contains_key("junegunn-fzf-e365764/"), "目录条目不进文件清单");
}

#[tokio::test]
async fn rate_limit_gets_a_readable_error_instead_of_a_bare_403() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/branches/master"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "0")
                .set_body_string(r#"{"message":"API rate limit exceeded for 1.2.3.4."}"#),
        )
        .mount(&server)
        .await;

    let err = client(&server, None).branch_head(&repo()).await.unwrap_err();
    assert_eq!(err.code, "NET_RATE_LIMITED");
    // 人话 + 下一步动作,且不是把英文报错原样丢给用户
    assert!(!err.message.contains("rate limit"), "{}", err.message);
    assert!(
        err.message.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn not_found_and_plain_forbidden_keep_their_meanings() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/branches/master"))
        .respond_with(ResponseTemplate::new(404).set_body_string(r#"{"message":"Not Found"}"#))
        .mount(&server)
        .await;
    let err = client(&server, None).branch_head(&repo()).await.unwrap_err();
    assert_eq!(err.code, "REPO_NOT_FOUND");

    let server2 = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/branches/master"))
        .respond_with(
            ResponseTemplate::new(403)
                .insert_header("x-ratelimit-remaining", "42")
                .set_body_string(r#"{"message":"Must have push access"}"#),
        )
        .mount(&server2)
        .await;
    let err = client(&server2, None).branch_head(&repo()).await.unwrap_err();
    assert_eq!(err.code, "REPO_FORBIDDEN", "还有余量的 403 不是限流,不能错报");
}

#[tokio::test]
async fn anonymous_requests_carry_no_authorization_and_token_becomes_bearer() {
    // 带凭证:必须是 Bearer 头
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/branches/master"))
        .and(header("authorization", "Bearer tok-abc"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"commit":{"sha":"abc","commit":{"committer":{"date":"2026-01-01T00:00:00Z"}}}}"#,
        ))
        .mount(&server)
        .await;
    client(&server, Some("tok-abc"))
        .branch_head(&repo())
        .await
        .expect("带凭证的请求应命中 Bearer 匹配");

    // 匿名:绝不能带 Authorization——空值或垃圾头会让 GitHub 直接 401
    let server2 = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/branches/master"))
        .and(header_exists("authorization"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server2)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/branches/master"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"commit":{"sha":"abc","commit":{"committer":{"date":"2026-01-01T00:00:00Z"}}}}"#,
        ))
        .mount(&server2)
        .await;
    client(&server2, None)
        .branch_head(&repo())
        .await
        .expect("匿名请求带了 Authorization 头会命中 500 桩");
}

// ============================================================ tree(M10 任务 3)

#[tokio::test]
async fn tree_parses_paths_and_the_truncated_flag() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/git/trees/abc1234"))
        .and(query_param("recursive", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"sha":"abc1234","truncated":false,"tree":[
                {"path":"README.md","type":"blob"},
                {"path":"plugins","type":"tree"},
                {"path":"plugins/skills/demo/SKILL.md","type":"blob"}
            ]}"#,
        ))
        .mount(&server)
        .await;

    let tree = client(&server, None).tree(&repo(), "abc1234").await.unwrap();
    assert!(!tree.truncated);
    assert_eq!(
        tree.paths,
        vec![
            "README.md".to_string(),
            "plugins".to_string(),
            "plugins/skills/demo/SKILL.md".to_string(),
        ]
    );
}

#[tokio::test]
async fn tree_surfaces_the_truncated_flag_when_the_repo_is_too_large() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/git/trees/abc1234"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"sha":"abc1234","truncated":true,"tree":[{"path":"README.md","type":"blob"}]}"#,
        ))
        .mount(&server)
        .await;

    let tree = client(&server, None).tree(&repo(), "abc1234").await.unwrap();
    assert!(tree.truncated, "被截断的树必须原样把 truncated=true 带出来,不能吞掉");
}

#[tokio::test]
async fn tree_maps_404_the_same_way_as_other_endpoints() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/git/trees/deadbee"))
        .respond_with(ResponseTemplate::new(404).set_body_string(r#"{"message":"Not Found"}"#))
        .mount(&server)
        .await;

    let err = client(&server, None).tree(&repo(), "deadbee").await.unwrap_err();
    assert_eq!(err.code, "REPO_NOT_FOUND");
}

#[tokio::test]
async fn tree_request_uses_the_given_sha_not_the_branch_name() {
    // repo() 的分支是 master,但 tree() 必须用调用方传入的 commit sha 拼 URL——
    // 树与 blob 内容要是同一个快照,传分支名会在分支推进后撕裂。
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/git/trees/master"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/junegunn/fzf/git/trees/e365764"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            r#"{"sha":"e365764","truncated":false,"tree":[]}"#,
        ))
        .mount(&server)
        .await;

    client(&server, None)
        .tree(&repo(), "e365764")
        .await
        .expect("必须命中按 sha 拼的 URL,而不是按分支名拼的那条 404 桩");
}
