//! 文本级守卫:`project_skill_update` 必须从磁盘反推关联对象
//! (`project::current_agents`),不能转发请求里的 `agent_ids`
//! ——v7 任务 3 修复轮 1(复审 I1)。
//!
//! `commands.rs` 里的 `#[tauri::command]` 函数锁在真实 `HOME` 上,这个仓库一贯
//! 不直接单测这类薄壳(见 `tests/plaza_ensure_repo.rs` 的模块头)。但这条接线
//! 恰恰是本任务的**头条改动**,而三条 `set_agents`/`current_agents` 单测都不
//! 经过这条 command——测试 3 只直调 `project::current_agents`,前端测试 mock 了
//! invoke。复审当场实测:把接线改回转发 `args.agent_ids`,全仓测试(Rust + 前端)
//! 照绿,零信号。这条守卫补的就是这个空档。
//!
//! 与 `plaza_ensure_repo.rs::every_install_entry_point_mounts_the_plaza_repo_before_fetching`
//! 同款处境:断言必须在剥掉注释之后再做——本文件正上方那段 doc comment
//! (解释这次修复的来龙去脉)原样写着 `project::current_agents` 与
//! `` `args.agent_ids` ``,不剥的话这条守卫会对着自己的说明文字恒真通过,
//! 无论函数体真实写的是什么。
//!
//! # 🔴 它挡得住什么,挡不住什么(修复轮 2 补,同 `tests/body_guard.rs` 的自我坦白)
//!
//! 这是**文本级**守卫,不是语义分析。下面四条盲区**已逐条注入验证**
//! (2026-08-28,构造对应的 `commands.rs` 现场跑 `cargo test --test
//! project_update_agent_wiring`,验完全部回拷复原):
//!
//! 1. **块注释 `/* */` 剥不掉**——`function_body()` 的过滤只按行匹配
//!    `l.trim_start().starts_with("//")`,不识别 `/* ... */` 的起止。把真实调用
//!    删掉、换成 `/* project::current_agents( */` 这样一句块注释,守卫**照绿**
//!    (实测确认)。
//! 2. **行尾注释剥不掉**——同一条过滤是"整行是不是以 `//` 开头",
//!    `let agent_ids = Vec::new(); // project::current_agents(` 这种写法里,
//!    该行开头是 `let`,不会被过滤掉,行尾的说明文字照样能让正向断言通过
//!    (实测确认)。
//! 3. **看不见"调了但结果没用上"**——正向断言只问"函数体里出现过这串文本没有",
//!    `let _ = project::current_agents(&root, &args.key)?;` 之后紧接着仍然传
//!    `agent_ids: Vec::new()`(调用结果被丢弃、建链用的是硬编码空表)—— 两条断言
//!    都通过,守卫看不出行为已经坏了(实测确认)。
//! 4. **两个锚点之间插入新函数会撑大扫描范围**——`end` 锚点是"下一个函数的
//!    分界注释"这句**固定文本**,不是"当前函数的右花括号"。在
//!    `project_skill_update` 与 `project_reveal` 之间插入任意新函数,新函数的
//!    源码会被一起纳入 `function_body()` 的返回值——`project_skill_update`
//!    本身完全正确时,新函数里字面提到 `args.agent_ids`(哪怕只是字符串字面量)
//!    也会让负向断言**误判成红**(实测确认:构造出的失败信息里能看到那个
//!    不相干的新函数被打印在"实际函数体"里)。
//!
//! **方向是安全的那一半**:负向断言(`!body.contains("args.agent_ids")`)的
//! 盲区(1、2)只会让它在真出问题时**更晚发现或漏判**(假绿),而盲区 4 造成的
//! 是**假红**——错怪一个本身没问题的函数,不会放过一个真正转发了 `agent_ids`
//! 的函数体。假红比假绿容易发现(测试红了就会有人去看),这是这类文本守卫
//! 能接受的不对称。
//!
//! **这条接线目前没有可交叉引用的行为测试兜底**——`body_guard.rs` 能在文档里
//! 指给读者"真正兜底的是 `share_flow.rs` 那条断言",这里没有对应的那一条:
//! `project_skill_update` 是 `#[tauri::command]`,锁在真实 `HOME` 与真实网络请求上,
//! 这个仓库现有的测试基础设施够不到它(同 `plaza_ensure_repo.rs` 的处境,那条
//! 也没有反过来指一条行为测试)。如实写在这里,比留白让人以为"总有别处兜着"更诚实。

use std::path::Path;

/// 取出 `project_skill_update` 的函数体,过滤掉整行 `//` 注释。
///
/// 起点定在 `pub async fn project_skill_update(` **本身**——不含它上面那段
/// doc comment。那段注释里同样出现了下面要断言的两个子串,含进来会让
/// 两条断言都失去意义(不管真实代码有没有改回去,子串永远都在)。
fn function_body() -> String {
    let src = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands.rs"),
    )
    .unwrap();

    let start = src
        .find("pub async fn project_skill_update(")
        .expect("找不到 project_skill_update —— 改名了就把这条守卫一起改");
    let body = &src[start..];
    let end = body
        .find("\n/// 在文件管理器中显示项目文件夹")
        .expect("找不到下一个函数的分界注释,项目结构变了就把这条守卫一起改");

    body[..end]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn project_skill_update_derives_agents_from_disk_not_from_the_request() {
    let body = function_body();

    assert!(
        body.contains("project::current_agents("),
        "project_skill_update 必须用 project::current_agents 从磁盘反推关联对象,\
         实际函数体:\n{body}"
    );
    assert!(
        !body.contains("args.agent_ids"),
        "project_skill_update 不该再读请求里的 agent_ids——那是前端探测出来的默认值,\
         用它建链会把关联悄悄改写成一套用户从未选过的默认值。实际函数体:\n{body}"
    );
}
