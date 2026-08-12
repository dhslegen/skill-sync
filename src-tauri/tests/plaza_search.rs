//! `core::plaza::search`(M9 任务 1)的 wiremock 集成测试。
//!
//! 真实 fixture(`fixtures/skillssh-search.json`)来自 2026-08-12 对
//! `https://skills.sh/api/search?q=react&limit=5` 的真实请求:首条记录
//! (id/skillId/name/`installs: 625414`/source)与调查报告
//! (`docs/调查-npx-skills-find-开放API.md`)内嵌的示例逐字节相同,证明端点形状
//! 在两次抓取之间未漂移——报告当时只内嵌了首条作为示例,完整多条捕获落在会话
//! scratchpad(已不可复现),这里是同一天对同一端点重新发起的真实请求,不是手编。
//! 其余测试用到的"变体"响应体是刻意构造的合法/脏 JSON,用于单独验证排序与容错规则,
//! 不冒充真实抓取。

use skillsync_lib::core::plaza::{self, PlazaSkillCard};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FIXTURE: &str = include_str!("fixtures/skillssh-search.json");

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("SkillSync/test")
        .build()
        .unwrap()
}

fn card(name: &str, slug: &str, owner_repo: &str, installs: u64) -> PlazaSkillCard {
    PlazaSkillCard {
        name: name.into(),
        slug: slug.into(),
        owner_repo: owner_repo.into(),
        installs,
    }
}

/// 挂一条 `/api/search` 桩,固定按我们的 client 实际会发的 `limit=20`(`PLAZA_SEARCH_LIMIT`)匹配。
async fn mount_search(server: &MockServer, q: &str, body: String, status: u16) {
    Mock::given(method("GET"))
        .and(path("/api/search"))
        .and(query_param("q", q))
        .and(query_param("limit", "20"))
        .respond_with(ResponseTemplate::new(status).set_body_string(body))
        .mount(server)
        .await;
}

// ---------------------------------------------------------------- 1. 真实 fixture

#[tokio::test]
async fn real_fixture_returns_five_cards_with_correct_fields_sorted_desc() {
    let server = MockServer::start().await;
    mount_search(&server, "react", FIXTURE.to_string(), 200).await;

    let got = plaza::search(&http(), &server.uri(), "react")
        .await
        .expect("真实 fixture 应当解析成功");

    // 原始 5 条的 installs 是 625414/185740/96286/5649/50583——第 4、5 条本就不是
    // 降序(5649 < 50583),这份真实数据顺带证明了排序不是"恰好碰上已排序的输入"。
    assert_eq!(
        got,
        vec![
            card(
                "vercel-react-best-practices",
                "vercel-labs/agent-skills/vercel-react-best-practices",
                "vercel-labs/agent-skills",
                625_414,
            ),
            card(
                "vercel-react-native-skills",
                "vercel-labs/agent-skills/vercel-react-native-skills",
                "vercel-labs/agent-skills",
                185_740,
            ),
            card(
                "vercel-react-view-transitions",
                "vercel-labs/agent-skills/vercel-react-view-transitions",
                "vercel-labs/agent-skills",
                96_286,
            ),
            card(
                "react:components",
                "google-labs-code/stitch-skills/react:components",
                "google-labs-code/stitch-skills",
                50_583,
            ),
            card(
                "react",
                "vercel-labs/json-render/react",
                "vercel-labs/json-render",
                5_649,
            ),
        ]
    );
}

// ---------------------------------------------------------------- 2. 降序排序(变体)

#[tokio::test]
async fn sorts_by_installs_descending() {
    let server = MockServer::start().await;
    // 刻意乱序(既不升也不降),用干净的小数据集单独验证排序规则本身。
    let body = serde_json::json!({
        "skills": [
            {"id": "a/a/low", "name": "low", "installs": 1, "source": "a/a"},
            {"id": "b/b/high", "name": "high", "installs": 999, "source": "b/b"},
            {"id": "c/c/mid", "name": "mid", "installs": 500, "source": "c/c"},
        ]
    })
    .to_string();
    mount_search(&server, "sort", body, 200).await;

    let got = plaza::search(&http(), &server.uri(), "sort")
        .await
        .expect("应当解析成功");

    assert_eq!(
        got.iter().map(|c| c.installs).collect::<Vec<_>>(),
        vec![999, 500, 1]
    );
    assert_eq!(got[0].name, "high");
    assert_eq!(got[1].name, "mid");
    assert_eq!(got[2].name, "low");
}

// ---------------------------------------------------------------- 3. 脏数据跳过

#[tokio::test]
async fn skips_entry_missing_source_keeps_the_rest() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "skills": [
            {"id": "a/a/one", "name": "one", "installs": 10, "source": "a/a"},
            // 缺 source:整条脏数据,应跳过而不是让整批解析失败
            {"id": "b/b/two", "name": "two", "installs": 20},
            {"id": "c/c/three", "name": "three", "installs": 30, "source": "c/c"},
            {"id": "d/d/four", "name": "four", "installs": 40, "source": "d/d"},
            {"id": "e/e/five", "name": "five", "installs": 50, "source": "e/e"},
        ]
    })
    .to_string();
    mount_search(&server, "q1", body, 200).await;

    let got = plaza::search(&http(), &server.uri(), "q1")
        .await
        .expect("单条脏数据不应让整批失败");

    assert_eq!(got.len(), 4, "{got:?}");
    assert!(
        got.iter().all(|c| c.name != "two"),
        "缺 source 那条应被跳过:{got:?}"
    );
    let names: Vec<&str> = got.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["five", "four", "three", "one"]);
}

#[tokio::test]
async fn skips_entry_missing_name_keeps_the_rest() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "skills": [
            {"id": "a/a/one", "name": "one", "installs": 10, "source": "a/a"},
            {"id": "c/c/three", "name": "three", "installs": 30, "source": "c/c"},
            // 缺 name:整条脏数据
            {"id": "b/b/two", "installs": 20, "source": "b/b"},
            {"id": "d/d/four", "name": "four", "installs": 40, "source": "d/d"},
            {"id": "e/e/five", "name": "five", "installs": 50, "source": "e/e"},
        ]
    })
    .to_string();
    mount_search(&server, "q2", body, 200).await;

    let got = plaza::search(&http(), &server.uri(), "q2")
        .await
        .expect("单条脏数据不应让整批失败");

    assert_eq!(got.len(), 4, "{got:?}");
    assert!(got.iter().all(|c| c.owner_repo != "b/b"));
    let names: Vec<&str> = got.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["five", "four", "three", "one"]);
}

// ---------------------------------------------------------------- 4. 未知字段宽容

#[tokio::test]
async fn tolerates_unknown_fields() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "query": "q3",
        "searchType": "fuzzy",
        "count": 1,
        "duration_ms": 42,
        "somethingUpstreamAddsLater": {"nested": true},
        "skills": [
            {
                "id": "a/a/one",
                "skillId": "one",
                "name": "one",
                "installs": 10,
                "source": "a/a",
                "description": "上游未来可能加的新字段"
            }
        ]
    })
    .to_string();
    mount_search(&server, "q3", body, 200).await;

    let got = plaza::search(&http(), &server.uri(), "q3")
        .await
        .expect("未知字段不应拦解析");

    assert_eq!(got, vec![card("one", "a/a/one", "a/a", 10)]);
}

// ---------------------------------------------------------------- 5/6. 错误映射

#[tokio::test]
async fn http_400_maps_to_net_plaza_search() {
    let server = MockServer::start().await;
    let body = serde_json::json!({"error": "Query must be at least 2 characters"}).to_string();
    mount_search(&server, "q4", body, 400).await;

    let err = plaza::search(&http(), &server.uri(), "q4")
        .await
        .expect_err("400 应当映射成错误");

    assert_eq!(err.code, "NET_PLAZA_SEARCH");
    assert_eq!(err.message, "技能广场搜索失败,请稍后重试");
}

#[tokio::test]
async fn non_json_body_maps_to_net_plaza_search() {
    let server = MockServer::start().await;
    mount_search(&server, "q5", "<html>not json at all</html>".to_string(), 200).await;

    let err = plaza::search(&http(), &server.uri(), "q5")
        .await
        .expect_err("非 JSON 响应应当映射成错误");

    assert_eq!(err.code, "NET_PLAZA_SEARCH");
    assert_eq!(err.message, "技能广场搜索失败,请稍后重试");
}

// ---------------------------------------------------------------- 7. 短 query 零请求

#[tokio::test]
async fn short_query_sends_zero_requests() {
    let server = MockServer::start().await;
    // 任何路径的任何请求都不该发生——挂一个"来什么都接"的桩,期望零命中。
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;

    // " a " 去空白后只剩 1 个字符,不足 2 字符的边界。
    let got = plaza::search(&http(), &server.uri(), " a ")
        .await
        .expect("不足 2 字符应返回 Ok(空),不是错误");

    assert!(got.is_empty());
}

// ---------------------------------------------------------------- 8. 请求形状

#[tokio::test]
async fn request_hits_the_expected_path_and_query_params() {
    let server = MockServer::start().await;
    let body = serde_json::json!({
        "skills": [{"id": "a/a/one", "name": "one", "installs": 1, "source": "a/a"}]
    })
    .to_string();
    // 严格匹配路径与 q/limit 值;匹配不上 wiremock 不会命中这条桩,search 就会
    // 拿到默认的 404,从而以 NET_PLAZA_SEARCH 报错——本测试断言"确实命中且只命中一次"。
    Mock::given(method("GET"))
        .and(path("/api/search"))
        .and(query_param("q", "hello"))
        .and(query_param("limit", "20"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .expect(1)
        .mount(&server)
        .await;

    let got = plaza::search(&http(), &server.uri(), "hello")
        .await
        .expect("路径与查询参数都对得上,应当命中桩");

    assert_eq!(got, vec![card("one", "a/a/one", "a/a", 1)]);
}
