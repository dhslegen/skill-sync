//! 商店索引的 DoD 计时:对着 docker fixture Gitea 量真实的首屏与缓存命中耗时。
//!
//! 需要先 `./fixtures/init.sh`。未起环境时自动跳过(与 gitea_live.rs 同样的约定)。
//!
//! 为什么必须有这一条:`tests/store_index.rs` 里的 300ms 断言跑在 wiremock 上,
//! 量到的是"扣掉网络之后"的开销。首屏 <2s 这个数含一次分支查询 + 一整个压缩包下载 +
//! 50 个技能的解析,只有对真 Gitea 跑才算量过。CI 上不稳定,所以不做成硬性门,
//! 但实测数字要记进 commit message,而不是拍脑袋声称达标。

use std::collections::HashMap;
use std::time::Instant;

use skillsync_lib::core::gitea::{ChangeFilesRequest, FileChange, GiteaClient, RepoRef};
use skillsync_lib::core::store;

/// 专用分支,不碰 main 上其他测试依赖的内容。
const BRANCH: &str = "store-perf-50";
const SKILL_COUNT: usize = 50;

fn fixture_env() -> Option<HashMap<String, String>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("fixtures/.env.local");
    let text = std::fs::read_to_string(path).ok()?;
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    Some(map)
}

fn skill_md(i: usize) -> String {
    format!(
        "---\nname: 性能样例技能 {i:02}\ndescription: \
         这是第 {i} 个用于计时的样例技能,描述长度刻意接近真实技能库里的水平,\
         以免把压缩包造得比实际更小而量出偏乐观的数字。\n---\n\n\
         ## 这个技能做什么\n\n把一批输入整理成结构化输出,并按部门模板排版。\n\n\
         ## 使用方式\n\n在任意已启用的 agent 中说「用性能样例技能 {i:02} 处理这份文档」。\n\n\
         ## 注意\n\n仅用于 fixture 计时,不承载真实业务逻辑。\n"
    )
}

/// 幂等地把 50 个技能灌到专用分支上。已经有了就直接返回。
async fn ensure_fixture(client: &GiteaClient, owner: &str, repo: &str) -> Result<(), String> {
    let target = RepoRef {
        owner: owner.into(),
        repo: repo.into(),
        branch: BRANCH.into(),
    };
    if let Ok(archive) = client.download_archive(&target).await {
        let existing = archive
            .files
            .iter()
            .filter(|f| f.contains("/perf-skill-") && f.ends_with("/SKILL.md"))
            .count();
        if existing >= SKILL_COUNT {
            return Ok(());
        }
    }

    // 分批提交:一次 commit 塞一百多个文件容易撞上服务端的请求体上限
    let mut created_branch = false;
    for chunk in (0..SKILL_COUNT).collect::<Vec<_>>().chunks(10) {
        let mut files = Vec::new();
        for &i in chunk {
            let dir = format!("skills/perf-skill-{i:02}");
            files.push(FileChange::create(
                format!("{dir}/SKILL.md"),
                skill_md(i).as_bytes(),
            ));
            files.push(FileChange::create(
                format!("{dir}/templates/dept.md"),
                b"# \xe9\x83\xa8\xe9\x97\xa8\xe6\xa8\xa1\xe6\x9d\xbf\n\n\xe6\xad\xa3\xe6\x96\x87\n",
            ));
            // 一部分技能带脚本,让"含可执行脚本"角标在真实数据上也走一遍
            if i % 5 == 0 {
                files.push(FileChange::create(
                    format!("{dir}/scripts/collect.py"),
                    b"print('fixture')\n",
                ));
            }
        }
        let req = ChangeFilesRequest {
            branch: if created_branch { BRANCH.into() } else { "main".into() },
            new_branch: if created_branch { None } else { Some(BRANCH.into()) },
            message: format!("fixture: 计时用样例技能 {:?}", chunk),
            files,
        };
        client
            .change_files(owner, repo, &req)
            .await
            .map_err(|e| format!("灌 fixture 数据失败: {e}"))?;
        created_branch = true;
    }
    Ok(())
}

#[tokio::test]
async fn measures_cold_first_paint_and_warm_cache_against_real_gitea() {
    let Some(env) = fixture_env() else {
        eprintln!("跳过:未找到 fixtures/.env.local,先跑 ./fixtures/init.sh");
        return;
    };
    let need = [
        "SKILLSYNC_FIXTURE_GITEA_URL",
        "SKILLSYNC_FIXTURE_ADMIN_TOKEN",
        "SKILLSYNC_FIXTURE_ORG",
        "SKILLSYNC_FIXTURE_REPO",
    ];
    if let Some(missing) = need.iter().find(|k| !env.contains_key(**k)) {
        eprintln!("跳过:fixtures/.env.local 缺 {missing}");
        return;
    }
    let (base_url, token) = (
        env["SKILLSYNC_FIXTURE_GITEA_URL"].clone(),
        env["SKILLSYNC_FIXTURE_ADMIN_TOKEN"].clone(),
    );
    let (owner, repo) = (
        env["SKILLSYNC_FIXTURE_ORG"].clone(),
        env["SKILLSYNC_FIXTURE_REPO"].clone(),
    );

    let client = GiteaClient::new(base_url, Some(token)).unwrap();
    if client.repo_info(&owner, &repo).await.is_err() {
        eprintln!("跳过:连不上 fixture Gitea");
        return;
    }
    if let Err(err) = ensure_fixture(&client, &owner, &repo).await {
        eprintln!("跳过:{err}");
        return;
    }

    let target = RepoRef {
        owner: owner.clone(),
        repo: repo.clone(),
        branch: BRANCH.into(),
    };
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), "fixture", &target);
    let now = 1_753_800_000;

    // 冷启动:空缓存 → 查分支头 + 下载压缩包 + 发现解析 + 落盘
    let started = Instant::now();
    let (index, outcome) = store::refresh_index(&client, &target, "fixture", &cache, false, now)
        .await
        .expect("冷启动取索引失败");
    let cold = started.elapsed();

    assert!(!outcome.from_cache);
    assert!(
        index.skills.len() >= SKILL_COUNT,
        "只发现 {} 个技能,fixture 没灌全",
        index.skills.len()
    );
    assert!(
        index.skills.iter().any(|s| s.has_scripts),
        "带脚本的技能应当被标出来"
    );

    // 缓存命中:只查一次分支头
    let started = Instant::now();
    let (cached, outcome) = store::refresh_index(&client, &target, "fixture", &cache, false, now)
        .await
        .expect("缓存命中取索引失败");
    let warm = started.elapsed();

    assert!(outcome.from_cache);
    assert_eq!(cached.skills.len(), index.skills.len());

    println!(
        "[DoD] 技能数={} 冷启动={cold:?} 缓存命中={warm:?}",
        index.skills.len()
    );
    assert!(cold < std::time::Duration::from_secs(2), "冷启动 {cold:?} 超出 DoD 的 2s");
    assert!(warm < std::time::Duration::from_millis(300), "缓存命中 {warm:?} 超出 DoD 的 300ms");
}
