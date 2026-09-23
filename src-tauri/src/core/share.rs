//! 分享编排:定位本体 → 标准校验 → 预检(同名两分支)→ 提交(按权限矩阵)→ 记账。
//!
//! # 分享就是分享——不改任何东西(v6 二期 A-1/A-2 拍板)
//!
//! 分享环节**零编辑**:名称、描述、文件夹名全部只读,frontmatter 补齐链路
//! (`rewrite_frontmatter` 那一族)已整体删除。取而代之的是一道**闸**:
//! 分享前按 Agent Skills 开放标准全量校验([`crate::core::skills::validate_skill_dir`]),
//! 不合格**不让分享**,并把不合格的那一条(`ShareBlock`)如实带回界面
//! ——界面照常显示这个技能、说清哪不合格、给「打开文件夹」的出口,
//! 改名与改 frontmatter 由用户在本地自行完成(A-3:名字冲突划在边界之外)。
//!
//! 直接后果是**「远端目录名」这个概念消失了**:标准要求 `name` 必须等于文件夹名,
//! 校验过了就意味着「文件夹名 = frontmatter `name` = 库里的目录名」三者同一。
//! 所以 [`ShareRequest`] 只剩三个字段,不再有 `share_name`/`display_name`/
//! `description`/`origin`/`overwrite`。
//!
//! ⚠️ 本模块头曾经写着一整套「中文名技能分享策略」(表单强制起 ASCII 远端目录名、
//! frontmatter `name` 保持中文显示名)。那套策略**本身就违反标准**(`name` 只能是
//! ASCII 小写且必须等于目录名,中文 `name` 两条都犯),已于 2026-08-24 被用户推翻,
//! v6 二期任务 6 落地删除。别照着它写新代码。
//!
//! # 本体永不搬家
//!
//! 旧模型里分享一个住在 agent 目录里的技能会先"收编":整份复制进 canonical、
//! 原位换成链接。新模型下**本体住在它现在所在的地方,一个字节都不搬**
//! ——分享读的就是本体目录,canonical 只保证有一条指向本体的链接
//! ([`crate::core::converge::ensure_canonical_link`],幂等;canonical 上若有一份
//! 同内容的实体副本,它会进废纸篓换成链接,可逆)。
//!
//! # 仍然成立的既有约定
//!
//! - **候选扫描用排除法**(设计方案 2.5②):不判断"原创"——canonical 目录里
//!   npx skills 装的、手写的、别的工具放的混在一起,原创性无法可靠判定。
//!   凡不在本 app `state.installed` 里(且那条账**确实有来源**)的都可以分享;
//!   来源只作标签展示(走 `ownership::source_label` 归一化)。
//! - **更新分享不删除远端多出的文件**:只做 create/update。远端有而本地没有的文件
//!   多半是评审者补的(如 LICENSE),静默删除比留着危险得多。

use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::converge;
use crate::core::fsops::{self, Trasher};
use crate::core::installer::Installer;
use crate::core::gitea::{
    ChangeFilesRequest, FileChange, GiteaClient, RepoArchive, RepoRef, RepoSource,
};
use crate::core::github::GithubClient;
use crate::core::ownership::{self, Identity};
use crate::core::skill_lock;
use crate::core::skills::{self, parse_skill_md, sanitize_name, ShareBlock};
use crate::core::state::{self, SharedSkill, SkillSource, Store};
use crate::error::AppError;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ============================================================ 候选扫描

/// 一个可分享的本地技能。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCandidate {
    /// 本地目录名(可能是中文,分享时不作远端名用)。
    pub dir_name: String,
    /// 绝对路径。
    pub path: String,
    /// 在 canonical 目录里;false = 在某个 agent 目录,分享时会顺便收编。
    pub in_canonical: bool,
    pub origin: CandidateOrigin,
    /// frontmatter 解析出的显示名与描述;解析失败时为空。
    pub name: Option<String>,
    pub description: Option<String>,
    /// SKILL.md 不合规的原因(人话)。有值 = 分享前要走补齐表单。
    pub problem: Option<String>,
    /// 之前分享过(state.shared 记账)。
    pub shared: Option<SharedStatus>,
    /// 目录名可直接用作远端名;false 时表单必须让用户另起英文名。
    pub dir_name_usable: bool,
    /// 这个候选与「我」的关系(v6,`ownership::relation` 唯一一处判定实现)。
    /// 候选本身定义为"不在 `state.installed` 里",所以这里几乎不会是
    /// `Relation::Installed`(库里有、作者不是我)——但技术上不排除:候选目录名
    /// 恰好撞上一个别人分享的同名技能时就是这一档,界面仍按它摆放即可。
    pub relation: ownership::Relation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum CandidateOrigin {
    /// 两处记账都查不到,视为本地创建。
    Local,
    /// 能在 npx skills 的 lock 里查到,`source` 是归一化后的展示文案
    /// (`ownership::source_label`)。
    NpxSkills { source: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedStatus {
    /// 上次分享后本地没再改过。
    pub up_to_date: bool,
    /// 上次分享用的远端名(再推沿用,不再询问)。
    pub share_name: String,
}

/// 扫描本地可分享的技能(排除法)。
///
/// 扫两处:canonical 目录下的实体目录 + 各 agent 全局目录下的实体目录(链接跳过
/// ——链接指向的内容已经由本体条目代表)。`state.installed` 里的不出现。
///
/// `identities`/`library` 是 `ownership::relation` 需要的另外两个输入
/// (v6 任务 2):`identities` 是当前登录身份(`config.identities`,按 registryId
/// 分开存),`library` 是 `commands::library_attribution` 合并出的
/// "dir_slug → (它所在的库, 库里记的作者)" 表——调用方(`commands.rs`)从索引
/// 缓存里建好后传进来,本函数不做任何 I/O,保持纯扫描 + 判定的分工。
pub fn scan_candidates(
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    state: &state::State,
    identities: &BTreeMap<String, Identity>,
    library: &ownership::LibraryAttribution,
) -> Result<Vec<ShareCandidate>, AppError> {
    let canonical = registry.canonical_global_dir(env).ok_or_else(|| {
        AppError::new("FS_NO_HOME", "找不到你的用户目录,无法扫描本地技能")
            .with_detail("home dir unavailable")
    })?;

    // 🔴 **只排除"确实有来源"的记账**(v6 二期任务 6):判据是
    // [`state::InstalledSkill::has_source`](全仓唯一判据,别在这里另写一遍)。
    // 原先是无差别 `state.installed.iter().map(|s| s.name)`,于是**空来源账**
    // ——用户在 `~/.claude/skills/` 下自己开发、只是点过一次工具勾(那一下由
    // `converge::set_agents` 顺手建了一条 `adopted` 账,三个来源字段全是空占位)
    // ——会被当成"库里装来的"整个排除掉,从候选里凭空消失。而"在 Claude Code 里
    // 开发 skill、还想分享出去"正是 v6 二期的主线场景。
    let installed: Vec<&str> = state
        .installed
        .iter()
        .filter(|s| s.has_source())
        .map(|s| s.name.as_str())
        .collect();
    let mut out: Vec<ShareCandidate> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let mut visit = |dir: &Path, in_canonical: bool| {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return; // 目录不存在(该 agent 没装过技能)是常态,不是错误
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            // 链接跳过:它指向的内容由本体条目代表,列两遍会让用户以为有两份
            if fsops::read_link_target(&path).is_some() {
                continue;
            }
            if !path.is_dir() || !path.join("SKILL.md").is_file() {
                continue;
            }
            if installed.contains(&name.as_str()) || seen.contains(&name) {
                continue;
            }
            seen.push(name.clone());
            out.push(candidate(env, state, &name, &path, in_canonical, identities, library));
        }
    };

    visit(&canonical, true);
    for (dir, _agents) in registry.group_by_global_dir(env) {
        if dir == canonical {
            continue;
        }
        visit(&dir, false);
    }

    // canonical 的排前面,同一处内按目录名排——扫描顺序不该影响界面
    out.sort_by(|a, b| b.in_canonical.cmp(&a.in_canonical).then(a.dir_name.cmp(&b.dir_name)));
    Ok(out)
}

fn candidate(
    env: &dyn AgentEnv,
    state: &state::State,
    dir_name: &str,
    path: &Path,
    in_canonical: bool,
    identities: &BTreeMap<String, Identity>,
    library: &ownership::LibraryAttribution,
) -> ShareCandidate {
    let relation = match library.get(dir_name) {
        Some(entry) => {
            let me = identities.get(&entry.registry_id);
            ownership::relation(me, entry.author.as_deref(), true, true)
        }
        None => ownership::relation(None, None, false, true),
    };

    let (name, description, problem) =
        match std::fs::read_to_string(path.join("SKILL.md")) {
            Ok(raw) => match parse_skill_md(&raw) {
                Ok(parsed) => (Some(parsed.name), Some(parsed.description), None),
                Err(e) => (None, None, Some(e.reason())),
            },
            Err(_) => (None, None, Some("SKILL.md 无法读取".to_string())),
        };

    // 路径一律按 `Path` 比,不按字符串比(项目铁律):`local_path` 是别处写下的
    // 字符串,分隔符写法可能与这次扫描出来的不同——`remove::remove` 早就是这么比的。
    let shared = state.shared.iter().find(|s| Path::new(&s.local_path) == path).map(|s| {
        SharedStatus {
            up_to_date: !s.content_hash.is_empty()
                && fsops::dir_content_hash(path).map(|h| h == s.content_hash).unwrap_or(false),
            share_name: s.name.clone(),
        }
    });

    ShareCandidate {
        dir_name: dir_name.to_string(),
        path: path.to_string_lossy().into_owned(),
        in_canonical,
        origin: npx_origin(env, dir_name),
        name,
        description,
        problem,
        shared,
        dir_name_usable: usable_share_name(dir_name),
        relation,
    }
}

/// 查 npx skills 的 lock:能查到就是它装的,展示归一化后的来源。
///
/// v6 任务 6:改走 `ownership::source_label`(与 `acquire.rs::foreign_origin`
/// 同一份归一化),不再各自手搓 `doc["skills"][dir]["source"]` 的裸字符串——
/// 界面因此不再显示"来自 acme/skills.git"这类未归一化的原始写法。
fn npx_origin(env: &dyn AgentEnv, dir_name: &str) -> CandidateOrigin {
    let Some(path) = skill_lock::lock_path(env) else {
        return CandidateOrigin::Local;
    };
    let entries = skill_lock::read_entries(&path);
    let Some(entry) = entries.iter().find(|e| e.key == dir_name) else {
        return CandidateOrigin::Local;
    };
    match ownership::source_label(&entry.source_type, &entry.source, &entry.source_url) {
        Some(source) => CandidateOrigin::NpxSkills { source },
        None => CandidateOrigin::Local,
    }
}

/// 目录名可否直接作远端名:必须已经是 sanitize 的不动点(纯 ASCII kebab)。
fn usable_share_name(name: &str) -> bool {
    sanitize_name(name) == name && name != "unnamed-skill"
}

// ============================================================ 预检

/// 同名预检的三分支(设计方案 2.5② 第 2 步)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SharePrecheck {
    /// 远端没有同名技能,直接提交。
    Fresh,
    /// 已存在,且是自己此前分享的——按"更新已分享的技能"处理。
    Mine,
    /// 已存在,不是自己分享的——改名 / 查看对方 / 覆盖,三选一。
    Taken,
}

/// 分享的目标客户端。**刻意不做 trait**(gitea.rs RepoSource 注释的约定):
/// 两家的提交/评审 API 形状完全不同——Gitea 是多文件 contents(逐文件带 blob sha),
/// GitHub 是 GraphQL createCommitOnBranch(只要 expectedHeadOid)。读链路那种
/// "同一签名两种实现"的共性在写链路不存在,枚举分发把差异摆在明处。
pub enum ShareClient<'a> {
    Gitea(&'a GiteaClient),
    Github(&'a GithubClient),
}

/// 分享**会走哪条路**的预告(M4 任务 2)。
///
/// 判据来自真实录制(`tests/fixtures/gitea-permissions/NOTES.md`)。**它只是提示,提交时刻的权限矩阵仍是权威判定**
/// ——预检与提交之间权限可能变化,所以两边不共用一次结果。
///
/// 返回的是枚举不是句子:文案在 i18n。core 若返回中文,两道术语门都扫不到它
/// (`tests/terminology.rs` 只扒 `AppError::new` 的 message,前端守卫只扫 `src/`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SharePath {
    /// 能直接保存进目标库:改动立即生效。
    DirectPush,
    /// **对这个技能库没有写权限**(v8 任务 3 / D8)。分享族按钮据此禁用并给一句
    /// 说明——此处刻意不套用「不摆比解释好」:用户需要知道**为什么自己没有这个
    /// 能力**,不摆的话他只会以为界面坏了。
    NoAccess,
    /// 探不到,或**有写权限但目标受保护**。界面不显示预告、也不禁用任何按钮。
    ///
    /// 🔴 「有写权限但受保护」刻意归到这一档、不归 [`Self::NoAccess`]:那个用户
    /// 对这个库**确实有**写权限,说他"没有写权限"是假话;而 D8 的禁用态是拿这句
    /// 话当理由的。受保护这件事由提交时刻的 403 出口如实说明(见 [`submit_gitea`]),
    /// 预检不替它表态。
    Unknown,
}

/// 探一次目标库的分享路径。**永不返回 Err**:预检失败一律 [`SharePath::Unknown`],
/// 绝不拦住分享本身(fail-open)。
///
/// 🔴 **v8 任务 3:这个函数没有被删掉,是被收窄**——它是 D8「只读用户按钮禁用 +
/// 说明」的**唯一判据来源**。删掉的只是 `reviewInRepo`/`reviewViaCopy` 这两个
/// **结果档**(那两条路本身没了),不是这次探测。
///
/// 注意调用方必须传**带凭证**的 client:匿名与只读用户的 `permissions` 完全相同
/// (录制结论 5),拿匿名 client 探出来的永远是"无权限"——而内建源的读链路
/// 恰好硬编码匿名,顺手复用 `read_source` 就会让每次预检都反向撒谎。
pub async fn preview_permission(client: &ShareClient<'_>, repo: &RepoRef) -> SharePath {
    match client {
        ShareClient::Gitea(c) => {
            // 两个端点都要:user_can_push 说得出"能不能直推",但它为 false 时
            // 分不出「有写权限但受保护」与「只读」——那两档的去向完全不同。
            let (Ok(branch), Ok(info)) = (
                c.branch_access(repo).await,
                c.repo_info(&repo.owner, &repo.repo).await,
            ) else {
                return SharePath::Unknown;
            };
            match (branch.user_can_push, info.permissions.push) {
                (Some(true), _) => SharePath::DirectPush,
                // 有写权限但目标受保护:**不是**"没有写权限",见 `SharePath::Unknown`
                (Some(false), true) => SharePath::Unknown,
                (Some(false), false) => SharePath::NoAccess,
                // 旧版 Gitea 没有 user_can_push:有写权限时保护状态无从得知,
                // 不许预告"直接生效";没有写权限则与新版结论一致。
                (None, true) => SharePath::Unknown,
                (None, false) => SharePath::NoAccess,
            }
        }
        // GitHub 的保护规则要 admin 权限才读得到,所以有 push 权限时只说"能直接
        // 保存"——探不到保护规则不影响这一档的用途(D8 的禁用态只认 NoAccess)。
        ShareClient::Github(c) => match c.repo_view(&repo.owner, &repo.repo).await {
            Ok(view) if view.permissions.push => SharePath::DirectPush,
            Ok(_) => SharePath::NoAccess,
            Err(_) => SharePath::Unknown,
        },
    }
}

/// 实时确认远端有没有同名技能(不信缓存:过期缓存会把 Taken 误判成 Fresh)。
///
/// 「是不是我的」有**两条判据,顺序不能反**(v6 终审修复):
///
/// 1. **库里记的分享者是不是我**(`me` + `library_author`,走
///    [`ownership::relation`] 这唯一一处判定表)。这一条是 v6 的权威口径,
///    也是"第一作者直接推进技能库、从没经过本应用"这个场景的**唯一出路**——
///    那台机器上 `state.shared` 必然是空的,只看本地记账会把作者本人判成外人,
///    弹出一整套写给外人看的三选文案(换名 / 看看对方的版本 / 覆盖)。
/// 2. 本机 `state.shared` 有没有这条记账。**不能删**:归因文件可能因提交冲突
///    被剥掉重试(见 `change_files_sparing_skill`)、索引缓存可能从没取过或已过期,
///    这两种情况下 `library_author` 都是 `None`,本机记账是仅剩的证据。
///
/// `library_author` 由调用方从**目标库自己**的索引缓存里取
/// ([`crate::core::store::cached_author`])——判定全程离线,不为它新增网络请求。
pub async fn precheck(
    client: &ShareClient<'_>,
    repo: &RepoRef,
    state: &state::State,
    share_name: &str,
    me: Option<&Identity>,
    library_author: Option<&str>,
) -> Result<SharePrecheck, AppError> {
    let path = format!("skills/{share_name}/SKILL.md");
    let exists = match client {
        ShareClient::Gitea(c) => c.file_sha(repo, &path).await?.is_some(),
        ShareClient::Github(c) => c.file_exists(repo, &path).await?,
    };
    if !exists {
        return Ok(SharePrecheck::Fresh);
    }
    // 走到这里说明库里确实有这个技能,`in_library` 因此恒为 true;`local_present`
    // 在 `in_library` 为真时不参与判定(见 relation 的判定表),传什么都一样。
    if ownership::relation(me, library_author, true, true) == ownership::Relation::Shared {
        return Ok(SharePrecheck::Mine);
    }
    let mine = state.shared.iter().any(|s| {
        s.name == share_name && s.target.owner == repo.owner && s.target.repo == repo.repo
    });
    Ok(if mine { SharePrecheck::Mine } else { SharePrecheck::Taken })
}

// ============================================================ 提交

/// 分享一个技能需要知道的全部信息(v6 二期任务 6 起只剩三样)。
///
/// **没有 `share_name`/`display_name`/`description`/`origin`/`overwrite`**:
/// 分享环节零编辑(模块头 A-1),而标准校验保证「文件夹名 = frontmatter `name`
/// = 库里的目录名」三者同一,所以远端名不需要、也不允许由调用方另给一个。
#[derive(Debug)]
pub struct ShareRequest<'a> {
    pub registry_id: &'a str,
    pub repo: &'a RepoRef,
    /// 技能标识。core 自己经 [`converge::locate`] 解析出本体住在哪
    /// ——**调用方不传路径**(旧的 `source_path` 让前端替 core 回答"本体在哪",
    /// 而那正是 v6 二期要收进 core 的唯一判定)。
    pub dir_slug: &'a str,
    /// 用户已在**统一分享确认屏**上拍过板(v8 任务 5 / D9):他看过了这次会新增、
    /// 修改、**删除**哪些文件,库里被改过时还看过顶部那条覆盖警告,仍然要推。
    ///
    /// ⚠️ 它取代了任务 4 的 `overwrite`,**不是改名**:那个只回答"知不知道会顶掉
    /// 我自己上一版",而删除能力上线后,同一次动作还要回答"知不知道库里哪几个文件
    /// 会没"。两件事拆成两个 bool 就是同一个动作两屏确认(D9 明确反对),所以合成
    /// 一个:`None` = 预览轮(**一个写请求都不发**),`Some(rev)` = 执行轮。
    ///
    /// 🔴 **它是 `Option<&str>` 而不是 `bool`(终审 C-1)**:执行轮必须带上
    /// "用户看到的那份清单是基于库里哪一版算出来的"。两轮之间同事往那个技能目录里
    /// 推了新文件的话,执行轮重算出的删除清单会多出一条**从未出现在用户看过的清单上
    /// 的文件**,而它会被真的删掉——铁律 7 与本项目命名过的「确认屏说 A、实际做 B」。
    /// 拆成两个形参(`confirmed: bool` + `rev: Option<..>`)就等于把这条不变量交给
    /// 约定;合成一个 `Option` 之后,"确认了却没带凭据"在 Rust 侧根本写不出来。
    ///
    /// 凭据的取值见 [`Confirmation`]。
    pub confirm: Option<Confirmation<'a>>,
}

/// 用户按下确认时必须带回来的两条凭据。**两条,不是一条**(v8 任务 8 / 顾问①)。
///
/// 终审 C-1 只绑了库里那一版([`remote_rev`])。摆出内容级差异之后,我们等于向
/// 用户承诺「**你看到的差异 = 我要推的差异**」——而执行轮是**重新读本地文件**的。
/// 本地在两轮之间被改(这个项目里 Claude Code 正在编辑是常态)就会推走用户
/// **没看过**的内容,而 `remote_rev` 照样对得上、**不触发重看**。
///
/// 🔴 **两个字段刻意不合并成一个复合 token**:两种失效对用户是**两句不同的话**
/// ——「技能库里那一版被别人改过了」与「你本地又改过了」。合并之后界面只知道
/// "凭据不对",说不清到底发生了什么。出口同一条([`StaleReason`] 两个成员),
/// 措辞两句。
///
/// 🔴 **合成一个 struct 而不是两个 `Option` 形参**:与 T5 把 `confirmed: bool`
/// 合成 `Option<&str>` 是同一条道理——"确认了却只带一条凭据"在 Rust 侧根本写不出来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Confirmation<'a> {
    /// 这份清单是基于**库里哪一版**算出来的,见 [`remote_rev`]。
    pub remote_rev: &'a str,
    /// 这份清单**自己**的指纹,见 [`PlannedChanges::plan_rev`]。
    pub plan_rev: &'a str,
}

/// 用户看过的那份清单为什么作废了。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StaleReason {
    /// 技能库里那一版变了(同事推了东西)。
    RemoteChanged,
    /// 本机这个技能变了(用户自己、或正开着的编辑器改的)。
    LocalChanged,
}

/// 这一轮该出清单还是该提交。
pub(crate) enum ConfirmGate {
    /// 没带凭据 = 预览轮,出清单,一个写请求都不发。
    Preview,
    /// 带了凭据,但它绑的那份清单已经作废,**照样只出清单**。
    Stale(StaleReason),
    /// 凭据对得上,照推。
    Go,
}

impl ConfirmGate {
    fn stale_reason(&self) -> Option<StaleReason> {
        match self {
            ConfirmGate::Stale(r) => Some(*r),
            _ => None,
        }
    }
}

/// 两条凭据**分别**比,而且顺序固定:先库里、后本地。
///
/// 两条都变时报 `RemoteChanged` 就够了,**不需要第三个"两边都变了"的成员**:
/// 退回去的那份清单是**重算**的,它自带的新 `plan_rev` 已经把新的本地状态绑上了,
/// 用户看的就是最新的两边。多一个成员只会多一句没人需要的话。
pub(crate) fn confirm_gate(
    confirm: Option<Confirmation<'_>>,
    remote_rev: &str,
    plan_rev: &str,
) -> ConfirmGate {
    match confirm {
        None => ConfirmGate::Preview,
        Some(c) if c.remote_rev != remote_rev => ConfirmGate::Stale(StaleReason::RemoteChanged),
        Some(c) if c.plan_rev != plan_rev => ConfirmGate::Stale(StaleReason::LocalChanged),
        Some(_) => ConfirmGate::Go,
    }
}

/// 提交走的路径。
///
/// **v8 任务 3(D1)起只剩 `Pushed` 一档**:提交审核与只读用户的副本两条路整体
/// 下线。留着这个枚举而不压成"没有返回值",是因为 core 仍要如实回报"这次到底
/// 做成了什么",而不是让调用方从"没有报错"倒推。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareMode {
    /// 直接进了默认分支。
    Pushed,
}

/// 分享的结果。**只剩 `Shared` 一档**:同名被别人占用不再是"等用户三选一"
/// 的拍板档,而是一个如实的错误(`REPO_NAME_TAKEN`)——覆盖别人的技能这条路
/// 已整体取消,改名由用户在本地完成(模块头 A-3)。
///
/// ⚠️ **序列化形状**:`rename_all` 挂在**枚举**上只改 variant 名,**不改 struct
/// variant 里的字段名**——必须另加 `rename_all_fields`。这个坑真炸过一次
/// (`review_url` 原样发成蛇形,界面读 `reviewUrl`,那条链接从来没渲染过;
/// 那个字段已随提交审核一起删除)。下面的
/// `share_outcome_serializes_every_field_in_camel_case` 正面钉住完整键集合。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "outcome")]
pub enum ShareOutcome {
    Shared {
        mode: ShareMode,
        commit_sha: String,
        /// 库里这个技能的目录名(= 本体文件夹名 = frontmatter `name`,三者同一)。
        share_name: String,
    },
    /// 预览轮的结果:这次会改动库里哪些文件(D6/D9)。**返回它时磁盘与远端
    /// 一个字节都没动**,用户在确认屏上拍板后带 `confirmed: true` 重来。
    ///
    /// `overwrite` 非空 = 库里那一版与本地基线不符,推上去会顶掉它——确认屏把它
    /// 显示在清单**顶部**,不另开一屏(D9)。
    NeedsConfirm {
        plan: SharePlan,
        overwrite: Option<OverwriteWarning>,
        /// 这份清单是基于库里哪一版算出来的([`remote_rev`])。执行轮原样带回来,
        /// core 比不上就**不提交**,而是重新算一份再问一次(终审 C-1)。
        remote_rev: String,
        /// 这份清单**自己**的指纹([`PlannedChanges::plan_rev`])。与上面那条一起
        /// 原样带回来,见 [`Confirmation`]。
        plan_rev: String,
        /// `true` = 用户确实按过确认,但他看清单的这段时间里情况变了,
        /// 这是**重新算出来的**第二份清单。界面必须如实说明发生了什么
        /// ——静默换掉清单,用户会以为自己看花了眼。
        stale: bool,
        /// 变的是哪一头([`StaleReason`])。`stale == stale_reason.is_some()`,
        /// 两者在**同一处**赋值(`stale: reason.is_some()`),不会漂。
        /// 留着 `stale` 是因为既有渲染点读它,这一条只是多告诉界面一句原因。
        stale_reason: Option<StaleReason>,
    },
    /// 库里这个技能已经与本地逐字节一致,**一个请求都没发**。
    ///
    /// 这不是"什么都没做",它是 v8 要治的那个病灶的正解:此前分享只上传不比对,
    /// 内容相同时照样提交,Gitea 照样建 commit——同事那三个空的合并请求就是这么
    /// 来的。走到这一档时顺手把陈旧基线对齐(T2 的 `align_baseline` 同一件事),
    /// 用户那一行就不会永远显示"和库里不一样"。
    AlreadyInSync,
}

/// 校验没过。`detail` 带 [`ShareBlock`] 的 camelCase 字面量,界面按它查文案表
/// ——**不在 core 里拼那句中文**(core 返回枚举、不返回给用户看的句子)。
///
/// 字面量取自 `ShareBlock` 自己的 serde 形状(`serde_json::to_value`),
/// **不手抄第二份名字映射**:抄一份就会漂,而漂了两边照样各自全绿。
fn skill_invalid_err(block: ShareBlock) -> AppError {
    let name = serde_json::to_value(block)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    AppError::new(
        "FS_SKILL_INVALID",
        "这个技能还不符合分享要求,请按提示改好后再分享",
    )
    .with_detail(name)
}

/// 分享一个本机技能。`now` 由调用方注入(派生评审分支名,便于测试)。
///
/// 主体顺序(每一步的先后都是判据,不是习惯):
/// 1. [`converge::locate`] 解析本体——多份内容分歧时报 `FS_NEEDS_VERSION_CHOICE`,
///    交给用户先在「留哪份」里拍板;一份都没有报 `FS_NOT_FOUND`;
/// 2. [`skills::validate_skill_dir`] 标准校验。**必须在任何网络请求之前**
///    ——不合格的技能连一次探测都不该发出去(测试正面断言"零请求");
/// 3. [`precheck`] 同名判定:`Taken`(库里有同名、且不是我分享的)→ `REPO_NAME_TAKEN`;
/// 4. [`converge::ensure_canonical_link`]:本体不搬,只保证 canonical 有一条
///    指向它的链接(cursor/codex 与全部 universal 工具唯一的读取位置)。
///    **返回 `Differs` 不算失败**:canonical 上那份实体内容与本体不同,是"两个版本"
///    的问题,由「我的技能」页单独让用户拍板,不该顺手把一次分享整个拦掉;
/// 5. 读本体目录 → 按权限矩阵提交;
/// 6. 记账:`state.shared` 的 `local_path` 记**本体所在**,查找也按同一把钥匙
///    (`Path` 比,不是字符串比)。
///
/// `trasher` 与 `acquire` 同款,由调用方注入:第 4 步的 `converge` 在 canonical
/// 上遇到一份**同内容**的实体副本时会把它送进废纸篓再换成链接,默认实现是**真实
/// 系统废纸篓**,测试必须注入 `SandboxTrash`。
#[allow(clippy::too_many_arguments)]
pub async fn share(
    client: &ShareClient<'_>,
    // 读链路:覆盖闸要拿库里的实时内容比一比(检测走读、提交走写,不能省成一个)。
    read: &impl RepoSource,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    trasher: &dyn Trasher,
    req: ShareRequest<'_>,
    now: &str,
) -> Result<ShareOutcome, AppError> {
    // 这一段里的写盘是本应用自己干的,期间的文件事件不上报(见 core/watcher.rs 模块头)
    let _quiet = crate::core::watcher::app_write();
    let installer = Installer::new(registry, env).with_trasher(trasher);
    let loaded = store.load_state()?;

    // ① 本体在哪
    let body: PathBuf = match converge::locate(&installer, registry, env, &loaded.value, req.dir_slug)? {
        converge::Located::Differs(versions) => {
            return Err(AppError::new(
                "FS_NEEDS_VERSION_CHOICE",
                "这个技能在你电脑上有好几个不一样的版本,请先选定保留哪一份",
            )
            .with_detail(format!("{} versions for {}", versions.len(), req.dir_slug)))
        }
        converge::Located::None => return Err(missing_body_err(req.dir_slug)),
        converge::Located::Body { body, .. } => body,
    };
    if !body.join("SKILL.md").is_file() {
        return Err(missing_body_err(req.dir_slug));
    }

    // ② 标准校验。**在任何网络请求之前**。
    skills::validate_skill_dir(&body).map_err(skill_invalid_err)?;
    // 校验刚刚证明了「文件夹名 = frontmatter name 且是合法的标准名」,所以库里的
    // 目录名直接取本体的叶子名——没有第二个名字可选,也不需要再解析一次 SKILL.md。
    let share_name = body
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| missing_body_err(req.dir_slug))?
        .to_string();

    // ③ 同名预检。归属判定的两个入参都离线取:身份来自登录那一刻落盘的
    //    `config.identities`,作者来自**目标库自己**的索引缓存。
    let config = store.load_config()?.value;
    let me = config.identities.get(req.registry_id);
    let library_author =
        crate::core::store::cached_author(store.dir(), req.registry_id, req.repo, &share_name);
    let checked = precheck(
        client,
        req.repo,
        &loaded.value,
        &share_name,
        me,
        library_author.as_deref(),
    )
    .await?;
    if checked == SharePrecheck::Taken {
        return Err(AppError::new(
            "REPO_NAME_TAKEN",
            "技能库里已经有一个同名技能,请先在本地给你的技能换个文件夹名",
        )
        .with_detail(format!("taken: {share_name}")));
    }

    // ③' 差集(D5)+ 覆盖闸(D14)。**两件事共用一次压缩包下载**——检测走读链路,
    //    提交走写链路,这条既有约束没变;变的是读那一侧只下载一次就够了。
    //    `Fresh` 时库里还没有这个技能:远端清单恒空 → 删除清单恒空、其余全进新增,
    //    也没有任何东西会被顶掉,所以这一档连压缩包都不用下。
    let fresh = checked == SharePrecheck::Fresh;
    let remote_path = format!("skills/{share_name}");
    let prefix = format!("{remote_path}/");
    let archive = if fresh { None } else { Some(read.download_archive(req.repo).await?) };
    let remote: BTreeMap<String, Vec<u8>> =
        archive.as_ref().map(|a| remote_files(a, &prefix)).unwrap_or_default();
    let changes = plan_changes(&prefix, &remote, payload_files(&body, &prefix)?)?;

    // 🔴 **差集为空 → 一个写请求都不发**(D5)。这是本期病灶的正解:此前这里
    //    照样提交,Gitea 照样建一个零改动的 commit。顺手对齐陈旧基线,否则那一行
    //    会永远显示"和库里不一样",用户只能一遍遍点分享、一遍遍造空提交。
    if changes.plan.is_empty() {
        align_shared_baseline(&installer, store, &loaded.value, &body, &req)?;
        return Ok(ShareOutcome::AlreadyInSync);
    }

    // 🔴 **预览轮与执行轮的绑定**(终审 C-1)。`rev` 是上面这份差集赖以算出的
    //    远端快照;执行轮带回来的凭据与它逐字相等,才说明"用户看过的清单 = 现在
    //    要做的事"。不等就**一个写请求都不发**,把重算出的清单(与重跑一次的覆盖闸)
    //    带 `stale: true` 退回去再问一次。
    //
    //    等号成立时不再重跑覆盖闸,**不是省事**:闸的全部输入(远端指纹、基线、
    //    技能路径)都没变,再跑一次必然得出同一个结论,而"同一条规则查两遍"是本项目
    //    记着的空转模式 ①——那一遍永远不触发,却会吞掉注入信号。
    //
    //    🔴 **凭据有两条**(v8 任务 8 / 顾问①):库里那一版 + 这份清单自己。
    //    摆出内容级差异之后,"用户看过的 = 现在要做的"这句承诺也包含本地那一侧,
    //    而执行轮是重新读本地文件的。完整原委见 [`Confirmation`]。
    let rev = archive.as_ref().map(|a| remote_rev(a, &remote_path)).unwrap_or_default();
    let gate = confirm_gate(req.confirm, &rev, &changes.plan_rev);
    if !matches!(gate, ConfirmGate::Go) {
        let baseline = loaded
            .value
            .shared
            .iter()
            .find(|s| {
                s.name == share_name
                    && s.target.owner == req.repo.owner
                    && s.target.repo == req.repo.repo
            })
            .map(|s| s.content_hash.as_str())
            .unwrap_or("");
        // 🔴 覆盖闸的基线取 `state.shared` 那条记账的指纹;换过电脑 / 从没经本 app
        //    分享过的作者根本没有这条记账,基线为空——[`overwrite_gate`] 仍然检测,
        //    **不跳过**(任务 4 / D14)。
        //    Fresh(archive 为 None)那一档库里还没有这个技能,没有覆盖警告可言,
        //    但清单照样要先给用户看一眼(D6「绝不静默删除」+ D9「一个动作一屏」)。
        let overwrite = match archive.as_ref() {
            Some(_) => overwrite_gate(&rev, client, req.repo, &remote_path, baseline).await?,
            None => None,
        };
        // `stale` 与 `stale_reason` 在**同一处**赋值,两者不可能漂。
        let reason = gate.stale_reason();
        return Ok(ShareOutcome::NeedsConfirm {
            plan: changes.plan,
            overwrite,
            remote_rev: rev,
            plan_rev: changes.plan_rev,
            stale: reason.is_some(),
            stale_reason: reason,
        });
    }

    // ④ 本体留在原地,canonical 只补一条指向它的链接。
    let home = installer.home(req.dir_slug, Some(&body))?;
    converge::ensure_canonical_link(&installer, &home)?;

    // ⑤ 提交
    let message = match checked {
        SharePrecheck::Fresh => format!("新增技能:{share_name}"),
        _ => format!("更新技能:{share_name}"),
    };
    // 🔴 基线取**推出去的那份字节**的指纹(定向复审 I-2),在 `changes` 被
    //    `submit` 拿走之前取出。提交之后再读盘,会把提交窗口里的新改动记成"已分享"。
    let pushed_hash = changes.local_hash.clone();
    let submitted =
        submit(client, req.repo, &prefix, fresh, changes, &message, &share_name).await?;

    // ⑥ 记账:content_hash 是**推出去的那份本体内容**——"有未分享的改动"的判据就是它
    let mut next = loaded.value.clone();
    let entry = SharedSkill {
        name: share_name.clone(),
        local_path: body.to_string_lossy().into_owned(),
        // 这个字段自 v6 二期起没有任何读者(来源标签统一走 `ownership::source_label`),
        // 保留只为不动 state schema;与 `acquire::seed_shared_baseline` 写的是同一个值。
        origin: "local".to_string(),
        target: SkillSource {
            registry_id: req.registry_id.to_string(),
            owner: req.repo.owner.clone(),
            repo: req.repo.repo.clone(),
            path: format!("skills/{share_name}"),
            git_ref: req.repo.branch.clone(),
        },
        last_pushed_sha: submitted.commit_sha.clone(),
        content_hash: pushed_hash,
    };
    let content_hash = entry.content_hash.clone();
    // 🔴 **钥匙是本体路径,不是远端名**:CLAUDE.md 记着 `state.shared` 读写双键
    // 不一致的既有隐患(写按远端名、读按本地路径)。远端名这个概念现在没了,
    // 两侧统一成同一把钥匙,并且**按 `Path` 比**。
    match next.shared.iter().position(|s| Path::new(&s.local_path) == body.as_path()) {
        Some(idx) => next.shared[idx] = entry,
        None => next.shared.push(entry),
    }
    record_pushed_skill(&mut next, &req, &home, &submitted, content_hash, now);
    store.save_state(&next)?;

    Ok(ShareOutcome::Shared {
        mode: submitted.mode,
        commit_sha: submitted.commit_sha,
        share_name,
    })
}

/// 「库里已与本地一致」那一档顺手做的基线对齐(v8 任务 5,呼应任务 2 的 D3)。
///
/// 两本账各自一条:
/// - `state.shared[..].content_hash` 是**覆盖闸**的基线。它陈旧时,下一次分享会
///   在内容明明一致的情况下弹一条"库里被人改过"的假警告;
/// - `state.installed[..].content_hash` 是**界面**"和库里不一样"的基线,由任务 2 的
///   [`converge::align_baseline`] 负责——**复用它,不另写一份**:那边的三道守卫
///   (不给无记账的行建账、坐标必须对得上、core 自己重算实时指纹)一条都不该绕过。
///
/// 两条都是"没有账就不建账",所以 `align_baseline` 的
/// `FS_NOT_INSTALLED` / `FS_LIBRARY_MISMATCH` 在这里**不是失败**:这次分享本来
/// 就可能是一个从没被本 app 装过的本地技能。其余错误照常上报。
fn align_shared_baseline(
    installer: &Installer<'_>,
    store: &Store,
    state: &state::State,
    body: &Path,
    req: &ShareRequest<'_>,
) -> Result<(), AppError> {
    let hash = fsops::dir_content_hash(body)?;
    let mut next = state.clone();
    if let Some(entry) =
        next.shared.iter_mut().find(|s| Path::new(&s.local_path) == body)
    {
        if entry.content_hash != hash {
            entry.content_hash = hash.clone();
            store.save_state(&next)?;
        }
    }
    match converge::align_baseline(
        installer,
        store,
        req.dir_slug,
        &hash,
        req.registry_id,
        &req.repo.owner,
        &req.repo.repo,
    ) {
        Ok(()) => Ok(()),
        Err(e) if e.code == "FS_NOT_INSTALLED" || e.code == "FS_LIBRARY_MISMATCH" => Ok(()),
        Err(e) => Err(e),
    }
}

fn missing_body_err(dir_slug: &str) -> AppError {
    AppError::new("FS_NOT_FOUND", "这个技能的内容已经不在了,请刷新后再试")
        .with_detail(format!("no body for {dir_slug}"))
}

/// 分享的闭环(M6 任务 5 引入,v6 二期任务 6 按新模型重写):**直推进库**之后
/// 给这个技能补上 `state.installed` 记账。
///
/// 它防的是**没有记账基线**:记账里的 `content_hash` 是「本地/库里谁更新」这套
/// 状态机的基线,没有它,刚直推进库的技能会落进 `noBaseline` 档——「分享更新」
/// 只能绕回来重推一遍(`share_installed` 一进门就要求记账存在,必撞
/// `FS_NOT_INSTALLED`),「移除」也一并没有。
///
/// 两道闸(v6 二期是三道;v8 任务 3 少的那道「只认直推」不是被忘掉的——
/// 提交审核整条下线之后 [`ShareMode`] 只剩 `Pushed` 一档,再判一遍就是同一条
/// 规则查两遍,而那一遍永远不触发,正是本项目记着的空转模式 ①,它会吞掉注入信号):
/// 1. **已有记账不覆盖**。回推改动走的是 [`share_installed`],不经过这里;
///    真走到这里说明是另一条路,覆盖账本会把 commit_sha 等既有事实抹掉;
/// 2. 记账键取 `home.dir_name`(= [`converge::record_key`]),`body` 只在本体
///    **不住在 canonical** 时才记——与 `acquire::record` 同一个约定。本体就在
///    canonical 时记成 `Some(canonical)` 是同一件事的第二种写法,是本项目吃过
///    亏的"两个概念取同值"。
///
/// 🔴 **旧的第二道闸「只认 canonical 里的技能」已被新模型推翻**:本体现在完全
/// 可以住在 `~/.claude/skills/`,那正是 v6 二期的主线场景;照搬那道闸会让"在
/// Claude Code 里开发、分享出去"的技能永远建不起基线。
/// 旧的第三道闸「本地目录名必须等于远端目录名」也没了——标准校验已经在上游
/// 保证了这件事,再判一遍就是同一条规则查两遍(本项目记着的空转模式 ①)。
///
/// `origin` 记 `claimed`:文件是用户自己的,本 app 只是记了账。这个字段现在只读,
/// 不驱动任何用户动作,留着是为了在 `commit_sha` 之外还有一份显式来历。
fn record_pushed_skill(
    next: &mut state::State,
    req: &ShareRequest,
    home: &crate::core::installer::SkillHome,
    submitted: &Submitted,
    content_hash: String,
    now: &str,
) {
    if next.installed.iter().any(|s| s.name == home.dir_name) {
        return;
    }
    next.installed.push(state::InstalledSkill {
        name: home.dir_name.clone(),
        source: SkillSource {
            registry_id: req.registry_id.to_string(),
            owner: req.repo.owner.clone(),
            repo: req.repo.repo.clone(),
            path: format!("skills/{}", home.dir_name),
            git_ref: req.repo.branch.clone(),
        },
        commit_sha: submitted.commit_sha.clone(),
        // 基线取刚推上去的内容:不等就会立刻误报"有可用更新 / 有未分享的改动"
        content_hash,
        origin: Some(crate::core::acquire::ORIGIN_CLAIMED.to_string()),
        // 本体住在 canonical 时留空(约定同 `acquire::record`),否则如实记下它在哪
        body: if home.body_is_canonical() {
            None
        } else {
            Some(home.body.to_string_lossy().into_owned())
        },
        // 关联没建过就如实留空——这里只记账,一个字节都不动磁盘
        agents: Vec::new(),
        links: Vec::new(),
        installed_at: now.to_string(),
        updated_at: now.to_string(),
    });
}

// ============================================================ 覆盖闸

/// 「推上去会不会顶掉库里那一版」——两条分享通道共用的唯一判据(v8 决策 D14)。
///
/// 返回 `None` = 不会顶掉任何东西,照常提交;返回 `Some` = 要用户先拍板,
/// 此刻磁盘与远端**一个字节都没动**。
///
/// 判据分两档,分界是**基线在不在**:
/// - **基线非空**:`库里实时内容 ≠ 本地基线` 即拦。基线是"上次与库里对齐时的
///   指纹",本地改动不动它——所以这一档**不看本地改没改**:本地没改时推上去的是
///   旧版,照样顶掉对方。
/// - 🔴 **基线为空:按「未知」处理,直接比 `库里实时 vs 本地实时`**,而不是像
///   v8 之前那样**跳过检测**。换过电脑、或早年经别的途径分享过的作者,本机根本
///   没有记账,沿用旧行为就是**不弹任何警告直接覆盖**。相同 → 放行(没什么可
///   覆盖的);不同 → 照样拦。
///
/// `read` 走**读链路**、`client` 走**写链路**,两者不能省成一个(现役约束)。
/// 拿不到"最后由谁改的"不影响这道闸拦不拦——那是 best-effort 的展示信息。
/// 「用户看到的清单是基于库里哪一版算出来的」这件事的凭据(终审 C-1)。
///
/// 取值是**这个技能目录的远端内容指纹**,不是分支头 sha。两个理由:
///
/// 1. **零新增请求**:压缩包已经在手里,这就是 [`overwrite_gate`] 本来就要算的
///    那个值——两轮的指纹相等 ⇒ 差集与覆盖警告必然逐字相同,"执行轮复用同一份
///    远端快照"这条语义因此在数据上成立,而不是靠注释承诺;
/// 2. **不会被无关改动误伤**:分支头 sha 会因为别人分享**另一个**技能而变,
///    那会把用户赶回确认屏重看一份一模一样的清单——假警报会训练人闭眼点确认。
///
/// 指纹含**路径**与长度前缀([`fsops::ContentHasher`]),所以"内容不变只改名"
/// 也测得出来;排除名单与 [`plan_changes`] 的删除侧同走 `is_excluded_rel`,
/// 两把尺子对齐,不会出现"指纹没变、清单变了"。
///
/// 库里还没有这个技能时是空串——那一档压根没有远端文件,删除清单恒空。
fn remote_rev(archive: &RepoArchive, remote_path: &str) -> String {
    // entries 的键保留压缩包顶层目录,技能路径必须拼上 archive.root 才剥得到条目
    // (store.rs 建索引时的 s.dir 天然带着它,这里的记账路径没有)
    crate::core::store::remote_content_hash(archive, &format!("{}/{remote_path}", archive.root))
}

async fn overwrite_gate(
    remote_hash: &str,
    client: &ShareClient<'_>,
    repo: &RepoRef,
    remote_path: &str,
    baseline: &str,
) -> Result<Option<OverwriteWarning>, AppError> {
    let differs = if baseline.is_empty() {
        // 🔴 **不再在这里比"库里 vs 本地"**(v8 任务 5):两边逐字节相同的那一档
        // 已经被调用方的差集短路成 `AlreadyInSync` 了,再比一遍就是同一条规则查
        // 两遍、而且那一遍永远不触发——本项目记着的空转模式 ①,它会吞掉注入信号。
        // 走到这里就意味着两边确实不同,库里非空即有东西会被顶掉。
        !remote_hash.is_empty()
    } else {
        remote_hash != baseline
    };
    if !differs {
        return Ok(None);
    }
    let (last_author, last_at) = match client {
        ShareClient::Gitea(c) => match c.last_commit(repo, remote_path).await {
            Some(lc) => (lc.author, lc.at),
            None => (None, None),
        },
        // GitHub 臂本任务不新增请求:链接照给,"谁/什么时候"如实留空。
        ShareClient::Github(_) => (None, None),
    };
    Ok(Some(OverwriteWarning {
        last_author,
        last_at,
        history_url: Some(match client {
            ShareClient::Gitea(c) => c.history_url(repo, remote_path),
            ShareClient::Github(c) => c.history_url(repo, remote_path),
        }),
    }))
}

// ============================================================ 回推已装技能的改动

/// 覆盖确认屏要说清的三件事:**覆盖谁、什么时候推的、去哪找回**(v8 决策 D2)。
///
/// 三个字段都是 `Option`,而且**绝不用空串冒充**:界面按"有没有值"决定那半句
/// 话摆不摆。`author`/`at` 来自单点的 [`gitea::Client::last_commit`]
/// (best-effort,取不到不影响这道闸照样拦);`history_url` 是 web UI 的提交
/// 历史页——"被替换的那一版仍能找回来"这句承诺的落点。
///
/// ⚠️ **`rename_all` 必须写在这个 struct 自己身上**:外层枚举的
/// `rename_all_fields` 管不到 newtype variant 内层 struct 的字段名。
/// 这个坑在本项目真炸过一次(`review_url` 原样发成蛇形,链接从没渲染过),
/// 下面 `share_outcome_serializes_every_field_in_camel_case` 正面钉住键集合。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverwriteWarning {
    /// 库里这个技能最后由谁改的(展示名优先)。取不到就是 `None`。
    pub last_author: Option<String>,
    /// 最后一次改动的时间(原样 ISO-8601)。取不到就是 `None`。
    pub last_at: Option<String>,
    /// 该技能目录在目标分支上的提交历史页;给不出时前端降级为纯文案。
    pub history_url: Option<String>,
}

/// 回推的两种结局:提交成功,或撞上"库里这一版与本地基线不符"的覆盖档。
///
/// 覆盖档**不是错误,是"要你先拍板"**:返回它时磁盘与远端一个字节都没动。
/// 用户看过 [`OverwriteWarning`] 后仍要覆盖,就带 `overwrite: true` 再来一次。
#[derive(Debug, Serialize)]
// 🔴 `rename_all_fields` 不能漏(终审 C-1 加 `remote_rev` 时当场被守卫抓到):
// 枚举上的 `rename_all` 只改 variant 名,struct variant 里的字段名归它管。
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ShareInstalledOutcome {
    Submitted(Submitted),
    /// 与 [`ShareOutcome::NeedsConfirm`] 同构:回推改动同样会删除库里的文件,
    /// 所以它也必须过确认屏(D6 在**两条分享通道**上都成立,不能只管一条)。
    NeedsConfirm {
        plan: SharePlan,
        overwrite: Option<OverwriteWarning>,
        /// 见 [`ShareOutcome::NeedsConfirm`] 的同名字段(终审 C-1)。
        remote_rev: String,
        /// 见 [`ShareOutcome::NeedsConfirm`] 的同名字段(v8 任务 8)。
        plan_rev: String,
        /// 见 [`ShareOutcome::NeedsConfirm`] 的同名字段(终审 C-1)。
        stale: bool,
        /// 见 [`ShareOutcome::NeedsConfirm`] 的同名字段(v8 任务 8)。
        stale_reason: Option<StaleReason>,
    },
    /// 库里已与本地一致;顺手做一次基线对齐(T2 的 [`converge::align_baseline`])。
    AlreadyInSync,
}

/// 把本 app 安装、用户改过的技能推回它的来源仓库。
///
/// 这就是获取流程冲突弹窗里承诺的"分享功能开放后可以分享改动"那条路。
/// 直推成功 → 更新 `contentHash`/`commitSha`,「已改动」标记消失。
///
/// 提交前先过 [`overwrite_gate`](D14):库里这一版与本地基线不符就退回
/// [`ShareInstalledOutcome::RemoteChanged`],**与本地改没改无关**(本地没改时
/// 回推的是旧版,照样顶掉对方)。乐观锁(CONFLICT_STALE)只拦"拉 sha 与提交
/// 之间"的瞬间竞态,防不了这一档,两者是互补关系。
#[allow(clippy::too_many_arguments)]
pub async fn share_installed(
    client: &ShareClient<'_>,
    read: &impl RepoSource,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    dir_slug: &str,
    branch: &str,
    // 用户已在**统一分享确认屏**上拍过板:看过这次会新增/修改/删除哪些文件,
    // 库里被改过时还看过顶部那条覆盖警告,仍然要推(v8 任务 5 / D9)。
    //
    // 🔴 它与已下线的 `force_review` 只是形参位置相同,**语义方向完全相反**:
    // 那个是"有权限也不许直推,强制开合并请求";这个是"看过了,照推"。
    //
    // 🔴 `Option<Confirmation>` 而不是 `bool`(终审 C-1 + v8 任务 8):执行轮必须
    // 带上"那份清单基于库里哪一版"与"那份清单自己长什么样"两条凭据,
    // 见 [`ShareRequest::confirm`] 与 [`Confirmation`]。
    confirm: Option<Confirmation<'_>>,
    now: &str,
) -> Result<ShareInstalledOutcome, AppError> {
    // 显式 `.with_trasher(SYSTEM_TRASH)`:默认值本来就是它,这条路上的 installer
    // 也只用于 `record_key`/`home_of`(两者都不碰废纸篓),所以今天零风险。
    // 写出来只为一件事——**全仓其余生产入口都显式带,唯独这里是例外**,
    // 而"唯一的例外"正是下一个人照抄时最容易抄错的形状(终审 M-1)。
    let installer = Installer::new(registry, env).with_trasher(&fsops::SYSTEM_TRASH);
    let loaded = store.load_state()?;
    // 🔴 查账键走 [`converge::record_key`],**不是调用方手上的 `dir_slug`**:
    // 记账键是清洗后的目录名(会小写化),而 `dir_slug` 是技能库里的原始目录名
    // ——`Weekly-Report` 这样的技能按 `dir_slug` 查必然查不到账,用户点「分享更新」
    // 只会得到「这个技能不在已获取列表中」。理由的完整版在 `record_key` 的文档里。
    let key = converge::record_key(&installer, dir_slug)?;
    let Some(idx) = loaded.value.installed.iter().position(|s| s.name == key) else {
        return Err(AppError::new(
            "FS_NOT_INSTALLED",
            "这个技能不在已获取列表中,请刷新后再试",
        )
        .with_detail(format!("not installed: {dir_slug}")));
    };
    let record = &loaded.value.installed[idx];
    // branch 由调用方给:安装记账的 git_ref 存的是 commit sha,不是分支名,
    // 从它反推不出来;而写死 main 会在内建库用别的默认分支时推错地方。
    let repo = RepoRef {
        owner: record.source.owner.clone(),
        repo: record.source.repo.clone(),
        branch: branch.to_string(),
    };

    // 本体在哪由 [`converge::home_of`] 说了算,**不再假定它住在 canonical**
    // (v6 二期):用户在 `~/.claude/skills/` 里开发的技能,拿 canonical 拼出来的
    // 路径要么根本不存在、要么是一条链接——前者报"内容已不存在"(假话),
    // 后者读出来的仍是本体,只是绕了一圈还多一处守卫看不见的本体解析点。
    let home = converge::home_of(&installer, &loaded.value, dir_slug)?;
    let source_dir = home.body.clone();
    if !source_dir.join("SKILL.md").is_file() {
        return Err(AppError::new(
            "FS_NOT_FOUND",
            "本地技能内容已不存在,无法分享改动",
        )
        .with_detail(format!("missing: {}", source_dir.display())));
    }
    // 🔴 **标准校验,与 [`share`] 同一把尺子、同样排在任何网络请求之前**
    // (终审 C-3)。A-2 是拍板不复议的硬规则:「分享前按 Agent Skills 标准全量
    // 校验,不合格不让分享」——而这里是分享的**第二条通道**,此前一个字的校验
    // 都没有,于是本期的旗舰场景整个漏了:用户在 `~/.claude/skills/x` 开发 →
    // 分享(过闸)→ 继续迭代时把 frontmatter 的 `name` 改成中文 → 点「分享更新」
    // → 一个 `name ≠ 文件夹名`、非 ASCII 的技能直推进公司技能库,全程零提示。
    //
    // **放在网络请求之前**不是顺手:不合格时磁盘与远端都必须零动作,而下面第一件
    // 事就是 `download_archive`。`share()` 那侧有"请求条数 = 0"的硬断言,这侧同款。
    skills::validate_skill_dir(&source_dir).map_err(skill_invalid_err)?;

    // 差集 + 覆盖闸共用一次压缩包下载(检测走读链路、提交走写链路,这条没变)。
    let remote_path = record.source.path.trim_end_matches('/').to_string();
    let prefix = format!("{remote_path}/");
    let archive = read.download_archive(&repo).await?;

    // 🔴 **「不是我分享的技能」在这里被拒**(v8 任务 6 / D7)。
    //
    // ⚠️ **这不是「同一条规则查两遍」,别当空转删掉**:界面自 v8 任务 6 起已经
    // 不摆「贡献更改」那颗按钮了——那是**不摆**;这里是**不许**,防的是绕过界面
    // 的调用(存量前端、脚本、以后被人顺手接回去的新入口)。两层职责不同:
    // 界面负责"不引导用户走一条死路",core 负责"这条路真的走不通"。
    //
    // 判据走 [`ownership::relation`](全仓唯一一处"这是不是我分享的"判定),
    // 作者取自**刚下载的这份压缩包**里的库根 authors.json:零新增请求,而且是
    // 此刻库里的实时事实。**刻意不用 `store::cached_author`**——索引缓存冷着时
    // 它返回 `None`,会把一次合法的「分享改动」误拒。
    //
    // 🔴 **库里没登记作者时放行**:那一刻我们并不知道"这不是你的",而
    // "拿不知道当没有"是本项目反复记着的另一种撒谎(与"权限探不到一律 Unknown、
    // 绝不落进无权限档"同一条)。真实内网库里"改别人的技能"这一档必然有作者
    // (38 个技能 / 5 位作者,D7 的实证),漏掉的只是"作者未登记"那一小撮,
    // 而那一撮界面同样不摆按钮。
    if let Some(library_slug) = record.library_dir_slug() {
        if let Some(author) =
            crate::core::store::parse_authors(&archive).get(&library_slug).map(|a| a.author.clone())
        {
            let config = store.load_config()?.value;
            let me = config.identities.get(&record.source.registry_id);
            if ownership::relation(me, Some(author.as_str()), true, true) != ownership::Relation::Shared
            {
                return Err(AppError::new(
                    "REPO_NOT_AUTHOR",
                    format!("这个技能是 {author} 分享的,你的改动不会自动进技能库。想让作者采纳,直接联系 {author}"),
                )
                .with_detail(format!("author={author}, slug={library_slug}, me={:?}", me.map(|i| &i.login))));
            }
        }
    }

    let changes =
        plan_changes(&prefix, &remote_files(&archive, &prefix), payload_files(&source_dir, &prefix)?)?;

    // 🔴 差集为空 → 一个写请求都不发,顺手对齐陈旧基线(D5 + 任务 2 的 D3)。
    // 这条正是同事那几行"永远显示不一样、点分享只造空提交"的出路。
    if changes.plan.is_empty() {
        let observed = fsops::dir_content_hash(&source_dir)?;
        converge::align_baseline(
            &installer,
            store,
            dir_slug,
            &observed,
            &record.source.registry_id,
            &repo.owner,
            &repo.repo,
        )?;
        return Ok(ShareInstalledOutcome::AlreadyInSync);
    }

    // 确认屏(D6/D9)+ 预览轮与执行轮的绑定(终审 C-1,完整原委见 [`remote_rev`]
    // 与 [`share`] 里的同一段):凭据对得上才照推,对不上就重算一份再问一次。
    let rev = remote_rev(&archive, &remote_path);
    let gate = confirm_gate(confirm, &rev, &changes.plan_rev);
    if !matches!(gate, ConfirmGate::Go) {
        let overwrite =
            overwrite_gate(&rev, client, &repo, &remote_path, &record.content_hash).await?;
        let reason = gate.stale_reason();
        return Ok(ShareInstalledOutcome::NeedsConfirm {
            plan: changes.plan,
            overwrite,
            remote_rev: rev,
            plan_rev: changes.plan_rev,
            stale: reason.is_some(),
            stale_reason: reason,
        });
    }

    let message = format!("更新技能:{dir_slug}");
    // 基线取推出去的那份字节(定向复审 I-2,原委见 [`PlannedChanges::local_hash`])
    let pushed_hash = changes.local_hash.clone();
    // fresh=false:已装技能的回推,远端必然已有这组文件
    let submitted = submit(client, &repo, &prefix, false, changes, &message, dir_slug).await?;

    // 内容确实进库了才更新基线(D3)。`submit` 只有直推一条路,走到这里就是成功。
    let mut next = loaded.value.clone();
    next.installed[idx].commit_sha = submitted.commit_sha.clone();
    next.installed[idx].content_hash = pushed_hash;
    next.installed[idx].updated_at = now.to_string();
    store.save_state(&next)?;
    Ok(ShareInstalledOutcome::Submitted(submitted))
}

// ============================================================ 内部

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submitted {
    pub mode: ShareMode,
    pub commit_sha: String,
}

/// 按来源类型分发提交。`fresh` = 远端还没有该技能(Gitea 路径可跳过拉取 blob sha)。
#[allow(clippy::too_many_arguments)]
async fn submit(
    client: &ShareClient<'_>,
    repo: &RepoRef,
    prefix: &str,
    fresh: bool,
    changes: PlannedChanges,
    message: &str,
    share_name: &str,
) -> Result<Submitted, AppError> {
    match client {
        ShareClient::Gitea(c) => {
            // 更新路径需要远端各文件的 blob sha,**删除也要**(Gitea 拿它做乐观锁);
            // Fresh 不需要(全 create,而且删除清单恒空)。
            let remote_shas: BTreeMap<String, String> = if fresh {
                BTreeMap::new()
            } else {
                let head = c.branch_head(repo).await?;
                c.tree_files(&repo.owner, &repo.repo, &head.sha)
                    .await?
                    .into_iter()
                    .filter(|f| f.path.starts_with(prefix))
                    .map(|f| (f.path, f.sha))
                    .collect()
            };
            let mut files: Vec<FileChange> = changes
                .upload
                .into_iter()
                .map(|(path, bytes)| match remote_shas.get(&path) {
                    Some(sha) => FileChange::update(path.clone(), &bytes, sha.clone()),
                    None => FileChange::create(path.clone(), &bytes),
                })
                .collect();
            for path in changes.delete {
                // 🔴 sha 拿不到就跳过这一条,而且**这不是"部分应用"那种半成品**:
                // 差集来自压缩包快照,sha 来自 `branch_head` 那一刻的文件树,
                // 后者更新。树里没有这条路径 = 这个文件在目标分支上**已经不存在了**
                // (别人先删掉了),要办的事已经办成,跳过之后两边仍然一致。
                // 树被截断那种"清单不完整"的情形不会走到这里——`tree_files` 自己
                // 就对 `truncated` 报 `REPO_TOO_LARGE`,一条都不返回。
                // 硬发一条没有 sha 的删除只会被 Gitea 整笔拒掉,把用户真正要办的
                // 上传也一起拖垮。
                match remote_shas.get(&path) {
                    Some(sha) => files.push(FileChange::delete(path.clone(), sha.clone())),
                    None => tracing::warn!(%path, "要删除的文件不在远端文件树里,跳过这一条"),
                }
            }
            // 归因修订(M7 任务 5)在 submit_gitea 内部追加。GitHub 臂刻意不做:
            // authors.json 是公司库契约,GitHub 源本来就不展示归因。
            submit_gitea(c, repo, files, message, share_name).await
        }
        ShareClient::Github(c) => {
            submit_github(c, repo, &changes.upload, &changes.delete, message).await
        }
    }
}

// ============================================================ 归因维护(M7 任务 5)

/// 库根归因文件名。它是提交里唯一"可以被牺牲"的条目(见 [`change_files_sparing_skill`])。
const AUTHORS_FILE: &str = "authors.json";

/// 提交;若因归因条目被拒,**剥掉归因重试一次**,保住用户真正要办的事。
///
/// 为什么需要这一层:归因与技能文件在同一笔多文件提交里,而 Gitea 的 contents API
/// 是原子的——`authors.json` 的 blob sha 一旦过期(**每次分享都写这一个文件**,
/// 两个人同时分享不同技能就会撞上),**整笔提交连技能文件一起被拒**。
/// 用户看到的是一句与归因毫无关系的冲突错误,而他的分享根本没进去。
/// 「归因绝不拦分享」必须在**提交边界**也成立,不能只在读取边界成立。
///
/// `REPO_FORBIDDEN` 直接上报、**不剥归因重试**:那是目标受保护,不是归因的锅,
/// 剥掉重试照样会被拒。调用方据此折成 [`push_blocked_err`](v8 任务 3 起不再
/// 降级走提交审核——那条路已下线)。
async fn change_files_sparing_skill(
    client: &GiteaClient,
    owner: &str,
    repo: &str,
    req: &ChangeFilesRequest,
) -> Result<crate::core::gitea::CommitResult, AppError> {
    match client.change_files(owner, repo, req).await {
        Ok(commit) => Ok(commit),
        Err(e) if e.code == "REPO_FORBIDDEN" => Err(e),
        Err(e) => {
            let stripped: Vec<FileChange> =
                req.files.iter().filter(|f| f.path != AUTHORS_FILE).cloned().collect();
            if stripped.len() == req.files.len() {
                return Err(e); // 本来就没带归因,如实上报
            }
            // 🔴 剥完什么都不剩:这笔提交本来就**只有**归因(v6 的
            // [`claim_attribution`] 就是这一档)。此时"剥掉重试"退化成
            // 发一笔空提交——Gitea 要么报另一个风马牛不相及的错、要么造一个空提交,
            // 两种都比如实上报原来的错误糟。这条守卫是新调用方唯一能触发的路径。
            if stripped.is_empty() {
                return Err(e);
            }
            tracing::warn!(code = %e.code, "带归因修订的提交被拒,剥掉归因重试一次");
            let retry = ChangeFilesRequest { files: stripped, ..req.clone() };
            client.change_files(owner, repo, &retry).await
        }
    }
}

/// 归因修订的三种结果。`Untouchable` = 文件在但形状不对,**一个字节都不动**
/// ——重建会抹掉其他条目,修复交给管理员(scripts/gen-authors.mjs 或手改)。
#[derive(Debug, PartialEq, Eq)]
enum AttributionUpsert {
    Unchanged,
    Updated(String),
    Untouchable(&'static str),
}

/// 对库根 authors.json 做归因 upsert(纯逻辑,喂现值、吐新文本)。
///
/// 规则(M7 任务 5,用户拍板;与 store::parse_authors 的宽容读取是同一契约的两端):
/// - 条目不存在 → `author` = 分享者:"新增分享的那一刻"是"谁的技能"最真实的时刻;
/// - **条目已存在绝不改 author**:分享者非 author 且不在 contributors → 追加进
///   contributors(覆盖他人技能、回推改动都是这一档);已是 author / 已在列表 → 不动;
/// - 文件坏 JSON、顶层/authors/条目/contributors 形状不对 → `Untouchable`;
///   条目缺 author 同理——App 不猜残缺数据的语义,不动它。
///
/// **`aliases` 是同一个人的全部写法**(展示名 + 登录名),只用于"是否已在名单里"的比对;
/// 写进文件的永远是 `display`。少了它,同一个人会被记成两个:手工维护的初版与
/// gen-authors 的产出用的是 git 名/登录名,而 App 用 full_name——真实内网库的初版
/// 正是按登录名填的,而账号可能另设了中文全名,他一分享就会把自己追加成自己的贡献者。
///
/// serde_json 开着 preserve_order:其余条目与键序原样保住,diff 只有这一处。
fn upsert_attribution(
    existing: Option<&str>,
    dir_slug: &str,
    display: &str,
    aliases: &[&str],
) -> AttributionUpsert {
    use serde_json::{json, Map, Value};
    let mut doc: Value = match existing {
        None => json!({ "authors": {} }),
        Some(text) => match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return AttributionUpsert::Untouchable("authors.json 不是合法 JSON"),
        },
    };
    let Some(root) = doc.as_object_mut() else {
        return AttributionUpsert::Untouchable("authors.json 顶层不是对象");
    };
    let authors = root
        .entry("authors")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(map) = authors.as_object_mut() else {
        return AttributionUpsert::Untouchable("authors 字段不是对象");
    };
    match map.get_mut(dir_slug) {
        None => {
            map.insert(dir_slug.to_string(), json!({ "author": display }));
        }
        Some(entry) => {
            let Some(obj) = entry.as_object_mut() else {
                return AttributionUpsert::Untouchable("该技能的归因条目不是对象");
            };
            match obj.get("author").and_then(|v| v.as_str()) {
                None => return AttributionUpsert::Untouchable("该技能的归因条目缺 author"),
                Some(author) if ownership::is_same_person(Some(author), aliases) => {
                    return AttributionUpsert::Unchanged
                }
                Some(_) => {
                    let contributors = obj
                        .entry("contributors")
                        .or_insert_with(|| Value::Array(Vec::new()));
                    let Some(arr) = contributors.as_array_mut() else {
                        return AttributionUpsert::Untouchable("contributors 不是数组");
                    };
                    if arr.iter().any(|v| ownership::is_same_person(v.as_str(), aliases)) {
                        return AttributionUpsert::Unchanged;
                    }
                    arr.push(Value::String(display.to_string()));
                }
            }
        }
    }
    match serde_json::to_string_pretty(&doc) {
        // 尾随换行与 scripts/gen-authors.mjs 的产出一致,两种维护方式不打无谓的格式仗
        Ok(text) => AttributionUpsert::Updated(format!("{text}\n")),
        Err(_) => AttributionUpsert::Untouchable("序列化失败"),
    }
}

/// 取分享者展示名 + 库根 authors.json 现值,算出要并进本次提交的归因修订。
///
/// **任何一步失败都返回 None(跳过维护),绝不拦分享**——归因是锦上添花,
/// 分享才是用户此刻要办的事。
async fn attribution_file_change(
    client: &GiteaClient,
    repo: &RepoRef,
    dir_slug: &str,
) -> Option<FileChange> {
    let user = match client.current_user().await {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!(code = %e.code, "取不到分享者身份,本次跳过归因维护");
            return None;
        }
    };
    // 展示名口径(用户拍板):full_name 优先,空则 login。
    // login 同时作为别名参与"是否已在名单里"的比对——存量数据(手工填的、
    // gen-authors 从 git 历史算的)记的往往是登录名。
    let login = user.login.trim().to_string();
    let full_name = user.full_name.trim().to_string();
    let display = if full_name.is_empty() { login.clone() } else { full_name };
    if display.is_empty() {
        tracing::warn!("分享者身份没有可用的名字,本次跳过归因维护");
        return None;
    }
    let identity = Identity { login: login.clone(), display_name: display.clone() };
    let aliases: Vec<&str> = identity.aliases();
    let existing = match client.file_content(repo, AUTHORS_FILE).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(code = %e.code, "读不到库根 authors.json,本次跳过归因维护");
            return None;
        }
    };
    match existing {
        None => match upsert_attribution(None, dir_slug, &display, &aliases) {
            AttributionUpsert::Updated(text) => Some(FileChange::create(AUTHORS_FILE, text.as_bytes())),
            _ => None,
        },
        Some((sha, bytes)) => {
            let Ok(text) = std::str::from_utf8(&bytes) else {
                tracing::warn!("authors.json 不是 UTF-8,不动它");
                return None;
            };
            match upsert_attribution(Some(text), dir_slug, &display, &aliases) {
                AttributionUpsert::Updated(next) => {
                    Some(FileChange::update(AUTHORS_FILE, next.as_bytes(), sha))
                }
                AttributionUpsert::Unchanged => None,
                AttributionUpsert::Untouchable(reason) => {
                    tracing::warn!(reason, "authors.json 形状不对,本次跳过归因维护");
                    None
                }
            }
        }
    }
}

// ============================================================ 「这是我分享的」写回(v6 任务 3)

/// 库里这个技能**已经登记过分享者**了吗。
///
/// 读不出来(文件不在 / 不是 UTF-8 / 不是合法 JSON / 形状不对)一律当"没登记"
/// ——形状问题由 [`attribution_change`] 那一步统一报错,同一条规则不查两遍
/// (查两遍的那一遍永远不触发,是本项目记着的空转模式 #1)。
fn already_attributed(existing: Option<&[u8]>, dir_slug: &str) -> bool {
    let Some(bytes) = existing else { return false };
    let Ok(text) = std::str::from_utf8(bytes) else { return false };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(text) else { return false };
    doc["authors"][dir_slug]["author"]
        .as_str()
        .is_some_and(|name| !name.trim().is_empty())
}

/// 把「登记我为分享者」这件事折成**一个** authors.json 的 FileChange。
///
/// 与 [`attribution_file_change`](分享顺带维护那条路)的关键区别:那条路失败一律
/// 返回 `None`、跳过维护、绝不拦分享;**这条路本身就是用户按下的那个动作**,
/// 失败必须如实上报,否则界面会显示"已登记"而库里什么都没发生。
///
/// `existing` 必须来自**实际提交的目标仓**:blob sha 不跨仓通用(这条当年是
/// share_live 的副本用例证伪出来的;副本那条路已随 v8 任务 3 下线,但"按目标仓
/// 取 sha"这条约束本身仍然成立,别因为只剩一个目标仓就把它当成可以忽略的细节)。
fn attribution_change(
    existing: Option<&(String, Vec<u8>)>,
    dir_slug: &str,
    display: &str,
    aliases: &[&str],
) -> Result<FileChange, AppError> {
    let bad = |reason: &str| {
        AppError::new(
            "REPO_BAD_ATTRIBUTION",
            "技能库里记录作者的文件格式不对,请联系它的管理员",
        )
        .with_detail(reason.to_string())
    };
    match existing {
        None => match upsert_attribution(None, dir_slug, display, aliases) {
            AttributionUpsert::Updated(text) => {
                Ok(FileChange::create(AUTHORS_FILE, text.as_bytes()))
            }
            AttributionUpsert::Unchanged => Err(already_attributed_err(dir_slug)),
            AttributionUpsert::Untouchable(reason) => Err(bad(reason)),
        },
        Some((sha, bytes)) => {
            let Ok(text) = std::str::from_utf8(bytes) else {
                return Err(bad("authors.json 不是 UTF-8"));
            };
            match upsert_attribution(Some(text), dir_slug, display, aliases) {
                AttributionUpsert::Updated(next) => {
                    Ok(FileChange::update(AUTHORS_FILE, next.as_bytes(), sha))
                }
                // 走到这里说明在"读 → 提交"之间有人抢先登记了。真实可达的竞态,
                // 不是死代码。
                AttributionUpsert::Unchanged => Err(already_attributed_err(dir_slug)),
                AttributionUpsert::Untouchable(reason) => Err(bad(reason)),
            }
        }
    }
}

fn already_attributed_err(dir_slug: &str) -> AppError {
    AppError::new(
        "CONFLICT_ALREADY_ATTRIBUTED",
        "这个技能已经登记过分享者了",
    )
    .with_detail(format!("already attributed: {dir_slug}"))
}

/// 「作者未登记 · 这是我分享的」:往技能库根 `authors.json` 里登记当前登录身份
/// 为这个技能的分享者(v6 任务 3)。
///
/// 与分享同一条提交路径(v8 任务 3 起只剩直推),但提交里**只有 authors.json
/// 一个文件**,不碰任何技能内容。
///
/// 结果**写回技能库、不写本地**:归属的真相在库里(设计文档 §1),写本地的话
/// 换台电脑还要再认一次。
///
/// `me` 由调用方从 `config.identities[registryId]` 取——登录那一刻已经落盘,
/// 这里不再打一次 `current_user`。
///
/// GitHub 源不做:`authors.json` 是公司技能库的契约,M7 拍板 GitHub 臂不维护归因。
pub async fn claim_attribution(
    client: &ShareClient<'_>,
    repo: &RepoRef,
    dir_slug: &str,
    me: &Identity,
) -> Result<ShareOutcome, AppError> {
    let ShareClient::Gitea(c) = client else {
        return Err(AppError::new(
            "REPO_NO_ATTRIBUTION",
            "这个来源不记录作者信息,只有公司技能库支持",
        )
        .with_detail("attribution is a gitea-only contract (M7)"));
    };

    // 展示名口径与分享链路一致:展示名优先、空则登录名。别名(两种写法)只用于比对。
    let display = if me.display_name.trim().is_empty() {
        me.login.trim()
    } else {
        me.display_name.trim()
    };
    if display.is_empty() {
        return Err(AppError::new(
            "AUTH_REQUIRED",
            "当前登录身份没有可用的名字,请重新登录后再试",
        )
        .with_detail("identity has neither display_name nor login"));
    }
    let aliases = me.aliases();

    // 先读、先判、**再**做任何有副作用的事:已登记时一个请求都不该多发。
    let upstream = c.file_content(repo, AUTHORS_FILE).await?;
    if already_attributed(upstream.as_ref().map(|(_, b)| b.as_slice()), dir_slug) {
        return Err(already_attributed_err(dir_slug));
    }

    let info = c.repo_info(&repo.owner, &repo.repo).await?;
    // 🔴 v8 任务 3:只读用户那条路(复制一份到自己名下 → 跨库提交审核)已下线,
    // 所以这里必须**早退给一句人话**,否则就是留一颗必然报错的按钮(D8 明确
    // 点名这个入口)。界面侧对应的禁用态在 `DetailPanel` 的 `ClaimAttribution`。
    if !info.permissions.push {
        return Err(no_write_access_err(&repo.owner, &repo.repo));
    }
    let message = format!("登记分享者:{dir_slug}");
    let change = attribution_change(upstream.as_ref(), dir_slug, display, &aliases)?;
    let direct = ChangeFilesRequest {
        branch: repo.branch.clone(),
        // v8 任务 3(D1)起恒 `None`:提交审核下线,分享只剩直推。字段本身留着
        // ——它是 Gitea 请求体的一部分,`tests/gitea_live.rs` 仍用它探只读用户的
        // 开分支权限(见 `gitea.rs` 那条守卫的文档)。
        new_branch: None,
        message,
        files: vec![change],
    };
    match change_files_sparing_skill(c, &repo.owner, &repo.repo, &direct).await {
        Ok(commit) => Ok(claimed(commit.sha, dir_slug)),
        // 403 = 默认分支受保护。如实报,不再降级开分支(D1)。
        Err(e) if e.code == "REPO_FORBIDDEN" => Err(push_blocked_err(&repo.owner, &repo.repo)),
        Err(e) => Err(e),
    }
}

/// 登记结果复用 [`ShareOutcome::Shared`]:界面上它与分享是同一类事,没必要为它
/// 另造一个只差名字的枚举。这条路一个文件都不搬,也不碰任何技能内容。
fn claimed(commit_sha: String, dir_slug: &str) -> ShareOutcome {
    ShareOutcome::Shared {
        mode: ShareMode::Pushed,
        commit_sha,
        share_name: dir_slug.to_string(),
    }
}

/// 没有写权限时的统一出口(v8 任务 3 / D8)。
///
/// 🔴 **必须排在任何有副作用的请求之前**——以前这一档会 fork 一份到用户名下再跨库
/// 提交审核,那条路已下线;不早退的话,提交必然 403,而在此之前我们已经读过
/// `authors.json`(白白一次请求),更早的版本还会在用户账号下留一个注定用不上的
/// 副本。界面侧有对应的禁用态(`SharePath::NoAccess`),这条错误是防"绕过界面
/// 直接调 IPC"与"预检探不到、点下去才知道"这两种情况,**不是**唯一防线。
fn no_write_access_err(owner: &str, repo: &str) -> AppError {
    AppError::new(
        "REPO_NO_WRITE_ACCESS",
        "你对这个技能库没有写入权限,分享不了。请找管理员开通后再试",
    )
    .with_detail(format!("no push permission on {owner}/{repo}"))
}

/// 目标受保护、直接保存被拒时的出口(v8 任务 3)。
///
/// 🔴 **不再降级开分支提交审核**(D1)。公司技能库实测没有开保护,所以这条路今天
/// 走不到;真有人哪天开了保护,用户要看到的是一句能让他找对人的话,而不是一次
/// 静默变成"提交了但没人看"的审核请求。
fn push_blocked_err(owner: &str, repo: &str) -> AppError {
    AppError::new(
        "REPO_PUSH_BLOCKED",
        "这个技能库开启了保护,现在不能直接分享,请联系它的管理员",
    )
    .with_detail(format!("direct push rejected by {owner}/{repo}"))
}

/// Gitea 的提交路径(v8 任务 3 起只剩一条):有写权限 → 直接保存进默认分支。
///
/// 两个失败出口各有一句人话:没有写权限 [`no_write_access_err`]、目标受保护
/// [`push_blocked_err`]。**两者都不再自动降级**,原委见 `gitea.rs` 模块头的
/// 权限矩阵。
async fn submit_gitea(
    client: &GiteaClient,
    repo: &RepoRef,
    files: Vec<FileChange>,
    message: &str,
    share_name: &str,
) -> Result<Submitted, AppError> {
    let info = client.repo_info(&repo.owner, &repo.repo).await?;
    // 🔴 早退排在 `attribution_file_change` 的读取之前:见 `no_write_access_err`。
    if !info.permissions.push {
        return Err(no_write_access_err(&repo.owner, &repo.repo));
    }

    // 归因修订并进同一笔提交(M7 任务 5)。
    let mut files = files;
    if let Some(fc) = attribution_file_change(client, repo, share_name).await {
        files.push(fc);
    }
    let direct = ChangeFilesRequest {
        branch: repo.branch.clone(),
        // v8 任务 3(D1)起恒 `None`:提交审核下线,分享只剩直推。字段本身留着
        // ——它是 Gitea 请求体的一部分,`tests/gitea_live.rs` 仍用它探只读用户的
        // 开分支权限(见 `gitea.rs` 那条守卫的文档)。
        new_branch: None,
        message: message.to_string(),
        files,
    };
    match change_files_sparing_skill(client, &repo.owner, &repo.repo, &direct).await {
        Ok(commit) => Ok(Submitted { mode: ShareMode::Pushed, commit_sha: commit.sha }),
        // 403 = 默认分支受保护(只读在上面已分流)。如实报,不再降级。
        Err(e) if e.code == "REPO_FORBIDDEN" => Err(push_blocked_err(&repo.owner, &repo.repo)),
        Err(e) => Err(e),
    }
}

/// GitHub 的提交路径(v8 任务 3 起只剩一条):有 push 权限 → createCommitOnBranch。
///
/// 保护规则要 admin 权限才读得到,所以**不先探**(`branch_protected` 已删除)
/// ——提交时的 `BRANCH_PROTECTION_RULE_VIOLATION`(`REPO_PROTECTED`)才是真相,
/// 它自己带着一句人话,原样上报。
async fn submit_github(
    client: &GithubClient,
    repo: &RepoRef,
    additions: &[(String, Vec<u8>)],
    deletions: &[String],
    message: &str,
) -> Result<Submitted, AppError> {
    let view = client.repo_view(&repo.owner, &repo.repo).await?;
    if !view.permissions.push {
        return Err(no_write_access_err(&repo.owner, &repo.repo));
    }
    let name_with_owner = format!("{}/{}", repo.owner, repo.repo);
    let head = client.branch_head(repo).await?;
    let oid = client
        .create_commit_on_branch(
            &name_with_owner,
            &repo.branch,
            &head.sha,
            message,
            additions,
            deletions,
        )
        .await?;
    Ok(Submitted { mode: ShareMode::Pushed, commit_sha: oid })
}

// ============================================================ 差集(v8 任务 5 / D5)

/// 这次分享会让技能库发生什么,**按用户看得懂的相对路径**列出来。
///
/// 三份清单各自排序,空清单就是"这一类没有"。界面按它渲染确认屏(D6/D9),
/// core 按同一次计算的结果提交——**展示与提交出自同一个函数**,不是两把尺子
/// (本项目记着「确认屏说推去 A、实际推去 B」那类缺陷)。
///
/// ⚠️ `rename_all` 必须写在这个 struct 自己身上:外层枚举的 `rename_all_fields`
/// 管不到 newtype/struct variant 内层 struct 的字段名(`review_url` 那次真炸过)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePlan {
    /// 本地有、库里没有。
    pub added: Vec<AddedFile>,
    /// 两边都有,但内容不同。
    pub modified: Vec<ModifiedFile>,
    /// 🔴 **库里有、本地没有——这次会把它们从技能库里删掉**。
    pub deleted: Vec<DeletedFile>,
}

/// 新增的一个文件。🔴 **只带路径与标记,不带内容**(v8 任务 8 / 顾问②)。
///
/// 理由是 IPC 返回值的体量:首次分享一个 54 文件的技能,最坏十几 MB 全塞进一次
/// 返回值里;而新增文件的内容**就在本地磁盘上**,任务 9 的「读本地单文件」通道
/// 按需读即可,**零新增接口**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedFile {
    pub path: String,
    pub body: AddedBody,
}

/// 新增文件的内容标记。**可辨联合不是布尔**:界面据此决定"给不给点开看"。
///
/// **这里没有「超限」那一档,是有意的**(设计 Q11「不预告大小,直接拉」):
/// 内容根本不随这一轮传,大小限额是**取数那一刻**的事——任务 9 从磁盘读回来时
/// 再判。摆在这里就是拿预览轮的一个旧观测去预告另一次读取的结果,而两次之间
/// 文件完全可能已经变了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AddedBody {
    /// 文本,内容按需读(见 [`AddedFile`] 的文档)。
    Text,
    /// 非 UTF-8。文案只能说「这不是文本格式,看不了内容」——**不能说"这是图片"**,
    /// UTF-16 文本也会落进这一档,那是在编造一个我们并不知道的事实。
    Binary,
}

/// 修改的一个文件:路径 + 这两版之间的差异。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModifiedFile {
    pub path: String,
    pub diff: FileDiff,
}

/// 删除的一个文件:路径 + **库里那一版**的内容。
///
/// 内容取自这一轮的远端快照——它已经在手上了,用完即弃(不落盘、不缓存)。
/// 本地那一侧根本没有这个文件,所以它是用户唯一能看到"要删掉的是什么"的地方。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedFile {
    pub path: String,
    pub body: DeletedBody,
}

/// 被删文件的远端内容。**超限那一档刻意不带正文**——它同时也是这一轮 IPC
/// 返回值体量的上界:一个技能可以有很多个被删的大文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DeletedBody {
    Text { text: String },
    /// 见 [`AddedBody::Binary`]。
    Binary,
    TooLarge { limit: SizeLimit, bytes: u64, lines: usize },
}

/// 两版之间的差异。四档**可辨联合,不是几个布尔**:每一档在界面上都是一句
/// 不同的话,压成布尔就分不出"为什么看不了"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FileDiff {
    /// 正常的逐行差异。`hidden_hunks` > 0 时只给了前 [`MAX_HUNKS`] 处。
    Hunks { hunks: Vec<DiffHunk>, hidden_hunks: usize },
    /// 🔴 正文逐字相同,**只有行尾的换行符不同**(设计 Q17)。
    /// 不单列这一档的话,用户看到的是"全文都红"——因为 CRLF 让每一行都不等,
    /// 而他明明一个字都没改。
    LineEndingsOnly,
    /// 任一侧非 UTF-8。见 [`AddedBody::Binary`]。
    Binary,
    /// 任一侧超限。`limit` 说清是哪条超了,`bytes`/`lines` 是两侧里较大的那个值。
    TooLarge { limit: SizeLimit, bytes: u64, lines: usize },
}

/// 超的是哪一条。**与 hunk 上限是两把不同的尺子**:一个文件可以很小、却改了上千处。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SizeLimit {
    Bytes,
    Lines,
    Both,
}

/// 一处改动及其上下文,与 `git diff` 的 `@@ -a,b +c,d @@` 同口径:行号 **1 基**,
/// 而**空范围**(纯新增/纯删除那一侧)的起点是它前面那一行——`git` 对全空的旧文件
/// 写的是 `-0,0` 而不是 `-1,0`。这一条不是细枝末节:界面要照这个数标行号,
/// 差一行就是指着别处说"这里改了"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<DiffLine>,
}

/// 差异里的一行。文本**不含行尾换行符**(渲染时由界面决定怎么断行)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub op: DiffOp,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffOp {
    Context,
    Insert,
    Delete,
}

/// 上下文行数:上下各 3 行,与 `git diff -U3` 同口径(设计 Q9)。
const CONTEXT_RADIUS: usize = 3;

/// 内容超过它就不算差异了(设计 Q12)。
const MAX_DIFF_BYTES: u64 = 256 * 1024;
const MAX_DIFF_LINES: usize = 2000;

/// 一个文件最多给出多少处改动。
///
/// **与 [`MAX_DIFF_BYTES`]/[`MAX_DIFF_LINES`] 是两把不同的尺子,不能合并**:
/// 一个文件可以只有几 KB、几百行,却在里面改了上千处(批量替换一个词就是这样),
/// 那两条闸一条都不触发,而逐处展开出来仍然是没人读得完的一屏。
///
/// 取 50 的理由:每一处最坏 7 行(上下各 3 行 + 改动),50 处 ≈ 350 行
/// ——已经远超任何人会在一个确认屏上逐条读完的量;再多给不增加信息,
/// 只增加"滚不到底就闭眼点确认"的概率。超出的部分如实报计数,不假装没有。
const MAX_HUNKS: usize = 50;

impl SharePlan {
    /// 一个字节都不用改。这正是"空提交"的判据:此前分享只上传不比对,
    /// 于是内容一模一样时照样发一笔提交,同事那三个空的合并请求就是这么来的。
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.deleted.is_empty()
    }
}

/// 差集的完整产物:给用户看的 [`SharePlan`],以及给提交用的全远端路径。
///
/// 两者**同一次算出来**,所以不可能出现"屏上列了三个删除、实际删了两个"。
#[derive(Debug)]
pub(crate) struct PlannedChanges {
    pub plan: SharePlan,
    /// 要上传的文件(新增 + 修改),键是**完整远端路径**。
    pub upload: Vec<(String, Vec<u8>)>,
    /// 要删除的文件,同样是完整远端路径。
    pub delete: Vec<String>,
    /// 🔴 **这份清单本身的指纹**(v8 任务 8 / 顾问①)。见 [`ShareRequest::confirm`]。
    ///
    /// 由**这一次**算出的每一项 `(动作, 路径, 本地字节)` 求出,与
    /// `upload`/`delete` 出自同一份数据——**刻意不另去磁盘上算一次
    /// `dir_content_hash`**:那等于在"算指纹"与"读要推的字节"之间再开一个
    /// 时间窗,而这个字段的全部意义正是关掉那个窗。
    pub plan_rev: String,
    /// 🔴 **这一轮读到的本地字节的技能指纹**——提交成功后记进基线的就是它
    /// (v8 定向复审 I-2)。
    ///
    /// 此前提交成功后是对盘上**重新**跑一遍 `dir_content_hash`:提交那几秒里
    /// Claude Code 若又改了一个字,基线就记进了**没推出去**的内容,此后本地指纹 =
    /// 基线、库里 ≠ 基线,界面把库里那份更旧的内容说成「更新」,`is_mine` 判不出来时
    /// 手动/定时更新还会静默覆盖掉那笔修改。与 `plan_rev` 同一份数据算出,不再读盘。
    ///
    /// 口径与 [`fsops::dir_content_hash`] 逐字节相等(界面判"一不一样"的尺子,
    /// 漂一个字节就永远误报"有更新"),实现复用
    /// [`crate::core::store::files_content_hash`]——不写第三份。
    pub local_hash: String,
}

/// 算出"让库里与本地一致"需要做的事。**纯函数,不发任何请求。**
///
/// `prefix` 是该技能在库里的目录前缀(带尾斜杠,如 `skills/my-notes/`);
/// `remote` 与 `local` 的键都是**完整远端路径**。远端首次分享时 `remote` 为空,
/// 于是删除清单恒空、其余全进新增——不需要为"首次"单开一条分支。
///
/// # 两把尺子必须一样
///
/// 远端那侧要过 [`fsops::is_excluded_rel`],因为本地那侧的 [`fsops::list_files`]
/// 就是这么筛的。不筛的话:①库里被 `npx skills` 写下的 `metadata.json` 会被当成
/// "本地没有"而删掉——那不是本 app 管的文件;②"差集为空"与
/// `dir_content_hash == remote_content_hash` 会脱钩,而后者正是界面判断
/// "一不一样"的尺子,两者一旦不等价,用户就会陷入"点了分享、还是显示不一样"。
///
/// # 两道护栏(删除是破坏性动作,删的还是服务端的东西)
///
/// 1. **本地一个文件都读不到 → 拒绝整笔提交**。那多半是本体路径解析出了岔子
///    或目录被挪走,照着一份空清单提交就是**把库里这个技能删空**。正常路径上
///    它不可达(上游 `validate_skill_dir` 已经要求 SKILL.md 在),所以它防的是
///    将来某条新路径绕过校验——测试直接喂空清单来走到它。
/// 2. **删除路径必须落在这个技能目录内**。`..` 段、绝对路径、空段一律拒绝整笔
///    提交(不是"跳过这一条"):远端清单里出现越界路径说明上游数据已经不可信,
///    此时最该做的是停手,而不是挑着做一半。
///
/// # 清单只列技能目录内的文件
///
/// 同一笔提交里还可能有一处**库根 `authors.json` 的归因修订**(M7 起由
/// `submit_gitea` 自动追加:新增分享记分享者、更新别人的技能追加贡献者)。
/// 它**不在清单里,也不在 `plan_rev` / `local_hash` 里**:那是技能库的元数据,
/// 不是用户这个技能的内容。所以「确认屏上看到的 = 推出去的」这句承诺的范围是
/// **这个技能目录**,不是整笔提交——别据此把归因也塞进清单或指纹(定向复审 M-5)。
fn plan_changes(
    prefix: &str,
    remote: &BTreeMap<String, Vec<u8>>,
    local: Vec<(String, Vec<u8>)>,
) -> Result<PlannedChanges, AppError> {
    if local.is_empty() {
        return Err(AppError::new(
            "FS_EMPTY_PAYLOAD",
            "读不到这个技能的任何文件,为免误删技能库里的内容,这次没有提交",
        )
        .with_detail(format!("empty payload for {prefix}")));
    }
    // 2026-09-23 起 `files_content_hash` 自己按 `Path` 逐段序重排,喂入顺序不再
    // 影响结果(下面转成 `BTreeMap` 是字符串序也无妨)。这里仍在转换之前先算 `rels`,
    // 只是为了在借用 `local` 的同时拿到每个文件相对这个技能目录的路径。
    let rels = local
        .iter()
        .map(|(path, _)| strip_within(prefix, path))
        .collect::<Result<Vec<_>, _>>()?;
    let local_hash = crate::core::store::files_content_hash(
        rels.iter().zip(&local).map(|(rel, (_, bytes))| (rel.as_str(), bytes.as_slice())),
    );
    let local: BTreeMap<String, Vec<u8>> = local.into_iter().collect();

    let mut out = PlannedChanges {
        plan: SharePlan::default(),
        upload: Vec::new(),
        delete: Vec::new(),
        plan_rev: String::new(),
        local_hash,
    };
    // 清单指纹与清单本身同一次算出来(见 [`PlannedChanges::plan_rev`])。
    // 动作进 hash:同一个路径"新增"与"修改"是两件不同的事,指纹必须分得开。
    let mut rev = fsops::ContentHasher::new();

    for (path, bytes) in &local {
        let rel = strip_within(prefix, path)?;
        match remote.get(path) {
            Some(existing) if existing == bytes => {} // 一个都不发
            Some(existing) => {
                rev.push(&format!("~{rel}"), bytes);
                out.plan.modified.push(ModifiedFile {
                    path: rel,
                    diff: diff_of(existing, bytes),
                });
                out.upload.push((path.clone(), bytes.clone()));
            }
            None => {
                rev.push(&format!("+{rel}"), bytes);
                out.plan.added.push(AddedFile { path: rel, body: added_body(bytes) });
                out.upload.push((path.clone(), bytes.clone()));
            }
        }
    }
    for (path, existing) in remote {
        if local.contains_key(path) {
            continue;
        }
        let rel = strip_within(prefix, path)?;
        if fsops::is_excluded_rel(&rel) {
            continue; // 不是本 app 管的文件,不碰
        }
        // 被删的那一侧本地没有字节可喂,喂空即可:远端内容变没变由 `remote_rev`
        // 那条凭据负责,这一条只回答"我这次要动的东西还是不是那些"。
        rev.push(&format!("-{rel}"), b"");
        out.plan.deleted.push(DeletedFile { path: rel, body: file_body(existing) });
        out.delete.push(path.clone());
    }
    out.plan_rev = rev.finish();
    Ok(out)
}

/// 新增文件只需要回答"点开看得了吗"。
fn added_body(bytes: &[u8]) -> AddedBody {
    match std::str::from_utf8(bytes) {
        Ok(_) => AddedBody::Text,
        Err(_) => AddedBody::Binary,
    }
}

/// 被删文件带上库里那一版的正文,超限与二进制两档只带标记。
///
/// 🔴 **这是"二进制 / 超限"判定唯一的一处**:v8 任务 9 的文件预览
/// (`core::file_preview::classify`)也从这里取,只在外面做一层一一对应的映射
/// ——别在预览那边另写一份 `from_utf8` + 限额判定,两份一漂,同一个文件在确认屏
/// 与详情页就会一处能看、一处说"太大了"。
pub(crate) fn file_body(bytes: &[u8]) -> DeletedBody {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return DeletedBody::Binary;
    };
    match over_limit(bytes.len(), count_lines(text)) {
        Some((limit, bytes_n, lines)) => DeletedBody::TooLarge { limit, bytes: bytes_n, lines },
        None => DeletedBody::Text { text: text.to_string() },
    }
}

/// 算两版之间的差异。**判定顺序就是判据**,换顺序会说假话:
///
/// 1. **二进制在最前**:`similar` 只吃 `&str`,非 UTF-8 在算 diff 之前就已经出局
///    ——一处判定两处用(设计 Q14),不是我们另立的第二条规则;
/// 2. **超限次之**:先量再算,免得为了一个根本不会显示的结果跑一遍 Myers;
/// 3. 🔴 **归一化行尾,然后才比**:归一化后相同 = 只有行尾不同(Q17)。
///    不归一化就直接 diff 的话,一个 CRLF 文件的每一行都带着 `\r`,
///    **整屏都是红绿**——而"改了行尾又改了一句话"这种混合情形更糟:
///    真正改的那一行会淹没在几百行假改动里。
///
/// ⚠️ 超限那一档的 `bytes`/`lines` 是**两版各自的最大值**,可能分别来自旧版与新版
/// (定向复审 M-4),所以界面在差异这一档**不说具体数字**,只说"改动前后有一版超过了
/// 上限"——说「这个文件有 300 KB」对一个删减到 1 KB 的文件是假话。
fn diff_of(old: &[u8], new: &[u8]) -> FileDiff {
    let (Ok(old), Ok(new)) = (std::str::from_utf8(old), std::str::from_utf8(new)) else {
        return FileDiff::Binary;
    };
    let bytes = old.len().max(new.len());
    let lines = count_lines(old).max(count_lines(new));
    if let Some((limit, bytes, lines)) = over_limit(bytes, lines) {
        return FileDiff::TooLarge { limit, bytes, lines };
    }
    let (old, new) = (normalize_line_endings(old), normalize_line_endings(new));
    if old == new {
        // 走到这里说明原始字节确实不同(调用方已经比过),那就只能是行尾
        return FileDiff::LineEndingsOnly;
    }
    hunks_of(&old, &new)
}

/// 超限判定。返回 `None` = 两条都没过线;`Some` 里带上**实测值**,
/// 好让界面说得出"多大 / 多少行",而不是干巴巴一句"太大了"。
fn over_limit(bytes: usize, lines: usize) -> Option<(SizeLimit, u64, usize)> {
    let bytes = bytes as u64;
    let limit = match (bytes > MAX_DIFF_BYTES, lines > MAX_DIFF_LINES) {
        (true, true) => SizeLimit::Both,
        (true, false) => SizeLimit::Bytes,
        (false, true) => SizeLimit::Lines,
        (false, false) => return None,
    };
    Some((limit, bytes, lines))
}

/// 只把 CRLF 折成 LF。**不碰单独的 `\r`**(老 Mac 行尾):那种文件在 `from_lines`
/// 眼里本来就是一整行,折了反而会凭空造出一堆行。
fn normalize_line_endings(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// 行数。末尾那个换行符不算新的一行(与 `wc -l` 的口径刻意不同:
/// 这里量的是"要显示多少行",空的末行不显示)。
fn count_lines(s: &str) -> usize {
    if s.is_empty() {
        return 0;
    }
    s.lines().count()
}

/// 0 基半开区间 → `@@` 头里的那个起点。空范围往前退一行,见 [`DiffHunk`]
/// (与 `similar` 自己 `Display` 那份实现同一条规则,我们只是要取值而它不给)。
fn unified_start(range: &std::ops::Range<usize>) -> usize {
    if range.is_empty() {
        range.start
    } else {
        range.start + 1
    }
}

/// 跑一遍统一视图的差异,取前 [`MAX_HUNKS`] 处。
fn hunks_of(old: &str, new: &str) -> FileDiff {
    let diff = similar::TextDiff::from_lines(old, new);
    let mut hunks = Vec::new();
    let mut hidden_hunks = 0usize;
    for hunk in diff.unified_diff().context_radius(CONTEXT_RADIUS).iter_hunks() {
        if hunks.len() >= MAX_HUNKS {
            hidden_hunks += 1;
            continue;
        }
        let ops = hunk.ops();
        // `similar` 的 `UnifiedHunkHeader` 没有暴露取值的方法(字段私有),
        // 这里按它自己的算法从首尾两个 op 还原:范围是 0 基半开区间,
        // 展示用的行号是 1 基,所以 +1。
        let (Some(first), Some(last)) = (ops.first(), ops.last()) else {
            continue;
        };
        let old_range = first.old_range().start..last.old_range().end;
        let new_range = first.new_range().start..last.new_range().end;
        let lines = hunk
            .iter_changes()
            .map(|change| DiffLine {
                op: match change.tag() {
                    similar::ChangeTag::Equal => DiffOp::Context,
                    similar::ChangeTag::Insert => DiffOp::Insert,
                    similar::ChangeTag::Delete => DiffOp::Delete,
                },
                // `from_lines` 的每一项都带着行尾换行符,展示时不要它
                text: change.value().trim_end_matches('\n').to_string(),
            })
            .collect();
        hunks.push(DiffHunk {
            old_start: unified_start(&old_range),
            old_lines: old_range.len(),
            new_start: unified_start(&new_range),
            new_lines: new_range.len(),
            lines,
        });
    }
    FileDiff::Hunks { hunks, hidden_hunks }
}

/// 把完整远端路径剥成技能目录内的相对路径,越界就拒。
///
/// 判据是**路径段**不是子串:`..` 只在整段等于它时才越界,`..foo` 是个正常文件名。
fn strip_within(prefix: &str, path: &str) -> Result<String, AppError> {
    let bad = |why: &str| {
        AppError::new(
            "FS_UNSAFE_PATH",
            "这个技能里有一条不该出现的文件路径,为安全起见没有提交",
        )
        .with_detail(format!("{why}: {path}"))
    };
    let rel = path.strip_prefix(prefix).ok_or_else(|| bad("outside skill dir"))?;
    if rel.is_empty() || rel.starts_with('/') {
        return Err(bad("empty or absolute"));
    }
    if rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return Err(bad("traversal"));
    }
    Ok(rel.to_string())
}

/// 从压缩包里剥出该技能目录下的远端文件(键是**完整远端路径**,与本地那侧同形)。
///
/// `archive.entries` 的键带着压缩包顶层目录,这里一并剥掉——与
/// `store::remote_content_hash` 拼 `archive.root` 是同一个约定。
pub(crate) fn remote_files(archive: &RepoArchive, prefix: &str) -> BTreeMap<String, Vec<u8>> {
    let full_prefix = format!("{}/{}", archive.root, prefix);
    archive
        .entries
        .iter()
        .filter_map(|(full, entry)| {
            let rel = full.strip_prefix(full_prefix.as_str())?;
            (!rel.is_empty()).then(|| (format!("{prefix}{rel}"), entry.bytes.clone()))
        })
        .collect()
}

/// 把本地目录读成 `(远端路径, 字节)` 清单。来源无关:Gitea 侧再按远端 blob sha
/// 分成 create/update,GitHub 侧原样进 createCommitOnBranch 的 additions
/// (它对"新增"与"修改"不作区分)。
fn payload_files(dir: &Path, prefix: &str) -> Result<Vec<(String, Vec<u8>)>, AppError> {
    let mut out = Vec::new();
    for rel in fsops::list_files(dir)? {
        let bytes = std::fs::read(dir.join(&rel)).map_err(|e| {
            AppError::new("FS_READ_FAILED", "无法读取技能目录内容,请重试")
                .with_detail(format!("read {}: {e}", rel.display()))
        })?;
        let rel = rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR_STR, "/");
        out.push((format!("{prefix}{rel}"), bytes));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{
        skill_invalid_err, upsert_attribution, AddedBody, AddedFile, AttributionUpsert,
        CandidateOrigin, DeletedBody, DeletedFile, DiffOp, FileDiff, ModifiedFile,
        OverwriteWarning, ShareInstalledOutcome, ShareMode, ShareOutcome, SharePlan,
        SizeLimit, StaleReason, MAX_DIFF_LINES, MAX_HUNKS,
    };
    use std::collections::BTreeMap;
    use crate::core::skills::ShareBlock;

    fn keys(v: &serde_json::Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    /// 🔴 **断言的是键的完整集合,不是"某个键存在"**(本项目记着的空转模式 ②)。
    ///
    /// 这条守的是一个真实存在过的哑弹:`rename_all` 挂在枚举上只改 variant 名,
    /// 当年 `review_url` 因此原样发成蛇形,而界面读的是 `reviewUrl`——那条链接
    /// 从来没渲染过。那个字段已随提交审核一起删除(v8 任务 3),但**断言"键的
    /// 完整集合"这件事本身要留着**:下一个往这个 variant 加带下划线字段的人,
    /// 要在这里当场变红。
    #[test]
    fn share_outcome_serializes_every_field_in_camel_case() {
        let v = serde_json::to_value(ShareOutcome::Shared {
            mode: ShareMode::Pushed,
            commit_sha: "abc".into(),
            share_name: "weekly-report".into(),
        })
        .unwrap();
        assert_eq!(
            keys(&v),
            vec![
                "commitSha".to_string(),
                "mode".to_string(),
                "outcome".to_string(),
                "shareName".to_string(),
            ]
        );
        assert_eq!(v["outcome"], "shared");
        assert_eq!(v["mode"], "pushed");
        assert_eq!(v["shareName"], "weekly-report");
    }

    /// 确认档的两层嵌套 struct——**外层枚举的 `rename_all_fields` 只管到
    /// variant 自己的字段名**(`plan`/`overwrite`),管不到 `SharePlan` 与
    /// `OverwriteWarning` 内部;那两个的 `rename_all` 必须写在它们自己身上。
    /// 两条通道(首次分享与回推改动)共用同一对 struct,所以两边一起钉。
    #[test]
    fn needs_confirm_serializes_every_field_in_camel_case() {
        let warning = OverwriteWarning {
            last_author: Some("李四".into()),
            last_at: Some("2026-09-10T03:04:05Z".into()),
            history_url: Some("http://x/commits".into()),
        };
        let plan = SharePlan {
            added: vec![AddedFile { path: "a.md".into(), body: AddedBody::Text }],
            modified: vec![ModifiedFile {
                path: "SKILL.md".into(),
                diff: FileDiff::TooLarge { limit: SizeLimit::Both, bytes: 999, lines: 9 },
            }],
            deleted: vec![DeletedFile {
                path: "old.md".into(),
                body: DeletedBody::Text { text: "库里那一版".into() },
            }],
        };
        let v = serde_json::to_value(ShareOutcome::NeedsConfirm {
            plan: plan.clone(),
            overwrite: Some(warning.clone()),
            remote_rev: "sha256:beef".into(),
            plan_rev: "sha256:plan".into(),
            stale: true,
            stale_reason: Some(StaleReason::LocalChanged),
        })
        .unwrap();
        assert_eq!(
            keys(&v),
            vec![
                "outcome".to_string(),
                "overwrite".to_string(),
                "plan".to_string(),
                "planRev".to_string(),
                "remoteRev".to_string(),
                "stale".to_string(),
                "staleReason".to_string()
            ]
        );
        assert_eq!(v["remoteRev"], "sha256:beef");
        assert_eq!(v["planRev"], "sha256:plan");
        assert_eq!(v["stale"], true);
        assert_eq!(v["staleReason"], "localChanged");
        assert_eq!(v["outcome"], "needsConfirm");
        assert_eq!(keys(&v["plan"]), vec!["added", "deleted", "modified"]);
        // 清单三档的内层 struct/enum 各有自己的 `rename_all`,外层管不到
        assert_eq!(keys(&v["plan"]["added"][0]), vec!["body", "path"]);
        assert_eq!(v["plan"]["added"][0]["body"]["kind"], "text");
        assert_eq!(v["plan"]["deleted"][0]["path"], "old.md");
        assert_eq!(v["plan"]["deleted"][0]["body"]["text"], "库里那一版");
        assert_eq!(
            keys(&v["plan"]["modified"][0]["diff"]),
            vec!["bytes".to_string(), "kind".to_string(), "limit".to_string(), "lines".to_string()]
        );
        assert_eq!(v["plan"]["modified"][0]["diff"]["limit"], "both");
        // `Hunks` 那一支的内层两级(DiffHunk / DiffLine)各有自己的 `rename_all`,
        // 上面那个样本用的是 `TooLarge`,钉不到它们——少了这一段,下一个人把
        // `FileDiff` 的 `rename_all_fields` 删掉,界面读到的就是 undefined。
        let hunks = serde_json::to_value(FileDiff::Hunks {
            hunks: vec![super::DiffHunk {
                old_start: 2,
                old_lines: 7,
                new_start: 2,
                new_lines: 7,
                lines: vec![super::DiffLine { op: DiffOp::Delete, text: "第5行".into() }],
            }],
            hidden_hunks: 3,
        })
        .unwrap();
        assert_eq!(
            keys(&hunks),
            vec!["hiddenHunks".to_string(), "hunks".to_string(), "kind".to_string()]
        );
        assert_eq!(hunks["kind"], "hunks");
        assert_eq!(hunks["hiddenHunks"], 3);
        assert_eq!(
            keys(&hunks["hunks"][0]),
            vec![
                "lines".to_string(),
                "newLines".to_string(),
                "newStart".to_string(),
                "oldLines".to_string(),
                "oldStart".to_string()
            ]
        );
        assert_eq!(keys(&hunks["hunks"][0]["lines"][0]), vec!["op".to_string(), "text".to_string()]);
        assert_eq!(hunks["hunks"][0]["lines"][0]["op"], "delete");
        assert_eq!(
            keys(&v["overwrite"]),
            vec!["historyUrl".to_string(), "lastAt".to_string(), "lastAuthor".to_string()]
        );
        assert_eq!(v["overwrite"]["lastAuthor"], "李四");

        let v = serde_json::to_value(ShareOutcome::AlreadyInSync).unwrap();
        assert_eq!(v["outcome"], "alreadyInSync");

        let v = serde_json::to_value(ShareInstalledOutcome::NeedsConfirm {
            plan,
            overwrite: Some(warning),
            remote_rev: "sha256:beef".into(),
            plan_rev: "sha256:plan".into(),
            stale: false,
            stale_reason: None,
        })
        .unwrap();
        assert_eq!(
            keys(&v),
            vec![
                "kind".to_string(),
                "overwrite".to_string(),
                "plan".to_string(),
                "planRev".to_string(),
                "remoteRev".to_string(),
                "stale".to_string(),
                "staleReason".to_string()
            ]
        );
        assert_eq!(v["remoteRev"], "sha256:beef");
        assert_eq!(v["stale"], false);
        assert_eq!(v["staleReason"], serde_json::Value::Null);
        assert_eq!(v["kind"], "needsConfirm");
        assert_eq!(v["overwrite"]["lastAt"], "2026-09-10T03:04:05Z");
        assert_eq!(
            serde_json::to_value(ShareInstalledOutcome::AlreadyInSync).unwrap()["kind"],
            "alreadyInSync"
        );
    }

    // ==================================================== 差集(v8 任务 5 / D5)

    fn remote_of(pairs: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        pairs.iter().map(|(p, c)| (p.to_string(), c.as_bytes().to_vec())).collect()
    }
    fn local_of(pairs: &[(&str, &str)]) -> Vec<(String, Vec<u8>)> {
        pairs.iter().map(|(p, c)| (p.to_string(), c.as_bytes().to_vec())).collect()
    }
    const PFX: &str = "skills/my-notes/";

    // 三档清单现在每一项都带内容标记(v8 任务 8),而多数既有断言只关心"有哪些路径"。
    fn added_paths(p: &SharePlan) -> Vec<String> {
        p.added.iter().map(|f| f.path.clone()).collect()
    }
    fn modified_paths(p: &SharePlan) -> Vec<String> {
        p.modified.iter().map(|f| f.path.clone()).collect()
    }
    fn deleted_paths(p: &SharePlan) -> Vec<String> {
        p.deleted.iter().map(|f| f.path.clone()).collect()
    }

    /// 四类各归各位,**内容相同的一个都不发**——今天那三个空的合并请求正是
    /// 漏了最后这一条判断。
    #[test]
    fn plan_splits_added_modified_deleted_and_drops_the_identical_ones() {
        let remote = remote_of(&[
            ("skills/my-notes/SKILL.md", "新正文"),
            ("skills/my-notes/same.md", "一模一样"),
            ("skills/my-notes/gone.md", "库里还留着"),
        ]);
        let local = local_of(&[
            ("skills/my-notes/SKILL.md", "旧正文"),
            ("skills/my-notes/same.md", "一模一样"),
            ("skills/my-notes/brand-new.md", "刚写的"),
        ]);
        let c = super::plan_changes(PFX, &remote, local).unwrap();
        assert_eq!(added_paths(&c.plan), vec!["brand-new.md".to_string()]);
        assert_eq!(modified_paths(&c.plan), vec!["SKILL.md".to_string()]);
        assert_eq!(deleted_paths(&c.plan), vec!["gone.md".to_string()]);
        let uploaded: Vec<&str> = c.upload.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            uploaded,
            vec!["skills/my-notes/SKILL.md", "skills/my-notes/brand-new.md"],
            "内容相同的 same.md 一个字节都不该发"
        );
        assert_eq!(c.delete, vec!["skills/my-notes/gone.md".to_string()]);
    }

    /// 两边逐字节相同 → 空计划。调用方据此短路成「库里已与本地一致」,零请求。
    #[test]
    fn plan_is_empty_when_both_sides_match_byte_for_byte() {
        let same = &[("skills/my-notes/SKILL.md", "正文"), ("skills/my-notes/a.md", "甲")];
        let c = super::plan_changes(PFX, &remote_of(same), local_of(same)).unwrap();
        assert!(c.plan.is_empty(), "内容一致时不该有任何改动:{:?}", c.plan);
        assert!(c.upload.is_empty() && c.delete.is_empty());
    }

    /// 首次分享:远端什么都没有 → 删除清单恒空,其余全进新增。
    #[test]
    fn a_first_share_has_nothing_to_delete() {
        let c = super::plan_changes(
            PFX,
            &BTreeMap::new(),
            local_of(&[("skills/my-notes/SKILL.md", "正文")]),
        )
        .unwrap();
        assert_eq!(added_paths(&c.plan), vec!["SKILL.md".to_string()]);
        assert!(c.plan.deleted.is_empty());
    }

    /// 🔴 护栏一:本地一个文件都读不到 → **拒绝整笔提交**。照着空清单提交
    /// 就是把库里这个技能删空。
    #[test]
    fn an_empty_local_payload_is_refused_outright() {
        let remote = remote_of(&[("skills/my-notes/SKILL.md", "库里还在")]);
        let err = super::plan_changes(PFX, &remote, Vec::new()).unwrap_err();
        assert_eq!(err.code, "FS_EMPTY_PAYLOAD");
    }

    /// 🔴 护栏二:越界路径一律拒绝整笔提交,不是"跳过这一条"。
    #[test]
    fn a_path_escaping_the_skill_directory_is_refused() {
        let remote = remote_of(&[("skills/my-notes/../other/SKILL.md", "别人的技能")]);
        let local = local_of(&[("skills/my-notes/SKILL.md", "我的")]);
        let err = super::plan_changes(PFX, &remote, local).unwrap_err();
        assert_eq!(err.code, "FS_UNSAFE_PATH");
        assert!(err.detail.unwrap_or_default().contains("traversal"));
    }

    /// `..foo` 是个正常文件名:判据是**路径段**,不是子串。
    #[test]
    fn a_file_named_with_leading_dots_is_not_a_traversal() {
        let local = local_of(&[("skills/my-notes/..gitkeep", "x")]);
        let c = super::plan_changes(PFX, &BTreeMap::new(), local).unwrap();
        assert_eq!(added_paths(&c.plan), vec!["..gitkeep".to_string()]);
    }

    /// 🔴 **两侧排除清单必须是同一把尺子**:本地那侧 `fsops::list_files` 早就
    /// 把 `metadata.json`/`.DS_Store` 筛掉了。远端不筛的话,`npx skills` 写下的
    /// `metadata.json` 会被当成"本地没有"删掉——那不是本 app 管的文件;而且
    /// "差集为空"会与 `dir_content_hash == remote_content_hash` 脱钩,
    /// 用户会陷入"点了分享、还是显示不一样"。
    #[test]
    fn files_that_the_hash_ruler_ignores_are_never_deleted() {
        let remote = remote_of(&[
            ("skills/my-notes/SKILL.md", "正文"),
            ("skills/my-notes/metadata.json", "{}"),
            ("skills/my-notes/.DS_Store", "\u{0}"),
            // 目录段也在排除清单里(`EXCLUDE_DIRS`),不只是文件名
            ("skills/my-notes/__pycache__/x.pyc", "字节码"),
        ]);
        let local = local_of(&[("skills/my-notes/SKILL.md", "正文")]);
        let c = super::plan_changes(PFX, &remote, local).unwrap();
        assert!(c.plan.is_empty(), "这三个文件不该产生任何改动:{:?}", c.plan);
    }

    // ============================== 内容级差异(v8 任务 8 / 设计 Q1–Q17)

    fn diff_one(old: &str, new: &str) -> FileDiff {
        let c = super::plan_changes(
            PFX,
            &remote_of(&[("skills/my-notes/SKILL.md", old)]),
            local_of(&[("skills/my-notes/SKILL.md", new)]),
        )
        .unwrap();
        assert_eq!(c.plan.modified.len(), 1, "这组样本应当只有一个文件被改:{:?}", c.plan);
        c.plan.modified.into_iter().next().unwrap().diff
    }

    fn ops(hunk: &super::DiffHunk) -> Vec<DiffOp> {
        hunk.lines.iter().map(|l| l.op).collect()
    }

    /// 1. 改一行 → 一处改动,上下文**恰好各 3 行**(与 `git diff -U3` 同口径)。
    #[test]
    fn a_modified_file_comes_back_with_three_lines_of_context_on_each_side() {
        let old: String = (1..=10).map(|i| format!("第{i}行\n")).collect();
        let new = old.replace("第5行", "第五行改过了");
        let FileDiff::Hunks { hunks, hidden_hunks } = diff_one(&old, &new) else {
            panic!("普通文本应当给出逐行差异");
        };
        assert_eq!(hidden_hunks, 0);
        assert_eq!(hunks.len(), 1, "只改了一处");
        let h = &hunks[0];
        // 第 2..8 行(1 基):3 行上文 + 改动的那一行(删+增)+ 3 行下文
        assert_eq!((h.old_start, h.old_lines), (2, 7));
        assert_eq!((h.new_start, h.new_lines), (2, 7));
        assert_eq!(
            ops(h),
            vec![
                DiffOp::Context,
                DiffOp::Context,
                DiffOp::Context,
                DiffOp::Delete,
                DiffOp::Insert,
                DiffOp::Context,
                DiffOp::Context,
                DiffOp::Context,
            ],
            "上下各 3 行,不多不少"
        );
        assert_eq!(h.lines[0].text, "第2行", "文本不带行尾换行符");
        assert_eq!(h.lines[3].text, "第5行");
        assert_eq!(h.lines[4].text, "第五行改过了");
    }

    /// 1'. 空范围的起点跟 `git` 走:旧文件是空的,`@@` 里写的是 `-0,0`。
    ///     差一行的后果是界面指着别处说"这里改了"。
    #[test]
    fn an_empty_side_starts_at_zero_like_git_does() {
        let FileDiff::Hunks { hunks, .. } = diff_one("", "第一行\n第二行\n") else {
            panic!("旧文件为空也该给出逐行差异");
        };
        assert_eq!((hunks[0].old_start, hunks[0].old_lines), (0, 0));
        assert_eq!((hunks[0].new_start, hunks[0].new_lines), (1, 2));
    }

    /// 2. 🔴 新增文件**只带路径与标记,不带内容**(顾问②)。
    ///
    /// 正面断言那个标记本身的完整形状——断言"没崩"是零信息量的,而
    /// "字段为空"也分不出"省略了"与"拼错了名字"。
    #[test]
    fn an_added_file_carries_no_content_at_all() {
        let c = super::plan_changes(
            PFX,
            &BTreeMap::new(),
            local_of(&[("skills/my-notes/SKILL.md", "一段不该出现在返回值里的正文")]),
        )
        .unwrap();
        assert_eq!(
            c.plan.added,
            vec![AddedFile { path: "SKILL.md".into(), body: AddedBody::Text }],
            "新增项的全部内容就是这两个字段"
        );
        let json = serde_json::to_string(&c.plan).unwrap();
        assert!(
            !json.contains("一段不该出现在返回值里的正文"),
            "新增文件的正文一个字都不该进这一轮返回值:{json}"
        );
    }

    /// 2'. 二进制的新增文件同样只给标记——界面据此**不给点**。
    #[test]
    fn an_added_binary_file_is_marked_as_such() {
        let local = vec![("skills/my-notes/x.bin".to_string(), vec![0xff, 0xfe, 0x00, 0x01])];
        let c = super::plan_changes(PFX, &BTreeMap::new(), local).unwrap();
        assert_eq!(c.plan.added[0].body, AddedBody::Binary);
    }

    /// 3. 删除的文件带**库里那一版**的内容——本地根本没有它,这是用户唯一
    ///    能看到"要删掉的是什么"的地方。
    #[test]
    fn a_deleted_file_carries_the_library_side_content() {
        let c = super::plan_changes(
            PFX,
            &remote_of(&[
                ("skills/my-notes/SKILL.md", "正文"),
                ("skills/my-notes/旧的.md", "库里这一版的内容"),
            ]),
            local_of(&[("skills/my-notes/SKILL.md", "正文")]),
        )
        .unwrap();
        assert_eq!(
            c.plan.deleted,
            vec![DeletedFile {
                path: "旧的.md".into(),
                body: DeletedBody::Text { text: "库里这一版的内容".into() },
            }]
        );
    }

    /// 3'. 被删的二进制文件不带字节;超限的也不带正文(它同时是这一轮返回值
    ///     体量的上界)。
    #[test]
    fn a_deleted_file_that_cannot_be_shown_carries_only_a_marker() {
        let remote: BTreeMap<String, Vec<u8>> = [
            ("skills/my-notes/x.bin".to_string(), vec![0xff, 0xfe]),
            (
                "skills/my-notes/big.md".to_string(),
                "x\n".repeat(MAX_DIFF_LINES + 1).into_bytes(),
            ),
        ]
        .into_iter()
        .collect();
        let c =
            super::plan_changes(PFX, &remote, local_of(&[("skills/my-notes/SKILL.md", "正文")]))
                .unwrap();
        let body_of = |name: &str| {
            c.plan.deleted.iter().find(|f| f.path == name).unwrap_or_else(|| panic!("{name} 不在删除清单里:{:?}", c.plan.deleted)).body.clone()
        };
        assert_eq!(body_of("x.bin"), DeletedBody::Binary);
        assert!(
            matches!(body_of("big.md"), DeletedBody::TooLarge { limit: SizeLimit::Lines, .. }),
            "{:?}",
            body_of("big.md")
        );
    }

    /// 4. 🔴 非 UTF-8 → 二进制档,**根本不进 diff 计算**(设计 Q14:
    ///    `similar` 只吃 `&str`,一处判定两处用)。
    #[test]
    fn a_non_utf8_file_is_binary_and_never_reaches_the_diff() {
        let c = super::plan_changes(
            PFX,
            &remote_of(&[("skills/my-notes/SKILL.md", "正文")]),
            vec![("skills/my-notes/SKILL.md".to_string(), vec![0xff, 0xfe, 0x00])],
        )
        .unwrap();
        assert_eq!(c.plan.modified[0].diff, FileDiff::Binary);
    }

    /// 5a. 字节数超限(行数没超)→ 截断档,`limit` 说清是**哪条**超了。
    #[test]
    fn a_file_over_the_byte_limit_says_so_by_bytes() {
        // 100 行 × 4000 字节 = 40 万字节:过了 256KB,没过 2000 行
        let big: String = (0..100).map(|_| format!("{}\n", "x".repeat(3999))).collect();
        let diff = diff_one("原来很短\n", &big);
        let FileDiff::TooLarge { limit, bytes, lines } = diff else {
            panic!("超限的文件不该给出逐行差异:{diff:?}");
        };
        assert_eq!(limit, SizeLimit::Bytes);
        assert!(bytes > 256 * 1024, "{bytes}");
        assert_eq!(lines, 100);
    }

    /// 5b. 行数超限(字节数没超)→ 同一档,但 `limit` 是另一个值。
    ///     **两条分别测**:只测一条的话,把判定写成"永远报 Bytes"也能过。
    #[test]
    fn a_file_over_the_line_limit_says_so_by_lines() {
        let many = "x\n".repeat(MAX_DIFF_LINES + 1);
        let diff = diff_one("原来很短\n", &many);
        let FileDiff::TooLarge { limit, bytes, lines } = diff else {
            panic!("超限的文件不该给出逐行差异:{diff:?}");
        };
        assert_eq!(limit, SizeLimit::Lines);
        assert!(bytes < 256 * 1024, "字节数这一条不该触发:{bytes}");
        assert_eq!(lines, MAX_DIFF_LINES + 1);
    }

    /// 6. 🔴 只有行尾不同 → 单独一档(设计 Q17)。
    ///    落不进这一档的表现是**整屏都红**:CRLF 让每一行都不等,而用户
    ///    明明一个字都没改。
    #[test]
    fn a_file_that_only_changed_line_endings_says_exactly_that() {
        let lf = "第一行\n第二行\n第三行\n";
        let crlf = "第一行\r\n第二行\r\n第三行\r\n";
        assert_eq!(diff_one(crlf, lf), FileDiff::LineEndingsOnly);
        assert_eq!(diff_one(lf, crlf), FileDiff::LineEndingsOnly);
    }

    /// 6'. 对照组:行尾**和**正文都变了 → 仍然是逐行差异,而且只有真改的那一行
    ///     进差异。少了它,上面那条用"CRLF 一律判 LineEndingsOnly"的实现也能过。
    #[test]
    fn a_line_ending_change_does_not_swallow_a_real_edit() {
        let crlf = "第一行\r\n第二行\r\n第三行\r\n";
        let lf_edited = "第一行\n第二行改了\n第三行\n";
        let FileDiff::Hunks { hunks, .. } = diff_one(crlf, lf_edited) else {
            panic!("正文也变了就该给出逐行差异");
        };
        assert_eq!(
            ops(&hunks[0]),
            vec![DiffOp::Context, DiffOp::Delete, DiffOp::Insert, DiffOp::Context],
            "只有真改的那一行进差异,其余两行是上下文"
        );
    }

    /// 7. 改动处超过上限 → 只给前 N 处 + **如实报出还有多少处没显示**。
    ///    这把尺子与 256KB/2000 行无关:这个样本又小又短,却改了 55 处。
    #[test]
    fn too_many_changed_spots_are_capped_and_the_rest_is_counted() {
        let blocks = MAX_HUNKS + 5;
        let old: String =
            (0..blocks).flat_map(|b| (0..10).map(move |i| format!("块{b}行{i}\n"))).collect();
        let new = old.replace("行0\n", "行零改过\n");
        let diff = diff_one(&old, &new);
        let FileDiff::Hunks { hunks, hidden_hunks } = diff else {
            panic!("这个文件既不大也不长:{diff:?}");
        };
        assert_eq!(hunks.len(), MAX_HUNKS);
        assert_eq!(hidden_hunks, 5, "没显示的那几处要如实报出来");
    }

    /// 🔴 清单指纹(顾问①):**本地内容变一个字,指纹就得变**。
    /// 它是"你看到的差异 = 我要推的差异"这句承诺的全部落点。
    #[test]
    fn the_plan_fingerprint_follows_the_local_bytes() {
        let remote = remote_of(&[("skills/my-notes/SKILL.md", "库里那一版")]);
        let a = super::plan_changes(PFX, &remote, local_of(&[("skills/my-notes/SKILL.md", "我这一版")]))
            .unwrap();
        let again =
            super::plan_changes(PFX, &remote, local_of(&[("skills/my-notes/SKILL.md", "我这一版")]))
                .unwrap();
        assert_eq!(a.plan_rev, again.plan_rev, "本地没变就该是同一个值");
        let edited = super::plan_changes(
            PFX,
            &remote,
            local_of(&[("skills/my-notes/SKILL.md", "我这一版,又改了一个字")]),
        )
        .unwrap();
        assert_ne!(a.plan_rev, edited.plan_rev, "本地改过就必须是另一个值");
    }

    /// 🔴 **动作也进指纹**:同一个路径、同样的字节,"新增"与"修改"是两件事。
    /// 不把动作喂进去的话,用户看着"新增 a.md"点了确认,而这一刻库里已经有了
    /// 同名文件,真正发生的是覆盖。
    #[test]
    fn the_plan_fingerprint_distinguishes_adding_from_modifying() {
        let local = local_of(&[("skills/my-notes/SKILL.md", "同样的字节")]);
        let as_added = super::plan_changes(PFX, &BTreeMap::new(), local.clone()).unwrap();
        let as_modified = super::plan_changes(
            PFX,
            &remote_of(&[("skills/my-notes/SKILL.md", "库里是别的东西")]),
            local,
        )
        .unwrap();
        assert_ne!(as_added.plan_rev, as_modified.plan_rev);
    }

    /// 🔴 删除清单也进指纹:本地删掉一个文件,要推的事就变了。
    #[test]
    fn the_plan_fingerprint_follows_the_deletions_too() {
        let remote = remote_of(&[
            ("skills/my-notes/SKILL.md", "正文"),
            ("skills/my-notes/旧的.md", "库里还留着"),
        ]);
        let with_delete =
            super::plan_changes(PFX, &remote, local_of(&[("skills/my-notes/SKILL.md", "改过")]))
                .unwrap();
        let without_delete = super::plan_changes(
            PFX,
            &remote,
            local_of(&[("skills/my-notes/SKILL.md", "改过"), ("skills/my-notes/旧的.md", "库里还留着")]),
        )
        .unwrap();
        assert_ne!(with_delete.plan_rev, without_delete.plan_rev);
    }

    /// 两条凭据**分别**比,失效原因分得开(顾问①:对用户是两句不同的话)。
    #[test]
    fn the_confirm_gate_tells_the_two_kinds_of_staleness_apart() {
        use super::{confirm_gate, ConfirmGate, Confirmation};
        let ok = Confirmation { remote_rev: "R", plan_rev: "P" };
        assert!(matches!(confirm_gate(None, "R", "P"), ConfirmGate::Preview));
        assert!(matches!(confirm_gate(Some(ok), "R", "P"), ConfirmGate::Go));
        assert!(matches!(
            confirm_gate(Some(ok), "R2", "P"),
            ConfirmGate::Stale(StaleReason::RemoteChanged)
        ));
        assert!(matches!(
            confirm_gate(Some(ok), "R", "P2"),
            ConfirmGate::Stale(StaleReason::LocalChanged)
        ));
        // 两边都变了只报 RemoteChanged:退回去那份清单是重算的,新的 planRev
        // 已经把新的本地状态绑上了,不需要第三个成员。
        assert!(matches!(
            confirm_gate(Some(ok), "R2", "P2"),
            ConfirmGate::Stale(StaleReason::RemoteChanged)
        ));
    }

    /// 同一个坑的第二处:`CandidateOrigin::NpxSkills { source }` 眼下是单词字段,
    /// 加不加 `rename_all_fields` 序列化结果都一样——**正因为看不出差别才要钉住**,
    /// 将来往这个变体加一个带下划线的字段时,这条会当场变红。
    #[test]
    fn candidate_origin_serializes_every_field_in_camel_case() {
        let v = serde_json::to_value(CandidateOrigin::NpxSkills { source: "acme/skills".into() })
            .unwrap();
        assert_eq!(keys(&v), vec!["kind".to_string(), "source".to_string()]);
        assert_eq!(v["kind"], "npxSkills");
        let local = serde_json::to_value(CandidateOrigin::Local).unwrap();
        assert_eq!(keys(&local), vec!["kind".to_string()]);
        assert_eq!(local["kind"], "local");
    }

    /// `FS_SKILL_INVALID` 的 `detail` 必须是 `ShareBlock` **自己的** serde 字面量
    /// ——界面按它查文案表。手抄一份名字映射的话,改了枚举两边照样各自全绿。
    #[test]
    fn share_block_detail_uses_the_enums_own_serde_name() {
        for (block, want) in [
            (ShareBlock::NameMissing, "nameMissing"),
            (ShareBlock::NameMismatch, "nameMismatch"),
            (ShareBlock::NameFormat, "nameFormat"),
            (ShareBlock::DirFormat, "dirFormat"),
            (ShareBlock::DescriptionMissing, "descriptionMissing"),
            (ShareBlock::DescriptionTooLong, "descriptionTooLong"),
            (ShareBlock::SkillMdUnreadable, "skillMdUnreadable"),
        ] {
            let err = skill_invalid_err(block);
            assert_eq!(err.code, "FS_SKILL_INVALID");
            assert_eq!(
                err.detail.as_deref(),
                Some(want),
                "{block:?} 的 detail 与它自己的 serde 名不一致"
            );
        }
    }

    fn updated(r: AttributionUpsert) -> String {
        match r {
            AttributionUpsert::Updated(text) => text,
            other => panic!("预期 Updated,实际 {other:?}"),
        }
    }

    #[test]
    fn upsert_creates_document_when_repo_has_no_authors_json() {
        let text = updated(upsert_attribution(None, "weekly-report", "张三", &["张三"]));
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["authors"]["weekly-report"]["author"], "张三");
        // 与 gen-authors.mjs 的产出一致:尾随换行
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn upsert_appends_new_entry_and_preserves_existing_ones_verbatim() {
        let existing = r#"{
  "$comment": "管理员手写的注释要原样保住",
  "authors": {
    "zulu-first": { "author": "王五" },
    "alpha-second": { "author": "李四", "contributors": ["赵六"] }
  }
}"#;
        let text = updated(upsert_attribution(Some(existing), "weekly-report", "张三", &["张三"]));
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["$comment"], "管理员手写的注释要原样保住");
        assert_eq!(doc["authors"]["zulu-first"]["author"], "王五");
        assert_eq!(doc["authors"]["alpha-second"]["contributors"][0], "赵六");
        assert_eq!(doc["authors"]["weekly-report"]["author"], "张三");
        // preserve_order:原有键序不得被重排成字母序(zulu 在 alpha 前面)
        let zulu = text.find("zulu-first").unwrap();
        let alpha = text.find("alpha-second").unwrap();
        assert!(zulu < alpha, "键序被重排了");
    }

    #[test]
    fn upsert_never_rewrites_author_of_existing_entry() {
        // 覆盖他人技能/回推他人技能:分享者进 contributors,author 一个字不动
        let existing = r#"{"authors":{"weekly-report":{"author":"张三"}}}"#;
        let text = updated(upsert_attribution(Some(existing), "weekly-report", "李四", &["李四"]));
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["authors"]["weekly-report"]["author"], "张三");
        assert_eq!(doc["authors"]["weekly-report"]["contributors"][0], "李四");
    }

    #[test]
    fn upsert_is_a_no_op_for_author_or_known_contributor() {
        let existing = r#"{"authors":{"weekly-report":{"author":"张三","contributors":["李四"]}}}"#;
        assert_eq!(
            upsert_attribution(Some(existing), "weekly-report", "张三", &["张三"]),
            AttributionUpsert::Unchanged
        );
        assert_eq!(
            upsert_attribution(Some(existing), "weekly-report", "李四", &["李四"]),
            AttributionUpsert::Unchanged
        );
    }

    #[test]
    fn upsert_refuses_to_touch_malformed_files_or_entries() {
        // 坏 JSON:重建会抹掉其他条目,一个字节都不动
        assert!(matches!(
            upsert_attribution(Some("{not json"), "s", "张三", &["张三"]),
            AttributionUpsert::Untouchable(_)
        ));
        // 顶层不是对象
        assert!(matches!(
            upsert_attribution(Some("[]"), "s", "张三", &["张三"]),
            AttributionUpsert::Untouchable(_)
        ));
        // authors 不是对象
        assert!(matches!(
            upsert_attribution(Some(r#"{"authors":"nope"}"#), "s", "张三", &["张三"]),
            AttributionUpsert::Untouchable(_)
        ));
        // 条目缺 author:残缺数据的语义不猜
        assert!(matches!(
            upsert_attribution(Some(r#"{"authors":{"s":{"contributors":["x"]}}}"#), "s", "张三", &["张三"]),
            AttributionUpsert::Untouchable(_)
        ));
        // contributors 不是数组
        assert!(matches!(
            upsert_attribution(
                Some(r#"{"authors":{"s":{"author":"别人","contributors":"nope"}}}"#),
                "s",
                "张三",
                &["张三"]
            ),
            AttributionUpsert::Untouchable(_)
        ));
    }

    /// 同一个人的两种写法必须认作一个人。真实场景:初版 authors.json 按 Gitea
    /// **登录名**手工填(gen-authors 从 git 历史算出来的也是登录名/git 名),
    /// 而 App 分享时用的是 **full_name**。不比别名的话,作者本人一分享就会被
    /// 追加进自己的 contributors——同一个人在界面上出现两次。
    #[test]
    fn aliases_keep_one_person_from_becoming_two() {
        // 条目按登录名记,分享者展示名是中文全名:认出是本人,不动
        let by_login = r#"{"authors":{"weekly-report":{"author":"wangfurong"}}}"#;
        assert_eq!(
            upsert_attribution(Some(by_login), "weekly-report", "王富荣", &["王富荣", "wangfurong"]),
            AttributionUpsert::Unchanged
        );
        // contributors 里按登录名记的也一样认得出
        let contributed = r#"{"authors":{"weekly-report":{"author":"别人","contributors":["wangfurong"]}}}"#;
        assert_eq!(
            upsert_attribution(Some(contributed), "weekly-report", "王富荣", &["王富荣", "wangfurong"]),
            AttributionUpsert::Unchanged
        );
        // 确实是别人时照常追加,而且写进去的是展示名不是登录名
        let others = r#"{"authors":{"weekly-report":{"author":"张三"}}}"#;
        let text = updated(upsert_attribution(
            Some(others),
            "weekly-report",
            "王富荣",
            &["王富荣", "wangfurong"],
        ));
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["authors"]["weekly-report"]["contributors"][0], "王富荣");
    }

    /// 🔴 **等式护栏**(定向复审 I-2 (c)):提交成功后记进基线的 `local_hash`,
    /// 必须与 [`crate::core::fsops::dir_content_hash`] 对同一个目录逐字节相等。
    /// 漂一个字节,分享完的那一行就永远显示"和库里不一样"/「更新」。
    ///
    /// fixture 刻意覆盖口径最容易漂的几处:子目录、`a-b` 与 `a/b` 这对**字符串序
    /// 与路径序不同**的名字(按 `BTreeMap` 的字符串序喂就会与 `dir_content_hash` 不等)、
    /// 被排除的系统元文件,以及大小写混排。
    #[test]
    fn the_pushed_baseline_uses_the_same_ruler_as_dir_content_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("my-notes");
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: my-notes\ndescription: d\n---\n").unwrap();
        std::fs::write(dir.join("a").join("b.md"), "子目录").unwrap();
        std::fs::write(dir.join("a-b.md"), "同级").unwrap();
        std::fs::write(dir.join("Zeta.txt"), "大写").unwrap();
        std::fs::write(dir.join(".DS_Store"), [0u8, 1, 2]).unwrap();
        std::fs::write(dir.join("logo.png"), [0x89u8, 0x50, 0xff]).unwrap();

        let prefix = "skills/my-notes/";
        let payload = super::payload_files(&dir, prefix).unwrap();
        let planned = super::plan_changes(prefix, &BTreeMap::new(), payload).unwrap();
        assert_eq!(
            planned.local_hash,
            crate::core::fsops::dir_content_hash(&dir).unwrap(),
            "基线指纹与界面比对用的那把尺子必须逐字节相等",
        );
    }

    /// 🔴 **`remote_rev` 与本地基线的等式护栏**(v8 任务 11 补丁,2026-09-23):
    /// `remote_rev` 是 `overwrite_gate` 判"库里是不是已经变了"唯一凭据的来源。
    /// 它必须与用户本地实际算出的基线([`crate::core::fsops::dir_content_hash`])
    /// 用同一把尺子——不然内容其实没变,分享时也会误判成"库里已经变了"、
    /// 每次都弹一次多余的覆盖警告。
    ///
    /// fixture 用 `reference/` 目录与 `reference.md` 文件这对兄弟名:字符串序把
    /// `reference.md` 排在 `reference/x.md` 前面,`Path` 逐段序相反。
    #[test]
    fn remote_rev_matches_the_local_baseline_for_sibling_names() {
        let remote_path = "sibling-names";
        let files: [(&str, &[u8]); 3] = [
            ("SKILL.md", b"---\nname: sibling-names\ndescription: d\n---\n"),
            ("reference.md", b"reference file"),
            ("reference/x.md", b"reference dir"),
        ];

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(remote_path);
        let mut archive = crate::core::gitea::RepoArchive {
            root: "skills".to_string(),
            tree: crate::core::skills::MemTree::new(),
            files: Vec::new(),
            entries: BTreeMap::new(),
        };
        for (rel, bytes) in files {
            let full = format!("skills/{remote_path}/{rel}");
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes).unwrap();
            archive.files.push(full.clone());
            archive.entries.insert(
                full,
                crate::core::gitea::ArchiveEntry { bytes: bytes.to_vec(), unix_mode: None },
            );
        }

        let local = crate::core::fsops::dir_content_hash(&dir).unwrap();
        let remote = super::remote_rev(&archive, remote_path);

        assert_eq!(remote, local, "remote_rev 必须与本地基线一致,否则分享会误报「库里已经变了」");
    }
}
