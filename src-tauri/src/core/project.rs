//! 项目级安装编排(v5 主目标):把技能装进**某个工作文件夹**,而不是全局 canonical。
//!
//! # 与全局链路的关系:并行,不共用
//!
//! **刻意不改 [`crate::core::installer`]**。它的不变量(canonical 无条件清空重建、
//! 守卫在 `acquire` 而不在它自己身上)是全局链路的地基,把 base 目录参数化就等于
//! 把项目级语义搅进那条路。这里只复用**原语**:[`crate::core::fsops`] 的建链/安全删除/
//! safe_join、[`crate::core::skills`] 的解析与 `sanitize_name`、
//! [`crate::core::installer::SkillPayload`] 的载荷形状。
//!
//! # 三个刻意的分叉(都对齐上游 `npx skills`,决策见 2026-08-20 拍板)
//!
//! 1. **安装键取 frontmatter `name`**,不取仓库目录名——与全局链路相反。
//!    项目级是新链路、零存量,跟上游一致才能让两边的 `skills-lock.json` 键对得上;
//!    全局链路的键已是索引/记账/lock 的同一把尺子,不迁移。
//! 2. **记账就是 `skills-lock.json` 本身**,不进 `state.installed`。零双份真相:
//!    项目目录被删/移走时天然降级为"不存在",不留孤儿记账。
//! 3. **本体落 `<项目>/.agents/skills/<键>`,按 `agents.json` 的 `skillsDir` 建相对链接**。
//!    `fsops` 的 Symlink 档本来就写相对路径(M1 为全局做的,注释对齐 installer.ts:254),
//!    实测产出与上游项目级逐字节相同,**无需为此改 fsops**。
//!
//! # 卸载为什么比上游啰嗦
//!
//! `skills-lock.json` 没有 link-mode 字段(上游的 schema,我们不能擅自加字段),
//! 所以卸载时看到 agent 目录下的**实体目录**,无从判断它是我们降级复制的、
//! 还是用户自己放的。上游直接删,本 app 受铁律 7「绝不静默删除用户文件」约束:
//! **内容与本体逐字节相同才删,不同就留着并在结果里报告**。

use std::path::{Path, PathBuf};

use crate::core::agents::AgentRegistry;
use crate::core::fsops::{self, OnOccupied};
use crate::core::installer::SkillPayload;
use crate::core::project_lock::{self, LocalEntry};
use crate::core::skills::{parse_skill_md, sanitize_name, SKILL_FILE};
use crate::error::AppError;

/// 技能本体在项目里的相对位置,对齐上游 `AGENTS_DIR/SKILLS_SUBDIR`。
const PROJECT_BODY_DIR: &str = ".agents/skills";

/// 安装成功后的回报。
#[derive(Debug, Clone)]
pub struct InstallDone {
    /// 安装键(= sanitize 后的 frontmatter name),也是 lock 的键与目录名。
    pub key: String,
    /// 本体绝对路径。
    pub body_dir: PathBuf,
    /// 实际建了链的 agent 名单(universal 的不在其中)。
    pub linked_agents: Vec<String>,
}

/// 安装前的预检结论。
#[derive(Debug)]
pub enum ProjectPrecheck {
    /// 该键在项目里还不存在,可以直接装。
    Fresh,
    /// 已存在且内容与将装的完全一致——没必要重装。
    AlreadyInstalled,
    /// 已存在但内容不同,**必须由用户拍板**。到这一步磁盘一个字节都没动过。
    NeedsDecision {
        /// 现有本体的 hash(上游口径)。
        current_hash: String,
    },
}

/// 卸载时**没有删掉**的东西,必须回报给调用方,由界面告诉用户。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RemovedItem {
    /// agent 目录下是实体目录且内容与本体不同——可能是用户自己的东西,留着。
    KeptForeignDir { dir: String },
}

/// 卸载结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDone {
    pub body_removed: bool,
    pub unlinked: Vec<String>,
    pub kept: Vec<RemovedItem>,
}

/// 技能本体目录:`<项目>/.agents/skills/<键>`。
pub fn body_dir(project_root: &Path, key: &str) -> PathBuf {
    project_root.join(PROJECT_BODY_DIR).join(key)
}

// ============================================================ 项目路径守卫

/// 选中的目录不能当项目用的理由。
///
/// core 返回**枚举不返回中文句子**:两道术语门都扫不到 core 里的散装文案
/// (`tests/terminology.rs` 只扒 `AppError::new`,前端守卫只扫 `src/`)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectPathError {
    NotFound,
    NotADirectory,
    /// 家目录本身。往这里装会把 `.agents/` 变成全局那一份。
    IsHome,
    /// canonical 自身、它的祖先(如 `~/.agents`)或它之下的任何位置。
    ///
    /// **"之下"这一档是重点**:选进 `~/.agents/skills/<某技能>/` 会把
    /// `skills-lock.json` 与 `.agents/` 写进那个已装技能的本体,
    /// `fsops::dir_content_hash` 当场漂移 → 全站误报「你改过这个技能」。
    InsideCanonical,
}

/// 校验一个目录能否作为项目根,通过则返回归一化后的绝对路径。
///
/// **一律按 `Path` 比,不按字符串比**(M4 任务 4 的 CI 教训:`home.join(".agents/skills")`
/// 在 Windows 上产出 `.agents/skills\x`,分段 join 产出 `.agents\skills\x`,
/// 同一个目录字符串却不等)。
pub fn validate_project_path(
    picked: &Path,
    home: &Path,
    canonical: &Path,
) -> Result<PathBuf, ProjectPathError> {
    let meta = std::fs::symlink_metadata(picked).map_err(|_| ProjectPathError::NotFound)?;
    if !picked.is_dir() {
        // symlink_metadata 不跟随链接,所以这里用 is_dir()(跟随)判断:
        // 指向目录的链接是可以当项目用的。
        let _ = meta;
        return Err(ProjectPathError::NotADirectory);
    }

    // 比较前各自 canonicalize:HOME 本身是软链的机器上(macOS 的 /tmp → /private/tmp
    // 就是这种)不做解析会比出假阴性。解析失败退回原路径,不因此放行。
    let resolved = std::fs::canonicalize(picked).unwrap_or_else(|_| picked.to_path_buf());
    let home_r = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let canonical_r =
        std::fs::canonicalize(canonical).unwrap_or_else(|_| canonical.to_path_buf());

    if resolved == home_r {
        return Err(ProjectPathError::IsHome);
    }
    // 三档一起判:canonical 自身、canonical 之下、canonical 的祖先。
    if resolved == canonical_r
        || resolved.starts_with(&canonical_r)
        || canonical_r.starts_with(&resolved)
    {
        return Err(ProjectPathError::InsideCanonical);
    }

    Ok(resolved)
}

// ============================================================ 项目清单

/// 把项目登记进清单(最近用的排前面)。**幂等**:同一路径只留一条。
///
/// 清单只是"用户碰过哪些项目"的路径列表——技能级真相在各项目的 `skills-lock.json` 里。
/// 项目目录被删或移走时,这条记录天然降级为"目录不存在",不留孤儿记账。
pub fn register_project(list: &mut Vec<String>, path: &Path) {
    let key = path.to_string_lossy().into_owned();
    list.retain(|p| Path::new(p) != path);
    list.insert(0, key);
    // 最近用的在前,但插入位置是 0 而列表原本有序——重新登记等于置顶。
    // 注意测试断言的是"置顶后 a 仍在 b 前",不是"顺序不变"。
}

/// 从清单移除。**纯记账**:磁盘一个字节都不动(用户的技能仍在项目里)。
pub fn forget_project(list: &mut Vec<String>, path: &Path) {
    list.retain(|p| Path::new(p) != path);
}

/// 从载荷里取出安装键。
///
/// 上游 `sanitizeName(skill.name || basename(skill.path))`:frontmatter name 优先,
/// 缺失才退回目录名。折成 `unnamed-skill` 说明信息全丢,拒绝安装
/// ——**不放宽 `sanitize_name`**,它同时决定 lock 的键。
pub fn install_key(dir_slug: &str, payload: &SkillPayload) -> Result<String, AppError> {
    let raw_name = payload
        .files()
        .get(SKILL_FILE)
        .and_then(|f| std::str::from_utf8(&f.bytes).ok())
        .and_then(|text| parse_skill_md(text).ok())
        .map(|parsed| parsed.name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| dir_slug.to_string());

    let key = sanitize_name(&raw_name);
    if key == "unnamed-skill" {
        return Err(AppError::new(
            "FS_UNUSABLE_NAME",
            "这个技能的名称无法作为文件夹名,请先给它起一个英文名称",
        )
        .with_detail(format!("sanitize_name({raw_name:?}) 折成了 unnamed-skill")));
    }
    Ok(key)
}

/// 安装前预检。**只读**:任何分支都不写磁盘。
pub fn precheck(
    project_root: &Path,
    dir_slug: &str,
    payload: &SkillPayload,
) -> Result<ProjectPrecheck, AppError> {
    let key = install_key(dir_slug, payload)?;
    let body = body_dir(project_root, &key);
    if !body.exists() {
        return Ok(ProjectPrecheck::Fresh);
    }

    let current = project_lock::upstream_folder_hash(&body)
        .map_err(|e| read_failed(&body, &e.to_string()))?;
    // 把载荷在内存里按同一口径算一遍,避免为了比对先落盘。
    let incoming = payload_hash(payload);

    if current == incoming {
        Ok(ProjectPrecheck::AlreadyInstalled)
    } else {
        Ok(ProjectPrecheck::NeedsDecision {
            current_hash: current,
        })
    }
}

/// 把载荷按上游 `computeSkillFolderHash` 的口径算一遍(不落盘)。
///
/// 与 [`project_lock::upstream_folder_hash`] 必须是同一把尺子:排序用同一个比较函数,
/// 拼接方式同为"裸拼路径+内容"。有测试断言"装完再算等于装之前算"。
fn payload_hash(payload: &SkillPayload) -> String {
    use sha2::{Digest, Sha256};
    let mut files: Vec<(&String, &[u8])> = payload
        .files()
        .iter()
        .map(|(rel, f)| (rel, f.bytes.as_slice()))
        .collect();
    files.sort_by(|a, b| project_lock::upstream_path_cmp(a.0, b.0));

    let mut hasher = Sha256::new();
    for (rel, bytes) in files {
        hasher.update(rel.as_bytes());
        hasher.update(bytes);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// 这个技能的本体是否被用户改过(与 lock 里记的 hash 不符)。
///
/// **lock 里没有这条记账时按"没改过"处理**:宁可漏报,不误报——与全局
/// 「指纹为空按没有更新处理」同一条取舍。手放进项目的技能就属于这一档,
/// 它本来也没有"更新"可言(界面不会给它摆更新按钮)。
pub fn has_local_edits(project_root: &Path, key: &str) -> Result<bool, AppError> {
    let lock = project_lock::lock_path(project_root);
    let Some((_, entry)) = project_lock::read_entries(&lock)
        .into_iter()
        .find(|(k, _)| k == key)
    else {
        return Ok(false);
    };
    if entry.computed_hash.is_empty() {
        return Ok(false);
    }

    let body = body_dir(project_root, key);
    if !body.exists() {
        return Ok(false);
    }
    let current =
        project_lock::upstream_folder_hash(&body).map_err(|e| read_failed(&body, &e.to_string()))?;
    Ok(current != entry.computed_hash)
}

/// 安装:落本体 → 建链 → 写 lock。
///
/// `entry` 里的 `computed_hash` 会被**实际落盘后现算的值覆盖**——调用方给什么都不算数,
/// 那条等式(lock 里的 hash == 磁盘现算)是"npx 不会误判我们装的技能改过了"的唯一保障。
pub fn install(
    project_root: &Path,
    dir_slug: &str,
    payload: &SkillPayload,
    agent_names: &[String],
    entry: &LocalEntry,
) -> Result<InstallDone, AppError> {
    let key = install_key(dir_slug, payload)?;
    let body = body_dir(project_root, &key);

    // 内容不可信:先整体校验路径再落盘,避免写到一半才发现 zip slip(同 installer)。
    let entries = payload
        .files()
        .iter()
        .map(|(rel, file)| Ok((fsops::safe_join(&body, rel)?, file)))
        .collect::<Result<Vec<_>, AppError>>()?;

    fsops::reset_dir(&body)?;
    for (path, file) in entries {
        fsops::write_file(&path, &file.bytes, file.unix_mode)?;
    }

    let mut linked = Vec::new();
    for dir in link_dirs(project_root, agent_names)? {
        let link = dir.path.join(&key);
        // OnOccupied::Fail:占位的可能是用户自己的技能,是否覆盖必须上层带确认结果决定。
        match fsops::link_dir(&body, &link, fsops::default_link_chain(), OnOccupied::Fail) {
            // `SameLocation` 不算建链——那是"目标就是本体自己"的情形,一个链接都没建。
            // 把它计进名单会让界面说"已关联到 X",而 X 其实什么都没发生。
            Ok(fsops::LinkOutcome::SameLocation) => {}
            Ok(_) => linked.extend(dir.agents.iter().cloned()),
            // 建链失败不回滚本体:技能已经装好了,universal 工具照样读得到。
            // 失败的 agent 由调用方决定要不要提示重试(与全局 link_agents 同姿态)。
            Err(e) => tracing::warn!(agent = ?dir.agents, error = %e.message, "项目级建链失败"),
        }
    }

    let mut final_entry = entry.clone();
    final_entry.computed_hash =
        project_lock::upstream_folder_hash(&body).map_err(|e| read_failed(&body, &e.to_string()))?;
    let outcome = project_lock::upsert(&project_lock::lock_path(project_root), &key, &final_entry);
    // 记账失败不阻断主流程(同全局 lock 的立场),但要留痕。
    if !matches!(outcome, project_lock::LocalLockOutcome::Written) {
        tracing::warn!(?outcome, "项目级记账未写入");
    }

    Ok(InstallDone {
        key,
        body_dir: body,
        linked_agents: linked,
    })
}

/// 卸载:摘链接 → 删本体 → 删 lock 条目。空的 lock 文件保留(对齐上游)。
pub fn remove(project_root: &Path, key: &str) -> Result<RemoveDone, AppError> {
    let body = body_dir(project_root, key);
    let mut unlinked = Vec::new();
    let mut kept = Vec::new();

    // 逐个 agent 目录清理。注意**不能只看账**——项目级没有 links 记账(lock 里没这个字段),
    // 所以按注册表把所有可能的位置都看一遍。
    for dir in all_link_dirs(project_root)? {
        let link = dir.join(key);
        if !link.exists() && fsops::read_link_target(&link).is_none() {
            continue;
        }
        if fsops::read_link_target(&link).is_some() {
            // 是链接:摘掉即可,只摘 reparse point / symlink,不动目标内容。
            if fsops::unlink_dir(&link)? {
                unlinked.push(link.to_string_lossy().into_owned());
            }
        } else if same_content(&link, &body) {
            // 实体目录且内容与本体相同 → 是我们降级复制出来的,删。
            fsops::remove_tree(&link)?;
            unlinked.push(link.to_string_lossy().into_owned());
        } else {
            // 内容不同 → 可能是用户自己的东西。留着并报告(铁律 7)。
            kept.push(RemovedItem::KeptForeignDir {
                dir: link.to_string_lossy().into_owned(),
            });
        }
    }

    let body_removed = fsops::remove_tree(&body)?;
    project_lock::remove(&project_lock::lock_path(project_root), key);

    Ok(RemoveDone {
        body_removed,
        unlinked,
        kept,
    })
}

/// 两个目录的内容是否逐字节相同(上游 hash 口径)。任一侧读不出来一律判"不同"
/// ——判不出来时保守留着,不删。
fn same_content(a: &Path, b: &Path) -> bool {
    match (
        project_lock::upstream_folder_hash(a),
        project_lock::upstream_folder_hash(b),
    ) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// 一个建链目标目录及共用它的 agent。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkDir {
    pub path: PathBuf,
    pub agents: Vec<String>,
}

/// 指定 agent 的建链目标(按目录合并,universal 的跳过)。
///
/// **按目录而不是按 agent**,与全局链路同一条铁律:多个 agent 共用一个 skillsDir 是常态,
/// 按 agent 逐个建/摘会互相踩。
///
/// ⚠️ **这个函数是 pub 的,因为 universal 跳过必须在这一层被测到**(2026-08-21 注入验证发现):
/// universal agent 的 `skillsDir` 恰好就是 `.agents/skills`,链接路径与本体完全相同,
/// 于是 `fsops::link_dir` 的 `SameLocation` 守卫会兜住它——把这道跳过删掉,
/// **端到端测试照样全绿**(空转模式 #1:同一条规则查了两遍)。
/// 不删这道跳过的理由是它表达意图且省掉无谓的建链尝试,但它必须在这里被直接断言,
/// 不能靠下层的巧合守卫。任务 4 的界面也要用它列"会关联到哪些工具"。
pub fn link_dirs(project_root: &Path, agent_names: &[String]) -> Result<Vec<LinkDir>, AppError> {
    let registry = AgentRegistry::builtin();
    let mut out: Vec<LinkDir> = Vec::new();
    for name in agent_names {
        let Some(agent) = registry.get(name) else {
            continue; // 注册表随版本演进,认不出的名字忽略而不是报错
        };
        if agent.is_universal() {
            continue; // 落在 .agents/skills 就可见,不建链
        }
        let path = project_root.join(&agent.skills_dir);
        match out.iter_mut().find(|d| d.path == path) {
            Some(existing) => existing.agents.push(name.clone()),
            None => out.push(LinkDir {
                path,
                agents: vec![name.clone()],
            }),
        }
    }
    Ok(out)
}

/// 注册表里所有可能的项目级建链目录(卸载时逐个查看)。
fn all_link_dirs(project_root: &Path) -> Result<Vec<PathBuf>, AppError> {
    let registry = AgentRegistry::builtin();
    let mut out: Vec<PathBuf> = Vec::new();
    for agent in registry.agents() {
        if agent.is_universal() {
            continue;
        }
        let path = project_root.join(&agent.skills_dir);
        if !out.contains(&path) {
            out.push(path);
        }
    }
    Ok(out)
}

fn read_failed(path: &Path, detail: &str) -> AppError {
    AppError::new("FS_READ_FAILED", "读取技能目录失败,请重试")
        .with_detail(format!("read {}: {detail}", path.display()))
}

// ============================================================ 更新去处

/// `sourceType` 里"来源可还原"的那几档。其余(`local` / `node_modules` /
/// `well-known`)没有可重新取数的远端,摆更新按钮就是摆一个必然报错的按钮。
const RESTORABLE_SOURCE_TYPES: [&str; 3] = ["github", "git", "gitlab"];

/// 更新一条项目级记账时,该去**哪个源、哪个库**取数。`None` = 没有可信去处,
/// 界面据此不摆更新按钮(M6「绑不上就不摆」同款姿势)。
///
/// 为什么非有这一层不可:项目级的唯一记账是项目根的 `skills-lock.json`,里面只有
/// `source`/`sourceUrl`/`sourceType`,**没有 registryId**。不还原成"源 + 库坐标"
/// 就把请求发出去,缺省会落到**内建源的主仓**——与 M4「更新必须带账上的仓库坐标」
/// 同一类缺陷:要么报找不到技能,要么装进来一个同名但完全不同的技能。
///
/// ⚠️ 分支名不从 lock 的 `gitRef` 取,走挂仓/库配置里记的那个分支——与全局链路
/// 「分支是技能库的属性」口径一致,不是这里漏了一个字段。
///
/// 判定分两步:
/// 1. 先走 [`acquire::resolve_binding_of`]——与「纳入管理」**同一份实现**,
///    同源 + 库在源的列表里才算绑上;
/// 2. 绑不上但来源指向 github.com → 落**广场源**。广场这一档按定义就是"任意
///    GitHub 仓",而项目 lock 是与 `npx skills` 共用的,里面的条目很可能压根不是
///    本 app 写的、这台机器的 `plazaRepos` 里当然没有它。取数前会幂等挂仓
///    (见 `plaza::ensure_repo`),所以这不是猜,是这条路唯一正确的去处。
pub fn update_target(
    entry: &LocalEntry,
    sources: &crate::core::acquire::BindingSources,
) -> Option<(String, String)> {
    if !RESTORABLE_SOURCE_TYPES.contains(&entry.source_type.as_str()) {
        return None;
    }
    let source_url = entry.source_url.as_deref().unwrap_or_default();

    // 坐标形状先收严:半边为空的话,拼出来的寻址键是 "owner/" 这种废话。
    let (owner, repo) = entry.source.split_once('/')?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    let key = crate::core::registry::repo_key(owner, repo);

    if let (crate::core::acquire::SourceBinding::Bound { registry_id, .. }, _, _) =
        crate::core::acquire::resolve_binding_of(&entry.source, source_url, sources)
    {
        return Some((registry_id, key));
    }

    if is_github_url(source_url) {
        return Some((crate::core::registry::PLAZA_REGISTRY_ID.to_string(), key));
    }
    None
}

/// `sourceUrl` 是不是指向 github.com。**按 URL 的 host 判,不按字符串包含**
/// ——`http://github.com.evil.internal/x/y` 含有 "github.com",而它不是 GitHub。
fn is_github_url(source_url: &str) -> bool {
    url::Url::parse(source_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case("github.com")))
        .unwrap_or(false)
}
