//! 对**真实 skills.sh 与 github.com**跑通技能广场的发现两步(M9 任务 6 的 DoD)。
//!
//! 走真实外网,**默认跳过**:
//! `SKILLSYNC_PLAZA_LIVE=1 cargo test --test plaza_live -- --nocapture` 手动跑。
//! 门控写法与既有 7 个 live 测试(`github_live`/`device_flow_live` 等)一致——
//! 专属环境变量、未设时 `eprintln!` 说明并直接返回,不 `panic`、不算失败。
//!
//! wiremock 验的是"我们怎么处理响应"(`tests/plaza_search.rs`/`plaza_detail.rs`),
//! 这里验的是真实 skills.sh 响应形状与真实 GitHub zipball 这些只有真跑才见得到的东西
//! ——调查报告(`docs/调查-npx-skills-find-开放API.md`)里的样本是 2026-08-12 白天
//! 抓的,这条测试是同一天晚上 M9 收尾时又跑通一次,证明端点在当天内没有漂移。
//!
//! **断言口径:只断言形状,不断言内容。** 三条测试(M9 两条 + M10 的排行榜一条)
//! 都不去断言具体名字、条数或排名——上游数据随时会变,断死了就是给自己埋眼看会
//! 假红的地雷。
//!
//! ⚠️ "形状"这两个字在 2026-08-17 之后**变严了**:排行榜那条原先只要求
//! `owner_repo` 非空,现在要求它是真正的 `owner/repo` 两段式。原因不是想断得更死,
//! 而是真实数据里混着 `open.feishu.cn` 这类域名式来源(600 条里 31 条),
//! `core::plaza` 已经在解析阶段把它们当脏数据丢掉了——**这条 live 测试是那道过滤
//! 面对真实上游数据的唯一哨兵**:上游哪天开始给出别的形状,只有它会红。
//! 断言放松回"非空"等于把哨兵撤了。

use skillsync_lib::core::gitea::{self, RepoRef};
use skillsync_lib::core::github::GithubClient;
use skillsync_lib::core::plaza;

fn live_enabled() -> bool {
    if std::env::var("SKILLSYNC_PLAZA_LIVE").as_deref() == Ok("1") {
        true
    } else {
        eprintln!("跳过:设 SKILLSYNC_PLAZA_LIVE=1 才对真实 skills.sh/github.com 跑");
        false
    }
}

/// 真实搜索 `q=react`:断言"非空,且每条的 `owner_repo` 都是 `owner/repo` 两段式"。
///
/// 不断言具体条目——上游排序与内容会随安装量变化漂移,断结构不断值。
#[tokio::test]
async fn searches_skills_sh_for_a_real_keyword() {
    if !live_enabled() {
        return;
    }
    let http = gitea::app_http_client_proxied().expect("构造代理 client 失败");

    let cards = plaza::search(&http, plaza::PLAZA_API_BASE, "react")
        .await
        .expect("真实 skills.sh 搜索失败");

    assert!(!cards.is_empty(), "q=react 应当搜到结果");
    for card in &cards {
        assert!(!card.name.is_empty(), "每条结果都应有非空 name: {card:?}");
        assert!(!card.slug.is_empty(), "每条结果都应有非空 slug: {card:?}");
        let parts: Vec<&str> = card.owner_repo.split('/').collect();
        assert_eq!(
            parts.len(),
            2,
            "source 应是 owner/repo 两段式,实际: {:?}",
            card.owner_repo
        );
        assert!(
            !parts[0].is_empty() && !parts[1].is_empty(),
            "owner/repo 两段都不该为空: {:?}",
            card.owner_repo
        );
    }

    eprintln!("[live] q=react 搜到 {} 条", cards.len());
}

/// 对 `vercel-labs/agent-skills`(调查报告里验证过存在真实技能的仓)走
/// `fetch_repo_skills`,断言"发现到至少一个技能"。
///
/// 这条同时验证了广场详情破例路径依赖的三件事都能对真实 GitHub 跑通:
/// 匿名 `branch_head`、匿名 `download_archive`(zipball)、`store::build_index`
/// 对真实压缩包的技能发现。
#[tokio::test]
async fn discovers_skills_in_a_real_github_repo_via_fetch_repo_skills() {
    if !live_enabled() {
        return;
    }
    let http = gitea::app_http_client_proxied().expect("构造代理 client 失败");

    let branch = plaza::default_branch(&http, plaza::PLAZA_GITHUB_API_BASE, "vercel-labs", "agent-skills")
        .await
        .expect("探测 vercel-labs/agent-skills 默认分支失败");

    let client = GithubClient::new("https://github.com", None, http);
    let repo = RepoRef { owner: "vercel-labs".into(), repo: "agent-skills".into(), branch };

    let skills = plaza::fetch_repo_skills(&client, &repo)
        .await
        .expect("真实 GitHub 仓技能发现失败");

    assert!(!skills.is_empty(), "vercel-labs/agent-skills 应当发现至少一个技能");
    for skill in &skills {
        assert!(!skill.dir_slug.is_empty(), "每个技能都应有非空目录名: {skill:?}");
    }

    eprintln!(
        "[live] vercel-labs/agent-skills 发现 {} 个技能,首个目录名: {}",
        skills.len(),
        skills[0].dir_slug
    );
}

/// 真实拉一次 skills.sh 首页热门排行榜(M10 任务 4),断言"非空,且字段形状齐全"。
///
/// 与上面两条同一套姿势:不断言具体名字/排名(会随安装量漂移),只断言结构;
/// 这条额外验证了 brief 点名的两个 ground truth——**跟随了 308 重定向**(不跟随
/// 拿到的是跳转页,解析必然失败,`cards` 会是空的)与 `PLAZA_LEADERBOARD_LIMIT`
/// 生效(真实首页有 600 条,这里必须已经截到常量设的上限)。
#[tokio::test]
async fn fetches_the_real_trending_leaderboard_from_the_skills_sh_homepage() {
    if !live_enabled() {
        return;
    }
    let http = gitea::app_http_client_proxied().expect("构造代理 client 失败");

    let cards = plaza::fetch_leaderboard(&http, plaza::PLAZA_HOME_URL).await;

    assert!(
        !cards.is_empty(),
        "真实首页应当能解析出热门榜数据(若这条断红,先怀疑上游改了首页渲染实现,\
         不是网络问题——core 侧已把网络失败也降级成空列表,两种原因界面上分不出来,\
         但这条 live 测试的目的正是替我们分辨)"
    );
    assert!(
        cards.len() <= plaza::PLAZA_LEADERBOARD_LIMIT,
        "截断应当生效,实际 {} 条",
        cards.len()
    );
    for card in &cards {
        assert!(!card.name.is_empty(), "每条结果都应有非空 name: {card:?}");
        assert!(!card.slug.is_empty(), "每条结果都应有非空 slug: {card:?}");
        // 断言严格的 owner/repo 两段式——2026-08-17 真机实测抓到过
        // `"source":"open.feishu.cn"` 这种域名式来源(单段、没有斜杠),排行榜端点
        // 收录的显然不只是 GitHub 仓;点开这类条目会在 `commands::parse_owner_repo`
        // 那一层直接报"技能坐标格式不对"(压根到不了 GitHub API),已由
        // `plaza::to_leaderboard_card` 用 `is_owner_repo_shaped` 在解析阶段过滤掉
        // (2026-08-17 审查修复,见该函数文档)。这里断言"结果里不该再有漏网之鱼",
        // 是那条过滤规则在真实数据上的端到端验证。
        let parts: Vec<&str> = card.owner_repo.split('/').collect();
        assert!(
            parts.len() == 2 && parts.iter().all(|p| !p.is_empty()),
            "owner_repo 应形如 owner/repo,不该漏过滤: {:?}",
            card.owner_repo
        );
    }

    eprintln!(
        "[live] skills.sh 首页热门榜解析出 {} 条,首条: {} ({}, {} 次安装, isOfficial={})",
        cards.len(),
        cards[0].name,
        cards[0].owner_repo,
        cards[0].installs,
        cards[0].is_official
    );
}
