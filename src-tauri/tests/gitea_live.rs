//! 对着 docker fixture Gitea 跑通「拉列表 → 下载 → 提交」全链路(任务 4 DoD)。
//!
//! 需要先 `./fixtures/init.sh`。未起环境时(如 CI)自动跳过,不让 `cargo test` 变红——
//! 但 wiremock 测的是"我们如何处理响应",只有这里能验证"真实 Gitea 到底怎么响应",
//! 所以本地开发与发版前必须实际跑一次。

use std::collections::HashMap;

use skillsync_lib::core::gitea::{ChangeFilesRequest, FileChange, GiteaClient, RepoRef};
use skillsync_lib::core::skills::{discover_skills, DiscoverOptions};

/// 读 fixtures/.env.local。文件不存在返回 None,调用方据此跳过。
fn fixture_env() -> Option<HashMap<String, String>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("fixtures/.env.local");
    let text = std::fs::read_to_string(path).ok()?;
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    Some(map)
}

macro_rules! env_or_skip {
    () => {
        match fixture_env() {
            Some(e) => e,
            None => {
                eprintln!("跳过:未找到 fixtures/.env.local,先跑 ./fixtures/init.sh");
                return;
            }
        }
    };
}

fn admin_client(env: &HashMap<String, String>) -> GiteaClient {
    GiteaClient::new(
        env["SKILLSYNC_FIXTURE_GITEA_URL"].clone(),
        Some(env["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone()),
    )
    .unwrap()
}

fn repo_ref(env: &HashMap<String, String>) -> RepoRef {
    RepoRef {
        owner: env["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: env["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    }
}

#[tokio::test]
async fn full_flow_list_download_commit() {
    let env = env_or_skip!();
    let client = admin_client(&env);
    let r = repo_ref(&env);

    // ---- 登录态 ----
    let user = client.current_user().await.unwrap();
    assert_eq!(user.login, env["SKILLSYNC_FIXTURE_ADMIN_USER"]);

    // ---- 权限:决定分享走直推还是提交审核 ----
    let info = client.repo_info(&r.owner, &r.repo).await.unwrap();
    assert_eq!(info.default_branch, "main");
    assert!(info.permissions.push, "管理员应有写权限");

    // ---- 拉列表:先看分支头,变了才下载 ----
    let head = client.branch_head(&r).await.unwrap();
    assert_eq!(head.sha.len(), 40);

    // ---- 下载并解析 ----
    let archive = client.download_archive(&r).await.unwrap();
    // Gitea 压缩包顶层是仓库名,不是 GitHub 的 repo-branch
    assert_eq!(archive.root, r.repo);

    let discovery = discover_skills(&archive.tree, &archive.root, &DiscoverOptions::default());
    let mut found: Vec<&str> = discovery.skills.iter().map(|s| s.name.as_str()).collect();
    found.sort();
    assert_eq!(found, vec!["合同审查助手", "周报生成", "数据采集"]);

    // 缺 description 的那个被跳过,且给出了可读原因
    assert_eq!(discovery.skipped.len(), 1, "{:?}", discovery.skipped);
    assert!(discovery.skipped[0].path.contains("bad-frontmatter"));
    assert!(discovery.skipped[0].reason.contains("description"));

    // 含脚本的技能应被识别出来,供详情页显示警示角标
    let with_scripts = discovery
        .skills
        .iter()
        .find(|s| s.name == "数据采集")
        .unwrap();
    assert!(skillsync_lib::core::skills::has_executable_scripts(
        &with_scripts.dir,
        &archive.files
    ));

    // ---- 提交:新建 ----
    let probe_path = "skills/live-test/SKILL.md";
    let content = "---\nname: 联调探针\ndescription: 由集成测试写入,随后会被删掉。\n---\n".as_bytes();
    let commit = client
        .change_files(
            &r.owner,
            &r.repo,
            &ChangeFilesRequest {
                branch: r.branch.clone(),
                new_branch: None,
                message: "集成测试:新建".into(),
                files: vec![FileChange::create(probe_path, content)],
            },
        )
        .await
        .unwrap();
    assert_eq!(commit.sha.len(), 40);

    // ---- 取 sha:存在与不存在两种情况 ----
    let sha = client.file_sha(&r, probe_path).await.unwrap();
    assert!(sha.is_some(), "刚提交的文件应能取到 sha");
    assert_eq!(client.file_sha(&r, "skills/不存在/SKILL.md").await.unwrap(), None);

    // ---- 提交竞态:用过期 sha 更新必须被拒,而不是静默覆盖 ----
    let stale = client
        .change_files(
            &r.owner,
            &r.repo,
            &ChangeFilesRequest {
                branch: r.branch.clone(),
                new_branch: None,
                message: "集成测试:过期 sha".into(),
                files: vec![FileChange::update(probe_path, b"x", "0".repeat(40))],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(stale.code, "CONFLICT_STALE", "{stale:?}");

    // ---- 用正确 sha 更新 ----
    client
        .change_files(
            &r.owner,
            &r.repo,
            &ChangeFilesRequest {
                branch: r.branch.clone(),
                new_branch: None,
                message: "集成测试:更新".into(),
                files: vec![FileChange::update(
                    probe_path,
                    "---\nname: 联调探针\ndescription: 已更新。\n---\n".as_bytes(),
                    sha.unwrap(),
                )],
            },
        )
        .await
        .unwrap();

    // ---- 清理:留下的东西必须自己收拾干净 ----
    let sha = client.file_sha(&r, probe_path).await.unwrap().unwrap();
    let cleanup = client
        .change_files(
            &r.owner,
            &r.repo,
            &ChangeFilesRequest {
                branch: r.branch.clone(),
                new_branch: None,
                message: "集成测试:清理".into(),
                files: vec![skillsync_lib::core::gitea::FileChange {
                    operation: skillsync_lib::core::gitea::FileOperation::Delete,
                    path: probe_path.into(),
                    content: None,
                    sha: Some(sha),
                }],
            },
        )
        .await;
    assert!(cleanup.is_ok(), "清理失败会污染 fixture: {cleanup:?}");
    assert_eq!(client.file_sha(&r, probe_path).await.unwrap(), None);
}

#[tokio::test]
async fn readonly_user_cannot_push_and_must_fork() {
    let env = env_or_skip!();
    let r = repo_ref(&env);
    let reader = GiteaClient::new(
        env["SKILLSYNC_FIXTURE_GITEA_URL"].clone(),
        Some(env["SKILLSYNC_FIXTURE_READER_TOKEN"].clone()),
    )
    .unwrap();

    // 只读用户看到的权限
    let info = reader.repo_info(&r.owner, &r.repo).await.unwrap();
    assert!(!info.permissions.push && info.permissions.pull);

    // 直推被拒
    let direct = reader
        .change_files(
            &r.owner,
            &r.repo,
            &ChangeFilesRequest {
                branch: r.branch.clone(),
                new_branch: None,
                message: "只读用户直推".into(),
                files: vec![FileChange::create("skills/x/SKILL.md", b"x")],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(direct.code, "REPO_FORBIDDEN");

    // 决策 C3 说无写权限就走"开分支 + 提交审核",但实测只读用户连分支都开不了。
    // 这条断言把该事实钉住:任务 11 必须为只读用户走 fork,而不是照 C3 字面实现。
    let new_branch = reader
        .change_files(
            &r.owner,
            &r.repo,
            &ChangeFilesRequest {
                branch: r.branch.clone(),
                new_branch: Some("share/readonly-probe".into()),
                message: "只读用户开分支".into(),
                files: vec![FileChange::create("skills/x/SKILL.md", b"x")],
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        new_branch.code, "REPO_FORBIDDEN",
        "只读用户开分支若不再被拒,说明 Gitea 行为变了,任务 11 的分享路径需重新评估"
    );
}
