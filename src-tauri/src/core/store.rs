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

use crate::core::gitea::{BranchHead, GiteaClient, RepoArchive, RepoRef};
use crate::core::skills::{self, DiscoverOptions, SkillTree};
use crate::error::AppError;

/// 索引缓存的结构版本。缓存是可丢弃的派生数据,版本不符即重建,不做迁移。
pub const INDEX_SCHEMA_VERSION: u32 = 1;

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

fn collect_files(archive: &RepoArchive, dir: &str) -> Vec<SkillFile> {
    let prefix = format!("{dir}/");
    let mut out: Vec<SkillFile> = archive
        .files
        .iter()
        .filter_map(|full| {
            let rel = full.strip_prefix(prefix.as_str())?;
            // 只要目录内的文件;压缩包里目录条目已被 unzip_archive 过滤掉
            (!rel.is_empty()).then(|| SkillFile {
                path: rel.to_string(),
                size: archive.tree.read_file(full).map(|c| c.len() as u64),
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
                })
                .collect(),
            skipped: self.skipped.clone(),
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
    client: &GiteaClient,
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
        let mut tree = MemTree::new();
        let mut files = Vec::new();
        for slug in slugs {
            let path = format!("skills/skills/{slug}/SKILL.md");
            tree = tree.with_file(
                &path,
                &format!("---\nname: 技能·{slug}\ndescription: {slug} 的说明\n---\n\n正文\n"),
            );
            files.push(path);
        }
        RepoArchive {
            root: "skills".to_string(),
            tree,
            files,
        }
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
        archive.files.push("skills/skills/with-scripts/scripts/collect.py".into());
        archive.tree = std::mem::take(&mut archive.tree)
            .with_file("skills/skills/with-scripts/scripts/collect.py", "print(1)\n");
        archive.files.push("skills/skills/docs-only/templates/dept.md".into());
        archive.tree = std::mem::take(&mut archive.tree)
            .with_file("skills/skills/docs-only/templates/dept.md", "# 模板\n");

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
    fn binary_files_appear_in_tree_without_size() {
        // 压缩包里的二进制文件不进内存树(任务 4 的既定行为),路径仍要出现在文件清单里
        let mut archive = archive_with(&["with-image"]);
        archive.files.push("skills/skills/with-image/logo.png".into());

        let index = build_index("company", &repo(), &head("abc"), &archive, 0);
        let png = index.skills[0].files.iter().find(|f| f.path == "logo.png").unwrap();
        assert_eq!(png.size, None, "拿不到内容就不该编造大小");
    }

    #[test]
    fn internal_skills_stay_out_of_the_store() {
        let mut archive = archive_with(&["public-one"]);
        let path = "skills/skills/hidden-one/SKILL.md";
        archive.tree = std::mem::take(&mut archive.tree).with_file(
            path,
            "---\nname: 技能·hidden-one\ndescription: 内部用\nmetadata:\n  internal: true\n---\n\n正文\n",
        );
        archive.files.push(path.into());

        let index = build_index("company", &repo(), &head("abc"), &archive, 0);
        assert_eq!(
            index.skills.iter().map(|s| s.dir_slug.as_str()).collect::<Vec<_>>(),
            vec!["public-one"]
        );
    }

    #[test]
    fn unparseable_skills_are_reported_not_swallowed() {
        let mut archive = archive_with(&["good-one"]);
        let path = "skills/skills/bad-one/SKILL.md";
        archive.tree = std::mem::take(&mut archive.tree).with_file(path, "---\nname: 只有名字\n---\n");
        archive.files.push(path.into());

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
