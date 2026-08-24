//! 获取流程编排测试。重点全在"什么时候**不许**动磁盘"上。
//!
//! `Installer::install` 一进去就 `reset_dir` 清空重建 canonical。所以这里的断言口径是
//! **canonical 里的字节有没有变**,而不是"函数返回了哪个枚举"——后者在守卫被绕过时
//! 照样能返回得很漂亮,而用户的文件已经没了。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireRequest, Precheck, Resolution, Stage};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops;
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::state::Store;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-07-30T12:00:00.000Z";
const REGISTRY: &str = "company";

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

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

/// 造一个像真的技能:SKILL.md + 二进制图片 + 可执行脚本。
///
/// 三样都要:早先 `unzip_archive` 只保文本内容,带图片的技能会被装成残缺品、
/// `run.sh` 会被装成不可执行——而只用纯文本技能做 fixture 是测不出这两件事的。
const PNG_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f];
const SCRIPT: &[u8] = b"#!/bin/sh\necho hi\n";

fn zip_with_skill(slug: &str, body: &str) -> Vec<u8> {
    zip_with_skill_in("skills", slug, body)
}

/// 同上,但压缩包顶层目录是 `repo`(Gitea 的 archive 用仓库名做顶层)。
/// 一源多仓的测试要造第二个技能库的压缩包,顶层目录必须跟着变。
fn zip_with_skill_in(repo: &str, slug: &str, body: &str) -> Vec<u8> {
    zip_with_optional_author(repo, slug, body, None)
}

/// 带库根 `authors.json` 的压缩包(v6 任务 3):`store::build_index` 会把它解析成
/// 每个技能的 attribution,而 attribution 的 author 正是"这是不是我分享的"唯一判据。
///
/// **不改 `zip_with_skill`**:那份 fixture 被上面所有既有用例共用,给它加一个文件
/// 会悄悄改掉每个用例看到的索引与内容指纹。
fn zip_with_author(slug: &str, body: &str, author: &str) -> Vec<u8> {
    zip_with_optional_author("skills", slug, body, Some(author))
}

fn zip_with_optional_author(repo: &str, slug: &str, body: &str, author: Option<&str>) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let plain: zip::write::SimpleFileOptions = Default::default();
        let exec = plain.unix_permissions(0o755);
        w.add_directory(format!("{repo}/"), plain).unwrap();
        if let Some(author) = author {
            w.start_file(format!("{repo}/authors.json"), plain).unwrap();
            std::io::Write::write_all(
                &mut w,
                serde_json::json!({ "authors": { slug: { "author": author } } })
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        }
        w.start_file(format!("{repo}/skills/{slug}/SKILL.md"), plain).unwrap();
        std::io::Write::write_all(
            &mut w,
            format!("---\nname: 周报生成\ndescription: 汇总本周工作\n---\n\n{body}\n").as_bytes(),
        )
        .unwrap();
        w.start_file(format!("{repo}/skills/{slug}/logo.png"), plain).unwrap();
        std::io::Write::write_all(&mut w, PNG_BYTES).unwrap();
        w.start_file(format!("{repo}/skills/{slug}/run.sh"), exec).unwrap();
        std::io::Write::write_all(&mut w, SCRIPT).unwrap();
        w.finish().unwrap();
    }
    buf
}

async fn mount(server: &MockServer, sha: &str, slug: &str, body: &str) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": sha, "timestamp": "2026-07-30T10:00:00+08:00" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_with_skill(slug, body)))
        .mount(server)
        .await;
}

/// 与 [`mount`] 同款,但技能库根带 `authors.json`,里面把这个技能记在 `author` 名下。
async fn mount_authored(server: &MockServer, sha: &str, slug: &str, body: &str, author: &str) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": sha, "timestamp": "2026-07-30T10:00:00+08:00" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_with_author(slug, body, author)))
        .mount(server)
        .await;
}

struct Ctx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    registry: AgentRegistry,
    store: Store,
    /// **绝不用默认的 `SYSTEM_TRASH`**:这个测试文件里有覆盖/重装已有本体的场景
    /// (`overwriting_is_only_done_when_explicitly_chosen` 等),不注入的话会把
    /// 测试产物丢进这台机器真实的系统废纸篓。
    trash: fsops::SandboxTrash,
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = Store::new(home.join(".skillsync"));
    let trash = fsops::SandboxTrash::new(home.join(".test-trash"));
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
            trash,
        },
        env,
    )
}

fn canonical(home: &Path, slug: &str) -> PathBuf {
    home.join(".agents").join("skills").join(slug)
}

async fn run(
    server: &MockServer,
    c: &Ctx,
    env: &TmpEnv,
    slug: &str,
    agents: &[String],
    resolution: Option<Resolution>,
) -> Result<acquire::AcquireOutcome, skillsync_lib::error::AppError> {
    let client = GiteaClient::new(server.uri(), None).unwrap();
    // Mutex 而非 RefCell:进度回调要满足 Send + Sync(见 ProgressSink 的注释)
    let stages = std::sync::Mutex::new(Vec::new());
    let sink = |s: Stage| stages.lock().unwrap().push(s);
    acquire::acquire(
        &client,
        &c.registry,
        env,
        &c.store,
        AcquireRequest {
            source: acquire::SourceMeta {
                registry_id: REGISTRY,
                kind: "gitea",
                base_url: &server.uri(),
            },
            repo: &repo_ref(),
            dir_slug: slug,
            agent_names: agents,
            resolution,
        },
        NOW,
        1_753_800_000,
        &c.trash,
        &sink,
    )
    .await
}

// ============================================================ 正常安装

#[tokio::test]
async fn installs_binary_and_executable_files_faithfully() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    let outcome = run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();
    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { local_kept: false, .. }));

    let dir = canonical(&c.home, "weekly-report");
    // 二进制字节必须逐字节往返 —— 文本树里根本没有这个文件,只有 entries 里有
    assert_eq!(std::fs::read(dir.join("logo.png")).unwrap(), PNG_BYTES);
    assert_eq!(std::fs::read(dir.join("run.sh")).unwrap(), SCRIPT);
    assert!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap().contains("汇总本周工作"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        // 可执行位来自压缩包里记的 0o755(Gitea 只对可执行文件写 mode,已实测)
        assert_eq!(mode(dir.join("run.sh")) & 0o111, 0o111, "run.sh 应当可执行");
        assert_eq!(mode(dir.join("logo.png")) & 0o111, 0, "普通文件不该被加上可执行位");
    }
}

#[tokio::test]
async fn records_the_sha_it_actually_installed() {
    let server = MockServer::start().await;
    mount(&server, "bbb2222", "weekly-report", "正文").await;
    let (c, env) = ctx();

    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let state = c.store.load_state().unwrap().value;
    let record = &state.installed[0];
    // 记的必须是这次下载到的版本,不是浏览时缓存里的那个 —— 记错的话更新检查会永久失灵且无提示
    assert_eq!(record.commit_sha, "bbb2222");
    assert_eq!(record.source.git_ref, "bbb2222");
    assert_eq!(record.name, "weekly-report");
    assert_eq!(record.installed_at, NOW);
}

#[tokio::test]
async fn a_fresh_install_immediately_reads_back_as_unmodified() {
    // dir_content_hash 的排除清单口径若与落盘不一致,刚装完就会被判成"用户改过",
    // 之后每次更新都停在冲突提示上。这条测试专门钉住那个口径——
    // **断言对象是 home.body**(v6 二期起本体的实际落点,不再默认就是 canonical):
    // 落盘后从磁盘现算的 hash 必须与记账一致。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let state = c.store.load_state().unwrap().value;
    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env);
    let home = skillsync_lib::core::converge::home_of(&installer, &state, "weekly-report").unwrap();
    let record = state.installed.iter().find(|s| s.name == "weekly-report").unwrap();
    assert_eq!(
        fsops::dir_content_hash(&home.body).unwrap(),
        record.content_hash,
        "落盘后 body 的内容 hash 必须与记账一致,否则刚装完就会被判成「用户改过」"
    );

    let checked = acquire::precheck(&installer, &c.registry, &env, &state, "weekly-report", "aaa1111", Some(&repo_ref()), Default::default()).unwrap();

    assert_eq!(
        checked,
        Precheck::Managed { installed_sha: "aaa1111".into(), up_to_date: true }
    );
}

/// 同一条等式在本体不在 canonical 时依然成立——`dir_content_hash` 只看目录内容,
/// 与目录物理位置无关。这条**不走 `acquire`**,直接摆一个 body 在工具目录里的
/// `SkillHome`,把不变量钉在 `Installer` 这一层。
///
/// (v6 二期任务 4 修复轮 1 订正:原注释写着"当前的 `acquire` 编排永远把本体落在
/// canonical、还没有任何写入路径会填 `state.installed[].body`"——任务 4 之后这句
/// 反了,`AlreadyHere` / `LocalDiffers+Overwrite` 两条路都会把本体落在工具目录里
/// 并把位置写进账。走 `acquire` 的那一档由
/// `a_local_dir_identical_to_the_library_is_adopted_without_writing_its_body`
/// 与 `update_of_a_body_living_in_a_tool_dir_...` 覆盖。)
#[test]
fn hash_equality_holds_even_when_the_body_lives_outside_canonical() {
    let (c, env) = ctx();
    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env)
        .with_trasher(&c.trash);
    let payload = skillsync_lib::core::installer::SkillPayload::new()
        .with_file("SKILL.md", "---\nname: 周报\ndescription: 写周报\n---\n正文\n");

    let elsewhere = c.home.join(".claude").join("skills").join("weekly-report");
    let home_elsewhere = installer.home("weekly-report", Some(&elsewhere)).unwrap();
    installer.install(&home_elsewhere, &payload, &[]).unwrap();

    // 对照:同样内容装进 canonical(另起一个目录名,避免与上面那次互相覆盖)
    let home_canonical = installer.home("weekly-report-canonical", None).unwrap();
    installer.install(&home_canonical, &payload, &[]).unwrap();

    assert_eq!(
        fsops::dir_content_hash(&home_elsewhere.body).unwrap(),
        fsops::dir_content_hash(&home_canonical.body).unwrap(),
        "hash 只看内容,不该因为本体住在别处就变"
    );
}

#[tokio::test]
async fn deleted_body_with_books_still_prechecks_as_fresh() {
    // M5 任务 2:「我的技能」不再列出目录已被删掉的记账(存在性以文件系统为准),
    // 于是"重新获取同名技能"成了这份孤账唯一的对齐路径。这条钉住:记账在而
    // canonical 目录不在时,precheck 走 Fresh(正常安装),不被残留记账绊住。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    // 用户在文件系统里手动删掉了技能目录,记账原样留着
    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env);
    let canonical = installer.home("weekly-report", None).unwrap().canonical;
    std::fs::remove_dir_all(&canonical).unwrap();
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed.len(), 1, "记账应当还在");

    let checked = acquire::precheck(&installer, &c.registry, &env, &state, "weekly-report", "bbb2222", Some(&repo_ref()), Default::default()).unwrap();

    assert_eq!(checked, Precheck::Fresh);
}

#[tokio::test]
async fn a_same_named_skill_from_another_library_needs_a_decision_not_a_silent_swap() {
    // M4 一源多仓最危险的一条:主库装了 weekly-report,用户没改过任何东西,
    // 切到同一个源的另一个技能库,那边也有一个 weekly-report——内容当然不一样。
    // 只比 hash 会把它判成一次正常"更新",清空重建 canonical 并把记账改指过去,
    // **全程不问用户一句**。那不是更新,是替换,必须停下来问。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "主库的正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();
    let before = std::fs::read_to_string(canonical(&c.home, "weekly-report").join("SKILL.md")).unwrap();

    // 另一个库:同源、同名技能、不同内容
    let other = RepoRef { owner: "design".into(), repo: "design-skills".into(), branch: "main".into() };
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/design/design-skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": "bbb2222", "timestamp": "2026-08-01T10:00:00+08:00" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/design/design-skills/archive/main\.zip$"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(zip_with_skill_in("design-skills", "weekly-report", "设计库的正文")),
        )
        .mount(&server)
        .await;

    let client = GiteaClient::new(server.uri(), None).unwrap();
    let stages = std::sync::Mutex::new(Vec::new());
    let sink = |s: Stage| stages.lock().unwrap().push(s);
    let outcome = acquire::acquire(
        &client,
        &c.registry,
        &env,
        &c.store,
        AcquireRequest {
            source: acquire::SourceMeta {
                registry_id: REGISTRY,
                kind: "gitea",
                base_url: &server.uri(),
            },
            repo: &other,
            dir_slug: "weekly-report",
            agent_names: &[],
            resolution: None,
        },
        NOW,
        1_753_800_000,
        &c.trash,
        &sink,
    )
    .await
    .unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::OtherLibrary { source_owner, source_repo, .. },
        } => {
            // 文案要说清"现在这个是从哪来的",否则用户没法判断该不该换
            assert_eq!(source_owner, "skills");
            assert_eq!(source_repo, "skills");
        }
        other => panic!("同名异库必须停下来问,实际: {other:?}"),
    }

    // 关键:磁盘一个字节都没动,记账也没被改指
    let after = std::fs::read_to_string(canonical(&c.home, "weekly-report").join("SKILL.md")).unwrap();
    assert_eq!(after, before, "拍板之前不得动本体");
    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed[0].source.repo, "skills", "拍板之前不得改指来源");
}

#[tokio::test]
async fn batch_skips_a_same_named_skill_from_another_library_with_a_readable_reason() {
    // 批量流程(向导一键全装 / 定时更新)不弹三选:跳过并给人话原因。
    // 定时更新绝不替换用户的技能——这条与上面那条是同一个不变量的两副面孔。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "主库的正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let other = RepoRef { owner: "design".into(), repo: "design-skills".into(), branch: "main".into() };
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/design/design-skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": "bbb2222", "timestamp": "2026-08-01T10:00:00+08:00" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/design/design-skills/archive/main\.zip$"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(zip_with_skill_in("design-skills", "weekly-report", "设计库的正文")),
        )
        .mount(&server)
        .await;

    let client = GiteaClient::new(server.uri(), None).unwrap();
    let items = acquire::acquire_batch(
        &client,
        &c.registry,
        &env,
        &c.store,
        acquire::SourceMeta { registry_id: REGISTRY, kind: "gitea", base_url: &server.uri() },
        &other,
        &["weekly-report".to_string()],
        acquire::BatchAgents::Uniform(&[]),
        NOW,
        1_753_800_000,
        &c.trash,
    )
    .await
    .unwrap();

    match &items[0].outcome {
        acquire::BatchOutcome::Skipped { reason } => {
            assert!(reason.contains("skills/skills"), "原因要说清现在这个是从哪来的: {reason}");
            // 人话:不露内部术语
            assert!(!reason.contains("repo"), "{reason}");
        }
        other => panic!("批量流程必须跳过,实际: {other:?}"),
    }
    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed[0].source.repo, "skills");
}

#[tokio::test]
async fn writes_the_external_lock_contract() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(c.home.join(".agents").join(".skill-lock.json")).unwrap(),
    )
    .unwrap();
    let entry = &lock["skills"]["weekly-report"];
    assert_eq!(entry["source"], "skills/skills");
    assert_eq!(entry["skillPath"], "skills/weekly-report");
    // 非 GitHub 源填空串(上游对 well-known 源就是这么填的)
    assert_eq!(entry["skillFolderHash"], "");
    // sourceUrl 必须是**完整 URL**(录制的 ground truth 就是这个形状)。
    // 曾经写的是 "owner/repo",于是 `acquire::resolve_binding` 的同源判据整个失效
    // ——脱管后重新纳入管理只能退回按 owner/repo 猜(M6 任务 6 修)。
    assert_eq!(entry["sourceUrl"], format!("{}/skills/skills", server.uri()));
    // sourceType 要说实话:此前不论来源是什么都写死 gitea
    assert_eq!(entry["sourceType"], "gitea");
}

// ============================================================ contentHash 守卫

/// 装好之后由用户改一笔本体,模拟"改过技能"。
fn user_edits(dir: &Path) {
    std::fs::write(dir.join("SKILL.md"), "---\nname: 周报生成\ndescription: 我改过的说明\n---\n我的改动\n")
        .unwrap();
}

#[tokio::test]
async fn a_locally_modified_skill_is_never_overwritten_without_a_decision() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let dir = canonical(&c.home, "weekly-report");
    user_edits(&dir);
    let mine = std::fs::read(dir.join("SKILL.md")).unwrap();

    // 远端出了新版本,用户再点一次获取
    let server2 = MockServer::start().await;
    mount(&server2, "ccc3333", "weekly-report", "远端的新正文").await;
    let outcome = run(&server2, &c, &env, "weekly-report", &[], None).await.unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::LocallyModified { installed_sha },
        } => assert_eq!(installed_sha, "aaa1111"),
        other => panic!("应当停下来问用户,实际: {other:?}"),
    }
    // 真正要断的是**文件还在**:只断枚举的话,守卫被绕过时这条测试照样过
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), mine, "用户的改动被抹掉了");
}

#[tokio::test]
async fn keeping_local_changes_touches_nothing_in_the_skill_body() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();
    let dir = canonical(&c.home, "weekly-report");
    user_edits(&dir);
    let mine = std::fs::read(dir.join("SKILL.md")).unwrap();

    let server2 = MockServer::start().await;
    mount(&server2, "ccc3333", "weekly-report", "远端的新正文").await;
    let outcome = run(&server2, &c, &env, "weekly-report", &[], Some(Resolution::KeepLocal))
        .await
        .unwrap();

    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { local_kept: true, .. }));
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), mine);

    // 关于内容的记账一个都不能动:这两个字段不符正是"有未分享的改动"与"有可用更新"
    // 这两个标记的判据,更新了标记就消失,用户的改动会在界面上彻底隐形。
    let state = c.store.load_state().unwrap().value;
    let record = &state.installed[0];
    assert_eq!(record.commit_sha, "aaa1111", "保留本地时不该把版本推进到远端");
    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env);
    assert_eq!(
        acquire::precheck(&installer, &c.registry, &env, &state, "weekly-report", "ccc3333", Some(&repo_ref()), Default::default()).unwrap(),
        Precheck::LocallyModified { installed_sha: "aaa1111".into() },
        "保留本地之后,它仍应被认作有未分享的改动"
    );
}

#[tokio::test]
async fn overwriting_is_only_done_when_explicitly_chosen() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();
    let dir = canonical(&c.home, "weekly-report");
    user_edits(&dir);

    let server2 = MockServer::start().await;
    mount(&server2, "ccc3333", "weekly-report", "远端的新正文").await;
    let outcome = run(&server2, &c, &env, "weekly-report", &[], Some(Resolution::Overwrite))
        .await
        .unwrap();

    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { local_kept: false, .. }));
    let now = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
    assert!(now.contains("远端的新正文"), "选了覆盖就该拿到远端内容");
    assert!(!now.contains("我的改动"));

    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed[0].commit_sha, "ccc3333");
    // 覆盖后 hash 必须与新内容一致,否则下一次又会被判成"用户改过"
    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env);
    assert!(matches!(
        acquire::precheck(&installer, &c.registry, &env, &state, "weekly-report", "ccc3333", Some(&repo_ref()), Default::default()).unwrap(),
        Precheck::Managed { up_to_date: true, .. }
    ));
}

#[tokio::test]
async fn an_unmodified_skill_updates_without_asking() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    // 用户没动过本体 → 远端有新版就直接更新,不该拿冲突去烦他
    let server2 = MockServer::start().await;
    mount(&server2, "ccc3333", "weekly-report", "远端的新正文").await;
    let outcome = run(&server2, &c, &env, "weekly-report", &[], None).await.unwrap();

    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { local_kept: false, .. }));
    let dir = canonical(&c.home, "weekly-report");
    assert!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap().contains("远端的新正文"));

    // 更新路径**也**要记实装版本。原先只有首次安装那条测试断言了 sha,
    // 于是把更新分支的 commit_sha 改坏,测试照样全绿(注入验证抓出来的)。
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed.len(), 1, "更新不该再追加一条记录");
    assert_eq!(state.installed[0].commit_sha, "ccc3333");
    assert_eq!(state.installed[0].installed_at, NOW, "首次安装时间要保留");
}

// ============================================================ 本地已有一份(无账)

/// v6 二期:本地已有一份、内容与库里**不同** → 两选,磁盘零写入。
///
/// 这条取代了旧的 `a_foreign_directory_is_reported_as_foreign_not_as_modified`。
/// 旧行为是告诉用户「这个位置上的技能不是本应用安装的」——那句话在"用户自己在
/// Claude Code 里开发这个技能"的场景下是把作者当外人,正是本期要消灭的。
/// 现在只问内容:不同就两选,不再猜"这个文件夹是谁建的"。
#[tokio::test]
async fn a_local_copy_that_differs_asks_which_one_to_keep_and_writes_nothing() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    let dir = canonical(&c.home, "weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "别人装的技能\n").unwrap();
    let theirs = std::fs::read(dir.join("SKILL.md")).unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::LocalDiffers { existing },
        } => assert_eq!(existing, dir.to_string_lossy(), "要说清是哪一份"),
        other => panic!("内容不同应当两选,实际: {other:?}"),
    }
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), theirs, "拍板之前动了本地那一份");
    assert!(c.trash.trashed().is_empty(), "拍板之前一个字节都不该进废纸篓");
}

/// 同一现场选「保留本地」:磁盘、记账、关联一个字节都不动。
///
/// **刻意不补建关联**:这一档没有任何记账,补了链接却没有账,移除时谁也摘不掉
/// 它们(`remove::remove` 只按 `state.links` 摘链)。要建关联走「勾选工具」。
#[tokio::test]
async fn keeping_the_local_copy_changes_nothing_at_all() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    let dir = canonical(&c.home, "weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "我自己写的\n").unwrap();
    let mine = std::fs::read(dir.join("SKILL.md")).unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &[], Some(Resolution::KeepLocal))
        .await
        .unwrap();

    assert!(
        matches!(outcome, acquire::AcquireOutcome::Kept { remote_changed: true }),
        "实际: {outcome:?}"
    );
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), mine);
    assert!(c.store.load_state().unwrap().value.installed.is_empty(), "不该凭空记一条账");
    assert!(c.trash.trashed().is_empty());
}

// ============================================================ 其他边界

#[tokio::test]
async fn a_skill_that_vanished_from_the_library_reports_an_actionable_error() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    let err = run(&server, &c, &env, "已经下架的技能", &[], None).await.unwrap_err();
    assert_eq!(err.code, "REPO_NOT_FOUND");
    assert!(err.message.contains("刷新"), "{}", err.message);
}

#[tokio::test]
async fn progress_reports_every_stage_in_order() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let stages = std::sync::Mutex::new(Vec::new());
    let sink = |s: Stage| stages.lock().unwrap().push(s);

    acquire::acquire(
        &client,
        &c.registry,
        &env,
        &c.store,
        AcquireRequest {
            source: acquire::SourceMeta {
                registry_id: REGISTRY,
                kind: "gitea",
                base_url: &server.uri(),
            },
            repo: &repo_ref(),
            dir_slug: "weekly-report",
            agent_names: &[],
            resolution: None,
        },
        NOW,
        1_753_800_000,
        &c.trash,
        &sink,
    )
    .await
    .unwrap();

    assert_eq!(
        stages.into_inner().unwrap(),
        vec![
            Stage::Fetching,
            Stage::Checking,
            Stage::Writing,
            Stage::Linking,
            Stage::Recording,
            Stage::Done
        ]
    );
}

// ============================================================ 记账的 agents 字段

#[tokio::test]
async fn recorded_agents_are_the_ones_the_skill_actually_works_for() {
    // cursor 的目录就是 canonical(universal):不建链、不出现在 links 里,
    // 但技能对它确实生效 —— agents 里必须有它,否则界面会把它画成"没启用"。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    run(
        &server,
        &c,
        &env,
        "weekly-report",
        &["claude-code".to_string(), "cursor".to_string()],
        None,
    )
    .await
    .unwrap();

    let state = c.store.load_state().unwrap().value;
    let record = &state.installed[0];
    assert_eq!(record.agents, ["claude-code", "cursor"]);
    // links 只记真实建过的链:cursor 那侧没有链
    assert_eq!(record.links.len(), 1);
}

#[tokio::test]
async fn a_failed_link_is_never_recorded_as_active() {
    // Claude Code 的落点被一个实体目录占着 → 建链失败(OnOccupied::Fail)。
    // 失败的那个若被记成"已生效",界面会画成启用中,用户以为技能可用 —— 实际上读不到。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    // ⚠️ **占位目录里刻意不放 SKILL.md**(v6 二期任务 4 改):放了的话它就是一份
    // 合法的同名技能实体,`converge::scan_all` 会把它认成候选本体,整条流程走的是
    // `LocalDiffers`(两选)而不是"装到 canonical 再建链"——那时测的就不是本条
    // 想测的东西了。这里要的是"落点被一个**不是技能**的目录占着"。
    let occupied = c.home.join(".claude").join("skills").join("weekly-report");
    std::fs::create_dir_all(&occupied).unwrap();
    std::fs::write(occupied.join("notes.md"), "用户自己放的\n").unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &["claude-code".to_string()], None)
        .await
        .unwrap();
    // 安装本身不失败:本体照常落盘,失败只体现在这一条链上
    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { .. }));

    let state = c.store.load_state().unwrap().value;
    let record = &state.installed[0];
    assert!(record.agents.is_empty(), "建链失败还被记成已生效: {:?}", record.agents);
    assert!(record.links.is_empty(), "失败的链不该进记账 —— 卸载时会拿它去动用户自己的目录");
}

// v6 二期任务 4:`keep_local_never_applies_to_a_foreign_directory` 已删除。
//
// 它守的是"向导一律传 KeepLocal 会把别人的内容当成我们装的记进 state"。
// 那条路现在从根上不存在了:本地已有一份、内容与库里不同 + KeepLocal 走的是
// `AcquireOutcome::Kept`——磁盘、记账、关联一个字节都不动,压根没有"记进 state"
// 这个动作。同一个不变量由上面的 `keeping_the_local_copy_changes_nothing_at_all`
// 正面断言(`installed.is_empty()`)。

#[tokio::test]
async fn acquiring_also_refreshes_the_store_index_cache() {
    // 压缩包已经在手上,顺带把索引刷到同一版本:免得用户装完回到列表还看到旧的"可更新"
    let server = MockServer::start().await;
    mount(&server, "ddd4444", "weekly-report", "正文").await;
    let (c, env) = ctx();

    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let cache = skillsync_lib::core::store::cache_path(c.store.dir(), REGISTRY, &repo_ref());
    let index = skillsync_lib::core::store::load_cache(&cache).expect("索引缓存应已写入");
    assert_eq!(index.commit_sha, "ddd4444");
    assert_eq!(index.skills.len(), 1);
}

// ============================================================ 「我分享的」(v6 任务 3)
//
// 这一节钉的是同一件事的六个面:**技能库里记的分享者是当前登录的这个人时,
// 获取流程不能再把他当外人**。判据来自库根 authors.json(随索引下来,离线可算),
// 不是本地的任何一本账——所以"换电脑 / app 数据丢了 / 绕过 app 直接推上去"
// 这三种本地毫无记录的场景,判定照样成立。

const ME_LOGIN: &str = "zhaowh";
const ME_DISPLAY: &str = "赵文浩";

/// 把「我」写进 `config.identities[REGISTRY]`(登录那一刻 session.rs 做的事)。
fn sign_in(c: &Ctx) {
    let mut config = c.store.load_config().unwrap().value;
    config.identities.insert(
        REGISTRY.to_string(),
        skillsync_lib::core::ownership::Identity {
            login: ME_LOGIN.into(),
            display_name: ME_DISPLAY.into(),
        },
    );
    c.store.save_config(&config).unwrap();
}

/// 我自己写的技能,直接推进了技能库(没经过本 app),这台电脑上因此:
/// canonical 里有实体目录、`state.installed` 没有账、npx 的 lock 里也没有条目。
/// 旧代码在这里返回 `Foreign`,弹窗告诉作者"这个位置上的技能不是本应用安装的"。
#[tokio::test]
async fn author_is_me_never_yields_foreign() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "库里的正文", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);

    let dir = canonical(&c.home, "weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "我自己起草的\n").unwrap();
    let drafted = std::fs::read(dir.join("SKILL.md")).unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::Mine { local_changed, remote_changed },
        } => {
            // 没有账 = 没有基线,两边一律按"变了"处理(少报哪一边都会丢东西)
            assert!(local_changed, "没有基线时必须当作本地有改动");
            assert!(remote_changed, "没有基线时必须当作库里也有新版");
        }
        other => panic!("作者在自己的技能上不该看到外来目录,实际: {other:?}"),
    }
    assert_eq!(
        std::fs::read(dir.join("SKILL.md")).unwrap(),
        drafted,
        "拍板之前一个字节都不该动"
    );
}

/// 对照组:同一份现场,只是没登录。未登录时不知道你是谁,于是只能按内容说话
/// ——落进 `LocalDiffers`(两选),而不是 `Mine`(那一档只有作者本人才配)。
#[tokio::test]
async fn signed_out_falls_back_to_comparing_content() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "库里的正文", ME_DISPLAY).await;
    let (c, env) = ctx(); // 刻意不 sign_in

    let dir = canonical(&c.home, "weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "我自己起草的\n").unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::LocalDiffers { existing },
        } => assert_eq!(existing, dir.to_string_lossy()),
        other => panic!("未登录时应当按内容两选,实际: {other:?}"),
    }
}

/// 「库里有新版、本地没改过」→ 直接取回;并且**两个阶段都要有分享基线**。
///
/// 第一段(Fresh)就是换电脑那一档:canonical 上什么都没有,precheck 走 `Fresh`,
/// 根本不经过 Mine 的折叠——基线若只在 Mine 那一档建,这一段会一条 shared 都没有,
/// 而「有改动未分享」正是靠它判定的。
#[tokio::test]
async fn mine_without_local_edits_pulls_and_seeds_shared_baseline() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "第一版", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);

    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let dir = canonical(&c.home, "weekly-report");
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.shared.len(), 1, "换电脑取回后必须有分享基线");
    assert_eq!(state.shared[0].name, "weekly-report");
    assert_eq!(state.shared[0].target.owner, "skills");
    assert_eq!(state.shared[0].target.repo, "skills");
    let first = skillsync_lib::core::fsops::dir_content_hash(&dir).unwrap();
    assert_eq!(state.shared[0].content_hash, first);

    // 第二段:库里出了新版(别人经审核改的),本地没动过 → 直接取回
    let server2 = MockServer::start().await;
    mount_authored(&server2, "bbb2222", "weekly-report", "第二版", ME_DISPLAY).await;
    run(&server2, &c, &env, "weekly-report", &[], None).await.unwrap();

    let second = skillsync_lib::core::fsops::dir_content_hash(&dir).unwrap();
    assert_ne!(second, first, "第二版内容应当真的落了盘");
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.shared.len(), 1, "基线是对齐不是新增一条");
    assert_eq!(state.shared[0].content_hash, second, "基线必须对齐到刚取回的这一版");
}

/// 「两边都新」:磁盘零写入,等用户拍板。
#[tokio::test]
async fn mine_with_local_edits_writes_nothing_without_a_decision() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "第一版", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let dir = canonical(&c.home, "weekly-report");
    user_edits(&dir);
    let before = skillsync_lib::core::fsops::dir_content_hash(&dir).unwrap();

    let server2 = MockServer::start().await;
    mount_authored(&server2, "bbb2222", "weekly-report", "同事改过的", ME_DISPLAY).await;
    let outcome = run(&server2, &c, &env, "weekly-report", &[], None).await.unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::Mine { local_changed, remote_changed },
        } => {
            assert!(local_changed);
            assert!(remote_changed);
        }
        other => panic!("两边都新时应当停下来问,实际: {other:?}"),
    }
    assert_eq!(
        skillsync_lib::core::fsops::dir_content_hash(&dir).unwrap(),
        before,
        "拍板之前磁盘一个字节都没动"
    );
}

/// 有账之后**也必须还能进 `Mine`**:第一次取回就会记一条 `state.installed`,
/// 此后同名目录先命中 `LocallyModified`。只在"没记账"时判关系的话,作者两边都新时
/// 弹的仍是旧三选(里面有拍板不给作者的「保留并贡献」)。
///
/// 同一份现场里带对照组:`me` 为 `None` 时仍然是 `LocallyModified`。
#[tokio::test]
async fn mine_with_ledger_still_yields_mine_not_locally_modified() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "第一版", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let dir = canonical(&c.home, "weekly-report");
    user_edits(&dir);

    let state = c.store.load_state().unwrap().value;
    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env);
    let me = skillsync_lib::core::ownership::Identity {
        login: ME_LOGIN.into(),
        display_name: ME_DISPLAY.into(),
    };

    let checked = acquire::precheck(
        &installer,
        &c.registry,
        &env,
        &state,
        "weekly-report",
        "bbb2222",
        Some(&repo_ref()),
        acquire::PrecheckContext {
            me: Some(&me),
            author: Some(ME_DISPLAY),
            remote_content_hash: Some("远端换了内容"),
        },
    )
    .unwrap();
    assert_eq!(checked, Precheck::Mine { local_changed: true, remote_changed: true });

    // 对照组:同一份 state、同一个目录,只是不知道我是谁
    let checked = acquire::precheck(
        &installer,
        &c.registry,
        &env,
        &state,
        "weekly-report",
        "bbb2222",
        Some(&repo_ref()),
        Default::default(),
    )
    .unwrap();
    assert_eq!(checked, Precheck::LocallyModified { installed_sha: "aaa1111".into() });
}

/// `remote_changed` 的判据是**逐技能内容指纹**,不是技能库的头 sha。
///
/// 库头一变就说"库里有新版"正是 2026-08-03 用户实测撞到的缺陷(别人分享任意一个
/// 技能都会让全部已装技能同时亮),而这个值会驱动两件真事:冲突弹窗上那句
/// "库里有新版",以及「以本地为准」之后分享更新要不要强制走审核。
/// fixture 刻意让 sha 与内容指纹给出**相反**的结论,两者取同值就测不出区别。
#[tokio::test]
async fn a_new_library_head_with_identical_content_is_not_a_remote_change() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "第一版", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let state = c.store.load_state().unwrap().value;
    let installed_hash = state.installed[0].content_hash.clone();
    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env);
    let me = skillsync_lib::core::ownership::Identity {
        login: ME_LOGIN.into(),
        display_name: ME_DISPLAY.into(),
    };

    let checked = acquire::precheck(
        &installer,
        &c.registry,
        &env,
        &state,
        "weekly-report",
        // 库头变了(别人分享了**另一个**技能),但这个技能的内容一个字没改
        "bbb2222",
        Some(&repo_ref()),
        acquire::PrecheckContext {
            me: Some(&me),
            author: Some(ME_DISPLAY),
            remote_content_hash: Some(&installed_hash),
        },
    )
    .unwrap();

    assert_eq!(
        checked,
        Precheck::Mine { local_changed: false, remote_changed: false },
        "库头变了不等于这个技能变了"
    );
}

/// 「以本地为准」:磁盘、记账、基线一个字节都不动,并把 `remote_changed` 交还给
/// 调用方——它为真时后续的分享更新必须强制走审核(直推等于覆盖同事经审核改的版本)。
#[tokio::test]
async fn keeping_local_on_my_own_skill_writes_nothing_and_reports_remote_changed() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "第一版", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);
    run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    let dir = canonical(&c.home, "weekly-report");
    user_edits(&dir);
    let edited = skillsync_lib::core::fsops::dir_content_hash(&dir).unwrap();
    let baseline_before = c.store.load_state().unwrap().value.shared[0].content_hash.clone();

    let server2 = MockServer::start().await;
    mount_authored(&server2, "bbb2222", "weekly-report", "同事改过的", ME_DISPLAY).await;
    let outcome = run(&server2, &c, &env, "weekly-report", &[], Some(Resolution::KeepLocal))
        .await
        .unwrap();

    match outcome {
        acquire::AcquireOutcome::Kept { remote_changed } => assert!(remote_changed),
        other => panic!("以本地为准时不该安装任何东西,实际: {other:?}"),
    }
    assert_eq!(
        skillsync_lib::core::fsops::dir_content_hash(&dir).unwrap(),
        edited,
        "本体被动过了"
    );
    let state = c.store.load_state().unwrap().value;
    assert_eq!(
        state.shared[0].content_hash, baseline_before,
        "没分享出去就不能动基线,动了「有改动未分享」这个标记会凭空消失"
    );
    assert_eq!(state.installed[0].commit_sha, "aaa1111", "记账也不该动");
}

/// 定时更新(与向导的一键全装)对「我分享的」一律跳过并说人话;
/// 但它装**新的**技能时,分享基线同样要建起来——新机器上的一键全装就是换电脑。
#[tokio::test]
async fn batch_skips_mine() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "第一版", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let source = acquire::SourceMeta {
        registry_id: REGISTRY,
        kind: "gitea",
        base_url: &server.uri(),
    };
    let slugs = vec!["weekly-report".to_string()];

    let items = acquire::acquire_batch(
        &client,
        &c.registry,
        &env,
        &c.store,
        source,
        &repo_ref(),
        &slugs,
        acquire::BatchAgents::Uniform(&[]),
        NOW,
        1_753_800_000,
        &c.trash,
    )
    .await
    .unwrap();
    assert!(
        matches!(items[0].outcome, acquire::BatchOutcome::Installed { .. }),
        "全新环境该照常装上,实际: {:?}",
        items[0].outcome
    );
    assert_eq!(
        c.store.load_state().unwrap().value.shared.len(),
        1,
        "批量装我自己的技能同样要建分享基线(一键全装 = 换电脑)"
    );

    // 库里出了新版:自动流程绝不替作者覆盖他自己的技能
    let server2 = MockServer::start().await;
    mount_authored(&server2, "bbb2222", "weekly-report", "第二版", ME_DISPLAY).await;
    let client2 = GiteaClient::new(server2.uri(), None).unwrap();
    let source2 = acquire::SourceMeta {
        registry_id: REGISTRY,
        kind: "gitea",
        base_url: &server2.uri(),
    };
    let items = acquire::acquire_batch(
        &client2,
        &c.registry,
        &env,
        &c.store,
        source2,
        &repo_ref(),
        &slugs,
        acquire::BatchAgents::FromAccount,
        NOW,
        1_753_800_000,
        &c.trash,
    )
    .await
    .unwrap();

    match &items[0].outcome {
        acquire::BatchOutcome::Skipped { reason } => {
            assert!(!reason.is_empty(), "跳过必须给一句人话");
            assert!(reason.contains("分享"), "跳过的原因要说清是因为这是我分享的:{reason}");
        }
        other => panic!("自动流程不该覆盖作者的技能,实际: {other:?}"),
    }
    let dir = canonical(&c.home, "weekly-report");
    assert!(
        std::fs::read_to_string(dir.join("SKILL.md")).unwrap().contains("第一版"),
        "本地内容被自动覆盖了"
    );
}

// ============================================================ 本体住在工具目录里(v6 二期任务 4)
//
// 这一节钉的是本期的核心承诺:**本体只有一份、住在它现在所在的地方、永不搬动**。
// 用户在 `~/.claude/skills/` 下开发技能是真实场景(项目记忆里那条原始诉求),
// 旧模型会把它当外人、取回时把它删掉换成 canonical 里的一份。

/// 在 `<home>/<rel_dir>/<slug>` 造一份与压缩包里那个技能**逐字节相同**的实体目录。
///
/// 三个文件一个都不能少:`dir_content_hash` 走的是"全部文件的相对路径 + 字节",
/// 少一个 logo.png 就与索引里的 `content_hash` 不相等,`AlreadyHere` 那一档
/// 根本走不到——而那正是这一节要测的东西。
fn plant_identical_skill(home: &Path, rel_dir: &str, slug: &str, body: &str) -> PathBuf {
    let dir = home.join(rel_dir).join(slug);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: 周报生成\ndescription: 汇总本周工作\n---\n\n{body}\n"),
    )
    .unwrap();
    std::fs::write(dir.join("logo.png"), PNG_BYTES).unwrap();
    std::fs::write(dir.join("run.sh"), SCRIPT).unwrap();
    dir
}

/// 造一份内容与库里**不同**的实体目录(只有 SKILL.md,足够被认成技能)。
fn plant_draft(home: &Path, rel_dir: &str, slug: &str, body: &str) -> PathBuf {
    let dir = home.join(rel_dir).join(slug);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: 周报生成\ndescription: 我自己写的\n---\n\n{body}\n"),
    )
    .unwrap();
    dir
}

/// 造一条**全空来源坐标**的记账(任务 3 起,勾选工具 / 版本拍板给纯本地技能建的
/// `adopted` 账就是这个形状)。`content_hash` 是真值——"勾的那一刻的快照"。
fn seed_sourceless_record(c: &Ctx, slug: &str, body: &Path) {
    let mut state = c.store.load_state().map(|l| l.value).unwrap_or_default();
    state.installed.push(skillsync_lib::core::state::InstalledSkill {
        name: slug.to_string(),
        source: skillsync_lib::core::state::SkillSource {
            registry_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            path: String::new(),
            git_ref: String::new(),
        },
        commit_sha: String::new(),
        content_hash: fsops::dir_content_hash(body).unwrap(),
        origin: Some(skillsync_lib::core::state::ORIGIN_ADOPTED.into()),
        body: Some(body.to_string_lossy().into_owned()),
        agents: vec!["claude-code".into()],
        links: Vec::new(),
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    c.store.save_state(&state).unwrap();
}

/// 索引缓存里这个技能的内容指纹(acquire 会顺带把缓存刷到同一版本)。
fn index_hash(c: &Ctx, slug: &str) -> String {
    let cache = skillsync_lib::core::store::cache_path(c.store.dir(), REGISTRY, &repo_ref());
    let index = skillsync_lib::core::store::load_cache(&cache).expect("索引缓存应已写入");
    index
        .skills
        .iter()
        .find(|s| s.dir_slug == slug)
        .expect("索引里应有这个技能")
        .content_hash
        .clone()
}

#[tokio::test]
async fn a_local_dir_identical_to_the_library_is_adopted_without_writing_its_body() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    let body = plant_identical_skill(&c.home, ".claude/skills", "weekly-report", "正文");
    let before = std::fs::read(body.join("SKILL.md")).unwrap();

    let agents = vec!["claude-code".to_string(), "trae".to_string()];
    let outcome = run(&server, &c, &env, "weekly-report", &agents, None).await.unwrap();
    assert!(
        matches!(outcome, acquire::AcquireOutcome::Installed { .. }),
        "内容已经一样,不该停下来问: {outcome:?}"
    );

    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "weekly-report").unwrap();
    assert_eq!(
        rec.body.as_deref(),
        Some(body.to_string_lossy().as_ref()),
        "本体必须留在原地,账上要记住它在哪"
    );
    assert_eq!(rec.content_hash, index_hash(&c, "weekly-report"), "基线等于索引指纹");
    // 刻意分了两个 origin 值,就该有断言——否则这段代码删掉也没人知道(修复轮 1,M-4)
    assert_eq!(
        rec.origin.as_deref(),
        Some(skillsync_lib::core::state::ORIGIN_ADOPTED),
        "本地已有一份、只是记账建链,来历该记 adopted 而不是 acquired"
    );
    assert!(c.trash.trashed().is_empty(), "内容相同,一个字节都不该进废纸篓");
    assert_eq!(std::fs::read(body.join("SKILL.md")).unwrap(), before, "本体被重写了");

    // canonical 与另一个工具都变成指向本体的链接
    assert_eq!(
        fsops::read_link_target(&c.home.join(".agents").join("skills").join("weekly-report")),
        Some(fsops::normalize(&body)),
        "canonical 没有指回本体"
    );
    assert_eq!(
        fsops::read_link_target(&c.home.join(".trae").join("skills").join("weekly-report")),
        Some(fsops::normalize(&body)),
        "trae 没有指回本体"
    );
    // 本体所在那个工具读的就是本体自己,不需要链接——但它确实生效,必须进账
    assert!(
        rec.agents.contains(&"claude-code".to_string()),
        "本体所在工具被漏成没启用: {:?}",
        rec.agents
    );
    assert!(rec.agents.contains(&"trae".to_string()), "{:?}", rec.agents);
}

/// 本地有**好几份**、内容全都与库里相同:选一份当本体,其余静默收成链接
/// (进废纸篓,可逆)——内容一样就是无损,不必打扰用户。
///
/// 这条钉的是 `finish` 里那趟 `merge_converged_others`:收敛成功的位置必须
/// **进账**,否则 `remove::remove`(只按 `state.links` 摘链)摘不掉它们,
/// 移除本体之后会在各工具目录里留下一地悬空链接。
#[tokio::test]
async fn identical_copies_elsewhere_are_folded_into_links_and_recorded() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    let body = plant_identical_skill(&c.home, ".claude/skills", "weekly-report", "正文");
    let dup = plant_identical_skill(&c.home, ".trae/skills", "weekly-report", "正文");

    let outcome = run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();
    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { .. }), "{outcome:?}");

    assert_eq!(
        fsops::read_link_target(&dup),
        Some(fsops::normalize(&body)),
        "内容一样的副本应当被收成指向本体的链接"
    );
    assert_eq!(c.trash.trashed(), vec![dup.clone()], "副本要进废纸篓,不能直接删");
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "weekly-report").unwrap();
    assert!(
        rec.links
            .iter()
            .any(|l| Path::new(&l.dir) == c.home.join(".trae").join("skills")),
        "收敛成功的位置必须进账(remove 才摘得掉): {:?}",
        rec.links
    );
}

#[tokio::test]
async fn a_local_dir_that_differs_needs_a_decision_and_overwrite_keeps_the_location() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "库里的正文").await;
    let (c, env) = ctx();
    let body = plant_draft(&c.home, ".claude/skills", "weekly-report", "我的草稿");

    let agents = vec!["claude-code".to_string()];
    let outcome = run(&server, &c, &env, "weekly-report", &agents, None).await.unwrap();
    let acquire::AcquireOutcome::NeedsDecision { precheck } = outcome else {
        panic!("内容不同必须停下来问")
    };
    assert_eq!(
        precheck,
        Precheck::LocalDiffers { existing: body.to_string_lossy().into_owned() }
    );
    assert!(
        std::fs::read_to_string(body.join("SKILL.md")).unwrap().contains("我的草稿"),
        "拍板前磁盘不动"
    );

    let outcome = run(&server, &c, &env, "weekly-report", &agents, Some(Resolution::Overwrite))
        .await
        .unwrap();
    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { .. }), "{outcome:?}");
    assert_eq!(c.trash.trashed(), vec![body.clone()], "旧的那份要进废纸篓,不能直接删");
    assert!(
        std::fs::read_to_string(body.join("SKILL.md")).unwrap().contains("库里的正文"),
        "库里的版本必须装到**同一位置**——本体不搬家"
    );
    assert!(
        !c.home.join(".agents").join("skills").join("weekly-report").join("SKILL.md").is_file()
            || fsops::read_link_target(&c.home.join(".agents").join("skills").join("weekly-report")).is_some(),
        "canonical 上应当是一条链接,不是又装了一份实体"
    );
    let st = c.store.load_state().unwrap().value;
    assert_eq!(
        st.installed[0].body.as_deref(),
        Some(body.to_string_lossy().as_ref()),
        "账上要记住本体在哪"
    );
}

#[tokio::test]
async fn a_recorded_skill_with_a_stray_differing_copy_still_updates_normally() {
    // 有账 + 工具目录里一份内容不同的杂散副本:`locate` 有账时恒返回 Body(账上),
    // precheck 照旧走 Managed。否则一份副本就能让自动更新静默停摆。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "第一版").await;
    let (c, env) = ctx();
    let agents = vec!["claude-code".to_string()];
    run(&server, &c, &env, "weekly-report", &agents, None).await.unwrap();

    // 摘掉链接,原位放一份内容不同的实体
    let link = c.home.join(".claude").join("skills").join("weekly-report");
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_dir(&link);
    let stray = plant_draft(&c.home, ".claude/skills", "weekly-report", "杂散副本");

    let server2 = MockServer::start().await;
    mount(&server2, "bbb2222", "weekly-report", "第二版").await;
    let outcome = run(&server2, &c, &env, "weekly-report", &agents, None).await.unwrap();

    assert!(
        matches!(outcome, acquire::AcquireOutcome::Installed { .. }),
        "不该退化成需要拍板: {outcome:?}"
    );
    assert!(
        std::fs::read_to_string(canonical(&c.home, "weekly-report").join("SKILL.md"))
            .unwrap()
            .contains("第二版"),
        "更新没落到本体上"
    );
    assert!(
        std::fs::read_to_string(stray.join("SKILL.md")).unwrap().contains("杂散副本"),
        "杂散副本一个字节都不该被动(建链撞上它 → converge Differs)"
    );
    assert!(c.trash.trashed().iter().all(|p| p != &stray), "杂散副本被丢进了废纸篓");
}

/// 编译期守卫:`Precheck` 不再有「这个目录不是本应用装的」那一档。
///
/// 穷尽 match 没有 `_` 兜底,任何人把 `Foreign` 加回来(或新增一档忘了处理)
/// 都会在这里编译失败。
#[test]
fn foreign_is_gone_nobody_is_told_their_dir_is_not_ours() {
    let _ = |p: Precheck| match p {
        Precheck::Fresh
        | Precheck::AlreadyHere { .. }
        | Precheck::LocalDiffers { .. }
        | Precheck::NeedsVersionChoice { .. }
        | Precheck::Managed { .. }
        | Precheck::LocallyModified { .. }
        | Precheck::OtherLibrary { .. }
        | Precheck::Mine { .. } => {}
    };
}

#[tokio::test]
async fn several_differing_copies_ask_the_user_to_pick_a_version_first() {
    // 无账 + 两处实体、内容还不一样:`Resolution` 的两档都回答不了"留哪一份",
    // 所以这一档**无视 resolution**,恒退回让用户先去拍板。磁盘零写入。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "库里的正文").await;
    let (c, env) = ctx();
    let a = plant_draft(&c.home, ".claude/skills", "weekly-report", "A 版");
    let b = plant_draft(&c.home, ".trae/skills", "weekly-report", "B 版");

    for resolution in [None, Some(Resolution::Overwrite), Some(Resolution::KeepLocal)] {
        let outcome = run(&server, &c, &env, "weekly-report", &[], resolution).await.unwrap();
        let acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::NeedsVersionChoice { versions },
        } = outcome
        else {
            panic!("有分歧版本时必须先拍板(resolution={resolution:?})")
        };
        let paths: Vec<&str> = versions.iter().map(|v| v.path.as_str()).collect();
        assert!(paths.contains(&a.to_string_lossy().as_ref()), "{paths:?}");
        assert!(paths.contains(&b.to_string_lossy().as_ref()), "{paths:?}");
    }
    assert!(std::fs::read_to_string(a.join("SKILL.md")).unwrap().contains("A 版"));
    assert!(std::fs::read_to_string(b.join("SKILL.md")).unwrap().contains("B 版"));
    assert!(c.trash.trashed().is_empty(), "拍板之前一个字节都不该进废纸篓");
    assert!(c.store.load_state().unwrap().value.installed.is_empty());
}

#[tokio::test]
async fn batch_skips_local_differs_and_version_choice_with_a_human_reason() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "库里的正文").await;
    let (c, env) = ctx();
    plant_draft(&c.home, ".claude/skills", "weekly-report", "我的草稿");

    let client = GiteaClient::new(server.uri(), None).unwrap();
    macro_rules! batch {
        () => {
            acquire::acquire_batch(
                &client,
                &c.registry,
                &env,
                &c.store,
                acquire::SourceMeta { registry_id: REGISTRY, kind: "gitea", base_url: &server.uri() },
                &repo_ref(),
                &["weekly-report".to_string()],
                acquire::BatchAgents::Uniform(&[]),
                NOW,
                1_753_800_000,
                &c.trash,
            )
            .await
            .unwrap()
        };
    }

    let items = batch!();
    match &items[0].outcome {
        acquire::BatchOutcome::Skipped { reason } => {
            assert!(reason.contains("内容不同"), "原因要说人话: {reason}");
        }
        other => panic!("批量流程必须跳过,实际: {other:?}"),
    }

    // 再加一份不同的,变成"多个分歧版本"
    plant_draft(&c.home, ".trae/skills", "weekly-report", "另一份");
    let items = batch!();
    match &items[0].outcome {
        acquire::BatchOutcome::Skipped { reason } => {
            assert!(reason.contains("好几份"), "原因要说人话: {reason}");
        }
        other => panic!("批量流程必须跳过,实际: {other:?}"),
    }
    assert!(c.store.load_state().unwrap().value.installed.is_empty());
    assert!(c.trash.trashed().is_empty());
}

#[tokio::test]
async fn update_of_a_body_living_in_a_tool_dir_writes_in_place_and_trashes_the_old_version() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    let body = plant_identical_skill(&c.home, ".claude/skills", "weekly-report", "正文");
    let agents = vec!["claude-code".to_string()];
    run(&server, &c, &env, "weekly-report", &agents, None).await.unwrap(); // AlreadyHere → 记账

    // 库里出新版
    let server2 = MockServer::start().await;
    mount(&server2, "bbb2222", "weekly-report", "第二版").await;
    let outcome = run(&server2, &c, &env, "weekly-report", &agents, None).await.unwrap();

    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { .. }), "{outcome:?}");
    assert!(
        std::fs::read_to_string(body.join("SKILL.md")).unwrap().contains("第二版"),
        "更新必须写在本体原地"
    );
    assert_eq!(c.trash.trashed(), vec![body.clone()], "旧的那一版进废纸篓");
    assert_eq!(
        fsops::dir_content_hash(&body).unwrap(),
        index_hash(&c, "weekly-report"),
        "hash 等式必须对 body 成立——不成立就是界面永远误报「有更新」"
    );
    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1, "更新不该再追加一条记录");
    assert_eq!(st.installed[0].commit_sha, "bbb2222");
    assert_eq!(st.installed[0].content_hash, index_hash(&c, "weekly-report"));
}

/// 「我分享的」技能取回时建的分享基线,`local_path` 记的必须是**本体**所在。
///
/// 记成 canonical 的话,`share::share_installed` 与 `remove` 都会拿一条指向
/// 一条链接的路径去比对/清理——而 `remove` 正是按 `local_path` 清孤儿的
/// (见 `remove_flow::removing_also_clears_the_shared_baseline_it_leaves_behind`)。
#[tokio::test]
async fn the_shared_baseline_points_at_the_body_not_at_the_canonical_link() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "库里的正文", ME_DISPLAY).await;
    let (c, env) = ctx();
    sign_in(&c);
    let body = plant_draft(&c.home, ".claude/skills", "weekly-report", "我的草稿");

    // 作者在自己的技能上永远落进 `Mine`(无账 = 无基线,两边一律按"变了"算),
    // 所以要用「用库里的」这一档才走到落盘 + 建基线。
    let outcome = run(&server, &c, &env, "weekly-report", &["claude-code".to_string()], None)
        .await
        .unwrap();
    assert!(
        matches!(
            outcome,
            acquire::AcquireOutcome::NeedsDecision { precheck: Precheck::Mine { .. } }
        ),
        "{outcome:?}"
    );
    run(&server, &c, &env, "weekly-report", &["claude-code".to_string()], Some(Resolution::Overwrite))
        .await
        .unwrap();

    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.shared.len(), 1, "作者取回自己的技能必须留下分享基线");
    assert_eq!(
        std::path::Path::new(&st.shared[0].local_path),
        body.as_path(),
        "基线指向的必须是本体"
    );
    assert_eq!(st.shared[0].content_hash, fsops::dir_content_hash(&body).unwrap());
}

/// 记账的内容指纹从**本体**算,不从 `report.canonical_dir` 算。
///
/// 本体住在工具目录、而 canonical 那条链接**没建成**(这里把 `~/.agents` 占成一个
/// 普通文件)时,两者的差别才现形:按 canonical 算会 `FS_HASH_FAILED`,整次获取
/// 因此失败——可技能本体明明已经好好地落在盘上了。
/// (canonical 链接建不成本就只该进报告,不该拦下整次获取。)
#[tokio::test]
async fn the_recorded_hash_is_computed_from_the_body_not_from_the_canonical_link() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "库里的正文").await;
    let (c, env) = ctx();
    let body = plant_identical_skill(&c.home, ".claude/skills", "weekly-report", "库里的正文");
    // canonical 的父目录被占成一个普通文件 → canonical 那条链接必然建不成
    std::fs::write(c.home.join(".agents"), b"not a directory").unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &["claude-code".to_string()], None)
        .await
        .unwrap();

    assert!(
        matches!(outcome, acquire::AcquireOutcome::Installed { .. }),
        "canonical 链接建不成不该拦下整次获取: {outcome:?}"
    );
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "weekly-report").unwrap();
    assert_eq!(
        rec.content_hash,
        fsops::dir_content_hash(&body).unwrap(),
        "记账的指纹必须是本体的指纹"
    );
    assert!(!rec.content_hash.is_empty());
}

/// 🔴 R10 + R14:纯本地技能的记账用的是**全空的来源坐标**(任务 3 起,勾选工具 /
/// 版本拍板时顺手建的 `adopted` 账)。它有两件事都不能做:
///
/// 1. **不能被说成「装自另一个技能库」**(R10):空 owner 与任何真实 owner 都不相等,
///    不过滤的话商店里同名技能点获取**必然**得到那句假话——它压根没装自任何技能库;
/// 2. **不能享有 `Managed` 的"无决策直接覆盖"**(R14,修复轮 1):`Managed` 的语义前提
///    是"记账里的内容来自技能库,覆盖是安全的",而空来源账的 `content_hash` 只是
///    "勾的那一刻的快照"。它必须走与**无账**完全相同的内容比对分档
///    (`AlreadyHere` / `LocalDiffers`),该问的要问。
#[tokio::test]
async fn a_record_with_no_library_source_walks_the_same_path_as_no_record() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "库里的正文").await;
    let (c, env) = ctx();

    // 现场:用户在 Claude Code 下开发这个技能,勾过工具 → 一条来源全空的 adopted 账
    let body = plant_draft(&c.home, ".claude/skills", "weekly-report", "我的草稿");
    seed_sourceless_record(&c, "weekly-report", &body);

    let installer = skillsync_lib::core::installer::Installer::new(&c.registry, &env);
    let state = c.store.load_state().unwrap().value;
    let checked = acquire::precheck(
        &installer,
        &c.registry,
        &env,
        &state,
        "weekly-report",
        "aaa1111",
        Some(&repo_ref()),
        Default::default(),
    )
    .unwrap();

    assert!(
        !matches!(checked, Precheck::OtherLibrary { .. }),
        "来源全空的账被当成了「另一个技能库」: {checked:?}"
    );
    assert_eq!(
        checked,
        Precheck::LocalDiffers { existing: body.to_string_lossy().into_owned() },
        "内容与库里不同 → 必须两选,不能落进 Managed 被无决策覆盖"
    );
}

/// R14 的端到端:草稿**不会**被静默换掉。
///
/// 这是这条裁定的全部价值——修复轮 1 之前,同一现场 `acquire` 会一路走到
/// `Managed{up_to_date:false}` → `needs_decision` 不含它 → **直接 install**,
/// 用户的草稿本体进废纸篓,全程没问过一句。
#[tokio::test]
async fn a_sourceless_draft_is_never_overwritten_without_a_decision() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "库里的正文").await;
    let (c, env) = ctx();
    let body = plant_draft(&c.home, ".claude/skills", "weekly-report", "我的草稿");
    seed_sourceless_record(&c, "weekly-report", &body);

    let outcome = run(&server, &c, &env, "weekly-report", &["claude-code".to_string()], None)
        .await
        .unwrap();

    assert!(
        matches!(
            outcome,
            acquire::AcquireOutcome::NeedsDecision { precheck: Precheck::LocalDiffers { .. } }
        ),
        "草稿必须停下来问,实际: {outcome:?}"
    );
    assert!(
        std::fs::read_to_string(body.join("SKILL.md")).unwrap().contains("我的草稿"),
        "拍板之前草稿被动过了"
    );
    assert!(c.trash.trashed().is_empty(), "拍板之前一个字节都不该进废纸篓");
}

/// R14 的另一半:空来源账 + 内容与库里**逐字节相同** → `AlreadyHere`(无损,直接办)。
///
/// 与上一条是同一条判据的两个方向:该问的问、不该问的不问。
#[tokio::test]
async fn a_sourceless_record_whose_content_matches_is_adopted_not_rewritten() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();
    let body = plant_identical_skill(&c.home, ".claude/skills", "weekly-report", "正文");
    seed_sourceless_record(&c, "weekly-report", &body);

    let outcome = run(&server, &c, &env, "weekly-report", &["claude-code".to_string()], None)
        .await
        .unwrap();

    assert!(matches!(outcome, acquire::AcquireOutcome::Installed { .. }), "{outcome:?}");
    assert!(c.trash.trashed().is_empty(), "内容一样,一个字节都不该进废纸篓");
    let st = c.store.load_state().unwrap().value;
    let rec = st.installed.iter().find(|s| s.name == "weekly-report").unwrap();
    assert_eq!(rec.source.owner, "skills", "收编之后来源要落到库坐标上");
    assert_eq!(rec.commit_sha, "aaa1111");
}

// ============================================================ 查账键(I-1,修复轮 1)
//
// 记账写的是**清洗后**的目录名(`sanitize_name` 会小写化),而调用方手上的
// `dir_slug` 是**技能库里的原始目录名**。两把尺子在全 ASCII 小写的技能上恰好相同
// ——**所以全小写 fixture 测不出任何东西**,这两条一律用大写 slug。
// 公司库 20 个技能都是小写,但技能广场是任意 GitHub 仓。

const MIXED: &str = "Weekly-Report";
/// `sanitize_name("Weekly-Report")`,也就是记账键与磁盘目录名。
const MIXED_KEY: &str = "weekly-report";

#[tokio::test]
async fn a_mixed_case_dir_slug_still_finds_its_record_on_the_next_acquire() {
    // 与 `a_recorded_skill_with_a_stray_differing_copy_still_updates_normally` 同一现场,
    // 只是技能库里的目录名带大写。查账键一错就走无账路 →
    // 一份杂散副本让 precheck 输出 NeedsVersionChoice → **自动更新静默停摆**。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", MIXED, "第一版").await;
    let (c, env) = ctx();
    let agents = vec!["claude-code".to_string()];
    run(&server, &c, &env, MIXED, &agents, None).await.unwrap();

    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed[0].name, MIXED_KEY, "前置:记账键是清洗后的名字");

    // 摘掉链接,原位放一份内容不同的实体
    let link = c.home.join(".claude").join("skills").join(MIXED_KEY);
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_dir(&link);
    let stray = plant_draft(&c.home, ".claude/skills", MIXED_KEY, "杂散副本");

    let server2 = MockServer::start().await;
    mount(&server2, "bbb2222", MIXED, "第二版").await;
    let outcome = run(&server2, &c, &env, MIXED, &agents, None).await.unwrap();

    assert!(
        matches!(outcome, acquire::AcquireOutcome::Installed { .. }),
        "大写目录名让查账失效 → 退化成需要拍板: {outcome:?}"
    );
    assert!(
        std::fs::read_to_string(canonical(&c.home, MIXED_KEY).join("SKILL.md"))
            .unwrap()
            .contains("第二版"),
        "更新没落到本体上"
    );
    assert!(
        std::fs::read_to_string(stray.join("SKILL.md")).unwrap().contains("杂散副本"),
        "杂散副本一个字节都不该被动"
    );
}

#[tokio::test]
async fn a_mixed_case_dir_slug_never_lets_the_body_move_house() {
    // 更隐蔽的那个后果:账上 `body = None`(本体在 canonical)+ 别处有一份**同内容**
    // 副本时,查账键一错就走无账路 → `choose_body` **优先非 canonical** → 本体被
    // "搬"进 `.claude/skills/`(原 canonical 实体进废纸篓、换成链接)。
    // 内容没丢(可逆),但「本体永不搬家」这条承诺被打破,而且没问过用户。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", MIXED, "正文").await;
    let (c, env) = ctx();
    run(&server, &c, &env, MIXED, &[], None).await.unwrap();

    let body = canonical(&c.home, MIXED_KEY);
    assert!(body.join("SKILL.md").is_file(), "前置:本体落在 canonical");
    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed[0].body, None, "前置:本体就在 canonical,账上不记 body");

    // 别的工具目录里放一份与本体**逐字节相同**的副本
    let dup = plant_identical_skill(&c.home, ".trae/skills", MIXED_KEY, "正文");
    assert_eq!(
        fsops::dir_content_hash(&dup).unwrap(),
        fsops::dir_content_hash(&body).unwrap(),
        "前置:两份内容必须逐字节相同,否则测的是另一档"
    );

    run(&server, &c, &env, MIXED, &[], None).await.unwrap();

    assert!(
        fsops::read_link_target(&body).is_none() && body.join("SKILL.md").is_file(),
        "本体被搬走了:canonical 上现在是一条链接而不是实体"
    );
    assert_eq!(
        fsops::read_link_target(&dup),
        Some(fsops::normalize(&body)),
        "方向反了——副本应当被收成指向 canonical 本体的链接,而不是反过来"
    );
    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed[0].body, None, "账上的本体位置被改指到了别处");
    // ⚠️ 刻意不断言"canonical 没进废纸篓":这一轮走的是正常更新
    // (`Managed`),`Installer::install` 本来就是"旧本体进废纸篓 → rename",
    // canonical 出现在废纸篓里是**对的**。要钉的是"本体还在原地",
    // 上面三条断言(canonical 仍是实体 / 副本指向它 / 账上 body 仍为 None)才是判据。
}

#[tokio::test]
async fn a_mixed_case_dir_slug_updates_the_body_where_the_books_say_it_lives() {
    // 第三个后果,专钉 `home_of` 那把钥匙:账上明明记着本体住在 `.claude/skills/`,
    // 查账键一错就读不到那条 `body`,更新会落回 canonical ——
    // **本体被搬回 canonical,原地那份变成一份没人管的陈旧实体**。
    // (前两条测试钉的是 `locate` 那把钥匙,`home_of` 这把在它们的现场恰好不影响结果。)
    let server = MockServer::start().await;
    mount(&server, "aaa1111", MIXED, "正文").await;
    let (c, env) = ctx();
    let body = plant_identical_skill(&c.home, ".claude/skills", MIXED_KEY, "正文");
    let agents = vec!["claude-code".to_string()];
    run(&server, &c, &env, MIXED, &agents, None).await.unwrap(); // AlreadyHere → 记账

    let st = c.store.load_state().unwrap().value;
    assert_eq!(
        st.installed[0].body.as_deref(),
        Some(body.to_string_lossy().as_ref()),
        "前置:账上必须记着本体住在工具目录里"
    );

    let server2 = MockServer::start().await;
    mount(&server2, "bbb2222", MIXED, "第二版").await;
    run(&server2, &c, &env, MIXED, &agents, None).await.unwrap();

    assert!(
        std::fs::read_to_string(body.join("SKILL.md")).unwrap().contains("第二版"),
        "更新没写在账上记的那个位置——本体被搬走了"
    );
    assert_eq!(
        fsops::read_link_target(&canonical(&c.home, MIXED_KEY)),
        Some(fsops::normalize(&body)),
        "canonical 应当仍是一条指向本体的链接,而不是又装了一份实体"
    );
    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1, "更新不该再追加一条记录");
    assert_eq!(
        st.installed[0].body.as_deref(),
        Some(body.to_string_lossy().as_ref()),
        "账上的本体位置被改指了"
    );
}

/// 批量的 `FromAccount` 档(定时更新)同样按 `record_key` 查账。
///
/// 用错的后果:大写目录名的技能在**每一轮定时更新**里都被判成「未安装,已跳过」
/// ——它明明就装着,却永远收不到更新,而且界面上什么异常都看不出来。
#[tokio::test]
async fn batch_from_account_finds_the_record_for_a_mixed_case_slug() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", MIXED, "第一版").await;
    let (c, env) = ctx();
    run(&server, &c, &env, MIXED, &["claude-code".to_string()], None).await.unwrap();

    let server2 = MockServer::start().await;
    mount(&server2, "bbb2222", MIXED, "第二版").await;
    let client = GiteaClient::new(server2.uri(), None).unwrap();
    let items = acquire::acquire_batch(
        &client,
        &c.registry,
        &env,
        &c.store,
        acquire::SourceMeta { registry_id: REGISTRY, kind: "gitea", base_url: &server2.uri() },
        &repo_ref(),
        &[MIXED.to_string()],
        acquire::BatchAgents::FromAccount,
        NOW,
        1_753_800_000,
        &c.trash,
    )
    .await
    .unwrap();

    match &items[0].outcome {
        acquire::BatchOutcome::Installed { .. } => {}
        other => panic!("装着的技能被定时更新判成没装,实际: {other:?}"),
    }
    assert!(
        std::fs::read_to_string(canonical(&c.home, MIXED_KEY).join("SKILL.md"))
            .unwrap()
            .contains("第二版"),
        "更新没落盘"
    );
    let st = c.store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1);
    assert_eq!(st.installed[0].commit_sha, "bbb2222");
}

// ============================================================ IPC 序列化形状

/// 🔴 `#[serde(rename_all = ...)]` 挂在**枚举**上只改 variant 名,**不改 struct
/// variant 的字段名**。`Precheck` 与 `AcquireOutcome` 从引入起就少了
/// `rename_all_fields`,于是一直把蛇形键发给前端,而 `src/lib/ipc.ts` 的类型
/// 与 `ConflictDialog` 读的是驼峰。两处真实后果:
/// - 「装自另一个技能库」弹窗里那句库名渲染成 `undefined/undefined`;
/// - `Kept.remoteChanged` 恒为 `undefined`(falsy)→ 后续分享**不强制走审核**,
///   直推等于覆盖同事经审核改过的版本。
///
/// 这条正面钉住键名。core 侧没有别的地方会碰到这两个枚举的序列化形状。
#[test]
fn precheck_and_outcome_serialize_with_camel_case_field_names() {
    let json = |v: &serde_json::Value| v.to_string();

    let managed = serde_json::to_value(Precheck::Managed {
        installed_sha: "aaa".into(),
        up_to_date: true,
    })
    .unwrap();
    assert_eq!(managed["status"], "managed");
    assert!(managed.get("installedSha").is_some(), "{}", json(&managed));
    assert!(managed.get("upToDate").is_some(), "{}", json(&managed));

    let other = serde_json::to_value(Precheck::OtherLibrary {
        installed_sha: "aaa".into(),
        source_owner: "skills".into(),
        source_repo: "skills".into(),
    })
    .unwrap();
    assert_eq!(other["sourceOwner"], "skills", "{}", json(&other));
    assert_eq!(other["sourceRepo"], "skills", "{}", json(&other));

    let mine = serde_json::to_value(Precheck::Mine {
        local_changed: true,
        remote_changed: false,
    })
    .unwrap();
    assert_eq!(mine["localChanged"], true, "{}", json(&mine));
    assert_eq!(mine["remoteChanged"], false, "{}", json(&mine));

    // v6 二期新增的三档:variant 名也要是驼峰
    let here = serde_json::to_value(Precheck::AlreadyHere { body: "/x/s".into() }).unwrap();
    assert_eq!(here["status"], "alreadyHere", "{}", json(&here));
    assert_eq!(here["body"], "/x/s");
    let differs = serde_json::to_value(Precheck::LocalDiffers { existing: "/x/s".into() }).unwrap();
    assert_eq!(differs["status"], "localDiffers", "{}", json(&differs));
    assert_eq!(differs["existing"], "/x/s");
    let choice = serde_json::to_value(Precheck::NeedsVersionChoice { versions: Vec::new() }).unwrap();
    assert_eq!(choice["status"], "needsVersionChoice", "{}", json(&choice));

    let kept = serde_json::to_value(acquire::AcquireOutcome::Kept { remote_changed: true }).unwrap();
    assert_eq!(kept["outcome"], "kept");
    assert_eq!(kept["remoteChanged"], true, "{}", json(&kept));

    let installed = serde_json::to_value(acquire::AcquireOutcome::Installed {
        report: skillsync_lib::core::installer::InstallReport {
            dir_name: "s".into(),
            canonical_dir: "/x/s".into(),
            links: Vec::new(),
        },
        local_kept: true,
        lock: "written".into(),
    })
    .unwrap();
    assert_eq!(installed["outcome"], "installed");
    assert_eq!(installed["localKept"], true, "{}", json(&installed));
}
