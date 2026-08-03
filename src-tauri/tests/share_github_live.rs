//! 对**真实 GitHub** 跑一遍组合后的分享写路径(M3-5b 的 DoD 收口):
//! 新增分享(Fresh→直接保存)→ 本地改动 → 更新分享(Mine→直接保存)。
//! 分支保护与 fork 两条路径的真实行为已单独录制(tests/fixtures/github-write/),
//! wiremock 矩阵测试按录制钉住;这里验证的是端到端组合。
//!
//! 需要可写测试仓凭证,**默认跳过**,手动跑:
//! ```
//! SKILLSYNC_GITHUB_LIVE=1 SKILLSYNC_GITHUB_WRITE_REPO=owner/repo \
//!   SKILLSYNC_GITHUB_WRITE_TOKEN=ghp_… cargo test --test share_github_live -- --nocapture
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::gitea::RepoRef;
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::share::{self, ShareClient, ShareMode, ShareOutcome};
use skillsync_lib::core::state::Store;

struct TmpEnv {
    home: PathBuf,
}

impl AgentEnv for TmpEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, _name: &str) -> Option<String> {
        None
    }
    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

#[tokio::test]
async fn share_fresh_then_update_against_real_github() {
    if std::env::var("SKILLSYNC_GITHUB_LIVE").as_deref() != Ok("1") {
        eprintln!("跳过:设 SKILLSYNC_GITHUB_LIVE=1 才对真实 GitHub 跑");
        return;
    }
    let (Ok(target), Ok(token)) = (
        std::env::var("SKILLSYNC_GITHUB_WRITE_REPO"),
        std::env::var("SKILLSYNC_GITHUB_WRITE_TOKEN"),
    ) else {
        eprintln!("跳过:未设 SKILLSYNC_GITHUB_WRITE_REPO / SKILLSYNC_GITHUB_WRITE_TOKEN");
        return;
    };
    let (owner, repo_name) = target.split_once('/').expect("REPO 应为 owner/repo");

    let tmp = tempfile::tempdir().unwrap();
    let env = TmpEnv {
        home: tmp.path().to_path_buf(),
    };
    let store = Store::new(tmp.path().join(".skillsync"));
    let registry = AgentRegistry::builtin();
    let http = skillsync_lib::core::gitea::app_http_client_proxied().unwrap();
    let gh = GithubClient::new("https://github.com", Some(token), http);
    let client = ShareClient::Github(&gh);
    let repo = RepoRef {
        owner: owner.into(),
        repo: repo_name.into(),
        branch: "main".into(),
    };

    // 用时间戳当分享名,避免与历史录制的残留冲突;live 测试允许摸时钟
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let share_name = format!("live-lab-{stamp}");
    let now = "2026-08-03T12:00:00.000Z";

    let dir = tmp.path().join(".agents/skills").join(&share_name);
    std::fs::create_dir_all(dir.join("scripts")).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: 联调样例\ndescription: 5b 端到端联调\n---\n\n第一版\n",
    )
    .unwrap();
    std::fs::write(dir.join("scripts/run.sh"), "#!/bin/sh\necho hi\n").unwrap();

    let req = |overwrite| share::ShareRequest {
        registry_id: "gh-live",
        repo: &repo,
        source_path: &dir,
        share_name: &share_name,
        display_name: None,
        description: None,
        origin: "local",
        overwrite,
    };

    // 第一步:Fresh → main 未保护 → 直接保存
    let outcome = share::share(&client, &registry, &env, &store, req(false), now)
        .await
        .expect("首次分享失败");
    let ShareOutcome::Shared { mode, commit_sha, .. } = outcome else {
        panic!("首次分享不应进入同名冲突");
    };
    assert_eq!(mode, ShareMode::Pushed);
    eprintln!("首次分享已保存:{commit_sha}");

    // 第二步:本地改一版 → Mine → 更新分享
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: 联调样例\ndescription: 5b 端到端联调\n---\n\n第二版\n",
    )
    .unwrap();
    let outcome = share::share(&client, &registry, &env, &store, req(false), now)
        .await
        .expect("更新分享失败");
    let ShareOutcome::Shared { mode, commit_sha: second_sha, .. } = outcome else {
        panic!("更新分享不应进入同名冲突(记账里是自己的)");
    };
    assert_eq!(mode, ShareMode::Pushed);
    assert_ne!(second_sha, commit_sha);
    eprintln!("更新分享已保存:{second_sha}");
    eprintln!("(远端残留 skills/{share_name}/,测试仓本就是一次性的,不清理)");
}
