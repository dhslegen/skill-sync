//! 「更新项目里的技能时,该去哪个源、哪个库取数」的判定(`project::update_target`)。
//!
//! 为什么单独有这么一层:项目级的**唯一**记账是项目根的 `skills-lock.json`,
//! 里面只有 `source`/`sourceUrl`/`sourceType` 三样,没有 `registryId`。
//! 不把它还原成"源 + 库坐标"就传给取数链路,缺省会打到**内建源的主仓**
//! ——与 M4「更新必须带账上的仓库坐标」是同一类缺陷:按钮摆着、点了要么报
//! 找不到技能,要么装进来一个同名但完全不同的技能。
//!
//! 判定复用 `acquire::resolve_binding_of`(与「纳入管理」同一把尺子),
//! 这里测的是项目级这一层的取舍:哪些档不摆按钮、GitHub 来源为什么落到广场源。

use skillsync_lib::core::acquire::BindingSources;
use skillsync_lib::core::project;
use skillsync_lib::core::project_lock::LocalEntry;
use skillsync_lib::core::registry::{BUILTIN_REGISTRY_ID, PLAZA_REGISTRY_ID};
use skillsync_lib::core::state::{RegistryConfig, RepoConfig};

fn entry(source: &str, source_url: &str, source_type: &str) -> LocalEntry {
    LocalEntry {
        source: source.into(),
        source_url: Some(source_url.into()),
        git_ref: Some("main".into()),
        source_type: source_type.into(),
        skill_path: Some(format!("skills/x/{}", "SKILL.md")),
        computed_hash: "deadbeef".into(),
    }
}

fn repo(owner: &str, name: &str) -> RepoConfig {
    RepoConfig { owner: owner.into(), repo: name.into(), branch: "main".into(), name: None }
}

#[test]
fn a_builtin_library_skill_updates_from_the_library_it_came_from_not_the_main_one() {
    let extra = vec![repo("team", "extra-skills")];
    let sources = BindingSources {
        builtin_base_url: Some("http://gitea.example"),
        builtin_repo: Some(("skills", "skills")),
        builtin_extra: &extra,
        custom: &[],
        plaza_repos: &[],
    };

    let got = project::update_target(
        &entry("team/extra-skills", "http://gitea.example/team/extra-skills.git", "git"),
        &sources,
    );

    // 坐标必须是账上那一个。缺省落回主仓 skills/skills 的话,更新会去另一个库
    // 找同名技能——找不到就报错,找到就装错内容。
    assert_eq!(got, Some((BUILTIN_REGISTRY_ID.to_string(), "team/extra-skills".to_string())));
}

#[test]
fn a_plaza_skill_updates_through_the_plaza_source() {
    let mounted = vec![repo("vercel-labs", "agent-skills")];
    let sources = BindingSources {
        builtin_base_url: Some("http://gitea.example"),
        builtin_repo: Some(("skills", "skills")),
        builtin_extra: &[],
        custom: &[],
        plaza_repos: &mounted,
    };

    let got = project::update_target(
        &entry("vercel-labs/agent-skills", "https://github.com/vercel-labs/agent-skills", "github"),
        &sources,
    );

    assert_eq!(
        got,
        Some((PLAZA_REGISTRY_ID.to_string(), "vercel-labs/agent-skills".to_string()))
    );
}

#[test]
fn a_github_skill_this_app_never_mounted_still_updates_through_the_plaza_source() {
    // 项目 lock 是与 npx skills 共用的:里面的条目**很可能不是本 app 写的**,
    // 那台机器的 config.plazaRepos 里当然没有这个仓。广场源这一档本来就是
    // "任意 GitHub 仓",取数前会幂等挂仓——所以这不是猜,是唯一正确的去处。
    let sources = BindingSources {
        builtin_base_url: Some("http://gitea.example"),
        builtin_repo: Some(("skills", "skills")),
        builtin_extra: &[],
        custom: &[],
        plaza_repos: &[],
    };

    let got = project::update_target(
        &entry("someone/their-skills", "https://github.com/someone/their-skills", "github"),
        &sources,
    );

    assert_eq!(
        got,
        Some((PLAZA_REGISTRY_ID.to_string(), "someone/their-skills".to_string()))
    );
}

#[test]
fn a_locally_created_skill_has_nowhere_to_update_from() {
    let sources = BindingSources {
        builtin_base_url: Some("http://gitea.example"),
        builtin_repo: Some(("skills", "skills")),
        builtin_extra: &[],
        custom: &[],
        plaza_repos: &[],
    };

    for kind in ["local", "node_modules", "well-known"] {
        assert_eq!(
            project::update_target(&entry("whatever", "", kind), &sources),
            None,
            "{kind} 还原不了来源,不该给出取数去处"
        );
    }
}

#[test]
fn a_git_skill_whose_source_is_gone_gets_no_target_instead_of_a_wrong_one() {
    // 自定义源被删掉了(或这台机器从来没配过它)。既不同源、又不是 GitHub,
    // 没有任何可信去处——**不摆按钮好过摆一个必然报错的按钮**(M6 同款姿势)。
    let sources = BindingSources {
        builtin_base_url: Some("http://gitea.example"),
        builtin_repo: Some(("skills", "skills")),
        builtin_extra: &[],
        custom: &[],
        plaza_repos: &[],
    };

    let got = project::update_target(
        &entry("them/theirs", "http://other-gitea.internal/them/theirs.git", "git"),
        &sources,
    );

    assert_eq!(got, None);
}

#[test]
fn a_same_origin_library_that_is_not_configured_gets_no_target() {
    // 源好好的,但这个技能库不在它的库列表里——落回主仓就是装错内容。
    let customs = vec![RegistryConfig {
        id: "custom-1".into(),
        name: "自建".into(),
        kind: "gitea".into(),
        base_url: "http://other-gitea.internal".into(),
        builtin: false,
        repos: vec![repo("them", "listed")],
    }];
    let sources = BindingSources {
        builtin_base_url: None,
        builtin_repo: None,
        builtin_extra: &[],
        custom: &customs,
        plaza_repos: &[],
    };

    let got = project::update_target(
        &entry("them/unlisted", "http://other-gitea.internal/them/unlisted.git", "git"),
        &sources,
    );

    assert_eq!(got, None);
}

#[test]
fn a_malformed_source_never_becomes_a_half_coordinate() {
    let sources = BindingSources {
        builtin_base_url: None,
        builtin_repo: None,
        builtin_extra: &[],
        custom: &[],
        plaza_repos: &[],
    };

    // 没有斜杠 / 半边为空,都不是可寻址的坐标。放行会让取数拼出 "x/" 这种键。
    for bad in ["notacoordinate", "owner/", "/repo", ""] {
        assert_eq!(
            project::update_target(&entry(bad, "https://github.com/whatever", "github"), &sources),
            None,
            "坐标形状不对却给出了去处:{bad}"
        );
    }
}
