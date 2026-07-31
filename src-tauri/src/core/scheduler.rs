//! 定时更新检查(M2 任务 3,设计方案 2.5③)。
//!
//! 两层拆开,各自可测:
//! - [`run_check`]:**单轮检查**的完整编排——`branch_head` 比对 → 有变化才下载
//!   → [`acquire::acquire_batch`](`BatchAgents::FromAccount`)。冲突保护不在这里另写
//!   一套:batch 对"用户改过/外来/已最新"一律跳过并给人话原因,那就是保护本身。
//! - `run_loop`:**调度循环**——只管"什么时候跑",跑什么由注入的闭包决定,
//!   所以能用 tokio 的暂停时钟测频率与重排,不用真的等四个小时。
//!
//! 铁律级约束:更新的唯一入口是 `acquire_batch`,**绝不直调 `Installer::install`**
//! (它无条件清空重建 canonical,守卫在 acquire 层)。
//!
//! # 假设(文档未覆盖,按开发纪律显式标注)
//! - 启动后延迟 [`FIRST_CHECK_DELAY`] 做首轮检查(让窗口与网络先起来),之后按频率;
//!   上次检查时刻只记在内存里,重启即重来——错过一轮的代价是多等一个间隔,
//!   比把时间戳落盘换来的复杂度便宜。
//! - 睡醒语义用"一次 `sleep` 到点"而不是 `interval`:系统休眠横跨多个周期后
//!   恢复,只补跑**一轮**,不堆积(DoD 明确要求)。

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::mpsc;

use crate::core::acquire::{self, BatchAgents, BatchOutcome};
use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::gitea::{GiteaClient, RepoRef};
use crate::core::state::Store;
use crate::error::AppError;

/// 启动后到首轮检查的延迟。
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);

// ============================================================ 单轮检查

/// 一轮检查的结果,供事件上报与通知文案使用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum CheckReport {
    /// 没装任何来自该库的技能,没发任何请求。
    NothingInstalled,
    /// 远端没有新内容(只发了一次 branch_head)。
    UpToDate { head_sha: String },
    /// 跑了一轮批量更新。
    Checked {
        head_sha: String,
        /// 更新成功的技能(目录名)。
        updated: Vec<String>,
        /// 跳过的技能与人话原因(用户改过/外来/已最新)。
        skipped: Vec<SkippedSkill>,
        /// 失败的技能与错误。
        failed: Vec<FailedSkill>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedSkill {
    pub dir_slug: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedSkill {
    pub dir_slug: String,
    pub error: AppError,
}

/// 单轮检查:head 比对 → 有变化才下载与批量更新。
///
/// 只碰属于 `registry_id` + `repo` 的已装技能;各技能的链接目标取**账上的 agents**
/// ——自动流程绝不改写用户的关联。
#[allow(clippy::too_many_arguments)]
pub async fn run_check(
    client: &GiteaClient,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    registry_id: &str,
    repo: &RepoRef,
    now: &str,
    fetched_at: i64,
) -> Result<CheckReport, AppError> {
    let state = store.load_state()?.value;
    let mine: Vec<String> = state
        .installed
        .iter()
        .filter(|s| {
            s.source.registry_id == registry_id
                && s.source.owner == repo.owner
                && s.source.repo == repo.repo
        })
        .map(|s| s.name.clone())
        .collect();

    if mine.is_empty() {
        tracing::info!(registry_id, "定时检查:没有已安装的技能,本轮跳过");
        return Ok(CheckReport::NothingInstalled);
    }

    let head = client.branch_head(repo).await?;
    let all_current = state
        .installed
        .iter()
        .filter(|s| mine.contains(&s.name))
        .all(|s| s.commit_sha == head.sha);
    if all_current {
        tracing::info!(head = %head.sha, count = mine.len(), "定时检查:全部已是最新,不下载");
        return Ok(CheckReport::UpToDate { head_sha: head.sha });
    }

    tracing::info!(head = %head.sha, count = mine.len(), "定时检查:发现新内容,开始批量更新");
    let items = acquire::acquire_batch(
        client,
        registry,
        env,
        store,
        registry_id,
        repo,
        &mine,
        BatchAgents::FromAccount,
        now,
        fetched_at,
    )
    .await?;

    let mut updated = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    for item in items {
        match item.outcome {
            BatchOutcome::Installed { .. } => updated.push(item.dir_slug),
            BatchOutcome::Skipped { reason } => skipped.push(SkippedSkill {
                dir_slug: item.dir_slug,
                reason,
            }),
            BatchOutcome::Failed { error } => {
                tracing::warn!(dir_slug = %item.dir_slug, code = %error.code, "定时更新失败");
                failed.push(FailedSkill {
                    dir_slug: item.dir_slug,
                    error,
                });
            }
        }
    }
    tracing::info!(
        updated = updated.len(),
        skipped = skipped.len(),
        failed = failed.len(),
        "定时检查完成"
    );
    Ok(CheckReport::Checked {
        head_sha: head.sha,
        updated,
        skipped,
        failed,
    })
}

// ============================================================ 系统通知文案

/// 一轮检查要不要通知、通知说什么。`None` = 不打扰。
///
/// 规则(M2 任务 4 的假设,文档只给了「3 个技能已更新」这一句样例):
/// - 有实际动作(更新成功或失败)才通知;纯"已最新/全部跳过"的例行轮次每隔
///   几小时就来一次,逐轮弹通知是骚扰——冲突的常驻提醒在「我的技能」页的
///   徽标上,这里不重复。
/// - body 只报数量,不露目录名(内部标识不是人话);明细引导去主窗看。
///
/// 文案是用户可见的第二通道(同 AppError 的 message),必须中文、禁 git 术语、
/// 禁 emoji——有单测钉住。
pub fn notification_copy(report: &CheckReport) -> Option<(String, String)> {
    let CheckReport::Checked { updated, skipped, failed, .. } = report else {
        return None;
    };
    if updated.is_empty() && failed.is_empty() {
        return None;
    }

    let mut parts = Vec::new();
    if !updated.is_empty() {
        parts.push(format!("{} 个技能已更新", updated.len()));
    }
    if !failed.is_empty() {
        parts.push(format!("{} 个更新失败", failed.len()));
    }
    if !skipped.is_empty() {
        parts.push(format!("{} 个已跳过", skipped.len()));
    }
    let mut body = parts.join(",");
    body.push_str("。详情见「我的技能」。");
    Some(("技能更新".to_string(), body))
}

// ============================================================ 调度循环

/// 循环读取的调度配置。每次睡醒或收到命令都重新取,频率变更即时生效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cadence {
    pub enabled: bool,
    pub interval_hours: u32,
}

/// 下一次检查的延迟。关掉了就是 `None`(睡到有命令为止)。
pub fn next_delay(cadence: Cadence) -> Option<Duration> {
    cadence
        .enabled
        .then(|| Duration::from_secs(u64::from(cadence.interval_hours.max(1)) * 3600))
}

/// 发给调度循环的命令。
#[derive(Debug)]
enum Command {
    /// 配置变了,重新计算下一次时刻。
    Reschedule,
    /// 立刻跑一轮(设置页「立即检查」)。
    CheckNow,
}

/// 调度器句柄。commands 层持有它;所有方法都是即发即忘。
#[derive(Clone)]
pub struct Scheduler {
    tx: mpsc::UnboundedSender<Command>,
}

impl Scheduler {
    pub fn reschedule(&self) {
        let _ = self.tx.send(Command::Reschedule);
    }
    pub fn check_now(&self) {
        let _ = self.tx.send(Command::CheckNow);
    }
}

pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// 组装调度循环。返回句柄与循环 future——**由调用方 spawn**(Tauri 用它自己的
/// async runtime,core 不替它决定跑在哪)。
///
/// `cadence` 与 `check` 都是注入的闭包:前者每次决策前读一次(所以设置页改完频率,
/// 下一次决策立刻按新值走);后者跑一轮检查并自行上报结果。
pub fn make(
    cadence: impl Fn() -> Cadence + Send + 'static,
    check: impl Fn() -> BoxFuture + Send + 'static,
) -> (Scheduler, impl Future<Output = ()> + Send + 'static) {
    let (tx, rx) = mpsc::unbounded_channel();
    (Scheduler { tx }, run_loop(rx, cadence, check, FIRST_CHECK_DELAY))
}

/// 循环本体。独立成函数是为了让测试能用暂停时钟直接驱动它。
async fn run_loop(
    mut rx: mpsc::UnboundedReceiver<Command>,
    cadence: impl Fn() -> Cadence,
    check: impl Fn() -> BoxFuture,
    first_delay: Duration,
) {
    // 首轮:开着才跑,且给系统一点起身时间
    let mut pending_delay = next_delay(cadence()).map(|_| first_delay);
    loop {
        let sleep_for = pending_delay;
        tokio::select! {
            _ = async {
                match sleep_for {
                    Some(d) => tokio::time::sleep(d).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                check().await;
                pending_delay = next_delay(cadence());
            }
            cmd = rx.recv() => match cmd {
                Some(Command::Reschedule) => {
                    // 一次 sleep 到点的写法,醒来只补一轮,系统休眠横跨多周期也不堆积
                    pending_delay = next_delay(cadence());
                }
                Some(Command::CheckNow) => {
                    check().await;
                    pending_delay = next_delay(cadence());
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn counter_check(hits: Arc<AtomicUsize>) -> impl Fn() -> BoxFuture {
        move || {
            let hits = hits.clone();
            Box::pin(async move {
                hits.fetch_add(1, Ordering::SeqCst);
            })
        }
    }

    fn checked(updated: usize, skipped: usize, failed: usize) -> CheckReport {
        CheckReport::Checked {
            head_sha: "sha-9".into(),
            updated: (0..updated).map(|i| format!("skill-{i}")).collect(),
            skipped: (0..skipped)
                .map(|i| SkippedSkill {
                    dir_slug: format!("skip-{i}"),
                    reason: "已安装且有你的本地改动,未覆盖".into(),
                })
                .collect(),
            failed: (0..failed)
                .map(|i| FailedSkill {
                    dir_slug: format!("fail-{i}"),
                    error: AppError::new("NET_UNREACHABLE", "连不上公司技能库"),
                })
                .collect(),
        }
    }

    #[test]
    fn routine_rounds_never_notify() {
        assert!(notification_copy(&CheckReport::NothingInstalled).is_none());
        assert!(notification_copy(&CheckReport::UpToDate { head_sha: "x".into() }).is_none());
        // 全部跳过、没有实际动作:徽标已经在「我的技能」页常驻,逐轮弹通知是骚扰
        assert!(notification_copy(&checked(0, 3, 0)).is_none());
    }

    #[test]
    fn real_outcomes_notify_with_counts_only() {
        let (title, body) = notification_copy(&checked(3, 1, 0)).unwrap();
        assert_eq!(title, "技能更新");
        assert_eq!(body, "3 个技能已更新,1 个已跳过。详情见「我的技能」。");

        let (_, body) = notification_copy(&checked(0, 0, 2)).unwrap();
        assert_eq!(body, "2 个更新失败。详情见「我的技能」。");

        // 目录名是内部标识,绝不能出现在通知里
        assert!(!body.contains("skill-"), "{body}");
        assert!(!body.contains("fail-"), "{body}");
    }

    #[test]
    fn notification_copy_is_chinese_and_free_of_git_jargon() {
        for report in [checked(2, 1, 1), checked(1, 0, 0), checked(0, 0, 1)] {
            let (title, body) = notification_copy(&report).unwrap();
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
            assert!(
                text.chars().all(|c| (c as u32) < 0x1F000),
                "通知文案禁 emoji: {text}"
            );
        }
    }

    #[test]
    fn next_delay_reflects_the_switch_and_interval() {
        assert_eq!(
            next_delay(Cadence { enabled: true, interval_hours: 4 }),
            Some(Duration::from_secs(4 * 3600))
        );
        assert_eq!(next_delay(Cadence { enabled: false, interval_hours: 4 }), None);
        // 0 不可能通过 save_auto_update 的校验,但手改 config 的兜底:钳到 1 小时
        assert_eq!(
            next_delay(Cadence { enabled: true, interval_hours: 0 }),
            Some(Duration::from_secs(3600))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_loop_fires_on_cadence_and_reschedules_immediately() {
        let hits = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = mpsc::unbounded_channel();
        let interval = Arc::new(AtomicUsize::new(4));
        let interval_for_loop = interval.clone();
        tokio::spawn(run_loop(
            rx,
            move || Cadence {
                enabled: true,
                interval_hours: interval_for_loop.load(Ordering::SeqCst) as u32,
            },
            counter_check(hits.clone()),
            Duration::from_secs(10),
        ));

        // 首轮:10 秒后
        tokio::time::sleep(Duration::from_secs(11)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1, "首轮该在启动延迟后触发");

        // 之后按 4 小时一轮
        tokio::time::sleep(Duration::from_secs(4 * 3600 + 5)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 2, "第二轮该在一个间隔后触发");

        // 改成 1 小时并重排:下一轮 1 小时后到,而不是仍按旧的 4 小时
        interval.store(1, Ordering::SeqCst);
        tx.send(Command::Reschedule).unwrap();
        tokio::time::sleep(Duration::from_secs(3600 + 5)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 3, "重排后新频率立刻生效");
    }

    #[tokio::test(start_paused = true)]
    async fn disabled_means_no_ticks_but_check_now_still_works() {
        let hits = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run_loop(
            rx,
            || Cadence { enabled: false, interval_hours: 4 },
            counter_check(hits.clone()),
            Duration::from_secs(10),
        ));

        // 关着:睡多久都不该触发
        tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0, "关掉自动更新就不该有任何一轮");

        // 但「立即检查」照常可用
        tx.send(Command::CheckNow).unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
