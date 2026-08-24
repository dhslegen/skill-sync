//! 移除编排:解链 → 本体进废纸篓 → 记账清除 → lock 双写移除。
//!
//! # v6 二期:不再有"改过要二次确认"这一道
//!
//! 铁律 7「绝不静默删除用户文件」此前在这条路上靠**问一遍**落实(改过本体就返回
//! `NeedsDecision`,拿到 `force` 才执行)。v6 二期把它换成了**可逆**:本体经
//! [`crate::core::fsops::trash_tree`] 进系统废纸篓,用户随时能捞回来。确认框本身
//! 不是可逆性——用户手滑点了"确定"东西照样没了;而进了废纸篓,连"程序判断错了"
//! 这一档都兜得住。所以这一层的问句撤掉,由界面上那一次"要移除吗"负责告知。
//!
//! # 假设(文档未覆盖,按开发纪律显式标注)
//!
//! - **本体已经不在磁盘上的记录可以直接清账**:目录没了,"你改过的内容"
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
///
/// 只剩一档(v6 二期任务 4 删掉了 `NeedsDecision`),但**保持枚举形状不变**:
/// 前端按 `outcome` 分支,枚举退化成结构体会让那一侧跟着改一遍,而将来若再有
/// 第二档(比如"本体在别的电脑上")还得改回来。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "outcome")]
pub enum RemoveOutcome {
    /// 已移除。`lock` 与 acquire 的口径一致:`written` / `skipped` / `failed`。
    Removed {
        report: UninstallReport,
        lock: String,
    },
}

/// 移除一个已安装的技能:解除全部关联,本体进废纸篓,清账。
///
/// **只服务"从技能库获取的技能"**(判据 [`crate::core::state::InstalledSkill::has_source`])。
/// 🔴 纯本地技能(用户自己在工具目录里开发的,任务 3 起勾选工具会顺手给它建一条
/// 全空来源的 `adopted` 账)**必须在这里拒绝**:否则用户在 Claude Code 里正开发的
/// 技能,只因为点过一次勾就获得了一个「移除」按钮,点下去本体就进了废纸篓——
/// 那不是本应用该替他做的决定。界面上也不该摆这个按钮(任务 5),core 这一层
/// 是不靠界面形状的第二道。
pub fn remove(
    installer: &Installer<'_>,
    env: &dyn AgentEnv,
    store: &Store,
    dir_slug: &str,
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
    if !record.has_source() {
        return Err(AppError::new(
            "FS_NOT_ACQUIRED",
            "这个技能不是从技能库获取的,要删除请直接在文件夹里删",
        )
        .with_detail(format!("no source recorded for {dir_slug}")));
    }

    let home = crate::core::converge::home_of(installer, &loaded.value, dir_slug)?;

    let (recorded, unparseable) = state_links_to_recorded(&record.links);
    let mut report = installer.uninstall(&home, &recorded, true)?;
    // 认不出 mode 的记账不猜着删,但也不能不吭声:并进报告让界面逐条说明
    report.unlinks.extend(unparseable);

    // 磁盘动完才清账:uninstall 失败时账还在,用户可以重试
    let mut next = loaded.value.clone();
    next.installed.remove(idx);
    // 分享记账也要一起清掉(v6 任务 3 修复轮 1)。它记的是"上次分享时这个**本地目录**
    // 的内容基线",本体都删了,那条记账指向的位置已经不存在——留着就是一条谁也清不掉的
    // 孤儿,而 `create::create_skill` 会拿它拒绝同名新建:「这个名字已经被一个分享过的
    // 技能占用了」,可那个技能本地已经不在了。**「占用」在本体不存在时是假话**,
    // 而"取回我分享的 → 移除 → 想重新起草一个同名的"是 v6 的主线路径。
    //
    // 丢掉它不丢信息:v6 的模型是「归属的真相在技能库、本地只是缓存」,
    // 关系随时可以由 `ownership::relation` 从库根 authors.json 重新算出来。
    //
    // 🔴 **按 `local_path` 匹配,不按 `name`**,而且**按 `Path` 比不按字符串比**:
    // - `name` 是**远端目录名**,中文名技能分享时会另起 ASCII 远端名,与本地目录名
    //   不是一回事(share.rs 模块头);拿 `dir_slug` 去比 `name`,中文名技能的孤儿
    //   一条都清不掉,还可能误删另一个本地目录以这个名字分享出去的那条记账。
    //   `local_path` 说的正是"这条记账讲的就是我刚删掉的这个目录"。
    // - 字符串比在 Windows 上会失配:`home.join(".agents/skills")` 产出
    //   `.agents/skills\x`,分段 join 产出 `.agents\skills\x`,同一个目录字符串却不等
    //   (2026-08-04 CI 真红过一次,当时栽在 create.rs 上)。
    // v6 二期:按**本体**比,不按 canonical 比——本体可能住在某个工具目录里,
    // 而 `seed_shared_baseline`/`share` 记的 `local_path` 就是本体所在。
    next.shared.retain(|s| Path::new(&s.local_path) != home.body);
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
