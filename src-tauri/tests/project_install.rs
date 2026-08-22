//! 项目级安装/卸载编排(`core::project`)的端到端行为。
//!
//! 与上游布局的差分由 `tests/project_lock_upstream_fixture.rs` 管(lock 字节与 hash 口径);
//! 本文件管的是**我们自己的编排不变量**:落盘位置、安装键、建链目标、
//! 拍板前零写入、卸载不静默删用户文件。

use std::path::{Path, PathBuf};

use skillsync_lib::core::installer::SkillPayload;
use skillsync_lib::core::project::{self, ProjectPrecheck, RemovedItem};
use skillsync_lib::core::project_lock::{self, LocalEntry};

/// 一个最小可用的技能载荷。`name` 进 frontmatter——项目级的安装键取它,不取目录名。
fn payload(name: &str, body: &str) -> SkillPayload {
    SkillPayload::new().with_file(
        "SKILL.md",
        format!("---\nname: {name}\ndescription: 测试用\n---\n\n{body}\n"),
    )
}

fn entry(hash: &str) -> LocalEntry {
    LocalEntry {
        source: "skills/skills".into(),
        source_url: Some("http://gitea.example.invalid/skills/skills.git".into()),
        git_ref: Some("main".into()),
        source_type: "git".into(),
        skill_path: Some("skills/weekly-report/SKILL.md".into()),
        computed_hash: hash.into(),
    }
}

fn project_dir() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    (tmp, root)
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

/// 落盘布局必须与上游一致:本体在 `.agents/skills/<键>`,
/// **键取 frontmatter name**(项目级刻意跟上游,与全局取仓库目录名分叉)。
#[test]
fn installs_body_under_project_agents_dir_keyed_by_frontmatter_name() {
    let (_tmp, root) = project_dir();

    let done = project::install(
        &root,
        // 仓库里的目录名与 frontmatter name **故意不同**——这正是广场 47 个技能里
        // 8 个的真实形态。若实现取错了,键会变成 react-best-practices。
        "react-best-practices",
        &payload("vercel-react-best-practices", "正文"),
        &[],
        &entry("deadbeef"),
    )
    .expect("安装应成功");

    assert_eq!(done.key, "vercel-react-best-practices");
    let body = root.join(".agents/skills/vercel-react-best-practices");
    assert!(body.join("SKILL.md").is_file(), "本体应落在 .agents/skills 下");
    assert!(
        !root.join(".agents/skills/react-best-practices").exists(),
        "不该用仓库目录名建目录"
    );
}

/// 非 universal 的 agent 要建链,且链接是**相对**的(项目整体搬走仍成立)。
#[cfg(unix)]
#[test]
fn links_non_universal_agents_with_a_relative_symlink() {
    let (_tmp, root) = project_dir();

    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "正文"),
        &["claude-code".to_string()],
        &entry("deadbeef"),
    )
    .unwrap();

    let link = root.join(".claude/skills/weekly-report");
    let raw = std::fs::read_link(&link).expect("claude-code 目录下应是链接");
    assert_eq!(
        raw.to_string_lossy(),
        "../../.agents/skills/weekly-report",
        "必须是相对链接,与上游 npx skills 逐字节一致"
    );
}

/// universal agent(skillsDir == .agents/skills)落在本体处即可见,**不建链**。
#[test]
fn universal_agents_are_not_linked() {
    let (_tmp, root) = project_dir();

    let done = project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "正文"),
        &["cursor".to_string()],
        &entry("deadbeef"),
    )
    .unwrap();

    // ⚠️ 光断言 `.cursor/skills` 不存在是**空转**的:cursor 的 skillsDir 就是
    // `.agents/skills`,那个目录本来就永远不会被创建(2026-08-21 注入验证发现)。
    // 真正的不变量是:universal agent 不进"已建链"名单,且本体仍是实体目录没被链接替换掉。
    assert!(
        done.linked_agents.is_empty(),
        "universal agent 不该出现在已建链名单里,实际 {:?}",
        done.linked_agents
    );
    let body = root.join(".agents/skills/weekly-report");
    assert!(
        body.is_dir() && fsops_read_link(&body).is_none(),
        "本体必须仍是实体目录,不能被链接顶掉"
    );
    assert!(body.join("SKILL.md").is_file());
}

/// 读链接指向;不是链接返回 None。测试里用来断言"本体没被链接顶掉"。
fn fsops_read_link(p: &Path) -> Option<PathBuf> {
    skillsync_lib::core::fsops::read_link_target(p)
}

/// 装完必须写 lock,且 hash 与磁盘实际内容相符——这条等式一破,
/// npx 会永远认为我们装的技能"改过了"。
#[test]
fn writes_lock_whose_hash_matches_what_landed_on_disk() {
    let (_tmp, root) = project_dir();

    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "正文"),
        &[],
        &entry("占位,应被实际算出的值覆盖"),
    )
    .unwrap();

    let entries = project_lock::read_entries(&project_lock::lock_path(&root));
    assert_eq!(entries.len(), 1);
    let (key, written) = &entries[0];
    assert_eq!(key, "weekly-report");

    let actual =
        project_lock::upstream_folder_hash(&root.join(".agents/skills/weekly-report")).unwrap();
    assert_eq!(
        written.computed_hash, actual,
        "lock 里的 hash 必须等于磁盘现算值"
    );
}

/// 同名技能已存在且内容相同 → 判定为已装,不是冲突。
#[test]
fn precheck_reports_already_installed_when_content_matches() {
    let (_tmp, root) = project_dir();
    let p = payload("weekly-report", "正文");
    project::install(&root, "weekly-report", &p, &[], &entry("x")).unwrap();

    let verdict = project::precheck(&root, "weekly-report", &p).unwrap();

    assert!(
        matches!(verdict, ProjectPrecheck::AlreadyInstalled),
        "内容相同应判已装,实际 {verdict:?}"
    );
}

/// 同名但内容不同 → 需要用户拍板,且**拍板之前磁盘一个字节都不许动**。
#[test]
fn precheck_needs_decision_and_touches_nothing_on_disk() {
    let (_tmp, root) = project_dir();
    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "原始正文"),
        &[],
        &entry("x"),
    )
    .unwrap();

    let body = root.join(".agents/skills/weekly-report/SKILL.md");
    let before_body = read(&body);
    let before_lock = read(&project_lock::lock_path(&root));

    let verdict = project::precheck(&root, "weekly-report", &payload("weekly-report", "新正文")).unwrap();

    assert!(
        matches!(verdict, ProjectPrecheck::NeedsDecision { .. }),
        "内容不同应需拍板,实际 {verdict:?}"
    );
    assert_eq!(read(&body), before_body, "拍板前不许改本体");
    assert_eq!(
        read(&project_lock::lock_path(&root)),
        before_lock,
        "拍板前不许改 lock"
    );
}

/// 卸载:删本体 + 摘链接 + 删 lock 条目,但**空的 lock 文件保留**(对齐上游)。
#[cfg(unix)]
#[test]
fn remove_takes_body_link_and_lock_entry_but_keeps_the_lock_file() {
    let (_tmp, root) = project_dir();
    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "正文"),
        &["claude-code".to_string()],
        &entry("x"),
    )
    .unwrap();

    let outcome = project::remove(&root, "weekly-report").unwrap();

    assert!(!root.join(".agents/skills/weekly-report").exists(), "本体应删除");
    assert!(
        !root.join(".claude/skills/weekly-report").exists(),
        "链接应摘除"
    );
    assert!(
        project_lock::lock_path(&root).is_file(),
        "空的 lock 文件必须保留(上游如此)"
    );
    assert!(project_lock::read_entries(&project_lock::lock_path(&root)).is_empty());
    assert!(outcome.body_removed);
}

/// 🔴 降级复制留下的**实体目录**:内容与本体相同才删,不同就留着并报告。
///
/// `skills-lock.json` 没有 link-mode 字段,所以卸载时无从知道 agent 目录下那个
/// 实体目录是我们复制的、还是用户自己放的。上游直接删,本 app 受铁律 7 约束不能。
#[test]
fn remove_keeps_a_diverged_real_directory_and_reports_it() {
    let (_tmp, root) = project_dir();
    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "正文"),
        &[],
        &entry("x"),
    )
    .unwrap();

    // 手工在 claude-code 的位置放一个**实体目录**,内容与本体不同(模拟用户自己的东西)。
    let squatter = root.join(".claude/skills/weekly-report");
    std::fs::create_dir_all(&squatter).unwrap();
    std::fs::write(squatter.join("SKILL.md"), "这是用户自己写的,不是我们复制的").unwrap();

    let outcome = project::remove(&root, "weekly-report").unwrap();

    assert!(squatter.join("SKILL.md").is_file(), "内容不同的实体目录绝不能删");
    assert!(
        outcome
            .kept
            .iter()
            .any(|k| matches!(k, RemovedItem::KeptForeignDir { .. })),
        "必须把留下来的目录报告给调用方,实际 {:?}",
        outcome.kept
    );
}

/// 中文名折成 unnamed-skill 时拒绝安装(同全局,不放宽 sanitize_name)。
#[test]
fn refuses_a_name_that_sanitizes_to_nothing_usable() {
    let (_tmp, root) = project_dir();

    let err = project::install(&root, "周报", &payload("周报生成", "正文"), &[], &entry("x"))
        .expect_err("纯中文名应被拒绝");

    assert_eq!(err.code, "FS_UNUSABLE_NAME");
    assert!(
        !root.join(".agents").exists(),
        "拒绝时不该在项目里留下任何目录"
    );
}

/// 🔴 `precheck` 用的内存 hash 与落盘后现算的 hash 必须是**同一把尺子**。
///
/// 两者是两份独立实现(一份遍历 payload、一份遍历磁盘),口径漂了的表现是:
/// 刚装完的技能立刻被 `precheck` 判成 `NeedsDecision`——用户每次点获取都被问
/// "要不要覆盖你的改动",而他什么都没改。这条等式是唯一的护栏。
#[test]
fn in_memory_and_on_disk_hashes_are_the_same_ruler() {
    let (_tmp, root) = project_dir();
    // 多文件 + 嵌套 + 大小写混排:正是两种排序口径会分歧的形状。
    let p = SkillPayload::new()
        .with_file("SKILL.md", "---\nname: weekly-report\ndescription: d\n---\n正文\n")
        .with_file("AGENTS.md", "agents")
        .with_file("metadata.json", "{}")
        .with_file("rules/_template.md", "t")
        .with_file("rules/js-early-exit.md", "e");

    project::install(&root, "weekly-report", &p, &[], &entry("x")).unwrap();

    // 装完立刻再预检同一份内容:必须判"已装",不能判"需要拍板"。
    let verdict = project::precheck(&root, "weekly-report", &p).unwrap();
    assert!(
        matches!(verdict, ProjectPrecheck::AlreadyInstalled),
        "刚装完立刻预检必须判已装,实际 {verdict:?}"
    );
}

/// universal agent 不产生建链目标。
///
/// ⚠️ 必须在 `link_dirs` 这一层断言,不能只看端到端结果:universal 的 skillsDir
/// 就是 `.agents/skills`,链接路径与本体相同,`fsops` 的 SameLocation 守卫会兜住,
/// 于是删掉 `is_universal()` 跳过之后端到端测试照样全绿(2026-08-21 注入验证发现)。
#[test]
fn universal_agents_produce_no_link_target() {
    let root = Path::new("/tmp/whatever"); // 纯计算,不碰磁盘
    let dirs = project::link_dirs(root, &["cursor".into(), "codex".into()]).unwrap();
    assert!(dirs.is_empty(), "universal agent 不该有建链目标,实际 {dirs:?}");

    // 对照组:非 universal 的必须有,否则上面那条可能是"永远返回空"的假绿。
    let dirs = project::link_dirs(root, &["claude-code".into()]).unwrap();
    assert_eq!(dirs.len(), 1);
    assert_eq!(dirs[0].path, root.join(".claude/skills"));
}

/// 多个 agent 共用同一个 skillsDir 时按目录合并,不重复建链。
#[test]
fn agents_sharing_a_directory_are_merged_into_one_target() {
    let root = Path::new("/tmp/whatever");
    let dirs = project::link_dirs(root, &["zencoder".into(), "zenflow".into()]).unwrap();
    assert_eq!(dirs.len(), 1, "共用目录的 agent 应合并成一个目标,实际 {dirs:?}");
    assert_eq!(dirs[0].agents.len(), 2);
}

/// lock 条目必须原样保住来源字段——尤其 `sourceUrl`。
///
/// git 档(内建 Gitea 归这档)缺了 sourceUrl,上游 `getLocalSource` 直接返回 null,
/// npx 更新时报 "missing sourceUrl for this generic Git source"
/// ——这条记账在 npx 那边根本没法还原。
#[test]
fn lock_entry_keeps_every_source_field() {
    let (_tmp, root) = project_dir();
    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "正文"),
        &[],
        &entry("x"),
    )
    .unwrap();

    let entries = project_lock::read_entries(&project_lock::lock_path(&root));
    let (_, written) = &entries[0];
    let expected = entry("x");
    assert_eq!(written.source, expected.source);
    assert_eq!(
        written.source_url, expected.source_url,
        "git 档缺 sourceUrl 会让 npx 无法还原这条记账"
    );
    assert_eq!(written.git_ref, expected.git_ref);
    assert_eq!(written.source_type, expected.source_type);
    assert_eq!(written.skill_path, expected.skill_path);
}

// ============================================================ 更新

/// 更新前必须先判"用户改过没有":改过就要拍板,不能静默覆盖。
#[test]
fn update_precheck_flags_local_edits() {
    let (_tmp, root) = project_dir();
    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "原始正文"),
        &[],
        &entry("x"),
    )
    .unwrap();

    // 用户手工改了本体。
    std::fs::write(
        root.join(".agents/skills/weekly-report/SKILL.md"),
        "---\nname: weekly-report\ndescription: 测试用\n---\n我自己改的\n",
    )
    .unwrap();

    assert!(
        project::has_local_edits(&root, "weekly-report").unwrap(),
        "本体与 lock 里的 hash 不符,应判为改过"
    );
}

/// 没改过时不能误报——误报会让用户每次更新都被问一次莫须有的"要不要保留改动"。
#[test]
fn update_precheck_does_not_cry_wolf_on_an_untouched_skill() {
    let (_tmp, root) = project_dir();
    project::install(
        &root,
        "weekly-report",
        &payload("weekly-report", "正文"),
        &[],
        &entry("x"),
    )
    .unwrap();

    assert!(
        !project::has_local_edits(&root, "weekly-report").unwrap(),
        "刚装完没动过,不该判为改过"
    );
}

/// lock 里没有这条记账时按"没改过"处理:宁可漏报,不误报
/// (与全局「指纹为空按没有更新处理」同一条取舍)。
#[test]
fn a_skill_without_a_lock_entry_is_not_reported_as_edited() {
    let (_tmp, root) = project_dir();
    std::fs::create_dir_all(root.join(".agents/skills/手放的")).unwrap();
    std::fs::write(root.join(".agents/skills/手放的/SKILL.md"), "x").unwrap();

    assert!(!project::has_local_edits(&root, "手放的").unwrap());
}

// ============================================================ 安装计划(强制覆盖)

use skillsync_lib::core::project::{plan, InstallStep};

/// 用户 2026-08-22 反馈:"装过的也能装,强制覆盖选项,保留足够权利"。
///
/// 此前 `AlreadyInstalled` 是**无条件早退**的,于是"已经装过"成了死路——
/// 界面连一个能点的按钮都没有。而重装是完全合法的操作:内容一样时它仍然会
/// **重建 agent 关联**(关联可能被别的工具删掉或改指),这正是用户要重装的理由。
#[test]
fn already_installed_skips_by_default_but_force_reinstalls() {
    assert_eq!(plan(&ProjectPrecheck::AlreadyInstalled, false, false), InstallStep::SkipAlready);
    assert_eq!(plan(&ProjectPrecheck::AlreadyInstalled, true, false), InstallStep::Install);
}

/// 🔴 **force 不蕴含"丢弃我的改动"**。两个开关管的是两件事:
/// - `force` = "我知道已经装了,再装一遍"(跳过省事判定);
/// - `confirmed_replace` = "我已确认丢弃本地改动"(铁律 7 要的那句确认)。
///
/// 混成一个的话,用户点「覆盖重装」就会**静默抹掉他自己改过的内容**。
#[test]
fn force_does_not_bypass_the_confirmation_for_local_edits() {
    let changed = ProjectPrecheck::NeedsDecision { current_hash: "abc".into() };

    assert_eq!(plan(&changed, true, false), InstallStep::NeedDecision, "force 不该绕过改动确认");
    assert_eq!(plan(&changed, false, false), InstallStep::NeedDecision);
    assert_eq!(plan(&changed, false, true), InstallStep::Install, "确认过就装");
    assert_eq!(plan(&changed, true, true), InstallStep::Install);
}

#[test]
fn a_fresh_target_always_installs() {
    for force in [false, true] {
        for confirmed in [false, true] {
            assert_eq!(plan(&ProjectPrecheck::Fresh, force, confirmed), InstallStep::Install);
        }
    }
}

/// 「更新」与「覆盖重装」是两件事,判定表上必须分得开。
///
/// ⚠️ 这条是实现「覆盖重装」时**顺手改错、自己发现**的:给 `project_skill_update`
/// 传 `force: true` 之后,"内容已经一样"那一档再也走不到,`AlreadyLatest`
/// (已经是最新的)成了死代码——用户点「更新」会看到"已更新",而远端根本没有新内容。
/// 「更新」问的是"远端有没有新内容";「覆盖重装」问的是"再装一遍(顺带重建关联)"。
#[test]
fn update_still_reports_already_latest_because_it_does_not_force() {
    // 更新走的是 confirmed_replace=true / force=false 这一组
    assert_eq!(
        plan(&ProjectPrecheck::AlreadyInstalled, false, true),
        InstallStep::SkipAlready,
        "更新遇到内容一样时要如实说已是最新,不能装作更新过"
    );
}
