//! 文本级守卫(v6 二期任务 2):本体路径的解析只许发生在 `installer.rs` /
//! `converge.rs` 这一层,别处一律走 `converge::home_of`(或已经拿到手的
//! `installer::SkillHome`)。
//!
//! `Installer::canonical_dir` 现在是模块私有方法,别的模块本来就编译不过——
//! 这条测试补的是**它之外还有一层保障**:防止将来有人在这些文件里重新拼出
//! 一套"自己算 canonical 路径"的逻辑(不经过 `canonical_dir` 这个名字,
//! 比如直接 `home.join(".agents").join("skills").join(slug)`)。它只挡得住
//! 直呼 `canonical_dir(` 这一种绕法,不是万能的,但这一种正是本任务改造前
//! 全仓唯一存在过的写法。

use std::path::Path;

/// 剥掉行注释、块注释与字符串字面量的内容(逐字符扫描,不做完整语法分析)。
/// 与 `tests/terminology.rs::strip` 同一种思路的简化版:这里不需要抽取字面量,
/// 只需要保证注释/字符串里提到 `canonical_dir(` 不会被当成真代码触发误报。
fn strip_comments(source: &str) -> String {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            '/' if bytes.get(i + 1) == Some(&'/') => {
                while i < bytes.len() && bytes[i] != '\n' {
                    i += 1;
                }
            }
            '/' if bytes.get(i + 1) == Some(&'*') => {
                let mut depth = 1;
                i += 2;
                while i < bytes.len() && depth > 0 {
                    if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if bytes[i] == '*' && bytes.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        if bytes[i] == '\n' {
                            out.push('\n');
                        }
                        i += 1;
                    }
                }
            }
            '"' => {
                i += 1;
                while i < bytes.len() && bytes[i] != '"' {
                    if bytes[i] == '\\' && i + 1 < bytes.len() {
                        i += 2;
                        continue;
                    }
                    i += 1;
                }
                i += 1; // 收尾引号
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    out
}

/// 受守卫的文件清单。两条规则(见下面两个测试)都对它们生效。
const GUARDED: [&str; 8] = [
    "core/acquire.rs",
    "core/remove.rs",
    "core/share.rs",
    "core/scheduler.rs",
    "core/my_skills.rs",
    "core/create.rs",
    "core/local_detail.rs",
    "commands.rs",
];

fn guarded_code(f: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(f);
    let src = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()));
    strip_comments(&src)
}

#[test]
fn body_path_is_resolved_in_exactly_one_layer() {
    for f in GUARDED {
        assert!(
            !guarded_code(f).contains("canonical_dir("),
            "{f} 不得自行解析本体路径,走 converge::home_of / installer.home"
        );
    }
}

/// 第二种绕法:不叫 `canonical_dir`,而是先取 canonical **根目录**
/// (`AgentRegistry::canonical_global_dir`)再 `.join(技能名)` 拼出本体路径。
///
/// v6 二期任务 6 之前 `core/share.rs` 里就有两处这种写法(收编那一段与
/// `share_installed`),上一条守卫**一个字都看不见**——它只挡直呼
/// `canonical_dir(` 那一种。新模型下本体完全可能住在 `~/.claude/skills/`,
/// 拿 canonical 拼出来的路径要么根本不存在(于是对用户说"内容已不存在",假话)、
/// 要么是一条链接(读出来仍是本体,只是绕一圈还多一处没人守的解析点)。
///
/// ⚠️ **刻意只禁 `.join(`,不禁 `canonical_global_dir(` 本身**:取 canonical
/// **根目录**是合法且必要的——`share::scan_candidates` 要枚举它下面的实体目录、
/// `commands::spawn_watcher` 要监听它、`project_pick` 的守卫要拿它做比对。
/// 一刀切禁掉那个函数会把这些正当用法一起打红,守卫就只能被放宽或删掉。
/// 残余豁免因此是:**这些文件仍可以取 canonical 根,但不许从它拼出某个技能的路径。**
#[test]
fn nobody_rebuilds_a_body_path_from_the_canonical_root() {
    for f in GUARDED {
        let code = guarded_code(f);
        for line in code.lines() {
            assert!(
                !line.contains("canonical.join("),
                "{f} 不得从 canonical 根拼出技能本体路径,走 converge::home_of:\n  {}",
                line.trim()
            );
        }
    }
}
