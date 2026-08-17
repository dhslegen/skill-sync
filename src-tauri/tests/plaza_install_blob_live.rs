//! 安装走 blob(M10 任务 3)的真机耗时对比,DoD 头号项。
//!
//! 与 `tests/plaza_detail_blob.rs::detail_via_blob_is_dramatically_faster_...`
//! 同一套姿势(同一个旗舰样本 `wshobson/agents`/`code-review-excellence`,同款
//! `SKILLSYNC_PLAZA_LIVE` 门控),但比的是**安装**要用到的那几步,不是详情:
//!
//! - 改造前(zipball):`branch_head` + `download_archive`(整仓);
//! - 改造后(blob):`branch_head` + `fetch_blob`(单技能内容)+
//!   `GithubClient::tree`(解仓内真实路径,任务 3 新增的那一步——这是详情路径
//!   没有的成本,path 缺口的解法本身要花时间,数字必须把它算进去,不能只比
//!   "取内容"这一半)。
//!
//! `commands::install_via_plaza_blob` 本身是私有函数(编排 + 缓存,覆盖在
//! `commands.rs` 自己的 `#[cfg(test)] mod tests` 里),这里只用公开原语
//! (`plaza::fetch_blob`、`GithubClient::tree`、`github::resolve_skill_path`)
//! 复现同一套调用顺序——序列化取数才是耗时的真正来源,候选检查/payload 拼装
//! 都是内存字符串操作,量级可忽略。

use skillsync_lib::core::gitea::RepoRef;
use skillsync_lib::core::github::{self, GithubClient};
use skillsync_lib::core::plaza;

fn live_enabled() -> bool {
    if std::env::var("SKILLSYNC_PLAZA_LIVE").as_deref() == Ok("1") {
        true
    } else {
        eprintln!("跳过:设 SKILLSYNC_PLAZA_LIVE=1 才对真实 skills.sh/github.com 跑");
        false
    }
}

#[tokio::test]
async fn install_via_blob_is_dramatically_faster_than_the_old_zipball_path_for_the_same_skill() {
    if !live_enabled() {
        return;
    }

    let http = skillsync_lib::core::gitea::app_http_client_proxied().expect("构造代理 client 失败");
    let owner = "wshobson";
    let repo_name = "agents";
    let slug = "code-review-excellence";

    let branch = plaza::default_branch(&http, plaza::PLAZA_GITHUB_API_BASE, owner, repo_name)
        .await
        .expect("探测默认分支失败");
    let repo = RepoRef { owner: owner.into(), repo: repo_name.into(), branch };
    let client = GithubClient::new("https://github.com", None, http.clone());

    // 改造前:M9 的安装取数路径(branch_head + 整仓 zipball)。
    let before_start = std::time::Instant::now();
    let head_before = client.branch_head(&repo).await.expect("branch_head 应当成功");
    let archive = client.download_archive(&repo).await.expect("zipball 下载应当成功");
    let before_elapsed = before_start.elapsed();

    // 改造后:M10 任务 3 的 blob 快路径(与 `install_via_plaza_blob` 同一套调用顺序:
    // branch_head → fetch_blob → tree)。
    let after_start = std::time::Instant::now();
    let head_after = client.branch_head(&repo).await.expect("branch_head 应当成功");
    let files = plaza::fetch_blob(&http, plaza::PLAZA_API_BASE, owner, repo_name, slug)
        .await
        .expect("blob 取数应当成功");
    let tree = client
        .tree(&repo, &head_after.sha)
        .await
        .expect("git trees 应当成功");
    let resolved_path =
        github::resolve_skill_path(&tree, slug).expect("应当能从真实仓库树中唯一定位到这个技能");
    let after_elapsed = after_start.elapsed();

    eprintln!("\n[live] === M10 任务 3 安装取数耗时对比(同一技能 {owner}/{repo_name}/{slug}) ===");
    eprintln!(
        "[live] 改造前(zipball 全仓): {:.2}s,压缩包 {} 个条目",
        before_elapsed.as_secs_f64(),
        archive.entries.len()
    );
    eprintln!(
        "[live] 改造后(blob + trees): {:.2}s,blob {} 个文件,树 {} 条路径(truncated={})",
        after_elapsed.as_secs_f64(),
        files.len(),
        tree.paths.len(),
        tree.truncated
    );
    eprintln!(
        "[live] 提速倍数: {:.1}x",
        before_elapsed.as_secs_f64() / after_elapsed.as_secs_f64().max(0.001)
    );
    eprintln!("[live] 解出的仓内真实路径: {resolved_path}");

    assert_eq!(head_before.sha, head_after.sha, "两次 branch_head 应指向同一个 commit(短时间内连续请求)");
    assert_eq!(
        resolved_path, "plugins/developer-essentials/skills/code-review-excellence",
        "与任务 1/2 记录的旗舰样本真实路径一致,sanity check"
    );
    assert!(
        after_elapsed < before_elapsed,
        "blob+trees 路径必须比 zipball 路径快(改造前 {before_elapsed:?},改造后 {after_elapsed:?})"
    );
}
