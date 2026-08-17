//! `core::plaza::fetch_skill_detail_via_blob`(M10 任务 2)的集成测试。
//!
//! 与 `tests/plaza_blob.rs`(取数原语)、`tests/plaza_detail.rs`(整仓 zipball 路径)
//! 是三个不同层次:这里测的是"给一个技能拼详情"这一步,`branch_head` 走一个 wiremock
//! GitHub 桩(与 `plaza_detail.rs::mount_branch` 同款路径形状),blob 内容走另一个
//! wiremock skills.sh 桩——两个假来源都不碰真实网络。
//!
//! `commands::plaza_detail_for_client` 的"blob 失败即静默回退 zipball"编排是私有函数,
//! 覆盖在 `commands.rs` 自己的 `#[cfg(test)] mod tests` 里(与该文件既有纪律一致:
//! 依赖 `app_store()`/私有状态的薄壳不挪到外部测试文件);这里只测
//! `fetch_skill_detail_via_blob` 本身"该在什么条件下返回 Err、返回 Err 时**不该**
//! 产生副作用"——它是决定"要不要回退"的唯一判据来源。

use skillsync_lib::core::gitea::RepoRef;
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::plaza;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn http() -> reqwest::Client {
    reqwest::Client::builder().user_agent("SkillSync/test").build().unwrap()
}

fn repo() -> RepoRef {
    RepoRef { owner: "vercel-labs".into(), repo: "skills".into(), branch: "main".into() }
}

async fn mount_branch(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/vercel-labs/skills/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "sha": "aaa1111", "commit": { "committer": { "date": "2026-08-12T10:00:00Z" } } }
        })))
        .mount(server)
        .await;
}

fn skill_md(name: &str, description: &str) -> String {
    format!("---\nname: {name}\ndescription: {description}\n---\n\n正文内容\n")
}

async fn mount_blob(server: &MockServer, slug: &str, status: u16, body: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path(format!("/api/download/vercel-labs/skills/{slug}")))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(server)
        .await;
}

// ---------------------------------------------------------------- 1. 成功路径

#[tokio::test]
async fn builds_a_skill_detail_from_the_blob_snapshot_when_the_name_matches() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({
            "files": [
                {"path": "SKILL.md", "contents": skill_md("weekly-report", "汇总本周工作")},
                {"path": "scripts/collect.py", "contents": "print('hi')"},
            ]
        }),
    )
    .await;

    let client = GithubClient::new(&github.uri(), None, http());
    let detail = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect("blob 命中且名字对得上应当成功");

    assert_eq!(detail.name, "weekly-report");
    assert_eq!(detail.dir_slug, "weekly-report");
    assert_eq!(detail.description, "汇总本周工作");
    assert!(detail.skill_md.contains("汇总本周工作"));
    assert_eq!(detail.commit_sha, "aaa1111", "commit_sha 必须来自 branch_head,不是空串");
    assert_eq!(detail.committed_at, "2026-08-12T10:00:00Z");
    assert_eq!(detail.files.len(), 2);
    assert!(detail.has_scripts, "含 .py 文件应判定为含可执行脚本");
    assert!(detail.tags.is_empty(), "blob 拿不到 tags.json,须是空,不是编造");
    assert!(detail.attribution.is_none(), "blob 拿不到 authors.json,须是 None,不是编造");
}

// ---------------------------------------------------------------- 2. 名字对不上 → 必须 Err(回退的唯一判据)

#[tokio::test]
async fn returns_err_when_the_blob_skill_name_does_not_match_the_clicked_card() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({
            "files": [{"path": "SKILL.md", "contents": skill_md("完全不同的名字", "汇总本周工作")}]
        }),
    )
    .await;

    let client = GithubClient::new(&github.uri(), None, http());
    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("名字对不上必须是 Err,调用方据此回退到能显示完整候选列表的 zipball 路径");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 3. internal 技能 → Err

#[tokio::test]
async fn returns_err_for_a_skill_marked_internal() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({
            "files": [{
                "path": "SKILL.md",
                "contents": "---\nname: weekly-report\ndescription: 汇总本周工作\nmetadata:\n  internal: true\n---\n\n正文\n"
            }]
        }),
    )
    .await;

    let client = GithubClient::new(&github.uri(), None, http());
    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("internal 技能必须回退,与 zipball 路径 discover_skills 默认排除 internal 的既有行为对齐");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 4. 缺 SKILL.md → Err

#[tokio::test]
async fn returns_err_when_the_blob_response_has_no_skill_md() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({"files": [{"path": "references/foo.md", "contents": "不是 SKILL.md"}]}),
    )
    .await;

    let client = GithubClient::new(&github.uri(), None, http());
    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("没有 SKILL.md 应当报错而不是拼一份内容缺失的详情");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 5. frontmatter 解析失败 → Err

#[tokio::test]
async fn returns_err_when_frontmatter_parsing_fails() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({"files": [{"path": "SKILL.md", "contents": "没有 frontmatter 的正文"}]}),
    )
    .await;

    let client = GithubClient::new(&github.uri(), None, http());
    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("frontmatter 解析失败应当报错");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 6. blob 404 → Err

#[tokio::test]
async fn returns_err_when_the_blob_endpoint_404s() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    mount_blob(&skillssh, "weekly-report", 404, serde_json::json!({"error": "not found"})).await;

    let client = GithubClient::new(&github.uri(), None, http());
    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("404 应当映射成 Err");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 7. id 形状不对 → 不发 blob 请求就直接 Err

#[tokio::test]
async fn returns_err_without_a_network_call_when_the_id_shape_does_not_match_owner_repo() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    // 不挂任何 /api/download 桩;如果实现在这种情况下仍然发了 blob 请求,
    // wiremock 默认 404 会让下面的 expect_err 恰好也通过,所以额外用 `.expect(0)`
    // 断言"零命中"——这才是这条测试真正要钉住的事实。
    Mock::given(method("GET"))
        .and(path("/api/download/vercel-labs/skills/weekly-report"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"files": []})))
        .expect(0)
        .mount(&skillssh)
        .await;

    let client = GithubClient::new(&github.uri(), None, http());
    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        // owner/repo 前缀对不上(另一个仓的 id),不应该发出任何 blob 请求
        "someone-else/other-repo/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("id 形状不对应当直接拒绝");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

/// 与上一条同一个判据的另一半:owner/repo 前缀对了,但剩下的部分**还带一层 `/`**
/// (不是模块头说的"纯技能名")。上游约定 `id` 恰好三段式,多一段大概率是拼错了
/// (比如误传了仓内完整路径),保守起见同样直接拒绝、不猜、不发请求。
#[tokio::test]
async fn returns_err_without_a_network_call_when_the_id_has_an_extra_path_segment() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    mount_branch(&github).await;
    Mock::given(method("GET"))
        .and(path("/api/download/vercel-labs/skills/skills/weekly-report"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"files": []})))
        .expect(0)
        .mount(&skillssh)
        .await;

    let client = GithubClient::new(&github.uri(), None, http());
    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        // owner/repo 前缀对得上,但剩下的 "skills/weekly-report" 还带一层 `/`
        "vercel-labs/skills/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("id 剩余部分带多余的 / 应当直接拒绝");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 8. branch_head 失败 → 透传 Err

#[tokio::test]
async fn surfaces_a_branch_head_failure_instead_of_swallowing_it() {
    let github = MockServer::start().await;
    let skillssh = MockServer::start().await;
    // 故意不挂分支桩,branch_head 会拿到默认 404。
    let client = GithubClient::new(&github.uri(), None, http());

    let err = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
    )
    .await
    .expect_err("branch_head 失败必须透出,不能吞掉");

    assert_eq!(err.code, "REPO_NOT_FOUND");
}

// ---------------------------------------------------------------- 9. DoD 头号项:真机耗时对比

/// **DoD 头号项**:同一个技能(brief 点名的原始样本 `wshobson/agents` /
/// `code-review-excellence`)分别走改造前(zipball 全仓)与改造后(blob 单技能)两条路径,
/// 本机真跑真实网络,打印耗时对比——不是估算。
///
/// 走真实外网,**默认跳过**,门控与 `plaza_blob_live.rs`/`plaza_live.rs` 完全一致(同一个
/// `SKILLSYNC_PLAZA_LIVE` 开关):
/// `SKILLSYNC_PLAZA_LIVE=1 cargo test --test plaza_detail_blob -- --nocapture` 手动跑。
#[tokio::test]
async fn detail_via_blob_is_dramatically_faster_than_the_old_zipball_path_for_the_same_skill() {
    if std::env::var("SKILLSYNC_PLAZA_LIVE").as_deref() != Ok("1") {
        eprintln!("跳过:设 SKILLSYNC_PLAZA_LIVE=1 才对真实 skills.sh/github.com 跑");
        return;
    }

    let http = skillsync_lib::core::gitea::app_http_client_proxied().expect("构造代理 client 失败");
    let owner = "wshobson";
    let repo_name = "agents";
    let slug = "code-review-excellence";

    // 改造前:M9 的详情路径(fetch_repo_skills = branch_head + 整仓 zipball + 全仓发现)。
    let branch = plaza::default_branch(&http, plaza::PLAZA_GITHUB_API_BASE, owner, repo_name)
        .await
        .expect("探测默认分支失败");
    let repo_ref = RepoRef { owner: owner.into(), repo: repo_name.into(), branch };
    let client = GithubClient::new("https://github.com", None, http.clone());

    let before_start = std::time::Instant::now();
    let before = plaza::fetch_repo_skills(&client, &repo_ref).await.expect("zipball 路径应当成功");
    let before_elapsed = before_start.elapsed();
    let before_detail = before
        .iter()
        .find(|d| d.dir_slug == slug)
        .unwrap_or_else(|| panic!("zipball 路径应发现到 {slug}"));

    // 改造后:M10 任务 2 的 blob 快路径。
    let after_start = std::time::Instant::now();
    let after = plaza::fetch_skill_detail_via_blob(
        &client,
        &repo_ref,
        &http,
        plaza::PLAZA_API_BASE,
        &format!("{owner}/{repo_name}/{slug}"),
        &before_detail.name,
    )
    .await
    .expect("blob 快路径应当成功");
    let after_elapsed = after_start.elapsed();

    eprintln!("\n[live] === M10 任务 2 详情耗时对比(同一技能 {owner}/{repo_name}/{slug}) ===");
    eprintln!(
        "[live] 改造前(zipball 全仓): {:.2}s,发现 {} 个技能",
        before_elapsed.as_secs_f64(),
        before.len()
    );
    eprintln!(
        "[live] 改造后(blob 单技能): {:.2}s,{} 个文件",
        after_elapsed.as_secs_f64(),
        after.files.len()
    );
    eprintln!(
        "[live] 提速倍数: {:.1}x",
        before_elapsed.as_secs_f64() / after_elapsed.as_secs_f64().max(0.001)
    );

    assert_eq!(after.name, before_detail.name);
    assert_eq!(after.description, before_detail.description);
    assert!(
        after_elapsed < before_elapsed,
        "blob 路径必须比 zipball 路径快(改造前 {before_elapsed:?},改造后 {after_elapsed:?})"
    );
    assert!(
        after_elapsed.as_secs_f64() < 2.0,
        "DoD:改造后必须落在 1 秒级(实测 {after_elapsed:?})"
    );
}
