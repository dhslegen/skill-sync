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
