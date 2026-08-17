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
//! 任务 1 只给原语与实证,不接安装/详情路径。
//!
//! # 安装走 blob(M10 任务 3)
//!
//! 装的时候也优先试 blob,不下整仓压缩包——同一个道理,同一份地基(任务 1 的
//! 等价性实证)。但安装比详情([`fetch_skill_detail_via_blob`])多两条硬约束,
//! 都是"信息会真的落进持久数据"逼出来的:
//!
//! 1. **blob 落盘会丢可执行位**(上面 ground truth 2:上游 v1.5.22 只在
//!    zipball/clone 路径 `chmod`,`skill.files` 那条只有 `writeFile`)。所以只有
//!    "确定不需要执行位"的纯文本扩展名才允许走 blob——白名单见
//!    [`all_files_blob_installable`]:任何一个文件不在白名单里,**整个技能**回退
//!    zipball,不是"跳过那一个文件"。
//!
//! 2. 🔴 **blob 端点不给仓库内的真实相对路径**(它的 `slug` 参数是"技能目录名",
//!    不是路径——`wshobson/agents` 的 `code-review-excellence`,真实路径是
//!    `plugins/developer-essentials/skills/code-review-excellence`)。任务 2 的
//!    详情面板能把这个信息缺口混过去(`SkillDetail.path` 退化填目录名,因为已核实
//!    详情面板从不渲染这个字段);**安装不能**——这个值会被 `acquire::record`
//!    真实写进 `state.installed[].source.path` 与外部契约 `.skill-lock.json` 的
//!    `skillPath`,`share.rs` 还拿它去定位"分享改动"要提交到仓库的哪个目录。
//!    写错等于制造下一个 M6 sourceUrl/sourceType 那种坑(字段形状写错,下游判定
//!    静默失灵,只有真的走到那条路径才会暴露)。
//!
//!    2026-08-17 拍板选项 A:额外发一次 `GET /repos/{o}/{r}/git/trees/{sha}?
//!    recursive=1`([`crate::core::github::GithubClient::tree`],只回路径不回内容,
//!    实测同一个样本 502,100 字节/5.55 秒,`truncated: false`,仍远小于
//!    3,149,975 字节/50.4 秒的 zipball——这也是上游 `npx skills` 自己的做法,
//!    `blob.ts` 第一步就是"Trees API → discover SKILL.md locations",不是本 app
//!    独创),在树里找"以技能目录名结尾、目录下有 SKILL.md"的**唯一**匹配
//!    ([`crate::core::github::resolve_skill_path`])。树被截断、零匹配、多个
//!    同名目录——任何一种都不敢猜,一律回退 zipball(方案 B「只给更新走 blob」
//!    放弃了首次安装提速这个核心收益;方案 C「path 退化成目录名」会把错误路径
//!    写进持久数据与外部契约,均已否决)。
//!
//! 这两条检查任一不过,本节的函数就返回 `Err`,调用方(`commands::skill_install`)
//! 静默回退到完全不动的 [`fetch_repo_skills`](zipball)全链路——与详情面板同一套
//! "宁可少加速一次,也不猜一个可能错的结果"的姿势。安装本身仍然**完整走
//! `acquire::acquire_prefetched`**(与 `acquire::acquire` 共用预检/落盘/记账那条
//! 尾巴,见该函数文档)——blob 只换掉了"取数"那一步,冲突判定、
//! `Installer::install` 的清空重建保护、`.skill-lock.json` 双写口径一个字都没有分叉。
//!
//! # 详情走 blob(M10 任务 2)
//!
//! [`fetch_skill_detail_via_blob`] 是详情面板的新首选路径:88 倍提速的对象是
//! **用户点开的那一个技能**,不是整仓。它与 [`fetch_repo_skills`](zipball)
//! 完全独立、互不改动——`commands::plaza_detail` 按"blob 能不能满足这次点击"
//! 二选一,blob 失败或结果与点开的搜索结果对不上,一律回退 zipball,
//! "多技能仓、名字对不上时显示列表"这条 M9 任务 5 的既有行为原样保留
//! (细节与判据见该函数文档)。安装路径**这次没动**,仍然是任务 3 的事。
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
use crate::core::installer::SkillPayload;
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

pub(crate) fn plaza_blob_err(detail: String) -> AppError {
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

// ============================================================ 详情走 blob(M10 任务 2)

/// 从 skills.sh 的 `id`(`PlazaSkillCard::slug`,形如 `owner/repo/skill-name`)里
/// 抠出 [`fetch_blob`] 要的那个"纯技能名"参数。
///
/// 要求 `id` 恰好以 `{owner}/{repo}/` 开头,且剩下的部分不再含 `/`——这是模块头
/// 记的上游约定(`id` 三段式,`skillId` 是"纯技能名"、没有更深的路径)。
/// 形状对不上就返回 `None`,调用方据此放弃 blob 快路径、直接回退现有 zipball 路径
/// (**保守**:宁可少用一次加速,也不猜一个可能是错的技能名去发请求)。
fn skill_name_from_id<'a>(id: &'a str, owner: &str, repo: &str) -> Option<&'a str> {
    let rest = id.strip_prefix(&format!("{owner}/{repo}/"))?;
    (!rest.is_empty() && !rest.contains('/')).then_some(rest)
}

/// 把 blob 快照的文件列表拼成一份 [`store::SkillDetail`](单个技能,不做仓内发现)。
///
/// **不调用 `skills::discover_skills`**:blob 端点本身已经按 slug 精确定位到了
/// 唯一一个技能目录,不存在"这堆文件里哪个子目录是技能"这个要发现的问题——
/// 需要发现的场景(多技能仓、目录结构未知)本就走不通 blob,天然回退 zipball。
///
/// - `skill_md` 取文件列表里的 [`crate::core::skills::SKILL_FILE`],缺失或
///   frontmatter 解析失败一律映射 `NET_PLAZA_BLOB`——调用方按"blob 不可用"处理,
///   不新开错误分叉(与 [`fetch_blob`] 同一套"错误码只分类不分因"姿势)。
/// - `has_scripts` 复用 `skills::is_script_extension`(同一份扩展名表,见该函数文档)
///   ——blob 的文件路径本来就是技能目录内的相对路径,不需要再剥前缀。
/// - `path`/`tags`/`attribution` 是这条路径**拿不到**的信息(blob 端点不给仓内完整
///   路径,也不读库根的 tags.json/authors.json——那两个文件多数广场仓根本没有,
///   为它们多发请求违反 brief"不为 blob 做防腐层"的边界):`path` 退而求其次填
///   技能目录名本身(这是**真值的一部分**,不是编造;而且广场详情面板压根不渲染
///   `SkillDetail.path`,见 `DetailPanel.tsx` 的 `PanelBody`,`LocalPanelBody` 才用它);
///   `tags` 给空、`attribution` 给 `None`,与"库里没有这两个文件"时的既有语义完全一致
///   (`IndexedSkill.tags`/`attribution` 本来就是"没有就不摆",不算新行为)。
/// - **`internal` 标记的技能一律当作 blob 不适用**:zipball 路径的
///   `discover_skills` 默认排除 `metadata.internal: true` 的技能
///   (`DiscoverOptions::default()`),blob 路径必须复现同一条规则,否则"某技能仓的
///   internal 技能不该出现在结果里"这条既有行为会被 blob 快路径悄悄破坏。
fn detail_from_blob_files(
    dir_slug: &str,
    files: Vec<BlobFile>,
    commit_sha: String,
    committed_at: String,
) -> Result<store::SkillDetail, AppError> {
    let skill_md = files
        .iter()
        .find(|f| f.path == crate::core::skills::SKILL_FILE)
        .map(|f| f.contents.clone())
        .ok_or_else(|| {
            plaza_blob_err(format!(
                "blob 响应缺少 {}(dir_slug={dir_slug})",
                crate::core::skills::SKILL_FILE
            ))
        })?;

    let parsed = crate::core::skills::parse_skill_md(&skill_md)
        .map_err(|e| plaza_blob_err(format!("{}(dir_slug={dir_slug})", e.reason())))?;
    if parsed.internal {
        return Err(plaza_blob_err(format!(
            "该技能标记为 internal,按既有规则不进结果(dir_slug={dir_slug})"
        )));
    }

    let has_scripts = files.iter().any(|f| crate::core::skills::is_script_extension(&f.path));
    let skill_files = files
        .iter()
        .map(|f| store::SkillFile {
            path: f.path.clone(),
            // `String::len()` 本就是字节数(UTF-8 编码长度),不是字符数——与
            // `fetch_blob` 文档反复强调的"contents 必须按字节用"是同一件事,
            // 这里不必也不该再写 `.as_bytes().len()`(clippy::needless_as_bytes)。
            size: Some(f.contents.len() as u64),
        })
        .collect();

    Ok(store::SkillDetail {
        name: parsed.name,
        dir_slug: dir_slug.to_string(),
        description: parsed.description,
        path: dir_slug.to_string(),
        skill_md,
        files: skill_files,
        has_scripts,
        commit_sha,
        committed_at,
        tags: Vec::new(),
        attribution: None,
    })
}

/// 给「用户点开的这一个技能」拼详情(M10 任务 2):优先 blob 快照,只取这一个技能,
/// 不下整仓。
///
/// **只服务这一次点击,不是"广场详情的新实现"**——与 [`fetch_repo_skills`](整仓/
/// zipball)是两条独立路径,调用方(`commands::plaza_detail`)按"blob 能不能满足
/// 这次点击"二选一,绝不混用。以下任一情况都视为"blob 不适用",返回 `Err` 让调用方
/// 静默回退到完全不动的 [`fetch_repo_skills`] 路径(brief 明确要求:回退场景**必须**
/// 走 zipball,不能用这条路径凑合出一个只有一项的"列表"):
/// - `skill_slug` 形状不对(见 [`skill_name_from_id`]);
/// - blob 请求失败(404/超时/解析失败,见 [`fetch_blob`]);
/// - 技能标记为 `internal`(见 [`detail_from_blob_files`]);
/// - **blob 拿到的技能名与用户点开那条搜索结果的名字对不上**——这正是 M9 任务 5
///   "多技能仓、名字对不上时显示列表"的既有判据(前端 `locatePlazaSkill` 同款字段),
///   对不上就必须落到能展示完整候选列表的 zipball 路径,而不是只给用户看这一个
///   可能文不对题的结果。
///
/// `source`/`repo` 用于 [`gitea::RepoSource::branch_head`] 拿准确的
/// `commit_sha`/`committed_at`(轻量请求,几百字节;这里不用 `download_archive`)。
pub async fn fetch_skill_detail_via_blob(
    source: &impl gitea::RepoSource,
    repo: &gitea::RepoRef,
    blob_http: &reqwest::Client,
    blob_api_base: &str,
    id: &str,
    wanted_name: &str,
) -> Result<store::SkillDetail, AppError> {
    let skill_slug = skill_name_from_id(id, &repo.owner, &repo.repo)
        .ok_or_else(|| plaza_blob_err(format!("无法从 id 解出技能名: {id}")))?;

    let head = source.branch_head(repo).await?;
    let files = fetch_blob(blob_http, blob_api_base, &repo.owner, &repo.repo, skill_slug).await?;
    let detail = detail_from_blob_files(skill_slug, files, head.sha, head.committed_at)?;

    if detail.name != wanted_name {
        return Err(plaza_blob_err(format!(
            "blob 技能名({})与点击的搜索结果名({wanted_name})不一致,回退整仓路径",
            detail.name
        )));
    }
    Ok(detail)
}

// ============================================================ 安装走 blob(M10 任务 3)
//
// 判据与设计理由见模块头「安装走 blob」一节(尤其是 path 缺口那一条,2026-08-17 拍板)。
// 这里只放实现:三个纯逻辑函数(白名单判定、候选检查、拼装),各自独立可测,
// 网络编排(branch_head → fetch_blob → 候选检查 → trees → resolve_skill_path →
// 拼装)留给调用方 `commands::skill_install`(它需要访问 `GithubClient::tree` 与
// 进程级缓存,那两样都不该让 `core::plaza` 认识——plaza 是 skills.sh 的模块)。

/// blob 落盘不写权限位,只有"不可能需要执行位"的扩展名才允许走安装快路径
/// (见模块头 ground truth 2)。
const BLOB_INSTALL_SAFE_EXTS: &[&str] = &["md", "txt", "json", "yaml", "yml", "toml", "csv"];

/// 单个文件是否"纯文本、不可能需要执行位"。
///
/// 判据:扩展名在保守白名单里,**且**不是 [`crate::core::skills::is_script_extension`]
/// 认定的脚本扩展名——后者是第二道防线,哪怕白名单将来被误改动收进了脚本类后缀,
/// 这里也会把它拦下(不是重复维护第二份扩展名表,是同一份表当两次判据用)。
/// 大小写不敏感(`.MD` 与 `.md` 等价);多重扩展名按 `Path::extension()` 的语义只看
/// 最后一段(`archive.tar.gz` 取到的是 `gz`,不在白名单里,按不安全处理);
/// 没有扩展名的文件(如 `LICENSE`)直接判不安全——拿不准就回退,回退只是慢,
/// 残缺是错。
fn is_blob_install_safe(path: &str) -> bool {
    if crate::core::skills::is_script_extension(path) {
        return false;
    }
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| BLOB_INSTALL_SAFE_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// blob 返回的文件是否**全部**命中白名单——这是"整个技能能不能走安装快路径"的
/// 判据,不是逐文件挑着装:哪怕只有一个文件不安全,整个技能都回退 zipball。
/// 空列表不算"全部安全"(`fetch_blob` 正常不会返回空列表,这里是双保险)。
pub(crate) fn all_files_blob_installable(files: &[BlobFile]) -> bool {
    !files.is_empty() && files.iter().all(|f| is_blob_install_safe(&f.path))
}

/// 已经通过"能不能装"全部检查(仓内真实路径除外)的 blob 素材。
#[derive(Debug)]
pub(crate) struct BlobInstallCandidate {
    name: String,
    description: String,
    skill_md: String,
    files: Vec<BlobFile>,
}

/// 检查 blob 响应是否满足"能走安装快路径"的条件(仓内真实路径除外——那个要另发
/// 一次 trees 请求,由调用方决定要不要发,见模块头)。宁可回退:白名单不过、
/// 缺 [`crate::core::skills::SKILL_FILE`]、frontmatter 解析失败、`internal` 标记,
/// 任一条命中都返回 `Err`,错误码统一是 `NET_PLAZA_BLOB`(与 [`fetch_blob`] 同一套
/// "错误码只分类不分因"姿势)。
///
/// `internal` 检查复现的是 zipball 路径 `discover_skills`(`DiscoverOptions::
/// default()`)默认排除 `metadata.internal: true` 技能的既有行为——理论上装不到
/// 这一步(详情面板早已把它过滤掉,用户点不到安装按钮),留着是防御性的第二道门,
/// 与 [`detail_from_blob_files`] 同一套理由。
pub(crate) fn blob_install_candidate(
    dir_slug: &str,
    files: Vec<BlobFile>,
) -> Result<BlobInstallCandidate, AppError> {
    let skill_md = files
        .iter()
        .find(|f| f.path == crate::core::skills::SKILL_FILE)
        .map(|f| f.contents.clone())
        .ok_or_else(|| {
            plaza_blob_err(format!(
                "blob 响应缺少 {}(dir_slug={dir_slug})",
                crate::core::skills::SKILL_FILE
            ))
        })?;

    if !all_files_blob_installable(&files) {
        return Err(plaza_blob_err(format!(
            "含不在保守白名单内的文件,回退整仓路径(dir_slug={dir_slug})"
        )));
    }

    let parsed = crate::core::skills::parse_skill_md(&skill_md)
        .map_err(|e| plaza_blob_err(format!("{}(dir_slug={dir_slug})", e.reason())))?;
    if parsed.internal {
        return Err(plaza_blob_err(format!(
            "该技能标记为 internal,不走快路径(dir_slug={dir_slug})"
        )));
    }

    Ok(BlobInstallCandidate {
        name: parsed.name,
        description: parsed.description,
        skill_md,
        files,
    })
}

/// 仓内真实路径解不出来时的统一错误(树被截断 / 零匹配 / 多个同名目录,
/// 见 [`crate::core::github::resolve_skill_path`])——与 [`blob_install_candidate`]
/// 同一套 `NET_PLAZA_BLOB` 错误码,调用方按同一种"blob 不适用"处理,静默回退 zipball。
pub(crate) fn blob_path_unresolved_err(dir_slug: &str, sha: &str) -> AppError {
    plaza_blob_err(format!(
        "无法在仓库树中为 {dir_slug} 唯一定位到真实路径,回退整仓路径(commit={sha})"
    ))
}

/// 把已经过 [`blob_install_candidate`] 检查、且已经解出仓内真实路径(`repo_path`,
/// 来自 [`crate::core::github::resolve_skill_path`])的素材,拼成 `acquire` 编排要的
/// `(IndexedSkill, SkillPayload)`。纯逻辑,不碰网络。
///
/// - `path` 用调用方解出的真实路径(不是目录名近似值,见模块头「path 缺口」);
/// - `has_scripts` 恒 `false`——能走到这里说明全部文件都过了
///   [`all_files_blob_installable`],白名单里没有一个扩展名会被
///   `is_script_extension` 认作脚本;
/// - `content_hash` 留空:`acquire::finish`(`record`)算的是**落盘后**的
///   `fsops::dir_content_hash`,不读 `IndexedSkill.content_hash` 这个字段
///   ——与 zipball 路径共用同一份记账逻辑,这条"口径不许改"的护栏两条路径都遵守;
/// - `tags`/`attribution` 给空——blob 端点没有这些信息,与"库里没有
///   tags.json/authors.json"时的既有语义一致,不是新增的降级(与
///   [`detail_from_blob_files`] 同一套理由)。
pub(crate) fn finish_blob_install(
    dir_slug: &str,
    candidate: BlobInstallCandidate,
    repo_path: String,
) -> (store::IndexedSkill, SkillPayload) {
    let skill_files: Vec<store::SkillFile> = candidate
        .files
        .iter()
        .map(|f| store::SkillFile {
            path: f.path.clone(),
            size: Some(f.contents.len() as u64),
        })
        .collect();
    let payload = payload_from_blob_files(&candidate.files);

    let skill = store::IndexedSkill {
        name: candidate.name,
        dir_slug: dir_slug.to_string(),
        description: candidate.description,
        path: repo_path,
        skill_md: candidate.skill_md,
        files: skill_files,
        has_scripts: false,
        content_hash: String::new(),
        tags: Vec::new(),
        attribution: None,
    };
    (skill, payload)
}

/// blob 文件转换成待落盘的 payload。权限位一律用默认(`SkillPayload::with_file`,
/// 不调用 `with_executable`)——blob 端点不给 unix mode,上游落盘也不 `chmod`
/// (模块头 ground truth 2),且白名单已经把"可能需要执行位"的扩展名挡在外面,
/// 这里没有丢失任何本该保留的信息。
fn payload_from_blob_files(files: &[BlobFile]) -> SkillPayload {
    let mut payload = SkillPayload::new();
    for f in files {
        payload = payload.with_file(&f.path, f.contents.as_bytes());
    }
    payload
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

    // ======================================================== 安装白名单(M10 任务 3)

    fn f(path: &str) -> BlobFile {
        BlobFile { path: path.to_string(), contents: String::new() }
    }

    #[test]
    fn blob_install_safe_extensions_are_case_insensitive() {
        assert!(is_blob_install_safe("SKILL.md"));
        assert!(is_blob_install_safe("SKILL.MD"), "大小写不敏感");
        assert!(is_blob_install_safe("notes.Txt"));
    }

    #[test]
    fn blob_install_safe_takes_only_the_last_of_multiple_extensions() {
        // Path::extension() 只看最后一段:archive.tar.gz 取到的是 gz,不在白名单里。
        assert!(!is_blob_install_safe("archive.tar.gz"));
        // 反过来,最后一段在白名单里就放行,即便前一段"看起来"像别的东西。
        assert!(is_blob_install_safe("weird.name.json"));
    }

    #[test]
    fn blob_install_safe_rejects_files_without_an_extension() {
        // 拿不准就回退——没有扩展名一律不安全,即便文件名本身看着人畜无害。
        assert!(!is_blob_install_safe("LICENSE"));
        assert!(!is_blob_install_safe("README"));
    }

    #[test]
    fn blob_install_safe_rejects_unknown_extensions() {
        assert!(!is_blob_install_safe("logo.png"));
        assert!(!is_blob_install_safe("archive.zip"));
        assert!(!is_blob_install_safe("data.bin"));
    }

    #[test]
    fn blob_install_safe_rejects_script_extensions_even_if_whitelisted_by_mistake() {
        // 双保险:is_script_extension 是第二道防线。这里只验证现状(.sh 不在白名单里
        // 时自然被拒),放宽白名单后的红线由 tests/plaza_install_blob.rs 的注入验证钉住
        // ——那条测试要真的改源码才能复现,这里测的是"正常状态下 .sh 就是不安全"。
        for ext in ["sh", "bash", "zsh", "py", "js", "mjs", "ps1", "rb"] {
            assert!(!is_blob_install_safe(&format!("run.{ext}")), "脚本扩展名 .{ext} 不该安全");
        }
    }

    #[test]
    fn all_files_blob_installable_requires_every_file_to_pass() {
        assert!(all_files_blob_installable(&[f("SKILL.md"), f("references/foo.txt")]));
        assert!(!all_files_blob_installable(&[f("SKILL.md"), f("scripts/run.sh")]),
            "一个文件不安全,整个技能都不算能走 blob");
        assert!(!all_files_blob_installable(&[]), "空列表不算全部安全");
    }

    // ======================================================== blob_install_candidate

    fn skill_md_only(name: &str) -> Vec<BlobFile> {
        vec![BlobFile {
            path: crate::core::skills::SKILL_FILE.to_string(),
            contents: format!("---\nname: {name}\ndescription: 测试\n---\n\n正文\n"),
        }]
    }

    #[test]
    fn blob_install_candidate_accepts_a_pure_markdown_skill() {
        let candidate = blob_install_candidate("demo-skill", skill_md_only("演示技能")).unwrap();
        assert_eq!(candidate.name, "演示技能");
    }

    #[test]
    fn blob_install_candidate_rejects_when_skill_md_is_missing() {
        let err = blob_install_candidate("demo-skill", vec![f("notes.txt")]).unwrap_err();
        assert_eq!(err.code, "NET_PLAZA_BLOB");
    }

    #[test]
    fn blob_install_candidate_rejects_a_script_file() {
        let mut files = skill_md_only("演示技能");
        files.push(BlobFile { path: "scripts/run.sh".into(), contents: "#!/bin/sh\n".into() });
        let err = blob_install_candidate("demo-skill", files).unwrap_err();
        assert_eq!(err.code, "NET_PLAZA_BLOB");
    }

    #[test]
    fn blob_install_candidate_rejects_a_binary_file() {
        let mut files = skill_md_only("演示技能");
        files.push(BlobFile { path: "assets/logo.png".into(), contents: "not really png bytes".into() });
        let err = blob_install_candidate("demo-skill", files).unwrap_err();
        assert_eq!(err.code, "NET_PLAZA_BLOB");
    }

    #[test]
    fn blob_install_candidate_rejects_internal_skills() {
        let files = vec![BlobFile {
            path: crate::core::skills::SKILL_FILE.to_string(),
            contents: "---\nname: 内部技能\ndescription: 测试\nmetadata:\n  internal: true\n---\n\n正文\n".into(),
        }];
        let err = blob_install_candidate("demo-skill", files).unwrap_err();
        assert_eq!(err.code, "NET_PLAZA_BLOB");
    }

    // ======================================================== finish_blob_install

    #[test]
    fn finish_blob_install_uses_the_resolved_repo_path_not_the_dir_slug() {
        let candidate = blob_install_candidate("code-review-excellence", skill_md_only("代码审查")).unwrap();
        let (skill, payload) = finish_blob_install(
            "code-review-excellence",
            candidate,
            "plugins/developer-essentials/skills/code-review-excellence".to_string(),
        );
        // 这条断言就是 path 缺口那道护栏本身:path 必须是解出来的真实路径,
        // 不能退化成 dir_slug——两者在这个样本里恰好不相等,能直接抓到"退化成近似值"
        // 这类回归(fixture 陷阱模式 #3 的对照:两个概念绝不能取同一个值)。
        assert_eq!(skill.path, "plugins/developer-essentials/skills/code-review-excellence");
        assert_ne!(skill.path, skill.dir_slug);
        assert!(!skill.has_scripts);
        assert!(payload.files().contains_key(crate::core::skills::SKILL_FILE));
    }

    #[test]
    fn payload_from_blob_files_uses_default_permissions_only() {
        let files = skill_md_only("演示技能");
        let payload = payload_from_blob_files(&files);
        let entry = payload.files().get(crate::core::skills::SKILL_FILE).unwrap();
        assert_eq!(entry.unix_mode, None, "blob 落盘不猜 chmod,一律走默认权限位");
    }
}
