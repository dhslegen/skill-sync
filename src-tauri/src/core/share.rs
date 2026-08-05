//! 分享编排:候选扫描(排除法)→ 预检(同名三分支)→ 收编 → 提交(按权限矩阵)→ 记账。
//!
//! 设计方案 2.5②:不判断"原创"——canonical 目录里 npx skills 装的、手写的、别的工具放的
//! 混在一起,原创性无法可靠判定。改用**排除法**:凡不在本 app `state.installed` 里的,
//! 都可以分享;来源只作标签展示(npx skills 装的提示"来自第三方仓库")。
//!
//! # 假设(文档未覆盖,按开发纪律显式标注)
//!
//! - **本地目录一律不改名**:`share_name` 只决定远端路径与(收编时的)canonical 落点。
//!   改名分享一个 npx skills 装的技能时,它本地的目录名、它在别的工具里的链接都不动
//!   ——动了会破坏 npx skills 自己的记账,那不是我们的东西。
//! - **中文名技能的分享策略**(CLAUDE.md 预告任务 11 要定):分享时必须提供
//!   ASCII kebab-case 的 `share_name` 作为远端目录名(表单强制),frontmatter 的
//!   `name` 保持中文显示名。这与"安装目录名取仓库目录名、展示名取 frontmatter"的
//!   既有口径互为镜像,两个中文技能因此不会在远端撞进同一个目录。
//! - **frontmatter 补齐会重建头部**:只在 SKILL.md 不合规时允许,重写后只保证
//!   `name`/`description` 与正文;坏头部里残存的其他字段不保证保留。
//! - **更新分享不删除远端多出的文件**:只做 create/update。远端有而本地没有的文件
//!   多半是评审者补的(如 LICENSE),静默删除比留着危险得多。

use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::fsops::{self, OnOccupied};
use crate::core::gitea::{ChangeFilesRequest, FileChange, GiteaClient, RepoRef, RepoSource};
use crate::core::github::GithubClient;
use crate::core::skill_lock;
use crate::core::skills::{parse_skill_md, sanitize_name};
use crate::core::state::{self, SharedSkill, SkillSource, Store};
use crate::error::AppError;
use std::collections::BTreeMap;
use std::path::Path;

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CandidateOrigin {
    /// 两处记账都查不到,视为本地创建。
    Local,
    /// npx skills 装的,`source` 是它记的原始来源。
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
pub fn scan_candidates(
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    state: &state::State,
) -> Result<Vec<ShareCandidate>, AppError> {
    let canonical = registry.canonical_global_dir(env).ok_or_else(|| {
        AppError::new("FS_NO_HOME", "找不到你的用户目录,无法扫描本地技能")
            .with_detail("home dir unavailable")
    })?;

    let installed: Vec<&str> = state.installed.iter().map(|s| s.name.as_str()).collect();
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
            out.push(candidate(env, state, &name, &path, in_canonical));
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
) -> ShareCandidate {
    let (name, description, problem) =
        match std::fs::read_to_string(path.join("SKILL.md")) {
            Ok(raw) => match parse_skill_md(&raw) {
                Ok(parsed) => (Some(parsed.name), Some(parsed.description), None),
                Err(e) => (None, None, Some(e.reason())),
            },
            Err(_) => (None, None, Some("SKILL.md 无法读取".to_string())),
        };

    let shared = state.shared.iter().find(|s| s.local_path == path.to_string_lossy()).map(|s| {
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
    }
}

/// 查 npx skills 的 lock:能查到就是它装的,展示原始来源。
fn npx_origin(env: &dyn AgentEnv, dir_name: &str) -> CandidateOrigin {
    let Some(path) = skill_lock::lock_path(env) else {
        return CandidateOrigin::Local;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return CandidateOrigin::Local;
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        return CandidateOrigin::Local;
    };
    match doc["skills"][dir_name]["source"].as_str() {
        Some(source) if !source.is_empty() => CandidateOrigin::NpxSkills {
            source: source.to_string(),
        },
        _ => CandidateOrigin::Local,
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
pub async fn precheck(
    client: &ShareClient<'_>,
    repo: &RepoRef,
    state: &state::State,
    share_name: &str,
) -> Result<SharePrecheck, AppError> {
    let path = format!("skills/{share_name}/SKILL.md");
    let exists = match client {
        ShareClient::Gitea(c) => c.file_sha(repo, &path).await?.is_some(),
        ShareClient::Github(c) => c.file_exists(repo, &path).await?,
    };
    if !exists {
        return Ok(SharePrecheck::Fresh);
    }
    let mine = state.shared.iter().any(|s| {
        s.name == share_name && s.target.owner == repo.owner && s.target.repo == repo.repo
    });
    Ok(if mine { SharePrecheck::Mine } else { SharePrecheck::Taken })
}

// ============================================================ 提交

#[derive(Debug)]
pub struct ShareRequest<'a> {
    pub registry_id: &'a str,
    pub repo: &'a RepoRef,
    /// 候选的本地绝对路径(扫描结果里的 `path`)。
    pub source_path: &'a Path,
    /// 远端目录名。必须是 sanitize 的不动点(ASCII kebab),core 兜底校验。
    pub share_name: &'a str,
    /// 补齐表单的结果;None = SKILL.md 本来就合规,不动它。
    pub display_name: Option<&'a str>,
    pub description: Option<&'a str>,
    /// 记账用的来源标签:`local` | `npx-skills`。
    pub origin: &'a str,
    /// Taken 时用户确认覆盖。
    pub overwrite: bool,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum ShareOutcome {
    /// 同名冲突,等用户拍板(改名 / 查看 / 覆盖)。未动磁盘、未发提交。
    NeedsDecision { precheck: SharePrecheck },
    Shared {
        mode: ShareMode,
        commit_sha: String,
        /// 评审链接(ReviewRequested 时有)。
        review_url: Option<String>,
        /// 本次把技能从 agent 目录收编进了 canonical。
        adopted: bool,
        share_name: String,
    },
}

/// 分享一个候选技能。`now` 由调用方注入(派生评审分支名,便于测试)。
#[allow(clippy::too_many_arguments)]
pub async fn share(
    client: &ShareClient<'_>,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    req: ShareRequest<'_>,
    now: &str,
) -> Result<ShareOutcome, AppError> {
    if !usable_share_name(req.share_name) {
        return Err(AppError::new(
            "FS_UNUSABLE_NAME",
            "分享名称只能用英文小写字母、数字和短横线",
        )
        .with_detail(format!("share_name: {}", req.share_name)));
    }
    if !req.source_path.join("SKILL.md").is_file() {
        return Err(AppError::new(
            "FS_NOT_FOUND",
            "本地技能目录已不存在,请刷新列表后再试",
        )
        .with_detail(format!("missing: {}", req.source_path.display())));
    }

    let loaded = store.load_state()?;
    let checked = precheck(client, req.repo, &loaded.value, req.share_name).await?;
    if checked == SharePrecheck::Taken && !req.overwrite {
        return Ok(ShareOutcome::NeedsDecision { precheck: checked });
    }

    // 收编:agent 目录里的实体技能迁入 canonical,原位换成链接(原名不动)。
    // 顺序保证不丢数据:先整份复制,复制成功才动原位;链接建不成会降级复制,
    // 最坏情况原位仍是一份完整副本。
    let canonical = registry.canonical_global_dir(env).ok_or_else(|| {
        AppError::new("FS_NO_HOME", "找不到你的用户目录").with_detail("home dir unavailable")
    })?;
    let in_canonical = req.source_path.starts_with(&canonical);
    let (source_dir, adopted) = if in_canonical {
        (req.source_path.to_path_buf(), false)
    } else {
        let target = canonical.join(req.share_name);
        if target.exists() {
            return Err(AppError::new(
                "FS_OCCUPIED",
                "技能目录下已有同名技能,请换一个分享名称",
            )
            .with_detail(format!("occupied: {}", target.display())));
        }
        fsops::copy_tree(req.source_path, &target)?;
        fsops::link_dir(
            &target,
            req.source_path,
            fsops::default_link_chain(),
            OnOccupied::Replace,
        )?;
        (target, true)
    };

    // 补齐 frontmatter(只在表单给了值时)。写在读 payload 之前:推上去的就是补齐后的。
    if req.display_name.is_some() || req.description.is_some() {
        rewrite_frontmatter(&source_dir, req.display_name, req.description)?;
    }

    let prefix = format!("skills/{}/", req.share_name);
    let files = payload_files(&source_dir, &prefix)?;
    let title_name = req
        .display_name
        .map(str::to_string)
        .or_else(|| {
            std::fs::read_to_string(source_dir.join("SKILL.md"))
                .ok()
                .and_then(|raw| parse_skill_md(&raw).ok())
                .map(|p| p.name)
        })
        .unwrap_or_else(|| req.share_name.to_string());
    let message = match checked {
        SharePrecheck::Fresh => format!("新增技能:{title_name}"),
        _ => format!("更新技能:{title_name}"),
    };

    let submitted = submit(
        client,
        req.repo,
        &prefix,
        checked == SharePrecheck::Fresh,
        false,
        files,
        &message,
        req.share_name,
        now,
    )
    .await?;

    // 记账:content_hash 从**实际推的目录**算——"有未分享的改动"的判据就是它
    let mut next = loaded.value.clone();
    let entry = SharedSkill {
        name: req.share_name.to_string(),
        local_path: source_dir.to_string_lossy().into_owned(),
        origin: req.origin.to_string(),
        target: SkillSource {
            registry_id: req.registry_id.to_string(),
            owner: req.repo.owner.clone(),
            repo: req.repo.repo.clone(),
            path: format!("skills/{}", req.share_name),
            git_ref: req.repo.branch.clone(),
        },
        last_pushed_sha: submitted.commit_sha.clone(),
        content_hash: fsops::dir_content_hash(&source_dir)?,
    };
    match next.shared.iter().position(|s| s.name == req.share_name) {
        Some(idx) => next.shared[idx] = entry,
        None => next.shared.push(entry),
    }
    store.save_state(&next)?;

    Ok(ShareOutcome::Shared {
        mode: submitted.mode,
        commit_sha: submitted.commit_sha,
        review_url: submitted.review_url,
        adopted,
        share_name: req.share_name.to_string(),
    })
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
    let loaded = store.load_state()?;
    let Some(idx) = loaded.value.installed.iter().position(|s| s.name == dir_slug) else {
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

    let canonical = registry.canonical_global_dir(env).ok_or_else(|| {
        AppError::new("FS_NO_HOME", "找不到你的用户目录").with_detail("home dir unavailable")
    })?;
    let source_dir = canonical.join(dir_slug);
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
            submit_gitea(c, repo, force_review, changes, message, share_name, now).await
        }
        ShareClient::Github(c) => {
            submit_github(c, repo, force_review, files, message, share_name, now).await
        }
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
        if !force_review {
            let direct = ChangeFilesRequest {
                branch: repo.branch.clone(),
                new_branch: None,
                message: message.to_string(),
                files: files.clone(),
            };
            match client.change_files(&repo.owner, &repo.repo, &direct).await {
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
        let commit = client.change_files(&repo.owner, &repo.repo, &via_branch).await?;
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
    let via_fork = ChangeFilesRequest {
        branch: repo.branch.clone(),
        new_branch: Some(branch_name.clone()),
        message: message.to_string(),
        files,
    };
    let commit = client.change_files(&fork.owner, &fork.repo, &via_fork).await?;
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

/// 重建 SKILL.md 的 frontmatter(补齐表单的落点)。
///
/// 现有值能解析就作缺省,表单给的覆盖;正文原样保留。
fn rewrite_frontmatter(
    dir: &Path,
    display_name: Option<&str>,
    description: Option<&str>,
) -> Result<(), AppError> {
    let path = dir.join("SKILL.md");
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        AppError::new("FS_READ_FAILED", "无法读取 SKILL.md,请重试").with_detail(e.to_string())
    })?;

    let (old_name, old_desc, body) = match parse_skill_md(&raw) {
        Ok(p) => (Some(p.name), Some(p.description), p.body),
        // 头部坏了(常见是只缺 description):能抢救的字段照样作缺省,
        // 不然用户只补描述,原有的名字反而被判成"没填"。
        Err(_) => (
            salvage_field(&raw, "name"),
            salvage_field(&raw, "description"),
            strip_broken_frontmatter(&raw),
        ),
    };
    let name = display_name
        .map(str::to_string)
        .or(old_name)
        .unwrap_or_default();
    let desc = description
        .map(str::to_string)
        .or(old_desc)
        .unwrap_or_default();
    if name.is_empty() || desc.is_empty() {
        return Err(AppError::new(
            "REPO_INCOMPLETE_SKILL",
            "技能的名称与描述都需要填写",
        )
        .with_detail(format!("name={name:?} desc={desc:?}")));
    }

    let text = format!(
        "---\nname: {}\ndescription: {}\n---\n{}",
        yaml_scalar(&name),
        yaml_scalar(&desc),
        body
    );
    std::fs::write(&path, text).map_err(|e| {
        AppError::new("FS_WRITE_FAILED", "无法写入 SKILL.md,请重试").with_detail(e.to_string())
    })
}

/// 从(可能不完整的)frontmatter 块里按行抢救一个顶层标量字段。
fn salvage_field(raw: &str, field: &str) -> Option<String> {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix(&format!("{field}:")) {
            let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// 剥掉坏 frontmatter:文件以 `---` 开头就丢到下一个 `---` 为止,否则整个当正文。
fn strip_broken_frontmatter(raw: &str) -> String {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return raw.to_string();
    }
    let rest: Vec<&str> = lines.collect();
    match rest.iter().position(|l| l.trim() == "---") {
        Some(end) => rest[end + 1..].join("\n"),
        None => raw.to_string(),
    }
}

/// YAML 标量:含特殊字符时加引号转义,避免用户输入撑坏头部。
fn yaml_scalar(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.contains('"')
        || s.contains('\'')
        || s.starts_with(|c: char| c.is_whitespace() || "-?[]{}&*!|>%@`\"'".contains(c))
        || s.ends_with(char::is_whitespace);
    if needs_quote {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}
