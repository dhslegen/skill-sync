//! 发版说明的解析(目标 ②:升级后首屏显示本版改了什么)。
//!
//! # 唯一真相仍是仓库根的 `RELEASE_NOTES.md`
//!
//! 那个文件早就是发版说明的唯一真相(内网 release 的正文与 README 的版本历史都从
//! 它来,`scripts/publish-release.sh` 会按版本取段落)。这个模块**只是多了一个读者**,
//! 不新造第二份数据。文件经 `bundle.resources` 打进安装包,运行时按 resource 路径读。
//!
//! # 为什么不做版本号大小比较
//!
//! 判定"用户还没看过哪几段"靠的是**文件本身新到旧的排列**——从头取到 `lastSeenVersion`
//! 那一段为止。这是发版脚本已经依赖的既有契约,复用它等于零新不变量;
//! 自己实现 semver 比较则是凭空多一条会出错的规则(`0.3.10` 与 `0.3.9`
//! 按字符串比会得出反的结论)。**别"顺手"加排序或比较。**
//!
//! # 宽容解析
//!
//! 读不到文件、格式不认得、标题里没有版本号——一律安静地少一段或返回空列表,
//! **绝不报错**。更新日志没了不该拦启动,更不该弹一个错误框
//! (同 `plaza::leaderboard` 解析失败一律 `Ok(空)` 的姿势)。

use std::path::Path;

use serde::Serialize;

use crate::error::AppError;

/// 一个版本段落。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    /// 这一段覆盖的版本号,按标题里出现的顺序。
    ///
    /// **不是一个而是一组**:仓库里真实存在 `## 0.3.5 / 0.3.4 —— 自更新链路验证`
    /// 这种写法。只认第一个的话,`lastSeenVersion = 0.3.4` 的用户在这段上匹配不到,
    /// 跨版本范围会一路取到文件末尾——把他早就看过的版本全列一遍。
    /// ⚠️ 这里比 `publish-release.sh` 的正则宽(那条只认 `## ` 后的第一个 token):
    /// 两者用途不同——脚本要"取某一版的正文",这里要"判断某一版在不在这段里"。
    pub versions: Vec<String>,
    /// 发布日期(`YYYY-MM-DD`),取自标题里版本号之后的那一段。
    ///
    /// `None` = 这一版还没发出去(发版脚本会在发版那天自动补)。**宁可不显示,
    /// 不编一个**——同"任一侧指纹缺失按没有更新处理"的姿态。
    pub date: Option<String>,
    /// 标题里 `——` 之后的主题句,给界面当副标题。没有分隔符时为空串。
    pub theme: String,
    /// 段落正文(原样 Markdown,到下一个 `## ` 为止)。
    pub body: String,
}

/// 从 `RELEASE_NOTES.md` 的全文切出版本段落,**顺序即文件顺序(新到旧)**。
pub fn parse(text: &str) -> Vec<ReleaseNote> {
    let mut out: Vec<ReleaseNote> = Vec::new();
    let mut current: Option<ReleaseNote> = None;

    for line in text.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            // 上一段到此为止。标题认不出版本号时 `current` 为 None,
            // 那一段的正文随之被丢弃——不硬猜一个版本号出来。
            if let Some(note) = current.take() {
                out.push(finish(note));
            }
            let (versions, date, theme) = split_heading(heading);
            if !versions.is_empty() {
                current = Some(ReleaseNote { versions, date, theme, body: String::new() });
            }
            continue;
        }
        if let Some(note) = current.as_mut() {
            note.body.push_str(line);
            note.body.push('\n');
        }
        // `current` 是 None 时(文件开头的前言、或认不出的标题之下)整段丢弃
    }
    if let Some(note) = current.take() {
        out.push(finish(note));
    }
    out
}

fn finish(mut note: ReleaseNote) -> ReleaseNote {
    note.body = note.body.trim().to_string();
    note
}

/// 拆标题:`0.3.5 / 0.3.4 · 2026-08-07 —— 自更新链路验证`
/// → (["0.3.5","0.3.4"], Some("2026-08-07"), "自更新链路验证")。
///
/// 版本号必须是完整三段式(`\d+.\d+.\d+`)。放宽成两段会让 `## 0.5 —— …` 这类
/// 笔误变成界面上一个根本不存在的版本号。日期形状是 `YYYY-MM-DD`,与版本号
/// 不可能互相误认(日期里没有点),但有测试正面钉住这一点。
fn split_heading(heading: &str) -> (Vec<String>, Option<String>, String) {
    let (version_part, theme) = match heading.split_once("——") {
        Some((v, t)) => (v, t.trim().to_string()),
        None => (heading, String::new()),
    };
    let tokens: Vec<&str> = version_part
        .split(|c: char| c.is_whitespace() || c == '/' || c == '·')
        .filter(|t| !t.is_empty())
        .collect();
    let versions = tokens
        .iter()
        .filter(|t| is_version(t))
        .map(|t| t.to_string())
        .collect();
    let date = tokens.iter().find(|t| is_date(t)).map(|t| t.to_string());
    (versions, date, theme)
}

/// `YYYY-MM-DD`。只查形状不查合法性——真实数据由发版脚本生成,
/// 这里要挡的是"把别的东西当成日期显示出去",不是校验日历。
fn is_date(token: &str) -> bool {
    let b = token.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_version(token: &str) -> bool {
    let mut parts = token.split('.');
    let ok = (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    });
    ok && parts.next().is_none()
}


/// 这一次启动该做什么。
///
/// 🔴 **刻意用枚举而不是"返回一个可能为空的列表"**:全新安装那一档不只是
/// "不显示",还必须**把当前版本静静记下来**——`wizard_done` 是个一次性判据,
/// 向导做完它就变成 `true`,那时若基线还是缺席,同一个从没更新过的人在
/// **第二次启动**时就会被告知「已更新到 x」。用枚举的话调用方漏掉这一档
/// 编译器会报错;用 bool 或空列表则会静默漏掉(v5 收尾时真漏了,靠推演抓到)。
#[derive(Debug)]
pub enum Decision<'a> {
    /// 不显示,也不动记账。
    Nothing,
    /// 显示这几段(新到旧)。**这时候不写记账**——写了就等于"显示即已读",
    /// 用户升级后立刻退出就永远看不到了。写入由「关掉卡片」触发。
    Show(&'a [ReleaseNote]),
    /// 全新安装:不显示,但把当前版本静静记下来。
    AdoptBaseline,
}

/// 这一次启动该给用户看什么。
///
/// 判定只看三样,全部由调用方给:当前版本、上次见过的版本、首次启动向导做没做完。
/// **不碰磁盘、不看时间**,所以可以逐档单测。
///
/// 六个出口,**判定顺序与下面的列举顺序一致**:
/// 1. 没有记录 + 向导还没做 → 全新安装,`AdoptBaseline`。
///    🔴 **这一档必须判在最前面**:当前版本没写说明时也得把基线记下来,
///    否则下次启动 `wizard_done` 已变 `true`,同一个人就被误判成"存量用户第一次
///    升上来"、被告知「已更新到 x」。有注入验证钉住这个顺序。
/// 2. 当前版本在文件里没有段落 → 什么都不做(不编一段出来);
/// 3. 记的就是当前版本 → 什么都不做(已经看过了);
/// 4. 记的是别的版本且在文件里找得到、且比当前版本旧 → 从当前版本那一段
///    取到它(不含)为止;
/// 5. 记的版本比当前版本新(降级)→ 什么都不做;
/// 6. 记的版本在文件里找不到(那一版没写说明),或没有记录但向导已做完
///    (存量用户第一次升上来)→ 只给当前版本那一段。
///
/// 🔴 **起点是当前版本那一段,不是文件开头**:发版流程要求**先写发版说明再发版**,
/// 所以"说明已进仓、包还没发"这个窗口里,文件里必然存在比当前版本更新的段落。
/// 从开头取起就会把还没发出去的那一版显示给用户。
///
/// 降级(记的版本比当前版本新)什么都不做——说"已更新到"是假话;而且那条分支
/// 不是可选的,去掉它切片会是 `notes[大..小]` 直接 panic(实测)。
pub fn decide<'a>(
    notes: &'a [ReleaseNote],
    current: &str,
    last_seen: Option<&str>,
    wizard_done: bool,
) -> Decision<'a> {
    // 全新安装这一档要先判:当前版本没写说明时也得记基线,否则下次启动照样误判。
    if last_seen.is_none() && !wizard_done {
        return Decision::AdoptBaseline;
    }
    let Some(from) = index_of(notes, current) else {
        return Decision::Nothing; // 当前版本没写说明:不编一段出来
    };
    match last_seen {
        Some(seen) if seen == current => Decision::Nothing,
        Some(seen) => match index_of(notes, seen) {
            // 索引越小越新。基线不比当前版本旧 = 降级或原地,没有"更新"可言。
            // 这条分支不是可选的:去掉它,降级时切片会是 `notes[大..小]` 直接 panic。
            Some(to) if to <= from => Decision::Nothing,
            Some(to) => Decision::Show(&notes[from..to]),
            None => Decision::Show(&notes[from..=from]),
        },
        // 存量用户第一次升上来(字段是这一版才有的)
        None => Decision::Show(&notes[from..=from]),
    }
}

/// 某个版本落在第几段。一段可以覆盖多个版本,所以是 `contains` 不是相等。
fn index_of(notes: &[ReleaseNote], version: &str) -> Option<usize> {
    notes
        .iter()
        .position(|n| n.versions.iter().any(|v| v == version))
}

/// 读并解析。**读不到就是没有日志,不是错误**(见模块头的宽容解析)。
pub fn read(path: &Path) -> Vec<ReleaseNote> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text),
        Err(e) => {
            tracing::debug!("读不到发版说明,本次不显示更新日志: {e}");
            Vec::new()
        }
    }
}

/// 更新日志的界面状态。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// 当前运行的版本。卡片标题「已更新到 x」用它,不用日志里最新那段的版本号
    /// ——文件里可能已经有一段还没发出去的版本(发版流程要求先写说明)。
    pub current: String,
    /// 这一次该给用户看的段落(新到旧)。空 = 不显示卡片。
    pub pending: Vec<ReleaseNote>,
    /// 全部段落,设置页的「版本历史」用。
    pub all: Vec<ReleaseNote>,
}

/// 读一次界面状态,**顺带在必要时静默采认基线**。
///
/// "写发生在读取路径上"与本项目 config/state 的 schema 迁移是同一个姿势
/// (CLAUDE.md:「迁移发生在读取路径上,写回是惰性的」)。这里只有全新安装那一档
/// 会写;存量用户看到日志时**不写**——那由「关掉卡片」触发,见 [`acknowledge`]。
///
/// 采认基线写失败不拦显示:最坏结果是下次启动再采认一次,而报错会把一个
/// 用户根本没要求过的动作变成他脸上的错误框。
pub fn resolve(
    store: &crate::core::state::Store,
    all: Vec<ReleaseNote>,
    current: &str,
) -> Result<State, AppError> {
    let config = store.load_config()?.value;
    let wizard_done = config.ui.as_ref().is_some_and(|u| u.wizard_done);

    let pending = match decide(&all, current, config.last_seen_version.as_deref(), wizard_done) {
        Decision::Show(notes) => notes.to_vec(),
        Decision::Nothing => Vec::new(),
        Decision::AdoptBaseline => {
            let mut next = config;
            next.last_seen_version = Some(current.to_string());
            if let Err(e) = store.save_config(&next) {
                tracing::debug!("采认更新日志基线失败,下次启动再试: {e:?}");
            }
            Vec::new()
        }
    };

    Ok(State { current: current.to_string(), pending, all })
}

/// 记下"这一版的更新日志我看过了"。由用户**关掉卡片**触发。
pub fn acknowledge(
    store: &crate::core::state::Store,
    current: &str,
) -> Result<(), AppError> {
    let mut config = store.load_config()?.value;
    config.last_seen_version = Some(current.to_string());
    store.save_config(&config)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实文件的形状:开头有标题与前言,版本段落新到旧排列,
    /// **一段可以覆盖两个版本**(`0.3.5 / 0.3.4` 是仓库里真实存在的写法)。
    const SAMPLE: &str = "\
# 版本历史

每个版本的发版说明。**这是发版说明的唯一真相**。

<!-- 新版本加在这一行下面 -->

## 0.5.0 —— 技能可以只装进某个项目文件夹

正文第一行。

- 要点一
- 要点二

## 0.3.5 / 0.3.4 —— 自更新链路验证

这一段覆盖两个版本。

## 0.1.0 —— 首个内部测试版本

最早那一版。
";


    fn notes() -> Vec<ReleaseNote> {
        parse(
            "\
## 0.6.0 —— 还没发出去的那一版

发版流程要求先写说明再发版,所以开发期文件里常常已经有比当前版本更新的段落。

## 0.5.0 —— 项目级安装

正文 5

## 0.4.0 —— 技能广场

正文 4

## 0.3.13 —— 窗口能拖动了

正文 3
",
        )
    }

    fn shown(current: &str, last_seen: Option<&str>, wizard_done: bool) -> Vec<String> {
        match decide(&notes(), current, last_seen, wizard_done) {
            Decision::Show(notes) => notes.iter().map(|n| n.versions[0].clone()).collect(),
            _ => Vec::new(),
        }
    }

    #[test]
    fn seeing_the_current_version_already_means_nothing_to_show() {
        assert!(shown("0.5.0", Some("0.5.0"), true).is_empty());
    }

    #[test]
    fn a_normal_upgrade_shows_just_the_new_version() {
        assert_eq!(shown("0.5.0", Some("0.4.0"), true), ["0.5.0"]);
    }

    #[test]
    fn skipping_versions_lists_every_missed_one_newest_first() {
        // 内网发版很密,一口气跨好几版是常态。用户拍板:漏掉的全部列出。
        assert_eq!(shown("0.5.0", Some("0.3.13"), true), ["0.5.0", "0.4.0"]);
    }

    #[test]
    fn a_section_newer_than_the_running_build_is_never_shown() {
        // 🔴 这不是假想:发版流程**要求先写发版说明再发版**,所以开发期与
        // "说明已进仓、包还没发"的窗口里,文件里必然存在比当前版本更新的段落。
        // 从文件开头取起就会把还没发出去的那一版显示给用户。
        assert_eq!(shown("0.5.0", Some("0.3.13"), true), ["0.5.0", "0.4.0"]);
        assert_eq!(shown("0.4.0", Some("0.3.13"), true), ["0.4.0"]);
    }

    #[test]
    fn a_brand_new_install_adopts_the_baseline_instead_of_being_greeted() {
        // wizardDone=false 才分得出"全新安装"与"存量用户第一次升上来"
        // ——两者的 lastSeenVersion 都是缺席的。对新人说"已更新到 0.5.0"是假话。
        //
        // 🔴 断言的是 `AdoptBaseline` 而不是"空":原先只断言空,把它与 `Nothing`
        // 混成一档,于是"要不要把基线记下来"这件事**根本没有测试**——真漏了,
        // 后果是同一个人走完向导、第二次启动就被告知「已更新到 0.5.0」。
        assert!(matches!(
            decide(&notes(), "0.5.0", None, false),
            Decision::AdoptBaseline
        ));
    }

    #[test]
    fn a_brand_new_install_adopts_the_baseline_even_with_no_section_for_this_version() {
        // 当前版本没写说明时也得记基线,否则下次启动照样把新人误判成存量用户。
        assert!(matches!(
            decide(&notes(), "9.9.9", None, false),
            Decision::AdoptBaseline
        ));
    }

    #[test]
    fn an_existing_user_upgrading_for_the_first_time_sees_this_version() {
        // 这个功能的第一批受益者:0.4.0 升到 0.5.0 的人,那时字段还不存在。
        assert_eq!(shown("0.5.0", None, true), ["0.5.0"]);
    }

    #[test]
    fn an_unknown_baseline_falls_back_to_just_this_version_instead_of_flooding() {
        // 记的版本在文件里找不到(降级过、或那一版没写说明)。宁可少列,不刷屏。
        assert_eq!(shown("0.5.0", Some("0.9.9"), true), ["0.5.0"]);
    }

    #[test]
    fn a_downgrade_shows_nothing_rather_than_claiming_an_update() {
        // 上次见到的比现在跑的还新 = 用户装回了旧版。说"已更新到"是假话。
        assert!(shown("0.4.0", Some("0.5.0"), true).is_empty());
    }

    #[test]
    fn two_versions_sharing_one_section_count_as_already_seen() {
        // `## 0.3.5 / 0.3.4 —— …` 是仓库里真实存在的写法。从 0.3.4 升到 0.3.5 时,
        // 基线与当前版本落在**同一段**(to == from),没有可看的新内容。
        // (判据里 `<=` 与 `<` 在这一档是等价的——`notes[i..i]` 是合法空切片。
        // 真正 load-bearing 的是这条分支**存在**:删掉它,降级那条用例会以
        // `slice index starts at 2 but ends at 1` panic,实测过。)
        let multi = parse("## 0.5.0 —— 新的\n\n正文\n\n## 0.3.5 / 0.3.4 —— 一段两版\n\n正文\n");
        let got = decide(&multi, "0.3.5", Some("0.3.4"), true);
        assert!(
            matches!(got, Decision::Nothing),
            "同一段里的两个版本之间没有可看的新内容,得到 {got:?}"
        );
    }

    #[test]
    fn a_version_with_no_section_shows_nothing_instead_of_inventing_one() {
        assert!(shown("0.5.1", Some("0.4.0"), true).is_empty());
    }

    #[test]
    fn sections_come_out_newest_first_and_the_preamble_is_not_one_of_them() {
        let notes = parse(SAMPLE);
        assert_eq!(notes.len(), 3, "前言不该被当成一个版本段落");
        assert_eq!(notes[0].versions, vec!["0.5.0"]);
        assert_eq!(notes[2].versions, vec!["0.1.0"]);
        // 顺序就是文件顺序(新到旧)。这条是"从头取到 lastSeen 为止"的地基:
        // 排序一反,跨版本升级会把用户已经看过的版本又列一遍。
        assert!(notes[0].body.contains("要点一"));
        assert!(!notes[0].body.contains("版本历史"), "前言混进了第一段正文");
        assert!(!notes[0].body.contains("0.3.5"), "正文越界吃进了下一段");
    }

    #[test]
    fn the_release_date_comes_out_of_the_heading() {
        // 日期是版本历史里最重要的元素之一(用户 2026-08-22 提):没有它,
        // 一列版本号看不出"这是上周的还是去年的"。
        let notes = parse("## 0.5.0 · 2026-08-22 —— 项目级安装\n\n正文\n");
        assert_eq!(notes[0].date.as_deref(), Some("2026-08-22"));
        assert_eq!(notes[0].versions, vec!["0.5.0"], "日期不能被当成版本号");
        assert_eq!(notes[0].theme, "项目级安装", "日期不能漏进主题句");
    }

    #[test]
    fn a_heading_without_a_date_is_fine_and_just_has_none() {
        // 还没发出去的版本**没有发布日期**,这是事实。宁可不显示,不编一个。
        // 发版脚本会在发版那天自动补上(日期是发版这个动作的属性,不该靠人手写)。
        let notes = parse(SAMPLE);
        assert!(notes.iter().all(|n| n.date.is_none()));
    }

    #[test]
    fn a_date_shaped_like_a_version_is_not_mistaken_for_one() {
        // `2026-08-22` 里有两个连字符,split('.') 得不到三段——但这条得钉住,
        // 因为放宽 is_version 的人未必想得到标题里还站着一个日期。
        let notes = parse("## 1.2.3 · 2026-08-22 —— 主题\n\n正文\n");
        assert_eq!(notes[0].versions, vec!["1.2.3"]);
    }

    #[test]
    fn only_a_dash_separated_ten_char_date_counts() {
        // 这条是注入验证逼出来的:原先只有正例,把形状判据整个放宽掉测试照样绿。
        // 判据松了的后果是标题里随便一个十来字符的 token 都会被当作发布日期摆到界面上。
        for bad in ["2026_08-22", "2026-08_22", "2026-8-22", "2026-08-222"] {
            let notes = parse(&format!("## 1.2.3 · {bad} —— 主题\n\n正文\n"));
            assert_eq!(notes[0].date, None, "{bad} 不是日期形状,不该被当成日期");
        }
    }

    #[test]
    fn a_heading_can_cover_more_than_one_version() {
        // 真实写法。只认第一个 token 的话,lastSeenVersion=0.3.4 的用户
        // 会在这段上匹配不到,跨版本范围就断了。
        let notes = parse(SAMPLE);
        assert_eq!(notes[1].versions, vec!["0.3.5", "0.3.4"]);
    }

    #[test]
    fn the_theme_sentence_is_separated_from_the_version_part() {
        // 卡片标题用「已更新到 <版本>」,主题句单独摆一行,所以得拆开。
        let notes = parse(SAMPLE);
        assert_eq!(notes[0].theme, "技能可以只装进某个项目文件夹");
        assert_eq!(notes[1].theme, "自更新链路验证");
    }

    #[test]
    fn a_heading_without_a_version_number_is_skipped_not_guessed() {
        let notes = parse("## 随手写的小标题\n\n正文\n\n## 0.1.0 —— 真的版本\n\n正文\n");
        assert_eq!(notes.len(), 1, "认不出版本号的段落应当跳过,不该硬猜一个");
        assert_eq!(notes[0].versions, vec!["0.1.0"]);
    }

    #[test]
    fn text_that_is_not_release_notes_at_all_yields_nothing_instead_of_an_error() {
        // 宽容解析:更新日志读不懂不该拦住任何事(同 plaza 排行榜解析失败一律 Ok(空))。
        assert!(parse("").is_empty());
        assert!(parse("随便什么东西\n没有任何标题\n").is_empty());
    }

    #[test]
    fn a_missing_file_reads_as_empty_not_as_a_failure() {
        let missing = std::path::Path::new("/nonexistent/RELEASE_NOTES.md");
        assert!(read(missing).is_empty(), "文件不在就是没有日志,不是错误");
    }

    #[test]
    fn only_a_full_three_part_version_counts() {
        // "0.5" 或 "2026.08" 这类不是本项目的版本号形状,放行会让卡片标题
        // 冒出一个根本不存在的版本。
        let notes = parse("## 0.5 —— 两段式\n\n正文\n\n## 1.2.3 —— 三段式\n\n正文\n");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].versions, vec!["1.2.3"]);
    }
}

