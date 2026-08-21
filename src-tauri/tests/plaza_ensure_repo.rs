//! `commands::plaza_ensure_repo`(M9 任务 3)的编排测试。
//!
//! `commands.rs` 里的 `#[tauri::command]` 函数依赖 `app_store()`(真实 `HOME`),
//! 这个仓库一贯不直接单测这类"薄壳"(参见 CLAUDE.md「测试要求」与
//! `tests/scheduler_check.rs`/`tests/claim_flow.rs` 的既有套路:command 的编排逻辑
//! 拆成 core 里的纯函数单独测,这里用注入的 `Store` 原样复演该命令的三步编排
//! ——check → (按需)HTTP 探测 → record + save——验证它们拼起来的行为,
//! 不依赖真实 `HOME`。
//!
//! 三步本身:`registry::find_plaza_repo` / `registry::record_plaza_repo` 各有独立单测
//! (`core/registry.rs`),`plaza::default_branch` 有独立单测(`tests/plaza_default_branch.rs`)。
//! 这里测的是**编排**——幂等判定是否真的省下了那次网络请求与那次写盘。

use skillsync_lib::core::plaza;
use skillsync_lib::core::registry::{self, PLAZA_REGISTRY_ID};
use skillsync_lib::core::state::Store;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("SkillSync/test")
        .build()
        .unwrap()
}

/// 调用**真实实现** `plaza::ensure_repo`,只把 `Store` 换成临时目录、`api_base`
/// 换成 wiremock(两者本来就是它的参数)。
///
/// ⚠️ 这里原先是一份"与 command 逐行同构"的**拷贝**:实现改了它照样绿,等于
/// 没有护栏(CLAUDE.md 记的空转模式——测试测的是自己那份代码)。挂仓编排在 v5
/// 多出第二个调用方(装进项目)时下沉进了 `core::plaza`,这份测试随之改成测真东西。
async fn ensure(
    store: &Store,
    server: &MockServer,
    owner: &str,
    repo: &str,
) -> Result<registry::RepoView, skillsync_lib::error::AppError> {
    plaza::ensure_repo(store, &http(), &server.uri(), owner, repo).await
}

#[tokio::test]
async fn ensuring_the_same_repo_twice_hits_the_network_only_once() {
    let server = MockServer::start().await;
    // `.expect(1)`:第二次调用如果又发了一次探测请求,这条断言会让测试失败——
    // 这正是"幂等"这条测试清单要钉住的事实。
    Mock::given(method("GET"))
        .and(path("/repos/vercel-labs/skills"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"default_branch":"main"}"#))
        .expect(1)
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));

    let first = ensure(&store, &server, "vercel-labs", "skills").await.unwrap();
    assert_eq!(first.key, "vercel-labs/skills");
    assert_eq!(first.branch, "main");

    let second = ensure(&store, &server, "vercel-labs", "skills").await.unwrap();
    assert_eq!(second.key, first.key);
    assert_eq!(second.branch, first.branch);

    // config 只有一条,不是挂了两遍
    let config = store.load_config().unwrap().value;
    assert_eq!(config.plaza_repos.len(), 1, "重复调用不该重复挂:{:?}", config.plaza_repos);

    server.verify().await; // 触发 `.expect(1)` 的断言
}

/// 挂仓后 `registry::resolve(plaza, key)` 立即可用,分支就是刚探测出的值——
/// 这是 `plaza_ensure_repo` 与既有获取 IPC 之间唯一的耦合点。
#[tokio::test]
async fn resolve_works_immediately_after_ensuring() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/octocat/hello-world"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(r#"{"default_branch":"develop"}"#),
        )
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));
    ensure(&store, &server, "octocat", "hello-world").await.unwrap();

    let config = store.load_config().unwrap().value;
    let builtin = registry::BuiltinSource { base_url: None, repo: None, branch: "main" };
    let resolved = registry::resolve(
        &builtin,
        &[],
        &[],
        PLAZA_REGISTRY_ID,
        Some("octocat/hello-world"),
        &config.plaza_repos,
    )
    .expect("挂仓后立即可解析");
    assert_eq!(resolved.repo.branch, "develop");
    assert_eq!(resolved.base_url, registry::PLAZA_BASE_URL);
    assert_eq!(resolved.kind, registry::RegistryKind::Github);
}

/// 404(仓不存在或拼错)不该把半条记录留在 config 里:`ensure` 用 `?` 在探测失败那步
/// 就提前返回,`record_plaza_repo`/`save_config` 都不会被调用到。
#[tokio::test]
async fn a_failed_probe_leaves_no_partial_config() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/repos/ghost/none"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let store = Store::new(tmp.path().join(".skillsync"));

    let err = ensure(&store, &server, "ghost", "none").await.unwrap_err();
    assert_eq!(err.code, "NET_PLAZA_REPO");

    // config.json 要么没落过盘,要么落的是默认空值——两种情况 plaza_repos 都该是空的。
    let config = store.load_config().unwrap().value;
    assert!(config.plaza_repos.is_empty(), "探测失败不该留下半条记录: {:?}", config.plaza_repos);
}

/// 挂仓的**调用方清单**守卫:每一条"用户按下了装"的入口,取数前都必须先幂等挂仓。
///
/// 为什么是文本级的:这两个入口都是 `#[tauri::command]` 薄壳,锁在真实 `HOME` 与真实
/// 网络上,单测够不到(同 `bundle_config.rs` 里那几条守卫的处境)。而漏掉这一步的
/// 表现极隐蔽——**只在"这台机器从没装过这个广场仓"时**报 `REPO_UNKNOWN_REPO`,
/// 开发机上往往早就挂过了,自己怎么试都是好的。v5 起初就漏在 `project_skill_install`
/// 这一条上。
///
/// 断言顺序而不只是存在性:挂在 `read_source` 之后等于没挂(resolve 已经报错返回了)。
#[test]
fn every_install_entry_point_mounts_the_plaza_repo_before_fetching() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands.rs"),
    )
    .unwrap();

    let start = src
        .find("pub async fn project_skill_install(")
        .expect("找不到 project_skill_install —— 改名了就把这条守卫一起改");
    let body = &src[start..];
    let end = body.find("\n/// 写进项目 lock 的 sourceUrl").unwrap_or(body.len());
    // ⚠️ **必须先剥掉注释**:函数体里那段说明本身就写着 `plaza::ensure_repo`,
    // 不剥的话把真实调用整段删掉、只留注释,这条守卫照样绿(注入验证当场复现)。
    // 「同一个词在注释里也出现」是文本级守卫的固有陷阱,别省这一步。
    let body: String = body[..end]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let body = body.as_str();

    let mount = body
        .find("plaza::ensure_repo")
        .expect("project_skill_install 没有幂等挂仓:广场技能装进项目会报「未知的技能库」");
    let fetch = body.find("read_source(").expect("找不到取数调用");
    assert!(
        mount < fetch,
        "挂仓必须在取数之前——挂在 read_source 之后等于没挂(resolve 已经先报错返回了)"
    );
}
