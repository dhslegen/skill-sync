//! 本地技能目录的详情读取:「我的技能」与分享页的详情面板数据源。
//!
//! 商店详情([`crate::core::store::SkillDetail`])来自远端压缩包缓存;已装技能可能
//! 来源已移除、或是 npx skills 装的,在商店索引里根本没有——所以本地详情必须直接
//! 读盘,而不是绕道商店缓存。
//!
//! 这里只**读**:遍历目录、读 SKILL.md、解析 frontmatter。不做任何写入或删改,
//! 铁律 3 针对的链接/删除/复制原语不在本模块出现。

use std::path::Path;

use serde::Serialize;

use crate::core::skills::{self, SKILL_FILE};
use crate::error::AppError;

/// 详情面板要展示的一个文件。与商店侧 `SkillFile` 形状兼容(path + size),
/// 但本地读盘永远拿得到大小,不需要 Option。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillFile {
    /// 相对技能目录的路径,如 `scripts/collect.py`。
    pub path: String,
    pub size: u64,
}

/// `skill_local_detail` 的返回。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillDetail {
    pub name: String,
    pub dir_slug: String,
    pub description: String,
    /// 目录的绝对路径。详情面板展示位置,也是「在访达/资源管理器中打开」的目标。
    pub path: String,
    pub skill_md: String,
    pub files: Vec<LocalSkillFile>,
    pub has_scripts: bool,
}

/// 目录不是技能(或不存在)时的统一错误。守卫与文案集中一处,
/// `skill_reveal` 的准入检查也用它——webview 通往文件系统的通道要收口。
pub fn ensure_skill_dir(dir: &Path) -> Result<(), AppError> {
    if dir.is_dir() && dir.join(SKILL_FILE).is_file() {
        return Ok(());
    }
    Err(
        AppError::new("FS_NOT_A_SKILL", "这个文件夹不是技能,或技能描述文件缺失")
            .with_detail(dir.to_string_lossy().into_owned()),
    )
}

/// 读一个本地技能目录出详情。
///
/// frontmatter 坏了**不报错**:本地技能可能被用户改过,详情面板此时更要打得开
/// (名称回退目录名、描述留空),否则"改坏了想看看哪坏了"这条路就断了。
pub fn local_skill_detail(dir: &Path) -> Result<LocalSkillDetail, AppError> {
    ensure_skill_dir(dir)?;
    let dir_slug = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();

    let skill_md = std::fs::read_to_string(dir.join(SKILL_FILE)).map_err(|e| {
        AppError::new("FS_READ_FAILED", "读取技能内容失败,请重试").with_detail(e.to_string())
    })?;
    let (name, description) = match skills::parse_skill_md(&skill_md) {
        Ok(parsed) => (parsed.name, parsed.description),
        Err(_) => (dir_slug.clone(), String::new()),
    };

    let mut files = Vec::new();
    collect_files(dir, "", &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));

    // 与商店详情同一条判定规则(按扩展名),避免同一个技能两个面板一处有警示一处没有
    let prefixed: Vec<String> = files
        .iter()
        .map(|f| format!("{dir_slug}/{}", f.path))
        .collect();
    let has_scripts = skills::has_executable_scripts(&dir_slug, &prefixed);

    Ok(LocalSkillDetail {
        name,
        dir_slug,
        description,
        path: dir.to_string_lossy().into_owned(),
        skill_md,
        files,
        has_scripts,
    })
}

/// 递归收集文件。**不进入目录符号链接**:canonical 目录正常不含链接,
/// 但用户手工摆一个自指链接(fsops 的自指防护处理的就是这类现场)会让
/// 跟随式遍历转圈;文件符号链接无环风险,按目标大小计入。
fn collect_files(root: &Path, prefix: &str, out: &mut Vec<LocalSkillFile>) -> Result<(), AppError> {
    let entries = std::fs::read_dir(root).map_err(|e| {
        AppError::new("FS_READ_FAILED", "读取技能内容失败,请重试").with_detail(e.to_string())
    })?;
    for entry in entries.flatten() {
        let Ok(file_name) = entry.file_name().into_string() else {
            continue;
        };
        let rel = if prefix.is_empty() {
            file_name.clone()
        } else {
            format!("{prefix}/{file_name}")
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_files(&entry.path(), &rel, out)?;
        } else if file_type.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(LocalSkillFile { path: rel, size });
        } else if file_type.is_symlink() {
            // 只认指向文件的链接;指向目录的一律不跟随(防环)
            if let Ok(meta) = std::fs::metadata(entry.path()) {
                if meta.is_file() {
                    out.push(LocalSkillFile { path: rel, size: meta.len() });
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn reads_dir_with_frontmatter_subdirs_and_sizes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("weekly-report");
        write(
            &dir,
            "SKILL.md",
            "---\nname: 周报生成\ndescription: 汇总本周工作\n---\n\n正文\n",
        );
        write(&dir, "templates/dept.md", "模板内容");
        write(&dir, "scripts/collect.py", "print('x')");

        let detail = local_skill_detail(&dir).unwrap();
        assert_eq!(detail.name, "周报生成");
        assert_eq!(detail.description, "汇总本周工作");
        assert_eq!(detail.dir_slug, "weekly-report");
        assert_eq!(detail.path, dir.to_string_lossy());
        assert!(detail.skill_md.contains("周报生成"));
        // 排序稳定:SKILL.md < scripts/collect.py < templates/dept.md
        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["SKILL.md", "scripts/collect.py", "templates/dept.md"]);
        let dept = detail.files.iter().find(|f| f.path == "templates/dept.md").unwrap();
        assert_eq!(dept.size, "模板内容".len() as u64);
        assert!(detail.has_scripts);
    }

    #[test]
    fn no_scripts_when_only_docs() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("plain");
        write(&dir, "SKILL.md", "---\nname: 纯文档\ndescription: 无脚本\n---\n\n正文\n");
        write(&dir, "notes/readme.txt", "说明");
        let detail = local_skill_detail(&dir).unwrap();
        assert!(!detail.has_scripts);
    }

    #[test]
    fn broken_frontmatter_falls_back_to_dir_name() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("hand-made");
        write(&dir, "SKILL.md", "没有 frontmatter 的手搓内容\n");
        let detail = local_skill_detail(&dir).unwrap();
        assert_eq!(detail.name, "hand-made");
        assert_eq!(detail.description, "");
        assert!(detail.skill_md.contains("手搓内容"));
    }

    #[test]
    fn rejects_dir_without_skill_md() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("not-a-skill");
        write(&dir, "readme.txt", "x");
        let err = local_skill_detail(&dir).unwrap_err();
        assert_eq!(err.code, "FS_NOT_A_SKILL");
    }

    #[test]
    fn rejects_missing_path() {
        let tmp = tempfile::tempdir().unwrap();
        let err = local_skill_detail(&tmp.path().join("ghost")).unwrap_err();
        assert_eq!(err.code, "FS_NOT_A_SKILL");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_dir_symlinks_but_counts_file_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("looped");
        write(&dir, "SKILL.md", "---\nname: 环\ndescription: 环\n---\n\n正文\n");
        write(&dir, "real.txt", "12345");
        // 自指目录链接:跟随式遍历会转圈
        std::os::unix::fs::symlink(&dir, dir.join("loop")).unwrap();
        std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("alias.txt")).unwrap();

        let detail = local_skill_detail(&dir).unwrap();
        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"alias.txt"));
        assert!(!paths.iter().any(|p| p.starts_with("loop")));
        let alias = detail.files.iter().find(|f| f.path == "alias.txt").unwrap();
        assert_eq!(alias.size, 5);
    }
}
