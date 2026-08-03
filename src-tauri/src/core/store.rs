//! 商店索引:技能库压缩包 → 技能发现 → 可离线复用的本地缓存。
//!
//! 落点 `~/.skillsync/index-<registryId>.json`。
//!
//! ## 与 state.rs 相反的取舍(有意为之,勿"对齐修正")
//!
//! [`crate::core::state`] 遇到损坏文件会报错而不重置,因为它存的是用户的安装记账
//! ——丢了就没法重建。本模块存的是**派生数据**:索引随时能从技能库再取一份。
//! 因此这里一律**读不出来就丢弃重取**,绝不让一个坏字节把商店页锁死。
//! 同理,缓存里出现比自己更高的 schemaVersion 也只是丢弃重建,不进只读模式
//! ——否则一台被新版本写过缓存的机器,降级回旧版后就再也打不开商店。
//!
//! ## 假设(文档未覆盖,按开发纪律显式标注)
//!
//! - **卡片上的"更新于"与版本标识取自技能库整体的分支头**,不是逐技能的最近提交。
//!   逐技能归因要对每个技能目录发一次 commits 请求,50 个技能的首屏 <2s 预算撑不住。
//!   决策 C6 只要求"更新于 x 天前 + 短码",技能库级别已满足。
//! - **不展示作者**:frontmatter 只有 name/description/metadata.internal(任务 3 的解析器),
//!   提交人归因受上面同一条预算限制。UI-Demo 里的作者一栏因此留空,不编造。
//! - **文件大小只对文本文件给出**:压缩包解开后二进制文件不进内存树(任务 4 的既定行为),
//!   拿不到内容也就拿不到大小,界面对这类文件不显示尺寸。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::fsops;
use crate::core::gitea::{BranchHead, RepoArchive, RepoRef, RepoSource};
use crate::core::skills::{self, DiscoverOptions, SkillTree};
use crate::error::AppError;

/// 索引缓存的结构版本。缓存是可丢弃的派生数据,版本不符即重建,不做迁移。
pub const INDEX_SCHEMA_VERSION: u32 = 2;

// ============================================================ 缓存结构

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    /// 相对技能目录的路径,如 `scripts/collect.py`。
    pub path: String,
    /// 字节数。二进制文件不进内存树,拿不到大小(见模块头「假设」)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedSkill {
    /// frontmatter 的 `name`,界面展示用。
    pub name: String,
    /// **技能库中的技能目录名**,也是安装目录名(installer 的 `dir_slug`)。
    /// 不是 frontmatter 的 name——对齐上游远端安装的既定事实。
    pub dir_slug: String,
    pub description: String,
    /// 相对技能库根的路径,如 `skills/weekly-report`。
    pub path: String,
    /// SKILL.md 全文。详情预览完全走缓存,打开面板不再联网。
    pub skill_md: String,
    /// 技能目录内的全部文件(相对技能目录)。
    pub files: Vec<SkillFile>,
    /// 含可执行脚本 → 详情页警示角标(UX 增强 #2:企业内网也要给用户知情权)。
    pub has_scripts: bool,
    /// 远端这一版技能的内容哈希,与 `state.installed[].contentHash` **同算法可比**
    /// ([`fsops::ContentHasher`])。
    ///
    /// 「有可用更新」只能靠它判定。**不能拿仓库 HEAD sha 比**——那是整库的,
    /// 别人分享任何一个技能都会让所有已装技能被判成有更新(2026-08-03 用户实测撞到)。
    /// 逐技能问 commits 接口是另一条路,但那要每个目录一次请求,首屏撑不住(见模块头)。
    #[serde(default)]
    pub content_hash: String,
}

/// 有 SKILL.md 但没通过校验的目录。界面据此引导修复,而不是让技能凭空消失。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreIndex {
    pub schema_version: u32,
    pub registry_id: String,
    pub owner: String,
    pub repo: String,
    pub branch: String,
    /// 索引对应的技能库版本。与远端分支头一致即说明缓存还新鲜。
    pub commit_sha: String,
    /// 该版本的提交时间(技能库返回的原样 ISO-8601)。
    pub committed_at: String,
    /// 本机取得这份索引的时间(unix 秒),由调用方注入以便测试。
    pub fetched_at: i64,
    pub skills: Vec<IndexedSkill>,
    #[serde(default)]
    pub skipped: Vec<SkippedEntry>,
    /// 技能库根目录 `curated.json` 里的精选清单(按 frontmatter `name` 记,fixture 即此约定)。
    /// 库里没有该文件就是空——向导据此决定"一键全装"还是引导去商店,**不编造精选**。
    /// 旧缓存没有此字段(serde default 补空),效果与"库里没有"相同,无需升缓存版本。
    #[serde(default)]
    pub curated: Vec<String>,
}

impl StoreIndex {
    /// 缓存是否就是这个技能库的。换了坐标就不能拿旧索引充数。
    ///
    /// 版本闸门**不在这里**——[`load_cache`] 已经把版本不认识的缓存挡在门外。
    /// 两处都查会让其中一道永远不触发:注入验证时发现"更高版本缓存"那条测试
    /// 其实是被这里兜住的,load_cache 里的检查改坏了都不会变红(与任务 6 踩过的坑同型)。
    pub fn is_for(&self, registry_id: &str, r: &RepoRef) -> bool {
        self.registry_id == registry_id
            && self.owner == r.owner
            && self.repo == r.repo
            && self.branch == r.branch
    }
}

// ============================================================ 前端契约(IPC DTO)

/// 商店列表里的一张卡片。刻意**不含** SKILL.md 全文与文件清单
/// ——那两样只有详情面板要,放进列表会让每次刷新都多传几百 KB。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSkillCard {
    pub name: String,
    pub dir_slug: String,
    pub description: String,
    pub path: String,
    pub has_scripts: bool,
    pub file_count: usize,
    /// 远端这一版的内容哈希,与已装记账的 contentHash 比即得"有无可用更新"。
    /// 见 [`IndexedSkill::content_hash`]:**不能用整库 HEAD sha 代替**。
    pub content_hash: String,
}

/// `store_index` 的返回。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreIndexView {
    pub registry_id: String,
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub commit_sha: String,
    pub committed_at: String,
    pub fetched_at: i64,
    pub skills: Vec<StoreSkillCard>,
    pub skipped: Vec<SkippedEntry>,
    /// 本次没有下载技能库,直接用了本地索引。
    pub from_cache: bool,
    /// 联系不上技能库,展示的是上一次取到的内容(界面显示提示条,不弹错误框)。
    pub offline: bool,
    /// 精选清单,已解析为 `dirSlug`(清单里写的是 name,界面与安装都认目录名)。
    /// 名称在库里对不上的条目直接丢弃——精选列表摆一个装不上的项就是撒谎。
    pub curated: Vec<String>,
}

/// `store_skill_detail` 的返回(契约 3.3)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub name: String,
    pub dir_slug: String,
    pub description: String,
    pub path: String,
    pub skill_md: String,
    pub files: Vec<SkillFile>,
    pub has_scripts: bool,
    pub commit_sha: String,
    pub committed_at: String,
}

// ============================================================ 缓存读写

const INDEX_FILE_PREFIX: &str = "index-";

pub fn cache_path(dir: &Path, registry_id: &str) -> PathBuf {
    // registry id 由本应用生成(内建为 `company`,自定义源在任务 11 起也由应用编号),
    // 仍做一次保守清洗:它要拼进文件名,不能带路径分隔符。
    let safe: String = registry_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    dir.join(format!("{INDEX_FILE_PREFIX}{safe}.json"))
}

/// 丢弃某个源的索引缓存(移除自定义源时用)。不存在不算错;删不掉只记日志
/// ——缓存是可再生数据,不值得为它拦断移除流程。
pub fn drop_cache(path: &Path) {
    if let Err(err) = std::fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(path = %path.display(), error = %err, "索引缓存清理失败");
        }
    }
}

/// 读缓存。**任何异常都返回 `None`**:文件缺失、权限不足、JSON 损坏、版本不认识,
/// 一律当作"没有缓存",由调用方重新下载。这是本模块与 state.rs 最重要的分歧点。
pub fn load_cache(path: &Path) -> Option<StoreIndex> {
    let text = std::fs::read_to_string(path).ok()?;
    let index: StoreIndex = serde_json::from_str(&text).ok()?;
    (index.schema_version == INDEX_SCHEMA_VERSION).then_some(index)
}

/// 原子写(临时文件 + 同目录 rename)。跨文件系统的 rename 不是原子操作,故临时文件必须同目录。
pub fn save_cache(path: &Path, index: &StoreIndex) -> Result<(), AppError> {
    let failed = |e: std::io::Error| {
        AppError::new("FS_CACHE_WRITE", "本地索引保存失败,下次打开会重新获取")
            .with_detail(format!("write {}: {e}", path.display()))
    };
    let dir = path.parent().ok_or_else(|| {
        AppError::new("FS_CACHE_WRITE", "本地索引保存失败:路径不合法")
            .with_detail(format!("no parent for {}", path.display()))
    })?;
    std::fs::create_dir_all(dir).map_err(failed)?;
    let text = serde_json::to_string(index).map_err(|e| {
        AppError::new("FS_CACHE_WRITE", "本地索引保存失败").with_detail(e.to_string())
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(failed)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        failed(e)
    })
}

// ============================================================ 索引构建

/// 从解开的压缩包构建索引。纯函数,不碰网络与磁盘。
pub fn build_index(
    registry_id: &str,
    r: &RepoRef,
    head: &BranchHead,
    archive: &RepoArchive,
    fetched_at: i64,
) -> StoreIndex {
    let discovery = skills::discover_skills(&archive.tree, &archive.root, &DiscoverOptions::default());
    let root_prefix = format!("{}/", archive.root);

    let mut skills_out: Vec<IndexedSkill> = discovery
        .skills
        .into_iter()
        .map(|s| {
            let dir_slug = s.dir.rsplit('/').next().unwrap_or(s.dir.as_str()).to_string();
            let path = s.dir.strip_prefix(root_prefix.as_str()).unwrap_or(s.dir.as_str()).to_string();
            let skill_md = archive
                .tree
                .read_file(&format!("{}/{}", s.dir, skills::SKILL_FILE))
                .unwrap_or_default();
            IndexedSkill {
                name: s.name,
                dir_slug,
                description: s.description,
                path,
                skill_md,
                content_hash: remote_content_hash(archive, &s.dir),
                files: collect_files(archive, &s.dir),
                has_scripts: skills::has_executable_scripts(&s.dir, &archive.files),
            }
        })
        .collect();
    // 发现顺序取决于优先目录的遍历次序,对用户没有意义。按目录名排序,保证同一份技能库
    // 每次刷新的卡片顺序都一样(界面不会莫名跳动),前端再按搜索/筛选重排。
    skills_out.sort_by(|a, b| a.dir_slug.cmp(&b.dir_slug));

    StoreIndex {
        schema_version: INDEX_SCHEMA_VERSION,
        registry_id: registry_id.to_string(),
        owner: r.owner.clone(),
        repo: r.repo.clone(),
        branch: r.branch.clone(),
        commit_sha: head.sha.clone(),
        committed_at: head.committed_at.clone(),
        fetched_at,
        skills: skills_out,
        curated: parse_curated(archive),
        skipped: discovery
            .skipped
            .into_iter()
            .map(|s| SkippedEntry {
                path: s.path.strip_prefix(root_prefix.as_str()).unwrap_or(s.path.as_str()).to_string(),
                reason: s.reason,
            })
            .collect(),
    }
}

/// 读技能库根目录的 `curated.json`。没有、或格式不对都返回空——
/// 精选是锦上添花,坏一个文件不该把整个索引拉挂。
fn parse_curated(archive: &RepoArchive) -> Vec<String> {
    let Some(raw) = archive.tree.read_file(&format!("{}/curated.json", archive.root)) else {
        return Vec::new();
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else {
        eprintln!("[store] curated.json 不是合法 JSON,忽略精选清单");
        return Vec::new();
    };
    doc["curated"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 远端这一版技能的内容哈希。
///
/// 必须与安装后 `fsops::dir_content_hash(canonical)` 得到的值**完全相等**——
/// installer 把 `archive.entries` 里该目录下的字节原样落盘,所以只要:
/// ①同一个 [`fsops::ContentHasher`];②同一份排除清单([`fsops::is_excluded_rel`]);
/// ③同样按相对路径字典序喂入(entries 是 BTreeMap,天然有序),两边就一定一致。
/// 有测试逐字节钉住这条等式——它一旦不成立,界面会永远显示"有更新"。
fn remote_content_hash(archive: &RepoArchive, dir: &str) -> String {
    let prefix = format!("{dir}/");
    let mut hasher = fsops::ContentHasher::new();
    for (full, entry) in &archive.entries {
        let Some(rel) = full.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if rel.is_empty() || fsops::is_excluded_rel(rel) {
            continue;
        }
        hasher.push(rel, &entry.bytes);
    }
    hasher.finish()
}

fn collect_files(archive: &RepoArchive, dir: &str) -> Vec<SkillFile> {
    let prefix = format!("{dir}/");
    let mut out: Vec<SkillFile> = archive
        .files
        .iter()
        .filter_map(|full| {
            let rel = full.strip_prefix(prefix.as_str())?;
            // 只要目录内的文件;压缩包里目录条目已被 unzip_archive 过滤掉
            (!rel.is_empty()).then(|| SkillFile {
                // 大小取自原始字节,二进制文件也有(它们不在文本树里,但在 entries 里)。
                // 早先从 tree 的字符串长度推,于是图片一律显示"—"——那时 entries 还不存在。
                path: rel.to_string(),
                size: archive.entries.get(full).map(|e| e.bytes.len() as u64),
            })
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

impl StoreIndex {
    pub fn to_view(&self, from_cache: bool, offline: bool) -> StoreIndexView {
        StoreIndexView {
            registry_id: self.registry_id.clone(),
            owner: self.owner.clone(),
            repo: self.repo.clone(),
            branch: self.branch.clone(),
            commit_sha: self.commit_sha.clone(),
            committed_at: self.committed_at.clone(),
            fetched_at: self.fetched_at,
            skills: self
                .skills
                .iter()
                .map(|s| StoreSkillCard {
                    name: s.name.clone(),
                    dir_slug: s.dir_slug.clone(),
                    description: s.description.clone(),
                    path: s.path.clone(),
                    has_scripts: s.has_scripts,
                    file_count: s.files.len(),
                    content_hash: s.content_hash.clone(),
                })
                .collect(),
            skipped: self.skipped.clone(),
            curated: self
                .curated
                .iter()
                .filter_map(|name| {
                    self.skills
                        .iter()
                        .find(|s| &s.name == name)
                        .map(|s| s.dir_slug.clone())
                })
                .collect(),
            from_cache,
            offline,
        }
    }

    pub fn detail(&self, dir_slug: &str) -> Option<SkillDetail> {
        let s = self.skills.iter().find(|s| s.dir_slug == dir_slug)?;
        Some(SkillDetail {
            name: s.name.clone(),
            dir_slug: s.dir_slug.clone(),
            description: s.description.clone(),
            path: s.path.clone(),
            skill_md: s.skill_md.clone(),
            files: s.files.clone(),
            has_scripts: s.has_scripts,
            commit_sha: self.commit_sha.clone(),
            committed_at: self.committed_at.clone(),
        })
    }
}

// ============================================================ 编排

/// 本次刷新的来源,决定界面上显示"刚刷新"还是离线提示条。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexOutcome {
    pub from_cache: bool,
    pub offline: bool,
}

/// 取商店索引。
///
/// 流程:读缓存 → 问分支头 → sha 相同则直接用缓存(**不下载压缩包**) → 否则下载重建并落盘。
/// 技能库联系不上时,有缓存就降级浏览(UX 增强 #10:断网不弹错误框轰炸),没缓存才报错。
pub async fn refresh_index(
    client: &impl RepoSource,
    r: &RepoRef,
    registry_id: &str,
    cache_file: &Path,
    force: bool,
    fetched_at: i64,
) -> Result<(StoreIndex, IndexOutcome), AppError> {
    let mut cached = load_cache(cache_file).filter(|c| c.is_for(registry_id, r));

    let head = match client.branch_head(r).await {
        Ok(head) => head,
        Err(err) => {
            return match cached {
                Some(index) => Ok((index, IndexOutcome { from_cache: true, offline: true })),
                None => Err(err),
            }
        }
    };

    if !force {
        // take/放回而不是 clone:命中缓存是最热的路径(DoD 要 <300ms),
        // 50 个技能连 SKILL.md 全文一起复制一遍纯属白花钱。
        if let Some(index) = cached.take() {
            if index.commit_sha == head.sha {
                return Ok((index, IndexOutcome { from_cache: true, offline: false }));
            }
            cached = Some(index);
        }
    }

    let archive = match client.download_archive(r).await {
        Ok(a) => a,
        Err(err) => {
            // 下载失败但手里有(旧版本的)索引:仍让用户浏览,标记为离线。
            return match cached {
                Some(index) => Ok((index, IndexOutcome { from_cache: true, offline: true })),
                None => Err(err),
            };
        }
    };

    let index = build_index(registry_id, r, &head, &archive, fetched_at);
    // 写缓存失败只影响下次能否命中,不该拦住这一次的浏览。
    if let Err(err) = save_cache(cache_file, &index) {
        tracing_warn(&err);
    }
    Ok((index, IndexOutcome { from_cache: false, offline: false }))
}

/// tracing 到任务 13 才接;在那之前用 stderr,至少不静默吞掉。
fn tracing_warn(err: &AppError) {
    eprintln!("[store] {err}{}", err.detail.as_deref().unwrap_or(""));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::skills::MemTree;

    fn head(sha: &str) -> BranchHead {
        BranchHead {
            sha: sha.to_string(),
            committed_at: "2026-07-30T10:00:00+08:00".to_string(),
        }
    }

    fn repo() -> RepoRef {
        RepoRef {
            owner: "skills".into(),
            repo: "skills".into(),
            branch: "main".into(),
        }
    }

    /// 造一个像真技能库那样的压缩包内容:顶层是仓库名,技能在 `skills/<slug>/`。
    ///
    /// frontmatter 的 `name` 故意**不等于**目录名(真实公司技能库正是中文名 + ASCII kebab 目录)。
    /// 早先版本让两者同值,结果"安装目录名取目录名而不是 name"这条关键事实
    /// 在实现改坏后测试照样通过——注入验证抓出来的空转。
    fn archive_with(slugs: &[&str]) -> RepoArchive {
        let mut archive = RepoArchive {
            root: "skills".to_string(),
            tree: MemTree::new(),
            files: Vec::new(),
            entries: Default::default(),
        };
        for slug in slugs {
            let path = format!("skills/skills/{slug}/SKILL.md");
            let text = format!("---\nname: 技能·{slug}\ndescription: {slug} 的说明\n---\n\n正文\n");
            put_text(&mut archive, &path, &text);
        }
        archive
    }

    /// 放一个文本文件:同时进文本树(发现扫描用)与 entries(落盘用)。
    fn put_text(archive: &mut RepoArchive, path: &str, text: &str) {
        archive.tree = std::mem::take(&mut archive.tree).with_file(path, text);
        archive.files.push(path.to_string());
        archive.entries.insert(
            path.to_string(),
            crate::core::gitea::ArchiveEntry { bytes: text.as_bytes().to_vec(), unix_mode: None },
        );
    }

    /// 放一个二进制文件:只进 entries,不进文本树(与 unzip_archive 的行为一致)。
    fn put_binary(archive: &mut RepoArchive, path: &str, bytes: &[u8]) {
        archive.files.push(path.to_string());
        archive.entries.insert(
            path.to_string(),
            crate::core::gitea::ArchiveEntry { bytes: bytes.to_vec(), unix_mode: None },
        );
    }

    #[test]
    fn builds_index_with_dir_slug_and_full_skill_md() {
        let archive = archive_with(&["weekly-report", "docx-to-markdown"]);
        let index = build_index("company", &repo(), &head("abc1234"), &archive, 1_753_800_000);

        assert_eq!(index.skills.len(), 2);
        // 排序按目录名,保证卡片顺序稳定
        assert_eq!(index.skills[0].dir_slug, "docx-to-markdown");
        assert_eq!(index.skills[1].dir_slug, "weekly-report");
        // 安装目录名取**技能库里的目录名**,不是 frontmatter 的 name(CLAUDE.md 关键事实)。
        // 两者必须分别断言,否则 fixture 一同值就把这条差别测没了。
        assert_eq!(index.skills[1].name, "技能·weekly-report");
        // path 相对技能库根,不带压缩包顶层目录
        assert_eq!(index.skills[1].path, "skills/weekly-report");
        // 详情预览要的全文进了索引
        assert!(index.skills[1].skill_md.contains("weekly-report 的说明"));
        assert_eq!(index.skills[1].files, vec![SkillFile { path: "SKILL.md".into(), size: Some(index.skills[1].skill_md.len() as u64) }]);
        assert_eq!(index.commit_sha, "abc1234");
        assert_eq!(index.committed_at, "2026-07-30T10:00:00+08:00");
        assert_eq!(index.fetched_at, 1_753_800_000);
    }

    #[test]
    fn flags_skills_that_carry_executable_scripts() {
        let mut archive = archive_with(&["with-scripts", "docs-only"]);
        put_text(&mut archive, "skills/skills/with-scripts/scripts/collect.py", "print(1)\n");
        put_text(&mut archive, "skills/skills/docs-only/templates/dept.md", "# 模板\n");

        let index = build_index("company", &repo(), &head("abc"), &archive, 0);
        let by = |slug: &str| index.skills.iter().find(|s| s.dir_slug == slug).unwrap().clone();

        assert!(by("with-scripts").has_scripts, "含 .py 的技能必须标警示角标");
        assert!(!by("docs-only").has_scripts, "只有 markdown 的技能不该被标成含脚本");
        // 目录内文件全都收进来,供文件树展示
        assert_eq!(
            by("with-scripts").files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["SKILL.md", "scripts/collect.py"]
        );
    }

    #[test]
    fn binary_files_get_a_real_size_from_their_bytes() {
        // 二进制文件不进**文本树**(既定行为),但字节在 entries 里——大小从那儿来。
        // 任务 9 之前 size 是从文本树的字符串长度推的,于是图片一律显示"—";
        // 有了 entries(安装要靠它拿字节)之后,这里就该给出真实大小。
        let mut archive = archive_with(&["with-image"]);
        put_binary(&mut archive, "skills/skills/with-image/logo.png", &[0x89, b'P', b'N', b'G', 1, 2, 3]);

        let index = build_index("company", &repo(), &head("abc"), &archive, 0);
        let png = index.skills[0].files.iter().find(|f| f.path == "logo.png").unwrap();
        assert_eq!(png.size, Some(7));
    }

    #[test]
    fn files_missing_from_entries_report_no_size_instead_of_zero() {
        // 路径在清单里但字节缺失(理论上不该发生)时,不编造 0 B
        let mut archive = archive_with(&["odd"]);
        archive.files.push("skills/skills/odd/ghost.bin".into());

        let index = build_index("company", &repo(), &head("abc"), &archive, 0);
        let ghost = index.skills[0].files.iter().find(|f| f.path == "ghost.bin").unwrap();
        assert_eq!(ghost.size, None);
    }

    #[test]
    fn internal_skills_stay_out_of_the_store() {
        let mut archive = archive_with(&["public-one"]);
        put_text(
            &mut archive,
            "skills/skills/hidden-one/SKILL.md",
            "---\nname: 技能·hidden-one\ndescription: 内部用\nmetadata:\n  internal: true\n---\n\n正文\n",
        );

        let index = build_index("company", &repo(), &head("abc"), &archive, 0);
        assert_eq!(
            index.skills.iter().map(|s| s.dir_slug.as_str()).collect::<Vec<_>>(),
            vec!["public-one"]
        );
    }

    #[test]
    fn unparseable_skills_are_reported_not_swallowed() {
        let mut archive = archive_with(&["good-one"]);
        put_text(&mut archive, "skills/skills/bad-one/SKILL.md", "---\nname: 只有名字\n---\n");

        let index = build_index("company", &repo(), &head("abc"), &archive, 0);
        assert_eq!(index.skills.len(), 1);
        assert_eq!(index.skipped.len(), 1);
        // 路径也去掉压缩包顶层目录,界面上给用户看的是技能库内的位置
        assert_eq!(index.skipped[0].path, "skills/bad-one/SKILL.md");
        assert!(index.skipped[0].reason.contains("description"), "{}", index.skipped[0].reason);
    }

    // ---- 缓存文件 ----

    #[test]
    fn cache_file_name_is_scoped_by_registry() {
        let dir = Path::new("/tmp/x");
        assert_eq!(cache_path(dir, "company"), dir.join("index-company.json"));
        // id 要拼进文件名,路径分隔符与 `.` 都必须被清掉,不能让它跑出目录
        assert_eq!(cache_path(dir, "a/../b"), dir.join("index-a____b.json"));
    }

    #[test]
    fn corrupt_cache_is_discarded_instead_of_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let path = cache_path(tmp.path(), "company");
        std::fs::write(&path, "{ 这不是 json").unwrap();
        assert!(load_cache(&path).is_none(), "损坏的索引必须当作没有缓存,而不是报错锁死商店");
    }

    #[test]
    fn cache_from_a_newer_app_version_is_rebuilt_not_locked() {
        let tmp = tempfile::tempdir().unwrap();
        let path = cache_path(tmp.path(), "company");
        let mut index = build_index("company", &repo(), &head("abc"), &archive_with(&["a"]), 0);
        index.schema_version = INDEX_SCHEMA_VERSION + 1;
        std::fs::write(&path, serde_json::to_string(&index).unwrap()).unwrap();

        assert!(
            load_cache(&path).is_none(),
            "更高版本的缓存要丢弃重建;若像 state 那样进只读,降级回旧版就再也打不开商店"
        );
    }

    #[test]
    fn cache_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = cache_path(tmp.path(), "company");
        let index = build_index("company", &repo(), &head("abc"), &archive_with(&["a", "b"]), 42);
        save_cache(&path, &index).unwrap();
        assert_eq!(load_cache(&path).unwrap(), index);
    }

    #[test]
    fn cache_write_is_atomic() {
        let tmp = tempfile::tempdir().unwrap();
        let path = cache_path(tmp.path(), "company");
        let old = build_index("company", &repo(), &head("old"), &archive_with(&["a"]), 1);
        save_cache(&path, &old).unwrap();
        let new = build_index("company", &repo(), &head("new"), &archive_with(&["a", "b"]), 2);
        save_cache(&path, &new).unwrap();

        assert_eq!(load_cache(&path).unwrap(), new);
        // 临时文件不得残留在用户目录里
        let leftovers: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
    }

    #[test]
    fn cache_of_another_repo_is_not_reused() {
        let index = build_index("company", &repo(), &head("abc"), &archive_with(&["a"]), 0);
        assert!(index.is_for("company", &repo()));
        assert!(!index.is_for("other", &repo()), "换了技能库源不能拿旧索引充数");
        assert!(!index.is_for(
            "company",
            &RepoRef { owner: "skills".into(), repo: "other".into(), branch: "main".into() }
        ));
        assert!(!index.is_for(
            "company",
            &RepoRef { owner: "skills".into(), repo: "skills".into(), branch: "dev".into() }
        ));
    }

    // ---- DTO ----

    #[test]
    fn list_view_omits_heavy_fields_but_detail_keeps_them() {
        let index = build_index("company", &repo(), &head("abc1234"), &archive_with(&["weekly-report"]), 7);
        let view = index.to_view(true, false);
        let json = serde_json::to_value(&view).unwrap();

        assert_eq!(json["skills"][0]["dirSlug"], "weekly-report");
        assert_eq!(json["skills"][0]["fileCount"], 1);
        assert!(json["skills"][0].get("skillMd").is_none(), "列表不该背着 SKILL.md 全文过 IPC");
        assert!(json["skills"][0].get("files").is_none());
        assert_eq!(json["fromCache"], true);
        assert_eq!(json["offline"], false);

        let detail = index.detail("weekly-report").unwrap();
        assert!(detail.skill_md.contains("weekly-report 的说明"));
        assert_eq!(detail.commit_sha, "abc1234");
        assert!(index.detail("不存在的技能").is_none());
    }
}

#[cfg(test)]
mod content_hash_tests {
    use super::*;
    use crate::core::skills::MemTree;

    fn archive() -> RepoArchive {
        let mut a = RepoArchive {
            root: "skills".to_string(),
            tree: MemTree::new(),
            files: Vec::new(),
            entries: Default::default(),
        };
        let files: [(&str, &[u8]); 4] = [
            (
                "skills/skills/weekly-report/SKILL.md",
                b"---\nname: \xe5\x91\xa8\xe6\x8a\xa5\ndescription: d\n---\n\n\xe6\xad\xa3\xe6\x96\x87\n",
            ),
            ("skills/skills/weekly-report/scripts/run.sh", b"#!/bin/sh\necho hi\n"),
            ("skills/skills/weekly-report/assets/logo.png", &[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
            // 排除清单里的:两侧都必须跳过
            ("skills/skills/weekly-report/metadata.json", b"{\"x\":1}"),
        ];
        for (path, bytes) in files {
            a.files.push(path.to_string());
            a.entries.insert(
                path.to_string(),
                crate::core::gitea::ArchiveEntry { bytes: bytes.to_vec(), unix_mode: None },
            );
            if let Ok(text) = std::str::from_utf8(bytes) {
                a.tree = std::mem::take(&mut a.tree).with_file(path, text);
            }
        }
        a
    }

    /// 本模块存在的**唯一理由**:远端算出的哈希必须与技能装到本地后
    /// `fsops::dir_content_hash` 算出的值逐字节相等。不相等 = 界面永远显示"有更新"。
    #[test]
    fn remote_hash_equals_hash_of_what_gets_installed() {
        let a = archive();
        let remote = remote_content_hash(&a, "skills/skills/weekly-report");

        // 模拟 installer:把该目录下的 entries 原样落盘(它就是这么做的)
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("weekly-report");
        let prefix = "skills/skills/weekly-report/";
        for (full, entry) in &a.entries {
            let Some(rel) = full.strip_prefix(prefix) else { continue };
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, &entry.bytes).unwrap();
        }
        let local = fsops::dir_content_hash(&dir).unwrap();

        assert_eq!(remote, local, "远端与本地哈希必须一致,否则装完就会永远提示有更新");
        assert!(remote.starts_with("sha256:"));
    }

    /// 改一个技能的内容只影响它自己 —— 这正是"分享一个技能导致全部提示更新"的反面。
    #[test]
    fn editing_one_skill_does_not_change_another_skills_hash() {
        let mut a = archive();
        let other = "skills/skills/other/SKILL.md";
        a.files.push(other.to_string());
        a.entries.insert(
            other.to_string(),
            crate::core::gitea::ArchiveEntry { bytes: b"---\nname: o\ndescription: d\n---\n".to_vec(), unix_mode: None },
        );

        let before_weekly = remote_content_hash(&a, "skills/skills/weekly-report");
        let before_other = remote_content_hash(&a, "skills/skills/other");

        // 只动 other
        a.entries.get_mut(other).unwrap().bytes = b"---\nname: o\ndescription: d2\n---\n".to_vec();

        assert_eq!(before_weekly, remote_content_hash(&a, "skills/skills/weekly-report"));
        assert_ne!(before_other, remote_content_hash(&a, "skills/skills/other"));
    }

    #[test]
    fn excluded_entries_do_not_affect_the_hash() {
        let a = archive();
        let with_meta = remote_content_hash(&a, "skills/skills/weekly-report");

        let mut b = archive();
        b.entries.get_mut("skills/skills/weekly-report/metadata.json").unwrap().bytes =
            b"{\"totally\":\"different\"}".to_vec();

        assert_eq!(with_meta, remote_content_hash(&b, "skills/skills/weekly-report"));
    }

    #[test]
    fn index_cards_carry_the_hash() {
        let a = archive();
        let index = build_index("company", &repo_ref(), &head_of("abc"), &a, 0);
        let card = &index.to_view(false, false).skills[0];
        assert_eq!(card.dir_slug, "weekly-report");
        assert_eq!(card.content_hash, remote_content_hash(&a, "skills/skills/weekly-report"));
    }

    fn repo_ref() -> RepoRef {
        RepoRef { owner: "skills".into(), repo: "skills".into(), branch: "main".into() }
    }
    fn head_of(sha: &str) -> BranchHead {
        BranchHead { sha: sha.into(), committed_at: "2026-08-03T10:00:00Z".into() }
    }
}
