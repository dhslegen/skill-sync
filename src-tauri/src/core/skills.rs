//! SKILL.md 解析与仓库发现规则。
//!
//! 移植自 vercel-labs/skills v1.5.20 的 `src/skills.ts` / `src/frontmatter.ts` / `src/sanitize.ts`(MIT)。
//! 与上游保持一致是硬需求:发现规则决定"仓库里哪些目录算技能",名称清洗决定 skill-lock 里的键,
//! 两者不一致会导致本 app 与 `npx skills` 对同一仓库看法不同。
//!
//! 数据源经 [`SkillTree`] 抽象:商店页扫描的是下载下来的仓库压缩包([`MemTree`]),
//! 分享页扫描的是本机目录([`FsTree`]),同一套发现逻辑两处复用。
//!
//! 与上游的有意分歧(均已在测试中锁定):
//! - 上游解析失败只 `console.warn`,此处收集进 [`Discovery::skipped`]——分享页要据此引导用户补齐 frontmatter;
//! - 上游不处理 BOM(带 BOM 的 SKILL.md 会被当作没有 frontmatter 而跳过),此处剥掉 BOM 再解析:
//!   面向非研发用户,因一个不可见字节而"技能凭空消失"是不可接受的失败模式;
//! - 上游没有"没有 frontmatter"这一类错误——正则不匹配时它返回空数据,最终报成"缺 name、description";
//!   此处单列 [`SkillParseError::NoFrontmatter`],接受/拒绝的结论与上游一致,只是提示更贴近真实原因;
//! - 目录列举结果排序,保证同名遮蔽的胜者可复现(上游依赖文件系统返回顺序)。

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use saphyr::{LoadableYamlNode, Yaml};

/// 技能定义文件名。上游大小写敏感,此处保持一致。
pub const SKILL_FILE: &str = "SKILL.md";

/// 扫描时跳过的目录(逐字取自上游 skills.ts 的 SKIP_DIRS)。
const SKIP_DIRS: [&str; 5] = ["node_modules", ".git", "dist", "build", "__pycache__"];

/// 上游 skills.ts 的 AGENT_PROJECT_SKILL_DIRS。
///
/// 注意:这**不是** agents.json 里 skillsDir 的集合,而是上游单独维护的一份项目级技能目录清单
/// (少数 agent 不在其中,`.github/skills` 则不属于任何 agent)。逐字照搬,勿用 agents.json 推导。
const AGENT_PROJECT_SKILL_DIRS: [&str; 26] = [
    ".agents/skills",
    ".claude/skills",
    ".cline/skills",
    ".codebuddy/skills",
    ".codex/skills",
    ".commandcode/skills",
    ".continue/skills",
    ".github/skills",
    ".goose/skills",
    ".grok/skills",
    ".iflow/skills",
    ".junie/skills",
    ".kilocode/skills",
    ".kimchi/skills",
    ".kiro/skills",
    ".mux/skills",
    ".neovate/skills",
    ".opencode/skills",
    ".openhands/skills",
    ".pi/skills",
    ".qoder/skills",
    ".roo/skills",
    ".trae/skills",
    ".windsurf/skills",
    ".zcode/skills",
    ".zencoder/skills",
];

/// 优先目录之外的递归兜底扫描深度(上游 findSkillDirs 的 maxDepth)。
const MAX_FALLBACK_DEPTH: usize = 5;

/// 目录名长度上限,对齐上游 sanitizeName(常见文件系统限制)。
const MAX_NAME_LEN: usize = 255;

// ============================================================ 数据源抽象

/// 可被扫描的技能目录树。路径一律用 `/` 分隔的逻辑路径,根为空串。
pub trait SkillTree {
    /// 列出目录下的**子目录名**;目录不存在或不可读时返回空(与上游"读不到就跳过"一致)。
    fn list_dirs(&self, path: &str) -> Vec<String>;
    fn is_file(&self, path: &str) -> bool;
    fn read_file(&self, path: &str) -> Option<String>;
}

fn join_path(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

/// 内存树。用于扫描下载下来的仓库压缩包,也便于在单测里精确构造目录布局。
#[derive(Debug, Default, Clone)]
pub struct MemTree {
    files: BTreeMap<String, String>,
}

impl MemTree {
    pub fn new() -> Self {
        Self::default()
    }

    /// 放入一个文件(路径为 `/` 分隔的逻辑路径),其各级父目录随之隐式存在。
    pub fn with_file(mut self, path: &str, content: &str) -> Self {
        self.files.insert(path.to_string(), content.to_string());
        self
    }

    /// 放入一个最小可用的 SKILL.md,省去测试里反复拼 frontmatter。
    pub fn with_skill(self, dir: &str, name: &str) -> Self {
        let content = format!("---\nname: {name}\ndescription: {name} 的说明\n---\n\n正文\n");
        self.with_file(&join_path(dir, SKILL_FILE), &content)
    }
}

impl SkillTree for MemTree {
    fn list_dirs(&self, path: &str) -> Vec<String> {
        let prefix = if path.is_empty() {
            String::new()
        } else {
            format!("{path}/")
        };
        let mut out = BTreeSet::new();
        for key in self.files.keys() {
            let Some(rest) = key.strip_prefix(prefix.as_str()) else {
                continue;
            };
            let mut parts = rest.splitn(2, '/');
            let head = parts.next().unwrap_or_default();
            // 后面还有段落才说明 head 是目录而非文件
            if !head.is_empty() && parts.next().is_some() {
                out.insert(head.to_string());
            }
        }
        out.into_iter().collect()
    }

    fn is_file(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    fn read_file(&self, path: &str) -> Option<String> {
        self.files.get(path).cloned()
    }
}

/// 本机文件系统树,根为某个真实目录。
pub struct FsTree {
    root: PathBuf,
}

impl FsTree {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn real_path(&self, path: &str) -> PathBuf {
        let mut p = self.root.clone();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            p.push(seg);
        }
        p
    }
}

impl SkillTree for FsTree {
    fn list_dirs(&self, path: &str) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(self.real_path(path)) else {
            return Vec::new();
        };
        let mut out: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        // 文件系统不保证顺序,排序以保证同名遮蔽的结果可复现
        out.sort();
        out
    }

    fn is_file(&self, path: &str) -> bool {
        self.real_path(path).is_file()
    }

    fn read_file(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.real_path(path)).ok()
    }
}

// ============================================================ 字符串清洗

/// 剥除终端转义序列与危险控制字符(等价于上游 sanitize.ts 的 stripTerminalEscapes)。
///
/// 保留 `\t` 与 `\n`。SKILL.md 来自仓库,属不可信输入:控制字符既可能污染日志输出,
/// 也会让界面上的技能名出现不可见字符。
pub fn strip_terminal_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek().copied() {
                // CSI:ESC [ 参数字节 中间字节 终止字节
                Some('[') => {
                    chars.next();
                    while matches!(chars.peek(), Some(&c) if ('\u{30}'..='\u{3f}').contains(&c)) {
                        chars.next();
                    }
                    while matches!(chars.peek(), Some(&c) if ('\u{20}'..='\u{2f}').contains(&c)) {
                        chars.next();
                    }
                    if matches!(chars.peek(), Some(&c) if ('\u{40}'..='\u{7e}').contains(&c)) {
                        chars.next();
                    }
                }
                // OSC:ESC ] … 以 BEL 或 ESC \ 结束
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // DCS / PM / APC:以 ESC \ 结束
                Some('P') | Some('^') | Some('_') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // 双字节简单转义
                Some(c2) if ('\u{20}'..='\u{7e}').contains(&c2) => {
                    chars.next();
                }
                _ => {}
            },
            '\t' | '\n' => out.push(c),
            // C1 控制码与其余控制字符(含 \r、DEL)一律丢弃
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// 清洗展示用元数据:剥转义 + 换行折为空格 + 去首尾空白(上游 sanitizeMetadata)。
pub fn sanitize_metadata(s: &str) -> String {
    let stripped = strip_terminal_escapes(s);
    let mut out = String::with_capacity(stripped.len());
    let mut in_newlines = false;
    for c in stripped.chars() {
        if c == '\n' || c == '\r' {
            if !in_newlines {
                out.push(' ');
                in_newlines = true;
            }
        } else {
            in_newlines = false;
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// 把技能名规整为安全目录名(上游 installer.ts 的 sanitizeName)。
///
/// 同时也是路径穿越防线:`../` 里的字符不在白名单内,会被折成 `-`。
pub fn sanitize_name(name: &str) -> String {
    let lowered = name.to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut in_replacement = false;
    for c in lowered.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' {
            out.push(c);
            in_replacement = false;
        } else if !in_replacement {
            out.push('-');
            in_replacement = true;
        }
    }
    let trimmed = out.trim_matches(|c| c == '.' || c == '-');
    // 上述替换后只剩 ASCII,按字节截断是安全的
    let truncated = &trimmed[..trimmed.len().min(MAX_NAME_LEN)];
    if truncated.is_empty() {
        "unnamed-skill".to_string()
    } else {
        truncated.to_string()
    }
}

// ============================================================ frontmatter 解析

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    /// `metadata.internal: true`——上游默认隐藏这类技能。
    pub internal: bool,
    /// frontmatter 之后的正文。
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillParseError {
    /// 没有 `---` 包裹的 frontmatter。
    NoFrontmatter,
    /// YAML 语法错误。
    Yaml(String),
    /// 缺少必填字段(上游把空串/0/false 也算缺失)。
    MissingFields(Vec<String>),
    /// 字段存在但不是字符串。
    NotString { field: String, got: String },
}

impl SkillParseError {
    /// 面向用户的中文原因,直接进"跳过原因"列表与分享页引导文案。
    pub fn reason(&self) -> String {
        match self {
            Self::NoFrontmatter => "文件开头缺少 --- 包裹的技能信息".to_string(),
            Self::Yaml(msg) => format!("技能信息格式有误:{msg}"),
            Self::MissingFields(fields) => format!("缺少必填项:{}", fields.join("、")),
            Self::NotString { field, got } => {
                format!("{field} 必须是一段文字,当前是{got}")
            }
        }
    }
}

/// 拆出 frontmatter 与正文。等价于上游 frontmatter.ts 的正则,只认 YAML(不支持 `---js`,避免 eval 类风险)。
fn split_frontmatter(raw: &str) -> Option<(&str, &str)> {
    // 上游不处理 BOM;此处剥掉(见模块头的分歧说明)
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let after_open = raw
        .strip_prefix("---\n")
        .or_else(|| raw.strip_prefix("---\r\n"))?;

    // 闭合的 `---` 要么紧跟开头(空 frontmatter),要么另起一行。
    // 上游正则要求闭合行前必有换行,`---\n---\n` 会被判定为"没有 frontmatter";
    // 此处额外认下这种写法——文件里明明有 `---`,却提示"缺少 --- 包裹"只会让人摸不着头脑,
    // 报"缺必填项"才是用户真正要修的东西。两种走法的接受/拒绝结论一致,只是提示更准。
    let immediate_close = after_open == "---"
        || after_open.starts_with("---\n")
        || after_open.starts_with("---\r\n");
    let (front, rest) = if immediate_close {
        ("", &after_open[3..])
    } else {
        let end = after_open.find("\n---")?;
        (
            after_open[..end].trim_end_matches('\r'),
            &after_open[end + 4..],
        )
    };
    let body = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .or_else(|| rest.strip_prefix('\r'))
        .unwrap_or(rest);
    Some((front, body))
}

fn yaml_type_name(value: &Yaml) -> &'static str {
    if value.is_integer() || value.is_floating_point() {
        "数字"
    } else if value.is_boolean() {
        "是/否值"
    } else if value.is_sequence() {
        "列表"
    } else if value.is_mapping() {
        "嵌套结构"
    } else {
        "非文本值"
    }
}

/// 上游用 JS 的真值判断筛必填项:空串、0、false 与缺失同样视为"没填"。
fn is_falsy(value: Option<&Yaml>) -> bool {
    match value {
        None => true,
        Some(v) => {
            v.is_null()
                || v.is_badvalue()
                || v.as_bool() == Some(false)
                || v.as_str() == Some("")
                || v.as_integer() == Some(0)
        }
    }
}

pub fn parse_skill_md(raw: &str) -> Result<ParsedSkill, SkillParseError> {
    let Some((front, body)) = split_frontmatter(raw) else {
        return Err(SkillParseError::NoFrontmatter);
    };

    let docs = Yaml::load_from_str(front).map_err(|e| SkillParseError::Yaml(e.to_string()))?;
    // 空 frontmatter 得到零个文档;顶层是纯量或列表时同样取不到字段——两种情况都按"缺必填项"处理,与上游一致
    let doc = docs.first();
    let get = |key: &str| -> Option<&Yaml> {
        doc.filter(|d| d.is_mapping())
            .and_then(|d| d.as_mapping_get(key))
    };

    let name = get("name");
    let description = get("description");

    let mut missing = Vec::new();
    if is_falsy(name) {
        missing.push("name".to_string());
    }
    if is_falsy(description) {
        missing.push("description".to_string());
    }
    if !missing.is_empty() {
        return Err(SkillParseError::MissingFields(missing));
    }

    let (Some(name), Some(description)) = (name, description) else {
        unreachable!("已排除缺失情况");
    };
    for (field, value) in [("name", name), ("description", description)] {
        if value.as_str().is_none() {
            return Err(SkillParseError::NotString {
                field: field.to_string(),
                got: yaml_type_name(value).to_string(),
            });
        }
    }

    let internal = get("metadata")
        .and_then(|m| m.as_mapping_get("internal"))
        .and_then(|v| v.as_bool())
        == Some(true);

    Ok(ParsedSkill {
        name: sanitize_metadata(name.as_str().unwrap_or_default()),
        description: sanitize_metadata(description.as_str().unwrap_or_default()),
        internal,
        body: body.to_string(),
    })
}

// ============================================================ 仓库发现

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    /// 技能目录的逻辑路径(树内绝对路径)。
    pub dir: String,
    pub internal: bool,
}

/// 有 SKILL.md 但没通过校验的目录。上游只打印警告,此处返回给界面用于引导修复。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedSkill {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Discovery {
    pub skills: Vec<DiscoveredSkill>,
    pub skipped: Vec<SkippedSkill>,
}

#[derive(Debug, Clone, Default)]
pub struct DiscoverOptions {
    /// 包含标记为 internal 的技能(用户显式点名某个技能时)。
    pub include_internal: bool,
    /// 即使根目录本身就是技能,也继续深挖全部子目录。
    pub full_depth: bool,
}

struct Discoverer<'a> {
    tree: &'a dyn SkillTree,
    opts: &'a DiscoverOptions,
    skills: Vec<DiscoveredSkill>,
    skipped: Vec<SkippedSkill>,
    seen_names: HashSet<String>,
    parsed_paths: HashSet<String>,
}

impl<'a> Discoverer<'a> {
    fn has_skill_md(&self, dir: &str) -> bool {
        self.tree.is_file(&join_path(dir, SKILL_FILE))
    }

    /// 解析某目录下的 SKILL.md。同一路径只解析一次(上游 parsedSkillPaths 语义)。
    fn parse_at(&mut self, dir: &str) -> Option<ParsedSkill> {
        let path = join_path(dir, SKILL_FILE);
        if !self.parsed_paths.insert(path.clone()) {
            return None;
        }
        match self.tree.read_file(&path) {
            None => {
                self.skipped.push(SkippedSkill {
                    path,
                    reason: "文件无法读取".to_string(),
                });
                None
            }
            Some(raw) => match parse_skill_md(&raw) {
                Ok(skill) => Some(skill),
                Err(err) => {
                    self.skipped.push(SkippedSkill {
                        path,
                        reason: err.reason(),
                    });
                    None
                }
            },
        }
    }

    /// 收录某目录的技能。返回该目录是否含 SKILL.md——含则不再往下探(上游语义)。
    fn try_add(&mut self, dir: &str) -> bool {
        if !self.has_skill_md(dir) {
            return false;
        }
        if let Some(skill) = self.parse_at(dir) {
            self.push(skill, dir);
        }
        true
    }

    fn push(&mut self, skill: ParsedSkill, dir: &str) {
        if skill.internal && !self.opts.include_internal {
            return;
        }
        if !self.seen_names.insert(skill.name.clone()) {
            return; // 同名遮蔽:先发现的优先
        }
        self.skills.push(DiscoveredSkill {
            name: skill.name,
            description: skill.description,
            dir: dir.to_string(),
            internal: skill.internal,
        });
    }

    /// 递归兜底扫描(上游 findSkillDirs):优先目录一无所获时才启用。
    fn collect_recursive(&self, dir: &str, depth: usize, out: &mut Vec<String>) {
        if depth > MAX_FALLBACK_DEPTH {
            return;
        }
        if self.has_skill_md(dir) {
            out.push(dir.to_string());
        }
        for name in self.tree.list_dirs(dir) {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            self.collect_recursive(&join_path(dir, &name), depth + 1, out);
        }
    }
}

/// 按上游规则在树中发现技能。
///
/// 顺序即优先级,同名时先发现者胜出:
/// 1. `base` 本身就是技能 → 直接返回(除非 `full_depth`);
/// 2. 优先目录:`base` / `skills` / `skills/.curated` / `.experimental` / `.system` / 各 agent 约定目录。
///    除 `base` 只看一层外,其余多走一层,以支持 `skills/<类目>/<技能>/` 这类布局;
/// 3. 前两步一无所获(或 `full_depth`)时,递归兜底扫描至多 5 层。
pub fn discover_skills(tree: &dyn SkillTree, base: &str, opts: &DiscoverOptions) -> Discovery {
    let mut d = Discoverer {
        tree,
        opts,
        skills: Vec::new(),
        skipped: Vec::new(),
        seen_names: HashSet::new(),
        parsed_paths: HashSet::new(),
    };

    // 1) base 本身是一个技能
    if d.has_skill_md(base) {
        if let Some(skill) = d.parse_at(base) {
            d.push(skill, base);
            if !opts.full_depth {
                return Discovery {
                    skills: d.skills,
                    skipped: d.skipped,
                };
            }
        }
    }

    // 2) 优先目录
    let mut priority = vec![base.to_string()];
    for sub in [
        "skills",
        "skills/.curated",
        "skills/.experimental",
        "skills/.system",
    ] {
        priority.push(join_path(base, sub));
    }
    for dir in AGENT_PROJECT_SKILL_DIRS {
        priority.push(join_path(base, dir));
    }
    // base 只看一层,避免把 examples/foo/SKILL.md 之类无关文件也收进来
    let deep_from = 1;

    for (idx, dir) in priority.iter().enumerate() {
        let walk_deep = idx >= deep_from;
        for name in d.tree.list_dirs(dir) {
            let child = join_path(dir, &name);
            let found = d.try_add(&child);
            if found || !walk_deep || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            for grand in d.tree.list_dirs(&child) {
                if SKIP_DIRS.contains(&grand.as_str()) {
                    continue;
                }
                d.try_add(&join_path(&child, &grand));
            }
        }
    }

    // 3) 递归兜底
    if d.skills.is_empty() || opts.full_depth {
        let mut dirs = Vec::new();
        d.collect_recursive(base, 0, &mut dirs);
        for dir in dirs {
            if let Some(skill) = d.parse_at(&dir) {
                d.push(skill, &dir);
            }
        }
    }

    Discovery {
        skills: d.skills,
        skipped: d.skipped,
    }
}

/// 判断某技能目录里是否含可执行脚本,用于详情页的"含可执行脚本"警示角标(UX 增强清单 #2)。
pub fn has_executable_scripts(dir: &str, files: &[String]) -> bool {
    const SCRIPT_EXTS: [&str; 8] = ["sh", "bash", "zsh", "py", "js", "mjs", "ps1", "rb"];
    let prefix = format!("{dir}/");
    files.iter().any(|f| {
        f.strip_prefix(prefix.as_str())
            .and_then(|rel| Path::new(rel).extension())
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| SCRIPT_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill_md(name: &str, description: &str) -> String {
        format!("---\nname: {name}\ndescription: {description}\n---\n\n正文内容\n")
    }

    // ---- frontmatter 解析 ----

    #[test]
    fn parses_standard_frontmatter() {
        let parsed = parse_skill_md(&skill_md("周报生成", "汇总本周工作")).unwrap();
        assert_eq!(parsed.name, "周报生成");
        assert_eq!(parsed.description, "汇总本周工作");
        assert!(!parsed.internal);
        assert_eq!(parsed.body, "\n正文内容\n");
    }

    #[test]
    fn rejects_missing_frontmatter() {
        assert_eq!(
            parse_skill_md("# 只是一篇 markdown\n\n没有技能信息").unwrap_err(),
            SkillParseError::NoFrontmatter
        );
    }

    #[test]
    fn rejects_empty_frontmatter() {
        let err = parse_skill_md("---\n---\n正文").unwrap_err();
        assert_eq!(
            err,
            SkillParseError::MissingFields(vec!["name".into(), "description".into()])
        );
    }

    #[test]
    fn reports_each_missing_field() {
        let only_name = parse_skill_md("---\nname: a\n---\n").unwrap_err();
        assert_eq!(
            only_name,
            SkillParseError::MissingFields(vec!["description".into()])
        );

        let only_desc = parse_skill_md("---\ndescription: d\n---\n").unwrap_err();
        assert_eq!(
            only_desc,
            SkillParseError::MissingFields(vec!["name".into()])
        );
    }

    #[test]
    fn empty_string_counts_as_missing_like_upstream() {
        // 上游用 JS 真值判断,空串与缺失同等对待
        let err = parse_skill_md("---\nname: \"\"\ndescription: d\n---\n").unwrap_err();
        assert_eq!(err, SkillParseError::MissingFields(vec!["name".into()]));
    }

    #[test]
    fn rejects_non_string_fields() {
        let err = parse_skill_md("---\nname: 42\ndescription: d\n---\n").unwrap_err();
        assert_eq!(
            err,
            SkillParseError::NotString {
                field: "name".into(),
                got: "数字".into()
            }
        );

        let err = parse_skill_md("---\nname: n\ndescription: [a, b]\n---\n").unwrap_err();
        assert_eq!(
            err,
            SkillParseError::NotString {
                field: "description".into(),
                got: "列表".into()
            }
        );
    }

    #[test]
    fn yaml_syntax_error_is_reported_not_panicked() {
        let err = parse_skill_md("---\nname: [unclosed\n---\n").unwrap_err();
        assert!(matches!(err, SkillParseError::Yaml(_)), "实际 {err:?}");
        assert!(err.reason().starts_with("技能信息格式有误"));
    }

    #[test]
    fn non_mapping_frontmatter_is_treated_as_missing_fields() {
        let err = parse_skill_md("---\n就是一句话\n---\n").unwrap_err();
        assert_eq!(
            err,
            SkillParseError::MissingFields(vec!["name".into(), "description".into()])
        );
    }

    #[test]
    fn handles_crlf_line_endings() {
        let raw = "---\r\nname: win\r\ndescription: 来自 Windows 仓库\r\n---\r\n正文\r\n";
        let parsed = parse_skill_md(raw).unwrap();
        assert_eq!(parsed.name, "win");
        assert_eq!(parsed.description, "来自 Windows 仓库");
    }

    #[test]
    fn handles_bom() {
        let raw = format!("\u{feff}{}", skill_md("bom", "带 BOM 的文件"));
        assert_eq!(parse_skill_md(&raw).unwrap().name, "bom");
    }

    #[test]
    fn multiline_description_is_folded_to_one_line() {
        let raw = "---\nname: n\ndescription: |\n  第一行\n  第二行\n---\n";
        assert_eq!(parse_skill_md(raw).unwrap().description, "第一行 第二行");
    }

    #[test]
    fn strips_terminal_escapes_from_metadata() {
        let raw = "---\nname: \"\\e[31m红色\\e[0m\"\ndescription: \"a\\u0007b\"\n---\n";
        let parsed = parse_skill_md(raw).unwrap();
        assert_eq!(parsed.name, "红色");
        assert_eq!(parsed.description, "ab");
    }

    #[test]
    fn detects_internal_metadata() {
        let raw = "---\nname: n\ndescription: d\nmetadata:\n  internal: true\n---\n";
        assert!(parse_skill_md(raw).unwrap().internal);
        // 只有布尔 true 算数
        let raw = "---\nname: n\ndescription: d\nmetadata:\n  internal: \"true\"\n---\n";
        assert!(!parse_skill_md(raw).unwrap().internal);
    }

    // ---- 清洗 ----

    #[test]
    fn sanitize_name_matches_upstream_rules() {
        assert_eq!(sanitize_name("Weekly Report"), "weekly-report");
        assert_eq!(sanitize_name("周报生成"), "unnamed-skill");
        assert_eq!(sanitize_name("my_skill.v2"), "my_skill.v2");
        // 连字符本身不在白名单内,连续的会被折成一个,再去掉首尾
        assert_eq!(sanitize_name("--leading--and-trailing--"), "leading-and-trailing");
        assert_eq!(sanitize_name("...dots..."), "dots");
        assert_eq!(sanitize_name("!!!"), "unnamed-skill");
        assert_eq!(sanitize_name(""), "unnamed-skill");
        assert_eq!(sanitize_name("A  B___C"), "a-b___c");
        assert_eq!(sanitize_name(&"x".repeat(300)).len(), MAX_NAME_LEN);
    }

    #[test]
    fn sanitize_name_defuses_path_traversal() {
        let got = sanitize_name("../../etc/passwd");
        assert!(!got.contains('/') && !got.contains('\\') && !got.starts_with('.'));
        assert_eq!(got, "etc-passwd");
    }

    #[test]
    fn strip_terminal_escapes_covers_sequence_families() {
        assert_eq!(strip_terminal_escapes("a\u{1b}[31mb"), "ab");
        assert_eq!(strip_terminal_escapes("a\u{1b}]0;标题\u{7}b"), "ab");
        assert_eq!(strip_terminal_escapes("a\u{1b}P x \u{1b}\\b"), "ab");
        assert_eq!(strip_terminal_escapes("a\u{1b}7b"), "ab");
        assert_eq!(strip_terminal_escapes("a\u{9b}b"), "ab");
        assert_eq!(strip_terminal_escapes("a\u{7f}b"), "ab");
        // 制表与换行保留
        assert_eq!(strip_terminal_escapes("a\tb\nc"), "a\tb\nc");
    }

    // ---- 发现规则 ----

    fn opts() -> DiscoverOptions {
        DiscoverOptions::default()
    }

    fn names(d: &Discovery) -> Vec<&str> {
        d.skills.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn root_itself_is_a_skill_returns_only_it() {
        let tree = MemTree::new()
            .with_skill("", "根技能")
            .with_skill("skills/其他", "其他技能");
        let d = discover_skills(&tree, "", &opts());
        assert_eq!(names(&d), vec!["根技能"]);
    }

    #[test]
    fn full_depth_keeps_scanning_past_root_skill() {
        let tree = MemTree::new()
            .with_skill("", "根技能")
            .with_skill("skills/其他", "其他技能");
        let d = discover_skills(
            &tree,
            "",
            &DiscoverOptions {
                full_depth: true,
                ..Default::default()
            },
        );
        assert_eq!(names(&d), vec!["根技能", "其他技能"]);
    }

    #[test]
    fn finds_skills_in_skills_dir() {
        let tree = MemTree::new()
            .with_skill("skills/a", "甲")
            .with_skill("skills/b", "乙");
        assert_eq!(names(&discover_skills(&tree, "", &opts())), vec!["甲", "乙"]);
    }

    #[test]
    fn finds_skills_two_levels_deep_in_container_dirs() {
        // skills/<类目>/<技能>/SKILL.md 这类目录布局
        let tree = MemTree::new().with_skill("skills/办公/周报", "周报");
        assert_eq!(names(&discover_skills(&tree, "", &opts())), vec!["周报"]);
    }

    #[test]
    fn finds_skills_in_curated_and_variants() {
        let tree = MemTree::new()
            .with_skill("skills/.curated/精选", "精选")
            .with_skill("skills/.experimental/实验", "实验")
            .with_skill("skills/.system/系统", "系统");
        let d = discover_skills(&tree, "", &opts());
        let got = names(&d);
        for expect in ["精选", "实验", "系统"] {
            assert!(got.contains(&expect), "缺 {expect},实际 {got:?}");
        }
    }

    #[test]
    fn finds_skills_in_agent_project_dirs() {
        let tree = MemTree::new()
            .with_skill(".claude/skills/克劳德", "克劳德")
            .with_skill(".github/skills/copilot", "copilot");
        let d = discover_skills(&tree, "", &opts());
        let got = names(&d);
        assert!(got.contains(&"克劳德") && got.contains(&"copilot"), "实际 {got:?}");
    }

    #[test]
    fn same_name_is_shadowed_by_first_found() {
        // skills/ 优先于 .claude/skills/,同名时前者胜出
        let tree = MemTree::new()
            .with_file(
                "skills/dup/SKILL.md",
                &skill_md("重名技能", "来自 skills 目录"),
            )
            .with_file(
                ".claude/skills/dup/SKILL.md",
                &skill_md("重名技能", "来自 claude 目录"),
            );
        let d = discover_skills(&tree, "", &opts());
        assert_eq!(d.skills.len(), 1);
        assert_eq!(d.skills[0].description, "来自 skills 目录");
        assert_eq!(d.skills[0].dir, "skills/dup");
    }

    #[test]
    fn does_not_descend_past_a_discovered_skill() {
        // 已是技能的目录内部即使还有 SKILL.md 也不再深挖
        let tree = MemTree::new()
            .with_skill("skills/外层", "外层")
            .with_skill("skills/外层/内层", "内层");
        assert_eq!(names(&discover_skills(&tree, "", &opts())), vec!["外层"]);
    }

    #[test]
    fn skips_ignored_directories() {
        let tree = MemTree::new()
            .with_skill("skills/正常", "正常")
            .with_skill("skills/node_modules/pkg", "不该出现")
            .with_skill("skills/dist/built", "也不该出现");
        assert_eq!(names(&discover_skills(&tree, "", &opts())), vec!["正常"]);
    }

    #[test]
    fn invalid_skill_does_not_break_others_and_is_reported() {
        let tree = MemTree::new()
            .with_skill("skills/好的", "好的")
            .with_file("skills/坏的/SKILL.md", "---\nname: 只有名字\n---\n");
        let d = discover_skills(&tree, "", &opts());
        assert_eq!(names(&d), vec!["好的"]);
        assert_eq!(d.skipped.len(), 1);
        assert_eq!(d.skipped[0].path, "skills/坏的/SKILL.md");
        assert!(d.skipped[0].reason.contains("description"), "{:?}", d.skipped[0]);
    }

    #[test]
    fn empty_repo_yields_nothing() {
        let tree = MemTree::new().with_file("README.md", "# 空仓库");
        let d = discover_skills(&tree, "", &opts());
        assert!(d.skills.is_empty() && d.skipped.is_empty());
    }

    #[test]
    fn falls_back_to_recursive_scan_when_priority_dirs_find_nothing() {
        // 三层深度不在优先扫描范围内,由递归兜底捞出来
        let tree = MemTree::new().with_skill("其他/很/深/的技能", "深藏");
        assert_eq!(names(&discover_skills(&tree, "", &opts())), vec!["深藏"]);
    }

    #[test]
    fn recursive_fallback_respects_depth_limit() {
        let deep = (0..=MAX_FALLBACK_DEPTH + 2)
            .map(|i| format!("层{i}"))
            .collect::<Vec<_>>()
            .join("/");
        let tree = MemTree::new().with_skill(&deep, "太深了");
        assert!(discover_skills(&tree, "", &opts()).skills.is_empty());
    }

    #[test]
    fn internal_skills_are_hidden_unless_requested() {
        let tree = MemTree::new().with_file(
            "skills/内部/SKILL.md",
            "---\nname: 内部技能\ndescription: d\nmetadata:\n  internal: true\n---\n",
        );
        assert!(discover_skills(&tree, "", &opts()).skills.is_empty());

        let d = discover_skills(
            &tree,
            "",
            &DiscoverOptions {
                include_internal: true,
                ..Default::default()
            },
        );
        assert_eq!(names(&d), vec!["内部技能"]);
    }

    #[test]
    fn discovery_works_from_a_subpath_base() {
        // 商店页扫描的是解压后的压缩包,内容在 "repo-main/" 这一层下
        let tree = MemTree::new().with_skill("repo-main/skills/甲", "甲");
        assert_eq!(
            names(&discover_skills(&tree, "repo-main", &opts())),
            vec!["甲"]
        );
    }

    #[test]
    fn detects_executable_scripts() {
        let files = vec![
            "skills/a/SKILL.md".to_string(),
            "skills/a/scripts/collect.py".to_string(),
            "skills/b/SKILL.md".to_string(),
            "skills/b/templates/dept.md".to_string(),
        ];
        assert!(has_executable_scripts("skills/a", &files));
        assert!(!has_executable_scripts("skills/b", &files));
    }
}
