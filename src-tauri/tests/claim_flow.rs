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
        &[github_registry()],
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
        }],
    };
    let report = acquire::claim(
        &installer,
        &ctx.registry,
        &env,
        &ctx.store,
        &[ghe],
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
fn claim_refuses_managed_missing_and_non_upstream() {
    let (ctx, env) = ctx();
    upstream_install(&ctx, "weekly-report");
    let installer = Installer::new(&ctx.registry, &env);

    // 本体不在:lock 有条目但目录已删
    std::fs::remove_dir_all(ctx.home.join(".agents/skills/weekly-report")).unwrap();
    let err = acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &[], "weekly-report", NOW)
        .unwrap_err();
    assert_eq!(err.code, "FS_NOT_CLAIMABLE");

    // 不是上游装的:目录在但 lock 没条目
    let stray = ctx.home.join(".agents/skills/hand-made");
    std::fs::create_dir_all(&stray).unwrap();
    let err = acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &[], "hand-made", NOW)
        .unwrap_err();
    assert_eq!(err.code, "FS_NOT_CLAIMABLE");

    // 已在管理中:state 里有记账
    std::fs::create_dir_all(ctx.home.join(".agents/skills/weekly-report")).unwrap();
    acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &[], "weekly-report", NOW).unwrap();
    let err = acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &[], "weekly-report", NOW)
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
        &[github_registry()],
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
    acquire::claim(&installer, &ctx.registry, &env, &ctx.store, &[], "managed-skill", NOW).unwrap();

    let st = ctx.store.load_state().unwrap().value;
    let unclaimed = acquire::unclaimed_skills(&env, &installer, &st);
    assert_eq!(unclaimed.len(), 1, "已管理与本体缺失的都不该列");
    assert_eq!(unclaimed[0].dir_slug, "weekly-report");
    assert_eq!(unclaimed[0].source, "vercel-labs/skills");
}
