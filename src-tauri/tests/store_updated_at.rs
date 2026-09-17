//! 逐技能的「最后改动时间」(v8 任务 1)。
//!
//! 起因是用户真机报障:商店里**所有**卡片的「更新于 X 前」永远是同一个时间
//! ——索引里根本没有 per-skill 的时间字段,卡片拿的是整库分支头的提交时间。
//!
//! 与 `store_index.rs` 同一个姿势:**不抽象网络**,直接对 wiremock 跑真
//! `GiteaClient`。要验的几件事里有两件只有数请求才算真验过:
//! ①翻页封顶到底有没有拦住第 6 页;②页数是不是真翻了。
//! 只断言"返回的时间看起来对"的话,「翻满上限」与「历史提前翻完」这两条路
//! 得到的结果**完全相同**(都是 `LongAgo`),测不出差别。

use skillsync_lib::core::gitea::{GiteaClient, RepoRef};
use skillsync_lib::core::store::{self, SkillUpdatedAt, COMMIT_PAGE_LIMIT, MAX_COMMIT_PAGES};
use wiremock::matchers::{method, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const REGISTRY: &str = "company";

fn repo_ref() -> RepoRef {
    RepoRef { owner: "skills".into(), repo: "skills".into(), branch: "main".into() }
}

fn zip_with(slugs: &[&str]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::SimpleFileOptions = Default::default();
        w.add_directory("skills/", opts).unwrap();
        for slug in slugs {
            w.start_file(format!("skills/skills/{slug}/SKILL.md"), opts).unwrap();
            std::io::Write::write_all(
                &mut w,
                format!("---\nname: {slug}\ndescription: {slug} 的说明文字。\n---\n\n正文\n").as_bytes(),
            )
            .unwrap();
        }
        w.finish().unwrap();
    }
    buf
}

async fn mount_repo(server: &MockServer, slugs: &[&str]) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/branches/main$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "name": "main",
            "commit": { "id": "head111", "timestamp": "2026-09-16T10:00:00Z" }
        })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/archive/main\.zip$"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_with(slugs)))
        .mount(server)
        .await;
}

/// 一条提交。字段名照真实 Gitea 1.25.3 的响应(2026-09-16 对 fixture 容器
/// curl 核实:顶层 `created` + `files[].filename`)。
fn commit(at: &str, files: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "sha": format!("sha-{at}"),
        "created": at,
        "files": files.iter().map(|f| serde_json::json!({ "filename": f })).collect::<Vec<_>>(),
    })
}

/// 挂一页提交历史。`page` 精确匹配,所以没挂的页会 404
/// ——"第 6 页有没有被请求"因此既能从请求记录看出,也不会被误响应遮住。
async fn mount_commit_page(server: &MockServer, page: u32, commits: Vec<serde_json::Value>) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/v1/repos/skills/skills/commits$"))
        .and(query_param("page", page.to_string()))
        .respond_with(ResponseTemplate::new(200).set_body_json(commits))
        .mount(server)
        .await;
}

/// 实际请求过的提交历史页码(按发出顺序)。
async fn requested_pages(server: &MockServer) -> Vec<String> {
    server
        .received_requests()
        .await
        .expect("wiremock 未记录请求")
        .iter()
        .filter(|r| r.url.path().ends_with("/repos/skills/skills/commits"))
        .filter_map(|r| {
            r.url.query_pairs().find(|(k, _)| k == "page").map(|(_, v)| v.into_owned())
        })
        .collect()
}

async fn refresh(server: &MockServer, cache: &std::path::Path) -> store::StoreIndex {
    let client = GiteaClient::new(server.uri(), None).unwrap();
    store::refresh_index(&client, &repo_ref(), REGISTRY, cache, false, 1_753_800_000)
        .await
        .unwrap()
        .0
}

fn at_of(index: &store::StoreIndex, slug: &str) -> SkillUpdatedAt {
    index
        .skills
        .iter()
        .find(|s| s.dir_slug == slug)
        .unwrap_or_else(|| panic!("索引里没有 {slug}"))
        .updated_at
        .clone()
}

/// 测试 1:一页历史能给每个技能标上**它自己**那次提交的时间;同一个技能出现
/// 多次时取**最新**那次(API 是新→旧分页,所以"首次出现"即最新)。
///
/// 两个技能的时间必须**不同**——这正是用户报障的那一条:今天它们是同一个值。
#[tokio::test]
async fn each_skill_gets_the_time_of_its_own_latest_commit() {
    let server = MockServer::start().await;
    mount_repo(&server, &["weekly-report", "docx-to-markdown"]).await;
    mount_commit_page(
        &server,
        1,
        vec![
            // 新 → 旧
            commit("2026-09-16T09:00:00Z", &["skills/weekly-report/SKILL.md"]),
            commit("2026-09-10T08:00:00Z", &["skills/docx-to-markdown/SKILL.md"]),
            // 同一个技能更早的一次:必须**不覆盖**上面那条
            commit("2026-08-01T07:00:00Z", &["skills/weekly-report/scripts/run.sh"]),
        ],
    )
    .await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY, &repo_ref());

    let index = refresh(&server, &cache).await;

    assert_eq!(
        at_of(&index, "weekly-report"),
        SkillUpdatedAt::At { at: "2026-09-16T09:00:00Z".into() },
        "同一技能出现多次要取最新那次(新→旧分页下就是首次出现的那次)"
    );
    assert_eq!(
        at_of(&index, "docx-to-markdown"),
        SkillUpdatedAt::At { at: "2026-09-10T08:00:00Z".into() },
        "每个技能取的是碰过它自己目录的那次提交,不是这一页最新那条"
    );
    // 落盘的那一份也得带上,否则下次命中缓存时间又没了(缓存命中路径不重扫)
    assert_eq!(
        at_of(&store::load_cache(&cache).unwrap(), "weekly-report"),
        SkillUpdatedAt::At { at: "2026-09-16T09:00:00Z".into() },
    );
    // 全部技能都找到了就该早退,不该白翻第 2 页
    assert_eq!(requested_pages(&server).await, vec!["1"], "找齐了就停,别接着翻");
}

/// 测试 2:翻页封顶。造 6 页,只在第 6 页出现的技能拿不到时间,**不报错**、
/// 也不拖垮整份索引(其余技能照常有时间、卡片照常出得来)。
///
/// 🔴 断言**请求过的页码**,不是只看结果:「翻满 5 页」与「历史提前翻完」
/// 得到的结果都是 `LongAgo`,光看结果分不出实现到底有没有在第 5 页刹住。
/// 每页都塞满 `COMMIT_PAGE_LIMIT` 条,免得"这一页不满 → 提前 break"
/// 让这条测试因为另一个原因通过。
#[tokio::test]
async fn paging_stops_at_the_cap_and_the_rest_are_long_ago() {
    let server = MockServer::start().await;
    mount_repo(&server, &["seen-early", "only-on-page-six"]).await;
    let filler = |page: u32, i: u32| {
        commit(&format!("2026-01-{page:02}T00:{i:02}:00Z"), &["skills/noise/SKILL.md"])
    };
    for page in 1..=6u32 {
        let mut commits: Vec<serde_json::Value> =
            (0..COMMIT_PAGE_LIMIT).map(|i| filler(page, i)).collect();
        if page == 1 {
            commits[0] = commit("2026-09-16T09:00:00Z", &["skills/seen-early/SKILL.md"]);
        }
        if page == 6 {
            commits[0] = commit("2020-01-01T00:00:00Z", &["skills/only-on-page-six/SKILL.md"]);
        }
        mount_commit_page(&server, page, commits).await;
    }
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY, &repo_ref());

    let index = refresh(&server, &cache).await;

    assert_eq!(index.skills.len(), 2, "翻页封顶不该影响索引本身");
    assert_eq!(
        at_of(&index, "seen-early"),
        SkillUpdatedAt::At { at: "2026-09-16T09:00:00Z".into() }
    );
    assert_eq!(
        at_of(&index, "only-on-page-six"),
        SkillUpdatedAt::LongAgo,
        "翻满上限还没见到 → 「很久以前」(属实),而不是 Unknown(那是「算不出」)"
    );
    // 🔴 期望值写**字面量**,不是 `(1..=MAX_COMMIT_PAGES)`。第一版就是照常量算的,
    // 注入验证当场抓到:把常量改成 4,闸和尺子一起动,测试照样绿——那是本项目
    // 复盘过的「候选闸与尺子被一起改掉」。字面量是独立的尺子,常量一动就变红。
    assert_eq!(
        requested_pages(&server).await,
        vec!["1", "2", "3", "4", "5"],
        "必须正好翻 5 页,第 6 页一个请求都不能发"
    );
    assert_eq!(
        MAX_COMMIT_PAGES, 5,
        "上限改过就一起改上面那份字面量清单,让下一个人看到当前值(与 INDEX_SCHEMA_VERSION 同款)"
    );
}

/// 测试 3:合并提交(实测 `files: []`)不能污染结果。
///
/// 把它摆在**最新**的位置:实现若拿"这一页最新那条的时间"去代表技能,
/// 两个技能都会变成合并提交那个时间——正是要修的那个缺陷的形状。
#[tokio::test]
async fn a_merge_commit_with_no_files_touches_nothing() {
    let server = MockServer::start().await;
    mount_repo(&server, &["weekly-report", "docx-to-markdown"]).await;
    mount_commit_page(
        &server,
        1,
        vec![
            commit("2026-09-16T23:59:00Z", &[]), // 合并提交:files 是空数组
            commit("2026-09-16T09:00:00Z", &["skills/weekly-report/SKILL.md"]),
            commit("2026-09-10T08:00:00Z", &["skills/docx-to-markdown/SKILL.md"]),
        ],
    )
    .await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY, &repo_ref());

    let index = refresh(&server, &cache).await;

    assert_eq!(
        at_of(&index, "weekly-report"),
        SkillUpdatedAt::At { at: "2026-09-16T09:00:00Z".into() },
        "合并提交没碰任何文件,不该把它的时间安到技能头上"
    );
    assert_eq!(
        at_of(&index, "docx-to-markdown"),
        SkillUpdatedAt::At { at: "2026-09-10T08:00:00Z".into() },
    );
}

/// 取提交历史失败时,**不能顺势写成「很久以前」**——那是拿一次网络故障编造事实。
/// 已经标上的保留,没标上的留在 `Unknown`(界面整行不摆),索引本身照常可用。
#[tokio::test]
async fn a_failing_history_leaves_unknown_not_long_ago() {
    let server = MockServer::start().await;
    mount_repo(&server, &["weekly-report"]).await;
    // 不挂 commits 端点 → 404 → 取数失败
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY, &repo_ref());

    let index = refresh(&server, &cache).await;

    assert_eq!(index.skills.len(), 1, "取不到提交历史不该拖垮整份索引");
    assert_eq!(
        at_of(&index, "weekly-report"),
        SkillUpdatedAt::Unknown,
        "取数失败 = 不知道,不是「很久以前」"
    );
}

/// 历史提前翻完(不满一页)时剩下的技能也是「很久以前」,并且**不会**接着翻下一页。
#[tokio::test]
async fn an_exhausted_history_stops_early() {
    let server = MockServer::start().await;
    mount_repo(&server, &["never-touched"]).await;
    mount_commit_page(&server, 1, vec![commit("2026-09-16T09:00:00Z", &["README.md"])]).await;
    let tmp = tempfile::tempdir().unwrap();
    let cache = store::cache_path(tmp.path(), REGISTRY, &repo_ref());

    let index = refresh(&server, &cache).await;

    assert_eq!(at_of(&index, "never-touched"), SkillUpdatedAt::LongAgo);
    assert_eq!(requested_pages(&server).await, vec!["1"], "这一页没满就说明到头了,别再翻");
}
