//! 广场挂仓后走既有获取(`acquire`)全链路的编排测试(M9 任务 3)。
//!
//! **本任务对 `acquire` 侧零逻辑改动**——`acquire::acquire`/`SourceMeta::source_url`
//! 都是既有代码(M6 任务 6 定的形状)。这份测试验的是"喂给它的坐标对不对":
//! 走 `registry::resolve(PLAZA_REGISTRY_ID, ..)` 这条与 `commands.rs` 完全同款的路径
//! 拿到 `ResolvedRegistry`,拼出 `SourceMeta` 喂给 `acquire::acquire`,断言
//! `state.installed` 与 `.skill-lock.json` 落的是广场坐标而不是别的什么。
//!
//! 网络仍然打到 wiremock(`GithubClient` 单独用 `server.uri()` 构造,与
//! `SourceMeta.base_url` 解耦)——与 `tests/github_client.rs` 同一套"把 wiremock 当
//! GHE 用"的手法(`api_base_for` 对非 `github.com` 主机会挂 `/api/v3`)。
//! `resolved.base_url` 则来自 `registry::resolve`,在生产与本测试里都是同一个硬编码
//! 常量 `https://github.com`——这正是要钉住的事实:与网络端点无关。

use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, AcquireRequest, Stage};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::registry::{self, PLAZA_REGISTRY_ID};
use skillsync_lib::core::state::{RepoConfig, Store};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-08-12T12:00:00.000Z";

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

/// GitHub 风格的压缩包顶层前缀(`{owner}-{repo}-{短sha}/`,2026-07-31 实测),
/// 内容随便什么都行——`unzip_archive` 只按第一段取 root,不校验具体命名。
fn zip_with_skill(slug: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::SimpleFileOptions = Default::default();
        w.add_directory("vercel-labs-skills-aaa1111/", opts).unwrap();
        w.start_file(format!("vercel-labs-skills-aaa1111/skills/{slug}/SKILL.md"), opts)
            .unwrap();
        std::io::Write::write_all(
            &mut w,
            b"---\nname: \xe5\x91\xa8\xe6\x8a\xa5\xe7\x94\x9f\xe6\x88\x90\ndescription: \xe6\xb1\x87\xe6\x80\xbb\xe6\x9c\xac\xe5\x91\xa8\xe5\xb7\xa5\xe4\xbd\x9c\n---\n\n\xe6\xad\xa3\xe6\x96\x87\n",
        )
        .unwrap();
        w.finish().unwrap();
    }
    buf
}

async fn mount(server: &MockServer, sha: &str, slug: &str) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "sha": sha, "commit": { "committer": { "date": "2026-08-12T10:00:00Z" } } }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/zipball/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_with_skill(slug)))
        .mount(server)
        .await;
}

#[tokio::test]
async fn acquiring_through_the_plaza_registry_records_plaza_id_and_a_full_github_source_url() {
    let server = MockServer::start().await;
    mount(&server, "aaa1111", "weekly-report").await;

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let agent_registry = AgentRegistry::builtin();

    // 与 commands.rs 的 `resolve_registry` 完全同款的路径:广场挂了这个仓,
    // 通过 registry::resolve 拿到访问坐标(base_url 是编译期同款常量,不是猜的)。
    let plaza_repos = vec![RepoConfig {
        owner: "vercel-labs".into(),
        repo: "skills".into(),
        branch: "main".into(),
        name: None,
    }];
    let builtin = registry::BuiltinSource { base_url: None, repo: None, branch: "main" };
    let resolved = registry::resolve(
        &builtin,
        &[],
        &[],
        PLAZA_REGISTRY_ID,
        Some("vercel-labs/skills"),
        &plaza_repos,
    )
    .unwrap();
    assert_eq!(
        resolved.base_url, "https://github.com",
        "sanity:广场坐标必须是 github.com,不是 skills.sh 或别的什么"
    );

    // 网络端点单独指向 wiremock,与 SourceMeta.base_url 解耦(见模块头)。
    let client = GithubClient::new(&server.uri(), None, reqwest::Client::new());

    let outcome = acquire::acquire(
        &client,
        &agent_registry,
        &env,
        &store,
        AcquireRequest {
            source: acquire::SourceMeta {
                registry_id: &resolved.id,
                kind: resolved.kind.as_str(),
                base_url: &resolved.base_url,
            },
            repo: &resolved.repo,
            dir_slug: "weekly-report",
            agent_names: &[],
            resolution: None,
        },
        NOW,
        1_755_000_000,
        &|_: Stage| {},
    )
    .await
    .unwrap();
    assert!(
        matches!(outcome, acquire::AcquireOutcome::Installed { .. }),
        "全新安装不该撞冲突: {outcome:?}"
    );

    // ---- state.installed:registry_id / owner / repo 必须是广场坐标 ----
    let st = store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1);
    assert_eq!(st.installed[0].source.registry_id, "plaza");
    assert_eq!(st.installed[0].source.owner, "vercel-labs");
    assert_eq!(st.installed[0].source.repo, "skills");

    // ---- .skill-lock.json:sourceUrl 是完整 URL、sourceType 是真实类型 ----
    // 对照口径与 M6 任务 6 的 `writes_the_external_lock_contract`(tests/acquire_flow.rs)
    // 及录制的 ground truth(tests/fixtures/upstream-skill-lock.json)相同。
    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(home.join(".agents").join(".skill-lock.json")).unwrap(),
    )
    .unwrap();
    let entry = &lock["skills"]["weekly-report"];
    assert_eq!(entry["source"], "vercel-labs/skills");
    assert_eq!(
        entry["sourceUrl"], "https://github.com/vercel-labs/skills",
        "曾经的缺陷是写 owner/repo 或错误域名,resolve_binding 的同源判据会因此失效"
    );
    assert_eq!(entry["sourceType"], "github");
}

// ============================================================ skillId ≠ 仓内目录名(2026-08-19 终审修复)

/// 造一个"skills.sh 的 skillId 与仓内目录名不同"的仓:目录叫 `dir_slug`,
/// SKILL.md 的 frontmatter `name`(= skills.sh 的 `skillId`)叫 `name`。
/// 真实样本:`vercel-labs/agent-skills` 的 `skills/react-best-practices/SKILL.md`,
/// frontmatter `name: vercel-react-best-practices`。
fn zip_with_named_skill(dir_slug: &str, name: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::SimpleFileOptions = Default::default();
        w.add_directory("vercel-labs-skills-aaa1111/", opts).unwrap();
        w.start_file(format!("vercel-labs-skills-aaa1111/skills/{dir_slug}/SKILL.md"), opts)
            .unwrap();
        std::io::Write::write_all(
            &mut w,
            format!("---\nname: {name}\ndescription: React 性能优化指南\n---\n\n正文\n").as_bytes(),
        )
        .unwrap();
        w.finish().unwrap();
    }
    buf
}

/// 🔴 端到端复现并钉住 2026-08-19 终审抓到的那条缺陷:
/// 用户在广场搜到 `vercel-react-best-practices`(skills.sh 的 `skillId`,取自
/// SKILL.md 的 frontmatter `name`)→ 点开详情 → 点「获取」。
///
/// 仓里的目录其实叫 `react-best-practices`。修复前详情把 `dir_slug` 填成了 skillId,
/// 前端原样当安装键传下来,于是**安装必然失败**(blob 快路径在树里找不到该目录 →
/// 回退 zipball → 索引里也没有这个 dir_slug → `REPO_NOT_FOUND`)。
///
/// 这条测试走的是真实生产函数的完整链路:
/// blob 详情(必须 Err)→ 整仓 zipball 详情(拿到真实 dir_slug)→ `acquire::acquire`
/// (必须装成功)——并逐条断言落盘的目录名/记账键/lock 键都是**仓内目录名**,
/// 不是 skills.sh 的 skillId。
#[tokio::test]
async fn a_skill_whose_skills_sh_id_differs_from_its_repo_directory_still_installs() {
    const DIR_SLUG: &str = "react-best-practices";
    const SKILLS_SH_ID: &str = "vercel-react-best-practices";

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "sha": "aaa1111", "commit": { "committer": { "date": "2026-08-12T10:00:00Z" } } }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/zipball/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_with_named_skill(DIR_SLUG, SKILLS_SH_ID)))
        .mount(&server)
        .await;
    // 仓库树:只有 `skills/react-best-practices/SKILL.md`,没有任何叫
    // `vercel-react-best-practices` 的目录——这正是真实仓库的形状。
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v3/repos/vercel-labs/skills/git/trees/aaa1111$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "sha": "aaa1111",
            "truncated": false,
            "tree": [
                {"path": "skills", "type": "tree"},
                {"path": format!("skills/{DIR_SLUG}"), "type": "tree"},
                {"path": format!("skills/{DIR_SLUG}/SKILL.md"), "type": "blob"},
            ]
        })))
        .mount(&server)
        .await;
    // skills.sh blob:按 skillId 取得到内容(实测两个键都 200、内容相同),
    // 所以**光靠 blob 自己发现不了这个坑**——挡住它的必须是仓库树。
    let skillssh = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(format!(r"^/api/download/vercel-labs/skills/{SKILLS_SH_ID}$")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "files": [{
                "path": "SKILL.md",
                "contents": format!("---\nname: {SKILLS_SH_ID}\ndescription: React 性能优化指南\n---\n\n正文\n")
            }]
        })))
        .mount(&skillssh)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv { home: home.clone() };
    let store = Store::new(home.join(".skillsync"));
    let agent_registry = AgentRegistry::builtin();
    let http = reqwest::Client::builder().user_agent("SkillSync/test").build().unwrap();
    let client = GithubClient::new(&server.uri(), None, http.clone());
    let repo = skillsync_lib::core::gitea::RepoRef {
        owner: "vercel-labs".into(),
        repo: "skills".into(),
        branch: "main".into(),
    };

    // ---- 1. 详情:blob 快路径必须拒绝(树里没有叫 skillId 的目录)----
    let head = skillsync_lib::core::gitea::RepoSource::branch_head(&client, &repo).await.unwrap();
    let tree = client.tree(&repo, &head.sha).await.unwrap();
    let blob_attempt = skillsync_lib::core::plaza::fetch_skill_detail_via_blob(
        &repo,
        &http,
        &skillssh.uri(),
        &format!("vercel-labs/skills/{SKILLS_SH_ID}"),
        SKILLS_SH_ID,
        &head,
        &tree,
    )
    .await;
    let err = blob_attempt.expect_err("skillId 不是仓内目录名时 blob 快路径必须拒绝");
    assert_eq!(err.code, "NET_PLAZA_BLOB");

    // ---- 2. 回退整仓路径:dir_slug 必须是仓内真实目录名 ----
    let details = skillsync_lib::core::plaza::fetch_repo_skills(&client, &repo).await.unwrap();
    // 前端 `locatePlazaSkill` 就是按**技能名**在结果里定位的(M9 任务 5 的既有行为)。
    let detail = details
        .iter()
        .find(|d| d.name == SKILLS_SH_ID)
        .expect("按技能名应当定位得到");
    assert_eq!(detail.dir_slug, DIR_SLUG, "dir_slug 必须是仓内目录名");
    assert_ne!(detail.dir_slug, SKILLS_SH_ID, "绝不能把 skills.sh 的 skillId 当成安装键");

    // ---- 3. 拿这个 dir_slug 去装:必须成功(修复前这里是 REPO_NOT_FOUND)----
    let outcome = acquire::acquire(
        &client,
        &agent_registry,
        &env,
        &store,
        AcquireRequest {
            source: acquire::SourceMeta {
                registry_id: PLAZA_REGISTRY_ID,
                kind: "github",
                base_url: "https://github.com",
            },
            repo: &repo,
            dir_slug: &detail.dir_slug,
            agent_names: &[],
            resolution: None,
        },
        NOW,
        1_755_000_000,
        &|_: Stage| {},
    )
    .await
    .expect("按仓内目录名安装必须成功");
    assert!(
        matches!(outcome, acquire::AcquireOutcome::Installed { .. }),
        "全新安装不该撞冲突: {outcome:?}"
    );

    // ---- 4. 落盘/记账/lock 三处的键都必须是仓内目录名 ----
    assert!(
        home.join(".agents").join("skills").join(DIR_SLUG).join("SKILL.md").exists(),
        "canonical 目录名必须是仓内目录名"
    );
    assert!(
        !home.join(".agents").join("skills").join(SKILLS_SH_ID).exists(),
        "绝不该出现以 skills.sh skillId 命名的目录"
    );
    let st = store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1);
    assert_eq!(st.installed[0].name, DIR_SLUG, "记账键(= 目录名)必须是仓内目录名");
    assert_eq!(st.installed[0].source.path, format!("skills/{DIR_SLUG}"));
    let lock: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(home.join(".agents").join(".skill-lock.json")).unwrap(),
    )
    .unwrap();
    assert!(lock["skills"][DIR_SLUG].is_object(), "lock 键必须是仓内目录名");
    assert!(lock["skills"][SKILLS_SH_ID].is_null(), "lock 里不该出现 skills.sh 的 skillId");
}
