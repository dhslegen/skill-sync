//! v8 任务 9:详情面板 / 分享确认屏「点开一个文件看内容」的 Gitea 那条通道。
//!
//! 🔴 这组测试的判别力靠**两个桩、两份不同内容**,不靠"没报错":
//! 同一个路径挂两个桩,`?ref=<commit_sha>` 给「列表那一版」、`?ref=main` 给「分支头
//! 那一版」,两份正文不同。实现若退回按分支头取,拿到的是 200 + **错的内容**,
//! 红在内容断言那一行——而不是"wiremock 没匹配上 → 404 → 被错误映射兜住"那种
//! 红在别处的假信号(本项目第一大陷阱)。

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use skillsync_lib::core::file_preview::{self, FileContent, GiteaFileCache};
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const LISTED_SHA: &str = "1111111111111111111111111111111111111111";
const SKILL_PATH: &str = "skills/weekly-report";

fn repo_ref() -> RepoRef {
    RepoRef { owner: "skills".into(), repo: "skills".into(), branch: "main".into() }
}

fn client(server: &MockServer) -> GiteaClient {
    GiteaClient::new(server.uri(), None).unwrap()
}

fn cache() -> GiteaFileCache {
    Mutex::new(HashMap::new())
}

/// contents API 的真实响应形状(base64 带换行分段,与 `file_content` 的解码约定一致)。
fn contents_body(bytes: &[u8]) -> serde_json::Value {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    serde_json::json!({ "sha": "blobsha", "encoding": "base64", "content": b64 })
}

/// 同一个文件挂两个桩:列表那一版(按 sha)与分支头那一版(按 main),内容不同。
async fn mount_two_versions(server: &MockServer, file: &str, listed: &str, head: &str) {
    let api_path = format!("/api/v1/repos/skills/skills/contents/{file}");
    Mock::given(method("GET"))
        .and(path(api_path.clone()))
        .and(query_param("ref", LISTED_SHA))
        .respond_with(ResponseTemplate::new(200).set_body_json(contents_body(listed.as_bytes())))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(api_path))
        .and(query_param("ref", "main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(contents_body(head.as_bytes())))
        .mount(server)
        .await;
}

/// 测试清单 3:请求 URL 真的带 `?ref=<commit_sha>`,取回的是**列表那一版**。
#[tokio::test]
async fn gitea_read_is_pinned_to_the_listed_commit_not_the_branch_head() {
    let server = MockServer::start().await;
    mount_two_versions(
        &server,
        "skills/weekly-report/templates/dept.md",
        "列表那一版的内容",
        "分支头已经改成了别的",
    )
    .await;

    let got = file_preview::read_gitea(
        &client(&server),
        &cache(),
        "company",
        &repo_ref(),
        LISTED_SHA,
        SKILL_PATH,
        "templates/dept.md",
    )
    .await
    .unwrap();

    assert_eq!(got, FileContent::Text { text: "列表那一版的内容".into() });
}

/// 测试清单 4(对照组):分享时读库根 `authors.json` 那条路走的是 `file_content`,
/// 它要的**就是分支头**——任务 9 不许顺手把它也改成按 sha 取。
#[tokio::test]
async fn authors_json_read_still_follows_the_branch_head() {
    let server = MockServer::start().await;
    mount_two_versions(&server, "authors.json", "{\"old\":1}", "{\"head\":1}").await;

    let (_, bytes) = client(&server)
        .file_content(&repo_ref(), "authors.json")
        .await
        .unwrap()
        .expect("分支头上有这个文件");
    assert_eq!(bytes, b"{\"head\":1}");
}

/// 测试清单 5:该 sha 下文件不存在 → 明确错误,**不是空内容**
/// (空内容会被当成"这是个空文件",那是假话)。
#[tokio::test]
async fn a_file_missing_at_that_commit_is_an_error_not_empty_content() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/contents/skills/weekly-report/gone.md"))
        .and(query_param("ref", LISTED_SHA))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "message": "object does not exist"
        })))
        .mount(&server)
        .await;

    let err = file_preview::read_gitea(
        &client(&server),
        &cache(),
        "company",
        &repo_ref(),
        LISTED_SHA,
        SKILL_PATH,
        "gone.md",
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "REPO_FILE_NOT_FOUND");
}

/// 测试清单 8:缓存命中 → 第二次读**零请求**。`.expect(1)` 由 MockServer drop 时校验。
#[tokio::test]
async fn a_cached_gitea_read_sends_no_second_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/contents/skills/weekly-report/SKILL.md"))
        .and(query_param("ref", LISTED_SHA))
        .respond_with(ResponseTemplate::new(200).set_body_json(contents_body(b"# hi\n")))
        .expect(1)
        .mount(&server)
        .await;

    let c = client(&server);
    let cache = cache();
    for _ in 0..2 {
        let got = file_preview::read_gitea(
            &c, &cache, "company", &repo_ref(), LISTED_SHA, SKILL_PATH, "SKILL.md",
        )
        .await
        .unwrap();
        assert_eq!(got, FileContent::Text { text: "# hi\n".into() });
    }
    server.verify().await;
}

/// 缓存键带版本:同一路径换一个 commit_sha 必须重新取,不能拿旧版本顶替。
#[tokio::test]
async fn the_cache_key_carries_the_commit_sha() {
    let server = MockServer::start().await;
    mount_two_versions(&server, "skills/weekly-report/SKILL.md", "旧版", "新版").await;

    let c = client(&server);
    let cache = cache();
    let old = file_preview::read_gitea(
        &c, &cache, "company", &repo_ref(), LISTED_SHA, SKILL_PATH, "SKILL.md",
    )
    .await
    .unwrap();
    // 这里拿 "main" 当 sha 喂进去只是为了命中第二个桩——它代表"另一个版本号"
    let newer = file_preview::read_gitea(
        &c, &cache, "company", &repo_ref(), "main", SKILL_PATH, "SKILL.md",
    )
    .await
    .unwrap();
    assert_eq!(old, FileContent::Text { text: "旧版".into() });
    assert_eq!(newer, FileContent::Text { text: "新版".into() });
}

/// 越界的相对路径在发请求之前就被拒(任意路径 `.expect(0)`)。
#[tokio::test]
async fn a_traversal_path_is_rejected_before_any_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(contents_body(b"x")))
        .expect(0)
        .mount(&server)
        .await;

    let err = file_preview::read_gitea(
        &client(&server),
        &cache(),
        "company",
        &repo_ref(),
        LISTED_SHA,
        SKILL_PATH,
        "../other-skill/SKILL.md",
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "FS_UNSAFE_PATH");
    server.verify().await;
}
