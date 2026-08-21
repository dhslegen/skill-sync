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
