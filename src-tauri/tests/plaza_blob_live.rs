//! **DoD 头号项**:blob 快照与 zipball 里同一技能的同名文件是否逐字节相同(M10 任务 1)。
//!
//! 商店索引的 `content_hash` 是从 zipball 算的(`store::remote_content_hash`)。
//! 若将来安装改走 blob(任务 3),而 blob 落盘的字节与 zipball 有哪怕一字节差,
//! `fsops::dir_content_hash` 就会与索引里的值对不上——**界面会永远误报"有更新"**
//! (CLAUDE.md 记载过这个坑,比没有这个功能更糟)。这条测试就是那道地基检查。
//!
//! 走真实外网,**默认跳过**,门控与 `plaza_live.rs` 完全一致(同一个
//! `SKILLSYNC_PLAZA_LIVE` 开关——这是同一个外部依赖 skills.sh/github.com 的两个侧面,
//! 拆成两个环境变量没有意义):
//! `SKILLSYNC_PLAZA_LIVE=1 cargo test --test plaza_blob_live -- --nocapture` 手动跑。
//!
//! # 样本选择(2026-08-17 实测,覆盖 brief 点名的三种场景)
//!
//! | # | owner/repo | slug | 场景 |
//! |---|---|---|---|
//! | 1 | `wshobson/agents` | `code-review-excellence` | 单文件纯 md(brief 给的原始样本,13225 B) |
//! | 2 | `jnmetacode/superpowers-zh` | `using-superpowers` | 多文件带子目录(`references/` 下 7 个文件) |
//! | 3 | `jnmetacode/superpowers-zh` | `chinese-code-review` | 单文件、大段中文(字符数≠字节数) |
//!
//! 技能在仓内的真实目录路径**不硬编码**:与生产代码同一条发现路径
//! (`store::build_index` 解析 zipball 的 tree),按 `dir_slug` 找到 `IndexedSkill.path`
//! 再去 `archive.entries` 里取对应前缀的文件——这与 `wshobson/agents` 把技能放在
//! `plugins/developer-essentials/skills/` 这种非顶层布局无关,靠的是发现规则而不是
//! 猜路径,和真实安装路径会走的发现逻辑完全一致。

use skillsync_lib::core::gitea::{self, RepoRef};
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::plaza;
use skillsync_lib::core::store;

fn live_enabled() -> bool {
    if std::env::var("SKILLSYNC_PLAZA_LIVE").as_deref() == Ok("1") {
        true
    } else {
        eprintln!("跳过:设 SKILLSYNC_PLAZA_LIVE=1 才对真实 skills.sh/github.com 跑");
        false
    }
}

/// 一个样本的比对结果,供最后统一打印成报告用的表格。
struct SampleResult {
    label: &'static str,
    file_count: usize,
    total_bytes: usize,
    all_equal: bool,
}

/// 对一个 (owner, repo, slug) 样本:分别取 blob 与 zipball,断言同名文件逐字节相等、
/// 文件集合一致。**任一不等就 panic**——这条测试的存在意义就是当那件事发生时立刻炸掉,
/// 不允许"先做着看"。
async fn assert_blob_matches_zipball(
    http: &reqwest::Client,
    owner: &str,
    repo: &str,
    slug: &str,
    label: &'static str,
) -> SampleResult {
    // 1. blob 快照
    let blob_files = plaza::fetch_blob(http, plaza::PLAZA_API_BASE, owner, repo, slug)
        .await
        .unwrap_or_else(|e| panic!("[{label}] 获取 blob 失败: {e}"));
    assert!(!blob_files.is_empty(), "[{label}] blob 应至少含一个文件");

    // 2. zipball(与生产代码同一条发现路径:branch_head + download_archive + build_index)
    let branch = plaza::default_branch(http, plaza::PLAZA_GITHUB_API_BASE, owner, repo)
        .await
        .unwrap_or_else(|e| panic!("[{label}] 探测默认分支失败: {e}"));
    let client = GithubClient::new("https://github.com", None, http.clone());
    let repo_ref = RepoRef { owner: owner.into(), repo: repo.into(), branch };
    let head = client
        .branch_head(&repo_ref)
        .await
        .unwrap_or_else(|e| panic!("[{label}] 取 branch_head 失败: {e}"));
    let archive = client
        .download_archive(&repo_ref)
        .await
        .unwrap_or_else(|e| panic!("[{label}] 下载 zipball 失败: {e}"));
    let index = store::build_index(skillsync_lib::core::registry::PLAZA_REGISTRY_ID, &repo_ref, &head, &archive, 0);
    let skill = index
        .skills
        .iter()
        .find(|s| s.dir_slug == slug)
        .unwrap_or_else(|| panic!("[{label}] zipball 里没发现到技能目录 {slug}(实际发现: {:?})", index.skills.iter().map(|s| &s.dir_slug).collect::<Vec<_>>()));
    let dir_prefix = format!("{}/{}/", archive.root, skill.path);

    let mut zip_files: std::collections::BTreeMap<String, &[u8]> = std::collections::BTreeMap::new();
    for (full, entry) in &archive.entries {
        if let Some(rel) = full.strip_prefix(dir_prefix.as_str()) {
            if !rel.is_empty() {
                zip_files.insert(rel.to_string(), entry.bytes.as_slice());
            }
        }
    }

    // 3. 逐个断言:路径集合一致 + 每个文件逐字节相等
    let blob_paths: std::collections::BTreeSet<&str> = blob_files.iter().map(|f| f.path.as_str()).collect();
    let zip_paths: std::collections::BTreeSet<&str> = zip_files.keys().map(|s| s.as_str()).collect();
    assert_eq!(
        blob_paths, zip_paths,
        "[{label}] blob 与 zipball 的文件集合不一致(blob 独有: {:?},zipball 独有: {:?})",
        blob_paths.difference(&zip_paths).collect::<Vec<_>>(),
        zip_paths.difference(&blob_paths).collect::<Vec<_>>()
    );

    let mut total_bytes = 0usize;
    let mut all_equal = true;
    for f in &blob_files {
        let blob_bytes = f.contents.as_bytes();
        let zip_bytes = *zip_files.get(f.path.as_str()).unwrap_or_else(|| panic!("[{label}] {} 应存在于 zip", f.path));
        let equal = blob_bytes == zip_bytes;
        eprintln!(
            "[live][{label}] {}: blob={}B zip={}B equal={}",
            f.path,
            blob_bytes.len(),
            zip_bytes.len(),
            equal
        );
        assert_eq!(
            blob_bytes, zip_bytes,
            "[{label}] {} 的内容不逐字节相等——这会让 dir_content_hash 与索引 content_hash 对不上,\
             界面将永远误报'有更新'。任务 1 到此为止,任务 3(安装走 blob)不成立,必须回来重新拍板。",
            f.path
        );
        total_bytes += blob_bytes.len();
        all_equal &= equal;
    }

    SampleResult { label, file_count: blob_files.len(), total_bytes, all_equal }
}

#[tokio::test]
async fn blob_and_zipball_are_byte_identical_across_three_real_samples() {
    if !live_enabled() {
        return;
    }
    let http = gitea::app_http_client_proxied().expect("构造代理 client 失败");

    let r1 = assert_blob_matches_zipball(
        &http,
        "wshobson",
        "agents",
        "code-review-excellence",
        "①单文件纯md",
    )
    .await;
    let r2 = assert_blob_matches_zipball(
        &http,
        "jnmetacode",
        "superpowers-zh",
        "using-superpowers",
        "②多文件带子目录",
    )
    .await;
    let r3 = assert_blob_matches_zipball(
        &http,
        "jnmetacode",
        "superpowers-zh",
        "chinese-code-review",
        "③中文多字节",
    )
    .await;

    eprintln!("\n[live] === 内容等价性实证汇总 ===");
    for r in [&r1, &r2, &r3] {
        eprintln!(
            "[live] {}: {} 个文件,共 {} 字节,逐字节相等={}",
            r.label, r.file_count, r.total_bytes, r.all_equal
        );
    }
    assert!(r1.all_equal && r2.all_equal && r3.all_equal, "三个样本必须全部逐字节相等");
}
