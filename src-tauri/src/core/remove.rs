//! 移除编排:预检(改过要确认)→ 解链 → 删本体 → 记账清除 → lock 双写移除。
//!
//! 与 [`crate::core::acquire`] 同构:破坏性动作前先预检,需要用户拍板时
//! 返回 [`RemoveOutcome::NeedsDecision`] 且**不动磁盘**,拿到确认(`force`)才执行。
//! 铁律 7「绝不静默删除用户文件」在移除路径上的落地就是这一道。
//!
//! # 假设(文档未覆盖,按开发纪律显式标注)
//!
//! - **本体已经不在磁盘上的记录可以直接清账**:canonical 目录没了,"你改过的内容"
//!   也无从谈起,拦着不让删只会留下一条永远清不掉的死账。
//! - **state 里认不出的链接 mode 一律跳过解链**:那说明 `state.json` 被手改过或来自
//!   更新的版本。跳过是保守选择——猜一个 mode 去删,猜错就是拿删除逻辑动错误的目录形态。

use serde::Serialize;

use crate::core::agents::AgentEnv;
use crate::core::fsops::{self, LinkKind};
use crate::core::installer::{Installer, RecordedLink, UninstallReport, UnlinkReport, UnlinkResult};
use crate::core::skill_lock::{self, LockOutcome};
use crate::core::state::Store;
use crate::error::AppError;
use std::path::{Path, PathBuf};

/// 一次移除请求的结论。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum RemoveOutcome {
    /// 用户改过技能本体,移除会连改动一起删掉——停下让界面去问,磁盘未动。
    NeedsDecision,
    /// 已移除。`lock` 与 acquire 的口径一致:`written` / `skipped` / `failed`。
    Removed {
        report: UninstallReport,
        lock: String,
    },
}

/// 移除一个已安装的技能。
///
/// `force` 是前端确认弹窗的结果:`false` 时遇到本地改动会停下来问;
/// `true` 表示用户已确认"连改动一起删"。
pub fn remove(
    installer: &Installer<'_>,
    env: &dyn AgentEnv,
    store: &Store,
    dir_slug: &str,
    force: bool,
) -> Result<RemoveOutcome, AppError> {
    // 删本体期间的文件事件不上报——那是本应用自己干的,界面已经会刷新
    let _quiet = crate::core::watcher::app_write();
    let loaded = store.load_state()?;
    let Some(idx) = loaded.value.installed.iter().position(|s| s.name == dir_slug) else {
        return Err(AppError::new(
            "FS_NOT_INSTALLED",
            "这个技能不在已获取列表中,可能已被移除",
        )
        .with_detail(format!("not in state.installed: {dir_slug}")));
    };
    let record = &loaded.value.installed[idx];

    // 预检:本体还在且内容与记账不符 = 用户改过。本体已不在则无改动可言,直接清账。
    let canonical = installer.canonical_dir(dir_slug)?;
    if !force && canonical.is_dir() {
        let actual = fsops::dir_content_hash(&canonical)?;
        if actual != record.content_hash {
            return Ok(RemoveOutcome::NeedsDecision);
        }
    }

    let (recorded, unparseable) = state_links_to_recorded(&record.links);
    let mut report = installer.uninstall(dir_slug, &recorded, true)?;
    // 认不出 mode 的记账不猜着删,但也不能不吭声:并进报告让界面逐条说明
    report.unlinks.extend(unparseable);

    // 磁盘动完才清账:uninstall 失败时账还在,用户可以重试
    let mut next = loaded.value.clone();
    next.installed.remove(idx);
    store.save_state(&next)?;

    // 外部契约同步。任何结果都不阻断——技能已经移除了,记账失败只该记日志。
    let lock = match skill_lock::lock_path(env) {
        None => {
            eprintln!("[remove] 跳过 lock 双写: 找不到 lock 文件落点");
            "skipped".into()
        }
        Some(path) => match skill_lock::remove(&path, &report.dir_name) {
            LockOutcome::Written => "written".into(),
            LockOutcome::Skipped { reason } => {
                eprintln!("[remove] 跳过 lock 双写: {reason}");
                "skipped".into()
            }
            LockOutcome::Failed { reason } => {
                eprintln!("[remove] lock 双写失败: {reason}");
                "failed".into()
            }
        },
    };

    Ok(RemoveOutcome::Removed { report, lock })
}

/// 把 state 里的字符串记账转成 installer 认识的形式;认不出的单独返回为"跳过"报告。
pub fn state_links_to_recorded(
    links: &[crate::core::state::LinkRecord],
) -> (Vec<RecordedLink>, Vec<UnlinkReport>) {
    let mut ok = Vec::new();
    let mut skipped = Vec::new();
    for l in links {
        match LinkKind::parse(&l.mode) {
            Some(mode) => ok.push(RecordedLink {
                dir: PathBuf::from(&l.dir),
                mode,
            }),
            None => skipped.push(UnlinkReport {
                dir: l.dir.clone(),
                result: UnlinkResult::Skipped {
                    reason: format!("记账中的关联方式「{}」无法识别,未做改动", l.mode),
                },
            }),
        }
    }
    (ok, skipped)
}

/// 判断某个已安装技能当前是否被用户改过(给「我的技能」列表用)。
///
/// 算不出 hash(目录没了、权限不足)按"没改过"处理:这个标记只用于提示,
/// 不该因为读不了目录就把整个列表拉挂。
pub fn is_locally_modified(canonical: &Path, recorded_hash: &str) -> bool {
    fsops::dir_content_hash(canonical)
        .map(|actual| actual != recorded_hash)
        .unwrap_or(false)
}
