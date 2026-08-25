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
/// (`AgentRegistry::canonical_global_dir`)再 `.join(技能名)` 拼出本体路径,
/// 或者干脆把本体 `copy_tree` 一份过去。
///
/// v6 二期任务 6 之前 `core/share.rs` 里就有这两种写法(收编那一段与
/// `share_installed`),上一条守卫**一个字都看不见**——它只挡直呼 `canonical_dir(`。
/// 新模型下本体完全可能住在 `~/.claude/skills/`,拿 canonical 拼出来的路径要么
/// 根本不存在(于是对用户说"内容已不存在",假话)、要么是一条链接(读出来仍是
/// 本体,只是绕一圈还多一处没人守的解析点)。
///
/// # 🔴 它是烟雾报警,不是防火墙(修复轮 1 订正,R25)
///
/// **这是文本匹配,挡不住变量改名,也挡不住把路径拼在一句表达式里。**
/// 复审者实测:把 `ensure_canonical_link` 换成
/// `canon_root.join(&home.dir_name)` + `copy_tree`——**正是"退回复制"这个坏实现**
/// ——本文件两条守卫**全绿**。所以:
///
/// - **真正拦住"退回复制"的是行为侧那条断言**:`tests/share_flow.rs::
///   share_uploads_the_body_in_place_and_links_canonical_without_copying` 里的
///   `fsops::read_link_target(canonical/<name>) == Some(normalize(body))`。
///   它比的是"canonical 上到底是不是一条指向本体的链接",复制过去一份就是 `None`,
///   变量叫什么、路径怎么拼都逃不掉。**改动这条链路时,那条断言才是护栏。**
/// - 本守卫的价值只在于**早一步**:形状最常见的那几种绕法在编辑时就报,
///   而且报错里直接把源码那一行打出来,比读一条 `None != Some(...)` 快。
///
/// 下面的模式**刻意放宽到"名字里带 canon/root 的变量 + `.join(`"以及
/// `share.rs` 里出现 `copy_tree`**(分享链路按定义不复制本体),但**不要**
/// 因此以为它 airtight,也**不要**在文档里那么写——本项目为"注释说谎"打回过三次。
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
        for (n, line) in code.lines().enumerate() {
            // 形状一:名字里带 canon / root 的变量身上调 `.join(`
            if let Some(at) = line.find(".join(") {
                let head = &line[..at];
                let ident: String = head
                    .chars()
                    .rev()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                let lowered = ident.to_ascii_lowercase();
                assert!(
                    !(lowered.contains("canon") || lowered.contains("root")),
                    "{f}:{} 不得从 canonical 根拼出技能本体路径,走 converge::home_of:\n  {}",
                    n + 1,
                    line.trim()
                );
            }
            // 形状二:分享链路按定义不复制本体(旧的「收编」就是 copy_tree + 换链接)
            assert!(
                !(f == "core/share.rs" && line.contains("copy_tree")),
                "{f}:{} 分享不复制本体——本体住原地,canonical 只放链接:\n  {}",
                n + 1,
                line.trim()
            );
        }
    }
}
