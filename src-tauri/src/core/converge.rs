//! 本体位置的解析入口 + 收敛原语(v6 二期)。
//!
//! `installer::Installer::home` 知道怎么把 `(dir_slug, 账上的 body)` 折成一个
//! [`crate::core::installer::SkillHome`],但它不该知道账在哪、怎么读——那是
//! `state::State` 的事。本模块把两者接起来,是全仓**唯一**允许调用
//! `Installer` 内部 `canonical_dir` 解析的入口之一(另一个是 `installer.rs` 自己)。
//! 文本级守卫 `tests/body_guard.rs` 钉住这条:`core/acquire.rs`、`core/remove.rs`、
//! `core/share.rs`、`core/scheduler.rs`、`core/my_skills.rs`、`core/create.rs`、
//! `core/local_detail.rs`、`commands.rs` 一律不得自行拼本体路径,只能调这里
//! (或已经拿到手的 `SkillHome`)。
//!
//! v6 二期任务 2 只打通了「有账时本体在哪」这一层解析,`body` 字段全程是
//! `None`。本任务(任务 3)在其上加四组能力,姿态统一是一句话:**写盘前只比
//! 内容——无损的自动做(不问用户),有损的停下来让用户拍板,拿走的一切都进
//! 废纸篓(可逆)**。
//! - [`locate`][]/[`scan_all`][]:本体「实际住在哪」的只读发现,绝不写盘;
//! - [`converge`][]:让某个位置成为指向本体的链接,内容相同才自动做;
//! - [`keep_version`][]:多份分歧版本时,用户拍板"留哪份"之后的落盘执行;
//! - [`set_agents`][]:「勾选哪些工具」这组checkbox 的建链/摘链差分编排。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::fsops::{self, LinkOutcome, LinkState, OnOccupied};
use crate::core::installer::{Installer, SkillHome};
use crate::core::state;
use crate::error::AppError;

/// 「这个技能在 `state.installed` 里的记账键」。**全仓唯一实现,别再手搓。**
///
/// 🔴 **记账键是清洗后的目录名,不是调用方手上的 `dir_slug`**(v6 二期任务 4
/// 修复轮 1,I-1):`acquire::record` 写的是 `InstallReport::dir_name`
/// = `SkillHome::dir_name` = `sanitize_name(dir_slug)`,而 `sanitize_name`
/// **会小写化**;调用方手上的 `dir_slug` 则是 `store::IndexedSkill::dir_slug`
/// ——**技能库里的原始目录名,一个字符都不清洗**。
///
/// 两者在全 ASCII 小写的技能上恰好相同(公司库 20 个技能全是这一档),
/// 所以这条错位一直没人撞上;技能广场是任意 GitHub 仓,`Weekly-Report`
/// 这样的目录名完全可能。撞上之后有两个后果,一个比一个隐蔽:
/// 1. `locate` 查不到账 → 走无账路 → 工具目录里一份内容不同的杂散副本就让
///    `precheck` 输出 `NeedsVersionChoice`,**自动更新静默停摆**(与本任务
///    修掉的 `Located::Body` 判据缺陷是同一个形状,只是换了根轴);
/// 2. 账上 `body` 为 `None`(本体在 canonical)且别处有一份**同内容**副本时,
///    走无账路会让 [`choose_body`] **优先选非 canonical** → 本体被"搬"进
///    `.claude/skills/`,**「本体永不搬家」这条承诺被打破,而且没问过用户**。
///
/// 实现刻意走 [`Installer::home`] 而不是直接调 `sanitize_name`:那样就是同一把
/// 尺子的**第二份实现**,口径一漂两边照样各自全绿(本项目的空转模式 ①)。
pub fn record_key(installer: &Installer<'_>, dir_slug: &str) -> Result<String, AppError> {
    Ok(installer.home(dir_slug, None)?.dir_name)
}

/// 解析一个技能「住在哪里」:先查 `state.installed` 有没有记账过的 body,
/// 没有(或没找到这条记账)就交给 [`Installer::home`] 落回 canonical 的默认值。
///
/// 查账用 [`record_key`],**不是 `dir_slug`**(理由见该函数)。
pub fn home_of(installer: &Installer<'_>, state: &state::State, dir_slug: &str) -> Result<SkillHome, AppError> {
    let base = installer.home(dir_slug, None)?;
    let recorded = state
        .installed
        .iter()
        .find(|s| s.name == base.dir_name)
        .and_then(|s| s.body.as_deref());
    match recorded {
        None => Ok(base),
        Some(body) => installer.home(dir_slug, Some(Path::new(body))),
    }
}

// ============================================================ 定位

/// 磁盘上一处「分歧版本」的快照:给用户拍板"留哪份"用,不是记账。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub path: String,
    /// RFC3339(UTC),取目录内(参与内容 hash 的那些)文件里最新的 mtime。
    pub modified_at: String,
    pub files: usize,
    pub content_hash: String,
}

/// 一次定位的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    None,
    /// 唯一实体目录(或多处但内容全同,此时 `body` 已按规则选定、`others` 是要收成链接的)。
    ///
    /// **有账时恒为这一档**(账上那份就是本体):`others` 只收内容与 `body` 相同的
    /// 杂散副本,内容不同的副本**不进 `Located`**——它们由「我的技能」页单独算进
    /// 那一行的 `versions` 展示,`precheck` 的判定照旧走既有四档,写盘碰到那个位置时
    /// 由 [`converge`] 的 `Differs` 兜住。否则一份杂散副本就能让自动更新静默停摆
    /// (一有分歧就报 `Differs`,用户还没做任何改动,更新流程却被拦死)。
    Body { body: PathBuf, others: Vec<PathBuf> },
    /// **无账**且多处实体目录内容有差异,交给用户在 [`keep_version`] 里拍板。
    Differs(Vec<Version>),
}

/// 扫 canonical + 每个工具全局目录下**实体**(非链接)且含 SKILL.md 的目录,
/// 按目录名分组。**绝不写盘**——发现是这一层唯一职责,写入的事一律交给
/// [`converge`]/[`keep_version`]/[`set_agents`]。
pub fn scan_all(registry: &AgentRegistry, env: &dyn AgentEnv) -> Result<BTreeMap<String, Vec<PathBuf>>, AppError> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(base) = registry.canonical_global_dir(env) {
        roots.push(base);
    }
    roots.extend(registry.group_by_global_dir(env).into_keys());
    roots.sort();
    roots.dedup();

    let mut out: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for root in &roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // 只认实体目录:是目录、且不是链接(symlink 或 windows junction)。
            if !path.is_dir() || fsops::read_link_target(&path).is_some() {
                continue;
            }
            if !path.join("SKILL.md").is_file() {
                continue;
            }
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            out.entry(name).or_default().push(path);
        }
    }
    for paths in out.values_mut() {
        paths.sort();
    }
    Ok(out)
}

/// 无账多处同内容时的选法:非 canonical 优先;多个非 canonical 时,按
/// `ordered_tool_dirs` 给定的顺序(调用方通常是 `registry.group_by_global_dir`
/// 按目录路径字典序排出的键序,排除 canonical 之后)取第一个匹配到候选路径的目录。
///
/// # 前置条件
/// `paths` 必须非空——本函数是任务书指定的 `pub` API,`locate` 内部调用时保证
/// 这一点(`locate` 只在候选数 ≥ 2 时才会走到这里),但别的调用方必须自己遵守。
/// **debug 构建下违反会 `debug_assert!` 失败**;release 构建不 panic
/// (审查修复轮 1 M1:它是 Tauri command 的下游依赖,`parse_owner_repo` 的
/// expect-panic 是前车之鉴——在 command 里 panic 而不是返回 `AppError` 会让
/// 整个后端崩掉),退化成一个空 `PathBuf` 占位。
pub fn choose_body(paths: &[PathBuf], canonical_base: &Path, ordered_tool_dirs: &[PathBuf]) -> PathBuf {
    debug_assert!(!paths.is_empty(), "choose_body 要求 paths 非空,调用方须先保证候选不为空");
    for dir in ordered_tool_dirs {
        if let Some(p) = paths.iter().find(|p| p.parent() == Some(dir.as_path())) {
            return p.clone();
        }
    }
    if let Some(p) = paths.iter().find(|p| p.parent() == Some(canonical_base)) {
        return p.clone();
    }
    paths.first().cloned().unwrap_or_default()
}

/// 解析一个技能「实际住在哪」,给出唯一权威判定,供 [`converge`]/[`keep_version`]/
/// [`set_agents`] 与「我的技能」页共用。**绝不写盘**。
///
/// 有账 → 恒 [`Located::Body`],账上记的就是本体(见该变体的文档);
/// 无账 → 按内容判定:全部实体目录内容相同则用 [`choose_body`] 选一个当本体,
/// 有分歧则 [`Located::Differs`],交给用户在 [`keep_version`] 里拍板。
pub fn locate(
    installer: &Installer<'_>,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    state: &state::State,
    dir_slug: &str,
) -> Result<Located, AppError> {
    let home = home_of(installer, state, dir_slug)?;
    let all = scan_all(registry, env)?;
    let candidates = all.get(&home.dir_name).cloned().unwrap_or_default();

    // 🔴 判据是「这个技能有没有账」,**不是「账上的 `body` 字段有没有值」**
    // (v6 二期任务 4 修):`body` 只在本体不住在 canonical 时才记(见
    // `state::InstalledSkill::body` 与 `acquire::record`),而本体住在 canonical
    // 是至今为止的绝大多数——按 `body.is_some()` 判的话,这些技能全部落进"无账"
    // 那条路,工具目录里出现**任何**一份内容不同的同名副本就会让 `locate` 报
    // `Differs`,于是 `precheck` 退化成 `NeedsVersionChoice`、自动更新静默停摆,
    // `set_agents` 也会拿一个假的"版本分歧"把用户的勾选顶回去。
    // 本变体的文档从任务 3 起写的就是"**有账时恒为这一档**",实现当时对不上。
    // 查账键用 `home.dir_name`(= `record_key`),不是 `dir_slug`——理由见 `record_key`。
    let recorded = state.installed.iter().find(|s| s.name == home.dir_name);

    if recorded.is_some() {
        let mut others = Vec::new();
        // body 本身若已不在磁盘上,不比对内容——宁可什么都不多说,也不对着
        // 不存在的路径算 hash 报错(判断"本体缺失"这件事是调用方的职责)。
        if home.body.is_dir() {
            for path in &candidates {
                if path == &home.body {
                    continue;
                }
                if fsops::same_content(&home.body, path)? {
                    others.push(path.clone());
                }
            }
        }
        // 已裁定:按路径排序后返回——文件系统枚举顺序不保证,不排序会让相等断言随机变红。
        others.sort();
        return Ok(Located::Body {
            body: home.body,
            others,
        });
    }

    if candidates.is_empty() {
        return Ok(Located::None);
    }
    if candidates.len() == 1 {
        return Ok(Located::Body {
            body: candidates[0].clone(),
            others: Vec::new(),
        });
    }

    let first = &candidates[0];
    let mut all_same = true;
    for path in &candidates[1..] {
        if !fsops::same_content(first, path)? {
            all_same = false;
            break;
        }
    }

    if all_same {
        let canonical_base = home
            .canonical
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.canonical.clone());
        let ordered_tool_dirs: Vec<PathBuf> = registry
            .group_by_global_dir(env)
            .into_keys()
            .filter(|d| d != &canonical_base)
            .collect();
        let body = choose_body(&candidates, &canonical_base, &ordered_tool_dirs);
        let mut others: Vec<PathBuf> = candidates.iter().filter(|p| **p != body).cloned().collect();
        others.sort();
        return Ok(Located::Body { body, others });
    }

    let mut versions = Vec::with_capacity(candidates.len());
    for path in &candidates {
        versions.push(build_version(path)?);
    }
    // 已裁定:按路径排序后返回,理由同上。
    versions.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Located::Differs(versions))
}

fn build_version(path: &Path) -> Result<Version, AppError> {
    let files = fsops::list_files(path)?;
    let mut latest: Option<std::time::SystemTime> = None;
    for rel in &files {
        if let Ok(meta) = std::fs::metadata(path.join(rel)) {
            if let Ok(mtime) = meta.modified() {
                if latest.is_none_or(|l| mtime > l) {
                    latest = Some(mtime);
                }
            }
        }
    }
    Ok(Version {
        path: path.to_string_lossy().into_owned(),
        modified_at: latest.map(rfc3339_utc).unwrap_or_default(),
        files: files.len(),
        content_hash: fsops::dir_content_hash(path)?,
    })
}

/// `SystemTime` → RFC3339(UTC,秒精度)。不为一个时间戳多引一个日期时间 crate——
/// `commands.rs` 的 `now_iso8601` 已有同款算法(Howard Hinnant 的 `civil_from_days`),
/// 这里为本模块的独立职责单独存一份,而不是让 core 反向依赖 commands.rs。
fn rfc3339_utc(t: std::time::SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// unix 天数 → 公历年月日(Howard Hinnant 的 civil_from_days,与
/// `commands::civil_from_days` 同一算法,边界已在那里测过)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ============================================================ 收敛

/// 一次收敛的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Converged {
    /// 新建了链接(或降级复制),`mode` 取 [`fsops::LinkKind::as_str`]。
    Linked { mode: String },
    /// 位置本就正确关联,未做任何改动。
    Unchanged,
    /// 位置与本体本就是同一处磁盘位置,无需建链。
    SameLocation,
    /// 位置是实体目录且内容与本体不同,停下来问用户——磁盘零写入。
    Differs { existing: String },
}

/// 让 `target` 成为指向 `body` 的链接。
///
/// 姿态与铁律 7 的落点:实体目录且内容与 `body` 相同 → 无损、可逆(进废纸篓),
/// 不问用户直接做;内容不同 → 有损,停下来让用户拍板,`target` 上**一个字节都不动**。
pub fn converge(installer: &Installer<'_>, target: &Path, body: &Path) -> Result<Converged, AppError> {
    match fsops::link_state(target, body) {
        LinkState::SameLocation => return Ok(Converged::SameLocation),
        LinkState::Linked(_) => return Ok(Converged::Unchanged),
        LinkState::Real => {
            // M3:目标位置是一个普通文件(不是目录)时,走 `same_content` 会对着
            // 它调 `dir_content_hash`,以 `FS_HASH_FAILED`「无法读取技能目录内容,
            // 请重试」报错——文不对题,用户重试多少次都一样。这本来就是"内容不同"
            // 的一种极端形式,直接停下来问用户,磁盘同样零写入。
            if !target.is_dir() || !fsops::same_content(target, body)? {
                return Ok(Converged::Differs {
                    existing: target.to_string_lossy().into_owned(),
                });
            }
            fsops::trash_tree(installer.trasher(), target)?;
        }
        LinkState::Broken | LinkState::Foreign(_) => {
            fsops::unlink_dir(target)?;
        }
        LinkState::Missing => {}
    }
    match fsops::link_dir(body, target, installer.chain(), OnOccupied::Fail)? {
        LinkOutcome::Created(k) | LinkOutcome::Unchanged(k) => Ok(Converged::Linked {
            mode: k.as_str().into(),
        }),
        LinkOutcome::SameLocation => Ok(Converged::SameLocation),
    }
}

/// `body` 不在 canonical 时,保证 `canonical/<name>` 是指向 `body` 的链接;
/// `body` 就住在 canonical 时是 no-op(两者本就是同一处)。
pub fn ensure_canonical_link(installer: &Installer<'_>, home: &SkillHome) -> Result<Converged, AppError> {
    if home.body_is_canonical() {
        return Ok(Converged::SameLocation);
    }
    converge(installer, &home.canonical, &home.body)
}

/// 把一次收敛结果并进账上的 `links`(审查修复轮 1 I4)。
///
/// **并集合并,不覆盖**——同一目录只留一条,mode 可能因这次收敛而变化(比如从
/// 复制升回链接);`acquire.rs::link_agents` 已有同款写法,这里照抄同一个姿势。
/// 只在这个位置确实"是一条指向本体的链接"时才记账:`Linked` 直接取返回的 mode;
/// `Unchanged`(`converge` 的早退分支,不带 mode)反查一次 `fsops::link_state`
/// 补上当前的链接方式;`SameLocation`(无需建链)与 `Differs`(磁盘没变)都不
/// 产生一条链接记账。
///
/// 不维护这份账的后果是真实的(I4):`remove::remove` 只按 `state.links` 摘链,
/// `converge`/`keep_version`/`set_agents` 建的链接若不进这份账,移除本体之后
/// 各工具目录会留下一地悬空链接;降级复制(`Copy` 档,目标是实体目录)那一档
/// 更险——不进账的话,连"这份实体目录是不是我们放的副本"都无从判断。
fn merge_link_record(
    links: &mut Vec<state::LinkRecord>,
    dir: &Path,
    link_path: &Path,
    body: &Path,
    outcome: &Converged,
) {
    let mode = match outcome {
        Converged::Linked { mode } => mode.clone(),
        Converged::Unchanged => match fsops::link_state(link_path, body) {
            LinkState::Linked(kind) => kind.as_str().to_string(),
            _ => return,
        },
        Converged::SameLocation | Converged::Differs { .. } => return,
    };
    match links.iter_mut().find(|l| Path::new(&l.dir) == dir) {
        Some(existing) => existing.mode = mode,
        None => links.push(state::LinkRecord {
            dir: dir.to_string_lossy().into_owned(),
            mode,
        }),
    }
}

// ============================================================ 版本拍板

/// [`keep_version`] 的执行结果。
///
/// 🔴 **每一条都带目标标识与 `Result`(审查修复轮 4)**:上一版的
/// `links: Vec<Converged>` 既认不出是哪个位置、也表达不了"这个位置没收敛成功"
/// ——而 R11 要求循环内的失败**收集而不是中断**,收集了却没人看得见,就从
/// "报错中断"退化成了**静默撒谎**(界面显示"已完成",实际那个位置根本没换成
/// 链接)。形状与 [`SetAgentsOutcome::Done`] 保持同一口径:`(目标标识, 结果)`
/// 的序对 + 一条单独的 `canonical`。
///
/// ⚠️ **序列化形状**(给任务 4/5/7 接前端类型用):`Result<T, E>` 走的是 serde
/// 内建 impl,键是**大写**的 `{"Ok": …}` / `{"Err": …}`,`rename_all` 管不到它;
/// 元组 `(String, Result<..>)` 序列化成 JSON 数组 `[目标, 结果]`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepReport {
    pub body: String,
    /// 被丢弃、进了废纸篓的其余版本(路径的字符串形式)。
    pub trashed: Vec<String>,
    /// 每处落选位置的收敛结果:`(该位置的路径, 收敛成链接的结果)`。
    /// `Err` = 这个位置试过了但没成功(废纸篓失败、或建链失败),不是"没处理它"。
    pub links: Vec<(String, Result<Converged, AppError>)>,
    /// canonical ← `keep` 那条链接的收敛结果(I1)。同样可能失败,同样如实回报。
    pub canonical: Result<Converged, AppError>,
}

/// 「有几个版本,选哪个」拍板落地:`keep` 原地留下当本体,其余全部进废纸篓、
/// 原位换成指向 `keep` 的链接;补齐 canonical 链接;写账 `body`/`agents`/`links`
/// (没有账就顺手建一条 `adopted` 账)。
///
/// **不走 [`converge`] 的内容相等闸**:这里处理的正是内容有分歧的那些位置
/// (否则用户不需要拍板),它们进废纸篓是用户刚做出的、明确的拍板结果,
/// 不是"看起来无损所以自动做"。
///
/// 三处审查修复轮 1 补的行为(都在这一个函数里):
/// - **C1**:`keep` 经 IPC 由前端传入,是不可信输入,必须是本次候选之一,
///   否则在动任何磁盘之前拒绝——不然它可以是任意路径,把真实本体全部送进
///   废纸篓、换成指向一个无关目录的链接,还会把账永久毒化。
/// - **I1**:candidates 只来自 [`scan_all`](只看得见实体目录),canonical 位置
///   若本来没有实体目录就不会成为候选、循环够不到它;不补一次
///   [`ensure_canonical_link`] 的话,拍板完这个技能会从「我的技能」页整行消失
///   (canonical 是 cursor/codex 与全部 universal 工具唯一的读取位置)。
/// - **I2**:`agents` 是并集合并,不是覆盖——一个工具若是通过健康链接关联的
///   (新模型下的常态),它的目录不会成为候选、不进 `touched_dirs`,整体覆盖
///   会把它从账上静默抹掉,即便磁盘上那条链接还在。
///
/// 🔴 **R11(审查修复轮 4,结构性)**——判据:**从第一次写磁盘到 `save_state`
/// 之间,任何失败都不得让函数带着"磁盘已动、账未存"的状态返回。** `set_agents`
/// 在修复轮 3 已按这条收干净,本函数当时**漏了**,现场比 `set_agents` 更险:
/// 循环里第一处写盘就是 `trash_tree`(破坏性),而 `dir_content_hash(keep)` 排在
/// 全部写盘之后——落选版本已进废纸篓、落选位置与 canonical 都已换成链接,hash
/// 一失败函数就带着 `Err` 返回,账上一条都没有。逐处落地(两种处置,各有依据):
/// - **前移(使 `?` 变安全)**——纯计算,挪到任何写盘之前即可,不必收集:
///   `installer.home(dir_slug, Some(keep))`(算 `keep_home`,只拼路径)、
///   `fsops::dir_content_hash(keep)`(只读)。这与修复轮 3 位置⑤ 是同一姿势:
///   此刻还没有任何写盘发生过,提前返回不留半成品。
/// - **收集(写盘之后,只能收)**——循环内的 `trash_tree` / `unlink_dir` /
///   `link_dir`,以及 [`ensure_canonical_link`]:各自装进
///   [`KeepReport::links`] / [`KeepReport::canonical`] 的 `Err` 分支,循环继续。
/// - **唯一残留的窗口**:`store.save_state` 自身。它本身就是"落账"这个动作,
///   失败了没有更早的地方可以退——这是这条判据下唯一仍然存在、也只能存在的
///   失败窗口(与 `set_agents` 位置⑥ 同款)。
pub fn keep_version(
    installer: &Installer<'_>,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &state::Store,
    dir_slug: &str,
    keep: &Path,
    now: &str,
) -> Result<KeepReport, AppError> {
    let home = installer.home(dir_slug, None)?;
    let all = scan_all(registry, env)?;
    let candidates = all.get(&home.dir_name).cloned().unwrap_or_default();

    // C1:见函数文档。必须在任何磁盘写入之前判定。
    if !candidates.iter().any(|p| p == keep) {
        return Err(AppError::new(
            "FS_BAD_VERSION_CHOICE",
            "选择的版本不是这个技能眼下的候选之一,请重新选择",
        )
        .with_detail(format!(
            "keep {} is not among the {} candidates for {dir_slug}",
            keep.display(),
            candidates.len()
        )));
    }

    // R11 前移①:纯路径计算,挪到任何写盘之前——原先它排在候选循环之后,一旦
    // `keep` 的叶子名与 slug 对不上(`FS_BAD_BODY`),落选版本已经全进废纸篓了。
    let keep_home = installer.home(dir_slug, Some(keep))?;
    // R11 前移②:只读,同样挪到写盘之前(原先排在全部写盘之后,见函数文档)。
    let content_hash = fsops::dir_content_hash(keep)?;

    let mut next = store.load_state()?.value;
    // 查账/落账一律用 `home.dir_name`(= `record_key`),不是 `dir_slug`——见 `record_key`。
    let key = home.dir_name.clone();
    let existing = next.installed.iter().find(|s| s.name == key);
    let mut agents: Vec<String> = existing.map(|s| s.agents.clone()).unwrap_or_default();
    let mut link_records: Vec<state::LinkRecord> = existing.map(|s| s.links.clone()).unwrap_or_default();

    let mut trashed = Vec::new();
    let mut report_links: Vec<(String, Result<Converged, AppError>)> = Vec::new();
    let mut touched_dirs: Vec<PathBuf> = Vec::new();
    if let Some(p) = keep.parent() {
        touched_dirs.push(p.to_path_buf());
    }

    // ↓↓↓ 这里开始写盘。到 `save_state` 之间一律收集,不用 `?`(R11)。
    for path in &candidates {
        if path == keep {
            continue;
        }
        let dir = path.parent();
        // 失败位置的 agent 照样进并集:那个工具目录里**确实还有一份技能**
        // (废纸篓/摘链没成功,东西还在原地),说它"没启用"才是假话;失败本身
        // 已经在 `KeepReport::links` 里如实可见,不靠这份账来表达。
        if let Some(d) = dir {
            touched_dirs.push(d.to_path_buf());
        }
        let label = path.to_string_lossy().into_owned();
        // 腾位置:实体目录进废纸篓,链接/断链直接摘。失败即收集并跳过这个位置
        // ——位置还占着,再去 `link_dir` 只会撞上 `OnOccupied::Fail`,报一个
        // 掩盖真实原因的第二个错。
        match fsops::link_state(path, keep) {
            LinkState::Real => match fsops::trash_tree(installer.trasher(), path) {
                Ok(_) => trashed.push(label.clone()),
                Err(err) => {
                    report_links.push((label, Err(err)));
                    continue;
                }
            },
            LinkState::Broken | LinkState::Foreign(_) => {
                if let Err(err) = fsops::unlink_dir(path) {
                    report_links.push((label, Err(err)));
                    continue;
                }
            }
            LinkState::Linked(_) | LinkState::SameLocation | LinkState::Missing => {}
        }
        let outcome = match fsops::link_dir(keep, path, installer.chain(), OnOccupied::Fail) {
            Ok(LinkOutcome::Created(k) | LinkOutcome::Unchanged(k)) => Ok(Converged::Linked {
                mode: k.as_str().into(),
            }),
            Ok(LinkOutcome::SameLocation) => Ok(Converged::SameLocation),
            Err(err) => Err(err),
        };
        if let (Ok(o), Some(d)) = (&outcome, dir) {
            merge_link_record(&mut link_records, d, path, keep, o);
        }
        report_links.push((label, outcome));
    }

    // I1:candidates 里没有 canonical 时,上面的循环够不到它;candidates 里已经
    // 有 canonical 时,这里是第二次收敛,`ensure_canonical_link` 幂等早退。
    // R11:结果装进 `KeepReport::canonical`,不再 `?` 中断。
    let canonical = ensure_canonical_link(installer, &keep_home);
    if let (Ok(outcome), Some(canonical_dir)) = (&canonical, keep_home.canonical.parent()) {
        merge_link_record(&mut link_records, canonical_dir, &keep_home.canonical, keep, outcome);
    }

    touched_dirs.sort();
    touched_dirs.dedup();
    let grouped = registry.group_by_global_dir(env);
    // I2:并集合并,不覆盖——理由见函数文档。
    agents.extend(touched_dirs.iter().filter_map(|d| grouped.get(d)).flatten().cloned());
    agents.sort();
    agents.dedup();

    match next.installed.iter().position(|s| s.name == key) {
        Some(idx) => {
            let rec = &mut next.installed[idx];
            rec.body = Some(keep.to_string_lossy().into_owned());
            rec.content_hash = content_hash.clone();
            rec.agents = agents;
            rec.links = link_records;
            rec.updated_at = now.to_string();
        }
        None => next.installed.push(state::InstalledSkill {
            name: key,
            source: empty_source(),
            commit_sha: String::new(),
            content_hash: content_hash.clone(),
            origin: Some(state::ORIGIN_ADOPTED.to_string()),
            body: Some(keep.to_string_lossy().into_owned()),
            agents,
            links: link_records,
            installed_at: now.to_string(),
            updated_at: now.to_string(),
        }),
    }
    // R11 唯一残留的失败窗口(见函数文档)。
    store.save_state(&next)?;

    Ok(KeepReport {
        body: keep.to_string_lossy().into_owned(),
        trashed,
        links: report_links,
        canonical,
    })
}

/// `keep_version`/`set_agents` 首次给一个纯本地技能(压根没有经过任何技能库)建账时
/// 用的占位来源——[`state::InstalledSkill::source`] 是必填字段,但这个场景就是没有
/// 来源。与「我的技能」页现有对"没有记账基线"那一档的处理同一姿势
/// (`my_skills::build` 里 `source_owner`/`source_repo`/`registry_id` 同样留空)。
fn empty_source() -> state::SkillSource {
    state::SkillSource {
        registry_id: String::new(),
        owner: String::new(),
        repo: String::new(),
        path: String::new(),
        git_ref: String::new(),
    }
}

// ============================================================ 勾选(建链/摘链)

/// [`set_agents`] 的结果。
///
/// ⚠️ **序列化形状**(审查修复轮 4 实测订正,给任务 4/5/7 接前端类型用):
/// - `#[serde(rename_all = ...)]` 挂在**枚举**上**只改 variant 名**
///   (`Done` → `"done"`),**不改 struct variant 的字段名**——本项目 IPC 一律
///   驼峰,所以必须另加 `rename_all_fields`(serde ≥ 1.0.181),否则实际发给
///   前端的是 `home_body` / `unlink_failed` 这样的蛇形键。已有序列化形状测试
///   正面钉住 `homeBody` / `unlinkFailed`;
/// - `Result<T, E>` 走 serde 内建 impl,键是**大写**的 `{"Ok": …}` / `{"Err": …}`,
///   `rename_all` / `rename_all_fields` 都管不到它。这是既定形状,不改实现,
///   前端类型照这个写;
/// - 元组 `(String, Result<..>)` 序列化成 JSON 数组 `[agent 名, 结果]`。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "outcome")]
pub enum SetAgentsOutcome {
    /// 本体位置有分歧,不敢猜——交给用户先在 [`keep_version`] 里拍板。
    NeedsVersionChoice { versions: Vec<Version> },
    Done {
        home_body: String,
        /// canonical ← body 那条链接的收敛结果(审查修复轮 1 I3 引入;审查修复轮 3
        /// R11 改成 `Result`)。`Err` 表示这一步(本函数**第一处写盘**)本身失败了
        /// ——不能再用 `?` 直接中断,那样会让函数带着"后面可能还没写的东西固然
        /// 没写,但这一步本身连结果都没告诉任何人"的半吞状态返回;失败也要如实
        /// 装进这里,交给上层决定要不要提示用户。
        canonical: Result<Converged, AppError>,
        /// 每个目标 agent 的收敛结果。`Err` 表示这个目标建链失败了(比如目标
        /// 位置的父目录被占成了一个普通文件)——不是"没处理它"、是"试过了但没
        /// 成功",必须如实回报,不能只进日志:那样界面看到的会是"什么都没
        /// 发生",而真实情况可能是"本体已经动过、这个工具却没配上"
        /// (审查修复轮 3 R11)。
        results: Vec<(String, Result<Converged, AppError>)>,
        /// 被摘掉关联的 agent 名单(本体不受影响)。
        unlinked: Vec<String>,
        /// 摘链失败的 agent 名单及原因(审查修复轮 2 I4③)。
        ///
        /// **收集而非用 `?` 中断**:摘链循环之后还有 `store.save_state`,一旦
        /// 半途中断,循环里已经成功建好的链接(尤其是本次 `wanted` 新增的那批)
        /// 会因为 `save_state` 没跑到而"磁盘已经动了、账却没存"——`remove::remove`
        /// 只按 `state.links` 摘链,这批链接从此摘不掉,留下一地悬空链接。
        /// 与 `installer::uninstall` 把每条解链结果收进 `UnlinkReport`、不是
        /// 遇错即抛同一姿势:摘不掉的位置(比如账上记的是链接、外部却把它换成了
        /// 一个实体目录)如实回报给界面,不吞、也不让它拖垮整次调用。
        unlink_failed: Vec<(String, AppError)>,
    },
}

fn missing_skill_error(dir_slug: &str) -> AppError {
    AppError::new("FS_MISSING_SKILL", "这个技能的本体不在了,请重新获取一次")
        .with_detail(format!("no body found for {dir_slug}"))
}

/// 注册表不认识这个 agent 名。
///
/// ⚠️ code 与 message **与 `installer::link_targets` / `canonical_visible_agents`
/// 里构造的那个逐字相同**(`FS_UNKNOWN_AGENT` /「这个 AI 工具不在支持列表中」)
/// ——同一件事在两处构造是可接受的小重复,文案漂移不是(术语门会各自扫到,
/// 而界面上会出现两句说同一件事的不同中文)。
fn unknown_agent_error(name: &str) -> AppError {
    AppError::new("FS_UNKNOWN_AGENT", "这个 AI 工具不在支持列表中")
        .with_detail(format!("unknown agent: {name}"))
}

/// 「勾选哪些工具能用这个技能」落地:`wanted`(本次目标集合)里**每一个**目标
/// 都跑一次 [`converge`](幂等,已经正确的直接早退,不是只处理新增的那些——
/// 断链自愈就落在这里,见下),账上有而 `wanted` 里没有的只摘链接(绝不删本体);
/// 无账时首次勾选顺手建一条 `adopted` 账。
///
/// 🔴 **对全体 `wanted` 收敛,不是只对本次新增的差集收敛**(调用方裁定):
/// 「修复关联」作为一个独立按钮的概念已被取消,用户看到某个工具的勾异常时,
/// 能做的唯一动作就是再次勾选它(哪怕账上已经记着这个 agent)——如果只处理
/// "新增"的差集,一个**已经在账上**的工具被人改指或删链之后,用户再怎么点
/// 同一个勾都修不好它,而旧的 `repair_links` 这条自愈路径又已经删除,断链
/// 就会永远留在那里。多付的代价只是每个目标多一次 `link_state` 判定
/// (converge 内部走的早退分支),可以忽略。
///
/// 本体所在工具**永远保留**,不因用户没勾选它就被摘掉——技能就住在那里,
/// 摘掉等于删本体。canonical 与本体不在一处时,每次调用都顺带
/// [`ensure_canonical_link`](幂等,与本次勾选变化无关),结果并进
/// [`SetAgentsOutcome::Done::canonical`](I3)。
///
/// 🔴 **C2**:`locate` 有账时恒返回 `Body{账上}`,但账上记的本体完全可能已经
/// 不在磁盘上了(它自己的文档写明"判断本体缺失是调用方的职责")——本函数在
/// 建任何链接之前先判 `body.is_dir()`,不在就报 `FS_MISSING_SKILL`,不会对着
/// 一个不存在的目标建出悬空链接、再谎称"已启用"。
///
/// 🔴 **I4**:每一条成功的收敛(含 canonical 那条)都并进 `rec.links`(见
/// [`merge_link_record`]),否则 `remove::remove` 找不到这些链接、摘不掉;
/// `removed` 摘链时若账上记的是 `copy` 档,走废纸篓而不是 `unlink_dir`——后者
/// 对实体目录(降级复制的产物)一律拒绝。
///
/// 🔴 **I4③ → R11(审查修复轮 3,结构性)**:I4③ 只堵了摘链循环这一个口子,
/// 复审者在建链循环里复现了同一形状(把某个工具技能目录的父路径造成一个普通
/// 文件,`link_dir` 内部 `create_dir_all(parent)` 失败),证明问题不是某个特例、
/// 是整个函数的结构——"修了特例以为修了结构"在这一个任务里已经重演第二次
/// (上一轮是 Copy 档 → 这一轮是摘链循环 → 这次是建链循环)。裁定 R11 是一句话:
/// **从第一次写磁盘到 `save_state` 之间,任何失败都不得让函数带着"磁盘已动、
/// 账未存"的状态返回。** 逐处落地:
/// - [`ensure_canonical_link`](本函数第一处写盘):失败不再 `?`,装进
///   `SetAgentsOutcome::Done::canonical` 的 `Err` 分支;
/// - 两处 `link_targets_for`(建链目标 / 摘链目标)**前移到任何写盘之前**
///   ——它们是纯计算(分组、只拼路径,不碰盘),挪到前面之后 `?` 就是安全的,
///   与位置⑤ 的 hash 前移同一姿势。**审查修复轮 4 订正**:修复轮 3 当时是
///   "留在原地 + 失败按名单逐个记 `Err`",那个写法有两处硬伤——① 一个坏名字
///   会让整个调用失败,却给**每个** agent 各记一条同样的 `Err`,界面按键渲染
///   就是「trae:这个 AI 工具不在支持列表中」,**对 trae 是假话**;② 回退分支
///   只过滤了本体自己的 agent,**漏了 universal 那一档**(cursor/codex 的
///   `skillsDir` 就是 canonical,正常路径里 `link_targets` 本就跳过它们、
///   它们从不出现在 `results`),于是给一个技能**确实生效**的工具记了失败。
///   现在改成**先按 agent 逐个 resolve**:注册表不认识的名字自己一条
///   `FS_UNKNOWN_AGENT`(**坏名字只坑它自己**),认识的照常成组建链/摘链;
/// - **`converge(...)`(建链循环内,主犯,复审者已复现)**:每个目标一个结果,
///   成功给 `Ok(Converged)`、失败给 `Err`,都装进 `results`,循环继续,不中断;
/// - `dir_content_hash(&home.body)`(仅无账新建那一档需要):**挪到本函数
///   任何写盘调用之前算**——原先排在写盘全部完成之后,一旦这里失败,磁盘已经
///   全部写完却建不出账,新技能会永久停留在"我的技能"里看不到的状态。挪到
///   最前面之后,这里继续用 `?` 是安全的:此刻还没有任何 `ensure_canonical_
///   link`/`converge` 调用发生过,提前返回不会留下"磁盘已动、账未存"的半成品。
///   **审查修复轮 4 顺带消掉了它留下的 `expect`**:"有没有账"这个判定改成在
///   写盘前定好一个 `existing_idx`,落账时按同一个下标分流——写盘窗口里从此
///   一个 `?`/`unwrap`/`expect`/提前 return 都没有;
/// - `store.save_state` 自身:固有的、收集救不了的最后一道窗口——它本身就是
///   "落账"这个动作,失败了没有更早的地方可以退。这是这条判据下**唯一**
///   仍然存在、也只能存在的失败窗口。
///
/// 🔴 **账上绝不写进注册表不认识的 agent 名**(审查修复轮 4):`rec.agents`
/// 写的是 `known`(`wanted` 减去未知名),不是 `wanted`。写进去的话方向恰好与
/// R11 相反——变成「账已存、磁盘未动」;更糟的是若界面从 `rec.agents` 回显
/// 勾选态再原样传回,垃圾名会**循环存在**,而它每次都会被判进 `removed`
/// (它不在下一次的 `known` 里),这个技能的关联状态永远稳定不下来。
pub fn set_agents(
    installer: &Installer<'_>,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &state::Store,
    dir_slug: &str,
    agents: &[String],
    now: &str,
) -> Result<SetAgentsOutcome, AppError> {
    let mut next = store.load_state()?.value;

    let located = locate(installer, registry, env, &next, dir_slug)?;
    let body = match located {
        Located::Differs(versions) => return Ok(SetAgentsOutcome::NeedsVersionChoice { versions }),
        Located::None => return Err(missing_skill_error(dir_slug)),
        Located::Body { body, .. } => body,
    };

    // C2:见函数文档。
    if !body.is_dir() {
        return Err(missing_skill_error(dir_slug));
    }

    let home = installer.home(dir_slug, Some(&body))?;

    let grouped = registry.group_by_global_dir(env);
    let body_agents: Vec<String> = home
        .body
        .parent()
        .and_then(|d| grouped.get(d))
        .cloned()
        .unwrap_or_default();

    let mut wanted: Vec<String> = agents.to_vec();
    for a in &body_agents {
        if !wanted.contains(a) {
            wanted.push(a.clone());
        }
    }
    wanted.sort();
    wanted.dedup();

    // 🔴 按 agent 逐个 resolve:注册表不认识的名字自己单独成一档,**坏名字只坑
    // 它自己**,合法的照常建链/摘链(见函数文档 R11 那段的订正)。
    let (known, unknown): (Vec<String>, Vec<String>) =
        wanted.iter().cloned().partition(|a| registry.get(a).is_some());

    // 这个下标在写盘之前定好,写盘期间没有任何代码改动 `next.installed` 的成员
    // 关系,所以后面直接拿它落账——不必写盘之后再 `position` 一次,更不必为
    // "刚才到底有没有账"留一个 `expect`(那是一条能在 Tauri command 里 panic
    // 的路,`parse_owner_repo` 的 expect 是前车之鉴)。
    // 查账/落账一律用 `home.dir_name`(= `record_key`),不是 `dir_slug`——见 `record_key`。
    let key = home.dir_name.clone();
    let existing_idx = next.installed.iter().position(|s| s.name == key);
    let existing = existing_idx.map(|i| &next.installed[i]);
    let existing_agents: Vec<String> = existing.map(|s| s.agents.clone()).unwrap_or_default();
    let mut link_records: Vec<state::LinkRecord> = existing.map(|s| s.links.clone()).unwrap_or_default();

    let removed: Vec<String> = existing_agents.iter().filter(|a| !wanted.contains(a)).cloned().collect();
    // 账上可能留着注册表不再认识的陈旧 agent 名(跨版本注册表变化)。它没有可解析
    // 的目录,摘无可摘,如实回报;但绝不能让它拖垮其余合法目标的摘链。
    let (removed_known, removed_unknown): (Vec<String>, Vec<String>) =
        removed.iter().cloned().partition(|a| registry.get(a).is_some());

    // R11:下面三处都必须在任何写盘调用之前算完,失败在这里用 `?` 是安全的
    // (还没有任何磁盘写入发生过)。`link_targets_for` 是纯计算——按目录分组、
    // 只拼路径,不碰盘。
    // 只有"无账、这次要新建一条"时才需要基线指纹;有账时这个值不会被消费
    // (下面按同一个 `existing_idx` 分流,走的是原地更新那一档)。
    let fresh_content_hash = match existing_idx {
        Some(_) => String::new(),
        None => fsops::dir_content_hash(&home.body)?,
    };
    let add_targets = installer.link_targets_for(&home, &known)?;
    let remove_targets = installer.link_targets_for(&home, &removed_known)?;

    // I3 / R11:结果并进 Done,不再用 `?` 中断——这是本函数第一处写盘。
    let canonical = ensure_canonical_link(installer, &home);
    if !home.body_is_canonical() {
        if let (Ok(outcome), Some(canonical_dir)) = (&canonical, home.canonical.parent()) {
            merge_link_record(&mut link_records, canonical_dir, &home.canonical, &home.body, outcome);
        }
    }

    // 🔴 对 `wanted` 里**每一个**目标都跑 `converge`,不是只跑本次新增的那些
    // (调用方裁定,取代了原先"只处理差集"的写法)。「修复关联」这个概念已经被
    // 取消——它不是一个独立按钮,断链自愈只能落在这里:用户看到某个工具的勾是
    // 灰的/异常的,再点一次(哪怕账上已经记着这个 agent),它就该自己好。
    // `converge` 本身幂等:链接已经正确时早退返回 `Unchanged`,不写盘,所以
    // "全量重跑"的代价只是每个目标多一次 `link_state` 判定,可以忽略。
    let mut results: Vec<(String, Result<Converged, AppError>)> = Vec::new();
    // 坏名字只坑它自己:一条独立的 `FS_UNKNOWN_AGENT`,不牵连任何别的 agent。
    for agent_name in &unknown {
        results.push((agent_name.clone(), Err(unknown_agent_error(agent_name))));
    }
    for target in add_targets {
        let link = target.dir.join(&home.dir_name);
        // R11:不再用 `?`——建链失败(比如目标位置的父目录被占成了一个
        // 普通文件,`link_dir` 内部 `create_dir_all(parent)` 报错)必须
        // 收进 `results`,不能中断:循环里可能还有别的目标本该成功、
        // 更早的 canonical 那步也可能已经写盘,中断会把它们的记账
        // 一起拖没了。
        let outcome = converge(installer, &link, &home.body);
        if let Ok(o) = &outcome {
            merge_link_record(&mut link_records, &target.dir, &link, &home.body, o);
        }
        for agent_name in &target.agents {
            results.push((agent_name.clone(), outcome.clone()));
        }
    }

    let mut unlinked = Vec::new();
    let mut unlink_failed: Vec<(String, AppError)> = Vec::new();
    for agent_name in &removed_unknown {
        unlink_failed.push((agent_name.clone(), unknown_agent_error(agent_name)));
    }
    for target in remove_targets {
        let link = target.dir.join(&home.dir_name);
        // I4:账上记的是 copy 档时,磁盘上那个位置是**实体目录**
        // (降级复制的产物)。`unlink_dir` 对实体目录一律拒绝
        // (`FS_NOT_A_LINK`),走废纸篓才对——判定与
        // `installer::unlink_one` 对 Copy 档同款。
        let recorded_copy = link_records
            .iter()
            .any(|l| Path::new(&l.dir) == target.dir.as_path() && l.mode == "copy");
        let result = if recorded_copy {
            fsops::trash_tree(installer.trasher(), &link)
        } else {
            fsops::unlink_dir(&link)
        };
        // I4③:收集失败,不用 `?` 中断——理由见函数文档 R11。
        match result {
            Ok(true) => {
                link_records.retain(|l| Path::new(&l.dir) != target.dir.as_path());
                unlinked.extend(target.agents.iter().cloned());
            }
            Ok(false) => {}
            Err(err) => {
                for agent_name in &target.agents {
                    unlink_failed.push((agent_name.clone(), err.clone()));
                }
            }
        }
    }

    let body_str = home.body.to_string_lossy().into_owned();
    match existing_idx {
        Some(idx) => {
            let rec = &mut next.installed[idx];
            rec.body = Some(body_str.clone());
            // 只写注册表认识的名字——见函数文档最后一段(不毒化账)。
            rec.agents = known;
            rec.links = link_records;
            rec.updated_at = now.to_string();
        }
        None => next.installed.push(state::InstalledSkill {
            name: key,
            source: empty_source(),
            commit_sha: String::new(),
            content_hash: fresh_content_hash,
            origin: Some(state::ORIGIN_ADOPTED.to_string()),
            body: Some(body_str.clone()),
            agents: known,
            links: link_records,
            installed_at: now.to_string(),
            updated_at: now.to_string(),
        }),
    }
    store.save_state(&next)?;

    Ok(SetAgentsOutcome::Done {
        home_body: body_str,
        canonical,
        results,
        unlinked,
        unlink_failed,
    })
}
