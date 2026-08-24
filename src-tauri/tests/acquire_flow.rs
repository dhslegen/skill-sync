//! 获取流程编排测试。重点全在"什么时候**不许**动磁盘"上。
//!
//! `Installer::install` 一进去就 `reset_dir` 清空重建 canonical。所以这里的断言口径是
//! **canonical 里的字节有没有变**,而不是"函数返回了哪个枚举"——后者在守卫被绕过时
//! 照样能返回得很漂亮,而用户的文件已经没了。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireRequest, ForeignOrigin, Precheck, Resolution, Stage};
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

    let checked = acquire::precheck(&installer, &env, &state, "weekly-report", "aaa1111", Some(&repo_ref()), Default::default()).unwrap();

    assert_eq!(
        checked,
        Precheck::Managed { installed_sha: "aaa1111".into(), up_to_date: true }
    );
}

/// 同一条等式在本体不在 canonical 时依然成立——`dir_content_hash` 只看目录内容,
/// 与目录物理位置无关。当前的 `acquire` 编排永远把本体落在 canonical(还没有任何
/// 写入路径会填 `state.installed[].body`),所以这条不走 `acquire`,直接摆一个
/// body 在工具目录里的 `SkillHome`,验证底层不变量在那个位置上依然成立。
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

    let checked = acquire::precheck(&installer, &env, &state, "weekly-report", "bbb2222", Some(&repo_ref()), Default::default()).unwrap();

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
        acquire::precheck(&installer, &env, &state, "weekly-report", "ccc3333", Some(&repo_ref()), Default::default()).unwrap(),
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
        acquire::precheck(&installer, &env, &state, "weekly-report", "ccc3333", Some(&repo_ref()), Default::default()).unwrap(),
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

// ============================================================ 外来目录

#[tokio::test]
async fn a_foreign_directory_is_reported_as_foreign_not_as_modified() {
    // 关键:这里**没有** state.installed 记录 —— 两个分支若共用 fixture 就会塌成一个
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
            precheck: Precheck::Foreign { origin },
        } => assert_eq!(origin, ForeignOrigin::Unknown),
        other => panic!("应当报成外来目录,实际: {other:?}"),
    }
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), theirs, "别人的目录被动过了");
}

#[tokio::test]
async fn a_foreign_directory_from_npx_skills_names_its_source() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    let dir = canonical(&c.home, "weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "npx skills 装的\n").unwrap();
    // 用排除法认出来源(设计方案 2.5②):能在 npx skills 的 lock 里查到就是它装的
    std::fs::write(
        c.home.join(".agents").join(".skill-lock.json"),
        serde_json::json!({
            "version": 3,
            "skills": { "weekly-report": { "source": "acme/skills", "sourceType": "github" } }
        })
        .to_string(),
    )
    .unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::Foreign { origin },
        } => assert_eq!(origin, ForeignOrigin::NpxSkills { source: "acme/skills".into() }),
        other => panic!("应当认出 npx skills 来源,实际: {other:?}"),
    }
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

    let occupied = c.home.join(".claude").join("skills").join("weekly-report");
    std::fs::create_dir_all(&occupied).unwrap();
    std::fs::write(occupied.join("SKILL.md"), "用户自己放的\n").unwrap();

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

#[tokio::test]
async fn keep_local_never_applies_to_a_foreign_directory() {
    // 外来目录里没有"你的改动"可留。接受 KeepLocal 会把别人的内容当成我们装的记进 state,
    // 之后更新检查永远显示"已是最新"。界面不给这个组合,但新的调用方(向导批量安装)
    // 很可能一律传 KeepLocal —— 必须在 core 层堵死,不能靠界面的形状保证。
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report", "正文").await;
    let (c, env) = ctx();

    let dir = canonical(&c.home, "weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "别人装的技能\n").unwrap();
    let theirs = std::fs::read(dir.join("SKILL.md")).unwrap();

    let err = run(&server, &c, &env, "weekly-report", &[], Some(Resolution::KeepLocal))
        .await
        .unwrap_err();

    assert_eq!(err.code, "CONFLICT_FOREIGN_DIR");
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), theirs, "外来目录被动过了");
    // 账上也不能多出一条:那份内容不是我们装的
    assert!(c.store.load_state().unwrap().value.installed.is_empty());
}

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

/// 对照组:同一份现场,只是没登录。未登录时不知道你是谁,**行为一个字不变**。
#[tokio::test]
async fn signed_out_keeps_foreign() {
    let server = MockServer::start().await;
    mount_authored(&server, "aaa1111", "weekly-report", "库里的正文", ME_DISPLAY).await;
    let (c, env) = ctx(); // 刻意不 sign_in

    let dir = canonical(&c.home, "weekly-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "我自己起草的\n").unwrap();

    let outcome = run(&server, &c, &env, "weekly-report", &[], None).await.unwrap();

    match outcome {
        acquire::AcquireOutcome::NeedsDecision {
            precheck: Precheck::Foreign { origin },
        } => assert_eq!(origin, ForeignOrigin::Unknown),
        other => panic!("未登录时应当维持原样,实际: {other:?}"),
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
