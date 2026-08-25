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
use crate::core::gitea::{ChangeFilesRequest, FileChange, GiteaClient, RepoRef, RepoSource};
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
/// 判据来自真实录制(`tests/fixtures/gitea-permissions/NOTES.md`),与 [`submit`] 的
/// 三条提交路径一一对应。**它只是提示,提交时刻的权限矩阵仍是权威判定**
/// ——预检与提交之间权限可能变化,所以两边不共用一次结果。
///
/// 返回的是枚举不是句子:文案在 i18n。core 若返回中文,两道术语门都扫不到它
/// (`tests/terminology.rs` 只扒 `AppError::new` 的 message,前端守卫只扫 `src/`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SharePath {
    /// 能直推目标分支:改动立即生效。
    DirectPush,
    /// 有写权限但分支受保护:在本库开分支提交审核。
    ReviewInRepo,
    /// 没有写权限:先复制一份到自己名下,再跨库提交审核。
    ReviewViaCopy,
    /// 有写权限但**探不到分支保护**(GitHub:保护规则要 admin 权限才读得到)。
    /// 可能直推,也可能被挡下转评审——不假装知道。
    MaybeDirect,
    /// 探不到(网络失败 / 空库 404 / 旧版 Gitea 缺字段)。界面不显示预告。
    Unknown,
}

/// 探一次目标库的分享路径。**永不返回 Err**:预检失败一律 [`SharePath::Unknown`],
/// 绝不拦住分享本身(fail-open)。
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
                (Some(false), true) => SharePath::ReviewInRepo,
                (Some(false), false) => SharePath::ReviewViaCopy,
                // 旧版 Gitea 没有 user_can_push:有写权限时分支保护无从得知,
                // 不许预告"直接生效";没有写权限则与新版结论一致。
                (None, true) => SharePath::Unknown,
                (None, false) => SharePath::ReviewViaCopy,
            }
        }
        ShareClient::Github(c) => match c.repo_view(&repo.owner, &repo.repo).await {
            Ok(view) if view.permissions.push => SharePath::MaybeDirect,
            Ok(_) => SharePath::ReviewViaCopy,
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
}

/// 提交走的路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareMode {
    /// 直接进了默认分支。
    Pushed,
    /// 开了评审(直推被分支保护挡下,或只读用户走 fork)。
    ReviewRequested,
}

/// 分享的结果。**只剩 `Shared` 一档**:同名被别人占用不再是"等用户三选一"
/// 的拍板档,而是一个如实的错误(`REPO_NAME_TAKEN`)——覆盖别人的技能这条路
/// 已整体取消,改名由用户在本地完成(模块头 A-3)。
///
/// ⚠️ **序列化形状**:`rename_all` 挂在**枚举**上只改 variant 名,**不改 struct
/// variant 里的字段名**——必须另加 `rename_all_fields`。这个坑本期已经踩过两次
/// (获取链路发了很久蛇形键),这里的具体后果是 `review_url` 原样发成蛇形,而
/// 界面读的是 `reviewUrl`:**分享走评审之后那条「查看审核」链接从来没渲染过**。
/// 下面的 `share_outcome_serializes_every_field_in_camel_case` 正面钉住完整键集合。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "outcome")]
pub enum ShareOutcome {
    Shared {
        mode: ShareMode,
        commit_sha: String,
        /// 评审链接(ReviewRequested 时有)。
        review_url: Option<String>,
        /// 库里这个技能的目录名(= 本体文件夹名 = frontmatter `name`,三者同一)。
        share_name: String,
    },
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
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    trasher: &dyn Trasher,
    req: ShareRequest<'_>,
    now: &str,
) -> Result<ShareOutcome, AppError> {
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

    // ④ 本体留在原地,canonical 只补一条指向它的链接。
    let home = installer.home(req.dir_slug, Some(&body))?;
    converge::ensure_canonical_link(&installer, &home)?;

    // ⑤ 提交
    let prefix = format!("skills/{share_name}/");
    let files = payload_files(&body, &prefix)?;
    let message = match checked {
        SharePrecheck::Fresh => format!("新增技能:{share_name}"),
        _ => format!("更新技能:{share_name}"),
    };
    let submitted = submit(
        client,
        req.repo,
        &prefix,
        checked == SharePrecheck::Fresh,
        false,
        files,
        &message,
        &share_name,
        now,
    )
    .await?;

    // ⑥ 记账:content_hash 从**本体**算——"有未分享的改动"的判据就是它
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
        content_hash: fsops::dir_content_hash(&body)?,
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
        review_url: submitted.review_url,
        share_name,
    })
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
/// 三道闸(v6 二期从四道减到三道,少的那道是被推翻的,不是被忘掉的):
/// 1. **只认直推**(`Pushed`)。走了提交审核的改动还在评审分支上,库里根本没有
///    这个技能,记成已入库会让「更新」去找一个不存在的东西,用户还会以为已经生效;
/// 2. **已有记账不覆盖**。回推改动走的是 [`share_installed`],不经过这里;
///    真走到这里说明是另一条路,覆盖账本会把 commit_sha 等既有事实抹掉;
/// 3. 记账键取 `home.dir_name`(= [`converge::record_key`]),`body` 只在本体
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
    if submitted.mode != ShareMode::Pushed {
        return;
    }
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

// ============================================================ 回推已装技能的改动

/// 回推的两种结局:提交成功,或撞上"远端在获取之后被别人改过"的冲突档。
///
/// 冲突档对齐 [`ShareOutcome::NeedsDecision`] 的模式:**不是错误,是需要用户拍板**
/// ——返回它时磁盘与远端一个字节都没动,前端弹确认(提交审核 / 先不动),
/// 确认后带 `force_review: true` 重来。
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShareInstalledOutcome {
    Submitted(Submitted),
    #[serde(rename_all = "camelCase")]
    RemoteChanged {
        /// 该技能目录在目标分支上的提交历史页;给不出时前端降级为纯文案。
        history_url: Option<String>,
    },
}

/// 把本 app 安装、用户改过的技能推回它的来源仓库。
///
/// 这就是获取流程冲突弹窗里承诺的"分享功能开放后可以分享改动"那条路。
/// 直推成功 → 更新 `contentHash`/`commitSha`,「已改动」标记消失;
/// 走了评审 → **记账一个字不动**:改动还没进 main,标记消失等于把它藏起来。
///
/// M5 任务 1 起,提交前先比对远端当前内容与账上 `content_hash`(`read` 走读链路):
/// 不相等 = 远端在获取之后被别人改过,回推等于覆盖对方——进 [`ShareInstalledOutcome::RemoteChanged`],
/// 与本地改没改无关(本地没改时回推的是旧版,照样覆盖)。乐观锁(CONFLICT_STALE)
/// 只拦"拉 sha 与提交之间"的瞬间竞态,防不了这一档,两者是互补关系。
/// `force_review = true` = 用户已在冲突档拍板:跳过检测,强制走「开分支 + 提交审核」,
/// 绝不直推(合并交给技能库的评审流程)。
#[allow(clippy::too_many_arguments)]
pub async fn share_installed(
    client: &ShareClient<'_>,
    read: &impl RepoSource,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    dir_slug: &str,
    branch: &str,
    force_review: bool,
    now: &str,
) -> Result<ShareInstalledOutcome, AppError> {
    let installer = Installer::new(registry, env);
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

    // 远端变更检测:账上 content_hash = 上次与远端对齐时的内容指纹(本地改动、
    // 走评审都不动它——现役不变量),远端当前指纹与它不等就是"别人改过"。
    // 基线为空时跳过(拿不准基线就不冤枉远端,提交时刻的乐观锁仍在兜底)。
    if !force_review && !record.content_hash.is_empty() {
        let archive = read.download_archive(&repo).await?;
        // entries 的键保留压缩包顶层目录,技能路径必须拼上 archive.root 才剥得到条目
        // (store.rs 建索引时的 s.dir 天然带着它,这里的记账路径没有)
        let remote_dir = format!("{}/{}", archive.root, record.source.path);
        let remote_hash = crate::core::store::remote_content_hash(&archive, &remote_dir);
        if remote_hash != record.content_hash {
            let history_url = Some(match client {
                ShareClient::Gitea(c) => c.history_url(&repo, &record.source.path),
                ShareClient::Github(c) => c.history_url(&repo, &record.source.path),
            });
            return Ok(ShareInstalledOutcome::RemoteChanged { history_url });
        }
    }

    let prefix = format!("{}/", record.source.path.trim_end_matches('/'));
    let files = payload_files(&source_dir, &prefix)?;
    let message = format!("更新技能:{dir_slug}");
    // fresh=false:已装技能的回推,远端必然已有这组文件
    let submitted =
        submit(client, &repo, &prefix, false, force_review, files, &message, dir_slug, now).await?;

    if submitted.mode == ShareMode::Pushed {
        let mut next = loaded.value.clone();
        next.installed[idx].commit_sha = submitted.commit_sha.clone();
        next.installed[idx].content_hash = fsops::dir_content_hash(&source_dir)?;
        next.installed[idx].updated_at = now.to_string();
        store.save_state(&next)?;
    }
    Ok(ShareInstalledOutcome::Submitted(submitted))
}

// ============================================================ 内部

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Submitted {
    pub mode: ShareMode,
    pub commit_sha: String,
    pub review_url: Option<String>,
}

/// 按来源类型分发提交。`fresh` = 远端还没有该技能(Gitea 路径可跳过拉取 blob sha);
/// `force_review` = 冲突档确认后的第二跳,有直推权限也不许直推(直推正是冲突档要防的覆盖)。
#[allow(clippy::too_many_arguments)]
async fn submit(
    client: &ShareClient<'_>,
    repo: &RepoRef,
    prefix: &str,
    fresh: bool,
    force_review: bool,
    files: Vec<(String, Vec<u8>)>,
    message: &str,
    share_name: &str,
    now: &str,
) -> Result<Submitted, AppError> {
    match client {
        ShareClient::Gitea(c) => {
            // 更新路径需要远端各文件的 blob sha;Fresh 不需要(全 create)
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
            let changes = files
                .into_iter()
                .map(|(path, bytes)| match remote_shas.get(&path) {
                    Some(sha) => FileChange::update(path.clone(), &bytes, sha.clone()),
                    None => FileChange::create(path.clone(), &bytes),
                })
                .collect();
            // 归因修订(M7 任务 5)在 submit_gitea 内部按**实际提交目标仓**追加
            // ——不能在这里做,fork 路径的目标仓不是 repo。GitHub 臂刻意不做:
            // authors.json 是公司库契约,GitHub 源本来就不展示归因。
            submit_gitea(c, repo, force_review, changes, message, share_name, now).await
        }
        ShareClient::Github(c) => {
            submit_github(c, repo, force_review, files, message, share_name, now).await
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
/// `REPO_FORBIDDEN` 直接上报:那是分支保护,调用方要据此降级走评审,不是归因的锅。
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
/// 分享才是用户此刻要办的事。走评审的路径下这个 FileChange 与技能文件在同一分支里,
/// 合并才一起进 main,不会给未合并的分享提前记账。
/// fork 路径的 blob sha 取自上游:fork 是即时全量副本,同一文件的 blob sha 相同。
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
/// `existing` 必须来自**实际提交的目标仓**:blob sha 不跨仓通用,拿上游的 sha 往
/// fork 上 update 会得到 `404 object does not exist`(share_live 的 fork 用例证伪过)。
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
                // 走到这里说明在"读上游 → 读 fork"之间有人抢先登记了(fork 是即时
                // 副本,内容本该与刚读过的上游相同)。是真实可达的竞态,不是死代码。
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
/// 与分享同一套权限矩阵(直推 → 开分支提交审核 → 只读用户走副本),但提交里
/// **只有 authors.json 一个文件**,不碰任何技能内容。
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
    now: &str,
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

    // 先读、先判、**再**做任何有副作用的事:已登记时连 fork 都不该建出来
    // ——那是在用户账号下留一个注定用不上的副本。
    let upstream = c.file_content(repo, AUTHORS_FILE).await?;
    if already_attributed(upstream.as_ref().map(|(_, b)| b.as_slice()), dir_slug) {
        return Err(already_attributed_err(dir_slug));
    }

    let info = c.repo_info(&repo.owner, &repo.repo).await?;
    let message = format!("登记分享者:{dir_slug}");
    let branch_name = review_branch(dir_slug, now);

    if info.permissions.push {
        let change = attribution_change(upstream.as_ref(), dir_slug, display, &aliases)?;
        let direct = ChangeFilesRequest {
            branch: repo.branch.clone(),
            new_branch: None,
            message: message.clone(),
            files: vec![change.clone()],
        };
        match change_files_sparing_skill(c, &repo.owner, &repo.repo, &direct).await {
            Ok(commit) => {
                return Ok(claimed(ShareMode::Pushed, commit.sha, None, dir_slug));
            }
            // 403 = 默认分支受保护(只读在下面分流)。降级开分支走提交审核。
            Err(e) if e.code == "REPO_FORBIDDEN" => {}
            Err(e) => return Err(e),
        }
        let via_branch = ChangeFilesRequest {
            branch: repo.branch.clone(),
            new_branch: Some(branch_name.clone()),
            message: message.clone(),
            files: vec![change],
        };
        let commit = change_files_sparing_skill(c, &repo.owner, &repo.repo, &via_branch).await?;
        let pull = c
            .create_pull(&repo.owner, &repo.repo, &branch_name, &repo.branch, &message, "")
            .await?;
        return Ok(claimed(
            ShareMode::ReviewRequested,
            commit.sha,
            Some(pull.html_url),
            dir_slug,
        ));
    }

    // 只读用户:实测连开分支都 403,唯一的路是先复制一份到自己名下
    let fork = c.fork_repo(&repo.owner, &repo.repo).await?;
    let fork_ref = RepoRef {
        owner: fork.owner.clone(),
        repo: fork.repo.clone(),
        branch: repo.branch.clone(),
    };
    // 🔴 blob sha 不跨仓通用:提交发到副本上,就必须拿副本自己的 sha
    let on_fork = c.file_content(&fork_ref, AUTHORS_FILE).await?;
    let change = attribution_change(on_fork.as_ref(), dir_slug, display, &aliases)?;
    let via_fork = ChangeFilesRequest {
        branch: repo.branch.clone(),
        new_branch: Some(branch_name.clone()),
        message: message.clone(),
        files: vec![change],
    };
    let commit = change_files_sparing_skill(c, &fork.owner, &fork.repo, &via_fork).await?;
    let pull = c
        .create_pull(
            &repo.owner,
            &repo.repo,
            &format!("{}:{}", fork.owner, branch_name),
            &repo.branch,
            &message,
            "",
        )
        .await?;
    Ok(claimed(
        ShareMode::ReviewRequested,
        commit.sha,
        Some(pull.html_url),
        dir_slug,
    ))
}

/// 登记结果复用 [`ShareOutcome::Shared`]:界面上它与分享是同一类事(可能直接生效、
/// 也可能等审核),没必要为它另造一个只差名字的枚举。这条路一个文件都不搬,
/// 也不碰任何技能内容。
fn claimed(
    mode: ShareMode,
    commit_sha: String,
    review_url: Option<String>,
    dir_slug: &str,
) -> ShareOutcome {
    ShareOutcome::Shared {
        mode,
        commit_sha,
        review_url,
        share_name: dir_slug.to_string(),
    }
}

/// Gitea 的权限矩阵(gitea.rs 模块头的实测矩阵):
/// 可写 → 先直推,被分支保护挡下(403)→ 开分支 + 提交审核;
/// 只读 → fork 到自己名下 → fork 上开分支 → 跨库提交审核。
/// `force_review` 只砍掉"先直推"那一步,其余分流不变(只读的 fork 路径本就是评审)。
#[allow(clippy::too_many_arguments)]
async fn submit_gitea(
    client: &GiteaClient,
    repo: &RepoRef,
    force_review: bool,
    files: Vec<FileChange>,
    message: &str,
    share_name: &str,
    now: &str,
) -> Result<Submitted, AppError> {
    let info = client.repo_info(&repo.owner, &repo.repo).await?;
    let branch_name = review_branch(share_name, now);

    if info.permissions.push {
        // 归因修订并进同一笔提交(M7 任务 5)。**必须在这里按目标仓取 sha**:
        // blob sha 不跨仓通用,拿上游的 sha 往 fork 上 update 会得到
        // `404 object does not exist`——整笔提交连技能文件一起失败。
        // 这个假设是 share_live 的 fork 用例当场证伪的,纯逻辑测试看不见。
        let mut files = files;
        if let Some(fc) = attribution_file_change(client, repo, share_name).await {
            files.push(fc);
        }
        if !force_review {
            let direct = ChangeFilesRequest {
                branch: repo.branch.clone(),
                new_branch: None,
                message: message.to_string(),
                files: files.clone(),
            };
            match change_files_sparing_skill(client, &repo.owner, &repo.repo, &direct).await {
                Ok(commit) => {
                    return Ok(Submitted {
                        mode: ShareMode::Pushed,
                        commit_sha: commit.sha,
                        review_url: None,
                    })
                }
                // 403 = 默认分支受保护(只读在上面已分流)。降级开分支走评审。
                Err(e) if e.code == "REPO_FORBIDDEN" => {}
                Err(e) => return Err(e),
            }
        }
        let via_branch = ChangeFilesRequest {
            branch: repo.branch.clone(),
            new_branch: Some(branch_name.clone()),
            message: message.to_string(),
            files,
        };
        let commit = change_files_sparing_skill(client, &repo.owner, &repo.repo, &via_branch).await?;
        let pull = client
            .create_pull(&repo.owner, &repo.repo, &branch_name, &repo.branch, message, "")
            .await?;
        return Ok(Submitted {
            mode: ShareMode::ReviewRequested,
            commit_sha: commit.sha,
            review_url: Some(pull.html_url),
        });
    }

    // 只读:实测连开分支都 403,唯一的路是 fork
    let fork = client.fork_repo(&repo.owner, &repo.repo).await?;
    // 归因的 blob sha 必须来自 **fork 仓**——提交发到这里,上游的 sha 在这儿不认。
    let fork_ref = RepoRef {
        owner: fork.owner.clone(),
        repo: fork.repo.clone(),
        branch: repo.branch.clone(),
    };
    let mut files = files;
    if let Some(fc) = attribution_file_change(client, &fork_ref, share_name).await {
        files.push(fc);
    }
    let via_fork = ChangeFilesRequest {
        branch: repo.branch.clone(),
        new_branch: Some(branch_name.clone()),
        message: message.to_string(),
        files,
    };
    let commit = change_files_sparing_skill(client, &fork.owner, &fork.repo, &via_fork).await?;
    let pull = client
        .create_pull(
            &repo.owner,
            &repo.repo,
            &format!("{}:{}", fork.owner, branch_name),
            &repo.branch,
            message,
            "",
        )
        .await?;
    Ok(Submitted {
        mode: ShareMode::ReviewRequested,
        commit_sha: commit.sha,
        review_url: Some(pull.html_url),
    })
}

/// GitHub 的权限矩阵(录制自真实行为,tests/fixtures/github-write/NOTES.md):
/// 有 push 且分支未保护 → createCommitOnBranch 直接保存;
/// 有 push 但分支受保护(protected 先探,或提交撞上
/// BRANCH_PROTECTION_RULE_VIOLATION)→ 开分支 + 提交审核;
/// 无 push → fork 到自己名下(202 异步,轮询就绪)→ fork 上开分支 → 跨库提交审核。
/// `force_review` 只砍掉"直接保存"那一步,其余分流不变。
#[allow(clippy::too_many_arguments)]
async fn submit_github(
    client: &GithubClient,
    repo: &RepoRef,
    force_review: bool,
    files: Vec<(String, Vec<u8>)>,
    message: &str,
    share_name: &str,
    now: &str,
) -> Result<Submitted, AppError> {
    let view = client.repo_view(&repo.owner, &repo.repo).await?;
    let branch_name = review_branch(share_name, now);
    let name_with_owner = format!("{}/{}", repo.owner, repo.repo);

    if view.permissions.push {
        // protected 只是先探(保护规则可能只拦部分人),提交时的错误类型才是最终真相
        if !force_review && !client.branch_protected(repo).await? {
            let head = client.branch_head(repo).await?;
            match client
                .create_commit_on_branch(&name_with_owner, &repo.branch, &head.sha, message, &files)
                .await
            {
                Ok(oid) => {
                    return Ok(Submitted {
                        mode: ShareMode::Pushed,
                        commit_sha: oid,
                        review_url: None,
                    })
                }
                Err(e) if e.code == "REPO_PROTECTED" => {}
                Err(e) => return Err(e),
            }
        }
        let head = client.branch_head(repo).await?;
        client
            .create_branch(&repo.owner, &repo.repo, &branch_name, &head.sha)
            .await?;
        let oid = client
            .create_commit_on_branch(&name_with_owner, &branch_name, &head.sha, message, &files)
            .await?;
        let pull = client
            .create_pull(&repo.owner, &repo.repo, &branch_name, &repo.branch, message)
            .await?;
        return Ok(Submitted {
            mode: ShareMode::ReviewRequested,
            commit_sha: oid,
            review_url: Some(pull.html_url),
        });
    }

    // 无 push:唯一的路是 fork(202 异步受理,实测约 3 秒可用)
    let fork = client.fork_repo(&repo.owner, &repo.repo).await?;
    let fork_ref = RepoRef {
        owner: fork.owner.clone(),
        repo: fork.repo.clone(),
        branch: repo.branch.clone(),
    };
    let fork_head = client
        .wait_fork_ready(&fork_ref, 60, std::time::Duration::from_secs(1))
        .await?;
    client
        .create_branch(&fork.owner, &fork.repo, &branch_name, &fork_head.sha)
        .await?;
    let oid = client
        .create_commit_on_branch(
            &format!("{}/{}", fork.owner, fork.repo),
            &branch_name,
            &fork_head.sha,
            message,
            &files,
        )
        .await?;
    let pull = client
        .create_pull(
            &repo.owner,
            &repo.repo,
            &format!("{}:{}", fork.owner, branch_name),
            &repo.branch,
            message,
        )
        .await?;
    Ok(Submitted {
        mode: ShareMode::ReviewRequested,
        commit_sha: oid,
        review_url: Some(pull.html_url),
    })
}

/// 评审分支名。从 `now` 派生而非取系统时间:核心不摸时钟,测试才能钉住它。
fn review_branch(share_name: &str, now: &str) -> String {
    let stamp: String = now.chars().filter(|c| c.is_ascii_digit()).collect();
    format!("skillsync/{share_name}-{stamp}")
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
        skill_invalid_err, upsert_attribution, AttributionUpsert, CandidateOrigin, ShareMode,
        ShareOutcome,
    };
    use crate::core::skills::ShareBlock;

    fn keys(v: &serde_json::Value) -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    /// 🔴 **断言的是键的完整集合,不是"某个键存在"**(本项目记着的空转模式 ②)。
    ///
    /// 这条守的是一个真实存在过的哑弹:`rename_all` 挂在枚举上只改 variant 名,
    /// `review_url` 因此原样发成蛇形,而 `SharePage` 读的是 `reviewUrl`
    /// ——分享走评审之后那条「查看审核」链接**从来没渲染过**。
    #[test]
    fn share_outcome_serializes_every_field_in_camel_case() {
        let v = serde_json::to_value(ShareOutcome::Shared {
            mode: ShareMode::ReviewRequested,
            commit_sha: "abc".into(),
            review_url: Some("http://x/pulls/1".into()),
            share_name: "weekly-report".into(),
        })
        .unwrap();
        assert_eq!(
            keys(&v),
            vec![
                "commitSha".to_string(),
                "mode".to_string(),
                "outcome".to_string(),
                "reviewUrl".to_string(),
                "shareName".to_string(),
            ]
        );
        assert_eq!(v["outcome"], "shared");
        assert_eq!(v["mode"], "reviewRequested");
        assert_eq!(v["reviewUrl"], "http://x/pulls/1");
        assert_eq!(v["shareName"], "weekly-report");
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
}
