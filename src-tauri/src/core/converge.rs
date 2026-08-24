//! 本体位置的解析入口(v6 二期)。
//!
//! `installer::Installer::home` 知道怎么把 `(dir_slug, 账上的 body)` 折成一个
//! [`crate::core::installer::SkillHome`],但它不该知道账在哪、怎么读——那是
//! `state::State` 的事。本模块把两者接起来,是全仓**唯一**允许调用
//! `Installer` 内部 `canonical_dir` 解析的入口之一(另一个是 `installer.rs` 自己)。
//! 文本级守卫 `tests/body_guard.rs` 钉住这条:`core/acquire.rs`、`core/remove.rs`、
//! `core/share.rs`、`core/scheduler.rs`、`core/my_skills.rs`、`core/create.rs`、
//! `core/local_detail.rs`、`commands.rs` 一律不得自行拼本体路径,只能调这里
//! (或已经拿到手的 `SkillHome`)。
//!
//! 本任务(v6 二期任务 2)只打通这一层:`state.installed[].body` 目前全部是
//! `None`(还没有任何写入路径会填非 `None` 值),所以 `home_of` 对今天的每一条
//! 记账都会落回 canonical——**存量安装的行为一个字节都不变**。往 `body` 字段写入
//! 真实值、以及"本体已经在别处、要不要收进管理"的判定,是后续任务的范围。

use std::path::Path;

use crate::core::installer::{Installer, SkillHome};
use crate::core::state;
use crate::error::AppError;

/// 解析一个技能「住在哪里」:先查 `state.installed` 有没有记账过的 body,
/// 没有(或没找到这条记账)就交给 [`Installer::home`] 落回 canonical 的默认值。
pub fn home_of(installer: &Installer<'_>, state: &state::State, dir_slug: &str) -> Result<SkillHome, AppError> {
    let recorded = state
        .installed
        .iter()
        .find(|s| s.name == dir_slug)
        .and_then(|s| s.body.as_deref());
    installer.home(dir_slug, recorded.map(Path::new))
}
