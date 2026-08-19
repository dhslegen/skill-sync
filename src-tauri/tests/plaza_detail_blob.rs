//! `core::plaza::fetch_skill_detail_via_blob`(M10 任务 2,2026-08-19 终审修复补上
//! 仓库树校验)的集成测试。
//!
//! 与 `tests/plaza_blob.rs`(取数原语)、`tests/plaza_detail.rs`(整仓 zipball 路径)
//! 是三个不同层次:这里测的是"给一个技能拼详情"这一步。`head` 与仓库树由调用方预取
//! (生产里是 `commands::plaza_blob_prefetch`),测试直接构造——这几条用例要钉的是
//! "拿到树之后怎么判",不是"树怎么拉下来";blob 内容走 wiremock skills.sh 桩,
//! 不碰真实网络。
//!
//! 🔴 **fixture 纪律:三个标识必须能取不同值**——skills.sh 的 `skillId`(= SKILL.md
//! frontmatter 的 `name`)、仓内技能目录名(`dir_slug`)、仓内相对路径(`path`)是
//! 三个不同的概念。任务 2 的这份测试原先让前两者恒等(都叫 `weekly-report`)、
//! 第三者退化成目录名,于是"skillId 不是目录名"这个真实缺陷从测试底下穿了过去
//! (CLAUDE.md 记的空转模式 ③:fixture 让两个不同概念取了同值,它们的差别就测没了)。
//! 现在:成功路径的树一律用**嵌套路径**(`plugins/team-pack/skills/<slug>/SKILL.md`,
//! 真实旗舰仓就是这个形状),并正面断言 `path != dir_slug`;
//! "两个标识不同"的场景另有专门用例(`vercel-react-best-practices` vs
//! `react-best-practices`,取自 2026-08-19 的真实实测样本)。
//!
//! `commands::plaza_detail_for_client` 的"blob 失败即静默回退 zipball"编排是私有函数,
//! 覆盖在 `commands.rs` 自己的 `#[cfg(test)] mod tests` 里(与该文件既有纪律一致:
//! 依赖 `app_store()`/私有状态的薄壳不挪到外部测试文件);这里只测
//! `fetch_skill_detail_via_blob` 本身"该在什么条件下返回 Err、返回 Err 时**不该**
//! 产生副作用"——它是决定"要不要回退"的唯一判据来源。

use skillsync_lib::core::gitea::{BranchHead, RepoRef};
use skillsync_lib::core::github::RepoTree;
use skillsync_lib::core::plaza;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn http() -> reqwest::Client {
    reqwest::Client::builder().user_agent("SkillSync/test").build().unwrap()
}

fn repo() -> RepoRef {
    RepoRef { owner: "vercel-labs".into(), repo: "skills".into(), branch: "main".into() }
}

fn head() -> BranchHead {
    BranchHead { sha: "aaa1111".into(), committed_at: "2026-08-12T10:00:00Z".into() }
}

fn tree(paths: &[&str]) -> RepoTree {
    RepoTree { paths: paths.iter().map(|p| (*p).to_string()).collect(), truncated: false }
}

/// 技能目录**故意放在嵌套路径下**(真实旗舰仓就是这个形状,如
/// `plugins/developer-essentials/skills/<slug>`):这样 `dir_slug` 与 `path` 必然不同值。
fn nested_tree(dir_slug: &str) -> RepoTree {
    tree(&[&format!("plugins/team-pack/skills/{dir_slug}/SKILL.md")])
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

/// 挂一个"如果实现真发了 blob 请求就会命中"的桩,并断言**零命中**:
/// 不挂桩的话 wiremock 默认 404 也会让 `expect_err` 恰好通过,分不出"没发请求"
/// 与"发了但被 404 拒了"。
async fn mount_blob_expecting_zero_calls(server: &MockServer, slug: &str) {
    Mock::given(method("GET"))
        .and(path(format!("/api/download/vercel-labs/skills/{slug}")))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "files": [{"path": "SKILL.md", "contents": skill_md(slug, "不该被读到")}]
        })))
        .expect(0)
        .mount(server)
        .await;
}

// ---------------------------------------------------------------- 1. 成功路径

#[tokio::test]
async fn builds_a_skill_detail_from_the_blob_snapshot_when_the_name_matches() {
    let skillssh = MockServer::start().await;
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

    let detail = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
    )
    .await
    .expect("blob 命中且名字对得上应当成功");

    assert_eq!(detail.name, "weekly-report");
    assert_eq!(detail.dir_slug, "weekly-report", "dir_slug 必须是仓内技能目录名(安装键)");
    assert_eq!(
        detail.path, "plugins/team-pack/skills/weekly-report",
        "path 必须是仓库树给出的真实相对路径,不是目录名"
    );
    assert_ne!(detail.path, detail.dir_slug, "两个字段是两个概念,fixture 不许让它们取同值");
    assert_eq!(detail.description, "汇总本周工作");
    assert!(detail.skill_md.contains("汇总本周工作"));
    assert_eq!(detail.commit_sha, "aaa1111", "commit_sha 必须来自调用方给的 head,不是空串");
    assert_eq!(detail.committed_at, "2026-08-12T10:00:00Z");
    assert_eq!(detail.files.len(), 2);
    assert!(detail.has_scripts, "含 .py 文件应判定为含可执行脚本");
    assert!(detail.tags.is_empty(), "blob 拿不到 tags.json,须是空,不是编造");
    assert!(detail.attribution.is_none(), "blob 拿不到 authors.json,须是 None,不是编造");
}

// ---------------------------------------------------------------- 2. 🔴 skillId ≠ 仓内目录名 → Err

/// 2026-08-19 终审修复钉住的那条缺陷,取真实实测样本:
/// `vercel-labs/agent-skills` 的 `skillId = vercel-react-best-practices`,而仓里的
/// 路径是 `skills/react-best-practices/SKILL.md`(该文件 frontmatter `name` 恰好就是
/// `vercel-react-best-practices`,所以**名字闸拦不住**)。
///
/// `dir_slug` 是安装目录名、`state.installed` 记账键与 `.skill-lock.json` 键的唯一
/// 来源,填成 skillId 的后果是「获取」必然报 `REPO_NOT_FOUND`。判据只能是仓库树。
#[tokio::test]
async fn returns_err_when_the_skills_sh_id_is_not_a_repo_directory_name() {
    let skillssh = MockServer::start().await;
    mount_blob_expecting_zero_calls(&skillssh, "vercel-react-best-practices").await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/vercel-react-best-practices",
        "vercel-react-best-practices",
        &head(),
        // 仓里真实的目录名短一截 —— 两个标识必须取不同值
        &nested_tree("react-best-practices"),
    )
    .await
    .expect_err("skillId 在树里找不到同名技能目录时必须 Err,交给调用方回退整仓路径");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

/// 同名目录不止一处 → 绑谁都是猜,一律回退(与安装路径 `resolve_skill_path` 同一判据)。
#[tokio::test]
async fn returns_err_when_two_directories_share_the_same_name() {
    let skillssh = MockServer::start().await;
    mount_blob_expecting_zero_calls(&skillssh, "weekly-report").await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &tree(&[
            "plugins/a/skills/weekly-report/SKILL.md",
            "plugins/b/skills/weekly-report/SKILL.md",
        ]),
    )
    .await
    .expect_err("多个同名目录时不敢猜,必须 Err");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

/// 树被 GitHub 截断 = 这份树不完整、"唯一匹配"不可信,同样回退。
#[tokio::test]
async fn returns_err_when_the_repo_tree_was_truncated() {
    let skillssh = MockServer::start().await;
    mount_blob_expecting_zero_calls(&skillssh, "weekly-report").await;

    let truncated = RepoTree {
        paths: vec!["plugins/team-pack/skills/weekly-report/SKILL.md".into()],
        truncated: true,
    };
    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &truncated,
    )
    .await
    .expect_err("树截断时不可信,必须 Err");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 3. 名字对不上 → 必须 Err(回退的唯一判据)

#[tokio::test]
async fn returns_err_when_the_blob_skill_name_does_not_match_the_clicked_card() {
    let skillssh = MockServer::start().await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({
            "files": [{"path": "SKILL.md", "contents": skill_md("完全不同的名字", "汇总本周工作")}]
        }),
    )
    .await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
    )
    .await
    .expect_err("名字对不上必须是 Err,调用方据此回退到能显示完整候选列表的 zipball 路径");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 4. internal 技能 → Err

#[tokio::test]
async fn returns_err_for_a_skill_marked_internal() {
    let skillssh = MockServer::start().await;
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

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
    )
    .await
    .expect_err("internal 技能必须回退,与 zipball 路径 discover_skills 默认排除 internal 的既有行为对齐");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 5. 缺 SKILL.md → Err

#[tokio::test]
async fn returns_err_when_the_blob_response_has_no_skill_md() {
    let skillssh = MockServer::start().await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({"files": [{"path": "references/foo.md", "contents": "不是 SKILL.md"}]}),
    )
    .await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
    )
    .await
    .expect_err("没有 SKILL.md 应当报错而不是拼一份内容缺失的详情");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 6. frontmatter 解析失败 → Err

#[tokio::test]
async fn returns_err_when_frontmatter_parsing_fails() {
    let skillssh = MockServer::start().await;
    mount_blob(
        &skillssh,
        "weekly-report",
        200,
        serde_json::json!({"files": [{"path": "SKILL.md", "contents": "没有 frontmatter 的正文"}]}),
    )
    .await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
    )
    .await
    .expect_err("frontmatter 解析失败应当报错");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 7. blob 404 → Err

#[tokio::test]
async fn returns_err_when_the_blob_endpoint_404s() {
    let skillssh = MockServer::start().await;
    mount_blob(&skillssh, "weekly-report", 404, serde_json::json!({"error": "not found"})).await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        "vercel-labs/skills/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
    )
    .await
    .expect_err("404 应当映射成 Err");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 8. id 形状不对 → 不发 blob 请求就直接 Err

#[tokio::test]
async fn returns_err_without_a_network_call_when_the_id_shape_does_not_match_owner_repo() {
    let skillssh = MockServer::start().await;
    mount_blob_expecting_zero_calls(&skillssh, "weekly-report").await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        // owner/repo 前缀对不上(另一个仓的 id),不应该发出任何 blob 请求
        "someone-else/other-repo/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
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
    let skillssh = MockServer::start().await;
    mount_blob_expecting_zero_calls(&skillssh, "skills/weekly-report").await;

    let err = plaza::fetch_skill_detail_via_blob(
        &repo(),
        &http(),
        &skillssh.uri(),
        // owner/repo 前缀对得上,但剩下的 "skills/weekly-report" 还带一层 `/`
        "vercel-labs/skills/skills/weekly-report",
        "weekly-report",
        &head(),
        &nested_tree("weekly-report"),
    )
    .await
    .expect_err("id 剩余部分带多余的 / 应当直接拒绝");

    assert_eq!(err.code, "NET_PLAZA_BLOB");
}

// ---------------------------------------------------------------- 9. DoD:真机耗时对比

/// **DoD 头号项**:同一个技能(brief 点名的原始样本 `wshobson/agents` /
/// `code-review-excellence`)分别走改造前(zipball 全仓)与改造后(blob 单技能)两条路径,
/// 本机真跑真实网络,打印耗时对比——不是估算。
///
/// ⚠️ **计时区间必须包含仓库树那次请求**(2026-08-19 终审修复起):树是 blob 快路径
/// 成立的前置条件(把 skills.sh 的 skillId 校验成仓内目录名),把它挪到计时区间外
/// 只会得到一个好看但不诚实的数字。旗舰大仓的树本身就有几百 KB(`wshobson/agents`
/// 实测 614KB),所以这条测试**不再断言"1 秒内"**,只断言"仍显著快于 zipball";
/// 真实数字以 `--nocapture` 打印的为准。
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
    let client = skillsync_lib::core::github::GithubClient::new("https://github.com", None, http.clone());

    let before_start = std::time::Instant::now();
    let before = plaza::fetch_repo_skills(&client, &repo_ref).await.expect("zipball 路径应当成功");
    let before_elapsed = before_start.elapsed();
    let before_detail = before
        .iter()
        .find(|d| d.dir_slug == slug)
        .unwrap_or_else(|| panic!("zipball 路径应发现到 {slug}"));

    // 改造后:blob 快路径。计时从 branch_head 起算,含仓库树那次请求——这才是用户
    // 点开详情时真实要等的全部时间。
    let after_start = std::time::Instant::now();
    let head = skillsync_lib::core::gitea::RepoSource::branch_head(&client, &repo_ref)
        .await
        .expect("branch_head 应当成功");
    let tree = client.tree(&repo_ref, &head.sha).await.expect("仓库树应当拉得到");
    let after = plaza::fetch_skill_detail_via_blob(
        &repo_ref,
        &http,
        plaza::PLAZA_API_BASE,
        &format!("{owner}/{repo_name}/{slug}"),
        &before_detail.name,
        &head,
        &tree,
    )
    .await
    .expect("blob 快路径应当成功");
    let after_elapsed = after_start.elapsed();

    eprintln!("\n[live] === M10 详情耗时对比(同一技能 {owner}/{repo_name}/{slug}) ===");
    eprintln!(
        "[live] 改造前(zipball 全仓): {:.2}s,发现 {} 个技能",
        before_elapsed.as_secs_f64(),
        before.len()
    );
    eprintln!(
        "[live] 改造后(head + 仓库树 + blob): {:.2}s,{} 个文件,树 {} 条目",
        after_elapsed.as_secs_f64(),
        after.files.len(),
        tree.paths.len()
    );
    eprintln!(
        "[live] 提速倍数: {:.1}x",
        before_elapsed.as_secs_f64() / after_elapsed.as_secs_f64().max(0.001)
    );

    assert_eq!(after.name, before_detail.name);
    assert_eq!(after.description, before_detail.description);
    assert_eq!(
        after.dir_slug, before_detail.dir_slug,
        "两条路径的 dir_slug 必须逐字相同——它是安装键"
    );
    assert_eq!(
        after.path, before_detail.path,
        "两条路径的仓内相对路径必须逐字相同"
    );
    assert!(
        after_elapsed < before_elapsed,
        "blob 路径(含树)必须仍比 zipball 路径快(改造前 {before_elapsed:?},改造后 {after_elapsed:?})"
    );
}
