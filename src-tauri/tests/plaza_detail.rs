//! `core::plaza::fetch_repo_skills` 与 `commands::plaza_detail`「未挂仓」分支的
//! 集成测试(M9 任务 4)。
//!
//! 与 `tests/plaza_acquire.rs`/`tests/plaza_ensure_repo.rs` 同一套写法:
//! - `fetch_repo_skills` 是纯 core 函数,直接用 wiremock 构造的 `GithubClient` 测
//!   (测试清单 1、3);
//! - `commands::plaza_detail` 依赖 `app_store()`(真实 `HOME`),这个仓库的既有纪律
//!   是不直接单测这类薄壳(见 `plaza_ensure_repo.rs` 模块头),这里用注入的 `Store`
//!   原样复演它「未挂仓」分支的编排:resolve 失败(`REPO_UNKNOWN_REPO`)→ 探测默认
//!   分支 → 手工拼 `RepoRef` 直连,**不写 config**(测试清单 4)。
//! - 「已挂仓」分支复用的是与 `tests/plaza_acquire.rs` 完全同一条 `registry::resolve`
//!   路径,那份测试已经钉住;「缓存命中」与「缓存键隔离」是私有静态,只能从
//!   `commands.rs` 内部够到,覆盖在那边的 `#[cfg(test)] mod tests`
//!   (`cached_plaza_detail_*` 系列),这里不重复。

use skillsync_lib::core::gitea::RepoRef;
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::plaza;
use skillsync_lib::core::registry::{self, PLAZA_REGISTRY_ID};
use skillsync_lib::core::state::Store;
use skillsync_lib::error::AppError;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn http() -> reqwest::Client {
    reqwest::Client::builder().user_agent("SkillSync/test").build().unwrap()
}

fn repo() -> RepoRef {
    RepoRef { owner: "octo".into(), repo: "multi".into(), branch: "main".into() }
}

/// GitHub 风格压缩包前缀(`{owner}-{repo}-{短sha}/`,2026-07-31 实测),放两个技能
/// ——断言"详情返回该仓全部技能",只放一个会把"全部"这两个字测没了。
fn zip_with_skills(slugs: &[&str]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::SimpleFileOptions = Default::default();
        w.add_directory("octo-multi-aaa1111/", opts).unwrap();
        for slug in slugs {
            w.start_file(format!("octo-multi-aaa1111/skills/{slug}/SKILL.md"), opts)
                .unwrap();
            let text = format!("---\nname: {slug}\ndescription: {slug} 的说明\n---\n\n正文\n");
            std::io::Write::write_all(&mut w, text.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }
    buf
}

async fn mount_branch(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/octo/multi/branches/main"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "sha": "aaa1111", "commit": { "committer": { "date": "2026-08-12T10:00:00Z" } } }
        })))
        .mount(server)
        .await;
}

// ---------------------------------------------------------------- 1. 返回该仓全部技能

#[tokio::test]
async fn fetch_repo_skills_returns_every_skill_in_the_repo() {
    let server = MockServer::start().await;
    mount_branch(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/octo/multi/zipball/main"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(zip_with_skills(&["weekly-report", "docx-to-markdown"])),
        )
        .mount(&server)
        .await;

    let client = GithubClient::new(&server.uri(), None, http());
    let skills = plaza::fetch_repo_skills(&client, &repo()).await.unwrap();

    assert_eq!(skills.len(), 2, "{skills:?}");
    let mut slugs: Vec<&str> = skills.iter().map(|s| s.dir_slug.as_str()).collect();
    slugs.sort();
    assert_eq!(slugs, vec!["docx-to-markdown", "weekly-report"]);

    // 与商店详情面板同一份形状:SKILL.md 全文、commit_sha 都在,不是精简过的卡片。
    let wr = skills.iter().find(|s| s.dir_slug == "weekly-report").unwrap();
    assert!(wr.skill_md.contains("weekly-report 的说明"), "{}", wr.skill_md);
    assert_eq!(wr.commit_sha, "aaa1111");
    assert_eq!(wr.path, "skills/weekly-report");
}

// ---------------------------------------------------------------- 3. zipball 失败

#[tokio::test]
async fn fetch_repo_skills_maps_a_missing_zipball_to_a_readable_chinese_error() {
    let server = MockServer::start().await;
    mount_branch(&server).await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/octo/multi/zipball/main"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let client = GithubClient::new(&server.uri(), None, http());
    let err = plaza::fetch_repo_skills(&client, &repo()).await.unwrap_err();

    // 复用既有 GithubClient 的状态码映射(github.rs::check_status),不是新错误码
    // ——404 已经是"找不到对应的技能库或文件"这句人话,不需要再包一层。
    assert_eq!(err.code, "REPO_NOT_FOUND");
    assert!(
        err.message.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
        "必须是中文: {}",
        err.message
    );
}

/// branch_head 本身失败(仓根本不存在)同样要给出中文错误,而不是在这里 panic 或
/// 吞掉——`fetch_repo_skills` 对两步都用 `?`,这条钉住第一步失败时也直接透出。
#[tokio::test]
async fn fetch_repo_skills_surfaces_a_branch_head_failure() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/repos/octo/multi/branches/main"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let client = GithubClient::new(&server.uri(), None, http());
    let err = plaza::fetch_repo_skills(&client, &repo()).await.unwrap_err();
    assert_eq!(err.code, "REPO_NOT_FOUND");
}

// ---------------------------------------------------------------- 4. 未挂仓可查详情且不写 config

/// 与 `commands::plaza_detail` 的「未挂仓」分支逐行同构:resolve 失败
/// (`REPO_UNKNOWN_REPO`)→ 探测默认分支 → 手工拼 `RepoRef` 直连。
/// **故意不调用 `commands::plaza_detail`**(它锁在真实 `HOME` 上,见模块头)。
async fn detail_ref_for_unregistered_repo(
    store: &Store,
    server: &MockServer,
    owner: &str,
    repo: &str,
) -> Result<RepoRef, AppError> {
    let config = store.load_config()?.value;
    let key = registry::repo_key(owner, repo);
    let builtin = registry::BuiltinSource { base_url: None, repo: None, branch: "main" };
    match registry::resolve(&builtin, &[], &[], PLAZA_REGISTRY_ID, Some(&key), &config.plaza_repos)
    {
        Ok(resolved) => Ok(resolved.repo),
        Err(err) if err.code == "REPO_UNKNOWN_REPO" => {
            let branch = plaza::default_branch(&http(), &server.uri(), owner, repo).await?;
            Ok(RepoRef { owner: owner.to_string(), repo: repo.to_string(), branch })
        }
        Err(err) => Err(err),
    }
}

#[tokio::test]
async fn detail_works_for_an_unregistered_repo_and_never_writes_config() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/octocat/hello-world"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"default_branch":"develop"}"#))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));

    let repo_ref = detail_ref_for_unregistered_repo(&store, &server, "octocat", "hello-world")
        .await
        .expect("未挂仓也该能查到坐标");
    assert_eq!(repo_ref.owner, "octocat");
    assert_eq!(repo_ref.repo, "hello-world");
    assert_eq!(repo_ref.branch, "develop");

    // "绝不创建用户没要求的记账"同族约束:查详情不该顺手挂仓。
    let config = store.load_config().unwrap().value;
    assert!(
        config.plaza_repos.is_empty(),
        "查详情不该顺手挂仓: {:?}",
        config.plaza_repos
    );
}

/// 注入验证的靶子:如果「未挂仓」分支被改成顺手 `record_plaza_repo` + `save_config`,
/// 上一条测试的断言就会失败——这条补一个探测失败的对照组,确认失败路径同样不留痕迹
/// (与 `plaza_ensure_repo.rs::a_failed_probe_leaves_no_partial_config` 同一种关注点)。
#[tokio::test]
async fn a_failed_probe_for_an_unregistered_repo_leaves_no_partial_config() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/ghost/none"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));

    let err = detail_ref_for_unregistered_repo(&store, &server, "ghost", "none")
        .await
        .unwrap_err();
    assert_eq!(err.code, "NET_PLAZA_REPO");

    let config = store.load_config().unwrap().value;
    assert!(config.plaza_repos.is_empty(), "探测失败不该留下半条记录: {:?}", config.plaza_repos);
}

/// 已挂仓时 resolve 直接成功,不该再去探测默认分支——这是「未挂仓」分支存在的前提
/// (否则每次查详情都会多打一次探测请求)。分支坐标必须来自账上记录,不是重新猜的。
#[tokio::test]
async fn detail_ref_skips_the_probe_once_the_repo_is_registered() {
    // 故意不挂任何桩:如果实现误触发了探测请求,wiremock 会用默认 404 响应,
    // 从而让下面的 `.expect()` panic——这就是"零请求"的断言方式。
    let server = MockServer::start().await;

    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));
    let mut config = store.load_config().unwrap().value;
    config.plaza_repos.push(skillsync_lib::core::state::RepoConfig {
        owner: "vercel-labs".into(),
        repo: "skills".into(),
        branch: "develop".into(),
        name: None,
    });
    store.save_config(&config).unwrap();

    let repo_ref = detail_ref_for_unregistered_repo(&store, &server, "vercel-labs", "skills")
        .await
        .expect("已挂仓应直接解析,不该发探测请求");
    assert_eq!(repo_ref.branch, "develop", "分支必须来自账上记录,不是又探测了一次");
}
