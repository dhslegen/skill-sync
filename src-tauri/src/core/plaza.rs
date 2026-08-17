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
//! # blob 取数(M10 任务 1)
//!
//! M9 的详情/安装都借道 `core::github` 的 zipball 机制——为看一个技能下整个仓,
//! 真机实测 3MB/50s(`wshobson/agents`)。skills.sh 另有一个 blob 快照端点
//! (`GET /api/download/{owner}/{repo}/{slug}`)只回该技能目录的文件,同一个样本
//! 14KB/0.57s。[`fetch_blob`] 是这个端点的取数原语。
//!
//! **它不是"新协议",是"新体积"**:内容与 zipball 里的同名文件逐字节相同——
//! 已用 3 个真实技能(单文件纯英文 / 多文件带子目录 / 单文件大段中文)现场验证过,
//! 见 `tests/plaza_blob_live.rs` 与任务报告。这正是"安装也能走 blob"的地基:
//! 商店索引里的 `content_hash` 是从 zipball 算的(`store::remote_content_hash`),
//! 装的字节必须与它对得上,否则界面会永远误报"有更新"。
//! **本任务只给原语与实证,不接入安装/详情路径**——那是任务 2/3 的事。
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

use crate::core::gitea;
use crate::core::registry::PLAZA_REGISTRY_ID;
use crate::core::store;
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

// ==================================================================== blob 取数(M10 任务 1)

/// blob 快照返回的一个文件。
///
/// **`contents` 必须按字节使用**:上游给的是 JSON 字符串,但落盘与内容 hash
/// (`fsops::dir_content_hash`/`store::remote_content_hash`)一律按 `as_bytes()` 走。
/// UTF-8 下字符数与字节数不对等——本模块 live 等价性测试里的真实样本(2026-08-17
/// 实测)`SKILL.md` 字符长 13112、编码后 13225 字节,按 `.len()`(字符数)去比就会
/// 得出错误结论。这是 [`fetch_blob`] 存在的意义:调用方(任务 3 的安装路径)拿到手的
/// 就是"该按字节处理"的 `String`,不必也不应该自己再去猜。
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct BlobFile {
    /// 技能目录**内**的相对路径(如 `SKILL.md`、`references/foo.md`),不带仓/技能目录前缀
    /// ——与 `store::SkillFile::path` 同一口径,拼落盘路径时直接 join。
    pub path: String,
    pub contents: String,
}

/// 单个文件的宽容解析形态:字段全 `Option`,缺失整条跳过(与 [`RawSkill`]/[`to_card`]
/// 同一套"单条脏数据不拖垮整批"的姿势)。
#[derive(Debug, Deserialize)]
struct RawBlobFile {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    contents: Option<String>,
}

/// 顶层响应形态。上游还带一个 `hash` 字段(它自己的内容指纹口径),我们不用
/// ——本 app 有自己的 `fsops::dir_content_hash`/`store::remote_content_hash`,两套口径
/// 混用只会制造第二种"应该相等却对不上"的坑,所以这里干脆不反序列化它,serde 默认忽略。
#[derive(Debug, Deserialize)]
struct BlobResponse {
    #[serde(default)]
    files: Vec<RawBlobFile>,
}

fn plaza_blob_err(detail: String) -> AppError {
    AppError::new("NET_PLAZA_BLOB", "获取技能内容失败,请稍后重试").with_detail(detail)
}

/// 把响应体解析成文件列表。纯逻辑,不碰网络,方便直接单测。缺 `path`/`contents`
/// 任一字段的条目跳过,不让整批解析失败。
fn parse_blob_files(body: &str) -> Result<Vec<BlobFile>, AppError> {
    let parsed: BlobResponse = serde_json::from_str(body).map_err(|e| {
        plaza_blob_err(format!(
            "{e}; body={}",
            body.chars().take(400).collect::<String>()
        ))
    })?;
    let files = parsed
        .files
        .into_iter()
        .filter_map(|f| {
            let path = f.path?;
            let contents = f.contents?;
            Some(BlobFile { path, contents })
        })
        .collect();
    Ok(files)
}

/// blob 快照:`GET {api_base}/api/download/{owner}/{repo}/{slug}`。
///
/// 宽容解析(见 [`parse_blob_files`]);网络错误 / 非 200 / 整体解析失败统一映射为
/// `AppError("NET_PLAZA_BLOB", ..)`——与 [`search`] 同一套"错误码只分类不分因"的姿势,
/// 前端只需要一种"获取失败,请稍后重试"的降级展示。
///
/// `http` 必须是 [`crate::core::gitea::app_http_client_proxied`] 构造的 client
/// (模块级文档已述:外部源跟随系统代理)。
pub async fn fetch_blob(
    http: &reqwest::Client,
    api_base: &str,
    owner: &str,
    repo: &str,
    slug: &str,
) -> Result<Vec<BlobFile>, AppError> {
    let base = api_base.trim_end_matches('/');
    let url = format!("{base}/api/download/{owner}/{repo}/{slug}");

    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| plaza_blob_err(e.to_string()))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| plaza_blob_err(e.to_string()))?;
    if !status.is_success() {
        return Err(plaza_blob_err(format!(
            "HTTP {status}: {}",
            body.chars().take(400).collect::<String>()
        )));
    }

    parse_blob_files(&body)
}

fn plaza_repo_err(detail: String) -> AppError {
    AppError::new("NET_PLAZA_REPO", "无法获取该技能库信息,请稍后重试").with_detail(detail)
}

/// 探测某个 GitHub 仓库的默认分支(挂仓预检,M9 任务 3)。
///
/// `GET {api_base}/repos/{owner}/{repo}`,取响应体的 `default_branch` 字段。
///
/// # 与 `github::GithubClient::repo_view` 的关系(2026-08-12 审查后重构)
///
/// 两者是**同一个外部契约的两个调用方**:GitHub `/repos/{owner}/{repo}` 端点、
/// 同一个 [`crate::core::github::RepoView`] 结构(含 `default_branch` 字段)、同一套
/// 状态码判定——URL 构造、鉴权头、状态码分档、JSON 解析全部只在
/// [`crate::core::github::fetch_repo_view`] 里维护一份,这里不再自己拼 URL 或解析
/// JSON。**唯一的分叉在错误处理**,而且分叉发生在这里(调用方),不在共享函数里:
/// `repo_view` 把 401/403/404/5xx 分档人话原样透给用户,这里把**任意** `Err`
/// 统一改写成 `NET_PLAZA_REPO`——广场挂仓探测只需要一种"探测失败,请稍后重试"的
/// 降级展示,不需要用户分辨具体是哪一种。
///
/// 匿名请求(广场技能公开可读,同内建源"读永远匿名"的先例,见 `registry.rs`
/// `ResolvedRegistry::auth_config` 的注释)。响应缺 `default_branch` 字段(或该字段
/// 为空串)按错误处理——这不是共享契约的一部分,是广场自己的业务要求(挂仓必须拿到
/// 一个可用的分支名),所以判定留在这一层,不下沉进共享函数。
pub async fn default_branch(
    http: &reqwest::Client,
    api_base: &str,
    owner: &str,
    repo: &str,
) -> Result<String, AppError> {
    let base = api_base.trim_end_matches('/');
    let view = crate::core::github::fetch_repo_view(http, None, base, owner, repo)
        .await
        .map_err(|e| {
            plaza_repo_err(format!(
                "{}: {}",
                e.code,
                e.detail.as_deref().unwrap_or(&e.message)
            ))
        })?;
    if view.default_branch.is_empty() {
        return Err(plaza_repo_err(format!(
            "响应缺少 default_branch 字段(owner={owner} repo={repo})"
        )));
    }
    Ok(view.default_branch)
}

/// 拉某个仓库现有全部技能的详情(广场专用,M9 任务 4)。
///
/// **这是详情面板"不联网"承诺的唯一破例,范围钉死在广场**(设计文档 §2.2):
/// 内建源/已有自定义源的详情依旧全部来自 `store.rs` 的索引缓存,一个字没改;
/// 这个函数是新路径,只有 `commands::plaza_detail` 会调它。
///
/// 复用 `store.rs` 既有的技能发现:branch_head + download_archive 拿到压缩包后,
/// 直接调**既有的** `store::build_index`(禁止把发现逻辑抄第二遍),再用它自带的
/// `detail()` 把每个技能转成与商店详情面板同一份 DTO(`store::SkillDetail`)——
/// 前端拿到手的数据形状不必区分"这是广场还是商店"。
///
/// **不落盘**:这条路径服务的是"很可能从未安装过"的仓,给它建一份索引缓存文件
/// 只会积累孤儿文件。进程内缓存是调用方(`commands::plaza_detail`)的事,
/// 这里每次调用都会现拉一次。
///
/// `registry_id` 固定传 [`PLAZA_REGISTRY_ID`]:`build_index` 只把它原样记进
/// `StoreIndex.registry_id`,`detail()` 用不到这个字段,不影响返回结果。
pub async fn fetch_repo_skills(
    source: &impl gitea::RepoSource,
    repo: &gitea::RepoRef,
) -> Result<Vec<store::SkillDetail>, AppError> {
    let head = source.branch_head(repo).await?;
    let archive = source.download_archive(repo).await?;
    // fetched_at 不进 SkillDetail(那是索引/缓存层的字段,不落盘就没有意义),给 0 即可。
    let index = store::build_index(PLAZA_REGISTRY_ID, repo, &head, &archive, 0);
    Ok(index.skills.iter().filter_map(|s| index.detail(&s.dir_slug)).collect())
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

    // `default_branch` 的响应体解析(JSON 形状、缺字段判定)现在完全委派给
    // `github::fetch_repo_view` + 本函数末尾的 `is_empty()` 判定,不再有独立的纯解析
    // 函数可测——覆盖挪到 tests/plaza_default_branch.rs 的 wiremock 测试里
    // (含"200 但缺 default_branch 字段"这条,2026-08-12 审查重构时新增,
    // 防止拆掉 parse_default_branch 之后这条业务规则悄悄失去覆盖)。
}
