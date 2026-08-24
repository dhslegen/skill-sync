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

#[test]
fn body_path_is_resolved_in_exactly_one_layer() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let forbidden = [
        "core/acquire.rs",
        "core/remove.rs",
        "core/share.rs",
        "core/scheduler.rs",
        "core/my_skills.rs",
        "core/create.rs",
        "core/local_detail.rs",
        "commands.rs",
    ];
    for f in forbidden {
        let path = root.join(f);
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()));
        let code = strip_comments(&src);
        assert!(
            !code.contains("canonical_dir("),
            "{f} 不得自行解析本体路径,走 converge::home_of / installer.home"
        );
    }
}
