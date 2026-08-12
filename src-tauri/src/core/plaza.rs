//! 技能广场:接入 skills.sh 搜索 API 做发现(M9 任务 1)。
//!
//! 调查见 `docs/调查-npx-skills-find-开放API.md`(本地文档,不进版本控制)。核心结论:
//! **不是开放 API,是 CLI(`npx skills find`)恰好在调的内部端点**——无文档、无版本号、
//! 无 SLA。设防姿势对应两条:
//! - **宽容解析**:只取要的字段,单条缺 `name`/`source`/`id` 的脏数据跳过,不拖垮整批;
//! - **单一错误码**:网络错误 / 非 200 / 整体解析失败统一映射成 `NET_PLAZA_SEARCH`,
//!   前端只需要一种"搜索失败,请稍后重试"的降级展示,不必区分是断网还是端点变了形状。
//!
//! 这个模块**只管发现**:结果里的 `owner_repo` 就是 GitHub `owner/repo`,安装/更新
//! 零新协议——直接复用既有 `core::github` 的 `RepoSource` 机制(M3/M4 已实现并 e2e 验证)。
//!
//! # 请求走外部源的 client
//!
//! skills.sh 是外部服务,调用方必须传入 [`crate::core::gitea::app_http_client_proxied`]
//! 构造的 client(跟随系统代理,M3 决策)——本模块不自己构造 client,以免悄悄绕开该策略。
//! 该 client 已带统一 UA(`SkillSync/<version>`),GitHub 系服务对无 UA 请求一律 403 的
//! 历史教训在这里同样适用。
//!
//! # 字段口径(2026-08-12 用户对 brief 歧义的裁决)
//!
//! 上游响应每条技能同时带 `id`(`owner/repo/skill-name`)与 `skillId`(纯技能名)两个字段。
//! [`PlazaSkillCard::slug`] 取 **`id`**,用于拼 `https://skills.sh/<slug>` 页面地址;
//! `skillId` 不使用。
//!
//! # 关于"零请求"与"单一错误码"
//!
//! `query` 去空白后不足 2 字符时**不发请求**直接返回空结果——这是上游 400 的边界
//! (`{"error":"Query must be at least 2 characters"}`,调查报告实测),提前拦掉比
//! 等对方 400 更省一次往返,也省了一条错误分支。

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// skills.sh 搜索 API 的 base。公开地址,硬编码不涉铁律 5(铁律 5 管的是内网地址与
/// OAuth secret);测试经参数注入 wiremock,不依赖这个常量本身可覆盖。
pub const PLAZA_API_BASE: &str = "https://skills.sh";
/// 与上游 CLI(`npx skills find`)同款的默认 limit。
pub const PLAZA_SEARCH_LIMIT: u32 = 20;
/// 挂仓时探测 `default_branch` 用的 GitHub REST API base(M9 任务 3)。
/// 与 [`PLAZA_API_BASE`] 是两个不同域名:后者只用于 skills.sh **搜索**,
/// 广场技能一旦要装,坐标就落到 `github.com`——与 `core::registry::PLAZA_BASE_URL`
/// (`https://github.com`,给 `resolve()`/lock `sourceUrl` 用)一体两面,
/// 这里是它的 REST API 形态。
pub const PLAZA_GITHUB_API_BASE: &str = "https://api.github.com";

/// 一条技能广场搜索结果,供前端渲染卡片。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlazaSkillCard {
    /// 上游 `skills[].name`,经字段缺失过滤。
    pub name: String,
    /// 上游 `skills[].id`(形如 `owner/repo/skill-name`),拼 skills.sh 页面 URL 用。
    pub slug: String,
    /// 上游 `skills[].source`(`owner/repo`),详情与安装的寻址键——直接喂给既有
    /// GitHub 源机制。
    pub owner_repo: String,
    /// 全网安装量,缺失按 0(上游字段本身可能是 0,不代表数据坏了)。
    pub installs: u64,
}

/// 上游单条技能的宽容解析形态:字段全部 `Option`,缺失不报错、留给上一层过滤。
#[derive(Debug, Deserialize)]
struct RawSkill {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    installs: Option<u64>,
}

/// 上游搜索响应的顶层形态。只取 `skills` 数组,`query`/`searchType`/`count`/
/// `duration_ms` 等字段照单全收地忽略(serde 默认行为)——这正是"宽容"的体现:
/// 上游加字段不改这里的形状。
#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    skills: Vec<RawSkill>,
}

/// `query` 去空白后是否不足 2 个字符(上游 400 的边界)。
fn query_too_short(query: &str) -> bool {
    query.trim().chars().count() < 2
}

/// 把一条上游原始记录过滤/映射成展示用的卡片。
/// 缺 `name`、`source`、`id` 任意一个都视为脏数据跳过——`id` 虽然 brief 没有点名
/// 必填,但它是拼 skills.sh 页面链接的唯一来源,没有它这张卡片点不出详情页,
/// 保守起见按同等的"脏数据"处理。
fn to_card(raw: RawSkill) -> Option<PlazaSkillCard> {
    let name = raw.name?;
    let owner_repo = raw.source?;
    let slug = raw.id?;
    Some(PlazaSkillCard { name, slug, owner_repo, installs: raw.installs.unwrap_or(0) })
}

/// 把响应体解析成按 `installs` 降序排列的卡片列表。纯逻辑,不碰网络,方便直接单测。
fn parse_cards(body: &str) -> Result<Vec<PlazaSkillCard>, AppError> {
    let parsed: SearchResponse = serde_json::from_str(body).map_err(|e| {
        plaza_search_err(format!(
            "{e}; body={}",
            body.chars().take(400).collect::<String>()
        ))
    })?;
    let mut cards: Vec<PlazaSkillCard> = parsed.skills.into_iter().filter_map(to_card).collect();
    // 稳定排序:installs 相同时保留上游给的相对顺序,不引入无意义的抖动。
    cards.sort_by_key(|c| std::cmp::Reverse(c.installs));
    Ok(cards)
}

fn plaza_search_err(detail: String) -> AppError {
    AppError::new("NET_PLAZA_SEARCH", "技能广场搜索失败,请稍后重试").with_detail(detail)
}

/// 搜索 skills.sh。
///
/// `query` 去空白后不足 2 字符直接返回 `Ok(空)`(上游 400 的边界,与上游 CLI 行为一致,
/// 也省一次注定失败的往返)。网络错误 / 非 200 / 整体解析失败统一映射为
/// `AppError("NET_PLAZA_SEARCH", ..)`;单条缺 `name`/`source`/`id` 的脏数据跳过不失败;
/// 结果按 `installs` 降序。
pub async fn search(
    http: &reqwest::Client,
    api_base: &str,
    query: &str,
) -> Result<Vec<PlazaSkillCard>, AppError> {
    if query_too_short(query) {
        return Ok(Vec::new());
    }
    let trimmed = query.trim();
    let base = api_base.trim_end_matches('/');
    // 手动拼查询串而不是 reqwest 的 `.query()`:项目没开该 crate feature
    // (auth.rs 的 OAuth 授权 URL 就是这么拼的,同一个套路)。
    let mut url = url::Url::parse(&format!("{base}/api/search"))
        .map_err(|e| plaza_search_err(format!("坏的 api_base: {e}")))?;
    url.query_pairs_mut()
        .append_pair("q", trimmed)
        .append_pair("limit", &PLAZA_SEARCH_LIMIT.to_string());

    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| plaza_search_err(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| plaza_search_err(e.to_string()))?;
    if !status.is_success() {
        return Err(plaza_search_err(format!(
            "HTTP {status}: {}",
            body.chars().take(400).collect::<String>()
        )));
    }

    parse_cards(&body)
}

/// 上游仓库视图的宽容解析形态,只取挂仓要用的一个字段。
#[derive(Debug, Deserialize)]
struct RawRepoView {
    #[serde(default)]
    default_branch: Option<String>,
}

fn parse_default_branch(body: &str) -> Result<String, AppError> {
    let parsed: RawRepoView = serde_json::from_str(body).map_err(|e| {
        plaza_repo_err(format!(
            "{e}; body={}",
            body.chars().take(400).collect::<String>()
        ))
    })?;
    parsed.default_branch.filter(|b| !b.is_empty()).ok_or_else(|| {
        plaza_repo_err(format!(
            "响应缺少 default_branch 字段; body={}",
            body.chars().take(400).collect::<String>()
        ))
    })
}

fn plaza_repo_err(detail: String) -> AppError {
    AppError::new("NET_PLAZA_REPO", "无法获取该技能库信息,请稍后重试").with_detail(detail)
}

/// 探测某个 GitHub 仓库的默认分支(挂仓预检,M9 任务 3)。
///
/// `GET {api_base}/repos/{owner}/{repo}`,取响应体的 `default_branch` 字段。
///
/// # 为什么不直接调 `github::GithubClient::repo_view`
///
/// 先查过了(brief 明确要求):`github.rs` 确有等价读原语 `repo_view`,形状与本函数
/// 要做的事完全一致。但它挂在 `GithubClient::new(base_url, ..)` 上,`api_base` 由
/// `api_base_for(base_url)` **派生**(非 `github.com` 主机一律补 `/api/v3`,GHE 语义)。
/// 广场的访问坐标是固定常量,没有"派生"这回事——硬套会强迫这里的测试也去扮演一个
/// GHE 实例(挂在 `/api/v3` 之下),平白引入一段与广场毫不相关的形状。这里走与同文件
/// [`search`] 一致的自包含风格(手动拼 URL、自行错误映射),不是重新发明轮子,
/// 是把 `search` 已验证过的"自包含"套路原样用在第二个端点上。
///
/// 匿名请求(广场技能公开可读,同内建源"读永远匿名"的先例,见 `registry.rs`
/// `ResolvedRegistry::auth_config` 的注释);404 / 网络错误 / 解析失败一律统一
/// 映射为 `AppError("NET_PLAZA_REPO", ..)`——与 `search` 的"单一错误码"同一套设防姿势。
pub async fn default_branch(
    http: &reqwest::Client,
    api_base: &str,
    owner: &str,
    repo: &str,
) -> Result<String, AppError> {
    let base = api_base.trim_end_matches('/');
    let url = format!("{base}/repos/{owner}/{repo}");

    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| plaza_repo_err(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| plaza_repo_err(e.to_string()))?;
    if !status.is_success() {
        return Err(plaza_repo_err(format!(
            "HTTP {status}: {}",
            body.chars().take(400).collect::<String>()
        )));
    }

    parse_default_branch(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 纯逻辑,不碰网络:query 去空白后长度判定的边界。真正的"零请求"断言(wiremock
    // 记零次命中)在 tests/plaza_search.rs——那条测的是"没发请求"这个网络层事实,
    // 这里测的是"判定本身对不对",两者不是同一条规则的重复检查。
    #[test]
    fn query_too_short_trims_before_counting() {
        assert!(query_too_short(""));
        assert!(query_too_short(" "));
        assert!(query_too_short(" a "));
        assert!(!query_too_short("ab"));
        assert!(!query_too_short(" ab "));
        // 中文字符按 char 计数,不是按字节——"技" 单字符不足,"技能" 两字符够。
        assert!(query_too_short("技"));
        assert!(!query_too_short("技能"));
    }

    // 纯逻辑,不碰网络:响应体解析的边界情形。真正的"发对了请求 / 状态码映射"
    // 在 tests/plaza_default_branch.rs(wiremock)。
    #[test]
    fn parse_default_branch_reads_the_field() {
        let branch = parse_default_branch(r#"{"default_branch":"main","full_name":"a/b"}"#)
            .expect("正常响应应解析成功");
        assert_eq!(branch, "main");
    }

    #[test]
    fn parse_default_branch_rejects_a_missing_or_empty_field() {
        assert_eq!(
            parse_default_branch(r#"{"full_name":"a/b"}"#).unwrap_err().code,
            "NET_PLAZA_REPO"
        );
        assert_eq!(
            parse_default_branch(r#"{"default_branch":""}"#).unwrap_err().code,
            "NET_PLAZA_REPO"
        );
    }

    #[test]
    fn parse_default_branch_rejects_unparseable_bodies() {
        assert_eq!(parse_default_branch("不是 json").unwrap_err().code, "NET_PLAZA_REPO");
    }
}
