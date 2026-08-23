//! 「作者未登记 · 这是我分享的」写回技能库的编排测试(v6 任务 3)。
//!
//! 断言纪律与 share_flow 一致:守卫盯的是**请求体与请求条数**,不是返回的枚举
//! ——"没确认就不写"要靠"一个 POST 都没发出去"来证明。
//!
//! 这条链路与分享共用权限矩阵,但提交里**只有 authors.json 一个文件**。
//! 单文件正是既有 `change_files_sparing_skill`(提交被拒就剥掉归因重试一次)
//! 唯一没有覆盖过的形状:剥完什么都不剩,"重试"会退化成发一笔空提交。

use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::ownership::Identity;
use skillsync_lib::core::share::{self, ShareClient, ShareMode, ShareOutcome};
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-08-24T09:00:00.000Z";
const SLUG: &str = "weekly-report";

fn me() -> Identity {
    Identity { login: "zhaowh".into(), display_name: "赵文浩".into() }
}

fn repo_ref() -> RepoRef {
    RepoRef { owner: "skills".into(), repo: "skills".into(), branch: "main".into() }
}

async fn mount_repo_info(server: &MockServer, push: bool) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main",
            "permissions": { "admin": false, "push": push, "pull": true },
            "empty": false
        })))
        .mount(server)
        .await;
}

/// 库根 authors.json 的现值。`None` = 文件还不存在(404)。
async fn mount_authors_json(server: &MockServer, repo_path: &str, sha: &str, existing: Option<&str>) {
    use base64::Engine;
    let m = Mock::given(method("GET"))
        .and(path(format!("/api/v1/repos/{repo_path}/contents/authors.json")));
    match existing {
        Some(text) => {
            m.respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sha": sha,
                "encoding": "base64",
                "content": base64::engine::general_purpose::STANDARD.encode(text)
            })))
            .mount(server)
            .await;
        }
        None => {
            m.respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(serde_json::json!({"message": "GetContentsOrList"})),
            )
            .mount(server)
            .await;
        }
    }
}

fn posts<'a>(
    reqs: &'a [wiremock::Request],
    repo_path: &str,
) -> Vec<&'a wiremock::Request> {
    let want = format!("/api/v1/repos/{repo_path}/contents");
    reqs.iter()
        .filter(|r| r.method.as_str() == "POST" && r.url.path() == want)
        .collect()
}

fn body_of(req: &wiremock::Request) -> serde_json::Value {
    serde_json::from_slice(&req.body).unwrap()
}

/// 从提交请求体里取出那唯一一个文件条目,并把内容解码成 JSON。
fn only_file(body: &serde_json::Value) -> (String, String, Option<String>, serde_json::Value) {
    use base64::Engine;
    let files = body["files"].as_array().unwrap();
    assert_eq!(files.len(), 1, "登记作者只该提交一个文件:{files:?}");
    let f = &files[0];
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(f["content"].as_str().unwrap())
        .unwrap();
    (
        f["path"].as_str().unwrap().to_string(),
        f["operation"].as_str().unwrap().to_string(),
        f["sha"].as_str().map(str::to_string),
        serde_json::from_slice(&bytes).unwrap(),
    )
}

#[tokio::test]
async fn claiming_writes_only_the_authors_file() {
    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    // 文件已经在,只是没有这个技能的条目
    mount_authors_json(
        &server,
        "skills/skills",
        "authsha",
        Some(r#"{"authors":{"other":{"author":"李四"}}}"#),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "newsha1", "html_url": "http://x/commit/newsha1" }
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::claim_attribution(
        &ShareClient::Gitea(&client),
        &repo_ref(),
        SLUG,
        &me(),
        NOW,
    )
    .await
    .unwrap();

    let ShareOutcome::Shared { mode, commit_sha, adopted, share_name, .. } = outcome else {
        panic!("登记作者不该要求拍板");
    };
    assert_eq!(mode, ShareMode::Pushed);
    assert_eq!(commit_sha, "newsha1");
    assert!(!adopted, "这条路一个文件都不搬");
    assert_eq!(share_name, SLUG);

    let reqs = server.received_requests().await.unwrap();
    let posted = posts(&reqs, "skills/skills");
    assert_eq!(posted.len(), 1);
    let body = body_of(posted[0]);
    assert!(body.get("new_branch").is_none(), "有直推权限就直接生效");
    assert_eq!(body["branch"], "main");
    let (path_, op, sha, doc) = only_file(&body);
    assert_eq!(path_, "authors.json");
    assert_eq!(op, "update");
    assert_eq!(sha.as_deref(), Some("authsha"));
    // 写进去的是展示名;别人的条目原样留着
    assert_eq!(doc["authors"][SLUG]["author"], "赵文浩");
    assert_eq!(doc["authors"]["other"]["author"], "李四");
}

/// 库里已经登记过分享者 → 拒绝,而且**一个写请求都不发**。
#[tokio::test]
async fn an_already_registered_skill_is_refused_before_any_write() {
    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_authors_json(
        &server,
        "skills/skills",
        "authsha",
        Some(&format!(r#"{{"authors":{{"{SLUG}":{{"author":"李四"}}}}}}"#)),
    )
    .await;
    // 写入端点故意不挂:真发了请求会得到 404 而不是静默通过
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let err = share::claim_attribution(
        &ShareClient::Gitea(&client),
        &repo_ref(),
        SLUG,
        &me(),
        NOW,
    )
    .await
    .expect_err("已登记过就不该再写一遍");

    // 先断"一个写请求都没发"——这条才是承重的那句(拒绝之前不许写);
    // 错误码断在后面,免得它先炸掉、把写守卫的失败挡在后面看不见。
    let reqs = server.received_requests().await.unwrap();
    assert!(
        posts(&reqs, "skills/skills").is_empty(),
        "拒绝之前不该发出任何提交"
    );
    assert_eq!(err.code, "CONFLICT_ALREADY_ATTRIBUTED");
}

/// 默认分支受保护(直推 403)→ 开分支 + 提交审核。
#[tokio::test]
async fn a_protected_branch_falls_back_to_review() {
    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_authors_json(&server, "skills/skills", "authsha", None).await;
    // 注册顺序即匹配顺序:带 new_branch 的先挂(放行),裸提交落到后面那条(403)
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .and(body_string_contains("new_branch"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "branchsha", "html_url": "http://x/commit/branchsha" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "message": "branch is protected"
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "html_url": "http://x/pulls/7", "number": 7
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::claim_attribution(
        &ShareClient::Gitea(&client),
        &repo_ref(),
        SLUG,
        &me(),
        NOW,
    )
    .await
    .unwrap();

    let ShareOutcome::Shared { mode, commit_sha, review_url, .. } = outcome else {
        panic!("应当提交成功");
    };
    assert_eq!(mode, ShareMode::ReviewRequested);
    assert_eq!(commit_sha, "branchsha");
    assert_eq!(review_url.as_deref(), Some("http://x/pulls/7"));

    let reqs = server.received_requests().await.unwrap();
    let posted = posts(&reqs, "skills/skills");
    assert_eq!(posted.len(), 2, "先试直推、被挡下才开分支");
    let (_, op, _, doc) = only_file(&body_of(posted[1]));
    assert_eq!(op, "create", "文件本来就不存在");
    assert_eq!(doc["authors"][SLUG]["author"], "赵文浩");
}

/// 只读用户走副本:**blob sha 必须取自副本仓**。拿上游的 sha 往副本上写会得到
/// `404 object does not exist`,整笔提交失败——只读用户永远登记不上。
#[tokio::test]
async fn a_read_only_user_claims_through_a_copy_and_takes_the_sha_from_it() {
    let server = MockServer::start().await;
    mount_repo_info(&server, false).await;
    // 上游与副本的 authors.json 内容相同、blob sha 不同 —— 断言用的就是这个差别
    let doc = r#"{"authors":{"other":{"author":"李四"}}}"#;
    mount_authors_json(&server, "skills/skills", "upstreamsha", Some(doc)).await;
    mount_authors_json(&server, "zhaowh/skills", "forkblobsha", Some(doc)).await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/forks"))
        .respond_with(ResponseTemplate::new(202).set_body_json(serde_json::json!({
            "name": "skills", "owner": { "login": "zhaowh" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/zhaowh/skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": { "sha": "forksha", "html_url": "http://x" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/pulls"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "html_url": "http://x/pulls/9", "number": 9
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let outcome = share::claim_attribution(
        &ShareClient::Gitea(&client),
        &repo_ref(),
        SLUG,
        &me(),
        NOW,
    )
    .await
    .unwrap();
    let ShareOutcome::Shared { mode, .. } = outcome else {
        panic!("应当提交成功");
    };
    assert_eq!(mode, ShareMode::ReviewRequested);

    let reqs = server.received_requests().await.unwrap();
    assert!(
        reqs.iter().any(|r| r.url.path() == "/api/v1/repos/zhaowh/skills/contents/authors.json"),
        "副本路径必须读副本自己的 authors.json"
    );
    let posted = posts(&reqs, "zhaowh/skills");
    assert_eq!(posted.len(), 1);
    let (_, op, sha, _) = only_file(&body_of(posted[0]));
    assert_eq!(op, "update");
    assert_eq!(
        sha.as_deref(),
        Some("forkblobsha"),
        "拿上游的 sha 往副本上写会 404,整笔提交失败"
    );
}

/// 提交被拒时**如实上报**,不许"剥掉归因重试一次"。
///
/// 这一笔提交里只有 authors.json,剥完就什么都不剩了——重试等于发一笔空提交。
/// 这条路只有本文件这个新调用方能走到,既有的分享链路永远带着技能文件。
#[tokio::test]
async fn a_rejected_single_file_commit_is_reported_not_retried_empty() {
    let server = MockServer::start().await;
    mount_repo_info(&server, true).await;
    mount_authors_json(
        &server,
        "skills/skills",
        "authsha",
        Some(r#"{"authors":{"other":{"author":"李四"}}}"#),
    )
    .await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "message": "sha does not match"
        })))
        .mount(&server)
        .await;
    let client = GiteaClient::new(server.uri(), None).unwrap();

    let err = share::claim_attribution(
        &ShareClient::Gitea(&client),
        &repo_ref(),
        SLUG,
        &me(),
        NOW,
    )
    .await
    .expect_err("提交被拒就该如实上报");
    assert_ne!(err.code, "", "错误码不该是空的");

    let reqs = server.received_requests().await.unwrap();
    assert_eq!(
        posts(&reqs, "skills/skills").len(),
        1,
        "剥完一个文件都不剩时不许重试(那会发一笔空提交)"
    );
}

/// 作者信息是公司技能库的契约,GitHub 源不维护(M7 拍板)。
/// 不假装成功——界面显示"已登记"而库里什么都没发生,比直说不支持糟得多。
#[tokio::test]
async fn a_github_source_says_so_instead_of_pretending() {
    let http = reqwest::Client::new();
    let gh = skillsync_lib::core::github::GithubClient::new("https://api.github.com", None, http);
    let err = share::claim_attribution(
        &ShareClient::Github(&gh),
        &repo_ref(),
        SLUG,
        &me(),
        NOW,
    )
    .await
    .expect_err("GitHub 源不登记作者");
    assert_eq!(err.code, "REPO_NO_ATTRIBUTION");
}
