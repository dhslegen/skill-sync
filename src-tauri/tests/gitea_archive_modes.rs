//! 对着**真实 Gitea 产物**钉住压缩包的权限位与二进制内容处理。
//!
//! `tests/fixtures/gitea-archive-modes.zip` 不是手工造的:2026-07-30 往 fixture Gitea
//! (1.25.3)push 了一个含 `100755` 脚本 + 二进制 png 的提交,再从
//! `GET /repos/{o}/{r}/archive/{branch}.zip` 下载下来,原样存进 fixture。
//!
//! 为什么必须录真的:安装要靠压缩包里的权限位决定 `run.sh` 落盘后能不能执行。
//! 按"普通文件应该是 0o644"去写判定会**全员变成可执行**——因为 Gitea 给普通文件写的是 `0`。
//! 这类事实只能观测,不能推理。

use skillsync_lib::core::gitea::unzip_archive;

const ARCHIVE: &[u8] = include_bytes!("fixtures/gitea-archive-modes.zip");

#[test]
fn gitea_records_mode_only_for_executables() {
    let archive = unzip_archive(ARCHIVE).unwrap();
    // Gitea 压缩包的顶层目录是**仓库名**(GitHub 才是 repo-ref)
    assert_eq!(archive.root, "team-skills");

    let entry = |name: &str| {
        archive
            .entries
            .get(&format!("team-skills/skills/mode-probe/{name}"))
            .unwrap_or_else(|| panic!("压缩包里没有 {name}"))
    };

    // 提交时是 100755 → Gitea 在 zip 里写了 0o755
    assert_eq!(entry("run.sh").unix_mode, Some(0o755));
    assert!(entry("run.sh").is_executable());

    // 提交时是 100644 → Gitea **什么都没写**(external_attr 高位为 0)。
    // 这正是关键:0 是"未记录",若当成 0o000 落盘,文件会连读都读不了;
    // 若拿 0o644 当基准比较,判定逻辑会写成另一个样子。
    assert_eq!(entry("SKILL.md").unix_mode, None, "普通文件不该带权限位");
    assert!(!entry("SKILL.md").is_executable());
    assert_eq!(entry("logo.png").unix_mode, None);
    assert!(!entry("logo.png").is_executable());
}

#[test]
fn binary_files_carry_bytes_even_though_they_stay_out_of_the_text_tree() {
    use skillsync_lib::core::skills::SkillTree;
    let archive = unzip_archive(ARCHIVE).unwrap();
    let png = "team-skills/skills/mode-probe/logo.png";

    // 展示用的文本树里没有二进制文件(既定行为)
    assert!(!archive.tree.is_file(png));
    // 但安装要的字节必须在,否则带图片的技能会被装成残缺品
    let bytes = &archive.entries.get(png).unwrap().bytes;
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "png 头字节应原样保留");
    // 路径清单同时也含它(文件树展示用)
    assert!(archive.files.contains(&png.to_string()));
}

#[test]
fn text_files_appear_in_both_the_tree_and_the_byte_entries() {
    use skillsync_lib::core::skills::SkillTree;
    let archive = unzip_archive(ARCHIVE).unwrap();
    let md = "team-skills/skills/mode-probe/SKILL.md";

    let text = archive.tree.read_file(md).unwrap();
    let bytes = &archive.entries.get(md).unwrap().bytes;
    // 两条路径必须给出同一份内容:展示走 tree、落盘走 entries,不一致就会"看到的和装上的不同"
    assert_eq!(text.as_bytes(), bytes.as_slice());
    assert!(text.contains("mode-probe"));
}

/// `filter(|m| *m != 0)` 那道守卫防的是什么。
///
/// Gitea 对普通文件根本不写 unix 属性,zip crate 直接给 `None`,所以那道 filter 在
/// Gitea 的产物上**永远不触发**——注入验证时把它删掉,上面几条测试全绿。
/// 但别的服务(或别的打包器)完全可能写一个 `mode=0` 出来,那时若原样采信,
/// 文件会以 `0o000` 落盘,连读都读不了。这里手工造出那种输入,把守卫钉在可达的路径上。
#[test]
fn a_zero_mode_entry_is_treated_as_unspecified_not_as_000() {
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::SimpleFileOptions =
            zip::write::SimpleFileOptions::default().unix_permissions(0);
        w.start_file("r/skills/a/SKILL.md", opts).unwrap();
        std::io::Write::write_all(&mut w, b"---\nname: a\ndescription: d\n---\n").unwrap();
        w.finish().unwrap();
    }

    let archive = unzip_archive(&buf).unwrap();
    let entry = archive.entries.get("r/skills/a/SKILL.md").unwrap();
    assert_eq!(entry.unix_mode, None, "mode=0 是「没说」,不是「谁都不许读」");
    assert!(!entry.is_executable());
}
