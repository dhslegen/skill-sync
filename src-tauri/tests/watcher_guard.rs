//! 文本级守卫(终审 I-3):**写盘的 core 编排函数必须在开头持有
//! `watcher::app_write()`**,期间的文件事件不上报给界面。
//!
//! # 为什么值得一条守卫
//!
//! `core/watcher.rs` 的模块头把这条规矩写死了,但它此前**只是一段文字**。
//! M4 定下那批调用方(`acquire` ×2 / `remove` / `create`)之后,v6 二期新增了
//! 三条写盘路径(`converge::set_agents` / `converge::keep_version` /
//! `share::share`)——**一条都没拿守卫**,而任务 5 同期把监听根从"只盯 canonical"
//! 扩到 canonical + 全部工具目录共 8 个根,新模型下本体就住在那些目录里。
//! 表现是显示层错乱:勾一个工具 → 往 `~/.claude/skills/` 写链接(macOS 上走
//! Finder,可能耗时数秒)→ 监听上报 → 界面在动作进行到一半时替换整张列表,
//! 勾在半途跳变。不丢数据,但 `lib/ipc.ts` 与 `hooks/useLocalRefresh.ts` 里
//! 那两句"core 已经滤掉本应用自己写盘引发的事件"当时是**假话**。
//!
//! # 🔴 它守什么、不守什么(明写,别让下一个人以为它管得比实际多)
//!
//! **守的是"名单里这几个别被摘掉"**——名单是人工维护的常量。
//! **守不住"新写的第八个编排忘了拿"**:那需要判断"这个函数会不会写盘",
//! 文本匹配做不到,而做不到的事不该假装做到(本分支已因"声称范围大于实际"
//! 被打回四次)。加新的写盘编排时,自己拿一个守卫并把它加进 [`GUARDED`]。
//!
//! **刻意不写运行时并发测试**:`APP_WRITING` 是进程全局的原子量,
//! `core::watcher::guard_is_reentrant_and_restores_on_drop` 已经因为这一点
//! 有过并发假红(CLAUDE.md 登记在案)。再加一条碰它的测试是往同一个坑里跳。

use std::path::Path;

/// 受守卫的写盘编排:`(文件, 函数签名的起始片段)`。
///
/// 函数用**签名片段**定位而不是函数名:`pub fn set_agents(` 这样的写法在文件里
/// 唯一,而裸函数名会撞上文档注释里的引用与调用点。
const GUARDED: [(&str, &str); 7] = [
    // `acquire` / `acquire_prefetched` 两个入口都只是薄壳,预检→落盘→建链→记账
    // 全在共用的尾巴 `finish` 里,守卫也在那儿——**守 `finish` 才是守真东西**。
    ("core/acquire.rs", "async fn finish("),
    ("core/acquire.rs", "pub async fn acquire_batch("),
    ("core/remove.rs", "pub fn remove("),
    ("core/create.rs", "pub fn create_skill("),
    ("core/converge.rs", "pub fn set_agents("),
    ("core/converge.rs", "pub fn keep_version("),
    ("core/share.rs", "pub async fn share("),
];

/// 函数体里允许在守卫之前出现多少**非空代码行**(注释已剥掉,留下的空行不计)。
///
/// 不写死"第一行":给一点余量容纳无害的前置(比如先算一个纯路径)。但拦得住
/// "先干点别的再拿"——真正要防的是守卫排在**写盘之后**,那时它一个事件也拦不住。
const MAX_LINES_BEFORE_GUARD: usize = 6;

const GUARD_CALL: &str = "watcher::app_write()";

/// 剥掉注释与字符串字面量的内容(与 `tests/body_guard.rs::strip_comments` 同款,
/// 逐字符扫描、不做完整语法分析)。
///
/// 🔴 **必须先剥再找**,两个理由各自都足够:
/// - 参数表的注释里有括号(`finish` 的 `` (`fsops::SYSTEM_TRASH`) ``),不剥的话
///   下面按括号配对找函数体开头会当场错位;
/// - 文档注释里提到 `watcher::app_write()` 会让守卫**认注释当代码**——删掉真实
///   调用、只留一句说明它照样绿(本项目在 `plaza_ensure_repo` 那条守卫上
///   复现过这个空转,注入验证抓到的)。
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
            '"' => {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 2;
                        continue;
                    }
                    i += 1;
                }
                i += 1;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    out
}

fn source_of(file: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()));
    strip_comments(&raw)
}

/// 从签名片段末尾的 `(` 起配对括号,再跳到紧随其后的 `{`——那就是函数体的开头。
fn body_start(src: &str, sig_at: usize, signature: &str) -> usize {
    let open = sig_at + signature.len() - 1; // 指向签名片段末尾的 `(`
    let chars: Vec<(usize, char)> = src.char_indices().skip_while(|(i, _)| *i < open).collect();
    let mut depth = 0usize;
    let mut k = 0usize;
    while k < chars.len() {
        match chars[k].1 {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        k += 1;
    }
    while k < chars.len() && chars[k].1 != '{' {
        k += 1;
    }
    chars.get(k).map(|(i, _)| *i).unwrap_or(src.len())
}

#[test]
fn every_disk_writing_orchestration_holds_the_watcher_guard_up_front() {
    for (file, signature) in GUARDED {
        let src = source_of(file);
        // 注释已剥掉,所以剩下的 `signature` 命中都是真代码;取最后一次出现,
        // 稳住"同一个片段在文件里出现多次"的情形(今天不存在,但改不坏)。
        let at = src
            .rfind(signature)
            .unwrap_or_else(|| panic!("{file} 里找不到 `{signature}` —— 函数改名了?守卫名单要跟着改"));
        let body = &src[body_start(&src, at, signature)..];
        // 🔴 **只数非空行**:剥注释会在原地留下一串空行(`finish` 的守卫前面就有
        // 五行注释),按物理行数会把守卫挤出窗口——那样这条守卫会对**做对了的
        // 代码**报红,而红的原因与它想说的话毫无关系。
        let found_at_line = body
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(MAX_LINES_BEFORE_GUARD)
            .position(|l| l.contains(GUARD_CALL));
        assert!(
            found_at_line.is_some(),
            "{file} 的 `{signature}` 函数体前 {MAX_LINES_BEFORE_GUARD} 个非空行里没有 `{GUARD_CALL}`。\n\
             写盘期间不持有它,本应用自己造的文件事件会被当成外部改动上报,\n\
             界面会在动作进行到一半时替换整张列表(见 core/watcher.rs 模块头)。"
        );
    }
}

/// 守卫的自保:名单里的文件路径与签名必须真的存在。
///
/// 上一条测试用 `rfind` + panic 已经覆盖了"函数改名",这一条覆盖另一半——
/// **名单被人整个清空或改短**时,上一条会静默变成零次循环、照样绿。
#[test]
fn the_guarded_list_is_not_silently_shrinking() {
    assert_eq!(
        GUARDED.len(),
        7,
        "写盘编排的名单变了。缩短它之前先确认那个函数真的不写盘了,\
         而不是「守卫碍事所以删掉一行」"
    );
}
