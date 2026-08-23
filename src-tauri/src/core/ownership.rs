//! 「技能库里记的分享者是不是我」这一件事的纯逻辑地基(v6 任务 1)。
//!
//! v6 要用这一个判定取代此前散落各处的四本账(`state.installed` 的 origin、
//! `claimed`/`acquired`、本地目录扫描……),本模块只产出两个零副作用的纯函数:
//! - [`is_same_person`]:名字是否与"我"的任一别名相同,从 `share.rs` 的
//!   `upsert_attribution` 里原有的 `is_me` 闭包原样抽出——那条闭包已经用真实数据
//!   验证过"别名要按展示名 + 登录名两种写法都认",这里不重新发明。
//! - [`relation`]:技能与"我"的关系判定表(**唯一一处**,后续 IPC/界面一律调它,
//!   不得各写一份——`update.rs::cardState` 当年"三处各写一份判定"就是前车之鉴)。
//!
//! `Identity` 是"我是谁"的最小表示,落在 `config.json` 的 `identities` 字段
//! (按 registryId 分开存,见 `state::Config`),由 `session.rs` 在登录/退出/查状态
//! 三处维护。

use serde::{Deserialize, Serialize};

/// 登录身份的最小表示:一个技能库账号的登录名 + 展示名。
///
/// 与 `session::SessionUser` 的字段有重叠,但语义不同——`SessionUser` 是"这次查询
/// 返回给界面看的东西"(还带 avatar_url),`Identity` 是"落盘、长期存在、只为比对
/// 用"的那一份,刻意做得更小。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub login: String,
    pub display_name: String,
}

impl Identity {
    /// 这个人的全部写法:展示名在前、登录名在后,**空串剔除**。
    ///
    /// 剔除空串是必须的:`display_name` 在 `full_name` 为空时会退回 `login`
    /// (见 `SessionUser::from`),两者因此可能相同,不是缺陷;但如果哪一侧本身
    /// 是空串还留在别名表里,会让 `is_same_person(Some(""), aliases)` 在
    /// `author` 同样缺失/是空串时被误判为"是本人"。
    pub fn aliases(&self) -> Vec<&str> {
        [self.display_name.as_str(), self.login.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect()
    }
}

/// `name` 是否与 `aliases` 中的任一写法相同。
///
/// 从 `share.rs::upsert_attribution` 原有的 `is_me` 闭包原样抽出
/// (`name.is_some_and(|n| aliases.contains(&n))`),行为逐字不变——
/// `share.rs:1284` 的 `aliases_keep_one_person_from_becoming_two` 测试就是它的护栏。
pub fn is_same_person(name: Option<&str>, aliases: &[&str]) -> bool {
    name.is_some_and(|n| aliases.contains(&n))
}

/// 技能与「我」的关系。序列化为对外契约的三个字面量(后续任务会放进 IPC DTO,
/// 名字不得再改)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    Shared,
    Installed,
    Draft,
}

/// 技能与「我」的关系判定表(**唯一一处**,调用方不得另写一份)。
///
/// - `me`:当前登录身份,未登录传 `None`;
/// - `author`:索引里这个技能的 attribution author(来自 `authors.json`,可能没有);
/// - `in_library`:索引里有没有这个 `dir_slug`(技能库里存不存在这个技能);
/// - `local_present`:canonical 目录下有没有本体(这台机器上有没有实体文件)。
///
/// 判定表(与 brief 逐字一致):
///
/// | in_library | local_present | me | author == me | → |
/// |---|---|---|---|---|
/// | false | true | 任意 | — | `Draft` |
/// | false | false | — | — | 不该出现(调用方不会喂)→ `Installed` 保守 |
/// | true | 任意 | `None` | — | `Installed` |
/// | true | 任意 | `Some` | false / author `None` | `Installed` |
/// | true | 任意 | `Some` | true | `Shared` |
pub fn relation(
    me: Option<&Identity>,
    author: Option<&str>,
    in_library: bool,
    local_present: bool,
) -> Relation {
    if !in_library {
        // 库里没有这个技能:有本体就是纯本地草稿;没本体是调用方不该喂的组合,
        // 保守当作 Installed(不当草稿——没有文件却当草稿会在界面上凭空生出条目)。
        return if local_present { Relation::Draft } else { Relation::Installed };
    }
    match me {
        Some(identity) if is_same_person(author, &identity.aliases()) => Relation::Shared,
        _ => Relation::Installed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Identity {
        Identity { login: "zhaowh".into(), display_name: "赵文浩".into() }
    }

    #[test]
    fn library_skill_authored_by_me_is_shared_under_either_alias() {
        assert_eq!(relation(Some(&me()), Some("赵文浩"), true, true), Relation::Shared);
        assert_eq!(relation(Some(&me()), Some("zhaowh"), true, false), Relation::Shared);
    }

    #[test]
    fn library_skill_by_someone_else_or_unattributed_is_installed() {
        assert_eq!(relation(Some(&me()), Some("李四"), true, true), Relation::Installed);
        assert_eq!(relation(Some(&me()), None, true, true), Relation::Installed);
    }

    #[test]
    fn signed_out_makes_every_library_skill_installed() {
        assert_eq!(relation(None, Some("赵文浩"), true, true), Relation::Installed);
    }

    #[test]
    fn local_only_is_a_draft_regardless_of_login() {
        assert_eq!(relation(None, None, false, true), Relation::Draft);
        assert_eq!(relation(Some(&me()), None, false, true), Relation::Draft);
    }

    #[test]
    fn empty_display_name_does_not_match_an_empty_author() {
        let m = Identity { login: "x".into(), display_name: "".into() };
        assert_eq!(relation(Some(&m), Some(""), true, true), Relation::Installed);
    }
}
