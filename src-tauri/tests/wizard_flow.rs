//! 首次启动向导的 core 部分:curated 精选解析 + 批量获取。
//!
//! 批量的断言重点:①一次下载服务多个技能(数请求)②冲突一律跳过且**磁盘一字不动**
//! ——向导面向全新环境,真撞上旧内容时,静默覆盖比装不上危险得多。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire::{self, BatchOutcome};
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::state::Store;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: &str = "2026-07-31T12:00:00.000Z";
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

struct Ctx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    registry: AgentRegistry,
    store: Store,
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = Store::new(home.join(".skillsync"));
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
        },
        env,
    )
}

/// 造一个含 N 个技能 + 可选 curated.json 的压缩包。
fn zip_repo(skills: &[(&str, &str)], curated: Option<&str>) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default();
        for (slug, name) in skills {
            zip.start_file(format!("repo/skills/{slug}/SKILL.md"), opts).unwrap();
            zip.write_all(
                format!("---\nname: {name}\ndescription: {name} 的说明\n---\n正文\n").as_bytes(),
            )
            .unwrap();
        }
        if let Some(json) = curated {
            zip.start_file("repo/curated.json", opts).unwrap();
            zip.write_all(json.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

async fn mount(server: &MockServer, sha: &str, zip: Vec<u8>) {
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "commit": { "id": sha, "timestamp": "2026-07-31T08:00:00Z" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v1/repos/skills/skills/archive/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip))
        .mount(server)
        .await;
}

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

async fn run_batch(
    server: &MockServer,
    c: &Ctx,
    env: &TmpEnv,
    slugs: &[&str],
) -> Vec<acquire::BatchItem> {
    let client = GiteaClient::new(server.uri(), None).unwrap();
    let slugs: Vec<String> = slugs.iter().map(|s| s.to_string()).collect();
    acquire::acquire_batch(
        &client,
        &c.registry,
        env,
        &c.store,
        REGISTRY,
        &repo_ref(),
        &slugs,
        &["claude-code".to_string()],
        NOW,
        1_753_900_000,
    )
    .await
    .unwrap()
}

// ============================================================ curated 解析

#[test]
fn curated_json_lands_in_the_index_and_maps_to_dir_slugs() {
    let zip = zip_repo(
        &[("weekly-report", "周报生成"), ("contract-review", "合同审查助手")],
        Some(r#"{ "curated": ["周报生成", "合同审查助手", "库里没有的"] }"#),
    );
    let archive = skillsync_lib::core::gitea::unzip_archive(&zip).unwrap();
    let head = skillsync_lib::core::gitea::BranchHead {
        sha: "aaa".into(),
        committed_at: "t".into(),
    };
    let index = skillsync_lib::core::store::build_index(REGISTRY, &repo_ref(), &head, &archive, 0);

    assert_eq!(index.curated, vec!["周报生成", "合同审查助手", "库里没有的"]);
    // view 层按 name 匹配成 dirSlug;对不上的直接丢——摆一个装不上的精选就是撒谎
    let view = index.to_view(false, false);
    assert_eq!(view.curated, vec!["weekly-report", "contract-review"]);
}

#[test]
fn a_missing_or_broken_curated_file_just_means_no_curation() {
    let head = skillsync_lib::core::gitea::BranchHead {
        sha: "aaa".into(),
        committed_at: "t".into(),
    };
    // 没有 curated.json
    let archive =
        skillsync_lib::core::gitea::unzip_archive(&zip_repo(&[("a", "甲")], None)).unwrap();
    let index = skillsync_lib::core::store::build_index(REGISTRY, &repo_ref(), &head, &archive, 0);
    assert!(index.curated.is_empty());
    // 坏 JSON:忽略,不拉挂索引
    let archive =
        skillsync_lib::core::gitea::unzip_archive(&zip_repo(&[("a", "甲")], Some("{oops"))).unwrap();
    let index = skillsync_lib::core::store::build_index(REGISTRY, &repo_ref(), &head, &archive, 0);
    assert!(index.curated.is_empty());
    assert_eq!(index.skills.len(), 1, "坏的 curated.json 不该影响技能发现");
}

// ============================================================ 批量获取

#[tokio::test]
async fn batch_installs_many_with_a_single_download() {
    let (c, env) = ctx();
    let server = MockServer::start().await;
    mount(
        &server,
        "aaa1111",
        zip_repo(&[("weekly-report", "周报生成"), ("contract-review", "合同审查")], None),
    )
    .await;

    let results = run_batch(&server, &c, &env, &["weekly-report", "contract-review"]).await;

    assert!(results
        .iter()
        .all(|r| matches!(r.outcome, BatchOutcome::Installed { .. })), "{results:?}");
    // 两个技能都真的落了盘、建了链、记了账
    for slug in ["weekly-report", "contract-review"] {
        assert!(c.home.join(".agents/skills").join(slug).join("SKILL.md").is_file());
        assert!(c.home.join(".claude/skills").join(slug).exists());
    }
    let state = c.store.load_state().unwrap().value;
    assert_eq!(state.installed.len(), 2);
    assert!(state.installed.iter().all(|s| s.commit_sha == "aaa1111"));
    // 关键:压缩包只下载了一次
    let downloads = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.url.path().contains("/archive/"))
        .count();
    assert_eq!(downloads, 1, "批量安装不该逐个重新下载");
}

#[tokio::test]
async fn batch_skips_modified_and_foreign_without_touching_disk() {
    let (c, env) = ctx();
    let server = MockServer::start().await;
    mount(
        &server,
        "aaa1111",
        zip_repo(&[("weekly-report", "周报生成"), ("hand-made", "手搓的")], None),
    )
    .await;

    // weekly-report:先装好再改——LocallyModified
    run_batch(&server, &c, &env, &["weekly-report"]).await;
    let modified = c.home.join(".agents/skills/weekly-report/SKILL.md");
    std::fs::write(&modified, "我的改动\n").unwrap();
    let mine = std::fs::read(&modified).unwrap();
    // hand-made:不在记账里的实体目录——Foreign
    let foreign = c.home.join(".agents/skills/hand-made");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(foreign.join("SKILL.md"), "别人放的\n").unwrap();
    let theirs = std::fs::read(foreign.join("SKILL.md")).unwrap();

    let results = run_batch(&server, &c, &env, &["weekly-report", "hand-made"]).await;

    for r in &results {
        assert!(
            matches!(&r.outcome, BatchOutcome::Skipped { reason } if !reason.is_empty()),
            "该跳过的没跳过: {r:?}"
        );
    }
    // 真正的守卫断言:两处的字节都原封不动
    assert_eq!(std::fs::read(&modified).unwrap(), mine, "用户改动被批量安装抹了");
    assert_eq!(std::fs::read(foreign.join("SKILL.md")).unwrap(), theirs, "外来目录被批量安装动了");
}

#[tokio::test]
async fn batch_reports_unknown_slugs_without_failing_the_rest() {
    let (c, env) = ctx();
    let server = MockServer::start().await;
    mount(&server, "aaa1111", zip_repo(&[("weekly-report", "周报生成")], None)).await;

    let results = run_batch(&server, &c, &env, &["weekly-report", "vanished"]).await;

    assert!(matches!(results[0].outcome, BatchOutcome::Installed { .. }));
    assert!(
        matches!(&results[1].outcome, BatchOutcome::Skipped { reason } if reason.contains("不在")),
        "{:?}",
        results[1]
    );
    // 好的那个照常装上
    assert!(c.home.join(".agents/skills/weekly-report/SKILL.md").is_file());
}

#[tokio::test]
async fn batch_skips_up_to_date_skills_instead_of_reinstalling() {
    let (c, env) = ctx();
    let server = MockServer::start().await;
    mount(&server, "aaa1111", zip_repo(&[("weekly-report", "周报生成")], None)).await;

    run_batch(&server, &c, &env, &["weekly-report"]).await;
    let results = run_batch(&server, &c, &env, &["weekly-report"]).await;

    assert!(
        matches!(&results[0].outcome, BatchOutcome::Skipped { reason } if reason.contains("最新")),
        "{:?}",
        results[0]
    );
}
