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
            let (versions, theme) = split_heading(heading);
            if !versions.is_empty() {
                current = Some(ReleaseNote { versions, theme, body: String::new() });
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

/// 拆标题:`0.3.5 / 0.3.4 —— 自更新链路验证` → (["0.3.5","0.3.4"], "自更新链路验证")。
///
/// 版本号必须是完整三段式(`\d+.\d+.\d+`)。放宽成两段会让 `## 0.5 —— …` 这类
/// 笔误变成界面上一个根本不存在的版本号。
fn split_heading(heading: &str) -> (Vec<String>, String) {
    let (version_part, theme) = match heading.split_once("——") {
        Some((v, t)) => (v, t.trim().to_string()),
        None => (heading, String::new()),
    };
    let versions = version_part
        .split(|c: char| c.is_whitespace() || c == '/')
        .filter(|t| is_version(t))
        .map(str::to_string)
        .collect();
    (versions, theme)
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


/// 这一次启动该给用户看哪几段(新到旧)。空 = 不显示卡片。
///
/// 判定只看三样,全部由调用方给:当前版本、上次见过的版本、首次启动向导做没做完。
/// **不碰磁盘、不看时间**,所以可以逐档单测。
///
/// 五档:
/// - 记的就是当前版本 → 空(已经看过了);
/// - 记的是别的版本且在文件里找得到 → 从当前版本那一段取到它(不含)为止;
/// - 记的版本在文件里找不到(降级过、或那一版没写说明)→ 只给当前版本那一段;
/// - 没有记录 + 向导做完了 → 存量用户第一次升上来,给当前版本那一段;
/// - 没有记录 + 向导还没做 → 全新安装,空。对新人说"已更新到 x"是假话。
///
/// 🔴 **起点是当前版本那一段,不是文件开头**:发版流程要求**先写发版说明再发版**,
/// 所以"说明已进仓、包还没发"这个窗口里,文件里必然存在比当前版本更新的段落。
/// 从开头取起就会把还没发出去的那一版显示给用户。
///
/// 降级(记的版本比当前版本新)返回空——说"已更新到"是假话。
pub fn pending<'a>(
    notes: &'a [ReleaseNote],
    current: &str,
    last_seen: Option<&str>,
    wizard_done: bool,
) -> &'a [ReleaseNote] {
    let Some(from) = index_of(notes, current) else {
        return &[]; // 当前版本没写说明:不编一段出来
    };
    match last_seen {
        Some(seen) if seen == current => &[],
        Some(seen) => match index_of(notes, seen) {
            // 索引越小越新。基线不比当前版本旧 = 降级或原地,没有"更新"可言。
            // 这条分支不是可选的:去掉它,降级时切片会是 `notes[大..小]` 直接 panic。
            Some(to) if to <= from => &[],
            Some(to) => &notes[from..to],
            None => &notes[from..=from],
        },
        None if wizard_done => &notes[from..=from],
        None => &[],
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
        pending(&notes(), current, last_seen, wizard_done)
            .iter()
            .map(|n| n.versions[0].clone())
            .collect()
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
    fn a_brand_new_install_is_not_greeted_with_a_changelog() {
        // wizardDone=false 才分得出"全新安装"与"存量用户第一次升上来"
        // ——两者的 lastSeenVersion 都是缺席的。对新人说"已更新到 0.5.0"是假话。
        assert!(shown("0.5.0", None, false).is_empty());
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
        let got = pending(&multi, "0.3.5", Some("0.3.4"), true);
        assert!(got.is_empty(), "同一段里的两个版本之间没有可看的新内容");
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
