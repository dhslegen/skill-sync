//! 文件系统操作统一入口(架构铁律 3)。
//!
//! 含 symlink→junction→copy 降级链、realpath 防环;禁止在其他模块直接调用 std::fs 链接 API。

use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 链接实现方式。与 `state.json` 的 `linkMode` 字段一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Symlink,
    Junction,
    Copy,
}

impl LinkKind {
    /// `state.json` 与 IPC 里的取值。
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Symlink => "symlink",
            LinkKind::Junction => "junction",
            LinkKind::Copy => "copy",
        }
    }
}

/// 本平台的降级链。
///
/// 假设(文档未覆盖,取 C11 与上游 installer.ts:255 的一致结论):**Windows 不试 symlink**。
/// `symlink_dir` 需开发者模式或管理员权限,在目标机器上大概率失败;junction 免提权且上游正是这么做的。
/// 铁律 3 写的"symlink→junction→copy"描述的是本模块的能力集合,不是 Windows 上的尝试顺序。
pub fn default_link_chain() -> &'static [LinkKind] {
    #[cfg(windows)]
    {
        &[LinkKind::Junction, LinkKind::Copy]
    }
    #[cfg(not(windows))]
    {
        &[LinkKind::Symlink, LinkKind::Copy]
    }
}

/// 建链结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkOutcome {
    /// 新建了链接(或降级复制)。
    Created(LinkKind),
    /// 已存在且指向正确目标,未做任何改动。
    Unchanged(LinkKind),
    /// 链接位置与目标本就是同一处磁盘位置(agent 目录整体是指向 canonical 的软链),无需建链。
    SameLocation,
}

/// 链接位置已被**实体目录**占用时的处置方式。
///
/// 铁律 7:破坏性操作需前端确认结果作为参数传入,所以默认是 [`OnOccupied::Fail`],
/// 由上层拿到用户确认后才传 [`OnOccupied::Replace`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnOccupied {
    Fail,
    Replace,
}

/// 把 `target` 目录链接到 `link` 位置,按 `chain` 逐级降级。
pub fn link_dir(
    target: &Path,
    link: &Path,
    chain: &[LinkKind],
    on_occupied: OnOccupied,
) -> Result<LinkOutcome, AppError> {
    let want = normalize(target);

    let existing_link = read_link_target(link);

    // 已是指向本目标的链接:原样保留,并把方式回报给调用方记账。
    if existing_link.as_ref() == Some(&want) {
        return Ok(LinkOutcome::Unchanged(
            link_kind_at(link).unwrap_or(LinkKind::Symlink),
        ));
    }

    // 必须先于一切删除动作:两者是同一处磁盘位置时,"先清链接位置再建链"删掉的就是技能本体。
    if same_physical_path(target, link) {
        return Ok(LinkOutcome::SameLocation);
    }

    if existing_link.is_some() {
        unlink(link)?;
    } else if std::fs::symlink_metadata(link).is_ok() {
        // 实体目录/文件占位:可能是用户自己写的技能,或上一次降级复制留下的副本。
        // 两者在磁盘上无从区分,故是否清除必须由上层带着用户确认结果决定。
        if on_occupied == OnOccupied::Fail {
            return Err(AppError::new(
                "FS_LINK_OCCUPIED",
                "该工具的技能目录下已有同名技能,请先确认是否覆盖",
            )
            .with_detail(format!("occupied: {}", link.display())));
        }
        remove_occupant(link)?;
    }

    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| link_failed(link, &e.to_string()))?;
    }

    let mut last: Option<String> = None;
    for kind in chain {
        match create_link(*kind, target, link) {
            Ok(()) => return Ok(LinkOutcome::Created(*kind)),
            Err(e) => last = Some(format!("{kind:?}: {e}")),
        }
    }
    Err(link_failed(link, last.as_deref().unwrap_or("降级链为空")))
}

/// 读取链接指向的目标(symlink 或 junction),解析为绝对路径;不是链接则返回 `None`。
///
/// 只做词法解析(相对目标按链接所在目录展开),**不做 realpath**——调用方要比对的是
/// "这条链是不是指向我们写的那个 canonical 路径",一旦沿途解析真实路径,
/// 家目录本身是软链的机器上就会比出"不相等"的假阴性。
pub fn read_link_target(link: &Path) -> Option<PathBuf> {
    match link_kind_at(link)? {
        LinkKind::Symlink => {
            let raw = std::fs::read_link(link).ok()?;
            Some(if raw.is_absolute() {
                normalize(&raw)
            } else {
                normalize(&link.parent()?.join(raw))
            })
        }
        #[cfg(windows)]
        LinkKind::Junction => junction::get_target(link).ok().map(|p| normalize(&p)),
        _ => None,
    }
}

/// 判断某路径上的链接类型;不是链接(实体目录/文件/不存在)返回 `None`。
fn link_kind_at(path: &Path) -> Option<LinkKind> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() {
        return Some(LinkKind::Symlink);
    }
    #[cfg(windows)]
    if meta.is_dir() && junction::exists(path).unwrap_or(false) {
        return Some(LinkKind::Junction);
    }
    None
}

/// 某个链接位置相对于期望目标的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    /// 该位置什么都没有。
    Missing,
    /// 是指向期望目标的链接,且目标健在。
    Linked(LinkKind),
    /// 是指向期望目标的链接,但目标已不在——本 app 留下的断链,可安全清理。
    Broken,
    /// 是链接,但指向别处(用户手工改过)。
    Foreign(PathBuf),
    /// 是实体目录或文件,与本 app 无关。
    Real,
    /// 与期望目标本就是同一处磁盘位置。
    SameLocation,
}

/// 判定链接位置的健康状态。卸载前据此决定"能不能动"。
pub fn link_state(link: &Path, expected_target: &Path) -> LinkState {
    let want = normalize(expected_target);
    match read_link_target(link) {
        Some(actual) if actual == want => {
            if link.exists() {
                LinkState::Linked(link_kind_at(link).unwrap_or(LinkKind::Symlink))
            } else {
                LinkState::Broken
            }
        }
        Some(actual) => LinkState::Foreign(actual),
        None if same_physical_path(expected_target, link) => LinkState::SameLocation,
        None if std::fs::symlink_metadata(link).is_ok() => LinkState::Real,
        None => LinkState::Missing,
    }
}

/// 摘除一条链接**本身**,绝不递归进目标目录。返回是否确有链接被摘除。
///
/// 这是"绝不静默删除用户文件"在文件系统层的落点。用 `remove_file`/`remove_dir` 这对精确操作
/// 而非 `remove_dir_all`:现行 std 的 `remove_dir_all` 确实已对软链与 reparse point 做了防护
/// (实测注入替换后目标内容依然存活),但它表达的语义是"删一棵树"——一旦哪天路径判断出错,
/// 波及面就是整个目标目录。让代码本身只具备"摘链接"的能力,是更小的攻击面。
///
/// 位置上是实体目录时直接拒绝——那可能是用户自己写的技能。
pub fn unlink_dir(link: &Path) -> Result<bool, AppError> {
    match link_kind_at(link) {
        Some(_) => unlink(link).map(|()| true),
        None if std::fs::symlink_metadata(link).is_ok() => Err(AppError::new(
            "FS_NOT_A_LINK",
            "该位置是一个实体技能目录,不会被自动删除",
        )
        .with_detail(format!("not a link: {}", link.display()))),
        None => Ok(false),
    }
}

fn unlink(link: &Path) -> Result<(), AppError> {
    let r = match link_kind_at(link) {
        Some(LinkKind::Symlink) if cfg!(windows) => std::fs::remove_dir(link),
        Some(LinkKind::Symlink) => std::fs::remove_file(link),
        Some(LinkKind::Junction) => std::fs::remove_dir(link),
        _ => return Ok(()),
    };
    r.map_err(|e| {
        AppError::new("FS_UNLINK_FAILED", "无法解除技能与该工具的关联,请重试")
            .with_detail(format!("unlink {}: {e}", link.display()))
    })
}

/// 两个路径是否落在同一处磁盘位置。
///
/// 两道判定缺一不可(对齐上游 installer.ts:205 与 :217):
/// 1. 两边都存在时直接比 realpath;
/// 2. **链接位置尚不存在**时 realpath 必然失败——而这正是真实场景:
///    `~/.claude/skills` 整体是指向 `~/.agents/skills` 的软链,`~/.claude/skills/周报` 还没建出来。
///    此时要解析的是**父目录**的真实路径,再接回原 basename。只实现第 1 道会漏判,
///    进而删掉刚写好的技能本体。
fn same_physical_path(a: &Path, b: &Path) -> bool {
    if let (Ok(ra), Ok(rb)) = (a.canonicalize(), b.canonicalize()) {
        if ra == rb {
            return true;
        }
    }
    resolve_parent_symlinks(a) == resolve_parent_symlinks(b)
}

/// 解析路径**父目录**上的软链,保留最后一段。父目录不存在时退回词法归一化。
fn resolve_parent_symlinks(path: &Path) -> PathBuf {
    let normalized = normalize(path);
    let (Some(parent), Some(base)) = (normalized.parent(), normalized.file_name()) else {
        return normalized;
    };
    match parent.canonicalize() {
        Ok(real) => real.join(base),
        Err(_) => normalized,
    }
}

/// 清除占位的实体目录/文件。仅在调用方明确确认后才会走到这里。
fn remove_occupant(path: &Path) -> Result<(), AppError> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| link_failed(path, &e.to_string()))?;
    let r = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    r.map_err(|e| {
        AppError::new("FS_REPLACE_FAILED", "无法清理该工具目录下的同名技能,请重试")
            .with_detail(format!("replace {}: {e}", path.display()))
    })
}

fn create_link(kind: LinkKind, target: &Path, link: &Path) -> std::io::Result<()> {
    match kind {
        LinkKind::Symlink => {
            // 相对目标(对齐上游 installer.ts:254):家目录整体搬迁或被映射到别的盘符时链接依然成立。
            let from = link.parent().unwrap_or(link);
            let rel = relative_from(&normalize(from), &normalize(target));
            #[cfg(windows)]
            {
                std::os::windows::fs::symlink_dir(rel, link)
            }
            #[cfg(not(windows))]
            {
                std::os::unix::fs::symlink(rel, link)
            }
        }
        LinkKind::Junction => {
            #[cfg(windows)]
            {
                // junction 只认绝对路径
                junction::create(normalize(target), link)
            }
            #[cfg(not(windows))]
            {
                let _ = (target, link);
                Err(std::io::Error::other("junction 仅 Windows 可用"))
            }
        }
        LinkKind::Copy => copy_dir(target, link),
    }
}

fn link_failed(link: &Path, detail: &str) -> AppError {
    AppError::new("FS_LINK_FAILED", "无法把技能关联到该工具的目录,请重试")
        .with_detail(format!("link {}: {detail}", link.display()))
}

/// 词法归一化:消掉 `.` 与 `..`,不访问文件系统。
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 计算 `to` 相对 `from` 的路径(两者均须已归一化)。
fn relative_from(from: &Path, to: &Path) -> PathBuf {
    let mut a = from.components().peekable();
    let mut b = to.components().peekable();
    while a.peek().is_some() && a.peek() == b.peek() {
        a.next();
        b.next();
    }
    let mut out = PathBuf::new();
    for _ in a {
        out.push("..");
    }
    out.extend(b);
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

/// 清空并重建一个目录。
///
/// 位置上若是链接,只摘链接再新建实体目录——递归删会顺着链接把目标内容一起清空。
pub fn reset_dir(dir: &Path) -> Result<(), AppError> {
    remove_tree(dir)?;
    std::fs::create_dir_all(dir).map_err(|e| {
        AppError::new("FS_MKDIR_FAILED", "无法创建技能目录,请检查磁盘空间与权限")
            .with_detail(format!("mkdir {}: {e}", dir.display()))
    })
}

/// 删除一个路径:链接只摘链接,实体目录整棵删。返回是否确有东西被删。
///
/// 调用方须自行确保这是本 app 的目录——本函数不做归属判断。
pub fn remove_tree(path: &Path) -> Result<bool, AppError> {
    if link_kind_at(path).is_some() {
        return unlink(path).map(|()| true);
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(false);
    };
    let r = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    r.map(|()| true).map_err(|e| {
        AppError::new("FS_REMOVE_FAILED", "无法清理技能目录,请重试")
            .with_detail(format!("remove {}: {e}", path.display()))
    })
}

/// 把一段相对路径安全地接到 `base` 之下,任何越界(`..`、绝对路径)都拒绝。
///
/// 技能内容来自技能库压缩包,属不可信输入:zip 里带 `../` 的条目能把文件写到目标目录之外。
pub fn safe_join(base: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let unsafe_path = || {
        AppError::new("FS_UNSAFE_PATH", "技能内容包含非法的文件路径,已中止安装")
            .with_detail(format!("unsafe entry: {relative}"))
    };
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(unsafe_path());
    }
    let joined = normalize(&base.join(rel));
    if !joined.starts_with(normalize(base)) || joined == normalize(base) {
        return Err(unsafe_path());
    }
    Ok(joined)
}

/// 写入一个文件,按需补齐父目录并设置 unix 权限位。
pub fn write_file(path: &Path, bytes: &[u8], unix_mode: Option<u32>) -> Result<(), AppError> {
    let write_failed = |e: std::io::Error| {
        AppError::new("FS_WRITE_FAILED", "写入技能文件失败,请检查磁盘空间与权限")
            .with_detail(format!("write {}: {e}", path.display()))
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(write_failed)?;
    }
    std::fs::write(path, bytes).map_err(write_failed)?;
    #[cfg(unix)]
    if let Some(mode) = unix_mode {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(write_failed)?;
    }
    #[cfg(not(unix))]
    let _ = unix_mode;
    Ok(())
}

/// 计算目录内容的 sha256,用于判断用户是否改过技能本体。
///
/// 路径与内容都参与:改内容、改文件名、增删文件都会让结果变化。
/// **排除清单必须与 [`copy_dir`] 完全一致**——装进来的目录本就没有被排除的那些条目,
/// 若此处口径更宽,一装完就会被判成"用户改过",更新流程会永远停在冲突提示上。
pub fn dir_content_hash(dir: &Path) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};

    let mut files = Vec::new();
    collect_files(dir, dir, &mut files).map_err(|e| {
        AppError::new("FS_HASH_FAILED", "无法读取技能目录内容,请重试")
            .with_detail(format!("hash {}: {e}", dir.display()))
    })?;
    // 文件系统不保证枚举顺序,排序后 hash 才可复现
    files.sort();

    let mut hasher = Sha256::new();
    for rel in &files {
        let bytes = std::fs::read(dir.join(rel)).map_err(|e| {
            AppError::new("FS_HASH_FAILED", "无法读取技能目录内容,请重试")
                .with_detail(format!("hash {}: {e}", rel.display()))
        })?;
        // 路径与长度都进 hash:否则把 a.md 的内容挪进 b.md 后 hash 不变,
        // 相邻文件内容首尾相接也会撞成同一个值。
        let rel = rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR_STR, "/");
        hasher.update((rel.len() as u64).to_le_bytes());
        hasher.update(rel.as_bytes());
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(7 + digest.len() * 2);
    hex.push_str("sha256:");
    for b in digest {
        use std::fmt::Write;
        let _ = write!(hex, "{b:02x}");
    }
    Ok(hex)
}

/// 收集目录下全部文件的相对路径,排除清单与 [`copy_dir`] 共用同一套判定。
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if EXCLUDE_FILES.contains(&name.as_ref()) {
            continue;
        }
        let path = entry.path();
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            // 与 copy_dir 一致:坏软链跳过。复制时它进不来,算 hash 时也不该算进去。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        if meta.is_dir() {
            if EXCLUDE_DIRS.contains(&name.as_ref()) {
                continue;
            }
            collect_files(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

/// 复制时排除的条目(上游 installer.ts:423)。`metadata.json` 是上游安装器自己的记账文件,
/// 目录三项则是绝不该随技能分发的构建/版本控制产物。
const EXCLUDE_FILES: &[&str] = &["metadata.json"];
const EXCLUDE_DIRS: &[&str] = &[".git", "__pycache__", "__pypackages__"];

/// 递归复制目录。
///
/// 与上游 `copyDirectory` 对齐的三处语义:
/// - 排除清单同上;
/// - **解引用软链**(上游 `dereference: true`):技能里的软链多半指向原机器上的路径,原样复制过来就是断链;
/// - 坏软链跳过而非中断:一个失效链接不该让整个技能装不上。
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if EXCLUDE_FILES.contains(&name.as_ref()) {
            continue;
        }
        let from = entry.path();
        // 用 metadata 而非 file_type:前者跟随软链,后者对软链恒为 is_symlink。
        let meta = match std::fs::metadata(&from) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let to = dst.join(entry.file_name());
        if meta.is_dir() {
            if EXCLUDE_DIRS.contains(&name.as_ref()) {
                continue;
            }
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 造一个内含 SKILL.md 的技能目录。
    fn skill_dir(root: &Path, name: &str, body: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), body).unwrap();
        dir
    }

    #[test]
    fn default_chain_puts_platform_native_link_first_and_copy_last() {
        let chain = default_link_chain();
        assert_eq!(*chain.last().unwrap(), LinkKind::Copy, "兜底必须是复制");
        #[cfg(windows)]
        assert_eq!(chain, [LinkKind::Junction, LinkKind::Copy]);
        #[cfg(not(windows))]
        assert_eq!(chain, [LinkKind::Symlink, LinkKind::Copy]);
    }

    #[test]
    fn links_target_dir_and_content_is_readable_through_link() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "内容甲");
        let link = tmp.path().join("agent").join("周报");

        let outcome = link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        // Windows 上必须落在 junction:C11 记录首台机器 symlink 成功疑为管理员提权造成的假阳性,
        // 而 CI runner 恰恰可能带着足以创建 symlink 的权限,从而复现同一个假阳性。
        // 断言"是 junction 而不是 symlink",普通员工机器上的真实路径才被真的验到。
        #[cfg(windows)]
        assert_eq!(outcome, LinkOutcome::Created(LinkKind::Junction));
        #[cfg(not(windows))]
        assert_eq!(outcome, LinkOutcome::Created(LinkKind::Symlink));
        assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), "内容甲");
        assert_eq!(read_link_target(&link).unwrap(), target);
    }

    #[test]
    fn relinking_same_target_changes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "内容甲");
        let link = tmp.path().join("agent").join("周报");
        link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        let again = link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        assert!(matches!(again, LinkOutcome::Unchanged(_)));
        assert_eq!(read_link_target(&link).unwrap(), target);
    }

    #[test]
    fn real_dir_at_link_path_is_never_silently_destroyed() {
        // 用户自己在 ~/.claude/skills/周报 手写了技能。上游此处直接 rm 覆盖;
        // 铁律 7 要求先让前端拿到确认结果,故默认失败而非覆盖。
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "团队版");
        let link = skill_dir(&tmp.path().join("agent"), "周报", "我自己写的");

        let err = link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap_err();

        assert_eq!(err.code, "FS_LINK_OCCUPIED");
        assert_eq!(
            fs::read_to_string(link.join("SKILL.md")).unwrap(),
            "我自己写的"
        );
    }

    #[test]
    fn real_dir_at_link_path_is_replaced_only_when_caller_confirms() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "团队版");
        let link = skill_dir(&tmp.path().join("agent"), "周报", "我自己写的");

        link_dir(&target, &link, default_link_chain(), OnOccupied::Replace).unwrap();

        assert_eq!(read_link_target(&link).unwrap(), target);
        assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), "团队版");
    }

    #[test]
    fn falls_back_to_copy_when_preferred_kind_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "内容甲");
        fs::write(target.join("run.sh"), "echo hi").unwrap();
        let link = tmp.path().join("agent").join("周报");
        // junction 在非 Windows 上必失败,是一条天然的"首选方式不可用"注入
        let chain = [LinkKind::Junction, LinkKind::Copy];

        let outcome = link_dir(&target, &link, &chain, OnOccupied::Fail).unwrap();

        #[cfg(not(windows))]
        {
            assert_eq!(outcome, LinkOutcome::Created(LinkKind::Copy));
            assert!(read_link_target(&link).is_none(), "复制出来的不是链接");
        }
        #[cfg(windows)]
        assert_eq!(outcome, LinkOutcome::Created(LinkKind::Junction));
        assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), "内容甲");
        assert_eq!(fs::read_to_string(link.join("run.sh")).unwrap(), "echo hi");
    }

    #[test]
    #[cfg(not(windows))]
    fn whole_chain_failing_reports_link_error() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "内容甲");
        let link = tmp.path().join("agent").join("周报");

        let err = link_dir(&target, &link, &[LinkKind::Junction], OnOccupied::Fail).unwrap_err();

        assert_eq!(err.code, "FS_LINK_FAILED");
        assert!(!link.exists());
    }

    #[test]
    #[cfg(unix)]
    fn same_location_is_detected_even_before_the_target_exists() {
        // 两边都还不存在时 realpath 必然失败,只能靠解析**父目录**来判定同一位置。
        // 漏判的后果不是报错而是更隐蔽的:会在 canonical 目录里造出一条指向自己的软链(ELOOP)。
        let tmp = tempfile::tempdir().unwrap();
        let canonical_base = tmp.path().join(".agents").join("skills");
        fs::create_dir_all(&canonical_base).unwrap();
        let agent_base = tmp.path().join(".claude").join("skills");
        fs::create_dir_all(agent_base.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&canonical_base, &agent_base).unwrap();
        // 技能本体尚未落盘
        let target = canonical_base.join("周报");
        let link = agent_base.join("周报");

        let outcome = link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        assert_eq!(outcome, LinkOutcome::SameLocation);
        assert!(
            std::fs::symlink_metadata(&target).is_err(),
            "不得在 canonical 目录里留下自指软链"
        );
    }

    #[test]
    #[cfg(unix)]
    fn link_and_target_resolving_to_same_place_is_a_no_op() {
        // agent 目录整体是一条指向 canonical 目录的软链(~/.claude/skills -> ~/.agents/skills)。
        // 此时 link 与 target 物理同一,建链会先删 link——那删掉的正是刚写好的技能本体。
        let tmp = tempfile::tempdir().unwrap();
        let canonical_base = tmp.path().join(".agents").join("skills");
        fs::create_dir_all(&canonical_base).unwrap();
        let target = skill_dir(&canonical_base, "周报", "本体");
        let agent_base = tmp.path().join(".claude").join("skills");
        fs::create_dir_all(agent_base.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&canonical_base, &agent_base).unwrap();
        let link = agent_base.join("周报");

        let outcome = link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        assert_eq!(outcome, LinkOutcome::SameLocation);
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "本体");
    }

    // ---- 解链 ----

    #[test]
    fn unlinking_removes_only_the_link_and_target_survives() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "本体");
        let link = tmp.path().join("agent").join("周报");
        link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        assert!(unlink_dir(&link).unwrap());

        assert!(!link.exists() && read_link_target(&link).is_none());
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "本体");
    }

    #[test]
    fn unlinking_a_real_directory_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let real = skill_dir(tmp.path(), "我自己写的", "别删我");

        let err = unlink_dir(&real).unwrap_err();

        assert_eq!(err.code, "FS_NOT_A_LINK");
        assert_eq!(fs::read_to_string(real.join("SKILL.md")).unwrap(), "别删我");
    }

    #[test]
    fn unlinking_a_missing_path_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!unlink_dir(&tmp.path().join("不存在")).unwrap());
    }

    #[test]
    fn broken_link_can_still_be_cleaned_up() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "本体");
        let link = tmp.path().join("agent").join("周报");
        link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();
        fs::remove_dir_all(&target).unwrap();

        assert!(unlink_dir(&link).unwrap());
        assert!(std::fs::symlink_metadata(&link).is_err());
    }

    #[test]
    fn resetting_a_dir_that_is_a_link_unlinks_it_and_spares_the_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "本体");
        let link = tmp.path().join("agent").join("周报");
        link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        reset_dir(&link).unwrap();

        assert!(link.is_dir() && read_link_target(&link).is_none());
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "本体");
    }

    #[test]
    fn resetting_a_dir_empties_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(tmp.path(), "canonical", "旧内容");

        reset_dir(&dir).unwrap();

        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn removing_a_tree_that_is_a_link_spares_the_target() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "本体");
        let link = tmp.path().join("agent").join("周报");
        link_dir(&target, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        assert!(remove_tree(&link).unwrap());

        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(fs::read_to_string(target.join("SKILL.md")).unwrap(), "本体");
        assert!(!remove_tree(&tmp.path().join("不存在")).unwrap());
    }

    // ---- 链接健康态 ----

    #[test]
    fn link_state_distinguishes_ours_foreign_broken_and_real() {
        let tmp = tempfile::tempdir().unwrap();
        let target = skill_dir(tmp.path(), "canonical", "本体");
        let other = skill_dir(tmp.path(), "别处", "别人的");

        assert_eq!(
            link_state(&tmp.path().join("没有"), &target),
            LinkState::Missing
        );

        let ours = tmp.path().join("a").join("周报");
        link_dir(&target, &ours, default_link_chain(), OnOccupied::Fail).unwrap();
        assert!(matches!(link_state(&ours, &target), LinkState::Linked(_)));

        let foreign = tmp.path().join("b").join("周报");
        link_dir(&other, &foreign, default_link_chain(), OnOccupied::Fail).unwrap();
        assert_eq!(
            link_state(&foreign, &target),
            LinkState::Foreign(normalize(&other))
        );

        let real = skill_dir(&tmp.path().join("c"), "周报", "手写的");
        assert_eq!(link_state(&real, &target), LinkState::Real);

        fs::remove_dir_all(&target).unwrap();
        assert_eq!(link_state(&ours, &target), LinkState::Broken);
    }

    // ---- 内容 hash ----

    #[test]
    fn content_hash_is_stable_for_identical_content() {
        let tmp = tempfile::tempdir().unwrap();
        let a = skill_dir(tmp.path(), "a", "正文");
        fs::write(a.join("b.md"), "另一个文件").unwrap();
        let b = skill_dir(tmp.path(), "b", "正文");
        fs::write(b.join("b.md"), "另一个文件").unwrap();

        assert_eq!(dir_content_hash(&a).unwrap(), dir_content_hash(&b).unwrap());
    }

    #[test]
    fn content_hash_changes_when_anything_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(tmp.path(), "s", "正文");
        let base = dir_content_hash(&dir).unwrap();

        fs::write(dir.join("SKILL.md"), "改过的正文").unwrap();
        let changed_content = dir_content_hash(&dir).unwrap();
        assert_ne!(base, changed_content, "改内容应改变 hash");

        fs::rename(dir.join("SKILL.md"), dir.join("别的名字.md")).unwrap();
        let renamed = dir_content_hash(&dir).unwrap();
        assert_ne!(changed_content, renamed, "改文件名应改变 hash");

        fs::write(dir.join("新增.md"), "新增").unwrap();
        assert_ne!(renamed, dir_content_hash(&dir).unwrap(), "增文件应改变 hash");
    }

    #[test]
    fn content_hash_covers_nested_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_dir(tmp.path(), "s", "正文");
        fs::create_dir_all(dir.join("模板")).unwrap();
        fs::write(dir.join("模板").join("t.md"), "模板").unwrap();
        let base = dir_content_hash(&dir).unwrap();

        fs::write(dir.join("模板").join("t.md"), "改过的模板").unwrap();

        assert_ne!(base, dir_content_hash(&dir).unwrap());
    }

    #[test]
    fn content_hash_ignores_exactly_what_copying_ignores() {
        // 口径不一致的后果:技能一装完就被判成"用户改过",更新会永远卡在冲突提示。
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join(".git")).unwrap();
        fs::create_dir_all(src.join("__pycache__")).unwrap();
        fs::write(src.join("SKILL.md"), "正文").unwrap();
        fs::write(src.join("metadata.json"), "{}").unwrap();
        fs::write(src.join(".git").join("HEAD"), "ref").unwrap();
        fs::write(src.join("__pycache__").join("x.pyc"), "x").unwrap();
        let dst = tmp.path().join("dst");
        copy_dir(&src, &dst).unwrap();

        assert_eq!(
            dir_content_hash(&src).unwrap(),
            dir_content_hash(&dst).unwrap(),
            "复制出来的副本必须与源同 hash,否则装完立刻被判成被改过"
        );
    }

    #[test]
    fn missing_directory_is_an_error_not_a_silent_empty_hash() {
        // 静默返回"空目录的 hash"会让"技能被整个删掉"看起来像"没有改动"。
        let tmp = tempfile::tempdir().unwrap();
        let err = dir_content_hash(&tmp.path().join("不存在")).unwrap_err();
        assert_eq!(err.code, "FS_HASH_FAILED");
    }

    // ---- 复制 ----

    #[test]
    fn copying_skips_upstream_excluded_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join(".git")).unwrap();
        fs::create_dir_all(src.join("__pycache__")).unwrap();
        fs::write(src.join("SKILL.md"), "正文").unwrap();
        fs::write(src.join("metadata.json"), "{}").unwrap();
        fs::write(src.join(".git").join("HEAD"), "ref").unwrap();
        let dst = tmp.path().join("dst");

        copy_dir(&src, &dst).unwrap();

        assert!(dst.join("SKILL.md").exists());
        assert!(!dst.join("metadata.json").exists());
        assert!(!dst.join(".git").exists());
        assert!(!dst.join("__pycache__").exists());
    }

    #[test]
    #[cfg(unix)]
    fn copying_preserves_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let script = src.join("run.sh");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let dst = tmp.path().join("dst");

        copy_dir(&src, &dst).unwrap();

        let mode = fs::metadata(dst.join("run.sh")).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "可执行位必须保留,否则脚本类技能失效");
    }

    #[test]
    #[cfg(unix)]
    fn copying_skips_broken_symlinks_instead_of_aborting() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "正文").unwrap();
        std::os::unix::fs::symlink("/绝对不存在的路径", src.join("坏链")).unwrap();
        let dst = tmp.path().join("dst");

        copy_dir(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "正文");
        assert!(!dst.join("坏链").exists());
    }

    #[test]
    #[cfg(unix)]
    fn copying_dereferences_symlinked_subdirectories() {
        let tmp = tempfile::tempdir().unwrap();
        let real = skill_dir(tmp.path(), "真目录", "内容");
        let src = tmp.path().join("src");
        fs::create_dir_all(&src).unwrap();
        std::os::unix::fs::symlink(&real, src.join("子目录")).unwrap();
        let dst = tmp.path().join("dst");

        copy_dir(&src, &dst).unwrap();

        assert!(!dst.join("子目录").is_symlink());
        assert_eq!(
            fs::read_to_string(dst.join("子目录").join("SKILL.md")).unwrap(),
            "内容"
        );
    }

    #[test]
    fn relinking_to_new_target_replaces_link_without_touching_old_target() {
        let tmp = tempfile::tempdir().unwrap();
        let old = skill_dir(tmp.path(), "旧", "旧内容");
        let new = skill_dir(tmp.path(), "新", "新内容");
        let link = tmp.path().join("agent").join("周报");
        link_dir(&old, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        link_dir(&new, &link, default_link_chain(), OnOccupied::Fail).unwrap();

        assert_eq!(read_link_target(&link).unwrap(), new);
        assert_eq!(fs::read_to_string(link.join("SKILL.md")).unwrap(), "新内容");
        // 换链不得动到旧目标的内容
        assert_eq!(fs::read_to_string(old.join("SKILL.md")).unwrap(), "旧内容");
    }
}
