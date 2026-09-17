//! 结构性守卫(v6 二期任务 6 修复轮 1):`rename_all` 挂在**枚举**上只改 variant 名,
//! **不改 struct variant 里的字段名**——要改字段名必须另加 `rename_all_fields`。
//!
//! # 为什么值得一条守卫,而不是"我扫过一遍"
//!
//! 这个坑在本仓已经出现**三次**,一次比一次难发现:
//! 1. `share::ShareOutcome::review_url` —— **真缺陷**:发出去的是 `review_url`,
//!    界面读 `reviewUrl`,「分享走评审之后的『查看审核』链接」从来没渲染过。
//!    ⚠️ 那个字段本身已随提交审核一起删除(v8 任务 3),这里只作为**这道守卫
//!    存在的理由**留着;下面的自保测试用的是合成样本,不依赖真实类型;
//! 2. `scheduler::CheckReport::head_sha` —— 哑弹(`ipc.ts` 声明 `headSha`,当下无人取值);
//! 3. `commands::ProjectInstallOutcome::linked_agents` —— 同上,而它是在
//!    "我全文扫描过了"这句话**之后**才被复审者找出来的。
//!
//! 第 3 次说明的正是"一次性扫描"的问题:扫描口径靠人记,记漏了没人知道。
//! 这条守卫把口径写成代码,每次 `cargo test` 都重扫一遍。
//!
//! # 它挡得住什么、挡不住什么
//!
//! 挡得住:新增(或改名成)带下划线的字段、新加一个漏了属性的 Serialize 枚举。
//!
//! **挡不住(逐条实测过,不是推测)**:
//! 1. **字段名本来就是单个单词**(`source`)时的遗漏——那种此刻序列化结果相同,
//!    加不加属性看不出差别;只能靠各类型自己的"断言完整键集合"测试在**将来**
//!    加字段时变红(`share.rs` 与 `scheduler.rs` 里各有一条);
//! 2. **只 `Deserialize` 的枚举整个不看**——判据是 `head.contains("Serialize")`。
//!    今天不活(本仓的 IPC 入参是 struct 不是 enum),但**如果将来出现一个
//!    `Deserialize` 的 tagged enum 作为 command 入参,这条守卫一个字都不会说**。
//!    真要覆盖得连同"入参键名"这条另一半契约一起想清楚,不是把判据改宽就完事。
//!
//! 曾经还有第三条(**误报**:字段自带 `#[serde(rename = "…")]` 时被判违规),
//! 修复轮 2 已修——见 [`snake_fields`] 里那道跳过,以及自保测试里对应的样本。
//!
//! 判据刻意**只看 `pub enum`**:非 pub 的枚举出不了 crate,不会成为 IPC 契约。

use std::path::Path;

/// 一处违规:文件、枚举名、变体名、犯规的字段。
#[derive(Debug)]
struct Offender {
    file: String,
    line: usize,
    enum_name: String,
    variant: String,
    fields: Vec<String>,
}

/// 剥掉行注释与块注释(不剥字符串:属性里的 `"camelCase"` 正是要读的东西)。
fn strip_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                let mut depth = 1;
                i += 2;
                while i < chars.len() && depth > 0 {
                    if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        if chars[i] == '\n' {
                            out.push('\n');
                        }
                        i += 1;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// 从 `at` 处的 `{` 起,返回配平的那一段(不含两端花括号)。
fn balanced_body(src: &str, open: usize) -> &str {
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[open + 1..i];
                }
            }
            _ => {}
        }
        i += 1;
    }
    &src[open + 1..]
}

/// 一段属性文本里有没有这个键。
fn has(attrs: &str, key: &str) -> bool {
    attrs.contains(key)
}

/// 从字段体里挑出"带下划线"的字段名(那些正是 camelCase 化之后会变形的)。
///
/// **自带 `#[serde(rename = "…")]` 的字段跳过**(修复轮 2 修的一处误报):
/// 它已经把键名钉死了,`rename_all_fields` 对它没有意义,判它违规就是一次**假红**。
/// ⚠️ 判据是"这一段里出现 `rename =`",粗但**方向安全**:宁可漏报一个真违规
/// (那是烟雾报警的固有代价),也不制造假红——本项目吃过假红的亏。
fn snake_fields(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in body.split(',') {
        if part.contains("rename =") || part.contains("rename=") {
            continue;
        }
        let Some((left, _)) = part.split_once(':') else { continue };
        let name = left.rsplit(|c: char| c.is_whitespace() || c == '#' || c == ']').next().unwrap_or("");
        let name = name.trim();
        if name.is_empty() || name.contains('<') || name.contains('(') {
            continue;
        }
        let ok_shape = name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && name.starts_with(|c: char| c.is_ascii_lowercase());
        if ok_shape && name.contains('_') {
            out.push(name.to_string());
        }
    }
    out
}

fn scan(file: &Path) -> Vec<Offender> {
    let raw = std::fs::read_to_string(file).unwrap_or_default();
    let src = strip_comments(&raw);
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = src[cursor..].find("pub enum ") {
        let at = cursor + rel;
        cursor = at + 9;
        // 枚举名与它的 `{`
        let after = &src[at + 9..];
        let Some(brace_rel) = after.find('{') else { break };
        let name = after[..brace_rel].trim();
        if name.is_empty() || name.contains(char::is_whitespace) {
            continue; // 带泛型/where 的写法,本仓没有,不猜
        }
        // 往前找紧邻的 derive + serde 属性块(到上一个 `}` 或 `;` 为止)
        let head_start = src[..at]
            .rfind(['}', ';'])
            .map(|p| p + 1)
            .unwrap_or(0);
        let head = &src[head_start..at];
        if !head.contains("Serialize") {
            continue;
        }
        if has(head, "rename_all_fields") {
            continue;
        }
        if !has(head, "rename_all") {
            continue; // 压根没要求改名,不在这条守卫的射程内
        }
        let body = balanced_body(&src[at + 9..], brace_rel);
        // 逐 variant:`名字 { ... }`,前面可能带自己的 #[serde(...)]
        let mut vcur = 0usize;
        while let Some(vrel) = body[vcur..].find('{') {
            let vat = vcur + vrel;
            let head_v = &body[vcur..vat];
            let vname = head_v
                .rsplit([',', ']', '\n'])
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            let vbody = balanced_body(body, vat);
            vcur = vat + vbody.len() + 2;
            // 该 variant 自带 rename_all 就算已覆盖
            if head_v.contains("rename_all") {
                continue;
            }
            let fields = snake_fields(vbody);
            if !fields.is_empty() {
                out.push(Offender {
                    file: file.display().to_string(),
                    line: raw[..raw.find(&format!("pub enum {name}")).unwrap_or(0)]
                        .lines()
                        .count()
                        + 1,
                    enum_name: name.to_string(),
                    variant: vname,
                    fields,
                });
            }
        }
    }
    out
}

fn all_rs(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            all_rs(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn every_serializable_enum_renames_its_struct_variant_fields_too() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    all_rs(&root, &mut files);
    files.sort();
    assert!(files.len() > 20, "扫描口径失灵:src/ 下只找到 {} 个 .rs", files.len());

    let offenders: Vec<Offender> = files.iter().flat_map(|f| scan(f)).collect();
    assert!(
        offenders.is_empty(),
        "这些枚举带 rename_all 却没有 rename_all_fields,struct variant 的字段会原样发成蛇形键:\n{}",
        offenders
            .iter()
            .map(|o| format!(
                "  {}:{} {}::{} 的 {:?}",
                o.file, o.line, o.enum_name, o.variant, o.fields
            ))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// 守卫的自保:扫描器本身要真的认得出违规形状。
///
/// **不是多余的一遍**——上面那条在全仓干净时恒绿,`scan` 整个失灵(正则改坏、
/// 属性块定位错)它一样绿。这条喂一段**已知违规**的源码进去,断言扫得出来;
/// 再喂一段加了属性的,断言扫不出来。两段只差 `rename_all_fields` 一个词。
#[test]
fn the_scanner_itself_recognizes_the_offending_shape() {
    let tmp = tempfile::tempdir().unwrap();

    let bad = tmp.path().join("bad.rs");
    std::fs::write(
        &bad,
        r#"
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Sample {
    Alpha { review_url: String, mode: String },
    Beta,
}
"#,
    )
    .unwrap();
    let found = scan(&bad);
    assert_eq!(found.len(), 1, "扫描器没认出违规形状: {found:?}");
    assert_eq!(found[0].enum_name, "Sample");
    assert_eq!(found[0].variant, "Alpha");
    assert_eq!(found[0].fields, vec!["review_url".to_string()]);

    let good = tmp.path().join("good.rs");
    std::fs::write(
        &good,
        r#"
#[derive(Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Sample {
    Alpha { review_url: String, mode: String },
    Beta,
}
"#,
    )
    .unwrap();
    assert!(scan(&good).is_empty(), "加了 rename_all_fields 仍被判违规");

    // 字段自带 `#[serde(rename = "…")]`:键名已经钉死,判它违规就是假红
    let field_rename = tmp.path().join("field_rename.rs");
    std::fs::write(
        &field_rename,
        r#"
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Sample {
    Alpha {
        #[serde(rename = "reviewUrl")]
        review_url: String,
    },
}
"#,
    )
    .unwrap();
    assert!(
        scan(&field_rename).is_empty(),
        "字段自带 rename 时不该判违规(假红)"
    );

    // per-variant 的 rename_all 同样算已覆盖(`ShareInstalledOutcome` 就是这个形状)
    let per_variant = tmp.path().join("per_variant.rs");
    std::fs::write(
        &per_variant,
        r#"
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Sample {
    #[serde(rename_all = "camelCase")]
    Alpha { review_url: String },
}
"#,
    )
    .unwrap();
    assert!(scan(&per_variant).is_empty(), "variant 自带 rename_all 不该判违规");
}
