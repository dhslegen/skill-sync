//! 本地技能目录的文件监听(M4 任务 6c 级别 3)。
//!
//! 用户在编辑器里改完 `SKILL.md`,不切窗口也该看到列表更新。级别 1(窗口焦点)与
//! 级别 2(切页)覆盖了绝大多数场景,这一级补的是"应用和编辑器并排放着"那种用法。
//!
//! # 头号风险:它会对**本应用自己的写入**触发
//!
//! 每一次获取/更新/移除/新建都在往 canonical 写,而 `Installer::install` 是
//! **清空后重建**——监听器会在目录空着或只写了一半时触发,前端拿这个瞬间去扫描,
//! 技能会凭空消失再出现,最坏的情况是用户对着一个半写状态做决定。
//! 单纯加防抖救不了:一次安装比任何合理的防抖窗口都长。
//!
//! 正确的框法是:**监听器只负责"不是本应用造成的变更"**。应用自己发起的每一次
//! 改动都已经显式刷新过界面了([`crate::commands`] 各处的 `refreshInstalled` /
//! `load`),不需要监听器再说一遍。
//!
//! 落地是 [`app_write`] 这个 RAII 守卫:所有会写盘的 command 在执行期间持有它,
//! 期间的文件事件一律丢弃;释放之后还要再静默 [`QUIET_AFTER_WRITE_MS`] 毫秒
//! ——FSEvents / ReadDirectoryChangesW 的投递都有延迟,写完那一刻的事件往往
//! 在守卫释放之后才到。
//!
//! # 多根监听(v6 二期任务 5 起)
//!
//! 原先**只盯 canonical**,理由是"用户手改技能内容改的是 canonical 里的本体,
//! agent 目录里多半是指向它的链接"。v6 二期把这个前提推翻了:**本体住在它现在
//! 所在的地方,永不搬动**——用户在 `~/.claude/skills/` 下开发的技能,本体就在
//! 那里,canonical 里才是指向它的链接。只盯 canonical 就等于对最典型的编辑场景
//! 视而不见。
//!
//! 现在盯 canonical + **每一个已经存在的**工具全局技能目录。不存在的目录
//! **不建、不盯**(绝不创建用户没要求的目录),它出现之后靠级别 1(窗口焦点)
//! 与级别 2(切页)补上。
//!
//! ⚠️ **「盯哪些目录」与「哪些变更算数」是两份清单,别合并**:
//! - [`watch_roots`] 给 `notify` 用,canonical 不存在时**退到它的父目录**
//!   (`~/.agents`)——那正是为了看见 canonical 被创建的那一刻;
//! - [`is_interesting`] 用的是**关心的根**(canonical + 全部工具目录,与存不存在
//!   无关)。拿 watch 清单去判的话,盯着 `~/.agents` 时
//!   `~/.agents/.skill-lock.json` 会被判成"值得刷新"——那是 npx skills 的文件,
//!   与技能列表无关(既有测试正面钉住这一条)。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

/// 本应用写盘结束后继续静默的时长。
///
/// 取值依据:文件事件的投递是异步的,写完那一刻的事件常常在守卫释放之后才到。
/// 太短会漏掉自造事件(前端读到半写状态),太长会让用户的真实改动迟迟不反映。
pub const QUIET_AFTER_WRITE_MS: u64 = 800;

/// 攒够多久没有新事件才上报一次。编辑器保存一个文件会产生好几个事件
/// (写临时文件 → rename → 改 mtime),不攒的话一次保存要刷好几遍界面。
pub const DEBOUNCE_MS: u64 = 400;

/// 前端订阅的事件名。载荷为空——它只是"去重新扫描一下"的信号,
/// 具体变了什么由前端各自的 `load()` 去查。
pub const CHANGED_EVENT: &str = "local-skills://changed";

/// 正在进行中的本应用写操作数(可嵌套:批量获取里每个技能各持一个)。
static APP_WRITING: AtomicUsize = AtomicUsize::new(0);
/// 最后一次本应用写操作结束的时刻(进程启动以来的毫秒数)。
static LAST_WRITE_END_MS: AtomicU64 = AtomicU64::new(0);

/// 进程启动以来的毫秒数。用单调时钟,不受系统时间调整影响。
///
/// **基准必须尽早钉死**:`OnceLock` 是首次调用时才初始化,那一次的 `elapsed()`
/// 必然是 0。配上 `LAST_WRITE_END_MS` 的初值 0,`should_report_at(0, 0, 0)` 算出
/// `0 - 0 >= 800` = false——**第一次外部文件变更必然被当成"本应用刚写完"吞掉**。
/// 2026-08-04 真机验证抓到:纯逻辑单测直接传参,根本走不到这条惰性初始化的路。
/// 现由 [`init_clock`] 在监听线程起来时先钉一次,判定里另有"从未写过"的分支兜底。
pub fn now_ms() -> u64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    // **+1 保证永不返回 0**:0 被 `should_report_at` 当作"本应用从未写过盘"的哨兵,
    // 而守卫在首次调用时 drop 会正好拿到 elapsed=0,把静音悄悄取消掉——
    // 同一个 bug 的另一面。偏移 1ms 对 800/400ms 的阈值毫无影响。
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

/// 把单调时钟的基准钉在此刻。监听线程启动时调一次,让后续的 `now_ms()` 从这里计时。
pub fn init_clock() {
    let _ = now_ms();
}

/// 标记"本应用正在写盘"的 RAII 守卫,持有期间文件监听不上报。
///
/// 用 RAII 而不是手动 begin/end:写路径上有 `?` 提前返回,手动配对迟早漏掉一处,
/// 而漏掉的表现是监听器从此永久静音——最难发现的那种坏法。
pub struct WriteGuard;

impl WriteGuard {
    fn new() -> Self {
        APP_WRITING.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        LAST_WRITE_END_MS.store(now_ms(), Ordering::SeqCst);
        APP_WRITING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 声明"接下来这段是本应用在写盘"。守卫存活期间与其后的静默期内,文件事件被丢弃。
pub fn app_write() -> WriteGuard {
    WriteGuard::new()
}

/// 此刻的文件变更该不该上报给前端。
///
/// 纯函数式的判定(时间从参数进来),因而可以直接单测,不必等真实时钟。
///
/// `last_write_end_ms == 0` 表示**本应用还没写过盘**,此时任何变更都是外面来的,
/// 直接放行——不能拿"距离 0 时刻不足 800ms"去判它(那正是上面说的那个真机缺陷)。
pub fn should_report_at(writing: usize, last_write_end_ms: u64, now: u64) -> bool {
    if writing != 0 {
        return false;
    }
    last_write_end_ms == 0 || now.saturating_sub(last_write_end_ms) >= QUIET_AFTER_WRITE_MS
}

/// 读当前的全局状态做判定。
pub fn should_report() -> bool {
    should_report_at(
        APP_WRITING.load(Ordering::SeqCst),
        LAST_WRITE_END_MS.load(Ordering::SeqCst),
        now_ms(),
    )
}

/// 这个路径的变更值得刷新界面吗。
///
/// `roots` 是**关心的根**(canonical + 各工具全局技能目录),不是 watch 清单
/// ——两者的区别见模块头。任一根之下命中即算数;排除名单对**每一个**根都生效。
///
/// 排除规则**复用 [`crate::core::fsops::is_excluded_rel`]**——那份名单决定了哪些
/// 文件不参与内容 hash,不参与 hash 就不可能改变任何界面上的判断,为它刷新纯属
/// 白费。两份实现迟早漂移(本项目记录的空转测试模式 #1)。
pub fn is_interesting(roots: &[PathBuf], changed: &Path) -> bool {
    roots.iter().any(|root| is_interesting_under(root, changed))
}

fn is_interesting_under(root: &Path, changed: &Path) -> bool {
    let Ok(rel) = changed.strip_prefix(root) else {
        return false; // 根之外的(比如 .skill-lock.json)不关我们的事
    };
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if rel_str.is_empty() {
        return true; // 根自身被创建/删除
    }
    !crate::core::fsops::is_excluded_rel(&rel_str)
}

/// 监听要盯的目录。
///
/// 盯的是 canonical 的**父目录**(`~/.agents`)而不是 canonical 本身:新用户还没装过
/// 任何技能时 canonical 并不存在,而 `notify` 对不存在的路径直接报错。父目录一般
/// 已经在了(`.skill-lock.json` 也放那儿)。父目录也不在就返回 `None`——
/// **绝不去创建用户没要求的目录**,降级到级别 1 与 2 即可。
pub fn watch_root(canonical: &Path) -> Option<PathBuf> {
    if canonical.is_dir() {
        return Some(canonical.to_path_buf());
    }
    canonical.parent().filter(|p| p.is_dir()).map(|p| p.to_path_buf())
}

/// 要交给 `notify` 的全部监听根:canonical 走 [`watch_root`] 的既有规则
/// (不存在就退到父目录),工具目录**只收已经存在的**。
///
/// 工具目录刻意**不退到父目录**:那些父目录(`~/.claude`、`~/.trae`…)是别的
/// 工具的家,里面的配置文件、缓存、会话记录都在变,盯上去换来的全是噪音——
/// 而 canonical 的父目录 `~/.agents` 只放 `.skill-lock.json` 与 `skills/`,
/// 代价小得多。目录不存在就**不建、不盯**(绝不创建用户没要求的目录),
/// 它出现之后靠窗口焦点/切页那两级刷新补上。
///
/// canonical 排在最前,其余按传入顺序;重复的目录去掉(多个 agent 共用一个
/// 目录是常态,`group_by_global_dir` 的键已经去过重,但 canonical 可能与某个
/// 工具目录重合,比如 `CLAUDE_CONFIG_DIR` 指到 `~/.agents` 那种)。
pub fn watch_roots(canonical: &Path, tool_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(root) = watch_root(canonical) {
        out.push(root);
    }
    for dir in tool_dirs {
        if dir.is_dir() && !out.contains(dir) {
            out.push(dir.clone());
        }
    }
    out
}

/// 防抖累加器:攒住事件,直到静默 [`DEBOUNCE_MS`] 才吐一次。
///
/// 单独抽出来是为了能直接单测——时间从参数进来,不依赖真实时钟,
/// 更不依赖 FSEvents / ReadDirectoryChangesW 各自的合并策略(那是 OS 行为,
/// 断言它等于给 CI 埋一颗定时炸弹)。
#[derive(Debug, Default)]
pub struct Debouncer {
    pending_since: Option<u64>,
    last_event_ms: u64,
}

impl Debouncer {
    /// 记下一个事件。
    pub fn record(&mut self, now: u64) {
        self.pending_since.get_or_insert(now);
        self.last_event_ms = now;
    }

    /// 到点了吗——有攒着的事件,且距最后一个事件已静默够久。
    /// 返回 true 时内部状态被清空,下一轮重新攒。
    pub fn take_due(&mut self, now: u64) -> bool {
        if self.pending_since.is_none() {
            return false;
        }
        if now.saturating_sub(self.last_event_ms) < DEBOUNCE_MS {
            return false;
        }
        self.pending_since = None;
        true
    }

    pub fn has_pending(&self) -> bool {
        self.pending_since.is_some()
    }
}

/// 轮询间隔:防抖到点的检查频率。比 [`DEBOUNCE_MS`] 短即可。
pub const TICK: Duration = Duration::from_millis(150);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_writes_are_never_reported() {
        // 写操作进行中:无论距上次写多久都不报
        assert!(!should_report_at(1, 0, 10_000_000));
        assert!(!should_report_at(3, 0, 10_000_000));
    }

    /// 应用还没写过盘时,任何变更都是外面来的,必须放行。
    ///
    /// 这一条钉的是 2026-08-04 真机验证抓到的缺陷:`now_ms()` 首次调用返回 0、
    /// `LAST_WRITE_END_MS` 初值也是 0,于是 `0 - 0 >= 800` 为假,
    /// **第一次外部变更被整个吞掉**。纯逻辑单测直接传参,走不到那条惰性初始化的路
    /// ——所以这里必须显式把 "从未写过" 这一档钉住。
    #[test]
    fn the_very_first_external_change_is_never_swallowed() {
        assert!(should_report_at(0, 0, 0), "从未写过盘 + 时钟刚起步,也必须上报");
        assert!(should_report_at(0, 0, 5));
        assert!(should_report_at(0, 0, 10_000_000));
    }

    #[test]
    fn quiet_period_outlasts_the_guard() {
        // 守卫刚释放,事件还在路上——这正是 Installer::install 落盘/替换本体的那一瞬
        assert!(!should_report_at(0, 1_000, 1_000));
        assert!(!should_report_at(0, 1_000, 1_000 + QUIET_AFTER_WRITE_MS - 1));
        // 静默期满,用户自己的改动可以报了
        assert!(should_report_at(0, 1_000, 1_000 + QUIET_AFTER_WRITE_MS));
    }

    #[test]
    fn the_clock_never_reports_zero() {
        // 0 是"从未写过盘"的哨兵。时钟要是也会返回 0,守卫 drop 时就会把
        // 自己的静音取消掉(真机验证抓到的缺陷的另一面)
        assert!(now_ms() > 0);
        init_clock();
        assert!(now_ms() > 0);
    }

    #[test]
    fn guard_is_reentrant_and_restores_on_drop() {
        // 批量获取里每个技能各持一个守卫,不能互相把对方的静音解除
        assert_eq!(APP_WRITING.load(Ordering::SeqCst), 0);
        {
            let _a = app_write();
            assert_eq!(APP_WRITING.load(Ordering::SeqCst), 1);
            {
                let _b = app_write();
                assert_eq!(APP_WRITING.load(Ordering::SeqCst), 2);
            }
            assert_eq!(APP_WRITING.load(Ordering::SeqCst), 1, "内层释放不该清零");
        }
        assert_eq!(APP_WRITING.load(Ordering::SeqCst), 0);
        // 释放后处在静默期里
        assert!(!should_report());
    }

    #[test]
    fn debouncer_waits_for_silence_then_fires_once() {
        let mut d = Debouncer::default();
        assert!(!d.take_due(0), "没有事件时不该触发");

        // 编辑器保存一个文件会连着来好几个事件
        d.record(100);
        d.record(150);
        d.record(200);
        assert!(!d.take_due(200 + DEBOUNCE_MS - 1), "还没静默够");
        assert!(d.take_due(200 + DEBOUNCE_MS), "静默够了,吐一次");
        assert!(!d.take_due(999_999), "吐过就清空,不会重复触发");
        assert!(!d.has_pending());
    }

    #[test]
    fn a_new_event_extends_the_window_rather_than_firing_mid_save() {
        let mut d = Debouncer::default();
        d.record(0);
        // 快到点时又来一个:窗口顺延,不能在保存进行到一半时就刷
        d.record(DEBOUNCE_MS - 10);
        assert!(!d.take_due(DEBOUNCE_MS));
        assert!(d.take_due(DEBOUNCE_MS - 10 + DEBOUNCE_MS));
    }

    #[test]
    fn only_changes_inside_canonical_matter() {
        let canonical = PathBuf::from("/home/u/.agents/skills");
        let roots = vec![canonical.clone()];
        assert!(is_interesting(&roots, Path::new("/home/u/.agents/skills/wr/SKILL.md")));
        assert!(is_interesting(&roots, &canonical), "canonical 自身被建/删也算");
        // lock 在父目录里,是 npx skills 的东西,与界面上的技能列表无关
        assert!(!is_interesting(&roots, Path::new("/home/u/.agents/.skill-lock.json")));
        assert!(!is_interesting(&roots, Path::new("/home/u/other/x")));
    }

    /// 与内容 hash 共用同一份排除名单:不参与 hash 就改不了界面上的任何判断,
    /// 为它刷新纯属白费。这里的样本要跟着 `fsops` 的名单走,不能另猜一份。
    ///
    /// ⚠️ 这里原先写着「`.DS_Store` 不在名单里,所以它确实会触发一次刷新」
    /// ——**v6 二期任务 1 已经把它连同 `Thumbs.db`/`desktop.ini` 一起加进
    /// `EXCLUDE_FILES`**(那条真缺陷是"访达开一次目录就让内容指纹漂移"),
    /// 那句注释从那一刻起就成了假话。现在正面钉住它**不**触发刷新。
    #[test]
    fn excluded_files_do_not_trigger_a_refresh() {
        let roots = vec![PathBuf::from("/home/u/.agents/skills")];
        assert!(!is_interesting(&roots, Path::new("/home/u/.agents/skills/wr/.git/HEAD")));
        assert!(!is_interesting(&roots, Path::new("/home/u/.agents/skills/wr/metadata.json")));
        assert!(!is_interesting(&roots, Path::new("/home/u/.agents/skills/wr/.DS_Store")));
        assert!(!is_interesting(
            &roots,
            Path::new("/home/u/.agents/skills/wr/__pycache__/x.pyc")
        ));
        assert!(is_interesting(&roots, Path::new("/home/u/.agents/skills/wr/scripts/run.sh")));
        assert!(is_interesting(&roots, Path::new("/home/u/.agents/skills/wr/SKILL.md")));
    }

    /// 多根(v6 二期任务 5):工具目录也算数,不存在的**不盯也不建**。
    #[test]
    fn changes_under_any_root_are_interesting_and_missing_tool_dirs_are_not_watched() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = tmp.path().join(".agents/skills");
        let claude = tmp.path().join(".claude/skills");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::create_dir_all(&claude).unwrap();
        let ghost = tmp.path().join(".trae/skills");

        let roots = watch_roots(&canonical, &[claude.clone(), ghost.clone()]);
        assert_eq!(roots, vec![canonical.clone(), claude.clone()], "不存在的工具目录不盯、不建");
        assert!(!ghost.exists(), "绝不创建用户没要求的目录");

        assert!(is_interesting(&roots, &claude.join("s/SKILL.md")));
        assert!(is_interesting(&roots, &canonical.join("s/SKILL.md")), "canonical 照旧算数");
        assert!(!is_interesting(&roots, &claude.join("s/.DS_Store")), "排除名单对每个根都生效");
        // `.claude/settings.json` 在技能目录**之外**:那是 Claude Code 自己的配置
        assert!(!is_interesting(&roots, &tmp.path().join(".claude/settings.json")));
        // 没被盯上的工具目录同样不算数
        assert!(!is_interesting(&roots, &ghost.join("s/SKILL.md")));
    }

    /// canonical 不存在时退到父目录,而**关心的根仍然是 canonical 本身**
    /// ——两份清单不能合并(见模块头)。
    #[test]
    fn watching_the_parent_does_not_make_the_lock_file_interesting() {
        let tmp = tempfile::tempdir().unwrap();
        let agents = tmp.path().join(".agents");
        let canonical = agents.join("skills");
        std::fs::create_dir_all(&agents).unwrap();

        let watch = watch_roots(&canonical, &[]);
        assert_eq!(watch, vec![agents.clone()], "canonical 不在时退到父目录才盯得住它被创建");

        // `commands::spawn_watcher` 判"值不值得刷新"用的是**关心的根**,不是 watch 清单
        let interest = vec![canonical.clone()];
        assert!(is_interesting(&interest, &canonical.join("s/SKILL.md")));
        assert!(
            !is_interesting(&interest, &agents.join(".skill-lock.json")),
            "lock 是 npx skills 的文件,与技能列表无关"
        );
    }

    #[test]
    fn watch_root_never_creates_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let agents = tmp.path().join(".agents");
        let canonical = agents.join("skills");

        // 两个都不存在:不监听,也**不创建**
        assert_eq!(watch_root(&canonical), None);
        assert!(!agents.exists(), "绝不创建用户没要求的目录");

        // 只有父目录在(新用户还没装过技能):盯父目录
        std::fs::create_dir_all(&agents).unwrap();
        assert_eq!(watch_root(&canonical), Some(agents.clone()));
        assert!(!canonical.exists());

        // canonical 也在了:直接盯它,范围更窄
        std::fs::create_dir_all(&canonical).unwrap();
        assert_eq!(watch_root(&canonical), Some(canonical));
    }
}
