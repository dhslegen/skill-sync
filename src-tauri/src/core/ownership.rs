//! 「技能库里记的分享者是不是我」这一件事的纯逻辑地基(v6 任务 1)。
//!
//! v6 要用这一个判定取代此前散落各处的四本账(`state.installed` 的 origin、
//! `claimed`/`acquired`、本地目录扫描……),本模块只产出几个零副作用的纯函数:
//! - [`is_same_person`]:名字是否与"我"的任一别名相同,从 `share.rs` 的
//!   `upsert_attribution` 里原有的 `is_me` 闭包原样抽出——那条闭包已经用真实数据
//!   验证过"别名要按展示名 + 登录名两种写法都认",这里不重新发明。
//! - [`relation`]:技能与"我"的关系判定表(**唯一一处**,后续 IPC/界面一律调它,
//!   不得各写一份——`update.rs::cardState` 当年"三处各写一份判定"就是前车之鉴)。
//! - [`source_label`]:把四种上游 `sourceType` 形状归一化成一句展示文案
//!   (v6 任务 2,撤掉「其他工具装的」标签后唯一留下的来历信息)。
//!
//! `Identity` 是"我是谁"的最小表示,落在 `config.json` 的 `identities` 字段
//! (按 registryId 分开存,见 `state::Config`),由 `session.rs` 在登录/退出/查状态
//! 三处维护。
//!
//! [`LibraryAttribution`] 是 `my_skills::build`/`share::scan_candidates`(v6 任务 2)
//! 共用的"库里有没有这个技能、是哪个库、作者是谁"合并表:`dir_slug → LibraryEntry`。
//! 由调用方从全部已配置库的索引缓存里合并而来(缓存是派生数据,详情面板
//! 不联网承诺不受影响),各处不必各自重新解析索引。
//!
//! **`owner`/`repo` 不是展示用的边角料,是「取回」这个动作能不能发生的前提**
//! (v6 任务 2 修复轮 1):"只在库里、本地没有本体"这一档唯一的存在理由就是
//! "换电脑 / app 数据丢 / 绕过 app 直推 git"——那一行的动作是「取回」,取回要调
//! `skill_acquire`,而获取**必须带库坐标**(`CLAUDE.md`「一源多仓」:更新与回推
//! 缺省会打到主仓,后果不是报错,是装进来一个同名但完全不同的技能)。只存
//! `registry_id` 不够,`owner`/`repo` 必须跟着存下来。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 一个 `dir_slug` 在某个已配置库里的落点:它属于哪个库(`registry_id` +
/// `owner`/`repo`)、在库里的相对路径,以及库里记的作者。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryEntry {
    pub registry_id: String,
    pub owner: String,
    pub repo: String,
    /// 相对技能库根的路径,如 `skills/weekly-report`(来自索引的
    /// `store::IndexedSkill::path`)。
    ///
    /// 🔴 **它是「在技能库里查看」那颗按钮唯一的路径来源**(v7.1 任务 3)。
    /// 拿 `skills/<dir_slug>` 现拼是在**猜**库的目录布局——布局是技能库管理员定的,
    /// 猜错的表现是用户点开得到一个 404。索引里现成就有真实路径,用它。
    pub path: String,
    /// 这个技能所在那个仓**自己的**默认分支。
    ///
    /// 🔴 **终审 I-4:必须跟着条目走,不能在用的时候拿编译期常量兜底**。
    /// 内建源不止一个仓——`config.builtin_extra_repos` 里每一条都带自己的
    /// `branch`(M4「一源多仓」),而 `builtin::BRANCH` 只是**主仓**的分支。
    /// 「在技能库里查看」拿主仓分支去拼一个追加仓的地址,用户点开就是 404。
    /// 这与 `path` 那条注释是**同一条道理**:布局与分支都是技能库那一侧定的,
    /// 现拼就是猜。
    pub branch: String,
    pub author: Option<String>,
}

/// `dir_slug → LibraryEntry`。库里没有这个技能 = 不在表里。
///
/// 只记"合并后第一次命中"的那个库——多个库都有同名 `dir_slug` 时,判给哪个库都是猜,
/// 与 `resolve_binding_of` "唯一命中才绑"同一种保守姿态(不同的是这里没有"绑不上就不管"
/// 的退路,只能挑一个;实际部署里技能库之间几乎不会撞目录名)。
pub type LibraryAttribution = HashMap<String, LibraryEntry>;

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

/// 「我的技能」页按**公司技能库**分的三区(v7):安装自公司库 / 已分享到公司库 /
/// 可分享到公司库。与 [`Relation`] 的区别只在于**说法**——`Relation` 说的是
/// "这个技能与我的关系",`Section` 说的是"这一行该出现在哪一栏",两者是一一对应
/// 的同一件事的两种措辞,序列化为对外契约的三个字面量(前端按它分区,名字不得再改)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    /// 安装自公司技能库。
    InstalledFrom,
    /// 已分享到公司技能库(库里记的分享者是我)。
    SharedTo,
    /// 可分享到公司技能库(本地草稿,库里还没有,或库里有的是另一个同名但内容不同
    /// 的技能——名字撞上不代表这就是"安装自"那个技能,见 `my_skills::in_builtin_library`)。
    Shareable,
}

/// [`Relation`] → [`Section`] 的**唯一**映射,调用方不得另写一份。
pub fn section(relation: Relation) -> Section {
    match relation {
        Relation::Shared => Section::SharedTo,
        Relation::Installed => Section::InstalledFrom,
        Relation::Draft => Section::Shareable,
    }
}

/// 把上游 `.skill-lock.json` 的 `(sourceType, source, sourceUrl)` 归一化成一句展示文案。
///
/// **凡是装来的技能都有来源**(实测 lock 41 条逐条核过,一条不缺),但形状有四种
/// (设计文档「来源展示」一节):`github`/`gitea` 的 `source` 本来就是 `owner/repo`,
/// 原样展示;`git`(`npx skills add <url>` 裸装的)要从 URL 里解析出 `owner/repo`
/// ——它与 `gitea` 那档常是**同一个库**,显示成两种形状用户会以为是两个来源;
/// `well-known` 的 `source` 是域名,原样展示;其余(空、未知类型)不摆来源行,不报错。
///
/// 只在本地新建、从未分享过的草稿没有 lock 条目,调用方传空串三元组即得 `None`
/// ——来源为空本身就是"尚未分享"这件事的信息,不是缺陷。
pub fn source_label(source_type: &str, source: &str, source_url: &str) -> Option<String> {
    match source_type {
        "github" | "gitea" | "well-known" if !source.is_empty() => Some(source.to_string()),
        "git" => owner_repo_from_git_url(source_url),
        _ => None,
    }
}

/// 从裸 git URL 里取最后两段路径、去掉 `.git` 后缀,拼成 `owner/repo`。
///
/// 不用 `url::Url` 严格解析:npx skills 记的 `sourceUrl` 不保证是标准 URL
/// (可能是 `git@host:owner/repo.git` 这类 scp 写法),按路径分段处理对两种写法都适用。
fn owner_repo_from_git_url(url: &str) -> Option<String> {
    let trimmed = url.trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let segments: Vec<&str> = trimmed
        .split(['/', ':'])
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() < 2 {
        return None;
    }
    let repo = segments[segments.len() - 1];
    let owner = segments[segments.len() - 2];
    Some(format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Identity {
        Identity { login: "zhaowh".into(), display_name: "赵文浩".into() }
    }

    #[test]
    fn every_relation_maps_to_exactly_one_section() {
        assert_eq!(section(Relation::Shared), Section::SharedTo);
        assert_eq!(section(Relation::Installed), Section::InstalledFrom);
        assert_eq!(section(Relation::Draft), Section::Shareable);
        // 序列化字面量钉死(前端按它分区)
        assert_eq!(serde_json::to_string(&Section::InstalledFrom).unwrap(), "\"installedFrom\"");
        assert_eq!(serde_json::to_string(&Section::SharedTo).unwrap(), "\"sharedTo\"");
        assert_eq!(serde_json::to_string(&Section::Shareable).unwrap(), "\"shareable\"");
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

    #[test]
    fn source_label_normalises_the_four_upstream_shapes() {
        assert_eq!(
            source_label("gitea", "skills/skills", "http://g.internal/skills/skills"),
            Some("skills/skills".into())
        );
        assert_eq!(
            source_label(
                "github",
                "anthropics/skills",
                "https://github.com/anthropics/skills.git"
            ),
            Some("anthropics/skills".into())
        );
        assert_eq!(
            source_label(
                "git",
                "http://g.internal:3000/skills/skills.git",
                "http://g.internal:3000/skills/skills.git"
            ),
            Some("skills/skills".into())
        );
        assert_eq!(
            source_label(
                "well-known",
                "open.feishu.cn",
                "https://open.feishu.cn/.well-known/skills/x/SKILL.md"
            ),
            Some("open.feishu.cn".into())
        );
        assert_eq!(source_label("", "", ""), None);
    }

    /// 对外契约:前端按这三个小写字面量分区(见 `commands::InstalledSkillView`)。
    /// 此前只有类型层面的 `#[serde(rename_all = "camelCase")]` 约束,没有测试正面
    /// 断言过序列化结果真的是这三个词——v6 任务 1 复审时记的 deferred minor,
    /// 任务 2 把 `Relation` 接进 IPC DTO 时一并补上(CLAUDE.md「注入验证」纪律:
    /// 只断言"存在"分不清"拼对"与"拼错",这里正面断言值本身)。
    #[test]
    fn relation_serialises_to_the_three_literals_the_frontend_switches_on() {
        assert_eq!(serde_json::to_string(&Relation::Shared).unwrap(), "\"shared\"");
        assert_eq!(serde_json::to_string(&Relation::Installed).unwrap(), "\"installed\"");
        assert_eq!(serde_json::to_string(&Relation::Draft).unwrap(), "\"draft\"");
    }
}
