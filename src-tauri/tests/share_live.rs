//! 对 docker fixture Gitea 跑真实分享:三分支预检 + 提交 + 竞态,全部打真库。
//!
//! 需要先 `./fixtures/init.sh`,环境不在时自动跳过(与 acquire_live 同约定)。
//! wiremock 验的是"我们怎么处理响应",这里验的是真实 Gitea 的行为有没有变:
//! 422 的错误消息措辞、fork/跨库评审的真实可行性,都只有真跑才知道。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::{FileChange, ChangeFilesRequest, GiteaClient, RepoRef};
use skillsync_lib::core::share::{self, ShareMode, ShareOutcome, SharePrecheck};
use skillsync_lib::core::state::Store;

const NOW: &str = "2026-07-31T10:00:00.000Z";

/// 会**直推 main** 的用例必须拿这把锁:同一二进制内测试并行跑,并发直推同一
/// 分支会在 Gitea 端撞车(M5 任务 1 加冲突用例时真实撞过——three_branches 的
/// Fresh 直推被并发的另一笔顶掉)。fork/分支路径不碰 main,不需要。
static MAIN_BRANCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct TmpEnv {
    home: PathBuf,
}

impl AgentEnv for TmpEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, _: &str) -> Option<String> {
        None
    }
    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

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

fn write_skill(dir: &Path, name: &str, desc: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {desc}\n---\n正文\n"),
    )
    .unwrap();
}

/// 一次性跑完三分支与竞态:live 测试共享同一个 fixture 库,拆成多个 #[test]
/// 会互相踩(并行跑、共享远端状态),串成一个用例反而各阶段边界最清楚。
#[tokio::test]
async fn share_three_branches_and_race_against_a_real_gitea() {
    let _main = MAIN_BRANCH_LOCK.lock().await;
    let Some(vars) = fixture_env() else {
        eprintln!("跳过:未找到 fixtures/.env.local,先跑 ./fixtures/init.sh");
        return;
    };
    let need = [
        "SKILLSYNC_FIXTURE_GITEA_URL",
        "SKILLSYNC_FIXTURE_ORG",
        "SKILLSYNC_FIXTURE_REPO",
        "SKILLSYNC_FIXTURE_ADMIN_TOKEN",
    ];
    if let Some(missing) = need.iter().find(|k| !vars.contains_key(**k)) {
        eprintln!("跳过:fixtures/.env.local 缺 {missing}");
        return;
    }
    let repo = RepoRef {
        owner: vars["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: vars["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    };
    let admin = GiteaClient::new(
        vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone(),
        Some(vars["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone()),
    )
    .unwrap();
    if admin.branch_head(&repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let registry = AgentRegistry::builtin();

    // 幂等:每轮用独立目录名,避免上一轮跑剩的内容影响判定
    let stamp = format!("{:x}", std::process::id());
    let name = format!("share-live-{stamp}");
    let dir = home.join(".agents").join("skills").join(&name);
    write_skill(&dir, "分享实测", "live 测试用");

    // ① Fresh:远端没有 → 直推(admin 可写且 main 未保护)
    let state = store.load_state().unwrap().value;
    assert_eq!(
        share::precheck(&share::ShareClient::Gitea(&admin), &repo, &state, &name).await.unwrap(),
        SharePrecheck::Fresh
    );
    let outcome = share::share(
        &share::ShareClient::Gitea(&admin),
        &registry,
        &env,
        &store,
        share::ShareRequest {
            registry_id: "fixture",
            repo: &repo,
            source_path: &dir,
            share_name: &name,
            display_name: None,
            description: None,
            origin: "local",
            overwrite: false,
        },
        NOW,
    )
    .await
    .expect("Fresh 分享失败");
    let ShareOutcome::Shared { mode, .. } = outcome else {
        panic!("Fresh 不该要求拍板")
    };
    assert_eq!(mode, ShareMode::Pushed);

    // ② Mine:再推同名 → 认出是自己的,直接更新
    std::fs::write(dir.join("SKILL.md"), "---\nname: 分享实测\ndescription: 改了\n---\n新正文\n")
        .unwrap();
    let state = store.load_state().unwrap().value;
    assert_eq!(
        share::precheck(&share::ShareClient::Gitea(&admin), &repo, &state, &name).await.unwrap(),
        SharePrecheck::Mine
    );
    let outcome = share::share(
        &share::ShareClient::Gitea(&admin),
        &registry,
        &env,
        &store,
        share::ShareRequest {
            registry_id: "fixture",
            repo: &repo,
            source_path: &dir,
            share_name: &name,
            display_name: None,
            description: None,
            origin: "local",
            overwrite: false,
        },
        NOW,
    )
    .await
    .expect("Mine 更新失败");
    assert!(matches!(outcome, ShareOutcome::Shared { .. }));

    // ③ Taken:清掉本地 shared 记账 → 同名立即变成"别人的",不确认就必须停
    let mut wiped = store.load_state().unwrap().value;
    wiped.shared.clear();
    store.save_state(&wiped).unwrap();
    let state = store.load_state().unwrap().value;
    assert_eq!(
        share::precheck(&share::ShareClient::Gitea(&admin), &repo, &state, &name).await.unwrap(),
        SharePrecheck::Taken
    );
    let outcome = share::share(
        &share::ShareClient::Gitea(&admin),
        &registry,
        &env,
        &store,
        share::ShareRequest {
            registry_id: "fixture",
            repo: &repo,
            source_path: &dir,
            share_name: &name,
            display_name: None,
            description: None,
            origin: "local",
            overwrite: false,
        },
        NOW,
    )
    .await
    .expect("Taken 预检不该报错");
    assert!(matches!(
        outcome,
        ShareOutcome::NeedsDecision { precheck: SharePrecheck::Taken }
    ));

    // ④ 竞态:预检后别人抢先改了同一文件 → 提交必须撞出 CONFLICT_STALE
    //    (拿过期的 blob sha 去 update,真实 Gitea 的 422 措辞在这里被验证)
    let path = format!("skills/{name}/SKILL.md");
    let stale_sha = admin.file_sha(&repo, &path).await.unwrap().unwrap();
    let race = ChangeFilesRequest {
        branch: "main".into(),
        new_branch: None,
        message: "别人抢先的改动".into(),
        files: vec![FileChange::update(&path, "---\nname: x\ndescription: y\n---\n".as_bytes(), stale_sha.clone())],
    };
    admin.change_files(&repo.owner, &repo.repo, &race).await.unwrap();
    let conflict = ChangeFilesRequest {
        branch: "main".into(),
        new_branch: None,
        message: "拿着过期 sha 的提交".into(),
        files: vec![FileChange::update(&path, b"stale", stale_sha)],
    };
    let err = admin
        .change_files(&repo.owner, &repo.repo, &conflict)
        .await
        .unwrap_err();
    assert_eq!(err.code, "CONFLICT_STALE", "真实 Gitea 的竞态措辞变了: {:?}", err.detail);

    // 清理:删掉本轮推上去的技能目录,让 fixture 可反复跑
    let head = admin.branch_head(&repo).await.unwrap();
    let files: Vec<FileChange> = admin
        .tree_files(&repo.owner, &repo.repo, &head.sha)
        .await
        .unwrap()
        .into_iter()
        .filter(|f| f.path.starts_with(&format!("skills/{name}/")))
        .map(|f| FileChange {
            operation: skillsync_lib::core::gitea::FileOperation::Delete,
            path: f.path,
            content: None,
            sha: Some(f.sha),
        })
        .collect();
    if !files.is_empty() {
        let cleanup = ChangeFilesRequest {
            branch: "main".into(),
            new_branch: None,
            message: format!("清理 live 测试目录 {name}"),
            files,
        };
        let _ = admin.change_files(&repo.owner, &repo.repo, &cleanup).await;
    }
}

/// C3 的只读档全链路:fork → fork 上开分支提交 → 跨库提交审核。
/// 任务 4 只实测过"只读直推/开分支都是 403",fork 之后那半条链在真库上没走过。
#[tokio::test]
async fn read_only_users_can_contribute_via_fork_for_real() {
    let Some(vars) = fixture_env() else {
        eprintln!("跳过:未找到 fixtures/.env.local");
        return;
    };
    let need = [
        "SKILLSYNC_FIXTURE_GITEA_URL",
        "SKILLSYNC_FIXTURE_ORG",
        "SKILLSYNC_FIXTURE_REPO",
        "SKILLSYNC_FIXTURE_ADMIN_TOKEN",
        "SKILLSYNC_FIXTURE_READER_TOKEN",
    ];
    if let Some(missing) = need.iter().find(|k| !vars.contains_key(**k)) {
        eprintln!("跳过:fixtures/.env.local 缺 {missing}");
        return;
    }
    let repo = RepoRef {
        owner: vars["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: vars["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    };
    let reader = GiteaClient::new(
        vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone(),
        Some(vars["SKILLSYNC_FIXTURE_READER_TOKEN"].clone()),
    )
    .unwrap();
    if reader.branch_head(&repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let registry = AgentRegistry::builtin();

    // 分支名从 now 派生 → 用进程号扰动,让重复跑不会撞已存在的分支
    let now = format!("2026-07-31T10:00:{:02}.{:03}Z", std::process::id() % 60, std::process::id() % 1000);
    let name = format!("share-fork-{:x}", std::process::id());
    let dir = home.join(".agents").join("skills").join(&name);
    write_skill(&dir, "只读用户的技能", "fork 链路实测");

    let outcome = share::share(
        &share::ShareClient::Gitea(&reader),
        &registry,
        &env,
        &store,
        share::ShareRequest {
            registry_id: "fixture",
            repo: &repo,
            source_path: &dir,
            share_name: &name,
            display_name: None,
            description: None,
            origin: "local",
            overwrite: false,
        },
        &now,
    )
    .await
    .expect("只读用户的 fork 分享失败");

    let ShareOutcome::Shared { mode, review_url, .. } = outcome else {
        panic!("Fresh 不该要求拍板")
    };
    assert_eq!(mode, ShareMode::ReviewRequested, "只读用户只可能走评审");
    let url = review_url.expect("评审必须有链接");
    assert!(url.contains("/pulls/"), "评审链接不像话: {url}");

    // 清理:admin 关掉这个评审,fixture 可反复跑(fork 留着,fork_repo 对 409 幂等)
    let admin = GiteaClient::new(
        vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone(),
        Some(vars["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone()),
    )
    .unwrap();
    if let Some(number) = url.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()) {
        let _ = admin.close_pull(&repo.owner, &repo.repo, number).await;
    }
}

/// 真实双写方冲突(M5 任务 1):A(本 app)基于旧版改,B 先推了新版。
///
/// wiremock 矩阵验的是"我们怎么处理响应";这条验真实 Gitea 的三件事串起来通:
/// ① 压缩包指纹与本地基线的比对真的认出"远端变过";
/// ② history_url 的路由在真实 Gitea 上是活的(200);
/// ③ 确认后的第二跳真的落成"开分支 + 提交审核",一笔直推都没有。
#[tokio::test]
async fn remote_conflict_detection_against_a_real_gitea() {
    use skillsync_lib::core::fsops;
    use skillsync_lib::core::state::{InstalledSkill, SkillSource};

    let _main = MAIN_BRANCH_LOCK.lock().await;
    let Some(vars) = fixture_env() else {
        eprintln!("跳过:未找到 fixtures/.env.local,先跑 ./fixtures/init.sh");
        return;
    };
    let need = [
        "SKILLSYNC_FIXTURE_GITEA_URL",
        "SKILLSYNC_FIXTURE_ORG",
        "SKILLSYNC_FIXTURE_REPO",
        "SKILLSYNC_FIXTURE_ADMIN_TOKEN",
    ];
    if let Some(missing) = need.iter().find(|k| !vars.contains_key(**k)) {
        eprintln!("跳过:fixtures/.env.local 缺 {missing}");
        return;
    }
    let repo = RepoRef {
        owner: vars["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: vars["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    };
    let admin = GiteaClient::new(
        vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone(),
        Some(vars["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone()),
    )
    .unwrap();
    if admin.branch_head(&repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let registry = AgentRegistry::builtin();

    // 每轮独立目录名;分支名从 now 派生,同样用进程号扰动避免撞车
    let stamp = format!("{:x}", std::process::id());
    let name = format!("conflict-live-{stamp}");
    let remote_path = format!("skills/{name}");
    let now = format!(
        "2026-08-05T10:00:{:02}.{:03}Z",
        std::process::id() % 60,
        std::process::id() % 1000
    );

    // ① "获取时刻"的基线:远端 v1,本地同字节 v1,按本地 dir hash 记账
    //   (zip 指纹与 dir hash 的等式已有测试逐字节钉住,这里靠它)
    let v1 = "---\nname: 冲突实测\ndescription: v1\n---\n正文\n";
    admin
        .change_files(
            &repo.owner,
            &repo.repo,
            &ChangeFilesRequest {
                branch: "main".into(),
                new_branch: None,
                message: "新增技能:冲突实测".into(),
                files: vec![FileChange::create(format!("{remote_path}/SKILL.md"), v1.as_bytes())],
            },
        )
        .await
        .expect("灌入 v1 失败");
    let dir = home.join(".agents").join("skills").join(&name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), v1).unwrap();
    let mut state = store.load_state().unwrap().value;
    state.installed.push(InstalledSkill {
        name: name.clone(),
        source: SkillSource {
            registry_id: "fixture".into(),
            owner: repo.owner.clone(),
            repo: repo.repo.clone(),
            path: remote_path.clone(),
            git_ref: "base".into(),
        },
        commit_sha: "base".into(),
        content_hash: fsops::dir_content_hash(&dir).unwrap(),
        origin: None,
        agents: vec![],
        links: vec![],
        installed_at: now.clone(),
        updated_at: now.clone(),
    });
    store.save_state(&state).unwrap();

    // ② 我本地改成 v2
    std::fs::write(dir.join("SKILL.md"), "---\nname: 冲突实测\ndescription: 我的 v2\n---\n正文\n")
        .unwrap();

    // ③ B 抢先把远端推到 v3(更新要带 v1 的 blob sha)
    let head = admin.branch_head(&repo).await.unwrap();
    let sha = admin
        .tree_files(&repo.owner, &repo.repo, &head.sha)
        .await
        .unwrap()
        .into_iter()
        .find(|f| f.path == format!("{remote_path}/SKILL.md"))
        .expect("远端应有 v1")
        .sha;
    admin
        .change_files(
            &repo.owner,
            &repo.repo,
            &ChangeFilesRequest {
                branch: "main".into(),
                new_branch: None,
                message: "更新技能:冲突实测".into(),
                files: vec![FileChange::update(
                    format!("{remote_path}/SKILL.md"),
                    "---\nname: 冲突实测\ndescription: 别人的 v3\n---\n正文\n".as_bytes(),
                    sha,
                )],
            },
        )
        .await
        .expect("B 推 v3 失败");

    // ④ 回推:必须认出远端变过,一个字节都不许写
    let outcome = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        false,
        &now,
    )
    .await
    .expect("冲突检测不该报错");
    let share::ShareInstalledOutcome::RemoteChanged { history_url } = outcome else {
        panic!("远端已是 v3,应进冲突档");
    };
    let url = history_url.expect("Gitea 源应给出历史链接");
    let resp = reqwest::get(&url).await.expect("历史页请求失败");
    assert_eq!(resp.status().as_u16(), 200, "历史页路由变了: {url}");

    // ⑤ 确认后的第二跳:开分支 + 提交审核,绝不直推
    let outcome = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        true,
        &now,
    )
    .await
    .expect("确认后的提交失败");
    let share::ShareInstalledOutcome::Submitted(submitted) = outcome else {
        panic!("确认后应当提交");
    };
    assert_eq!(submitted.mode, ShareMode::ReviewRequested, "admin 可直推也必须走评审");
    let review = submitted.review_url.expect("评审必须有链接");

    // 远端 main 上仍是 B 的 v3——直推没有发生
    let head = admin.branch_head(&repo).await.unwrap();
    let files = admin.tree_files(&repo.owner, &repo.repo, &head.sha).await.unwrap();
    assert!(files.iter().any(|f| f.path == format!("{remote_path}/SKILL.md")));

    // 清理:关评审 + 把灌进 main 的技能删掉。留着会污染别的 live 断言
    // (gitea_live 对技能清单的断言真被上一轮残留打红过)。
    if let Some(number) = review.rsplit('/').next().and_then(|n| n.parse::<u64>().ok()) {
        let _ = admin.close_pull(&repo.owner, &repo.repo, number).await;
    }
    let probe = format!("{remote_path}/SKILL.md");
    if let Ok(Some(sha)) = admin.file_sha(&repo, &probe).await {
        admin
            .change_files(
                &repo.owner,
                &repo.repo,
                &ChangeFilesRequest {
                    branch: "main".into(),
                    new_branch: None,
                    message: "清理:冲突实测".into(),
                    files: vec![skillsync_lib::core::gitea::FileChange {
                        operation: skillsync_lib::core::gitea::FileOperation::Delete,
                        path: probe,
                        content: None,
                        sha: Some(sha),
                    }],
                },
            )
            .await
            .expect("清理失败——手动删掉 skills/conflict-live-* 后再跑");
    }
}
