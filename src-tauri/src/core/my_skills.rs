//! 「我的技能」列表的编排(v6 任务 2)。
//!
//! 从 `commands::installed_list` 下沉到这里,理由与 `core::plaza::ensure_repo` 那次
//! 下沉相同(见 `tests/plaza_ensure_repo.rs` 模块头记的教训):`commands.rs` 里的
//! `#[tauri::command]` 依赖真实 `HOME`(`app_store()`),这个仓库一贯不直接单测
//! 这类"薄壳"——编排逻辑必须落在 core 里,才能用注入的 `Store` + 临时 HOME 测
//! (`tests/installed_list.rs`)。`commands.rs` 只做 [`InstalledRow`] → IPC DTO
//! 的字段搬运。
//!
//! # 四源汇一表(v6 二期任务 5:本体与位置模型之后的新形状)
//!
//! 这一页的语义是「**这台电脑上我拥有的技能**」,一个技能**只占一行**——哪怕它
//! 在 canonical、`~/.claude/skills/`、`~/.trae/skills/` 里各有一份实体。四个来源
//! 汇进同一张表,按**记账键**(`converge::record_key`,即清洗后的目录名)去重:
//!
//! 1. `state.installed` 的记账:本体位置由 `converge::home_of` 解析(**不再假定
//!    它住在 canonical**),本体已不在磁盘上则不占行(存量口径,M5 任务 2 用户拍板);
//! 2. `converge::scan_all` 扫出来的、没有记账的实体目录——**canonical 与每个工具
//!    全局目录都算**,不再只看 canonical。用户在 `~/.claude/skills/` 下开发的技能
//!    从此第一次出现在这一页上(这正是 v6 二期的起因);
//! 3. 同上,但同名实体在多处且内容有分歧:仍然**只占一行**,分歧摆进
//!    [`InstalledRow::versions`] 让用户拍板留哪份,而不是列成两行装作两个技能;
//! 4. 只在技能库索引里、这台电脑没有本体的:只有 `relation == Shared` 才摆出来
//!    ——库里记的分享者是我、但本地没有,这是「换电脑 / 数据丢 / 绕过 app 直推」
//!    的写照。既不在本地又不是我分享的技能,没有理由出现在「我的技能」里。
//!
//! # 三条同轴缺陷(任务 5 一次性吃掉,它们是同一根轴的三面镜子)
//!
//! 轴 = **「清洗后的记账键」与「磁盘/技能库里的字面目录名」是两样东西**
//! (`converge::record_key` 的文档是这条轴的总说明)。
//!
//! - ① 本模块原先以 **canonical** 为尺子判"本体在不在"、算"用户改没改过",
//!   而记账基线自任务 4 起已是 `home.body`。后果:canonical 链接建不成时
//!   **整行从这一页消失**(技能装上了却没有移除入口);Windows 降级复制时
//!   `local_modified` 漏报。现在一律以 `home.body` 为尺子。
//! - ② 原先把**记账名**(清洗过、会小写化)当 `dir_slug` 发给前端,而商店索引的键是
//!   **技能库里的原始目录名**。后果与任务 4 修的 scheduler 那条同构:`Weekly-Report`
//!   这样的技能 `hasUpdate` 永远匹配不到、单条获取也对不上索引。现在走
//!   [`state::InstalledSkill::library_dir_slug`](**唯一判据**,不在这里另写一遍
//!   "取末段")。
//! - ③ `converge::scan_all` 原先按磁盘上的字面目录名分组,而 `locate` 按清洗名查
//!   ——用户手建的 `Weekly-Report` 目录**永远发现不了**。已在 `converge::scan_all`
//!   处修正(分组键改为清洗名),口径与 `record_key` 一致。
//!
//! # `tools` 的成员口径(见 [`tools_of`])与 `agents` 的关系
//!
//! [`InstalledRow::tools`] 是「每个工具一个勾」这组 checkbox 的**唯一真相**,
//! 既有的 [`InstalledRow::agents`](账上记的 agent 名单)**不是**——理由写在
//! [`tools_of`] 的文档里。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};


use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::gitea::RepoRef;
use crate::core::converge;
use crate::core::fsops;
use crate::core::installer::{self, Installer};
use crate::core::ownership;
use crate::core::registry;
use crate::core::remove;
use crate::core::skill_lock;
use crate::core::skills;
use crate::core::state::{self, Store};
use crate::core::store;
use crate::error::AppError;

/// 一个工具眼下能不能读到这个技能。
///
/// 判据全部来自**磁盘**(`fsops::link_state`)+ 账上的 `links` 记账,
/// **不是** `state.installed.agents`——见 [`tools_of`] 的文档。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolState {
    /// 本体就住在这个工具的目录里(用户在这里开发它)。**永远不该给它一个能取消的勾**
    /// ——取消等于删本体。
    Body,
    /// 有一条健康的链接指向本体(或与本体是同一处磁盘位置)。
    Linked,
    /// 账上记的是降级复制(Windows 无权建链时的形态),位置上确实是一份实体副本。
    Copy,
    /// 账上有这个目录,但那里的东西已经不是我们放的了(断链 / 被改指 / 被实体顶掉 / 整个不见)。
    Missing,
    /// 账上没有这个目录——用户没启用过它。
    Off,
}

/// 「一个技能,各个工具里」——每个工具一个勾。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub agent: String,
    pub state: ToolState,
}

/// 「我的技能」一行——`commands::InstalledSkillView` 的核心数据,字段一一对应
/// (IPC DTO 只是把这份数据换成 camelCase 的 Serialize 结构)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRow {
    /// 给前端用的技能标识:**优先是技能库里的原始目录名**(`library_dir_slug`),
    /// 没有来源时退回磁盘上的字面目录名。商店索引按这把尺子建键,`hasUpdate`
    /// 与「获取」都靠它对得上(见模块头同轴缺陷 ②)。
    ///
    /// 传回 core 做动作时不必担心大小写:core 一律经 `converge::record_key`
    /// 清洗成记账键,两侧对得上。
    pub dir_slug: String,
    pub commit_sha: String,
    pub content_hash: String,
    /// 账上记的 agent 名单。**不是 checkbox 的真相**(那是 [`Self::tools`]),
    /// 保留它是因为更新/回推等既有链路仍按它建链。
    pub agents: Vec<String>,
    pub installed_at: String,
    pub updated_at: String,
    pub local_modified: bool,
    pub source_owner: String,
    pub source_repo: String,
    pub registry_id: String,
    pub source_removed: bool,
    pub library_removed: bool,
    pub relation: ownership::Relation,
    pub local_present: bool,
    pub source_label: Option<String>,
    pub links: Vec<installer::LinkHealthReport>,
    /// 本体现在住在哪(绝对路径)。第 4 源(只在库里、本地没有)是空串。
    ///
    /// **它是「本体永不搬动」这条承诺在界面上的落点**:用户要能看见"这个技能就在
    /// 我 `~/.claude/skills/` 下的那个文件夹里",而不是被告知一个它从没听说过的
    /// canonical 路径。
    pub body: String,
    /// 本体此刻的**实时**内容指纹(读不出来留空)。
    ///
    /// 🔴 与 [`Self::content_hash`] 是两样东西,别混:那个是**安装那一刻的基线**,
    /// 没有记账的行恒为空;这个是"本体现在长什么样"。前端要回答"本地与库里
    /// 一不一样"(无基线那一档的唯一问法)只能靠它 —— DTO 里此前没有任何字段
    /// 能回答这个问题(R4)。与 [`Self::local_modified`] 复用同一次目录遍历。
    pub local_hash: String,
    /// 各工具的启用态。**checkbox 的唯一真相**,口径见 [`tools_of`]。
    pub tools: Vec<ToolView>,
    /// 这个技能眼下有几份内容不同的实体(含本体自己)。空 = 没有分歧。
    /// 非空时界面要让用户拍板留哪份(`converge::keep_version`)。
    pub versions: Vec<converge::Version>,
    /// 分享前的标准校验没过的话,是哪一条(v6 二期 A-2)。`None` = 可以分享。
    /// 第 4 源恒 `None`:本地没有文件,没什么可校验的。
    pub share_blocked: Option<skills::ShareBlock>,
}

/// 算出「这个技能在各个工具里的启用态」。
///
/// # 成员口径(本任务要求显式定死并写明理由)
///
/// 成员 = **`Installer::link_targets` ∪ {本体所在目录对应的 agent}**
/// (修复轮 1 R19)。前一半的理由一句话:**一个勾存在,当且仅当执行它的那把尺子
/// (`link_targets`,`converge::set_agents` 用的就是它)真的会对它动手**。
/// 直接用分组产物会摆出两类永远点不亮的死勾:
/// - **universal agent**(`skillsDir == ".agents/skills"`,共 19 个,其中 **13 个的
///   全局目录并不是 canonical** —— cursor `~/.cursor/skills`、codex `~/.codex/skills`、
///   gemini-cli、github-copilot…):它们落在 canonical 就能读到,`link_targets`
///   按设计跳过它们,勾了什么也不会发生;
/// - **canonical 自身**(`CLAUDE_CONFIG_DIR` 指到 `~/.agents` 时 claude-code 的
///   目录恰好等于 canonical):canonical 永不作为建链目标,否则"取消关联"就等于
///   删本体。
///
/// 🔴 **但只取前一半是错的(R19,审查者探针实测)**:本体住在
/// `~/.cursor/skills/s` 时,那一行 56 个勾全是 `Off`、**cursor 根本不在勾里、
/// 没有任何 `Body`——而 cursor 此刻正读着它**。产品模型承诺「各个工具里,
/// 每个工具一个勾」,本体所在的那个工具恰恰是用户最需要看到的一个。
/// 所以并上本体所在目录的全部 agent,状态恒 `Body`:那一档按既定语义
/// **恒勾且不可取消**(取消等于删本体),不会引入任何死动作,两边的好处都拿到。
/// 本体住 canonical 时同理——那 6 个共用 canonical 的 agent 确实正读着它。
///
/// **不按 `config.disabledAgents` 过滤、也不按"这台机器上有没有装那个工具"过滤**:
/// 前者按既有约定只影响默认勾选、不影响既有关联(账上已有的关联被过滤掉就等于
/// 在界面上撒谎说"没启用");后者是展示层的事,前端按 `agents_detected` 收窄即可
/// ——core 少知道一件事,判定就少一处会漂的地方。
///
/// # 为什么不是 `state.installed.agents`
///
/// 那份名单是**期望态**(desired state):`set_agents` 会把本体所在目录的全部同组
/// agent 并进去,建链失败的合法目标也照样留在里面(那是刻意的,下次勾选自愈)。
/// 拿它当勾的回显,界面会冒出一串用户从没选过的勾(本体住 canonical 时那一组
/// 就有 cline/dexto/kimi-code-cli/loaf/warp/zed 六个),而**建链失败的目标会显示
/// 成已启用——那是撒谎**。这里一律现算磁盘状态,失败就显示 `Missing`。
fn tools_of(
    targets: &[installer::LinkTarget],
    grouped: &BTreeMap<PathBuf, Vec<String>>,
    home: &installer::SkillHome,
    recorded_links: &[state::LinkRecord],
) -> Vec<ToolView> {
    let body_dir = home.body.parent().map(fsops::normalize);
    // `BTreeMap` 兼作去重与排序:目录枚举顺序不该影响界面。
    let mut out: BTreeMap<String, ToolState> = BTreeMap::new();

    // R19 的那一半:本体所在目录的全部 agent 恒 `Body`,先放进去。
    // 用 `fsops::normalize` 比,不按字面 `PathBuf` 比——两侧一个来自模板展开、
    // 一个来自账上的字符串,字面写法可能不同而指的是同一处
    // (本项目「路径按 Path 比、不按字符串比」这条教训的同款落点)。
    if let Some(dir) = &body_dir {
        if let Some((_, agents)) = grouped.iter().find(|(d, _)| &fsops::normalize(d) == dir) {
            for agent in agents {
                out.insert(agent.clone(), ToolState::Body);
            }
        }
    }

    for target in targets {
        let state = if body_dir.as_deref() == Some(fsops::normalize(&target.dir).as_path()) {
            ToolState::Body
        } else {
            let link = target.dir.join(&home.dir_name);
            let recorded = recorded_links
                .iter()
                .find(|l| Path::new(&l.dir) == target.dir.as_path());
            match fsops::link_state(&link, &home.body) {
                fsops::LinkState::Linked(_) | fsops::LinkState::SameLocation => ToolState::Linked,
                fsops::LinkState::Real if recorded.is_some_and(|l| l.mode == "copy") => ToolState::Copy,
                // 账上有这个目录,但磁盘上的东西对不上账:断链/改指/被实体顶掉/不见了。
                // 都是"用户以为启用着、其实读不到"的同一件事,不必在界面上分四种说法。
                _ if recorded.is_some() => ToolState::Missing,
                _ => ToolState::Off,
            }
        };
        // `or_insert`:本体那一档已经放进去的不被覆盖(它是最强的事实)。
        for agent in &target.agents {
            out.entry(agent.clone()).or_insert(state);
        }
    }
    out.into_iter().map(|(agent, state)| ToolView { agent, state }).collect()
}

/// 已配置的全部 (源, 库) 坐标:内建主仓 + 追加仓、自定义源各库、广场已挂仓。
/// 只用来枚举"要去哪些索引缓存里找作者信息",不校验源是否真的可达
/// ——那是 [`library_reachability`] 的职责,与这里无关。
fn all_repo_refs(builtin: &registry::BuiltinSource, config: &state::Config) -> Vec<(String, RepoRef)> {
    let mut out = Vec::new();
    if let (Some(_base), Some((o, r))) = (builtin.base_url, builtin.repo) {
        out.push((
            registry::BUILTIN_REGISTRY_ID.to_string(),
            RepoRef { owner: o.to_string(), repo: r.to_string(), branch: builtin.branch.to_string() },
        ));
        for c in &config.builtin_extra_repos {
            out.push((
                registry::BUILTIN_REGISTRY_ID.to_string(),
                RepoRef { owner: c.owner.clone(), repo: c.repo.clone(), branch: c.branch.clone() },
            ));
        }
    }
    for reg in &config.registries {
        for c in &reg.repos {
            out.push((
                reg.id.clone(),
                RepoRef { owner: c.owner.clone(), repo: c.repo.clone(), branch: c.branch.clone() },
            ));
        }
    }
    for c in &config.plaza_repos {
        out.push((
            registry::PLAZA_REGISTRY_ID.to_string(),
            RepoRef { owner: c.owner.clone(), repo: c.repo.clone(), branch: c.branch.clone() },
        ));
    }
    out
}

/// 合并全部已配置库的索引缓存,建一份 `dir_slug → LibraryEntry` 的表。
///
/// `my_skills::build` 与 `share::scan_candidates` 共用同一份"库里有没有这个技能、
/// 是哪个库、作者是谁"的真相,不各自重新解析索引——两份实现迟早漂移,正是本项目
/// 记录的空转测试模式 #1。只记"第一次命中"的库(见 [`ownership::LibraryAttribution`]
/// 文档),索引缓存没有(未取过、已过期不要紧)则该 dir_slug 视作"不在库里",
/// 由调用方按 [`ownership::relation`] 的规则退化处理。
///
/// `owner`/`repo` 必须跟着 `registry_id` 一起存(修复轮 1):第三档(只在库里、
/// 本地没有本体)靠这份表填 `InstalledRow::source_owner/source_repo`,那是「取回」
/// 这个动作能不能发出正确请求的前提,不是展示边角料。
pub fn library_attribution(
    store: &Store,
    builtin: &registry::BuiltinSource,
    config: &state::Config,
) -> ownership::LibraryAttribution {
    let mut map: ownership::LibraryAttribution = HashMap::new();
    for (registry_id, repo) in all_repo_refs(builtin, config) {
        let path = store::cache_path(store.dir(), &registry_id, &repo);
        let Some(index) = store::load_cache(&path) else {
            continue;
        };
        for skill in &index.skills {
            map.entry(skill.dir_slug.clone()).or_insert_with(|| ownership::LibraryEntry {
                registry_id: registry_id.clone(),
                owner: repo.owner.clone(),
                repo: repo.repo.clone(),
                author: skill.attribution.as_ref().map(|a| a.author.clone()),
            });
        }
    }
    map
}

/// 一条 `state.installed` 记账**自己那个库**里,这个技能的作者(找不到就是 `None`,
/// 覆盖"从没取过索引"与"取过但库里没写作者"两种情况——对 `relation()` 来说
/// 两者都等价于"作者未知")。
///
/// **不用 [`library_attribution`] 的合并表**:合并表只记"第一次命中"的库,而
/// `state.installed` 行自己就知道装自哪个 (源,库),用它自己的坐标查更准确,
/// 不受"另一个库也凑巧有同名 dir_slug"这种边缘情况影响。
fn library_author_of(store: &Store, source: &state::SkillSource, dir_slug: &str) -> Option<String> {
    let repo = RepoRef { owner: source.owner.clone(), repo: source.repo.clone(), branch: String::new() };
    store::cached_author(store.dir(), &source.registry_id, &repo, dir_slug)
}

/// `.skill-lock.json` 的全部条目,按它自己的 `key` 建表,供来源展示
/// ([`ownership::source_label`])查表用。**只读**,与已撤销的「认领」无关。
///
/// ⚠️ 那个 `key` 是**清洗后**的目录名(与 `state.installed` 的记账键同尺),
/// **不是** [`InstalledRow::dir_slug`](v6 二期任务 5 起那是技能库里的原始目录名,
/// 大小写不清洗)。查表一律用 `home.dir_name` / `scan_all` 的分组键,别拿 `dir_slug`
/// 去查——`Weekly-Report` 那批技能会查空,来源行凭空消失。
fn lock_entries_by_key(env: &dyn AgentEnv) -> HashMap<String, skill_lock::UpstreamEntry> {
    let Some(path) = skill_lock::lock_path(env) else {
        return HashMap::new();
    };
    skill_lock::read_entries(&path)
        .into_iter()
        .map(|e| (e.key.clone(), e))
        .collect()
}

fn source_label_of(lock: &HashMap<String, skill_lock::UpstreamEntry>, dir_slug: &str) -> Option<String> {
    let entry = lock.get(dir_slug)?;
    ownership::source_label(&entry.source_type, &entry.source, &entry.source_url)
}

/// 一个已装技能的来源还通不通(M4 任务 2)。返回 `(source_removed, library_removed)`。
///
/// 两者都为 true 是**不允许**的组合:源都没了就只说"来源已移除",再补一句
/// "技能库不在列表里"是废话。`library_removed` 专指"源好好的,但这个技能库不在它的
/// 列表里"——M3 的 `bind_source` 只比同源不校验库,存量条目会走到这一档,
/// 说成"来源已移除"是假话。
///
/// **广场(`PLAZA_REGISTRY_ID`)必须走独立分支**(M9 任务 2):下面的通用算法用
/// `resolve(id, key=None)` 探测"这个源本身还在不在",这对内建/自定义源成立
/// (它们都有主仓),但广场**没有主仓概念**——`resolve(plaza, None)` 按设计永远
/// `Err(REPO_UNKNOWN)`(见 `registry::resolve`)。不加这个分支的话,任何广场来源的
/// 已装技能都会被判成"来源已移除",即便广场好好的、这个库也明明在 `plaza_repos` 里。
fn library_reachability(
    builtin: &registry::BuiltinSource,
    config: &state::Config,
    source: &state::SkillSource,
) -> (bool, bool) {
    let resolve_with = |key: Option<&str>| {
        registry::resolve(
            builtin,
            &config.registries,
            &config.builtin_extra_repos,
            &source.registry_id,
            key,
            &config.plaza_repos,
        )
        .is_ok()
    };
    if source.registry_id == registry::PLAZA_REGISTRY_ID {
        let key = registry::repo_key(&source.owner, &source.repo);
        return (false, !resolve_with(Some(&key)));
    }
    if !resolve_with(None) {
        return (true, false);
    }
    let key = registry::repo_key(&source.owner, &source.repo);
    (false, !resolve_with(Some(&key)))
}

/// [`library_reachability`] 的入口:**没有来源的记账不问这个问题**。
///
/// 🔴 R10:`registry_id` 是空串时,通用算法会 `resolve("")` 失败 → 报「来源已移除」
/// ——而这是**第三种情况**:它从来就没有来源(`converge::keep_version`/`set_agents`
/// 给纯本地技能建的 `adopted` 账,三个坐标字段都是空串占位)。本项目早就把
/// "源没了"与"库不在源里"分成两句不同的话,现在这两句**对它都不成立**,
/// 说哪一句都是假话。判据走 [`state::InstalledSkill::has_source`](**唯一判据**,
/// 不在这里另写一遍"三个字段非空")。
fn reachability_of(
    builtin: &registry::BuiltinSource,
    config: &state::Config,
    record: &state::InstalledSkill,
) -> (bool, bool) {
    if !record.has_source() {
        return (false, false);
    }
    library_reachability(builtin, config, &record.source)
}

/// 「我的技能」整份列表的编排。见模块头「四源汇一表」。
#[allow(clippy::too_many_arguments)]
pub fn build(
    installer: &Installer,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    builtin: &registry::BuiltinSource,
    config: &state::Config,
    state: &state::State,
) -> Result<Vec<InstalledRow>, AppError> {
    let library = library_attribution(store, builtin, config);
    let lock_entries = lock_entries_by_key(env);
    // 🔴 只读发现,绝不写盘、绝不写账(`scan_all` 自己也有这条承诺)。
    let all = converge::scan_all(registry, env)?;
    // 建链目标口径见 `tools_of`:成员来自执行建链的那把尺子,不是原始分组。
    let grouped = registry.group_by_global_dir(env);
    let all_agents: Vec<String> = grouped.values().flatten().cloned().collect();
    let tool_targets = installer.link_targets(&all_agents)?;

    let mut rows: Vec<InstalledRow> = Vec::new();
    // 🔴 **两套去重集合,回答的是两个不同的问题**(修复轮 1 R20):
    // - `seen_literals` = 磁盘上的**字面目录名**。第 1 源与第 2/3 源之间按它去重
    //   ——`~/.claude/skills/Weekly Report` 与 `~/.trae/skills/weekly-report` 清洗后
    //   同名,但 Claude Code 是**按字面目录名调用**技能的,它们是**两个技能**。
    //   按清洗名合并会把它们摆成一行、`versions=2`,于是弹一次"留哪个"、
    //   落选那份进废纸篓——那是让用户在两个不同的技能之间二选一。设计原文写得
    //   很清楚:「不同 + 异名 → 这是两个东西」。
    // - `seen_keys` = **记账键**(清洗名)。**只给第 4 源用**,而且这层不对称是
    //   **安全侧**的,不是随手定的(修复轮 2 订正:原先写的理由「canonical 上同一个
    //   键只有一个位置」不准确,换成下面这条硬的):
    //   「取回」走 `acquire::precheck` → `converge::locate(.., dir_slug)`,那条路
    //   **按清洗名取数**。第 4 源若摆出一行与本地实体撞键的技能,用户点「取回」
    //   会落进 `NeedsVersionChoice`——**在两个不同的技能之间二选一**,正是 R20
    //   要消灭的那个形状。所以这里按清洗名抑制。
    //   反向也不行(第 4 源改按字面名去重):库里是 `Weekly-Report`、本地 canonical
    //   的本体字面是 `weekly-report`(**同一个技能**)时,会凭空多出一行说
    //   "这台电脑上没有"——那是**假行**。
    //
    // ⚠️ 分组与查账**仍然用清洗名**(缺陷 ③ 的修复靠它,别动);改的只是
    // "几份实体算不算同一行"这个判据。
    let mut seen_literals: HashSet<String> = HashSet::new();
    let mut seen_keys: HashSet<String> = HashSet::new();

    // ── 第 1 源:`state.installed` 的记账 ────────────────────────────────
    for record in &state.installed {
        // 记账名本身就是记账键;`home_of` 会在这本账里找到它并解析出 body。
        let home = match converge::home_of(installer, state, &record.name) {
            Ok(h) => h,
            // 记账名当不了目录名(只可能来自手改过的 state.json)。**不让一条坏记账
            // 打掉整页**——那是"技能凭空全部消失",比少一行严重得多。
            Err(err) => {
                tracing::warn!(name = %record.name, error = %err.message, "跳过一条无法解析本体位置的记账");
                continue;
            }
        };
        // 存在性以文件系统为准(M5 任务 2,用户拍板):**尺子是 body 不是 canonical**
        // (模块头同轴缺陷 ①)。本体没了就不占行,记账保留——重新获取同名技能时
        // precheck 按 Fresh 走正常安装,记账随之对齐,孤账无害。
        if !home.body.is_dir() {
            continue;
        }
        // 这一行"占住"的是本体那个**字面**目录名(R20);同名的其他字面组另占一行。
        let body_literal = leaf_of(&home.body);
        seen_literals.insert(body_literal.clone());
        seen_keys.insert(home.dir_name.clone());

        // 同轴缺陷 ②:发给前端的是**技能库里的原始目录名**,不是清洗过的记账名。
        let dir_slug = record
            .library_dir_slug()
            .unwrap_or_else(|| home.dir_name.clone());
        // 空来源账(纯本地技能第一次被勾选/拍板时建的)压根没经过任何技能库,
        // `in_library` 必须是 false —— 硬填 true 会让一个手写的草稿被判成
        // `Installed`(「我安装的」),而诚实的答案是 `Draft`。
        let (in_library, author) = if record.has_source() {
            (true, library_author_of(store, &record.source, &dir_slug))
        } else {
            (false, None)
        };
        let identity = config.identities.get(&record.source.registry_id);
        let relation = ownership::relation(identity, author.as_deref(), in_library, true);

        let (recorded, _) = remove::state_links_to_recorded(&record.links);
        // R4:一次遍历,两个用途。读不出来留空,**不冒充"改过了"**。
        let local_hash = fsops::dir_content_hash(&home.body).unwrap_or_default();
        let (source_removed, library_removed) = reachability_of(builtin, config, record);
        rows.push(InstalledRow {
            dir_slug,
            commit_sha: record.commit_sha.clone(),
            content_hash: record.content_hash.clone(),
            agents: record.agents.clone(),
            installed_at: record.installed_at.clone(),
            updated_at: record.updated_at.clone(),
            // 基线或实时指纹任一为空都按"没改过"处理:宁可漏报,不误报
            // (与「有可用更新」的既有姿态一致)。
            local_modified: !record.content_hash.is_empty()
                && !local_hash.is_empty()
                && local_hash != record.content_hash,
            source_owner: record.source.owner.clone(),
            source_repo: record.source.repo.clone(),
            registry_id: record.source.registry_id.clone(),
            source_removed,
            library_removed,
            relation,
            local_present: true,
            // lock 的键是**清洗后**的目录名,所以这里用 `home.dir_name` 而不是 `dir_slug`。
            source_label: source_label_of(&lock_entries, &home.dir_name),
            links: installer.link_health(&home, &recorded)?,
            body: home.body.to_string_lossy().into_owned(),
            local_hash,
            tools: tools_of(&tool_targets, &grouped, &home, &record.links),
            // 只跟**同一个字面目录名**的那些实体比版本:字面名不同的是另一个技能,
            // 把它摆进"留哪个"的选项里就是在诱导用户销毁另一个技能(R20)。
            versions: versions_for(&home.body, literal_group(&all, &home.dir_name, &body_literal)),
            share_blocked: skills::validate_skill_dir(&home.body).err(),
        });
    }

    // ── 第 2+3 源:磁盘上有实体、但没有记账 ─────────────────────────────
    // `all` 的键是记账键(清洗名),但**一行 = 一个字面目录名**(R20):
    // 清洗后撞名的两个不同文件夹是两个技能,各占一行。
    for (key, paths) in &all {
        for (literal, group) in by_literal_name(paths) {
            if seen_literals.contains(&literal) || group.is_empty() {
                continue;
            }
            seen_literals.insert(literal.clone());
            seen_keys.insert(key.clone());
            rows.push(unmanaged_row(
                installer,
                registry,
                env,
                state,
                config,
                &library,
                &lock_entries,
                &tool_targets,
                &grouped,
                key,
                &literal,
                &group,
            ));
        }
    }

    // ── 第 4 源:只在库里、这台电脑没有本体 ─────────────────────────────
    // 只有「我分享的」才有理由出现在这里(换电脑 / app 数据丢 / 绕过 app 直推 git,
    // 见设计文档「不依赖本地账本」)。未登录或作者不是我时 relation 会退化成
    // installed,此时**不摆**——一个既不在本地、又不是我分享的技能出现在
    // 「我的技能」里没有道理。
    //
    // 🔴 `source_owner`/`source_repo` 必须填库坐标的真实值,不能留空(v6 任务 2
    // 修复轮 1):这一档存在的唯一理由就是"换电脑/数据丢"场景,主动作是「取回」
    // ——取回要调 `skill_acquire`,缺坐标不会报错,是**装进来一个同名但完全不同
    // 的技能**。`source_label` 仍然固定 `None`:那是"这台电脑上从哪装来的"个人
    // 历史,这一档从没装过,填了是假话。
    for (dir_slug, entry) in &library {
        let key = converge::record_key(installer, dir_slug).unwrap_or_else(|_| dir_slug.clone());
        // 这一档按**记账键**去重(见上面两套集合的说明):它问的是"这台电脑上有没有
        // 本体",而 canonical 上同一个键只有一个位置。
        if seen_keys.contains(&key) {
            continue; // 已经在上面两档里出现过(本地有记账或有本体)
        }
        let identity = config.identities.get(&entry.registry_id);
        let relation = ownership::relation(identity, entry.author.as_deref(), true, false);
        if relation != ownership::Relation::Shared {
            continue;
        }
        seen_keys.insert(key);
        rows.push(InstalledRow {
            dir_slug: dir_slug.clone(),
            commit_sha: String::new(),
            content_hash: String::new(),
            agents: Vec::new(),
            installed_at: String::new(),
            updated_at: String::new(),
            local_modified: false,
            source_owner: entry.owner.clone(),
            source_repo: entry.repo.clone(),
            registry_id: entry.registry_id.clone(),
            source_removed: false,
            library_removed: false,
            relation,
            local_present: false,
            source_label: None,
            links: Vec::new(),
            // 本地什么都没有:没有本体路径、没有实时指纹、没有工具可勾、
            // 没有版本要拍板、也没有本地文件可校验。四个空值都是刻意的。
            body: String::new(),
            local_hash: String::new(),
            tools: Vec::new(),
            versions: Vec::new(),
            share_blocked: None,
        });
    }

    Ok(rows)
}

/// 一个路径的**字面**叶子名(不清洗)。这是用户在访达里看到的名字,
/// 也是 Claude Code 实际用来调用这个技能的名字(官方文档:调用名来自目录名)。
fn leaf_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// 把一个清洗名下的实体目录按**字面目录名**再分一层(R20)。
///
/// `converge::scan_all` 按清洗名分组是为了让 `locate` 查得到(缺陷 ③),但
/// 「几份实体算不算同一行」是另一个问题:`Weekly Report` 与 `weekly-report`
/// 清洗后同名,调用名却不同——**它们是两个技能**,合并成一行就会让用户在两个
/// 不同的技能之间二选一、落选那份进废纸篓。
fn by_literal_name(paths: &[PathBuf]) -> BTreeMap<String, Vec<PathBuf>> {
    let mut out: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for p in paths {
        out.entry(leaf_of(p)).or_default().push(p.clone());
    }
    out
}

/// 某个清洗名下、字面名等于 `literal` 的那些实体目录。
fn literal_group(all: &BTreeMap<String, Vec<PathBuf>>, key: &str, literal: &str) -> Vec<PathBuf> {
    all.get(key)
        .map(|paths| paths.iter().filter(|p| leaf_of(p) == literal).cloned().collect())
        .unwrap_or_default()
}

/// 内容分歧的那几份版本(空 = 没有分歧)。
///
/// 算不出来(本体读不了)时**返回空而不是往上抛**:一个技能目录的权限问题
/// 不该让整页 500。这一档的代价只是那一行暂时不提示"有两个版本",
/// 而写盘时 `converge` 的 `Differs` 仍会兜住,不会静默覆盖。
fn versions_for(body: &Path, candidates: Vec<PathBuf>) -> Vec<converge::Version> {
    match converge::versions_of(body, &candidates) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(body = %body.display(), error = %err.message, "算不出版本分歧,这一行按无分歧处理");
            Vec::new()
        }
    }
}

/// 第 2+3 源的一行:磁盘上有实体、没有 `state.installed` 记账。
///
/// **没有记账基线**,所以 `commit_sha`/`content_hash`/`installed_at`/`updated_at`
/// 一律空、`local_modified` 恒 false、`links` 恒空——这不是偷懒,是这几个字段的
/// 定义就要求有一次"安装"作为参照,而这一档从来没有过。前端据此不摆"有可用更新"
/// 之类需要基线才能回答的东西(既有约定,判据是 `contentHash !== ""`)。
#[allow(clippy::too_many_arguments)]
fn unmanaged_row(
    installer: &Installer,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    state: &state::State,
    config: &state::Config,
    library: &ownership::LibraryAttribution,
    lock_entries: &HashMap<String, skill_lock::UpstreamEntry>,
    tool_targets: &[installer::LinkTarget],
    grouped: &BTreeMap<PathBuf, Vec<String>>,
    key: &str,
    literal: &str,
    group: &[PathBuf],
) -> InstalledRow {
    // `locate` 是"本体住在哪"的唯一权威判定,这里只消费它,不另写一套选法。
    // 解析不了(目录名清洗后塌成 `unnamed-skill`,即纯中文目录名)时**降级成
    // 一行而不是丢掉**:技能就在用户磁盘上,让它凭空消失是这个项目明令不可接受的
    // 失败模式。降级行天然是惰性的——没有账就没有移除入口,`tools` 为空就没有勾,
    // 而 `share_blocked` 会诚实地告诉他文件夹名不合标准(A-5「显示 + 说明 + 出口」)。
    //
    // 🔴 **只接受落在本字面组里的那个答案**(R20):`locate` 按清洗名找,而清洗后
    // 撞名的另一个字面目录是**另一个技能**——它的本体不能当成这一行的本体。
    // 落不进本组时(账上那份属于另一个字面组、或账上的本体已经不在磁盘上),
    // 退回本组里排序第一的那份:它就是这一行**实际存在**的东西。
    let located = converge::locate(installer, registry, env, state, key);
    let body = match &located {
        Ok(converge::Located::Body { body, .. }) if body.is_dir() && group.contains(body) => body.clone(),
        Ok(converge::Located::Differs(versions)) => versions
            .iter()
            .map(|v| PathBuf::from(&v.path))
            .find(|p| group.contains(p))
            .unwrap_or_else(|| group[0].clone()),
        _ => group[0].clone(),
    };
    if let Err(err) = &located {
        tracing::warn!(key = %key, error = %err.message, "本体位置解析不了,按降级行摆出");
    }

    // 展示用的标识就是这一行的**字面目录名**:它既是用户在访达里看到的那个名字、
    // 也是 Claude Code 的调用名,还是技能库索引的建键口径(库里的目录名同样不清洗)。
    let dir_slug = literal.to_string();

    let relation = match library.get(&dir_slug).or_else(|| library.get(key)) {
        Some(entry) => {
            let me = config.identities.get(&entry.registry_id);
            ownership::relation(me, entry.author.as_deref(), true, true)
        }
        None => ownership::relation(None, None, false, true),
    };

    // 本体的叶子名可能与记账键大小写不同(`Weekly-Report` vs `weekly-report`),
    // 而 lock 的键是清洗后的那一个——两把都试一次,别让大小写差异吞掉来源展示。
    let source_label =
        source_label_of(lock_entries, &dir_slug).or_else(|| source_label_of(lock_entries, key));

    // `link_targets`/`link_health` 都要一个 `SkillHome`;拿不到就只能不摆工具勾
    // (降级行的形状)。这里用 `key` 而不是 `dir_slug`:前者已是记账键口径。
    let home = installer.home(key, Some(&body)).ok();
    let tools = home.as_ref().map(|h| tools_of(tool_targets, grouped, h, &[])).unwrap_or_default();

    InstalledRow {
        dir_slug,
        commit_sha: String::new(),
        content_hash: String::new(),
        agents: Vec::new(),
        installed_at: String::new(),
        updated_at: String::new(),
        local_modified: false,
        source_owner: String::new(),
        source_repo: String::new(),
        registry_id: String::new(),
        source_removed: false,
        library_removed: false,
        relation,
        local_present: true,
        source_label,
        links: Vec::new(),
        local_hash: fsops::dir_content_hash(&body).unwrap_or_default(),
        tools,
        versions: versions_for(&body, group.to_vec()),
        share_blocked: skills::validate_skill_dir(&body).err(),
        body: body.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_library_missing_from_a_live_source_is_not_the_same_as_a_removed_source() {
        // M3 的 bind_source 只比同源不校验库,存量条目可能把 host/someone/other-repo
        // 的技能绑到该 host 的源上;或用户后来把库从源里移除了。
        // 两种情况下更新与回推都没了去处,但**说法不同**:源好好的,
        // 说成"来源已移除"是假话。
        let builtin = registry::BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "main",
        };
        let config = state::Config::default();
        let src = |registry_id: &str, owner: &str, repo: &str| state::SkillSource {
            registry_id: registry_id.into(),
            owner: owner.into(),
            repo: repo.into(),
            path: "skills/x".into(),
            git_ref: "aaa1111".into(),
        };

        // 主库:两个标记都不亮
        assert_eq!(
            library_reachability(&builtin, &config, &src("company", "skills", "skills")),
            (false, false)
        );
        // 源在,但这个库不在它的列表里 —— 只有 library_removed 该亮
        assert_eq!(
            library_reachability(&builtin, &config, &src("company", "someone", "other-repo")),
            (false, true),
            "源好好的,说成「来源已移除」是假话"
        );
        // 源本身不在:只说"来源已移除",不再补一句库不在列表里(那是废话)
        assert_eq!(
            library_reachability(&builtin, &config, &src("custom-99", "a", "b")),
            (true, false)
        );
    }

    /// 广场(M9 任务 2)必须走独立分支:通用算法用 `resolve(id, key=None)` 探测
    /// "源本身还在不在",这对内建/自定义源成立(它们都有主仓),但广场**没有主仓**,
    /// `resolve(plaza, None)` 按设计永远出错。不特殊处理的话,任何广场来源的已装技能
    /// 都会被判成"来源已移除",即便广场好好的、库也明明在 `plaza_repos` 里。
    #[test]
    fn plaza_sourced_skills_are_never_reported_as_source_removed() {
        let builtin = registry::BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "main",
        };
        let mut config = state::Config::default();
        config.plaza_repos.push(state::RepoConfig {
            owner: "vercel-labs".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        });
        let src = |owner: &str, repo: &str| state::SkillSource {
            registry_id: "plaza".into(),
            owner: owner.into(),
            repo: repo.into(),
            path: "skills/x".into(),
            git_ref: "aaa1111".into(),
        };

        // 库在 plaza_repos 里:两个标记都不亮
        assert_eq!(
            library_reachability(&builtin, &config, &src("vercel-labs", "skills")),
            (false, false)
        );
        // 库不在 plaza_repos 里:只有 library_removed 亮,绝不是 source_removed
        // ——广场这个"源"本身从未移除过。
        assert_eq!(
            library_reachability(&builtin, &config, &src("someone", "other-skills")),
            (false, true),
            "广场是锁定源,永远不该被判成「来源已移除」"
        );
    }
}
