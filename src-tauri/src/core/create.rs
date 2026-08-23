//! 新建技能:等价上游 `npx skills init` 的脚手架(M4 任务 4)。
//!
//! # 关键决定(与任务分解草案的偏离,均有实测依据,按开发纪律显式标注)
//!
//! - **只在 canonical 建目录 + 写 SKILL.md,不建链、不写 `.skill-lock.json`、不进 `state`**。
//!   上游 init 也只产出 `<name>/SKILL.md` 一个文件(录制见
//!   `tests/fixtures/skills-init/NOTES.md`)——init 给的是草稿,不是安装,而 lock 记的是
//!   "从哪装来的",新建的没有来源可记。
//!
//!   草案原写「选 agent 建链,复用 `link_agents`」,复用不了:`link_agents` 硬要求
//!   `state.installed` 里有条目。而把新建的技能记进 `installed` 会让别处**撒谎**——
//!   `acquire::precheck` 判 `recorded.source.owner != target.owner` 即 `OtherLibrary`,
//!   source 全空必然不等,于是商店里出现同名技能时卡片会说「装自另一个技能库」,
//!   可它根本不是从任何库来的。
//!
//!   代价是有限的:`resources/agents.json` 里 Cursor 与 Codex 的 `skillsDir` 就是
//!   `.agents/skills`(= canonical),草稿对它们立刻可见;只有 Claude Code
//!   (`.claude/skills`)与 Trae(`.trae/skills`)需要链接,这两个要走「分享到团队库
//!   → 从商店获取」。
//!
//!   ⚠️ 前端文案 `create.doneVisible` 把这四个工具名**写死**在句子里。真相在
//!   `AgentDef::is_universal()`(即 `skillsDir == ".agents/skills"`),而
//!   `pnpm verify:agents` 会从上游重新同步注册表——universal 集合一变,那句文案
//!   就悄悄成了假话。重新校验 agents.json 时请一并核对它。
//!
//!   而这条限制**对所有本地技能都成立**(用户手放的、npx 装的一样),
//!   不是本模块造出来的——要给 Claude Code / Trae 用,唯一的路是走「分享到技能库」
//!   (`share::scan_candidates` 会扫到这类没有关联记账的目录)再从商店重新获取。
//!
//! - **slug 必须是 [`sanitize_name`] 的不动点**,不做静默清洗。`Installer::canonical_dir`
//!   本身会把 `a--b` 清洗成 `a-b` 再建目录——对**远端来的**目录名那是对的(仓库里的
//!   名字已经是 kebab,清洗只是防御),但用户在表单里亲手填的名字被悄悄改掉不行。
//!
//! - **frontmatter 的值按需加引号,判定交给 YAML 解析器自己做**(见 [`yaml_scalar`])。
//!   手写一张"危险字符表"必漏:`yes` 会被读成布尔、`123` 读成整数、`周报: 汇总`
//!   直接是语法错误,三种都会让自己的 [`parse_skill_md`] 报"类型不对"。

use saphyr::{LoadableYamlNode, Yaml};
use serde::Serialize;

use crate::core::fsops;
use crate::core::installer::Installer;
use crate::core::skills::{sanitize_metadata, sanitize_name};
use crate::core::state::Store;
use crate::error::AppError;

/// 新建表单的三个字段。正文用固定模板,不在表单里填——写正文是编辑器的事。
pub struct CreateRequest<'a> {
    /// 目录名。ASCII kebab,强制,见模块头第二条。
    pub dir_slug: &'a str,
    /// 显示名,可中文。落 frontmatter 的 `name`。
    pub display_name: &'a str,
    pub description: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReport {
    pub dir_slug: String,
    /// 绝对路径,用于完成提示与「在访达中显示」。
    pub path: String,
}

/// slug 可否直接做目录名:必须已经是 [`sanitize_name`] 的不动点。
///
/// 与 `share::usable_share_name` 是**同一把尺子**(那边定远端目录名,这边定本地目录名)。
/// 前端 `lib/slug.ts` 另有一份等价判定,两侧各有一条测试断言与
/// `fixtures/slug-samples.json` 一致——那份 fixture 是这条口径的唯一真相。
pub fn usable_slug(slug: &str) -> bool {
    sanitize_name(slug) == slug && slug != "unnamed-skill"
}

/// 新建一个技能到 canonical 目录。
///
/// 撞名一律拒绝、**绝不覆盖**,且拒的时候磁盘一个字节都没动。
pub fn create_skill(
    installer: &Installer<'_>,
    store: &Store,
    req: &CreateRequest<'_>,
) -> Result<CreateReport, AppError> {
    // 写盘期间的文件事件不上报(与获取/移除同理)
    let _quiet = crate::core::watcher::app_write();
    if !usable_slug(req.dir_slug) {
        return Err(AppError::new(
            "FS_UNUSABLE_NAME",
            "文件夹名只能用小写英文字母、数字、下划线和点,短横线不能连用也不能放在首尾",
        )
        .with_detail(format!("not a sanitize_name fixpoint: {}", req.dir_slug)));
    }

    // 清洗与 frontmatter 解析回来时同一套(换行折空格、剥终端转义),
    // 这样"写进去的"与"读出来的"严格相等,往返测试才立得住
    let display_name = sanitize_metadata(req.display_name).trim().to_string();
    let description = sanitize_metadata(req.description).trim().to_string();
    if display_name.is_empty() {
        return Err(AppError::new("FS_UNUSABLE_NAME", "请填写技能的名称"));
    }
    if description.is_empty() {
        return Err(AppError::new("FS_UNUSABLE_NAME", "请填写这个技能是做什么的"));
    }

    let dir = installer.canonical_dir(req.dir_slug)?;
    let state = store.load_state()?.value;

    // 两种撞法各拒一次。第二条**不被第一条覆盖**:记账还在而用户把本体删了时
    // (断链态)目录并不存在,直接建会顶掉那份记账,而 `state.installed` 驱动着
    // 更新 / 解链 / 移除,顶掉它等于让那几条路去操作一个完全无关的技能。
    //
    // 🔴 **这里曾经还有第三条:`state.shared` 里有条记账指着这个位置就拒**
    // (v6 任务 3 修复轮 1 删除)。它是一条死路:
    // - 本体**还在**时,第一条(目录里有东西)已经拒了,第三条从来轮不到;
    // - 本体**不在**时,那条记账就是孤儿(移除没清干净、或旧版
    //   `adopt_into_management` 留下的),而**「占用」在本体不存在时是假话**
    //   ——用户拿到的是「这个名字已经被一个分享过的技能占用了」这样一句永久拒绝,
    //   指的却是一个他电脑上已经没有的技能。「取回我分享的 → 移除 → 重新起草一个
    //   同名的」是 v6 的主线路径,它在那里撞进死胡同。
    //
    // 换句话说,「有没有被占用」的判据就该是**磁盘上真的有没有东西**,那正是
    // 第一条 `dir_occupied` 在做的事;拿一本可能过期的账去回答同一个问题,
    // 对了是多余、错了是死路。新产生的孤儿由 `remove::remove` 一并清掉,
    // 存量的靠这里放行救回来。代价已知且可接受:新起草的技能会短暂沿用那条旧记账的
    // 远端绑定(界面上显示成"分享过"),而它与新技能**同名**、下次分享本来也要推到
    // 同一个位置,自我纠正。
    if dir_occupied(&dir) {
        return Err(taken("本地已经有同名的技能文件夹了,换一个名字吧", &dir.display()));
    }
    if state.installed.iter().any(|s| s.name == req.dir_slug) {
        return Err(taken("这个名字已经被一个已获取的技能占用了,换一个吧", &req.dir_slug));
    }
    let path_str = dir.to_string_lossy().into_owned();

    fsops::write_file(
        &dir.join("SKILL.md"),
        skill_md(&display_name, &description).as_bytes(),
        None,
    )?;

    Ok(CreateReport {
        dir_slug: req.dir_slug.to_string(),
        path: path_str,
    })
}

fn taken(message: &str, detail: &impl std::fmt::Display) -> AppError {
    AppError::new("CONFLICT_NAME_TAKEN", message).with_detail(format!("taken: {detail}"))
}

/// 目录是否已被占用。
///
/// **空目录放行**:写 SKILL.md 那一步失败(磁盘满 / 权限)会留下一个空目录,
/// 一律拒就等于同一个名字再也建不成了。空目录里没有任何东西会被毁,放行是安全的。
fn dir_occupied(dir: &std::path::Path) -> bool {
    match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_some(),
        // 不存在(常态)读不出来;读得到但报错(权限)也当没占用——
        // 真占着的话写入自会失败,不必在这里替它下结论
        Err(_) => false,
    }
}

/// 生成 SKILL.md。结构与上游 init 一致(标题 / 何时使用 / 步骤),正文改中文
/// ——本 app 的用户是非研发中文同事,给一份英文骨架等于让他们先翻译再动手。
fn skill_md(display_name: &str, description: &str) -> String {
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n# {display_name}\n\n\
         在这里写清楚你希望 AI 做什么。写得越具体,它做得越准。\n\n\
         ## 何时使用\n\n\
         描述什么情况下应该用到这个技能。\n\n\
         ## 步骤\n\n\
         1. 第一步\n2. 第二步\n3. 按需补充\n",
        yaml_scalar(display_name),
        yaml_scalar(description),
    )
}

/// 把一个字符串写成 YAML 标量:能裸写就裸写,否则双引号 + 转义。
///
/// **判定交给解析器自己做**,不手写危险字符表:裸写一遍再读回来,读到的不是等值
/// 字符串就说明裸写会走样(`yes` 成布尔、`123` 成整数、`名字: 说明` 直接语法错)。
fn yaml_scalar(value: &str) -> String {
    let plain_ok = Yaml::load_from_str(&format!("v: {value}"))
        .ok()
        .and_then(|docs| {
            docs.first()
                .filter(|d| d.is_mapping())
                .and_then(|d| d.as_mapping_get("v"))
                .and_then(|v| v.as_str().map(|s| s == value))
        })
        .unwrap_or(false);
    if plain_ok {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::skills::parse_skill_md;

    /// 与前端共读 `fixtures/slug-samples.json`——**一份真相,两侧各测一次**。
    /// 手抄两份样本表的话,口径漂了两边照样各自全绿,那道护栏就是空转的。
    #[test]
    fn usable_slug_agrees_with_the_shared_sample_file() {
        const RAW: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/slug-samples.json"
        ));
        let doc: serde_json::Value = serde_json::from_str(RAW).expect("样本文件应当是合法 JSON");
        let samples = doc["samples"].as_array().expect("samples 应当是数组");
        assert!(samples.len() >= 15, "样本表被删剩 {} 条了", samples.len());
        for s in samples {
            let slug = s["slug"].as_str().expect("slug 应当是字符串");
            let expected = s["valid"].as_bool().expect("valid 应当是布尔");
            assert_eq!(
                usable_slug(slug),
                expected,
                "slug {slug:?} 与样本表不一致({})",
                s["why"].as_str().unwrap_or("")
            );
        }
    }

    /// 往返:写进去的显示名与描述,必须能被自己的解析器一字不差地读回来。
    /// 刁钻输入全在这里——YAML 标量的坑就靠这条兜住。
    #[test]
    fn generated_skill_md_round_trips_through_parser() {
        let cases = [
            ("周报生成", "每周自动汇总工作进展"),
            // 冒号后带空格是 YAML 的键值分隔,裸写直接语法错
            ("周报: 汇总", "把 A: B 的格式整理成表格"),
            // 裸写会被读成整数 / 浮点 / null
            ("123", "3.14"),
            ("null", "~"),
            // 实测:saphyr 走 YAML 1.2 core schema,只认 true/false,
            // `yes`/`no`/`on` 裸写读回来就是字符串(YAML 1.1 才把它们当布尔)
            ("yes", "no"),
            // 井号是注释起始
            ("tag #1", "带 # 的说明"),
            // 引号与反斜杠要转义
            ("说\"引号\"", "路径 C:\\Users\\me"),
            // 以 YAML 指示符开头
            ("- dash", "* star"),
            ("[bracket]", "{brace}"),
            ("&anchor", "*alias"),
            // 前后空白会被 trim,这里给已 trim 的值
            ("多 空 格", "a  b"),
        ];
        for (name, description) in cases {
            let raw = skill_md(name, description);
            let parsed = parse_skill_md(&raw)
                .unwrap_or_else(|e| panic!("{name:?} / {description:?} 解析失败: {e:?}"));
            assert_eq!(parsed.name, name, "name 往返走样");
            assert_eq!(parsed.description, description, "description 往返走样");
        }
    }

    #[test]
    fn template_body_carries_display_name_and_sections() {
        let raw = skill_md("周报生成", "每周汇总");
        let parsed = parse_skill_md(&raw).expect("模板应当合规");
        assert!(parsed.body.contains("# 周报生成"), "正文标题应当是显示名");
        assert!(parsed.body.contains("## 何时使用"));
        assert!(parsed.body.contains("## 步骤"));
    }

    /// 两个方向都要钉住,否则这个函数会悄悄退化。
    ///
    /// 写成**性质断言**而不是逐个写死形态,是因为"哪些值裸写会走样"取决于解析器的
    /// schema,不该由我在测试里再猜一遍——写这条测试的过程中就猜错两次
    /// (`yes` 在 YAML 1.2 下不是布尔;`say "hi"` 的引号不在开头,裸写也合法)。
    #[test]
    fn yaml_scalar_round_trips_and_does_not_over_quote() {
        // 方向一(正确性):无论加不加引号,读回来必须逐字等于原值
        for v in [
            "weekly report", "周报生成", "yes", "123", "3.14", "null", "~",
            "a: b", "tag #1", "say \"hi\"", "C:\\Users\\me", "- dash",
            "[bracket]", "{brace}", "&anchor", "*alias", "%directive", "@at",
            "!tag", "|pipe", ">fold", "'single'", "back`tick",
        ] {
            let raw = format!("v: {}", yaml_scalar(v));
            let docs = Yaml::load_from_str(&raw)
                .unwrap_or_else(|e| panic!("{v:?} 生成了非法 YAML({raw:?}): {e}"));
            let got = docs
                .first()
                .filter(|d| d.is_mapping())
                .and_then(|d| d.as_mapping_get("v"))
                .and_then(|x| x.as_str());
            assert_eq!(got, Some(v), "{v:?} 往返走样,生成的是 {raw:?}");
        }
        // 方向二(不过度):不能退化成"一律加引号",平凡文本必须裸写
        assert_eq!(yaml_scalar("weekly report"), "weekly report");
        assert_eq!(yaml_scalar("周报生成"), "周报生成");
        // 而整数字面量确实会走样,必须加引号
        assert_eq!(yaml_scalar("123"), "\"123\"");
    }
}
