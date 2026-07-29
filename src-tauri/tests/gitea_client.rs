//! Gitea client 的错误映射与请求构造测试。
//!
//! 响应体全部照抄 fixtures 实例上录到的真实内容(见 core/gitea.rs 模块头),
//! 而不是照文档臆造——mock 只能验证"我们如何处理响应",验证不了"响应长什么样",
//! 所以响应本身必须来自真实观测。

use skillsync_lib::core::gitea::{ChangeFilesRequest, FileChange, GiteaClient, RepoRef};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "ai-skills".into(),
        repo: "team-skills".into(),
        branch: "main".into(),
    }
}

fn client(server: &MockServer) -> GiteaClient {
    GiteaClient::new(server.uri(), Some("test-token".into())).unwrap()
}

#[tokio::test]
async fn sends_token_as_authorization_header() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/user"))
        .and(header("Authorization", "token test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "login": "skillsync-admin",
            "full_name": "",
            "avatar_url": "http://127.0.0.1:3300/avatars/ef80"
        })))
        .mount(&server)
        .await;

    let user = client(&server).current_user().await.unwrap();
    assert_eq!(user.login, "skillsync-admin");
    // Gitea 发的是 snake_case。这里必须断到实际取值:字段带 serde(default) 时,
    // 若改名方向配错会静默拿到空串,只断 login 是看不出来的。
    assert_eq!(user.avatar_url, "http://127.0.0.1:3300/avatars/ef80");
}

#[tokio::test]
async fn unauthorized_maps_to_relogin_prompt() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/user"))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
            "message": "invalid username, password or token",
            "url": "http://127.0.0.1:3300/api/swagger"
        })))
        .mount(&server)
        .await;

    let err = client(&server).current_user().await.unwrap_err();
    assert_eq!(err.code, "AUTH_INVALID");
    assert!(err.message.contains("重新登录"), "{}", err.message);
    // 技术细节进 detail,不进给用户看的 message
    assert!(err.detail.unwrap().contains("invalid username"));
}

#[tokio::test]
async fn missing_repo_maps_to_not_found() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/ai-skills/nope"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "errors": ["object does not exist [id: , rel_path: ]"],
            "message": "GetRepo",
            "url": "http://127.0.0.1:3300/api/swagger"
        })))
        .mount(&server)
        .await;

    let err = client(&server)
        .repo_info("ai-skills", "nope")
        .await
        .unwrap_err();
    assert_eq!(err.code, "REPO_NOT_FOUND");
}

#[tokio::test]
async fn missing_file_is_absence_not_error() {
    // 分享预检要靠这个区分"新建"与"更新",404 必须是 Ok(None) 而非报错
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/ai-skills/team-skills/contents/skills/新技能/SKILL.md"))
        .and(query_param("ref", "main"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "errors": ["object does not exist [id: , rel_path: skills/新技能/SKILL.md]"],
            "message": "GetContentsOrList",
            "url": "http://127.0.0.1:3300/api/swagger"
        })))
        .mount(&server)
        .await;

    let got = client(&server)
        .file_sha(&repo_ref(), "skills/新技能/SKILL.md")
        .await
        .unwrap();
    assert_eq!(got, None);
}

#[tokio::test]
async fn existing_file_returns_sha() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/ai-skills/team-skills/contents/skills/good-skill/SKILL.md"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "SKILL.md",
            "path": "skills/good-skill/SKILL.md",
            "sha": "1b859a18032efcf2e2d36ba9ffae4ef12ac1d135",
            "type": "file",
            "size": 305,
            "encoding": "base64",
            "content": "LS0t"
        })))
        .mount(&server)
        .await;

    let got = client(&server)
        .file_sha(&repo_ref(), "skills/good-skill/SKILL.md")
        .await
        .unwrap();
    assert_eq!(got.as_deref(), Some("1b859a18032efcf2e2d36ba9ffae4ef12ac1d135"));
}

#[tokio::test]
async fn stale_sha_maps_to_conflict_so_ui_can_recheck() {
    // 预检与提交之间有人改了同一个文件:Gitea 拒绝而不是静默覆盖,
    // 我们必须把它识别成 CONFLICT_STALE,让界面退回预检而不是盲目重试
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/ai-skills/team-skills/contents"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "sha does not match [given: 0000000000000000000000000000000000000000, expected: 1b859a18032efcf2e2d36ba9ffae4ef12ac1d135]",
            "url": "http://127.0.0.1:3300/api/swagger"
        })))
        .mount(&server)
        .await;

    let req = ChangeFilesRequest {
        branch: "main".into(),
        new_branch: None,
        message: "分享".into(),
        files: vec![FileChange::update("skills/a/SKILL.md", b"x", "0".repeat(40))],
    };
    let err = client(&server)
        .change_files("ai-skills", "team-skills", &req)
        .await
        .unwrap_err();
    assert_eq!(err.code, "CONFLICT_STALE");
    assert!(err.message.contains("其他人改过"), "{}", err.message);
}

#[tokio::test]
async fn other_unprocessable_errors_are_not_mistaken_for_conflict() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/ai-skills/team-skills/contents"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "repository file already exists [path: skills/a/SKILL.md]",
            "url": "http://127.0.0.1:3300/api/swagger"
        })))
        .mount(&server)
        .await;

    let req = ChangeFilesRequest {
        branch: "main".into(),
        new_branch: None,
        message: "分享".into(),
        files: vec![FileChange::create("skills/a/SKILL.md", b"x")],
    };
    let err = client(&server)
        .change_files("ai-skills", "team-skills", &req)
        .await
        .unwrap_err();
    assert_eq!(err.code, "REPO_REJECTED");
}

#[tokio::test]
async fn forbidden_push_maps_to_permission_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/ai-skills/team-skills/contents"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "message": "user should have a permission to write to the target branch",
            "url": "http://127.0.0.1:3300/api/swagger"
        })))
        .mount(&server)
        .await;

    let req = ChangeFilesRequest {
        branch: "main".into(),
        new_branch: None,
        message: "分享".into(),
        files: vec![FileChange::create("a.md", b"x")],
    };
    let err = client(&server)
        .change_files("ai-skills", "team-skills", &req)
        .await
        .unwrap_err();
    assert_eq!(err.code, "REPO_FORBIDDEN");
}

#[tokio::test]
async fn commit_returns_sha_and_url() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/ai-skills/team-skills/contents"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "commit": {
                "sha": "77ff66698556da7f065bdb663b745d2b8ee47d22",
                "html_url": "http://127.0.0.1:3300/ai-skills/team-skills/commit/77ff666985"
            },
            "files": [{"path": "skills/a/SKILL.md"}]
        })))
        .mount(&server)
        .await;

    let req = ChangeFilesRequest {
        branch: "main".into(),
        new_branch: None,
        message: "分享".into(),
        files: vec![FileChange::create("skills/a/SKILL.md", b"x")],
    };
    let commit = client(&server)
        .change_files("ai-skills", "team-skills", &req)
        .await
        .unwrap();
    assert_eq!(commit.sha, "77ff66698556da7f065bdb663b745d2b8ee47d22");
    assert!(commit.html_url.ends_with("/commit/77ff666985"));
}

#[tokio::test]
async fn responses_serialize_to_camel_case_for_the_frontend() {
    // 同一个结构体两头用:从 Gitea 反序列化 snake_case,向前端序列化 camelCase。
    // 配错方向不会报错,只会安静地丢字段,所以两个方向都要断。
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/ai-skills/team-skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main",
            "permissions": {"admin": true, "push": true, "pull": true},
            "empty": false
        })))
        .mount(&server)
        .await;

    let info = client(&server)
        .repo_info("ai-skills", "team-skills")
        .await
        .unwrap();
    assert_eq!(info.default_branch, "main");
    assert!(info.permissions.push);

    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(json["defaultBranch"], "main");
    assert!(json.get("default_branch").is_none());
}

#[tokio::test]
async fn branch_head_extracts_commit_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/ai-skills/team-skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": {
                "id": "6493e4cb9a35e61dfe43c6227e44dc128f158fcf",
                "timestamp": "2026-07-29T07:38:53Z"
            },
            "user_can_push": true
        })))
        .mount(&server)
        .await;

    let head = client(&server).branch_head(&repo_ref()).await.unwrap();
    assert_eq!(head.sha, "6493e4cb9a35e61dfe43c6227e44dc128f158fcf");
    assert_eq!(head.committed_at, "2026-07-29T07:38:53Z");
}

#[tokio::test]
async fn existing_fork_is_not_an_error() {
    // 同一个人第二次分享时 fork 已存在,这是常态而不是失败
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/ai-skills/team-skills/forks"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "message": "repository is already forked by user"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "login": "skillsync-reader", "full_name": "", "avatar_url": ""
        })))
        .mount(&server)
        .await;

    let fork = client(&server)
        .fork_repo("ai-skills", "team-skills")
        .await
        .unwrap();
    assert_eq!(fork.owner, "skillsync-reader");
    assert!(fork.already_existed);
}

#[tokio::test]
async fn server_error_tells_user_to_retry_later() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/user"))
        .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
        .mount(&server)
        .await;

    let err = client(&server).current_user().await.unwrap_err();
    assert_eq!(err.code, "NET_SERVER");
}

#[tokio::test]
async fn unreachable_host_produces_actionable_network_error() {
    // 连不上时的提示必须给出下一步动作(文案规范),而不是抛裸错误。
    //
    // 注意:客户端遵循系统代理设置。开发机上若设了 http_proxy,请求会先到代理,
    // 由代理返回 5xx —— 这时错误码是 NET_SERVER 而非 NET_UNREACHABLE,两者都是可接受的
    // 网络类错误。无代理环境(含 CI)下则应精确落在 NET_UNREACHABLE。
    let behind_proxy = ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]
        .iter()
        .any(|k| std::env::var(k).is_ok_and(|v| !v.is_empty()));

    let client = GiteaClient::new("http://127.0.0.1:1", Some("t".into())).unwrap();
    let err = client.current_user().await.unwrap_err();

    assert!(err.code.starts_with("NET_"), "应为网络类错误,实际 {}", err.code);
    assert!(!err.message.is_empty());
    if !behind_proxy {
        assert_eq!(err.code, "NET_UNREACHABLE");
        assert!(
            err.message.contains("内网") || err.message.contains("VPN"),
            "{}",
            err.message
        );
    }
}
