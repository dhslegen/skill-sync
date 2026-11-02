//! 作者把自己的技能从技能库里删掉(0.8.0 任务 5)。wiremock 上的完整编排。
//!
//! 钉住的事:预览轮零写请求;作者闸(未登记作者也拒);确认轮绑快照(对不上不删);
//! 一笔提交里删技能文件 + 清三份元数据;元数据形状不对时只跳过那一份;本机那份默认不动,
//! 要求时走移除、失败如实回报;403 一句人话。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::ownership::Identity;
use skillsync_lib::core::share::ShareClient;
use skillsync_lib::core::state::{Config, InstalledSkill, SkillSource, Store};
use skillsync_lib::core::unpublish::{unpublish, LocalResult, UnpublishOutcome, UnpublishRequest};
use wiremock::matchers::{method, path, path_regex};
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
    store: Store,
    registry: AgentRegistry,
    trash: fsops::SandboxTrash,
}

fn ctx(me: &str) -> Ctx {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let store = Store::new(home.join(".skillsync"));
    let mut config = Config::default();
    config.identities.insert("company".into(), Identity { login: me.into(), display_name: me.into() });
    store.save_config(&config).unwrap();
    Ctx {
        env: TmpEnv { home: home.clone(), vars: HashMap::new() },
        trash: fsops::SandboxTrash::new(home.join(".test-trash")),
        registry: AgentRegistry::builtin(),
        store,
        home,
        _tmp: tmp,
    }
}

fn repo_ref() -> RepoRef {
    RepoRef { owner: "skills".into(), repo: "skills".into(), branch: "main".into() }
}

const MD: &str = "---\nname: weekly-report\ndescription: 周报\n---\n正文\n";

fn library_zip(author: Option<&str>, extra: &[(&str, &str)]) -> Vec<u8> {
    use std::io::Write as _;
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        let mut put = |p: &str, b: &str| {
            w.start_file(format!("repo/{p}"), opts).unwrap();
            w.write_all(b.as_bytes()).unwrap();
        };
        put("skills/weekly-report/SKILL.md", MD);
        put("skills/weekly-report/ref.md", "参考\n");
        put("skills/other/SKILL.md", "别人的技能\n");
        if let Some(a) = author {
            put("authors.json", &format!(r#"{{"authors":{{"weekly-report":{{"author":"{a}"}},"other":{{"author":"王五"}}}}}}"#));
        }
        for (p, b) in extra {
            put(p, b);
        }
        w.finish().unwrap();
    }
    buf
}

async fn mount_meta(server: &MockServer, file: &str, text: Option<&str>) {
    let m = Mock::given(method("GET")).and(path(format!("/api/v1/repos/skills/skills/contents/{file}")));
    match text {
        Some(t) => {
            m.respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sha": format!("{file}-sha"), "encoding": "base64",
                "content": base64::engine::general_purpose::STANDARD.encode(t)
            })))
            .mount(server)
            .await
        }
        None => m.respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({"message": "x"}))).mount(server).await,
    }
}

/// 读链路 + 写链路的全套 mock。`push` 控制写权限,`commit_status` 控制提交结果。
async fn mount_all(server: &MockServer, author: Option<&str>, push: bool, commit_status: u16) {
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/archive/main.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(library_zip(author, &[])))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "default_branch": "main", "permissions": { "admin": false, "push": push, "pull": true }, "empty": false
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": "head1", "timestamp": "2026-11-03T08:00:00Z" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/git/trees/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "tree": [
                { "path": "skills/weekly-report/SKILL.md", "sha": "s1", "type": "blob" },
                { "path": "skills/weekly-report/ref.md", "sha": "s2", "type": "blob" },
                { "path": "skills/weekly-report-old/SKILL.md", "sha": "s3", "type": "blob" },
                { "path": "skills/other/SKILL.md", "sha": "s4", "type": "blob" }
            ],
            "truncated": false
        })))
        .mount(server)
        .await;
    mount_meta(
        server,
        "authors.json",
        Some(r#"{"authors":{"weekly-report":{"author":"张三"},"other":{"author":"王五"}}}"#),
    )
    .await;
    mount_meta(server, "tags.json", Some(r#"{"tags":{"weekly-report":["文档"],"other":["代码"]}}"#)).await;
    mount_meta(server, "curated.json", Some(r#"{"curated":["周报生成","别的"]}"#)).await;
    let resp = if commit_status < 300 {
        ResponseTemplate::new(commit_status).set_body_json(serde_json::json!({ "commit": { "sha": "delsha", "html_url": "" } }))
    } else {
        ResponseTemplate::new(commit_status).set_body_json(serde_json::json!({ "message": "forbidden" }))
    };
    Mock::given(method("POST")).and(path("/api/v1/repos/skills/skills/contents")).respond_with(resp).mount(server).await;
}

async fn run(
    c: &Ctx,
    server: &MockServer,
    confirm: Option<&str>,
    also_trash_local: bool,
) -> Result<UnpublishOutcome, skillsync_lib::error::AppError> {
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let installer = Installer::new(&c.registry, &c.env).with_trasher(&c.trash);
    unpublish(
        &ShareClient::Gitea(&client),
        &client,
        &installer,
        &c.env,
        &c.store,
        UnpublishRequest {
            registry_id: "company",
            repo: &repo_ref(),
            dir_slug: "weekly-report",
            skill_path: "skills/weekly-report",
            display_name: "周报生成",
            confirm,
            also_trash_local,
        },
    )
    .await
}

async fn posts(server: &MockServer) -> Vec<serde_json::Value> {
    server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.method.as_str() == "POST")
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect()
}

fn decoded(file: &serde_json::Value) -> serde_json::Value {
    let b = base64::engine::general_purpose::STANDARD.decode(file["content"].as_str().unwrap()).unwrap();
    serde_json::from_slice(&b).unwrap()
}

async fn preview_rev(c: &Ctx, server: &MockServer) -> String {
    match run(c, server, None, false).await.unwrap() {
        UnpublishOutcome::NeedsConfirm { remote_rev, .. } => remote_rev,
        other => panic!("预览轮应当要确认:{other:?}"),
    }
}

#[tokio::test]
async fn preview_lists_the_files_and_sends_no_write() {
    let c = ctx("张三");
    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 201).await;

    let UnpublishOutcome::NeedsConfirm { files, stale, history_url, .. } = run(&c, &server, None, false).await.unwrap() else {
        panic!("预览轮应当要确认");
    };
    assert_eq!(files, ["SKILL.md", "ref.md"], "别的技能(含前缀相同的 weekly-report-old)不在清单里");
    assert!(!stale);
    assert!(history_url.contains("skills/weekly-report"));
    assert!(posts(&server).await.is_empty(), "预览轮一个写请求都不发");
}

#[tokio::test]
async fn confirmed_unpublish_deletes_the_files_and_cleans_metadata_in_one_commit() {
    let c = ctx("张三");
    let local = c.home.join(".claude").join("skills").join("weekly-report");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("SKILL.md"), MD).unwrap();
    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 201).await;

    let rev = preview_rev(&c, &server).await;
    let out = run(&c, &server, Some(&rev), false).await.unwrap();
    let UnpublishOutcome::Unpublished { commit_sha, local: result } = out else { panic!("应当删成") };
    assert_eq!(commit_sha, "delsha");
    assert!(matches!(result, LocalResult::Untouched));
    assert!(local.join("SKILL.md").is_file(), "没勾「同时移到废纸篓」时本机一个字节都不动");

    let bodies = posts(&server).await;
    assert_eq!(bodies.len(), 1, "一笔提交");
    let files = bodies[0]["files"].as_array().unwrap();
    let deletes: Vec<(&str, &str)> = files
        .iter()
        .filter(|f| f["operation"] == "delete")
        .map(|f| (f["path"].as_str().unwrap(), f["sha"].as_str().unwrap()))
        .collect();
    assert_eq!(deletes, [("skills/weekly-report/SKILL.md", "s1"), ("skills/weekly-report/ref.md", "s2")]);
    let by = |name: &str| files.iter().find(|f| f["path"] == name).unwrap_or_else(|| panic!("缺 {name}"));
    let authors = decoded(by("authors.json"));
    assert!(authors["authors"].get("weekly-report").is_none());
    assert_eq!(authors["authors"]["other"]["author"], "王五", "别人的条目不动");
    assert_eq!(by("authors.json")["sha"], "authors.json-sha");
    assert!(decoded(by("tags.json"))["tags"].get("weekly-report").is_none());
    assert_eq!(decoded(by("curated.json"))["curated"], serde_json::json!(["别的"]));
}

#[tokio::test]
async fn a_stale_confirmation_deletes_nothing_and_shows_the_new_list() {
    let c = ctx("张三");
    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 201).await;

    let out = run(&c, &server, Some("别人推之前那一版的指纹"), false).await.unwrap();
    assert!(matches!(out, UnpublishOutcome::NeedsConfirm { stale: true, .. }));
    assert!(posts(&server).await.is_empty());
}

#[tokio::test]
async fn someone_else_cannot_delete_it() {
    let c = ctx("李四");
    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 201).await;

    let err = run(&c, &server, None, false).await.unwrap_err();
    assert_eq!(err.code, "REPO_NOT_AUTHOR");
    assert!(err.message.contains("张三"));
    assert!(posts(&server).await.is_empty());
}

#[tokio::test]
async fn a_skill_without_a_registered_author_cannot_be_deleted_here() {
    let c = ctx("张三");
    let server = MockServer::start().await;
    mount_all(&server, None, true, 201).await;

    let err = run(&c, &server, None, false).await.unwrap_err();
    assert_eq!(err.code, "REPO_NOT_AUTHOR");
    assert!(err.message.contains("没有登记作者"), "{err:?}");
}

#[tokio::test]
async fn no_write_access_and_protected_branch_each_get_their_own_sentence() {
    let c = ctx("张三");
    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), false, 201).await;
    let rev = preview_rev(&c, &server).await;
    let err = run(&c, &server, Some(&rev), false).await.unwrap_err();
    assert_eq!(err.code, "REPO_NO_WRITE_ACCESS");
    assert!(err.message.contains("删不了"));

    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 403).await;
    let rev = preview_rev(&c, &server).await;
    let err = run(&c, &server, Some(&rev), false).await.unwrap_err();
    assert_eq!(err.code, "REPO_PUSH_BLOCKED");
}

#[tokio::test]
async fn trashing_the_local_copy_reuses_remove_and_reports_its_failure_without_undoing_the_library() {
    // 没有记账的本地技能:remove 会拒,这一档必须如实回报,而库里那一笔照样算数
    let c = ctx("张三");
    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 201).await;
    let rev = preview_rev(&c, &server).await;
    let UnpublishOutcome::Unpublished { local, .. } = run(&c, &server, Some(&rev), true).await.unwrap() else {
        panic!("库里应当删成");
    };
    assert!(matches!(local, LocalResult::Failed { .. }), "{local:?}");
    assert_eq!(posts(&server).await.len(), 1);
}

#[tokio::test]
async fn trashing_the_local_copy_moves_it_to_the_trash_and_clears_the_books() {
    let c = ctx("张三");
    let installer = Installer::new(&c.registry, &c.env).with_trasher(&c.trash);
    let home = installer.home("weekly-report", None).unwrap();
    installer
        .install(&home, &skillsync_lib::core::installer::SkillPayload::new().with_file("SKILL.md", MD), &[])
        .unwrap();
    let canonical = c.home.join(".agents").join("skills").join("weekly-report");
    let mut state = c.store.load_state().map(|l| l.value).unwrap_or_default();
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "company".into(), owner: "skills".into(), repo: "skills".into(),
            path: "skills/weekly-report".into(), git_ref: "aaa".into(),
        },
        commit_sha: "aaa".into(),
        content_hash: fsops::dir_content_hash(&canonical).unwrap(),
        origin: None, body: None, agents: vec![], links: vec![],
        installed_at: "2026-11-03T00:00:00Z".into(), updated_at: "2026-11-03T00:00:00Z".into(),
    });
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 201).await;
    let rev = preview_rev(&c, &server).await;
    let UnpublishOutcome::Unpublished { local, .. } = run(&c, &server, Some(&rev), true).await.unwrap() else {
        panic!("库里应当删成");
    };
    assert!(matches!(local, LocalResult::Trashed), "{local:?}");
    assert!(!canonical.exists(), "本机那份进了废纸篓");
    assert!(c.store.load_state().unwrap().value.installed.is_empty(), "记账一并清掉");
}

#[tokio::test]
async fn a_library_failure_leaves_the_local_copy_alone() {
    let c = ctx("张三");
    let local = c.home.join(".agents").join("skills").join("weekly-report");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("SKILL.md"), MD).unwrap();
    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 403).await;
    let rev = preview_rev(&c, &server).await;
    assert!(run(&c, &server, Some(&rev), true).await.is_err());
    assert!(local.join("SKILL.md").is_file(), "先删库、后删本地:库删失败就不动本地");
}

#[tokio::test]
async fn a_commit_rejected_because_of_metadata_is_retried_without_it() {
    let c = ctx("张三");
    let server = MockServer::start().await;
    // 第一次提交被拒(元数据 blob sha 过期这一类,409),第二次成功——先挂的 mock 优先匹配
    Mock::given(method("POST"))
        .and(path("/api/v1/repos/skills/skills/contents"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({ "message": "sha mismatch" })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    mount_all(&server, Some("张三"), true, 201).await;

    let rev = preview_rev(&c, &server).await;
    let out = run(&c, &server, Some(&rev), false).await.unwrap();
    assert!(matches!(out, UnpublishOutcome::Unpublished { .. }));
    let bodies = posts(&server).await;
    assert_eq!(bodies.len(), 2);
    let retried: Vec<&str> = bodies[1]["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(retried, ["skills/weekly-report/SKILL.md", "skills/weekly-report/ref.md"], "重试只剩技能文件");
}

#[tokio::test]
async fn keeping_the_local_copy_detaches_its_record_from_the_library() {
    // 作者删库保留本机:记账来源清空,那一行才能落进「可分享到」重新分享
    let c = ctx("张三");
    let mut state = c.store.load_state().map(|l| l.value).unwrap_or_default();
    state.installed.push(InstalledSkill {
        name: "weekly-report".into(),
        source: SkillSource {
            registry_id: "company".into(), owner: "skills".into(), repo: "skills".into(),
            path: "skills/weekly-report".into(), git_ref: "aaa".into(),
        },
        commit_sha: "aaa".into(), content_hash: "h".into(),
        origin: None, body: None, agents: vec!["claude-code".into()], links: vec![],
        installed_at: "2026-11-03T00:00:00Z".into(), updated_at: "2026-11-03T00:00:00Z".into(),
    });
    state.installed.push(InstalledSkill {
        name: "meeting-notes".into(),
        source: SkillSource {
            registry_id: "company".into(), owner: "skills".into(), repo: "skills".into(),
            path: "skills/meeting-notes".into(), git_ref: "aaa".into(),
        },
        commit_sha: "aaa".into(), content_hash: "h".into(),
        origin: None, body: None, agents: vec![], links: vec![],
        installed_at: "2026-11-03T00:00:00Z".into(), updated_at: "2026-11-03T00:00:00Z".into(),
    });
    c.store.save_state(&state).unwrap();

    let server = MockServer::start().await;
    mount_all(&server, Some("张三"), true, 201).await;
    let rev = preview_rev(&c, &server).await;
    run(&c, &server, Some(&rev), false).await.unwrap();

    let after = c.store.load_state().unwrap().value;
    let mine = after.installed.iter().find(|s| s.name == "weekly-report").unwrap();
    assert!(!mine.has_source(), "这一行的来源应当清空");
    assert_eq!(mine.agents, ["claude-code"], "别的记账(工具关联)一个字不动");
    let other = after.installed.iter().find(|s| s.name == "meeting-notes").unwrap();
    assert!(other.has_source(), "别的技能的记账不能被连带清掉");
}
