//! 技能发现规则与上游 vercel-labs/skills 的差分测试。
//!
//! fixture 由 `node scripts/verify-skill-discovery.mjs` 生成:它把 `files` 描述的仓库布局落到真实
//! 目录,再调用上游 `discoverSkills` 记录结果。这里用同一份布局构造内存树跑我们的实现,断言一致。
//!
//! 发现规则决定"商店里显示哪些技能"。与上游不一致意味着本 app 与 `npx skills` 对同一个技能库
//! 看法不同——这是设计方案里"生态互通"的底线,所以拿上游真实执行结果当基准,而非二次解读。

use std::path::PathBuf;

use serde::Deserialize;
use skillsync_lib::core::skills::{discover_skills, DiscoverOptions, FsTree, MemTree};

const FIXTURE: &str = include_str!("fixtures/upstream-discovery.json");

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    files: std::collections::BTreeMap<String, String>,
    expected: Vec<ExpectedSkill>,
}

#[derive(Deserialize)]
struct ExpectedSkill {
    name: String,
    description: String,
    /// 相对仓库根的技能目录;根目录本身是技能时为空串。
    dir: String,
}

#[test]
fn discovery_matches_upstream() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture 可解析");
    assert!(!fixture.cases.is_empty());

    for case in &fixture.cases {
        let mut tree = MemTree::new();
        for (path, content) in &case.files {
            tree = tree.with_file(path, content);
        }

        let got = discover_skills(&tree, "", &DiscoverOptions::default());
        let got_desc: Vec<(&str, &str, &str)> = got
            .skills
            .iter()
            .map(|s| (s.name.as_str(), s.description.as_str(), s.dir.as_str()))
            .collect();
        let want_desc: Vec<(&str, &str, &str)> = case
            .expected
            .iter()
            .map(|s| (s.name.as_str(), s.description.as_str(), s.dir.as_str()))
            .collect();

        assert_eq!(
            got_desc, want_desc,
            "布局「{}」的发现结果与上游不一致",
            case.name
        );
    }
}

/// 同一套发现逻辑要在两种数据源上给出相同结果:
/// 商店页扫描的是下载下来的压缩包(内存树),分享页扫描的是本机目录(文件系统树)。
#[test]
fn filesystem_tree_agrees_with_in_memory_tree() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture 可解析");

    for (idx, case) in fixture.cases.iter().enumerate() {
        let root = temp_dir(idx);
        let _guard = CleanUp(root.clone());
        for (path, content) in &case.files {
            let full = path
                .split('/')
                .fold(root.clone(), |acc, seg| acc.join(seg));
            std::fs::create_dir_all(full.parent().expect("有父目录")).expect("建目录");
            std::fs::write(&full, content).expect("写文件");
        }

        let mut mem = MemTree::new();
        for (path, content) in &case.files {
            mem = mem.with_file(path, content);
        }

        let from_mem = discover_skills(&mem, "", &DiscoverOptions::default());
        let from_fs = discover_skills(&FsTree::new(&root), "", &DiscoverOptions::default());

        assert_eq!(
            from_fs.skills, from_mem.skills,
            "布局「{}」在文件系统与内存树上的发现结果不一致",
            case.name
        );
    }
}

fn temp_dir(idx: usize) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("skillsync-fs-{}-{idx}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录");
    dir
}

struct CleanUp(PathBuf);

impl Drop for CleanUp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
