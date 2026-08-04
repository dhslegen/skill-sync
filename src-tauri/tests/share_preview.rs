//! 分享前的权限预检(M4 任务 2)。
//!
//! 判据来自真实录制:`tests/fixtures/gitea-permissions/NOTES.md`。核心结论是
//! **`permissions.push` 单独用会说谎**(main 受保护时它仍是 true,而直推必然 403),
//! 准确判据是 `branches/{branch}` 的 `user_can_push`。
//!
//! 这里的响应体**原样喂录制文件**,不手打 JSON:手打时会照着 Rust 字段名打,
//! 两边一起把 `user_can_push` 写成 `userCanPush` 就测不出来了(M3 的
//! `new_branch`→`newBranch` 就是这么溜过去的)。

use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::share::{self, ShareClient, SharePath};
use wiremock::matchers::{header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gitea-permissions");

fn repo() -> RepoRef {
    RepoRef {
        owner: "ai-skills".into(),
        repo: "team-skills".into(),
        // 目标分支刻意不叫 main:预检必须查**目标分支**,不是默认分支
        // ——多仓下两者完全可能不同,查错了预告的就是另一条分支的规则。
        branch: "release".into(),
    }
}

/// 录制的未保护 + 普通写权限响应,按需改两个布尔。
fn branch_body(protected: bool, user_can_push: bool) -> serde_json::Value {
    let raw = std::fs::read_to_string(format!("{FIXTURES}/branch-unprotected-writer.json"))
        .expect("录制文件缺失");
    let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    v["protected"] = protected.into();
    v["user_can_push"] = user_can_push.into();
    v
}

fn repo_body(push: bool) -> serde_json::Value {
    let raw = std::fs::read_to_string(format!("{FIXTURES}/repo-readonly.json")).expect("录制文件缺失");
    let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    v["permissions"]["push"] = push.into();
    v
}

/// 挂两个端点。**都要求带 Authorization**:匿名与只读的 permissions 完全相同
/// (录制结论 5),拿匿名 client 探出来的永远是"无权限",而那正是最容易犯的错
/// ——`read_source` 对内建源硬编码匿名。没有这条 header 断言,匿名实现也能测绿。
async fn mount(server: &MockServer, branch: serde_json::Value, repo_info: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/ai-skills/team-skills/branches/release"))
        .and(header_exists("authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(branch))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/ai-skills/team-skills"))
        .and(header_exists("authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(repo_info))
        .mount(server)
        .await;
}

fn gitea(server: &MockServer) -> GiteaClient {
    GiteaClient::new(server.uri(), Some("tok-abc".into())).unwrap()
}

async fn preview(client: &GiteaClient, r: &RepoRef) -> SharePath {
    share::preview_permission(&ShareClient::Gitea(client), r).await
}

// ============================================================ Gitea 三档

#[tokio::test]
async fn writable_and_unprotected_predicts_a_direct_push() {
    let server = MockServer::start().await;
    mount(&server, branch_body(false, true), repo_body(true)).await;
    assert_eq!(preview(&gitea(&server), &repo()).await, SharePath::DirectPush);
}

#[tokio::test]
async fn writable_but_protected_predicts_a_review_in_the_same_library() {
    // 这一档是整个任务的理由:`permissions.push` 仍是 true,只有 user_can_push 说了实话。
    // 判定若照抄 submit_gitea 的 permissions.push,这里就会预告"直接生效"——假话。
    let server = MockServer::start().await;
    mount(&server, branch_body(true, false), repo_body(true)).await;
    assert_eq!(preview(&gitea(&server), &repo()).await, SharePath::ReviewInRepo);
}

#[tokio::test]
async fn read_only_predicts_a_review_via_a_personal_copy() {
    let server = MockServer::start().await;
    mount(&server, branch_body(true, false), repo_body(false)).await;
    assert_eq!(preview(&gitea(&server), &repo()).await, SharePath::ReviewViaCopy);
    // 未保护的只读库同样走这条:user_can_push=false 且没有写权限
    let server = MockServer::start().await;
    mount(&server, branch_body(false, false), repo_body(false)).await;
    assert_eq!(preview(&gitea(&server), &repo()).await, SharePath::ReviewViaCopy);
}

// ============================================================ 探不到时一律 Unknown

#[tokio::test]
async fn an_unreachable_or_missing_branch_is_unknown_not_no_permission() {
    // `permissions` 的 serde default 会把"读不到"变成 push:false,落进"无权限"档
    // 就是反向撒谎。空库/刚建的库查分支是 404,同样走这条。
    for status in [404u16, 500, 502] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&server)
            .await;
        assert_eq!(
            preview(&gitea(&server), &repo()).await,
            SharePath::Unknown,
            "HTTP {status} 应当是「未知」,不能落进无权限档"
        );
    }
    // 连不上也一样。**不能靠 drop 掉 MockServer 空出端口来模拟**:测试是并发跑的,
    // 另一个 MockServer 完全可能立刻绑上刚空出来的随机端口,请求就打到别人身上,
    // 拿到的是那个 server 的响应而不是连接失败(2026-08-04 macOS CI 真红过一次,
    // 之前一直绿只是运气好)。用保留域名 `.invalid`,DNS 必然解析不出来——
    // 与 `tests/proxy_bypass.rs` 绕开 loopback 豁免是同一个套路。
    let client =
        GiteaClient::new("http://unreachable.invalid".to_string(), Some("tok-abc".into())).unwrap();
    assert_eq!(preview(&client, &repo()).await, SharePath::Unknown);
}

#[tokio::test]
async fn an_old_gitea_without_user_can_push_falls_back_instead_of_erroring() {
    // 旧版 Gitea 的 branches 响应没有这个字段。此时唯一能说的是"有没有写权限",
    // 分支保护未知——不能假装知道,退回 Unknown/ReviewViaCopy 两档。
    let server = MockServer::start().await;
    let mut body = branch_body(false, true);
    body.as_object_mut().unwrap().remove("user_can_push");
    mount(&server, body, repo_body(true)).await;
    // 有写权限但探不到分支能否直推:说不准,不许预告"直接生效"
    assert_eq!(preview(&gitea(&server), &repo()).await, SharePath::Unknown);

    // 没有写权限则与新版一致:必然要复制一份
    let server = MockServer::start().await;
    let mut body = branch_body(false, false);
    body.as_object_mut().unwrap().remove("user_can_push");
    mount(&server, body, repo_body(false)).await;
    assert_eq!(preview(&gitea(&server), &repo()).await, SharePath::ReviewViaCopy);
}

// ============================================================ GitHub 两档(不假装能预知保护)

#[tokio::test]
async fn github_with_push_access_says_maybe_direct_never_promises_it() {
    // GitHub 的分支保护预检不到(REST branch-protection 端点要 admin 权限),
    // 所以有写权限时只能说"可能直接生效"。硬说 DirectPush 就是在猜。
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/ai-skills/team-skills"))
        .and(header_exists("authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main",
            "permissions": { "push": true }
        })))
        .mount(&server)
        .await;
    let client = GithubClient::new(&server.uri(), Some("tok-abc".into()), reqwest::Client::new());
    assert_eq!(
        share::preview_permission(&ShareClient::Github(&client), &repo()).await,
        SharePath::MaybeDirect
    );
}

#[tokio::test]
async fn github_without_push_access_predicts_a_personal_copy() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/ai-skills/team-skills"))
        .and(header_exists("authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main",
            "permissions": {}
        })))
        .mount(&server)
        .await;
    let client = GithubClient::new(&server.uri(), Some("tok-abc".into()), reqwest::Client::new());
    assert_eq!(
        share::preview_permission(&ShareClient::Github(&client), &repo()).await,
        SharePath::ReviewViaCopy
    );
}

#[tokio::test]
async fn github_failures_are_unknown_too() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;
    let client = GithubClient::new(&server.uri(), Some("tok-abc".into()), reqwest::Client::new());
    assert_eq!(
        share::preview_permission(&ShareClient::Github(&client), &repo()).await,
        SharePath::Unknown
    );
}

// ============================================================ 前端契约

#[test]
fn the_serialized_shape_carries_no_user_facing_prose() {
    // 文案在 i18n。core 返回中文句子的话,两道术语门都扫不到它:
    // tests/terminology.rs 只扒 AppError::new 的 message,前端守卫只扫 src/。
    for (variant, tag) in [
        (SharePath::DirectPush, "directPush"),
        (SharePath::ReviewInRepo, "reviewInRepo"),
        (SharePath::ReviewViaCopy, "reviewViaCopy"),
        (SharePath::MaybeDirect, "maybeDirect"),
        (SharePath::Unknown, "unknown"),
    ] {
        let json = serde_json::to_string(&variant).unwrap();
        assert_eq!(json, format!("\"{tag}\""), "{variant:?}");
        assert!(
            !json.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
            "core 不返回用户可见文案:{json}"
        );
    }
}
