//! 认领上游安装(M3 任务 6)的编排测试。
//!
//! 断言纪律与 remove_flow 相同:关心磁盘与账本的实际字节,不只看返回枚举。
//! 铁律级断言:认领**不动 lock 一个字节**——那是 npx skills 的数据。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use skillsync_lib::core::acquire;
use skillsync_lib::core::agents::{AgentEnv, AgentRegistry};
use skillsync_lib::core::fsops::{self, OnOccupied};
use skillsync_lib::core::installer::Installer;
use skillsync_lib::core::remove::{self, RemoveOutcome};
use skillsync_lib::core::state::{RegistryConfig, RepoConfig, Store};

const NOW: &str = "2026-07-31T12:00:00.000Z";

struct TmpEnv {
    home: PathBuf,
    vars: HashMap<String, String>,
}

impl AgentEnv for TmpEnv {
    fn home(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn var(&self, name: &str) -> Option<String> {
        self.vars.get(name).cloned()
    }
    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

struct Ctx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    registry: AgentRegistry,
    store: Store,
}

fn ctx() -> (Ctx, TmpEnv) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let env = TmpEnv {
        home: home.clone(),
        vars: HashMap::new(),
    };
    let store = Store::new(home.join(".skillsync"));
    (
        Ctx {
            _tmp: tmp,
            home,
            registry: AgentRegistry::builtin(),
            store,
        },
        env,
    )
}

/// 模拟一次 npx skills 的全局安装:canonical 落盘 + claude-code 目录建链 + lock 记账。
fn upstream_install(ctx: &Ctx, slug: &str) {
    let canonical = ctx.home.join(".agents/skills").join(slug);
    std::fs::create_dir_all(&canonical).unwrap();
    std::fs::write(
        canonical.join("SKILL.md"),
        format!("---\nname: 上游技能\ndescription: 说明\n---\n{slug}\n"),
    )
    .unwrap();

    let claude_dir = ctx.home.join(".claude/skills");
    std::fs::create_dir_all(&claude_dir).unwrap();
    // 用平台降级链建链(macOS symlink / Windows junction),与 npx 的产物同形态
    fsops::link_dir(
        &canonical,
        &claude_dir.join(slug),
        fsops::default_link_chain(),
        OnOccupied::Fail,
    )
    .unwrap();

    let lock = ctx.home.join(".agents/.skill-lock.json");
    let doc = serde_json::json!({
        "version": 3,
        "skills": {
            slug: {
                "source": "vercel-labs/skills",
                "sourceType": "github",
                "sourceUrl": "https://github.com/vercel-labs/skills",
                "skillFolderHash": "abc123",
                "installedAt": "2026-07-01T00:00:00.000Z",
                "updatedAt": "2026-07-01T00:00:00.000Z"
            }
        },
        "dismissed": ["someone-elses-flag"]
    });
    std::fs::write(&lock, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
}

/// 模拟一次**本 app 自己**的安装留下的痕迹,然后把 state 抹掉
/// ——等价于重装 app / 换机器 / state.json 损坏之后的现场:
/// canonical 有文件、lock 有条目(sourceType gitea、sourceUrl 是 "owner/repo" 不是 URL),
/// 但本 app 的账上什么都没有。
fn company_install(ctx: &Ctx, slug: &str) {
    let canonical = ctx.home.join(".agents/skills").join(slug);
    std::fs::create_dir_all(&canonical).unwrap();
    std::fs::write(
        canonical.join("SKILL.md"),
        format!("---\nname: 公司技能\ndescription: 说明\n---\n{slug}\n"),
    )
    .unwrap();

    let lock = ctx.home.join(".agents/.skill-lock.json");
    let mut doc: serde_json::Value = std::fs::read_to_string(&lock)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({ "version": 3, "skills": {} }));
    doc["skills"][slug] = serde_json::json!({
        // 与 acquire.rs 写 lock 时逐字一致:sourceUrl 就是 "owner/repo",不是 URL
        "source": "skills/skills",
        "sourceType": "gitea",
        "sourceUrl": "skills/skills",
        "skillFolderHash": "",
        "installedAt": "2026-07-01T00:00:00.000Z",
        "updatedAt": "2026-07-01T00:00:00.000Z"
    });
    std::fs::write(&lock, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
}

/// 内建源 = 公司库 `skills/skills`(测试构建不注入编译期常量,所以显式给坐标)。
fn company_sources(custom: &[RegistryConfig]) -> acquire::BindingSources<'_> {
    acquire::BindingSources {
        builtin_base_url: Some("http://gitea.internal.example"),
        builtin_repo: Some(("skills", "skills")),
        builtin_extra: &[],
        custom,
    }
}

/// 只有自定义源、没有内建源(内建坐标未注入的构建)。
fn custom_only(custom: &[RegistryConfig]) -> acquire::BindingSources<'_> {
    acquire::BindingSources {
        builtin_base_url: None,
        builtin_repo: None,
        builtin_extra: &[],
        custom,
    }
}

fn github_registry() -> RegistryConfig {
    RegistryConfig {
        id: "custom-7".into(),
        name: "开源技能集".into(),
        kind: "github".into(),
        base_url: "https://github.com".into(),
        builtin: false,
        repos: vec![RepoConfig {
            owner: "vercel-labs".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        }],
    }
}

#[test]
fn claims_an_upstream_skill_adopting_links_without_touching_the_lock() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let lock_path = ctx.home.join(".agents/.skill-lock.json");
    let lock_before = std::fs::read(&lock_path).unwrap();

    let installer = Installer::new(&ctx.registry, &env);
    let report = acquire::claim(
        &installer,
        &ctx.registry,
        &env,
        &ctx.store,
        &custom_only(&[github_registry()]),
        "weekly-report",
        NOW,
    )
    .unwrap();

    assert!(report.bound, "sourceUrl 与已配置 GitHub 源同源,应当绑定");
    assert_eq!(report.adopted_links, 1, "claude-code 的链接应被收编入账");

    let st = ctx.store.load_state().unwrap().value;
    assert_eq!(st.installed.len(), 1);
    let s = &st.installed[0];
    assert_eq!(s.name, "weekly-report");
    assert_eq!(s.source.registry_id, "custom-7");
    assert_eq!(s.source.owner, "vercel-labs");
    assert_eq!(s.source.repo, "skills");
    assert_eq!(s.commit_sha, "", "基线版本未知,commit_sha 必须留空");
    assert!(!s.content_hash.is_empty(), "content_hash 以认领此刻为基线");
    assert!(s.agents.contains(&"claude-code".to_string()));
    assert_eq!(s.links.len(), 1);
    // 上游的安装时间照抄,不冒充是现在装的
    assert_eq!(s.installed_at, "2026-07-01T00:00:00.000Z");

    // 铁律:lock 一个字节不动(他人的 dismissed 等条目原样在)
    let lock_after = std::fs::read(&lock_path).unwrap();
    assert_eq!(lock_before, lock_after, "认领动了 lock——那是 npx skills 的数据");
}

#[test]
fn without_a_matching_registry_the_claim_is_local_only() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);

    // 配了一个 GitHub kind 的源,但它是别家 GHE——与上游 sourceUrl(github.com)不同源。
    // 只看 kind 不比对同源的实现会把 GHE 源错绑上(注入验证曾抓到这条测试缺辨别场景)。
    let ghe = RegistryConfig {
        id: "custom-9".into(),
        name: "内网 GHE".into(),
        kind: "github".into(),
        base_url: "https://ghe.example.com".into(),
        builtin: false,
        repos: vec![RepoConfig {
            owner: "tools".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        }],
    };
    let report = acquire::claim(
        &installer,
        &ctx.registry,
        &env,
        &ctx.store,
        &custom_only(&[ghe]),
        "weekly-report",
        NOW,
    )
    .unwrap();

    assert!(!report.bound, "不同源的 GitHub 源不得被错绑");
    let st = ctx.store.load_state().unwrap().value;
    assert_eq!(st.installed[0].source.registry_id, "", "绑不上就留空,不能瞎绑内建源");
    // 展示信息仍在
    assert_eq!(st.installed[0].source.owner, "vercel-labs");
}

#[test]
fn same_origin_but_a_different_repo_is_not_bound() {
    // M4 任务 1:同源还不够,技能所属的库也得在源的库列表里。
    // 绑上去等于承诺"能从这个来源更新它",而源里没有这个库时,更新只会去主库
    // 找同名技能——找不到就报错,找到就装错内容(M3 起就静默存在的错绑)。
    let (ctx_a, env_a) = ctx();
    upstream_install(&ctx_a, "weekly-report"); // 上游来源是 vercel-labs/skills
    let installer = Installer::new(&ctx_a.registry, &env_a);

    let other_repo = RegistryConfig {
        // 同一个 github.com,但配的是另一个技能库
        repos: vec![RepoConfig {
            owner: "someone".into(),
            repo: "other-skills".into(),
            branch: "main".into(),
            name: None,
        }],
        ..github_registry()
    };
    let report = acquire::claim(
        &installer,
        &ctx_a.registry,
        &env_a,
        &ctx_a.store,
        &custom_only(std::slice::from_ref(&other_repo)),
        "weekly-report",
        NOW,
    )
    .unwrap();

    assert!(!report.bound, "同源但技能库对不上,不得绑定");
    let st = ctx_a.store.load_state().unwrap().value;
    assert_eq!(st.installed[0].source.registry_id, "");
    // 展示信息仍如实保留
    assert_eq!(st.installed[0].source.owner, "vercel-labs");
    assert_eq!(st.installed[0].source.repo, "skills");

    // 对照组:同一个源里**追加**上这个库之后,同一次认领就该绑上了
    let mut with_repo = other_repo;
    with_repo.repos.push(RepoConfig {
        owner: "vercel-labs".into(),
        repo: "skills".into(),
        branch: "main".into(),
        name: None,
    });
    let (ctx_b, env_b) = ctx();
    upstream_install(&ctx_b, "weekly-report");
    let installer_b = Installer::new(&ctx_b.registry, &env_b);
    let report_b = acquire::claim(
        &installer_b,
        &ctx_b.registry,
        &env_b,
        &ctx_b.store,
        &custom_only(&[with_repo]),
        "weekly-report",
        NOW,
    )
    .unwrap();
    assert!(report_b.bound, "库在列表里就该绑上——否则上面那条断言证明不了是库在起作用");
    assert_eq!(
        ctx_b.store.load_state().unwrap().value.installed[0].source.registry_id,
        "custom-7"
    );
}

/// 本 app 自己装的技能写进 lock 的是 `sourceType: gitea` + `sourceUrl: "owner/repo"`
/// (不是 URL),而内建源**不在 config.registries 里**(坐标是编译期常量)。
/// 两件事叠起来:公司库装的技能一旦脱管(重装 app / 换机器 / state.json 丢了),
/// 认领回来一律绑不上——M3 起就是这样,认领对主线场景从来没生效过(M6 任务 4 修)。
#[test]
fn a_company_library_skill_rebinds_to_the_builtin_source_when_reclaimed() {
    let (ctx, env) = ctx();
    company_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);

    let report = acquire::claim(
        &installer,
        &ctx.registry,
        &env,
        &ctx.store,
        &company_sources(&[]),
        "weekly-report",
        NOW,
    )
    .unwrap();

    assert!(report.bound, "公司库装的技能脱管后必须能绑回内建源");
    let src = ctx.store.load_state().unwrap().value.installed[0].source.clone();
    assert_eq!(
        (src.registry_id.as_str(), src.owner.as_str(), src.repo.as_str()),
        ("company", "skills", "skills"),
    );
}

/// 说不清是哪个库就不绑:`sourceUrl` 不是 URL 时只能按 owner/repo 找,
/// 两个源都有同名库时绑谁都是猜——宁可不绑(与"任一侧指纹缺失按没有更新处理"同一姿态)。
#[test]
fn an_ambiguous_owner_repo_is_left_unbound() {
    let (ctx, env) = ctx();
    company_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);

    // 自定义源里也有一个 skills/skills
    let twin = RegistryConfig {
        id: "custom-3".into(),
        name: "另一个 Gitea".into(),
        kind: "gitea".into(),
        base_url: "https://gitea.example.com".into(),
        builtin: false,
        repos: vec![RepoConfig {
            owner: "skills".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        }],
    };

    let report = acquire::claim(
        &installer,
        &ctx.registry,
        &env,
        &ctx.store,
        &company_sources(std::slice::from_ref(&twin)),
        "weekly-report",
        NOW,
    )
    .unwrap();

    assert!(!report.bound, "两个源都有同名库,绑谁都是猜");
    assert_eq!(ctx.store.load_state().unwrap().value.installed[0].source.registry_id, "");
}

/// 未认领清单要顺带给出绑定结论:界面靠它决定摆「认领」还是摆「分享到技能库」
/// ——绑不上的认领只多出"修复关联"与"移除",摆出来就是引诱用户点一个没有意义的按钮。
#[test]
fn the_unclaimed_listing_reports_whether_each_one_would_bind() {
    let (ctx, env) = ctx();
    // upstream_install 是整份覆写 lock,company_install 是合并——顺序不能反
    upstream_install(&ctx, "from-github"); // github.com/vercel-labs/skills:没配那个源
    company_install(&ctx, "from-company"); // 内建库来的:绑得上

    let installer = Installer::new(&ctx.registry, &env);
    let st = ctx.store.load_state().unwrap().value;
    let list = acquire::unclaimed_skills(&env, &installer, &st, &company_sources(&[]));

    let binding = |slug: &str| {
        list.iter()
            .find(|u| u.dir_slug == slug)
            .unwrap_or_else(|| panic!("{slug} 不在未认领清单里"))
            .binding
            .clone()
    };
    assert!(matches!(binding("from-company"), acquire::SourceBinding::Bound { .. }));
    assert!(matches!(binding("from-github"), acquire::SourceBinding::NoSource));

    // 与真认领的结论一致——清单说能绑,认领就必须真绑上(两套判定各写一份必然漂移)
    let report = acquire::claim(
        &installer,
        &ctx.registry,
        &env,
        &ctx.store,
        &company_sources(&[]),
        "from-company",
        NOW,
    )
    .unwrap();
    assert!(report.bound);
}

#[test]
fn claim_refuses_managed_missing_and_non_upstream() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);

    // 本体不在:lock 有条目但目录已删
    std::fs::remove_dir_all(ctx.home.join(".agents/skills/weekly-report")).unwrap();
    let err = acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &custom_only(&[]), "weekly-report", NOW)
        .unwrap_err();
    assert_eq!(err.code, "FS_NOT_CLAIMABLE");

    // 不是上游装的:目录在但 lock 没条目
    let stray = ctx.home.join(".agents/skills/hand-made");
    std::fs::create_dir_all(&stray).unwrap();
    let err = acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &custom_only(&[]), "hand-made", NOW)
        .unwrap_err();
    assert_eq!(err.code, "FS_NOT_CLAIMABLE");

    // 已在管理中:state 里有记账
    std::fs::create_dir_all(ctx.home.join(".agents/skills/weekly-report")).unwrap();
    acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &custom_only(&[]), "weekly-report", NOW).unwrap();
    let err = acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &custom_only(&[]), "weekly-report", NOW)
        .unwrap_err();
    assert_eq!(err.code, "CONFLICT_ALREADY_MANAGED");
}

#[test]
fn removal_after_claim_cleans_adopted_links_and_the_lock_entry() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);
    acquire::claim(
        &installer,
        &ctx.registry,
        &env,
        &ctx.store,
        &custom_only(&[github_registry()]),
        "weekly-report",
        NOW,
    )
    .unwrap();

    // 认领后走既有移除:未改动、不带 force,应一次移除干净
    let outcome =
        remove::remove(&installer, &env, &ctx.store, "weekly-report", false).unwrap();
    assert!(matches!(outcome, RemoveOutcome::Removed { .. }));

    let link = ctx.home.join(".claude/skills/weekly-report");
    assert!(
        fsops::read_link_target(&link).is_none() && !link.exists(),
        "收编入账的链接应随移除解掉,不留断链"
    );
    assert!(!ctx.home.join(".agents/skills/weekly-report").exists());
    let lock_text =
        std::fs::read_to_string(ctx.home.join(".agents/.skill-lock.json")).unwrap();
    assert!(!lock_text.contains("weekly-report"), "移除应清掉 lock 条目(既有语义)");
    assert!(lock_text.contains("someone-elses-flag"), "他人的 dismissed 数据必须原样保留");
}

#[test]
fn unclaimed_listing_skips_managed_and_missing_bodies() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);

    // 再补两条 lock 条目:一条本体已删,一条随后被认领
    let lock_path = ctx.home.join(".agents/.skill-lock.json");
    let mut doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();
    for key in ["gone-skill", "managed-skill"] {
        doc["skills"][key] = serde_json::json!({
            "source": "someone/repo", "sourceType": "github",
            "sourceUrl": "https://github.com/someone/repo", "skillFolderHash": ""
        });
    }
    std::fs::write(&lock_path, serde_json::to_string(&doc).unwrap()).unwrap();
    std::fs::create_dir_all(ctx.home.join(".agents/skills/managed-skill")).unwrap();
    acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &custom_only(&[]), "managed-skill", NOW).unwrap();

    let st = ctx.store.load_state().unwrap().value;
    let unclaimed = acquire::unclaimed_skills(&env, &installer, &st, &custom_only(&[]));
    assert_eq!(unclaimed.len(), 1, "已管理与本体缺失的都不该列");
    assert_eq!(unclaimed[0].dir_slug, "weekly-report");
    assert_eq!(unclaimed[0].source, "vercel-labs/skills");
}

// ============================================================ 取消认领(M4 任务 6a)

/// 黄金测试:**claim → unclaim 之后,磁盘与 lock 必须与认领之前逐字节相同**。
///
/// 这一条断言就是整个契约。认领本身是纯记账(claim 全程只调一次 save_state),
/// 所以它的撤销也必须是纯记账——磁盘、各工具下的链接、`.skill-lock.json` 全不动。
///
/// 在 unclaim 存在之前,认领后唯一的退出路径是「移除」,而移除会解链 → 删本体 →
/// 从 lock 删条目:用户点一个零副作用的动作,反悔时唯一的按钮会把这个技能从
/// npx skills 那边一并毁掉(2026-08-04 用户实测报的)。
///
/// 注:比这三条断言更硬的保障是**签名本身**——`unclaim(store, dir_slug)` 里既没有
/// `Installer` 也没有 `AgentEnv`,它在类型层面就拿不到 canonical 路径与 lock 落点,
/// 结构上动不了磁盘。这条测试是"将来有人给它加参数"时的护栏。
#[test]
fn unclaim_restores_everything_exactly_as_it_was_before_the_claim() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let canonical = ctx.home.join(".agents/skills/weekly-report");
    let lock_path = ctx.home.join(".agents/.skill-lock.json");
    let link = ctx.home.join(".claude/skills/weekly-report");

    let skill_before = std::fs::read(canonical.join("SKILL.md")).unwrap();
    let lock_before = std::fs::read(&lock_path).unwrap();
    let link_target_before = fsops::read_link_target(&link);
    assert!(link_target_before.is_some(), "前提:npx 建的链接存在");

    let installer = Installer::new(&ctx.registry, &env);
    acquire::claim(
        &installer, &ctx.registry, &env, &ctx.store,
        &custom_only(&[github_registry()]), "weekly-report", NOW,
    )
    .expect("认领应当成功");
    assert_eq!(ctx.store.load_state().unwrap().value.installed.len(), 1);

    acquire::unclaim(&ctx.store, "weekly-report").expect("取消认领应当成功");

    // 记账没了
    assert!(ctx.store.load_state().unwrap().value.installed.is_empty());
    // 而磁盘上的一切原封不动——这才是"无损撤销"
    assert_eq!(
        std::fs::read(canonical.join("SKILL.md")).unwrap(),
        skill_before,
        "技能本体不该被动过"
    );
    assert_eq!(std::fs::read(&lock_path).unwrap(), lock_before, "lock 不该被动过");
    assert_eq!(
        fsops::read_link_target(&link),
        link_target_before,
        "npx 建的链接不该被解掉"
    );
}

/// 取消认领后,它回到「未认领」那一档,可以再认领一次——一进一出都无损。
#[test]
fn unclaimed_skill_shows_up_again_and_can_be_reclaimed() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);
    let claim_once = || {
        acquire::claim(
            &installer, &ctx.registry, &env, &ctx.store,
            &custom_only(&[github_registry()]), "weekly-report", NOW,
        )
    };

    claim_once().unwrap();
    acquire::unclaim(&ctx.store, "weekly-report").unwrap();

    let st = ctx.store.load_state().unwrap().value;
    let pending = acquire::unclaimed_skills(&env, &installer, &st, &custom_only(&[]));
    assert_eq!(pending.len(), 1, "该回到未认领那一档");
    assert_eq!(pending[0].dir_slug, "weekly-report");

    claim_once().expect("应当能再认领一次");
    assert_eq!(ctx.store.load_state().unwrap().value.installed.len(), 1);
}

/// 从技能库获取的**不许**取消认领:文件是本 app 装的,只删记账会留下
/// 孤儿目录与孤儿链接——那正是「绝不静默毁坏」要防的。
#[test]
fn refuses_to_unclaim_a_skill_that_was_acquired_from_a_library() {
    let (ctx, _env) = ctx();
    let mut st = skillsync_lib::core::state::State::default();
    st.installed.push(skillsync_lib::core::state::InstalledSkill {
        name: "weekly-report".into(),
        source: skillsync_lib::core::state::SkillSource {
            registry_id: "builtin".into(),
            owner: "skills".into(),
            repo: "skills".into(),
            path: "skills/weekly-report".into(),
            git_ref: "abc".into(),
        },
        commit_sha: "abc123".into(),
        content_hash: "hash".into(),
        origin: Some(acquire::ORIGIN_ACQUIRED.into()),
        agents: vec![],
        links: vec![],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    });
    ctx.store.save_state(&st).unwrap();

    let err = acquire::unclaim(&ctx.store, "weekly-report").unwrap_err();
    assert_eq!(err.code, "CONFLICT_NOT_CLAIMED");
    // 记账原样保留
    assert_eq!(ctx.store.load_state().unwrap().value.installed.len(), 1);
}

/// 存量条目(`origin` 缺席)退回按空 `commit_sha` 判定。
/// 已实证 `state.installed` 全仓只有两处写入,只有 claim 留空 sha。
#[test]
fn legacy_entries_without_origin_fall_back_to_the_empty_sha_rule() {
    let (ctx, _env) = ctx();
    let entry = |name: &str, sha: &str| skillsync_lib::core::state::InstalledSkill {
        name: name.into(),
        source: skillsync_lib::core::state::SkillSource {
            registry_id: String::new(),
            owner: "acme".into(),
            repo: "skills".into(),
            path: String::new(),
            git_ref: String::new(),
        },
        commit_sha: sha.into(),
        content_hash: "hash".into(),
        origin: None, // 旧版 state 没有这个字段
        agents: vec![],
        links: vec![],
        installed_at: NOW.into(),
        updated_at: NOW.into(),
    };
    let mut st = skillsync_lib::core::state::State::default();
    st.installed.push(entry("claimed-one", ""));
    st.installed.push(entry("acquired-one", "abc123"));
    ctx.store.save_state(&st).unwrap();

    acquire::unclaim(&ctx.store, "claimed-one").expect("空 sha 的存量条目 = 认领来的");
    assert_eq!(
        acquire::unclaim(&ctx.store, "acquired-one").unwrap_err().code,
        "CONFLICT_NOT_CLAIMED",
        "有 sha 的存量条目 = 获取来的,拿不准也不许删"
    );
}

#[test]
fn unclaiming_something_that_is_not_managed_is_an_error_not_a_silent_noop() {
    let (ctx, _env) = ctx();
    let err = acquire::unclaim(&ctx.store, "never-existed").unwrap_err();
    assert_eq!(err.code, "FS_NOT_INSTALLED");
}
