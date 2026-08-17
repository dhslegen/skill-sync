//! `core::plaza::fetch_blob`(M10 任务 1)的 wiremock 集成测试。
//!
//! 真实 fixture(`fixtures/skillssh-download.json`)来自 2026-08-17 对
//! `https://skills.sh/api/download/wshobson/agents/code-review-excellence` 的真实请求
//! ——与任务 1 的 live 等价性实证是同一个样本,`SKILL.md` 字符长 13112、字节长 13225,
//! 正是"contents 必须按字节用"的活证据。其余测试用到的"变体"响应体是刻意构造的合法/脏
//! JSON,用于单独验证容错规则,不冒充真实抓取。

use skillsync_lib::core::plaza::{self, BlobFile};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FIXTURE: &str = include_str!("fixtures/skillssh-download.json");

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("SkillSync/test")
        .build()
        .unwrap()
}

fn file(path: &str, contents: &str) -> BlobFile {
    BlobFile { path: path.into(), contents: contents.into() }
}

async fn mount_download(server: &MockServer, owner: &str, repo: &str, slug: &str, body: String, status: u16) {
    Mock::given(method("GET"))
        .and(path(format!("/api/download/{owner}/{repo}/{slug}")))
        .respond_with(ResponseTemplate::new(status).set_body_string(body))
        .mount(server)
        .await;
}

// ---------------------------------------------------------------- 1. 真实 fixture(正常)

#[tokio::test]
async fn real_fixture_returns_the_single_file_with_full_byte_length() {
    let server = MockServer::start().await;
    mount_download(&server, "wshobson", "agents", "code-review-excellence", FIXTURE.to_string(), 200).await;

    let got = plaza::fetch_blob(&http(), &server.uri(), "wshobson", "agents", "code-review-excellence")
        .await
        .expect("真实 fixture 应当解析成功");

    assert_eq!(got.len(), 1);
    assert_eq!(got[0].path, "SKILL.md");
    // 字符数与字节数不相等,恰好是这份 fixture 存在的意义:contents 必须按字节用。
    assert_eq!(got[0].contents.chars().count(), 13112);
    assert_eq!(got[0].contents.len(), 13225);
}

// ---------------------------------------------------------------- 2. 多文件(变体)

#[tokio::test]
async fn parses_multiple_files_preserving_order() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "hash": "上游自己的口径,我们不用",
        "files": [
            {"path": "SKILL.md", "contents": "# 标题\n正文"},
            {"path": "references/foo.md", "contents": "子目录文件"},
        ]
    })
    .to_string();
    mount_download(&server, "o", "r", "multi", body, 200).await;

    let got = plaza::fetch_blob(&http(), &server.uri(), "o", "r", "multi")
        .await
        .expect("应当解析成功");

    assert_eq!(got, vec![file("SKILL.md", "# 标题\n正文"), file("references/foo.md", "子目录文件")]);
}

// ---------------------------------------------------------------- 3. 脏数据跳过

#[tokio::test]
async fn skips_entry_missing_contents_keeps_the_rest() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "files": [
            {"path": "SKILL.md", "contents": "ok"},
            // 缺 contents:整条脏数据,应跳过而不是让整批解析失败
            {"path": "references/broken.md"},
            {"path": "references/foo.md", "contents": "also ok"},
        ]
    })
    .to_string();
    mount_download(&server, "o", "r", "dirty1", body, 200).await;

    let got = plaza::fetch_blob(&http(), &server.uri(), "o", "r", "dirty1")
        .await
        .expect("单条脏数据不应让整批失败");

    assert_eq!(got, vec![file("SKILL.md", "ok"), file("references/foo.md", "also ok")]);
}

#[tokio::test]
async fn skips_entry_missing_path_keeps_the_rest() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "files": [
            {"path": "SKILL.md", "contents": "ok"},
            // 缺 path:整条脏数据
            {"contents": "no path here"},
        ]
    })
    .to_string();
    mount_download(&server, "o", "r", "dirty2", body, 200).await;

    let got = plaza::fetch_blob(&http(), &server.uri(), "o", "r", "dirty2")
        .await
        .expect("单条脏数据不应让整批失败");

    assert_eq!(got, vec![file("SKILL.md", "ok")]);
}

// ---------------------------------------------------------------- 4. 未知字段宽容

#[tokio::test]
async fn tolerates_unknown_fields() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "hash": "abc123",
        "somethingUpstreamAddsLater": {"nested": true},
        "files": [
            {"path": "SKILL.md", "contents": "ok", "size": 2, "encoding": "utf-8"}
        ]
    })
    .to_string();
    mount_download(&server, "o", "r", "unknown", body, 200).await;

    let got = plaza::fetch_blob(&http(), &server.uri(), "o", "r", "unknown")
        .await
        .expect("未知字段不应拦解析");

    assert_eq!(got, vec![file("SKILL.md", "ok")]);
}

// ---------------------------------------------------------------- 5/6. 错误映射

#[tokio::test]
async fn http_404_maps_to_net_plaza_blob() {
    let server = MockServer::start().await;
    let body = serde_json::json!({"error": "not found"}).to_string();
    mount_download(&server, "o", "r", "missing", body, 404).await;

    let err = plaza::fetch_blob(&http(), &server.uri(), "o", "r", "missing")
        .await
        .expect_err("404 应当映射成错误");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
    assert_eq!(err.message, "获取技能内容失败,请稍后重试");
}

#[tokio::test]
async fn non_json_body_maps_to_net_plaza_blob() {
    let server = MockServer::start().await;
    mount_download(&server, "o", "r", "badjson", "<html>not json at all</html>".to_string(), 200).await;

    let err = plaza::fetch_blob(&http(), &server.uri(), "o", "r", "badjson")
        .await
        .expect_err("非 JSON 响应应当映射成错误");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
    assert_eq!(err.message, "获取技能内容失败,请稍后重试");
}

// ---------------------------------------------------------------- 7. 请求形状

#[tokio::test]
async fn request_hits_the_expected_path() {
    let server = MockServer::start().await;
    let body = serde_json::json!({"files": [{"path": "SKILL.md", "contents": "ok"}]}).to_string();
    // 严格匹配路径;匹配不上 wiremock 不会命中这条桩,fetch_blob 就会拿到默认的 404,
    // 从而以 NET_PLAZA_BLOB 报错——本测试断言"确实命中且只命中一次"。
    Mock::given(method("GET"))
        .and(path("/api/download/acme/tools/hello"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .expect(1)
        .mount(&server)
        .await;

    let got = plaza::fetch_blob(&http(), &server.uri(), "acme", "tools", "hello")
        .await
        .expect("路径对得上,应当命中桩");

    assert_eq!(got, vec![file("SKILL.md", "ok")]);
}

// ---------------------------------------------------------------- 8. 空文件列表

#[tokio::test]
async fn empty_files_array_returns_empty_vec_not_error() {
    let server = MockServer::start().await;
    let body = serde_json::json!({"files": []}).to_string();
    mount_download(&server, "o", "r", "empty", body, 200).await;

    let got = plaza::fetch_blob(&http(), &server.uri(), "o", "r", "empty")
        .await
        .expect("空文件列表不是错误");

    assert!(got.is_empty());
}
