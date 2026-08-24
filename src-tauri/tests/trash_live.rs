//! 对**真实操作系统废纸篓**跑通 `SystemTrash`(v6 二期任务 1 的 DoD)。
//!
//! `SandboxTrash` 只在临时目录内部模拟"移动",验证的是 `trash_tree` 的编排逻辑
//! (链接摘链接、实体目录进篓);真正调没调得动系统废纸篓 API(macOS Finder /
//! Windows 回收站 / Linux XDG trash),只有对着真实文件系统跑一次才知道。
//!
//! 默认跳过:`SKILLSYNC_TRASH_LIVE=1 cargo test --test trash_live -- --nocapture`
//! 手动跑。门控写法与既有 live 测试(`plaza_live.rs` 等)一致——专属环境变量、
//! 未设时 `eprintln!` 说明并直接返回,不 `panic`、不算失败。
//!
//! 在 `$HOME` 下建临时目录而不是系统临时目录:废纸篓的实现在有些平台上是
//! "同一个卷/挂载点内移动",系统临时目录(如 macOS 的 `/var/folders/...`,
//! 可能是不同的 tmpfs 挂载)不一定能代表用户真实会遇到的场景
//! (技能目录本来就落在 `$HOME/.agents/skills` 下)。

use std::path::Path;

use skillsync_lib::core::fsops::{Trasher, SYSTEM_TRASH};

fn live_enabled() -> bool {
    if std::env::var("SKILLSYNC_TRASH_LIVE").as_deref() == Ok("1") {
        true
    } else {
        eprintln!("跳过:设 SKILLSYNC_TRASH_LIVE=1 才对真实系统废纸篓跑");
        false
    }
}

#[test]
fn moves_a_real_directory_into_the_system_trash() {
    if !live_enabled() {
        return;
    }
    let home = dirs::home_dir().expect("取不到 HOME,无法跑这条 live 测试");
    let root = home.join(format!(".skillsync-trash-live-test-{}", std::process::id()));
    let target = root.join("废纸篓测试技能");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("SKILL.md"), "临时测试内容,可安全丢弃").unwrap();

    let result = SYSTEM_TRASH.trash(&target);

    // 无论成功与否都先清理 root 目录,不给用户 HOME 下留垃圾。
    let cleanup = |p: &Path| {
        if p.exists() {
            let _ = std::fs::remove_dir_all(p);
        }
    };

    match &result {
        Ok(()) => {
            assert!(std::fs::symlink_metadata(&target).is_err(), "原位应当已消失");
            eprintln!("[live] {} 已移进系统废纸篓", target.display());
        }
        Err(e) => {
            eprintln!("[live] SystemTrash::trash 失败: {} ({:?})", e.message, e.detail);
        }
    }

    cleanup(&root);
    result.expect("真实系统废纸篓调用失败,详情见上面的 eprintln");
}
