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

/// 从净化文本里找出 `anchor` 开头的结构体字面量里 `field:` 那一项的字符串字面量。
///
/// 与 [`extract_messages`] 同一套词法基础(先剥注释、再按调用锚定),差别只在
/// 定界符是 `{}` 而不是 `()`,以及要按字段名而不是位置取值。
///
/// 取值规则:找到 `field:` 之后,收**本字段内**的第一个字面量——遇到本层的 `,`
/// 或整个块结束就停。这样 `reason: format!("模板…", 变量)` 里取到的是模板本身
/// (它才是用户看见的那句话),而 `reason: 变量` / `reason`(简写)自然什么都取不到。
fn extract_field_literals(file: &Path, source: &str, anchors: &[&str], field: &str) -> Vec<Extracted> {
    let (clean, literals) = strip(source);
    let mut out = Vec::new();
    let needle = format!("{field}:");
    for anchor in anchors {
        let mut from = 0;
        while let Some(pos) = clean[from..].find(anchor) {
            let open = from + pos + anchor.len() - 1; // 指向 `{`
            from = open + 1;
            let chars: Vec<char> = clean[open..].chars().collect();
            // 先定位本块内的 `field:`(按深度限界,别越过块尾去抓下一个结构体的)
            let mut depth = 0usize;
            let mut j = 0usize;
            let mut field_at: Option<usize> = None;
            while j < chars.len() {
                match chars[j] {
                    '{' | '(' => depth += 1,
                    '}' | ')' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {
                        if depth == 1 && chars[j..].starts_with(&needle.chars().collect::<Vec<_>>()[..]) {
                            field_at = Some(j + needle.chars().count());
                            break;
                        }
                    }
                }
                j += 1;
            }
            let Some(mut k) = field_at else { continue };
            // 再收这一项的第一个字面量:本层的 `,` 或块尾即止
            let mut inner = 1usize;
            while k < chars.len() {
                match chars[k] {
                    '{' | '(' => inner += 1,
                    '}' | ')' => {
                        inner -= 1;
                        if inner == 0 {
                            break;
                        }
                    }
                    ',' if inner == 1 => break,
                    '\u{1}' => {
                        let mut num = String::new();
                        k += 1;
                        while k < chars.len() && chars[k] != '\u{1}' {
                            num.push(chars[k]);
                            k += 1;
                        }
                        let id: usize = num.parse().unwrap();
                        let (line, text) = &literals[id];
                        out.push(Extracted {
                            file: file.to_path_buf(),
                            line: *line,
                            message: text.clone(),
                        });
                        break;
                    }
                    _ => {}
                }
                k += 1;
            }
        }
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

/// core **直接产出、原样显示给用户**的中文句子。
///
/// # 为什么要单开一条通道
///
/// 用户可见文案有好几条通道,**别用序数指代它们**(数着数着就对不上,本项目
/// 记过这条教训)。按名字列:i18n 资源(`src/i18n/index.test.ts` 扫 `zh-CN.json`)、
/// `AppError::new`(本文件其余测试)、发版说明(`RELEASE_NOTES.md`)、
/// `README.md`、以及**这一条**——core 拼好中文原样送上界面的字段。前几道谁都扫不到它:而
/// `BatchOutcome::Skipped { reason }` 这类字段是 core 拼好一句中文、经 IPC
/// 原样送到界面上渲染的(`components/Wizard.tsx` 就把它直接贴在结果行末尾)。
///
/// # 覆盖范围(明写,别让下一个人以为它管得比实际多)
///
/// 只锚定两个类型的**结构体字面量**:
/// - `BatchOutcome::Skipped { reason }`(`core/acquire.rs`)——向导一键全装与
///   定时更新的跳过原因,**当前唯一真的被渲染出来的一条通道**;
/// - `SkippedSkill { reason }`(`core/scheduler.rs` 的定时更新报告、
///   `core/skills.rs` 的技能发现跳过)——同一个字段名、同一种"人话原因",
///   今天前端只读数量不读文本,纳进来是防它哪天被渲染;
/// - `UnlinkResult::Skipped { reason }`(`core/installer.rs` / `core/remove.rs`)
///   ——移除时"这个位置没能解除"的原因,自终审 I-1 起真的会渲染到
///   「我的技能」的失败框里(见下)。
///
/// **挡不住什么**(与 `body_guard` 同一个道理:它是烟雾报警,不是防火墙):
/// - 间接产出的句子,例如 `reason: err.reason()`(`core/skills.rs:510`)——
///   文本在另一个函数里,锚定不到;
/// - 变量、常量、`format!` 之外的拼接。
///
/// # `UnlinkResult::Skipped` 是**后加进来的**(终审 I-1),原委值得留着
///
/// 这段文档此前写着「那批字段今天没有任何渲染点……哪天界面开始渲染它,把锚点
/// 加进来即可」。**那一天就是 I-1**:`store/my-skills.ts::confirmRemove` 从此把
/// `UninstallReport.unlinks` 摆到界面上,承诺当场到期。加锚点的那一刻守卫立刻
/// 变红(「关联」「记账」两个本期禁词各命中一处),这是免费的注入验证。
///
/// ⚠️ 加锚点连带要求 `core/installer.rs` 的写法配合:那四句原先走
/// `skip("…")` 闭包,字符串在**调用点**而不是结构体字面量里,`extract_field_literals`
/// 按锚点抓不到——加了锚点也仍是空转。现已改成内联的
/// `UnlinkResult::Skipped { reason: "…".into() }`。**别"顺手"把它们收回闭包**。
///
/// 真正兜底的是**逐条读一遍**加上下面这条自保断言:提取器一旦失灵,
/// 条数会掉下去,而不是静默变成空转。
fn core_visible_reasons() -> Vec<Extracted> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut out = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        out.extend(extract_field_literals(
            &file,
            &text,
            &["BatchOutcome::Skipped {", "SkippedSkill {", "UnlinkResult::Skipped {"],
            "reason",
        ));
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
fn error_messages_use_no_retired_feature_terms() {
    // 与上面的 git 术语禁词表分开维护:这三个词不是 git 术语(与 docs/terminology.md
    // 无关),是 v6 撤掉「纳入管理/移出管理」整条链路之后新增的项目内部禁词。
    // 刻意不加 "npx"——release_notes 那两条守卫用的是另一份(只含 git 术语)的
    // 禁词表,"与 npx skills 完全互通"是合法的功能承诺,不该被误伤(v6 任务 6 拍板)。
    let banned = ["纳入管理", "移出管理", "其他工具装的"];
    for m in all_messages() {
        for word in banned {
            assert!(
                !m.message.contains(word),
                "用户可见的错误信息里出现已撤销的功能术语「{word}」\n  {}",
                place(&m)
            );
        }
    }
}

#[test]
fn error_messages_use_no_link_terminology() {
    // 第三份独立禁词表(前端 `src/i18n/index.test.ts` 有同名同表的一条)。
    // **不与上面两份合并**:git 术语那份出自 docs/terminology.md,「纳入管理」
    // 那份是 v6 撤销认领语义的产物,这一份是 v6 二期撤销「本体/链接」实现模型
    // 之后的产物——三者的存废理由各不相同。
    //
    // 用户可见的说法只有「一个技能,三个在哪」:这台电脑上 / 各个工具里 /
    // 技能库里。「关联」「修复关联」「收编」「记账」「占位」全是实现细节的名字,
    // 它们泄漏到错误信息里,用户就得先学会这套内部模型才看得懂出了什么事。
    let banned = ["修复关联", "关联", "收编", "记账", "占位"];
    for m in all_messages() {
        for word in banned {
            assert!(
                !m.message.contains(word),
                "用户可见的错误信息里出现实现术语「{word}」\n  {}",
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

// ============================================================ core 直出的中文串(第四条通道)

#[test]
fn core_visible_reasons_are_actually_extracted() {
    // 提取器的自保:锚点或写法一变,下面两条禁词测试会静默变成空转。
    // 现役语料:acquire 8 + scheduler 3(含测试模块里的两条)+ skills 1
    // + installer/remove 的 UnlinkResult::Skipped 5 条(I-1 起纳入)。
    // 掉到个位数一定是提取器坏了。
    let found = core_visible_reasons();
    assert!(
        found.len() >= 9,
        "只提取到 {} 条 core 直出文案,提取器大概率失灵了:{:?}",
        found.len(),
        found.iter().map(place).collect::<Vec<_>>()
    );
}

#[test]
fn core_visible_reasons_use_no_git_terminology_in_chinese() {
    // 只查中文那份。**刻意不套英文 git 禁词表**:这批句子里有
    // `format!("同名技能已从 {source_owner}/{source_repo} 获取…")` 这样的模板,
    // 占位符名字里的 `repo` 会被英文表当成 git 术语误伤,而它根本不会显示给用户
    // ——替换之后落在用户眼里的是一个真实的技能库坐标。
    let banned = ["仓库", "分支", "拉取", "推送", "克隆", "合并", "代码库"];
    for m in core_visible_reasons() {
        for word in banned {
            assert!(
                !m.message.contains(word),
                "core 直接显示给用户的句子里出现 git 术语「{word}」\n  {}",
                place(&m)
            );
        }
    }
}

#[test]
fn core_visible_reasons_use_no_retired_or_implementation_terms() {
    // 与 `AppError` 那两份禁词表同源(v6 的「纳入管理」一批 + v6 二期的
    // 「关联/收编/记账/占位」一批),刻意不合并成一份:三份表的存废理由各不相同。
    let banned = [
        "纳入管理", "移出管理", "其他工具装的",
        "修复关联", "关联", "收编", "记账", "占位",
    ];
    for m in core_visible_reasons() {
        for word in banned {
            assert!(
                !m.message.contains(word),
                "core 直接显示给用户的句子里出现实现术语「{word}」\n  {}",
                place(&m)
            );
        }
    }
}

/// 已撤销的功能术语 + 实现术语,合起来一份(v6 的「纳入管理」一批 +
/// v6 二期的「关联/收编/记账/占位」一批)。
///
/// ⚠️ **只给"照抄两处以上"的守卫用**:上面 `AppError` 与 `core_visible_reasons`
/// 那两条各自内联着自己的表,**刻意不共用**——它们的存废理由与这两处不同,
/// 合并之后再想删其中一条就得连带论证另外几条。这个常量是给
/// `README.md` / `RELEASE_NOTES.md` 两条文档守卫用的,那两处的判据完全一致。
const RETIRED_AND_IMPLEMENTATION_TERMS: [&str; 8] = [
    "纳入管理", "移出管理", "其他工具装的",
    "修复关联", "关联", "收编", "记账", "占位",
];

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

/// 发版说明同样要过**已撤销/实现术语**那份表(终审 I-2)。
///
/// 此前这个文件只受 git 术语守卫管辖,于是 0.5.0 段落里的两处「关联」
/// 一直活着——而这份文件会**在设置页里渲染给用户**,还会被 `publish-release.sh`
/// 同步到内网发布仓的首页。
#[test]
fn release_notes_use_no_retired_or_implementation_terms() {
    for (version, text) in release_note_texts() {
        for word in RETIRED_AND_IMPLEMENTATION_TERMS {
            assert!(
                !text.contains(word),
                "发版说明 {version} 里出现已撤销/实现术语「{word}」\
                 —— 这段文字会显示给用户(升级后的首屏卡片与设置页)"
            );
        }
    }
}

// ============================================================ README(第五条通道)

/// `README.md` 的全文。
///
/// 它是**用户可见文案的第五条通道**,而且此前一道守卫都没有:
/// `publish-release.sh` 把它同步到内网发布仓,那是同事下载安装包时唯一会看到的
/// 说明页。终审 I-2 在它里面抓到两处活的「关联」,其中一处是本分支新写的
/// ——写在**解释新模型的那一段**里,与它旁边的「链接」一起,两个已经从产品层
/// 撤掉的词同时出现。
fn readme_text() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("README.md");
    let text = std::fs::read_to_string(&path).expect("读不到 README.md");
    assert!(
        text.len() > 2000,
        "README.md 只有 {} 字节 —— 要么文件挪了位置,要么被截断了;\
         这条守卫的自保:读空时下面那条会静默变成空转",
        text.len()
    );
    text
}

/// 🔴 **范围只有"已撤销/实现术语"这一份表,刻意不套 git 术语表。**
///
/// README 后半截是**给开发者看的**(本地联调、四道闸、发版流程),那里出现
/// 「仓库」「提交」是准确的技术表述,不是给最终用户的文案。套上去只会红在一批
/// 这次并不打算改、也不该改的存量文字上——而一条"红了就得去改无关文字"的守卫,
/// 下一个人只会把它删掉。**声称的范围必须等于实际的范围**(本分支已因反例被
/// 打回四次)。
#[test]
fn readme_uses_no_retired_or_implementation_terms() {
    let text = readme_text();
    for word in RETIRED_AND_IMPLEMENTATION_TERMS {
        assert!(
            !text.contains(word),
            "README.md 里出现已撤销/实现术语「{word}」—— 它会被同步到内网发布仓,\
             是同事下载安装包时唯一会看到的说明页"
        );
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
