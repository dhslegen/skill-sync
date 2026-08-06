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

    /// 装失败:只放开互斥,不记就绪。
    pub fn abort_stage(&self) {
        let mut inner = self.inner.lock().expect("app_update 状态锁不该中毒");
        inner.in_flight = false;
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
