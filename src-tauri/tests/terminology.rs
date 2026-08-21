//! Rust 侧的术语与观感守卫(docs/terminology.md + UI 规范 §2)。
//!
//! 前端有同款守卫(src/i18n/index.test.ts),但它只扫 i18n 资源——
//! `AppError` 的 message 由 Rust 直接给出、原样弹到界面上,前端守卫看不见它。
//! 这条测试把 src/ 下所有 `AppError::new(code, message)` 的 message 抠出来过同一份禁词表。
//!
//! 提取方式是词法级的:先剥注释、收集字符串字面量,再按括号深度定位每个
//! `AppError::new(...)` 调用内的前两个字面量。不做完整语法分析——够用就好,
//! 真有解析不了的写法,测试会因"一个 message 都没提到"而失败,不会静默放过。

use std::path::{Path, PathBuf};

/// 一次调用里按出现顺序收集到的字符串字面量。
struct Extracted {
    file: PathBuf,
    line: usize,
    message: String,
}

/// 剥注释 + 抽字符串:返回(净化文本, 字面量表)。
/// 净化文本中,注释与字面量都被替换为等长占位,字面量位置用 `\u{1}<idx>\u{1}` 标记。
fn strip(source: &str) -> (String, Vec<(usize, String)>) {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut literals: Vec<(usize, String)> = Vec::new();
    let mut i = 0;
    let mut line = 1;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            '\n' => {
                line += 1;
                out.push('\n');
                i += 1;
            }
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
                            line += 1;
                            out.push('\n');
                        }
                        i += 1;
                    }
                }
            }
            '"' => {
                let start_line = line;
                let mut lit = String::new();
                i += 1;
                while i < bytes.len() && bytes[i] != '"' {
                    if bytes[i] == '\\' && i + 1 < bytes.len() {
                        lit.push(bytes[i]);
                        lit.push(bytes[i + 1]);
                        i += 2;
                        continue;
                    }
                    if bytes[i] == '\n' {
                        line += 1;
                    }
                    lit.push(bytes[i]);
                    i += 1;
                }
                i += 1; // 收尾引号
                out.push('\u{1}');
                out.push_str(&literals.len().to_string());
                out.push('\u{1}');
                literals.push((start_line, lit));
            }
            // char 字面量里可能藏引号('"'),要整个跳过;lifetime('a)不动
            '\'' => {
                let next = bytes.get(i + 1);
                let after = bytes.get(i + 2);
                if next == Some(&'\\') {
                    // '\n' / '\'' 这类:跳到收尾引号
                    out.push(' ');
                    i += 2;
                    while i < bytes.len() && bytes[i] != '\'' {
                        i += 1;
                    }
                    i += 1;
                } else if after == Some(&'\'') {
                    out.push(' ');
                    i += 3;
                } else {
                    out.push('\'');
                    i += 1;
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    (out, literals)
}

/// 从净化文本里找出每个 `AppError::new(...)` 的 message 字面量。
fn extract_messages(file: &Path, source: &str) -> Vec<Extracted> {
    let (clean, literals) = strip(source);
    let mut out = Vec::new();
    let needle = "AppError::new(";
    let mut from = 0;
    while let Some(pos) = clean[from..].find(needle) {
        let open = from + pos + needle.len() - 1;
        // 括号深度限界:只收本调用内的字面量占位符
        let mut depth = 0usize;
        let mut ids: Vec<usize> = Vec::new();
        let chars: Vec<char> = clean[open..].chars().collect();
        let mut j = 0;
        while j < chars.len() {
            match chars[j] {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                '\u{1}' => {
                    let mut num = String::new();
                    j += 1;
                    while j < chars.len() && chars[j] != '\u{1}' {
                        num.push(chars[j]);
                        j += 1;
                    }
                    // 深层的也收:message 写成 format!("模板…", …) 时,模板在更深一层,
                    // 而那正是要查的文案
                    ids.push(num.parse().unwrap());
                }
                _ => {}
            }
            j += 1;
        }
        // 第一个字面量若是错误码(全大写+下划线),message 是下一个;否则第一个就是
        let msg = match ids.first().map(|id| &literals[*id]) {
            Some((_, first)) if looks_like_code(first) => ids.get(1),
            Some(_) => ids.first(),
            None => None,
        };
        if let Some(id) = msg {
            let (line, text) = &literals[*id];
            out.push(Extracted {
                file: file.to_path_buf(),
                line: *line,
                message: text.clone(),
            });
        }
        from = open;
        from += 1;
    }
    out
}

fn looks_like_code(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

fn all_messages() -> Vec<Extracted> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut out = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        out.extend(extract_messages(&file, &text));
    }
    out
}

fn place(m: &Extracted) -> String {
    format!("{}:{}: {}", m.file.display(), m.line, m.message)
}

#[test]
fn error_messages_are_actually_extracted() {
    // 守卫的自保:提取器若因写法变化而失灵,下面几条禁词测试会变成空转。
    // gitea.rs 一个模块就有十几条 message,总数掉到个位数一定是提取器坏了。
    let messages = all_messages();
    assert!(
        messages.len() >= 20,
        "只提取到 {} 条 message,提取器大概率失灵了",
        messages.len()
    );
}

#[test]
fn error_messages_use_no_git_terminology_in_english() {
    let banned = ["commit", "push", "pull", "fetch", "branch", "repo", "repository", "clone", "merge", "token"];
    for m in all_messages() {
        let lower = m.message.to_lowercase();
        for word in banned {
            // 词边界:两侧不能是 ASCII 字母(否则 "report" 会被 "repo" 误伤)
            let mut from = 0;
            while let Some(pos) = lower[from..].find(word) {
                let at = from + pos;
                let before_ok = at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphabetic();
                let after = at + word.len();
                let after_ok = after >= lower.len() || !lower.as_bytes()[after].is_ascii_alphabetic();
                assert!(
                    !(before_ok && after_ok),
                    "用户可见的错误信息里出现 git 术语「{word}」\n  {}",
                    place(&m)
                );
                from = at + 1;
            }
        }
    }
}

#[test]
fn error_messages_use_no_git_terminology_in_chinese() {
    // 与 src/i18n/index.test.ts 同一份禁词表(docs/terminology.md)
    let banned = ["仓库", "分支", "拉取", "推送", "克隆", "合并", "代码库"];
    for m in all_messages() {
        for word in banned {
            assert!(
                !m.message.contains(word),
                "用户可见的错误信息里出现 git 术语「{word}」\n  {}",
                place(&m)
            );
        }
    }
}

#[test]
fn error_messages_contain_no_emoji() {
    // 近似 \p{Extended_Pictographic} 的主要码位区间(std 没有 Unicode 属性查询,不为此引依赖)
    let is_emoji = |c: char| {
        matches!(c,
            '\u{1F000}'..='\u{1FAFF}' | '\u{2600}'..='\u{27BF}' | '\u{2B00}'..='\u{2BFF}' | '\u{FE0F}'
        )
    };
    for m in all_messages() {
        assert!(
            !m.message.chars().any(is_emoji),
            "用户可见的错误信息里出现 emoji(UI 规范 §2 全站禁 emoji)\n  {}",
            place(&m)
        );
    }
}

#[test]
fn error_messages_are_written_in_chinese() {
    // message 面向用户,必须是中文;detail 才是给排查用的英文。
    // 拦的是"顺手把英文错误当 message"——那会把 reqwest 的原话直接糊到用户脸上。
    for m in all_messages() {
        assert!(
            m.message.chars().any(|c| ('\u{4E00}'..='\u{9FFF}').contains(&c)),
            "用户可见的错误信息不是中文\n  {}",
            place(&m)
        );
    }
}

// ============================================================ 发版说明(第三条通道)

/// 版本段落的文本(标题主题句 + 正文)。**只取会上界面的部分**:文件开头的前言
/// 是写给维护者看的,永远不显示给用户,拿它去过禁词表只会制造假红。
fn release_note_texts() -> Vec<(String, String)> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("RELEASE_NOTES.md");
    let notes = skillsync_lib::core::release_notes::read(&path);
    assert!(
        !notes.is_empty(),
        "一段发版说明都没解析出来 —— 要么文件挪了位置,要么格式变了。\
         这条守卫的自保:解析器失灵时下面几条会静默变成空转"
    );
    notes
        .into_iter()
        .map(|n| (n.versions.join(" / "), format!("{}\n{}", n.theme, n.body)))
        .collect()
}

/// 发版说明是用户可见文案的**第三条通道**,两道现有守卫都扫不到它:
/// `src/i18n/index.test.ts` 只扫 i18n 资源,本文件其余测试只扒 `AppError::new`。
/// 而这个文件的正文自 v5 起会直接显示在升级后的首屏卡片与设置页里。
///
/// (加这条守卫的当场就抓到一处:0.4.0 段落里写着「整个代码仓库」。)
#[test]
fn release_notes_use_no_git_terminology_in_chinese() {
    let banned = ["仓库", "分支", "拉取", "推送", "克隆", "合并", "代码库"];
    for (version, text) in release_note_texts() {
        for word in banned {
            assert!(
                !text.contains(word),
                "发版说明 {version} 里出现 git 术语「{word}」\
                 —— 这段文字会显示给用户,见 docs/terminology.md"
            );
        }
    }
}

#[test]
fn release_notes_contain_no_emoji() {
    let is_emoji = |c: char| {
        matches!(c,
            '\u{1F000}'..='\u{1FAFF}' | '\u{2600}'..='\u{27BF}' | '\u{2B00}'..='\u{2BFF}' | '\u{FE0F}'
        )
    };
    for (version, text) in release_note_texts() {
        assert!(
            !text.chars().any(is_emoji),
            "发版说明 {version} 里出现 emoji(UI 规范 §2 全站禁 emoji)"
        );
    }
}
