//! 商店索引编排层测试:缓存新鲜度判定、离线降级、以及 DoD 的缓存命中时延。
//!
//! 这里刻意**不抽象网络**,直接对 wiremock 跑真 `GiteaClient`——要验的正是
//! "sha 没变时到底有没有发出下载请求",而这件事只有数请求数才算真验过。
//! 断言写成 `received_requests()` 里的压缩包请求条数,而不是"返回的数据看起来对":
//! 后者在实现退化成"每次都重下"时依然会通过,等于没测。

use std::path::Path;

use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::store::{self, INDEX_SCHEMA_VERSION};
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const REGISTRY: &str = "company";

fn repo_ref() -> RepoRef {
    RepoRef {
        owner: "skills".into(),
        repo: "skills".into(),
        branch: "main".into(),
    }
}

/// 造一个 Gitea 形状的仓库压缩包:顶层目录是**仓库名**(GitHub 才是 `repo-ref`)。
fn zip_with(slugs: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::SimpleFileOptions = Default::default();
        w.add_directory("skills/", opts).unwrap();
        for slug in slugs {
            w.start_file(format!("skills/skills/{slug}/SKILL.md"), opts).unwrap();
            std::io::Write::write_all(
                &mut w,
                format!(
                    "---\nname: {slug}\ndescription: {slug} 的用途说明,一句话讲清楚它能干什么。\n---\n\n\
                     ## 这个技能做什么\n\n正文若干,用来把 SKILL.md 撑到接近真实体积。\n"
                )
                .as_bytes(),
            )
            .unwrap();
        }
        w.finish().unwrap();
    }
    buf
}

fn slugs(n: usize) -> Vec<String> {
    (0..n).map(|i| format!("skill-{i:03}")).collect()
}

async fn mount_branch(server: &MockServer, sha: &str) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": sha, "timestamp": "2026-07-30T10:00:00+08:00" }
        })))
        .mount(server)
        .await;
}

async fn mount_archive(server: &MockServer, slugs: &[String]) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_with(slugs)))
        .mount(server)
        .await;
}

/// 至今为止发往压缩包端点的请求数。缓存是否真的省掉了下载,只能靠这个数字说话。
async fn archive_hits(server: &MockServer) -> usize {
    server
        .received_requests()
        .await
        .expect("wiremock 未记录请求")
        .iter()
        .filter(|r| r.url.path().ends_with("/archive/main.zip"))
        .count()
}

fn client(server: &MockServer) -> GiteaClient {
    // 匿名读:技能库公开可读,商店浏览先于登录
    GiteaClient::new(server.uri(), None).unwrap()
}

async fn refresh(
    server: &MockServer,
    cache: &Path,
    force: bool,
) -> (store::StoreIndex, store::IndexOutcome) {
    store::refresh_index(&client(server), &repo_ref(), REGISTRY, cache, force, 1_753_800_000)
        .await
        .unwrap()
}

#[tokio::test]
async fn first_run_downloads_and_writes_the_cache() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(3)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);

    let (index, outcome) = refresh(&server, &cache, false).await;

    assert_eq!(index.skills.len(), 3);
    assert!(!outcome.from_cache);
    assert!(!outcome.offline);
    assert_eq!(archive_hits(&server).await, 1);
    assert_eq!(store::load_cache(&cache).unwrap().commit_sha, "aaa1111");
}

#[tokio::test]
async fn unchanged_sha_serves_cache_without_downloading_again() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(3)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);

    refresh(&server, &cache, false).await;
    assert_eq!(archive_hits(&server).await, 1, "首次必须下载");

    let (index, outcome) = refresh(&server, &cache, false).await;

    assert!(outcome.from_cache);
    assert!(!outcome.offline);
    assert_eq!(index.skills.len(), 3);
    assert_eq!(
        archive_hits(&server).await,
        1,
        "分支头没变就不该再下载一次压缩包——这条断言是本模块存在的理由"
    );
}

#[tokio::test]
async fn changed_sha_refetches_and_replaces_the_cache() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(2)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    refresh(&server, &cache, false).await;

    // 远端向前走了一版,且多了一个技能
    let server2 = MockServer::start().await;
    mount_branch(&server2, "bbb2222").await;
    mount_archive(&server2, &slugs(5)).await;
    // 换 server 会换端口,但缓存的坐标(owner/repo/branch)不变,仍应命中新鲜度判定
    let (index, outcome) = refresh(&server2, &cache, false).await;

    assert!(!outcome.from_cache, "sha 变了必须重新获取");
    assert_eq!(index.skills.len(), 5);
    assert_eq!(archive_hits(&server2).await, 1);
    assert_eq!(store::load_cache(&cache).unwrap().commit_sha, "bbb2222");
}

#[tokio::test]
async fn force_bypasses_the_freshness_check() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(3)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    refresh(&server, &cache, false).await;

    let (_, outcome) = refresh(&server, &cache, true).await;

    assert!(!outcome.from_cache, "用户手动刷新时即使 sha 相同也要重新获取");
    assert_eq!(archive_hits(&server).await, 2);
}

#[tokio::test]
async fn corrupt_cache_is_refetched_instead_of_failing() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(3)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    std::fs::create_dir_all(tmp.path()).unwrap();
    std::fs::write(&cache, "{\"schemaVersion\":1,\"skills\":截断了").unwrap();

    let (index, outcome) = refresh(&server, &cache, false).await;

    assert_eq!(index.skills.len(), 3, "坏缓存不能拦住商店页");
    assert!(!outcome.from_cache);
    assert_eq!(archive_hits(&server).await, 1);
}

#[tokio::test]
async fn cache_written_by_a_newer_version_is_rebuilt() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(3)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    std::fs::create_dir_all(tmp.path()).unwrap();
    std::fs::write(
        &cache,
        serde_json::json!({
            "schemaVersion": INDEX_SCHEMA_VERSION + 1,
            "registryId": REGISTRY,
            "owner": "skills", "repo": "skills", "branch": "main",
            "commitSha": "aaa1111", "committedAt": "", "fetchedAt": 0,
            "skills": [], "skipped": []
        })
        .to_string(),
    )
    .unwrap();

    let (index, _) = refresh(&server, &cache, false).await;

    // 关键区别于 state.rs:那里更高版本 → 只读锁死;这里 → 丢弃重建
    assert_eq!(index.skills.len(), 3);
    assert_eq!(store::load_cache(&cache).unwrap().schema_version, INDEX_SCHEMA_VERSION);
}

#[tokio::test]
async fn cache_of_a_different_repo_is_ignored() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(3)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    refresh(&server, &cache, false).await;

    // 同一个缓存文件,但这次问的是另一个技能库的同名分支
    let other = RepoRef { owner: "skills".into(), repo: "other".into(), branch: "main".into() };
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/other/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": "aaa1111", "timestamp": "2026-07-30T10:00:00+08:00" }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/other/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_with(&slugs(1))))
        .mount(&server)
        .await;

    let (index, outcome) = store::refresh_index(
        &client(&server), &other, REGISTRY, &cache, false, 1_753_800_000,
    )
    .await
    .unwrap();

    // sha 恰好相同也不能复用:那是另一个技能库的索引
    assert!(!outcome.from_cache, "换了技能库坐标必须重新获取");
    assert_eq!(index.skills.len(), 1);
}

#[tokio::test]
async fn unreachable_registry_serves_the_cache_and_flags_offline() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(4)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    refresh(&server, &cache, false).await;

    // 技能库出故障(5xx 与连不上内网在编排层是同一条 Err 分支)
    let down = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(502))
        .mount(&down)
        .await;

    let (index, outcome) = refresh(&down, &cache, false).await;

    assert!(outcome.offline, "断网时应降级浏览并标记离线,而不是弹错误框");
    assert!(outcome.from_cache);
    assert_eq!(index.skills.len(), 4, "上次取到的内容照样可以浏览");
}

#[tokio::test]
async fn unreachable_registry_without_cache_reports_an_actionable_error() {
    let down = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(502))
        .mount(&down)
        .await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);

    let err = store::refresh_index(
        &client(&down), &repo_ref(), REGISTRY, &cache, false, 0,
    )
    .await
    .unwrap_err();

    assert_eq!(err.code, "NET_SERVER");
    // 文案规范:错误必须给下一步动作
    assert!(err.message.contains("稍后重试"), "{}", err.message);
}

#[tokio::test]
async fn archive_failure_falls_back_to_the_stale_cache() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(4)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    refresh(&server, &cache, false).await;

    // 分支头能拿到(说明远端已经更新了),但压缩包下载失败
    let broken = MockServer::start().await;
    mount_branch(&broken, "ccc3333").await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&broken)
        .await;

    let (index, outcome) = refresh(&broken, &cache, false).await;

    assert!(outcome.offline);
    assert_eq!(index.commit_sha, "aaa1111", "拿不到新版本就继续显示旧版本,并标记为非最新");
    assert_eq!(store::load_cache(&cache).unwrap().commit_sha, "aaa1111", "失败不得污染缓存");
}

/// 缓存命中路径不能退化成"每次重下"。
///
/// **阈值刻意放宽到 1s,而不是 DoD 的 300ms。** 这条断言要进 CI,而 CI 是共享 I/O 的
/// Windows/macOS runner:把 300ms 这个在开发机上量出来的数字钉进去,迟早会在没人改坏任何东西
/// 的情况下变红,而一个会乱叫的性能门会顺带拖垮整套测试的可信度。
///
/// 真正钉住"没有重新下载"的是 [`unchanged_sha_serves_cache_without_downloading_again`]
/// 里的请求条数断言——那个是确定性的。这里只兜住"缓存路径本身慢得离谱"这一类退化
/// (真去下载 + 解压 50 个技能会明显超过 1s)。
/// DoD 的 300ms 由 `tests/store_live.rs` 在受控环境下量,并把实测值记进 commit message。
#[tokio::test]
async fn cache_hit_for_fifty_skills_does_not_silently_redownload() {
    let server = MockServer::start().await;
    mount_branch(&server, "aaa1111").await;
    mount_archive(&server, &slugs(50)).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY);
    let (first, _) = refresh(&server, &cache, false).await;
    assert_eq!(first.skills.len(), 50);

    let started = std::time::Instant::now();
    let (index, outcome) = refresh(&server, &cache, false).await;
    let elapsed = started.elapsed();

    assert!(outcome.from_cache);
    assert_eq!(index.skills.len(), 50);
    assert_eq!(archive_hits(&server).await, 1, "命中缓存就不该再下载一次");
    assert!(
        elapsed < std::time::Duration::from_secs(1),
        "缓存命中耗时 {elapsed:?} —— 这个量级说明它根本没走缓存"
    );
}
