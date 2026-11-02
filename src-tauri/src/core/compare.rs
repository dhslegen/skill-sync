//! 「与库里不同」的逐文件比较(0.8.0 任务 2)。
//!
//! 「与库里不同」此前出现在四处(商店卡片、详情底部、「我的技能」那一行、
//! 两边都改过时的冲突弹窗),用户点进去却**看不到到底哪里不同**,只能盲选。
//! 这里给出一份逐文件差异,界面复用分享确认屏的 `SharePlanList`/`FileViewer` 渲染。
//!
//! # 比的是哪两边
//!
//! - **本地**:经 [`converge::locate`] 定位本体——**与分享走同一个入口**。
//!   本体可以住在工具目录里(v6 二期),按 canonical 拼路径就会比错文件夹
//!   (v8 定向复审 I-1 的同一个坑)。
//! - **库里**:**索引里那一版**(`commit_sha` 钉住),不是分支头。卡片说「与库里不同」
//!   用的是索引的 `content_hash`,这里也必须比同一版,否则会出现"卡片说不同、
//!   点开一看相同"或者反过来。返回值带上那一版的指纹 `remote_hash`,下游
//!   (任务 4 的「已保留你的版本」)记的就是它——接缝表第一条。
//!
//! # 方向
//!
//! 复用 [`share::plan_changes`](同一个纯函数,不另写一份差集):新增 = 只有你有,
//! 修改 = 两边都有但不同,删除 = 只有库里有。语义与分享清单完全相同,
//! 只是界面换一句标题——不是"这次会删掉",而是"库里有、你没有"。
//!
//! # 只读
//!
//! 这里**不写盘、不发任何写请求**:只下载那一版的压缩包。所以不持 `app_write` 守卫
//! (守卫名单 `tests/watcher_guard.rs` 只收写盘函数)。

use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::converge;
use crate::core::gitea::{RepoRef, RepoSource};
use crate::core::installer::Installer;
use crate::core::share::{self, SharePlan};
use crate::core::state::Store;
use crate::error::AppError;

/// 库里那一版的坐标——**调用方从索引缓存里取**,三样必须出自同一份索引。
pub struct LibraryVersion<'a> {
    /// `branch` 填的是**那一版的提交 sha**,不是分支名(压缩包端点两家都接受提交 sha)。
    pub at: &'a RepoRef,
    /// 技能在库里的真实路径(`IndexedSkill::path`),不拿 `skills/<dirSlug>` 现猜。
    pub skill_path: &'a str,
    /// 索引给这一版算的内容指纹(`IndexedSkill::content_hash`)。
    pub content_hash: &'a str,
}

/// 比较结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub plan: SharePlan,
    /// 本体的绝对路径。界面读本地文件时**必须按它读**(`{path}`),
    /// 不能按 `{dirSlug}`——后者在无记账时落回 canonical,本体在工具目录里就读不到。
    pub local_path: String,
    /// 比较的那一版库内容的指纹(= 索引 `content_hash`)。
    pub remote_hash: String,
    /// 三份清单都空。理论上不该出现(卡片判「不同」才会进来),但索引过期时可能:
    /// 界面据此说「其实是一样的」,不摆三选一。
    pub identical: bool,
}

/// 比较本机这份与库里那一版。只读。
pub async fn compare_with_library(
    read: &impl RepoSource,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    dir_slug: &str,
    library: LibraryVersion<'_>,
) -> Result<Comparison, AppError> {
    let installer = Installer::new(registry, env);
    let state = store.load_state()?.value;

    // ① 本地:与分享同一个定位入口
    let body = match converge::locate(&installer, registry, env, &state, dir_slug)? {
        converge::Located::Differs(versions) => {
            return Err(AppError::new(
                "FS_NEEDS_VERSION_CHOICE",
                "这个技能在你电脑上有好几个不一样的版本,请先选定保留哪一份",
            )
            .with_detail(format!("{} versions for {dir_slug}", versions.len())))
        }
        converge::Located::None => return Err(share::missing_body_err(dir_slug)),
        converge::Located::Body { body, .. } => body,
    };
    let prefix = format!("{}/", library.skill_path.trim_matches('/'));
    let local = share::payload_files(&body, &prefix)?;
    if local.is_empty() {
        // 不交给 plan_changes 去报:它那句话说的是"这次没有提交",在比较里是假话
        return Err(share::missing_body_err(dir_slug));
    }

    // ② 库里那一版
    let archive = read.download_archive(library.at).await?;
    let remote = share::remote_files(&archive, &prefix);
    if remote.is_empty() {
        return Err(AppError::new(
            "REPO_NOT_FOUND",
            "技能库那一版里找不到这个技能,请刷新后再试",
        )
        .with_detail(format!("{prefix} not in {}", library.at.branch)));
    }

    let changes = share::plan_changes(&prefix, &remote, local)?;
    let plan = changes.plan;
    let identical = plan.added.is_empty() && plan.modified.is_empty() && plan.deleted.is_empty();
    Ok(Comparison {
        plan,
        local_path: body.to_string_lossy().into_owned(),
        remote_hash: library.content_hash.to_string(),
        identical,
    })
}
