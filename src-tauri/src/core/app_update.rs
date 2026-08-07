//! App 自更新的纯逻辑(M6 任务 1)。
//!
//! 下载安装的插件调用只能在 commands 层(要 AppHandle);这里放全部可单测的判定:
//! - `ReadyState`:进程内就绪记账 + 下载互斥。tauri updater 的 `check()` 比较的是
//!   **运行中进程**的版本与远端 latest,新版装完(等重启)之后它照样返回 Available
//!   ——"已就绪"这件事只有我们自己记得,这就是本结构存在的理由。
//! - `should_notify`:窗口可见就不发系统通知(左下角 pill 已经在),不可见才发
//!   ——同一件事只打扰一次(2026-08-06 拍板)。
//! - `ready_notification`:通知文案,只报版本号,对齐 `scheduler::notification_copy`
//!   的姿态(可单测、禁 git 术语、禁内部标识)。

use serde::Serialize;
use std::sync::Mutex;

/// 检查结果分类。serde 契约与前端 `lib/ipc.ts` 的 `AppUpdateStatus` 一一对应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum AppUpdateStatus {
    UpToDate,
    Available { version: String },
    /// 新版已在后台下载安装完毕,重启即生效。
    Ready { version: String },
}

#[derive(Debug, Default)]
struct Inner {
    /// 装好等重启的版本。
    ready: Option<String>,
    /// 有一轮下载正在进行(启动探测与 scheduler 轮可能同时到)。
    in_flight: bool,
    /// **已下载、但还没安装**的安装包字节(Windows 专用,见 `finish_download` 的说明)。
    /// macOS 走"下载即安装",这里永远是 None。
    pending_install: Option<Vec<u8>>,
}

/// 进程内的就绪记账。不落盘:重启之后运行的就是新版,这份状态天然作废。
#[derive(Debug, Default)]
pub struct ReadyState {
    inner: Mutex<Inner>,
}

impl ReadyState {
    /// 这一轮要不要下载安装 `version`:已就绪同版本、或有人正在装 → 不装;
    /// 否则占坑(返回 true 的调用方**必须**以 finish/abort 收尾,不然互斥永远不放)。
    pub fn begin_stage(&self, version: &str) -> bool {
        let mut inner = self.inner.lock().expect("app_update 状态锁不该中毒");
        if inner.in_flight || inner.ready.as_deref() == Some(version) {
            return false;
        }
        inner.in_flight = true;
        true
    }

    /// 装完:记下就绪版本,放开互斥。
    pub fn finish_stage(&self, version: &str) {
        let mut inner = self.inner.lock().expect("app_update 状态锁不该中毒");
        inner.ready = Some(version.to_string());
        inner.in_flight = false;
    }

    /// **下载完但没安装**:记下就绪版本并留住安装包字节,放开互斥。
    ///
    /// 只有 Windows 走这条。原因是平台硬限制:Windows replacing 不了正在运行的 exe,
    /// tauri 的 `install()` 会**先 `std::process::exit(0)` 把应用杀掉**再跑安装程序
    /// (见 tauri-plugin-updater 的 `on_before_exit` 注释)。
    /// 所以"静默装好 + 提示重启"这个模型在 Windows 上根本不成立——"装好"就等于
    /// "应用已经没了"。2026-08-07 用户在 Windows 真机上问的正是这个:
    /// 应用用着用着自己退出并更新,而不是像 macOS 那样静默备好、由他挑时机。
    ///
    /// 改成:下载完只**留住字节**(内容确实已备好,`ready` 语义与 macOS 一致,
    /// 前端那个 pill 一个字都不用改),等用户点了重启才 `install()`。
    /// 代价是安装包字节常驻内存到用户点击为止(Windows 包约 5MB),
    /// 换来的是"退出这件事由用户按下按钮触发",不再打断正在做的事。
    pub fn finish_download(&self, version: &str, bytes: Vec<u8>) {
        let mut inner = self.inner.lock().expect("app_update 状态锁不该中毒");
        inner.ready = Some(version.to_string());
        inner.pending_install = Some(bytes);
        inner.in_flight = false;
    }

    /// 取出待安装的字节(**取走即清空**)。
    ///
    /// 清空是防重复安装的关键:`install()` 在 Windows 上不返回(进程直接退出),
    /// 但万一它失败了并返回,重启流程会继续往下走——这时若字节还在,
    /// 下一次点重启会拿着同一份包再装一次。
    pub fn take_pending_install(&self) -> Option<Vec<u8>> {
        self.inner.lock().expect("app_update 状态锁不该中毒").pending_install.take()
    }

    /// 装失败:只放开互斥,不记就绪。半份下载的字节一并丢掉,不留给下一轮用。
    pub fn abort_stage(&self) {
        let mut inner = self.inner.lock().expect("app_update 状态锁不该中毒");
        inner.in_flight = false;
        inner.pending_install = None;
    }

    pub fn ready_version(&self) -> Option<String> {
        self.inner.lock().expect("app_update 状态锁不该中毒").ready.clone()
    }

    /// 把 updater 的检查结果分类给前端。`remote` = 远端公告的新版本(None = 没有新版)。
    /// 远端没有的版本不冒充有:就绪版本只有在与远端一致时才升级成 Ready。
    pub fn classify(&self, remote: Option<&str>) -> AppUpdateStatus {
        match remote {
            None => AppUpdateStatus::UpToDate,
            Some(version) if self.ready_version().as_deref() == Some(version) => {
                AppUpdateStatus::Ready { version: version.to_string() }
            }
            Some(version) => AppUpdateStatus::Available { version: version.to_string() },
        }
    }
}

/// 系统通知的发送判定。`window_visible`:None = 窗口都没了(拿不到句柄),照发。
pub fn should_notify(window_visible: Option<bool>) -> bool {
    window_visible != Some(true)
}

/// App 自更新的检查间隔(用户拍板:1 分钟)。
///
/// 一个 latest.json 的 GET 而已,内网每分钟一次可以忽略不计;换来的是
/// "发版之后一分钟内,用户那边就自己装好并提示重启"。
pub const CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// 下一次 App 自更新检查要不要排、隔多久。
///
/// **与技能检查的档位彻底无关**(M6 任务 6 修,原设计是错的):此前 App 检查寄生在
/// 技能检查那一拍上,于是技能设「手动」时 `scheduler::next_delay` 返回 `None`、
/// 调度循环根本不 tick,App 自更新就只剩"启动后 20 秒"那一次
/// ——0.3.1 在那之后才发布,用户等到的是"什么都没发生"(2026-08-06 实测)。
pub fn next_check_delay(app_auto_update: bool) -> Option<std::time::Duration> {
    app_auto_update.then_some(CHECK_INTERVAL)
}

/// 从可执行文件路径推出它所属的 `.app` 包(macOS 重启用)。
///
/// **为什么需要它**:`tauri::AppHandle::restart()` 是直接 spawn 包内的可执行文件,
/// 绕开了 LaunchServices。macOS 上这样起的新进程,在父进程随即退出时**拿不到激活权**
/// ——窗口建出来了却沉在所有应用后面,用户看到的是"重启完没有界面,
/// 点一下程序坞图标才出来"(2026-08-06 实测,对照组见下)。
///
/// 实测对照(旧实例在新实例起来后立刻退出,与 restart 同一时序):
/// - 直接跑 `SkillSync.app/Contents/MacOS/skillsync` → `frontmost: false`
/// - `open -n -a SkillSync.app`(走 LaunchServices)→ `frontmost: true`
///
/// 认不出 `.app` 结构就返回 `None`(dev 构建就是这一档),调用方回退到 `restart()`。
pub fn macos_bundle_path(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let macos_dir = exe.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos_dir.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// 就绪通知文案(标题, 正文)。
pub fn ready_notification(version: &str) -> (String, String) {
    (
        "应用更新".to_string(),
        format!("SkillSync {version} 已在后台就绪,重启应用即可完成更新。"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_lifecycle_dedupes_by_version() {
        let s = ReadyState::default();
        assert!(s.begin_stage("0.3.1"), "第一次要装");
        assert!(!s.begin_stage("0.3.1"), "同版本正在装,不重复下载");
        s.finish_stage("0.3.1");
        assert_eq!(s.ready_version().as_deref(), Some("0.3.1"));
        assert!(!s.begin_stage("0.3.1"), "已就绪同版本,不再装");
        assert!(s.begin_stage("0.3.2"), "更新的版本要重新装(0.3.1 就绪期间 0.3.2 发布)");
    }

    #[test]
    fn abort_releases_the_lock_without_marking_ready() {
        let s = ReadyState::default();
        assert!(s.begin_stage("0.3.1"));
        s.abort_stage();
        assert_eq!(s.ready_version(), None, "失败不算就绪");
        assert!(s.begin_stage("0.3.1"), "失败后下一轮可以重试同版本");
    }

    /// Windows 那条路:下载完只留字节不安装,对外的就绪语义与 macOS 完全一致
    /// (前端那个 pill 因此一个字都不用改)。
    #[test]
    fn downloaded_but_not_installed_still_counts_as_ready() {
        let s = ReadyState::default();
        assert!(s.begin_stage("0.3.12"));
        s.finish_download("0.3.12", vec![1, 2, 3]);
        assert_eq!(s.ready_version().as_deref(), Some("0.3.12"), "下载完就算就绪");
        assert!(!s.begin_stage("0.3.12"), "已就绪同版本,不再重复下载");
        assert_eq!(
            s.classify(Some("0.3.12")),
            AppUpdateStatus::Ready { version: "0.3.12".into() },
            "远端与就绪版本一致时应报 Ready"
        );
    }

    /// **取走即清空**:`install()` 在 Windows 上正常情况下不返回(进程直接退出),
    /// 但万一它失败并返回,重启流程会继续往下走——字节还留着的话,
    /// 下次点重启会拿同一份包再装一次。
    #[test]
    fn pending_install_bytes_are_consumed_exactly_once() {
        let s = ReadyState::default();
        s.finish_download("0.3.12", vec![7, 7, 7]);
        assert_eq!(s.take_pending_install(), Some(vec![7, 7, 7]), "第一次拿得到");
        assert_eq!(s.take_pending_install(), None, "第二次必须为空,否则会重复安装");
    }

    /// 下载失败时半份字节不能留给下一轮用。
    #[test]
    fn abort_discards_any_downloaded_bytes() {
        let s = ReadyState::default();
        assert!(s.begin_stage("0.3.12"));
        s.finish_download("0.3.12", vec![9, 9]);
        s.abort_stage();
        assert_eq!(s.take_pending_install(), None, "中止后不得留下半份安装包");
    }

    #[test]
    fn classify_promotes_to_ready_only_when_remote_agrees() {
        let s = ReadyState::default();
        assert_eq!(s.classify(None), AppUpdateStatus::UpToDate);
        assert_eq!(
            s.classify(Some("0.3.1")),
            AppUpdateStatus::Available { version: "0.3.1".into() }
        );
        s.finish_stage("0.3.1");
        assert_eq!(
            s.classify(Some("0.3.1")),
            AppUpdateStatus::Ready { version: "0.3.1".into() }
        );
        // 就绪的是 0.3.1,远端又发了 0.3.2:对用户而言那是一个还没装的新版本
        assert_eq!(
            s.classify(Some("0.3.2")),
            AppUpdateStatus::Available { version: "0.3.2".into() }
        );
        // 远端下架(公告没有新版):不拿本地就绪状态冒充远端有
        assert_eq!(s.classify(None), AppUpdateStatus::UpToDate);
    }

    #[test]
    fn notify_only_when_window_is_not_visible() {
        assert!(!should_notify(Some(true)), "窗口开着:pill 已经在,不双重打扰");
        assert!(should_notify(Some(false)), "缩进托盘:通知是唯一入口");
        assert!(should_notify(None), "窗口句柄都没了:照发,宁多勿漏");
    }

    #[test]
    fn the_check_cadence_does_not_depend_on_the_skills_cadence() {
        // 关掉「自动更新应用」才不查;技能档位(含「手动」)一概管不着它
        assert_eq!(next_check_delay(true), Some(CHECK_INTERVAL));
        assert_eq!(next_check_delay(false), None);
        // 分钟级:间隔一大,"一旦有新版本就提示"这件事就不成立了(用户拍板 1 分钟)
        assert!(
            CHECK_INTERVAL <= std::time::Duration::from_secs(300),
            "间隔超过 5 分钟,用户等不到自动提示",
        );
    }

    #[test]
    fn only_a_real_app_bundle_yields_a_relaunch_target() {
        use std::path::Path;
        assert_eq!(
            macos_bundle_path(Path::new("/Applications/SkillSync.app/Contents/MacOS/skillsync")),
            Some(Path::new("/Applications/SkillSync.app").to_path_buf()),
        );
        // dev 构建不在 .app 里:必须回退到 tauri 自己的 restart,不能瞎拼一个路径
        assert_eq!(macos_bundle_path(Path::new("/repo/target/debug/skillsync")), None);
        // 层级对不上的一律不认(少一层 Contents / 目录名不是 MacOS / 不以 .app 结尾)
        assert_eq!(macos_bundle_path(Path::new("/A/X.app/MacOS/bin")), None);
        assert_eq!(macos_bundle_path(Path::new("/A/X.app/Contents/Helpers/bin")), None);
        assert_eq!(macos_bundle_path(Path::new("/A/X/Contents/MacOS/bin")), None);
    }

    #[test]
    fn ready_notification_reports_version_only() {
        let (title, body) = ready_notification("0.3.1");
        assert_eq!(title, "应用更新");
        assert!(body.contains("0.3.1"), "{body}");
        assert!(body.contains("重启"), "要说清生效方式: {body}");
        assert!(!body.contains("设置"), "新体验不再指去设置页: {body}");
    }

    #[test]
    fn ready_notification_is_chinese_and_free_of_git_jargon() {
        let (title, body) = ready_notification("0.3.1");
        let text = format!("{title} {body}");
        for word in ["commit", "push", "pull", "repo", "branch", "PR", "merge"] {
            assert!(
                !text.to_lowercase().contains(&word.to_lowercase()),
                "通知文案出现 git 术语 {word}: {text}"
            );
        }
        assert!(
            text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
            "通知文案必须是中文: {text}"
        );
        assert!(text.chars().all(|c| (c as u32) < 0x1F000), "通知文案禁 emoji: {text}");
    }
}
