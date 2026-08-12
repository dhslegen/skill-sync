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
