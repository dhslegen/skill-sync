//! 「我的技能」列表的编排(v6 任务 2)。
//!
//! 从 `commands::installed_list` 下沉到这里,理由与 `core::plaza::ensure_repo` 那次
//! 下沉相同(见 `tests/plaza_ensure_repo.rs` 模块头记的教训):`commands.rs` 里的
//! `#[tauri::command]` 依赖真实 `HOME`(`app_store()`),这个仓库一贯不直接单测
//! 这类"薄壳"——编排逻辑必须落在 core 里,才能用注入的 `Store` + 临时 HOME 测
//! (`tests/installed_list.rs`)。`commands.rs` 只做 [`InstalledRow`] → IPC DTO
//! 的字段搬运。
//!
//! # 三路合并(v6 撤掉「纳入管理/移出管理」与三分区之后的新形状)
//!
//! 1. `state.installed`:本 app 记账、canonical 目录还在的。`in_library` 强制为
//!    `true`(记账本身就是"来自某个库"的证据),作者从**它自己那个库**的索引缓存里查
//!    ——不用下面的合并表,避免"另一个库凑巧有同名 dir_slug"这种边缘情况指错人。
//! 2. `share::scan_candidates` 里 `in_canonical` 的:canonical 有本体、但没有
//!    `state.installed` 记账(不管是别的工具装的还是手放的,v6 起不再区分)。
//!    关系用合并表(`LibraryAttribution`)判定。
//! 3. 合并表里"只在库里、这台电脑没有本体"的:只有 `relation == Shared` 才摆出来
//!    ——库里记的分享者是我、但本地没有,这是「换电脑 / 数据丢 / 绕过 app 直推 git」
//!    的写照(见 `docs/设计-v6-技能归属模型.md`)。既不在本地又不是我分享的技能,
//!    没有理由出现在「我的技能」里。

use std::collections::HashMap;

use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::gitea::RepoRef;
use crate::core::installer::{self, Installer};
use crate::core::ownership;
use crate::core::registry;
use crate::core::remove;
use crate::core::share;
use crate::core::skill_lock;
use crate::core::state::{self, Store};
use crate::core::store;
use crate::error::AppError;

/// 「我的技能」一行——`commands::InstalledSkillView` 的核心数据,字段一一对应
/// (IPC DTO 只是把这份数据换成 camelCase 的 Serialize 结构)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRow {
    pub dir_slug: String,
    pub commit_sha: String,
    pub content_hash: String,
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
    if source.registry_id.is_empty() {
        return None;
    }
    let repo = RepoRef { owner: source.owner.clone(), repo: source.repo.clone(), branch: String::new() };
    let path = store::cache_path(store.dir(), &source.registry_id, &repo);
    let index = store::load_cache(&path)?;
    index
        .skills
        .iter()
        .find(|s| s.dir_slug == dir_slug)?
        .attribution
        .as_ref()
        .map(|a| a.author.clone())
}

/// `.skill-lock.json` 的全部条目,按 `key`(= dir_slug)建表,供来源展示
/// ([`ownership::source_label`])查表用。**只读**,与已撤销的「认领」无关。
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

/// 「我的技能」整份列表的编排。见模块头「三路合并」。
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

    let mut rows: Vec<InstalledRow> = state
        .installed
        .iter()
        .filter_map(|s| {
            let canonical = match installer.canonical_dir(&s.name) {
                Ok(c) => c,
                Err(e) => return Some(Err(e)),
            };
            // 存在性以文件系统为准(M5 任务 2,用户拍板):目录被删就不占行。
            // 记账**保留**——重新获取同名技能时 precheck 按 Fresh 走正常安装,
            // 记账随之对齐(tests/acquire_flow.rs 有测试钉住),孤账无害。
            if !canonical.is_dir() {
                return None;
            }
            // 认不出 mode 的记账进不了健康检查——那是移除时才需要面对的问题
            let (recorded, _) = remove::state_links_to_recorded(&s.links);
            let author = library_author_of(store, &s.source, &s.name);
            let identity = config.identities.get(&s.source.registry_id);
            let relation = ownership::relation(identity, author.as_deref(), true, true);
            Some(Ok(InstalledRow {
                dir_slug: s.name.clone(),
                commit_sha: s.commit_sha.clone(),
                content_hash: s.content_hash.clone(),
                agents: s.agents.clone(),
                installed_at: s.installed_at.clone(),
                updated_at: s.updated_at.clone(),
                local_modified: remove::is_locally_modified(&canonical, &s.content_hash),
                source_owner: s.source.owner.clone(),
                source_repo: s.source.repo.clone(),
                registry_id: s.source.registry_id.clone(),
                // 源没了 与 库不在源的列表里 是**两句不同的话**(M4 任务 2)
                source_removed: library_reachability(builtin, config, &s.source).0,
                library_removed: library_reachability(builtin, config, &s.source).1,
                relation,
                local_present: true,
                source_label: source_label_of(&lock_entries, &s.name),
                links: match installer.link_health(&s.name, &recorded) {
                    Ok(l) => l,
                    Err(e) => return Some(Err(e)),
                },
            }))
        })
        .collect::<Result<_, AppError>>()?;

    // 第二档:canonical 里有本体、但没有 `state.installed` 记账的目录——不再区分
    // "其他工具装的"与"本地新建的"(v6 撤掉这条标签,来历改由 source_label 展示)。
    // 发现逻辑**复用 share::scan_candidates**,不另写一套扫描——两份实现迟早漂移,
    // 那正是本项目记录的空转测试模式 #1。只取 canonical 里的:agent 目录下的
    // 实体目录归分享页收编,在「我的技能」里摆出来会让用户以为它已经归本 app 管。
    for c in share::scan_candidates(registry, env, state, &config.identities, &library)?
        .into_iter()
        .filter(|c| c.in_canonical)
    {
        rows.push(InstalledRow {
            dir_slug: c.dir_name.clone(),
            // 没有 state.installed 记账就没有本 app 的记账基线,这些字段照旧空着
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
            relation: c.relation,
            local_present: true,
            source_label: source_label_of(&lock_entries, &c.dir_name),
            links: Vec::new(),
        });
    }

    // 第三档:只在库里、这台电脑没有本体——只有「我分享的」才有理由出现在这里
    // (换电脑 / app 数据丢 / 绕过 app 直推 git,见设计文档「不依赖本地账本」)。
    // 未登录或作者不是我时 relation 会退化成 installed,此时**不摆**——
    // 一个既不在本地、又不是我分享的技能出现在「我的技能」里没有道理。
    //
    // 🔴 `source_owner`/`source_repo` 必须填库坐标的真实值,不能留空(修复轮 1)。
    // 这一档存在的唯一理由就是"换电脑/数据丢"场景,主动作是「取回」——取回要调
    // `skill_acquire`,缺坐标不会报错,是**装进来一个同名但完全不同的技能**
    // (`CLAUDE.md`「一源多仓」的既有教训)。`source_label` 仍然固定 `None`:
    // 那是"这台电脑上从哪装来的"个人历史,这一档从没装过,填了是假话——
    // 坐标(给取回用)与展示标签(给人看的历史)是两件事,不能因为都叫"来源"就合并。
    for (dir_slug, entry) in &library {
        if rows.iter().any(|v| &v.dir_slug == dir_slug) {
            continue; // 已经在上面两档里出现过(本地有记账或有本体)
        }
        let identity = config.identities.get(&entry.registry_id);
        let relation = ownership::relation(identity, entry.author.as_deref(), true, false);
        if relation != ownership::Relation::Shared {
            continue;
        }
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
        });
    }

    Ok(rows)
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
