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

/// 一次性跑完 `precheck` 的三档(Fresh / Mine / Taken)与提交竞态:live 测试
/// 共享同一个 fixture 库,拆成多个 #[test] 会互相踩(并行跑、共享远端状态),
/// 串成一个用例反而各阶段边界最清楚。
///
/// ⚠️ 这里原先叫「三分支」,而 v8 任务 3(D1)之后**分享只剩直推一条路**,
/// 那个名字会让人以为它在验三条提交路径。它验的一直是 `SharePrecheck` 的三档。
#[tokio::test]
async fn share_precheck_three_cases_and_race_against_a_real_gitea() {
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
    // 显式注入沙盒废纸篓:`share()` 内部的 `ensure_canonical_link` 有删除路径,
    // 默认实现是这台机器真实的系统废纸篓。
    let trash = skillsync_lib::core::fsops::SandboxTrash::new(home.join("..").join("share-live-trash"));

    // 幂等:每轮用独立目录名,避免上一轮跑剩的内容影响判定
    let stamp = format!("{:x}", std::process::id());
    let name = format!("share-live-{stamp}");
    let dir = home.join(".agents").join("skills").join(&name);
    write_skill(&dir, &name, "live 测试用");

    // ① Fresh:远端没有 → 直推(admin 可写且 main 未保护)
    let state = store.load_state().unwrap().value;
    assert_eq!(
        share::precheck(&share::ShareClient::Gitea(&admin), &repo, &state, &name, None, None)
            .await
            .unwrap(),
        SharePrecheck::Fresh
    );
    let outcome = confirmed_share(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &trash,
        "fixture",
        &repo,
        &name,
        NOW,
    )
    .await
    .expect("Fresh 分享失败");
    let ShareOutcome::Shared { mode, .. } = outcome else { panic!("应当分享成功,不该落进覆盖确认档") };
    assert_eq!(mode, ShareMode::Pushed);

    // ② Mine:再推同名 → 认出是自己的,直接更新
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: 改了\n---\n新正文\n"),
    )
    .unwrap();
    let state = store.load_state().unwrap().value;
    assert_eq!(
        share::precheck(&share::ShareClient::Gitea(&admin), &repo, &state, &name, None, None)
            .await
            .unwrap(),
        SharePrecheck::Mine
    );
    let outcome = confirmed_share(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &trash,
        "fixture",
        &repo,
        &name,
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
        share::precheck(&share::ShareClient::Gitea(&admin), &repo, &state, &name, None, None)
            .await
            .unwrap(),
        SharePrecheck::Taken
    );
    // 「覆盖别人的技能」这条路已整体取消(v6 二期 A-3),所以 Taken 现在是一个
    // 如实的错误,不是"等用户三选一"的拍板档。
    let err = confirmed_share(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &trash,
        "fixture",
        &repo,
        &name,
        NOW,
    )
    .await
    .expect_err("库里同名且不是我分享的,应当报错");
    assert_eq!(err.code, "REPO_NAME_TAKEN");

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

// ⚠️ **v8 任务 3 删掉了 `read_only_users_can_contribute_via_fork_for_real`**:
// 它验的是「只读用户 → 复制一份到自己名下 → 跨库提交审核」这条链路,而那条链路
// 已整体下线(D1)。只读用户现在的行为(一句人话 + 零写请求)由
// `tests/share_flow.rs::a_read_only_user_is_told_why_instead_of_getting_a_personal_copy`
// 与 `tests/share_attribution.rs` 的同名用例在 wiremock 上钉住——那是纯判定,
// 不需要真 Gitea。

/// 真实双写方冲突(M5 任务 1):A(本 app)基于旧版改,B 先推了新版。
///
/// wiremock 矩阵验的是"我们怎么处理响应";这条验真实 Gitea 的三件事串起来通:
/// ① 压缩包指纹与本地基线的比对真的认出"远端变过";
/// ② history_url 的路由在真实 Gitea 上是活的(200);
/// ③ 被拦下时**远端 main 一个字节都没动**。
///
/// ⚠️ **v8 任务 3:第二跳(确认后强制走提交审核)已删除**——那条路整体下线,
/// 而"仍然覆盖"是 v8 任务 4 的事。这条 live 现在到"认出冲突 + 零写入"为止。
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
    // 🔴 frontmatter `name` 必须**等于文件夹名**(这里是 `conflict-live-<pid>`)。
    // 终审 C-3 起 `share_installed` 也过 A-2 的标准校验闸,而这份 fixture 原先写的是
    // `name: 冲突实测`——中文、且与文件夹名不同,两条都犯,回推会被闸拦下。
    // **这不是为了迁就守卫改测试数据**:回推一个 `name ≠ 文件夹名` 的技能今天
    // 本来就不该成功,fixture 那样写只是因为当初那条闸不存在。
    let v1 = format!("---\nname: {name}\ndescription: v1\n---\n正文\n");
    let v1 = v1.as_str();
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
        body: None,
        agents: vec![],
        links: vec![],
        installed_at: now.clone(),
        updated_at: now.clone(),
    });
    store.save_state(&state).unwrap();

    // ② 我本地改成 v2
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: 我的 v2\n---\n正文\n"),
    )
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
                    format!("---\nname: {name}\ndescription: 别人的 v3\n---\n正文\n").as_bytes(),
                    sha,
                )],
            },
        )
        .await
        .expect("B 推 v3 失败");

    // ③' 🔴 v8 任务 4 的核心修复:**没有基线也要弹**。换过电脑、或早年经别的
    //     途径分享过的作者,本机根本没有记账——旧行为是跳过检测直接覆盖。
    //     这里把基线抹成空串再跑一次,判据退化成"本地实时 vs 库里实时"。
    let mut blanked = store.load_state().unwrap().value;
    let idx = blanked.installed.iter().position(|s| s.name == name).unwrap();
    let baseline = std::mem::take(&mut blanked.installed[idx].content_hash);
    store.save_state(&blanked).unwrap();
    let outcome = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        None,
        &now,
    )
    .await
    .expect("空基线不该报错");
    assert!(
        matches!(outcome, share::ShareInstalledOutcome::NeedsConfirm { overwrite: Some(_), .. }),
        "没有基线时本地 v2 与库里 v3 不同,照样要弹覆盖确认:{outcome:?}",
    );
    // 把基线放回去,下面几步测的是"有基线"那一档
    let mut restored = store.load_state().unwrap().value;
    restored.installed[idx].content_hash = baseline;
    store.save_state(&restored).unwrap();

    // ④ 回推:必须认出远端变过,一个字节都不许写
    let outcome = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        None,
        &now,
    )
    .await
    .expect("冲突检测不该报错");
    let share::ShareInstalledOutcome::NeedsConfirm { overwrite: Some(warning), remote_rev: seen_rev, .. } = outcome else {
        panic!("远端已是 v3,应进冲突档");
    };
    let url = warning.history_url.expect("Gitea 源应给出历史链接");
    let resp = reqwest::get(&url).await.expect("历史页请求失败");
    assert_eq!(resp.status().as_u16(), 200, "历史页路由变了: {url}");

    // ⑤ 远端 main 上仍是 B 的 v3——一个字节都没写
    let head = admin.branch_head(&repo).await.unwrap();
    let files = admin.tree_files(&repo.owner, &repo.repo, &head.sha).await.unwrap();
    assert!(files.iter().any(|f| f.path == format!("{remote_path}/SKILL.md")));

    // ⑥ v8 任务 4:拍板信息要点名"最后由谁、什么时候改的"。这是真 Gitea 的
    //    `commits?path=…&limit=1`,wiremock 上录不出"路径不存在返回 404"这类真实形状。
    assert!(
        warning.last_author.is_some(),
        "真 Gitea 应当答得出这个技能目录最后由谁改的",
    );
    assert!(warning.last_at.is_some(), "以及什么时候");

    // ⑦ 用户按了「仍然覆盖」:带 overwrite 重来一跳 → 直推成功 → **基线对齐**。
    //    不对齐正是同事那个死循环的成因(推上去了,界面还说"库里有新版")。
    let local_hash = fsops::dir_content_hash(&dir).unwrap();
    let outcome = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        // 终审 C-1:确认那一跳要带上一轮回来的凭据(界面就是这么做的)
        Some(seen_rev.as_str()),
        &now,
    )
    .await
    .expect("拍过板的覆盖应当推得上去");
    let share::ShareInstalledOutcome::Submitted(_) = outcome else {
        panic!("带 overwrite 就不该再被拦下:{outcome:?}");
    };
    let after = store.load_state().unwrap().value;
    let record = after
        .installed
        .iter()
        .find(|s| s.name == name)
        .expect("记账应当还在");
    assert_eq!(record.content_hash, local_hash, "覆盖成功后基线必须对齐");
    // 远端真的成了我的 v2
    let head = admin.branch_head(&repo).await.unwrap();
    let blob = admin
        .tree_files(&repo.owner, &repo.repo, &head.sha)
        .await
        .unwrap()
        .into_iter()
        .find(|f| f.path == format!("{remote_path}/SKILL.md"))
        .expect("远端应有这个技能");
    assert!(!blob.sha.is_empty());

    // 清理:把灌进 main 的技能删掉。留着会污染别的 live 断言
    // (gitea_live 对技能清单的断言真被上一轮残留打红过)。
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

/// 🔴 **作者闭环的真 Gitea 版**(v6 二期任务 9,wiremock 版在 `tests/e2e_author_loop.rs`)。
///
/// wiremock 那条验的是"我们怎么编排",这条验的是**真实 Gitea 的压缩包与提交**
/// 走完同一圈之后,本体还在不在原地:
/// 在 `~/.claude/skills/<slug>` 里开发 → 分享(直推 main)→ 同事把库里那份改了 →
/// **取回** → 内容变成库里的新版,而文件夹**还是那一个**。
///
/// 与 wiremock 版刻意不重合的地方:
/// - 压缩包是 Gitea 自己打的(顶层目录、权限位、路径前缀全是真的);
/// - `authors.json` 是 `share()` 上一步真写进去的,不是 fixture 摆好的;
/// - 分享与取回打的是**同一个真实分支**,`commit_sha` 的对齐没有 mock 兜着。
///
/// 直推 main,所以要拿 [`MAIN_BRANCH_LOCK`],并在收尾把技能目录删干净
/// (残留会打红 `gitea_live` 的技能清单断言——真发生过)。
#[tokio::test]
async fn author_loop_in_a_tool_dir_against_a_real_gitea() {
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
    let base_url = vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone();
    let repo = RepoRef {
        owner: vars["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: vars["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    };
    let admin = GiteaClient::new(base_url.clone(), Some(vars["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone())).unwrap();
    if admin.branch_head(&repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let registry = AgentRegistry::builtin();
    let trash = skillsync_lib::core::fsops::SandboxTrash::new(home.join("..").join("share-live-loop-trash"));

    // 与上面那条 live 用例同进程,名字必须错开(两条都直推同一个库)
    let name = format!("author-loop-{:x}", std::process::id());
    // 🔴 本体**不在** canonical,住在 Claude Code 的技能目录里 —— 这就是本期的场景
    let body = home.join(".claude").join("skills").join(&name);
    write_skill(&body, &name, "第一版正文");

    // 登录身份:取回那一步的「这是不是我分享的」判据要拿它跟库里的 authors.json 比
    let user = admin.current_user().await.unwrap();
    let mut config = store.load_config().unwrap().value;
    config.identities.insert(
        "fixture".into(),
        skillsync_lib::core::ownership::Identity {
            login: user.login.clone(),
            display_name: if user.full_name.trim().is_empty() { user.login.clone() } else { user.full_name.clone() },
        },
    );
    store.save_config(&config).unwrap();

    // ① 分享:直推 main。本体留在原地,canonical 只多一条指向它的链接。
    let outcome = confirmed_share(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &trash,
        "fixture",
        &repo,
        &name,
        NOW,
    )
    .await
    .expect("分享失败");
    let ShareOutcome::Shared { mode, .. } = outcome else { panic!("应当分享成功,不该落进覆盖确认档") };
    assert_eq!(mode, ShareMode::Pushed);
    let canonical = home.join(".agents").join("skills").join(&name);
    assert_eq!(
        skillsync_lib::core::fsops::read_link_target(&canonical),
        Some(skillsync_lib::core::fsops::normalize(&body)),
        "canonical 该是一条指向本体的链接"
    );

    // ② 同事经审核把库里那份改成了第二版
    let remote_md = format!("skills/{name}/SKILL.md");
    let sha = admin.file_sha(&repo, &remote_md).await.unwrap().expect("刚推上去的文件应当在");
    admin
        .change_files(
            &repo.owner,
            &repo.repo,
            &ChangeFilesRequest {
                branch: "main".into(),
                new_branch: None,
                message: format!("同事改了 {name}"),
                files: vec![FileChange::update(
                    &remote_md,
                    format!("---\nname: {name}\ndescription: live 测试用\n---\n第二版正文\n").as_bytes(),
                    sha,
                )],
            },
        )
        .await
        .expect("改库失败");

    // ③ 取回
    let stages = std::sync::Mutex::new(Vec::new());
    let sink = |s: skillsync_lib::core::acquire::Stage| stages.lock().unwrap().push(s);
    let out = skillsync_lib::core::acquire::acquire(
        &admin,
        &registry,
        &env,
        &store,
        skillsync_lib::core::acquire::AcquireRequest {
            source: skillsync_lib::core::acquire::SourceMeta {
                registry_id: "fixture",
                kind: "gitea",
                base_url: &base_url,
            },
            repo: &repo,
            dir_slug: &name,
            agent_names: &[],
            resolution: None,
        },
        NOW,
        0,
        &trash,
        &sink,
    )
    .await
    .expect("取回失败");
    assert!(
        matches!(out, skillsync_lib::core::acquire::AcquireOutcome::Installed { .. }),
        "作者本地没改动,取回就该直接装下来:{out:?}"
    );

    // ④ 🔴 同一份文件、内容是库里那版、本体没有搬家
    assert!(
        std::fs::read_to_string(body.join("SKILL.md")).unwrap().contains("第二版正文"),
        "取回之后 ~/.claude/skills 里那份就该是库里的新版"
    );
    assert_eq!(
        skillsync_lib::core::fsops::read_link_target(&canonical),
        Some(skillsync_lib::core::fsops::normalize(&body)),
        "本体没有被搬进 canonical"
    );
    let state = store.load_state().unwrap().value;
    assert_eq!(
        state.installed[0].body.as_deref().map(Path::new),
        Some(body.as_path()),
        "账上记的本体位置也不许变"
    );
    assert_eq!(trash.trashed().len(), 1, "旧版应当整份进废纸篓:{:?}", trash.trashed());

    // 清理:删掉本轮推上去的技能目录(残留会打红 gitea_live 的清单断言)
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
        admin
            .change_files(&repo.owner, &repo.repo, &cleanup)
            .await
            .expect("清理失败——手动删掉 skills/author-loop-* 后再跑");
    }
}

/// 🔴 **本期(v8)的病灶本身,只有真 Gitea 能证伪**:分享此前**只上传、从不删除**,
/// 用户在本地删掉的文件会永远留在库里 → 两边指纹永不相等 → 行上恒显示"不一样"、
/// 每次点分享都推一遍相同内容(同事真机上因此开出三个**空**合并请求)。
///
/// 这条用例跑完整一圈:分享两个文件 → 本地删掉其中一个 → 再分享 → 断言
/// ①预览清单里**点名**了那个文件;②确认后**库里真的没有它了**(查真实的树,
/// 不是查我们自己的返回值);③两边指纹相等(`AlreadyInSync` 这一档不再有活可干)。
///
/// wiremock 证明不了第 ②、③ 条:那要真实 Gitea 认下一笔带 `Delete` 操作的多文件提交。
#[tokio::test]
async fn deleting_a_local_file_removes_it_from_a_real_gitea() {
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
    let base_url = vars["SKILLSYNC_FIXTURE_GITEA_URL"].clone();
    let repo = RepoRef {
        owner: vars["SKILLSYNC_FIXTURE_ORG"].clone(),
        repo: vars["SKILLSYNC_FIXTURE_REPO"].clone(),
        branch: "main".into(),
    };
    let admin = GiteaClient::new(base_url.clone(), Some(vars["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone())).unwrap();
    if admin.branch_head(&repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let registry = AgentRegistry::builtin();
    let trash = skillsync_lib::core::fsops::SandboxTrash::new(home.join("..").join("share-live-delete-trash"));

    // 与同进程其他 live 用例错开名字:三条都直推同一个库
    let name = format!("delete-live-{:x}", std::process::id());
    let body = home.join(".agents").join("skills").join(&name);
    write_skill(&body, &name, "两个文件的技能");
    std::fs::write(body.join("extra.md"), "这个文件待会儿会被删掉\n").unwrap();

    let user = admin.current_user().await.unwrap();
    let mut config = store.load_config().unwrap().value;
    config.identities.insert(
        "fixture".into(),
        skillsync_lib::core::ownership::Identity {
            login: user.login.clone(),
            display_name: if user.full_name.trim().is_empty() { user.login.clone() } else { user.full_name.clone() },
        },
    );
    store.save_config(&config).unwrap();

    // ① 首次分享:两个文件都上去
    let first = confirmed_share(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &trash,
        "fixture",
        &repo,
        &name,
        NOW,
    )
    .await
    .expect("首次分享失败");
    assert!(matches!(first, ShareOutcome::Shared { mode: ShareMode::Pushed, .. }), "首次分享应当直推:{first:?}");
    assert!(
        remote_paths(&admin, &repo, &name).await.contains(&format!("skills/{name}/extra.md")),
        "第一步就该把两个文件都推上去"
    );

    // ② 本地删掉 extra.md —— 这正是同事那台机器上发生过的事
    std::fs::remove_file(body.join("extra.md")).unwrap();

    // ③ 预览轮:清单里必须**点名**那个文件
    let preview = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        None,
        NOW,
    )
    .await
    .expect("预览轮失败");
    let share::ShareInstalledOutcome::NeedsConfirm { plan, remote_rev, .. } = preview else {
        panic!("本地删过文件,预览轮就该回一份带删除的清单:{preview:?}");
    };
    assert_eq!(plan.deleted, vec!["extra.md".to_string()], "确认屏要点名这个文件:{plan:?}");

    // ④ 确认后:库里真的没有它了(查真实的树,不是查我们自己的返回值)
    let done = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        Some(remote_rev.as_str()),
        NOW,
    )
    .await
    .expect("确认轮失败");
    let after = remote_paths(&admin, &repo, &name).await;

    // ⑤ 两边一致之后再点一次分享:没有活可干,一个写请求都不该发
    let again = share::share_installed(
        &share::ShareClient::Gitea(&admin),
        &admin,
        &registry,
        &env,
        &store,
        &name,
        "main",
        None,
        NOW,
    )
    .await
    .expect("第三轮失败");

    // 🔴 **清理排在全部断言之前**:断言一 panic,后面的代码就不跑了,残留的技能目录
    // 会打红 `gitea_live` 的库内清单断言——那是一条**与被测代码毫无关系**的红,
    // 排查的人要绕一大圈才找得到源头(本条测试的注入验证当场制造过一次)。
    // 事实都已经取到手上了(`after` / `done` / `again`),清理不会影响任何一条判断。
    cleanup_skill_dir(&admin, &repo, &name).await;

    assert!(matches!(done, share::ShareInstalledOutcome::Submitted(_)), "确认后就该推上去:{done:?}");
    assert!(
        !after.contains(&format!("skills/{name}/extra.md")),
        "本地删掉的文件必须从库里一起删掉,否则两边指纹永不相等:{after:?}"
    );
    assert!(after.contains(&format!("skills/{name}/SKILL.md")), "只删该删的那个:{after:?}");
    assert!(
        matches!(again, share::ShareInstalledOutcome::AlreadyInSync),
        "两边已经一样,就该直说「已一致」而不是推一笔空提交:{again:?}"
    );
}

/// 库里这个技能目录当前有哪些文件(真实的树,不是我们自己的返回值)。
async fn remote_paths(admin: &GiteaClient, repo: &RepoRef, name: &str) -> Vec<String> {
    let head = admin.branch_head(repo).await.unwrap();
    admin
        .tree_files(&repo.owner, &repo.repo, &head.sha)
        .await
        .unwrap()
        .into_iter()
        .map(|f| f.path)
        .filter(|p| p.starts_with(&format!("skills/{name}/")))
        .collect()
}

/// 删掉本轮推上去的技能目录:残留会打红 `gitea_live` 的清单断言。
async fn cleanup_skill_dir(admin: &GiteaClient, repo: &RepoRef, name: &str) {
    let head = admin.branch_head(repo).await.unwrap();
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
        let req = ChangeFilesRequest {
            branch: "main".into(),
            new_branch: None,
            message: format!("清理 live 测试目录 {name}"),
            files,
        };
        admin.change_files(&repo.owner, &repo.repo, &req).await.expect("清理失败");
    }
}

/// 「用户在确认屏上点了确认」的**完整两轮**(终审 C-1:执行轮必须带上"这份清单
/// 基于库里哪一版"的凭据)。预览轮拿 `remote_rev`,执行轮原样带回去——这正是
/// 界面走的路。预览轮就报错 / 直接给出终态时原样回,不硬凑第二跳。
#[allow(clippy::too_many_arguments)]
async fn confirmed_share(
    client: &share::ShareClient<'_>,
    read: &impl skillsync_lib::core::gitea::RepoSource,
    registry: &skillsync_lib::core::agents::AgentRegistry,
    env: &dyn skillsync_lib::core::agents::AgentEnv,
    store: &skillsync_lib::core::state::Store,
    trash: &dyn skillsync_lib::core::fsops::Trasher,
    registry_id: &str,
    repo: &skillsync_lib::core::gitea::RepoRef,
    dir_slug: &str,
    now: &str,
) -> Result<ShareOutcome, skillsync_lib::error::AppError> {
    let first = share::share(
        client,
        read,
        registry,
        env,
        store,
        trash,
        share::ShareRequest { registry_id, repo, dir_slug, confirm: None },
        now,
    )
    .await?;
    let ShareOutcome::NeedsConfirm { remote_rev, .. } = &first else { return Ok(first) };
    let rev = remote_rev.clone();
    share::share(
        client,
        read,
        registry,
        env,
        store,
        trash,
        share::ShareRequest { registry_id, repo, dir_slug, confirm: Some(&rev) },
        now,
    )
    .await
}
