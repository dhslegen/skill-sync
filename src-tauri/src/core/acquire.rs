//! 获取流程编排:下载 → 预检 → 落盘 → 建链 → 记账。
//!
//! 各模块刻意都只管自己那一段:[`crate::core::installer`] 不碰 `state.json`、
//! [`crate::core::store`] 只管索引、[`crate::core::skill_lock`] 是外部契约。
//! 把它们串起来的这段编排放在这里,`commands.rs` 保持薄壳。
//!
//! # 这里是 contentHash 守卫真正生效的地方
//!
//! `Installer::install` 会**无条件替换本体**(它的文档里写明了;v6 二期起写入顺序
//! 是 staging → 旧本体进废纸篓 → rename,不再是原地清空重建,但对调用方的意义
//! 不变——旧内容照样会被换掉)。
//! 任务 7 备好的料——`state.installed[].contentHash` 与 `fsops::dir_content_hash`——
//! 到本模块才第一次被接上:两者不符即说明用户改过技能本体,此时**先返回让界面去问**,
//! 拿到用户结论才动磁盘。这是铁律 7「绝不静默删除用户文件」在获取路径上的落地。
//!
//! # 假设(文档未覆盖,按开发纪律显式标注)
//!
//! - **`Resolution` 只有两档**:「把本地改动分享上去」(任务 11 起可用)由前端编排——
//!   先带 `KeepLocal` 走本函数落稳,再调 [`crate::core::share::share_installed`] 推改动。
//!   保留时 `commitSha` 与 `contentHash` **一个都不更新**——它们不符正是
//!   "有未分享的改动 / 有可用更新"这两个标记的判据,更新了标记就消失了。
//! - **安装时重新下载一次压缩包**,不把全部文件内容塞进索引缓存:安装是低频操作,
//!   一次往返换取"装上的就是此刻远端的内容",比缓存 50 个技能的全部文件划算。
//!   顺手用同一份压缩包刷新索引缓存,免得再下一次。

use std::path::Path;

use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::fsops;
use crate::core::gitea::{RepoArchive, RepoRef, RepoSource};
use crate::core::installer::{InstallReport, Installer, SkillPayload};
use crate::core::ownership::{self, Identity};
use crate::core::skill_lock::{self, LockEntry, LockOutcome};
use crate::core::state::{self, InstalledSkill, LinkRecord, SkillSource, Store};
use crate::core::store::{self as store_index, IndexedSkill};
use crate::error::AppError;

/// `state.installed[].origin` 的两个历史取值。
///
/// v6 撤掉了「纳入管理 / 移出管理」(`claim`/`unclaim` 已删,见
/// `docs/设计-v6-技能归属模型.md` §3「四本账去留」):技能与"我"的关系现在由
/// `ownership::relation` 从技能库的 `authors.json` 现场判定,不再依赖这个标记。
///
/// **两个值都还在写,只是没有任何判定再读它们**(v6 终审订正:原文写成
/// "只剩读的意义",与紧随其后的两句自相矛盾——方向恰好反了):
/// `ORIGIN_ACQUIRED` 由 [`record`] 写入(文件是本 app 装的),`ORIGIN_CLAIMED`
/// 由 `share::adopt_into_management` 写入(文件是用户自己放的、本 app 只记了账),
/// 存量 `state.json` 里还留着旧版认领写下的同名值。它们如今是**纯留痕**:
/// 界面分区、能不能移除、能不能分享,一概不看这个字段。
/// ⚠️ **别据此把它们删掉**——写进 `state.json` 的字段一旦停写,存量文件与新文件
/// 的形状就分了叉,而它们的成本只是一个字符串。
pub const ORIGIN_CLAIMED: &str = "claimed";
pub const ORIGIN_ACQUIRED: &str = "acquired";

// ============================================================ 预检

/// 这个技能在这台电脑上当前的状况。
///
/// ⚠️ **`rename_all_fields` 不是可有可无的**(v6 二期任务 4 实测):`rename_all`
/// 挂在**枚举**上只改 variant 名,**不改 struct variant 的字段名**——本枚举此前
/// 因此把 `installed_sha` / `up_to_date` / `source_owner` / `source_repo` /
/// `local_changed` / `remote_changed` 全部以蛇形发给前端,而 `src/lib/ipc.ts`
/// 的 `Precheck` 类型与 `ConflictDialog` 读的一直是驼峰。表现是
/// 「装自另一个技能库」的弹窗把库名显示成 `undefined/undefined`,
/// 「我分享的」那一档的 `remoteChanged` 恒为 undefined(于是后续分享不强制走审核)。
/// 序列化形状有测试正面钉住,别把这行属性删了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum Precheck {
    /// 这台电脑上没有这个技能,直接装。
    Fresh,
    /// **无账**,本地已有一份实体,内容与库里这一版逐字节相同。
    ///
    /// 装 = 记账 + 建链,**本体一个字节都不写**(它已经是对的了)。典型场景:
    /// 用户在 `~/.claude/skills/` 下开发技能、经 git 直接推进了技能库,
    /// 换台电脑或重装 app 之后再取回。旧模型在这里说的是「这个位置上的技能
    /// 不是本应用安装的」并把它当成外人——那句话正是 v6 二期要消灭的。
    AlreadyHere {
        /// 本体所在(实体目录)。
        body: String,
    },
    /// **无账**,本地已有一份实体,内容与库里这一版不同。
    ///
    /// 两选:用库里的(`Resolution::Overwrite` → 旧的那份进废纸篓,库里的版本装到
    /// **同一位置**,本体不搬家)/ 保留本地(`Resolution::KeepLocal` → 什么都不做)。
    LocalDiffers {
        /// 本地那一份实体所在。
        existing: String,
    },
    /// **无账**,同名技能在多处各有一份实体且内容有分歧——先让用户拍板留哪一份
    /// (`converge::keep_version`),再谈获取。任何 `Resolution` 都回答不了
    /// "留哪一份",所以这一档**无视 `resolution`**,恒返回"需要拍板"。
    NeedsVersionChoice { versions: Vec<crate::core::converge::Version> },
    /// 本应用装的,且本体与安装时一致——覆盖是安全的(这就是"更新")。
    Managed {
        installed_sha: String,
        /// 本地已经是远端这一版了。
        up_to_date: bool,
    },
    /// 本应用装的,但**用户改过本体**。覆盖会丢改动,必须先问。
    LocallyModified { installed_sha: String },
    /// 本应用装的,但装自**另一个技能库**的同名技能(M4 任务 1 一源多仓)。
    ///
    /// 这不是"更新",是"用另一个库的同名技能替换掉现有的"——两者内容可能毫无关系。
    /// 用户没改过本体时 hash 也照样不等,只比 hash 会把它当成一次正常更新静默做掉,
    /// 那就是在没问过任何问题的情况下换掉用户的技能。展示名要说清是从哪个库来的。
    OtherLibrary {
        installed_sha: String,
        /// 账上记的来源库,展示为 `owner/repo`。
        source_owner: String,
        source_repo: String,
    },
    /// **技能库里记的分享者就是当前登录的这个人**(v6 任务 3)。
    ///
    /// 这一档取代了作者在自己技能上会看到的 `Foreign`/`LocallyModified`/
    /// `Managed{up_to_date:false}` 三种说法——它们讲的都是"这东西是怎么来的"
    /// (来历),而作者要的是"我这边和库里哪边新"(关系)。
    ///
    /// - `local_changed`:本地本体与账上基线不符(没有账 = 没有基线,保守当作改过);
    /// - `remote_changed`:库里这一版与账上基线不符(判据是**逐技能内容指纹**,
    ///   不是库头 sha,见 [`remote_content_changed`])。
    Mine {
        local_changed: bool,
        remote_changed: bool,
    },
}

/// 用户对冲突的处置。界面负责给默认值,这里不替它决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    /// 保留本地本体不动,只补建链接。
    KeepLocal,
    /// 用远端内容覆盖本地。**会丢用户改动**,界面必须已明确告知。
    Overwrite,
}

/// [`precheck`] 判"这是谁的技能"所需的三样东西(v6 任务 3)。
///
/// 单独成结构体而不是三个位置参数:`precheck` 本来就已经六个参数,再加三个
/// 会顶到 clippy 的 `too_many_arguments`,而用 `#[allow]` 掩过去只是把味道藏起来。
/// `Default`(全 `None`)= **未登录、库里没记作者**,此时全部判定与 v6 之前逐字相同
/// ——既有调用方与既有测试因此可以原样迁移,这也是"未登录行为一个字不变"的护栏。
#[derive(Debug, Clone, Copy, Default)]
pub struct PrecheckContext<'a> {
    /// 目标技能库对应的登录身份(`config.identities[registryId]`),未登录 `None`。
    pub me: Option<&'a Identity>,
    /// 技能库根 `authors.json` 里记的分享者(索引 `attribution.author`)。
    pub author: Option<&'a str>,
    /// 远端这一版技能的**内容指纹**(`store::IndexedSkill::content_hash`)。
    ///
    /// 拿不到时(旧索引缓存没有这个字段)`remote_changed` 退回库头 sha 比对,
    /// 见 [`remote_content_changed`]。
    pub remote_content_hash: Option<&'a str>,
}

/// 「技能库里记的分享者是不是我」。判定实现只有 [`ownership::relation`] 一处。
///
/// `in_library` 恒 `true` **由构造保证**:调用方只在技能确实存在于索引里时才走到这里。
/// `local_present` **必须传真实值**——它在 [`precheck`] 里确实恒真(canonical 不存在
/// 已经早退成 `Fresh`),但 [`finish`] 是在早退之外调用的,`Fresh`(换电脑那一档)
/// 的真实值是 `false`。今天两者结论相同只是因为 `in_library=true` 把 `local_present`
/// 短路掉了,那是下层的巧合不是这一层的正确——`link_dirs` 的 universal 跳过就是这么
/// 被下层守卫兜住、删掉之后端到端测试照样全绿的(CLAUDE.md 有记)。
fn is_mine(ctx: &PrecheckContext<'_>, local_present: bool) -> bool {
    ownership::relation(ctx.me, ctx.author, true, local_present) == ownership::Relation::Shared
}

/// 库里这一版与账上基线比,变没变。
///
/// 🔴 **判据是逐技能的内容指纹,不是库头 sha**:库头一变就说"库里有新版"正是
/// 2026-08-03 用户实测撞到的缺陷(别人分享任意一个技能都会让全部已装技能同时亮),
/// 而这个值会驱动两件真事——冲突弹窗上那句"库里有新版",以及「以本地为准」之后
/// 分享更新要不要强制走审核。用库头算,两件事都会长期说假话。
///
/// 指纹任一侧缺失(旧缓存没有 `content_hash`)时退回库头比对:这个方向上宁可**多报**
/// ——多报的代价是分享多走一次审核,少报的代价是直推覆盖同事经审核改过的版本。
fn remote_content_changed(
    recorded: &InstalledSkill,
    ctx: &PrecheckContext<'_>,
    remote_sha: &str,
) -> bool {
    match ctx.remote_content_hash {
        Some(remote) if !remote.is_empty() && !recorded.content_hash.is_empty() => {
            recorded.content_hash != remote
        }
        _ => recorded.commit_sha != remote_sha,
    }
}

/// 读磁盘与 state,判断这个技能在这台电脑上的现状。不写任何东西。
///
/// v6 二期起判定的起点是 [`crate::core::converge::locate`](本体「实际住在哪」),
/// 不再是"canonical 上有没有东西"——本体可以住在任何一个工具目录里,而
/// canonical 只是一条指向它的链接。
// 八个参数。拆成结构体不划算:`installer`/`registry`/`env`/`state` 是四个来源
// 各不相同的上下文引用,打包只会多一层没有语义的壳,而 `PrecheckContext`
// (真正相关的三样)已经打包过了。
#[allow(clippy::too_many_arguments)]
pub fn precheck(
    installer: &Installer,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    state: &state::State,
    dir_slug: &str,
    remote_sha: &str,
    // target:本次请求的目标库。`None` = 调用方不关心来源,跳过库比对。
    target: Option<&RepoRef>,
    ctx: PrecheckContext<'_>,
) -> Result<Precheck, AppError> {
    let located = crate::core::converge::locate(installer, registry, env, state, dir_slug)?;
    let body = match located {
        crate::core::converge::Located::None => return Ok(Precheck::Fresh),
        // 有账时 `locate` 恒返回 `Body`(见该变体的文档),所以这一档只可能出现在
        // 无账那条路上——有测试钉住:`a_recorded_skill_with_a_stray_differing_copy_still_updates_normally`
        crate::core::converge::Located::Differs(versions) => {
            return Ok(Precheck::NeedsVersionChoice { versions })
        }
        crate::core::converge::Located::Body { body, .. } => body,
    };
    // 账上记着本体、那个目录却已经不在磁盘上(用户手动删了):没有"本地内容"可谈,
    // 按全新安装走,重新获取即可把它对齐回来。这条早退取代了 v6 二期之前的
    // `!canonical.exists()`,行为等价——它守的是同一件事。
    if !body.is_dir() {
        return Ok(Precheck::Fresh);
    }

    // `installer.home` 保证过 body 的叶子名就是 canonical 的目录名(对不上会
    // 报 `FS_BAD_BODY`),所以这里取到的与旧代码从 canonical 取的是同一个值。
    let dir_name = body
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir_slug.to_string());

    // 本体一定在(不在已经早退成 Fresh),传真实值即 true
    let mine = is_mine(&ctx, true);

    // 🔴 **空来源账不算"从技能库装的",一律走无账那条路**(v6 二期任务 4 修复轮 1,
    // R14)。`Managed` 的语义是"从某个技能库装的、且与安装时一致,覆盖是安全的
    // (这就是更新)",而全空来源的 `adopted` 账(任务 3 起,勾选工具 / 版本拍板
    // 时顺手建的)**不满足这个前提**:它的 `content_hash` 只是"勾的那一刻的快照",
    // 不是"从库里装下来的那一版"。不过滤掉的话,`commit_sha` 为空 → `up_to_date`
    // 恒 false → `Managed{up_to_date:false}` → `needs_decision` 不含它 →
    // **用户的纯本地草稿被无决策直接覆盖**(内容进废纸篓可逆,但没问过一句)。
    //
    // 过滤之后 `OtherLibrary` 那一档就不必再问一次 `has_source()` 了——同一条规则
    // 查两遍是本项目的空转模式 ①,多余那道闸会吞掉注入信号。
    let recorded = state
        .installed
        .iter()
        .find(|s| s.name == dir_name)
        .filter(|r| r.has_source());
    let Some(recorded) = recorded else {
        // 🔴 v6 的核心修复:**作者永远进不了"这不是本应用装的"那一档**。用户自己写的
        // 技能、直接推进技能库(或换电脑后重装的 app)在本地没有任何记账,旧代码据此
        // 告诉他"这个位置上的技能不是本应用安装的"——app 把自己的作者当成了外人。
        //
        // 没有记账 = 没有基线,两边一律按"变了"处理。保守方向只有这一个:
        // 少报 local_changed 会静默覆盖作者自己的内容(铁律 7),
        // 少报 remote_changed 会让接下来的分享更新直推、覆盖同事经审核改过的版本。
        if mine {
            return Ok(Precheck::Mine {
                local_changed: true,
                remote_changed: true,
            });
        }
        // 🔴 v6 二期:不是我分享的、也没有账,那就**只问内容**——不再去猜"这个
        // 文件夹是谁建的"(磁盘上根本回答不了那个问题)。内容与库里相同 = 无损,
        // 记账建链即可;不同 = 有损,停下来让用户两选。
        let local = fsops::dir_content_hash(&body)?;
        let existing = body.to_string_lossy().into_owned();
        return Ok(match ctx.remote_content_hash {
            Some(remote) if remote == local => Precheck::AlreadyHere { body: existing },
            _ => Precheck::LocalDiffers { existing },
        });
    };

    // 来源库不同要**先于**内容比对:用户没改过本体时 hash 照样不等(两个库的同名
    // 技能内容本就不同),落进 Managed 就会被当成一次正常更新静默做掉。
    //
    // 这一档**不受 `Mine` 影响**:两个库里的同名技能是两个东西,哪怕两边的作者
    // 都是我,"用另一个库的同名技能替换掉现有的"仍然必须由用户拍板。
    //
    // 走到这里的 `recorded` 一定有来源坐标(上面已按 `has_source()` 过滤),所以
    // 这里直接比 owner/repo 就够——空来源账不会落到这一档说出「这个技能已装自
    // 另一个技能库」那句假话(它压根没有装自任何技能库)。
    if let Some(t) = target {
        if recorded.source.owner != t.owner || recorded.source.repo != t.repo {
            return Ok(Precheck::OtherLibrary {
                installed_sha: recorded.commit_sha.clone(),
                source_owner: recorded.source.owner.clone(),
                source_repo: recorded.source.repo.clone(),
            });
        }
    }

    let remote_changed = remote_content_changed(recorded, &ctx, remote_sha);
    let actual = fsops::dir_content_hash(&body)?;
    if actual != recorded.content_hash {
        // 有账之后也必须还能进 `Mine`:第一次取回就会往 `state.installed` 记一条,
        // 此后同名目录先命中 LocallyModified。只在"没记账"时判关系的话,
        // 「我分享的」技能两边都新时弹的仍是旧三选(里面有拍板不给作者的
        // 「保留并贡献」)——折叠因此放在 core,不交给前端按 relation 挑弹窗。
        if mine {
            return Ok(Precheck::Mine {
                local_changed: true,
                remote_changed,
            });
        }
        return Ok(Precheck::LocallyModified {
            installed_sha: recorded.commit_sha.clone(),
        });
    }
    let up_to_date = recorded.commit_sha == remote_sha;
    if mine && !up_to_date {
        return Ok(Precheck::Mine {
            local_changed: false,
            remote_changed,
        });
    }
    Ok(Precheck::Managed {
        installed_sha: recorded.commit_sha.clone(),
        up_to_date,
    })
}

// ============================================================ 进度

/// 长任务进度。通过 Tauri event `progress://{taskId}` 上报(契约 3.3)。
///
/// core 不依赖 Tauri:编排收一个回调,由 command 那层把它接到事件上。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// 取技能库内容。
    Fetching,
    /// 检查本地现状。
    Checking,
    /// 写入技能内容。
    Writing,
    /// 关联到 AI 工具。
    Linking,
    /// 记录安装信息。
    Recording,
    Done,
}

/// 进度回调。
///
/// `Send + Sync` 不是装饰:`acquire` 是 async 且要跨 await 持有它,
/// 而 `&T` 只有在 `T: Sync` 时才是 `Send`。少了这两个约束,整个 command 的 future
/// 就不是 Send,Tauri 直接拒绝注册——报错只说 "future cannot be sent between threads"。
pub type ProgressSink<'a> = &'a (dyn Fn(Stage) + Send + Sync);

// ============================================================ 结果

/// ⚠️ `rename_all_fields` 的理由与 [`Precheck`] 上那条逐字相同(v6 二期任务 4 实测):
/// 不加它,`local_kept` / `remote_changed` 会以蛇形发给前端,而 `src/lib/ipc.ts`
/// 读的是 `localKept` / `remoteChanged`。后者尤其要命——它为真时后续分享必须
/// 强制走审核,读成 `undefined` 就等于永远不强制,直推覆盖同事经审核改过的版本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "outcome")]
pub enum AcquireOutcome {
    /// 需要用户先决定怎么处理本地内容。**磁盘一个字节都没动。**
    NeedsDecision { precheck: Precheck },
    /// 「我分享的」技能上用户选了**以本地为准**:磁盘、记账、关联一个字节都没动
    /// (v6 任务 3)。下一步由调用方去走「分享更新」,不是安装。
    ///
    /// 带上 `remote_changed` 是为了让这一步自己把话说全——调用方不必跨两次 IPC 记住
    /// 上一轮 `NeedsDecision` 里的那个值:**它为真时后续分享会覆盖库里那一版**
    /// (前提就是"库里已有新版")。
    ///
    /// ⚠️ 这里原先写的是"必须带 `force_review`"——v8 任务 3 把提交审核整条下线之后
    /// 那个形参已经不存在了,那句话是假话。覆盖前的拍板确认是 v8 任务 4 的事。
    Kept { remote_changed: bool },
    Installed {
        report: InstallReport,
        /// 本次保留了用户的本地改动(没有覆盖本体)。
        local_kept: bool,
        /// `.skill-lock.json` 双写的结果。失败或跳过都不影响安装本身。
        lock: String,
    },
}

/// 写 `.skill-lock.json` 时要用的来源标识(M6 任务 6)。
///
/// 外部契约要的是**完整 URL 与真实类型**——录制的 ground truth
/// (`tests/fixtures/upstream-skill-lock.json`)里 `sourceUrl` 就是完整 URL。
/// 此前这里写的是 `"owner/repo"`、`sourceType` 一律写死 `gitea`,于是
/// `acquire::resolve_binding_of` 的同源判据对本 app 自己装的技能整个失效。
#[derive(Debug, Clone, Copy)]
pub struct SourceMeta<'a> {
    pub registry_id: &'a str,
    /// `gitea` | `github`。
    pub kind: &'a str,
    /// 源地址,与 `owner/repo` 拼成 `sourceUrl`。
    pub base_url: &'a str,
}

impl SourceMeta<'_> {
    fn source_url(&self, repo: &RepoRef) -> String {
        format!("{}/{}/{}", self.base_url.trim_end_matches('/'), repo.owner, repo.repo)
    }
}

/// 全部字段都是 `Copy` 类型(引用/切片/`Option<Resolution>`),派生 `Copy` 让
/// 同一个请求能先喂给 blob 快路径试一次、失败再原样喂给 zipball 路径——不然
/// 调用方(`commands::skill_install`)得手写两份几乎一样的构造代码(M10 任务 3)。
#[derive(Clone, Copy)]
pub struct AcquireRequest<'a> {
    pub source: SourceMeta<'a>,
    pub repo: &'a RepoRef,
    /// 技能库中的技能目录名。
    pub dir_slug: &'a str,
    pub agent_names: &'a [String],
    /// 冲突时的处置。`None` 表示界面还没问过——预检发现冲突就原样返回。
    pub resolution: Option<Resolution>,
}

// ============================================================ 编排

/// 从压缩包里取出一个技能目录的全部文件。
///
/// 用索引里记的 `path`(已相对技能库根)拼,不重新推前缀。
/// 落盘要的是**字节**与**权限位**,所以走 `archive.entries` 而不是文本树
/// ——文本树里没有二进制文件,也没有可执行位。
pub fn extract_payload(archive: &RepoArchive, skill: &IndexedSkill) -> SkillPayload {
    let prefix = if archive.root.is_empty() {
        format!("{}/", skill.path)
    } else {
        format!("{}/{}/", archive.root, skill.path)
    };
    let mut payload = SkillPayload::new();
    for (path, entry) in &archive.entries {
        let Some(rel) = path.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        payload = if entry.is_executable() {
            payload.with_executable(rel, entry.bytes.clone())
        } else {
            payload.with_file(rel, entry.bytes.clone())
        };
    }
    payload
}

/// 走完一次获取。
///
/// `now` 为 ISO-8601 时间戳,由调用方注入以便测试(与 skill_lock 的约定一致)。
#[allow(clippy::too_many_arguments)]
pub async fn acquire(
    client: &impl RepoSource,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    req: AcquireRequest<'_>,
    now: &str,
    fetched_at: i64,
    trasher: &dyn fsops::Trasher,
    progress: ProgressSink<'_>,
) -> Result<AcquireOutcome, AppError> {
    progress(Stage::Fetching);
    // 先问分支头再下载:记账要记**实际装下来的那个版本**。
    // 拿商店缓存里的 sha 去记会在"浏览时是 A、点安装时远端已到 B"的情况下永久记错,
    // 而且错得毫无提示——之后的更新检查全部失灵。
    let head = client.branch_head(req.repo).await?;
    let archive = client.download_archive(req.repo).await?;

    // 压缩包已经在手上,顺带把索引缓存刷新到同一版本:一次下载服务两处。
    let index = store_index::build_index(req.source.registry_id, req.repo, &head, &archive, fetched_at);
    let cache = store_index::cache_path(store.dir(), req.source.registry_id, req.repo);
    if let Err(err) = store_index::save_cache(&cache, &index) {
        eprintln!("[acquire] 刷新索引缓存失败(不影响安装): {err}");
    }

    let skill = index
        .skills
        .iter()
        .find(|s| s.dir_slug == req.dir_slug)
        .ok_or_else(|| {
            AppError::new(
                "REPO_NOT_FOUND",
                "这个技能已不在该技能库中,请返回列表刷新后再试",
            )
            .with_detail(format!("dir_slug not in index: {}", req.dir_slug))
        })?;

    let payload = extract_payload(&archive, skill);

    finish(registry, env, store, req, skill, payload, &head.sha, now, trasher, progress).await
}

/// 广场安装的 blob 快路径(M10 任务 3):取数那一步(下载压缩包 → 建索引 →
/// 找到技能 → 抽取 payload)已经由调用方(`commands::skill_install` 的 plaza 分支,
/// 经 `core::plaza::blob_install_candidate`/`finish_blob_install` 拼好),不再重复
/// 下载整仓压缩包。**预检 → 落盘 → 建链 → 记账这条尾巴与 [`acquire`] 完全共用**
/// (都是 [`finish`]),这正是"守卫在 acquire、不许绕开"这条硬约束落地的地方——
/// blob 路径与 zipball 路径唯一的差别只在"payload 从哪来",冲突判定、
/// `Installer::install` 的替换保护(staging → 旧本体进废纸篓 → rename)、
/// `.skill-lock.json` 双写口径一个字都没有分叉。
///
/// **不刷新索引缓存**:blob 只知道"这一个技能",拿它建一份只有一条记录的索引
/// 缓存写盘,会让这个仓后续正常浏览(切到「按仓浏览」)只看到一个技能——宁可让
/// 下一次浏览触发一次完整的 zipball 刷新(既有行为),也不写一份残缺缓存。
#[allow(clippy::too_many_arguments)]
pub async fn acquire_prefetched(
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    req: AcquireRequest<'_>,
    skill: &IndexedSkill,
    payload: SkillPayload,
    remote_sha: &str,
    now: &str,
    trasher: &dyn fsops::Trasher,
    progress: ProgressSink<'_>,
) -> Result<AcquireOutcome, AppError> {
    finish(registry, env, store, req, skill, payload, remote_sha, now, trasher, progress).await
}

/// [`acquire`]/[`acquire_prefetched`] 共用的尾巴:预检 → 落盘 → 建链 → 记账。
/// 两者唯一的区别是"payload/skill/remote_sha 怎么来的"(前者现下载现建索引,
/// 后者由调用方已经拼好),从这里开始完全同一条逻辑,这也是"守卫在 acquire"
/// 这条硬约束在代码层面的体现——没有第二份预检/记账实现。
#[allow(clippy::too_many_arguments)]
async fn finish(
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    req: AcquireRequest<'_>,
    skill: &IndexedSkill,
    payload: SkillPayload,
    remote_sha: &str,
    now: &str,
    // 覆盖/重装会把旧本体经 `Installer::install` 送进废纸篓——生产用真实系统废纸篓
    // (`fsops::SYSTEM_TRASH`),测试必须注入 `SandboxTrash`,否则会把测试产物
    // 丢进这台机器真实的系统废纸篓(v6 二期任务 2)。
    trasher: &dyn fsops::Trasher,
    progress: ProgressSink<'_>,
) -> Result<AcquireOutcome, AppError> {
    // 这段期间的文件事件不上报(审查修复轮 1 I-4 订正措辞:`Installer::install`
    // 已经不是"清空重建"——写入顺序是 staging → 旧本体进废纸篓 → rename,
    // 落盘期间旧内容原样健在;但"旧本体进废纸篓"与"新内容 rename 进来"之间仍有
    // 一个目标路径不存在的瞬间)。监听器若在此时触发,前端会拿到一个技能凭空消失
    // 的瞬间(见 core::watcher 模块头)。
    let _quiet = crate::core::watcher::app_write();

    // `Installer::install` 会把 staging(哪怕是空的)rename 到本体位置,旧本体在那之前
    // 已经被送进废纸篓——空 payload 会让"技能还在列表里,装完却是个空壳"这句话成真
    // (旧内容仍可从废纸篓找回,但界面上看到的是个空壳)——宁可在这里报错拦下。
    //
    // 说明:zipball 路径走到这里 payload 理论上不可能为空——索引是从同一份压缩包的
    // 文本树建的,发现到 SKILL.md 就意味着 entries 里也有它(tree ⊂ entries);
    // blob 路径同样不可能为空——`blob_install_candidate` 已经确认过响应里有
    // `SKILL.md`。留着这道检查是因为它守的是"用空内容替换掉本体"这个破坏性动作,
    // 两条路径各自唯一可能让它触发的原因(前者 prefix 拼错、后者上游响应形状突变)
    // 都另有各自的单测直接钉住。
    if payload.is_empty() {
        return Err(AppError::new(
            "REPO_EMPTY_SKILL",
            "这个技能在该技能库里是空的,请联系它的维护者",
        )
        .with_detail(format!("empty payload for {}", skill.path)));
    }

    progress(Stage::Checking);
    let installer = Installer::new(registry, env).with_trasher(trasher);
    let loaded = store.load_state()?;
    // 「我是谁」读 config 就够,不打网络(v6 任务 1 起登录时就落了盘)。
    // **读不出来一律上报,绝不降级成 `me = None`**:那等于在读不到配置的环境里
    // 悄悄把作者又变回外人——正是本任务要消灭的缺陷从侧门回来,而且没有任何测试
    // 走得到。上面的 `load_state` 本来就会因同一类故障中断获取,这里不新增故障面。
    let config = store.load_config()?;
    let me = config.value.identities.get(req.source.registry_id);
    let author = skill.attribution.as_ref().map(|a| a.author.as_str());
    let ctx = PrecheckContext {
        me,
        author,
        remote_content_hash: Some(skill.content_hash.as_str()),
    };
    // 本体「实际住在哪」。precheck 内部也会 locate 一次(它是独立可调的公开 API,
    // 不该反过来要求调用方先喂给它一个 `Located`),这里再算一次是为了拿到
    // `others`——同名、内容与本体相同的其余实体副本,装完要收成链接。
    let located = crate::core::converge::locate(&installer, registry, env, &loaded.value, req.dir_slug)?;
    let (existing_body, others) = match located {
        // 账上记着本体、目录却已经不在磁盘上时,`body` 不是一个可用的落点
        // ——退回 `home_of`(与 precheck 的 `Fresh` 早退同一个判据)。
        crate::core::converge::Located::Body { body, others } if body.is_dir() => (Some(body), others),
        _ => (None, Vec::new()),
    };
    // 与 precheck 里那次是同一个判定实现(`is_mine` → `ownership::relation`),
    // 但问的不是同一件事:precheck 用它挑档位(只在本地已有一份实体时才问),
    // 这里用它决定要不要给 `state.shared` 建内容基线——**换电脑那一档走的是
    // `Fresh`**(这台电脑上什么都没有),压根不经过 Mine 的折叠,而它恰恰是
    // 这条基线最需要从无到有建起来的场景。
    let mine = is_mine(&ctx, existing_body.is_some());
    let checked = precheck(
        &installer,
        registry,
        env,
        &loaded.value,
        req.dir_slug,
        remote_sha,
        Some(req.repo),
        ctx,
    )?;

    // 多份分歧版本:`Resolution` 的两档(保留本地 / 用远端覆盖)都回答不了
    // "留哪一份",所以这一档**无视 resolution**,恒退回让用户先去
    // `converge::keep_version` 拍板。磁盘零写入。
    if matches!(checked, Precheck::NeedsVersionChoice { .. }) {
        return Ok(AcquireOutcome::NeedsDecision { precheck: checked });
    }

    // 需要用户拍板的情况:改过本体、装自另一个技能库、本地那份与库里不同,
    // 或者「我分享的」技能两边都新。此时不动磁盘。
    let needs_decision = matches!(
        checked,
        Precheck::LocallyModified { .. }
            | Precheck::OtherLibrary { .. }
            | Precheck::LocalDiffers { .. }
            | Precheck::Mine {
                local_changed: true,
                ..
            }
    );
    if needs_decision && req.resolution.is_none() {
        return Ok(AcquireOutcome::NeedsDecision { precheck: checked });
    }

    // 「我分享的」+ 以本地为准:什么都不做。本体是作者手上的最新版,覆盖它就是丢改动;
    // 也不补建关联——这条路的下一步是「分享更新」,不是安装。
    if let Precheck::Mine { remote_changed, .. } = checked {
        if req.resolution == Some(Resolution::KeepLocal) {
            return Ok(AcquireOutcome::Kept { remote_changed });
        }
    }
    // 本地那一份与库里不同 + 保留本地:与上面同一个出口。**不补建关联**——
    // 这一档没有任何记账,补了链接却没有账,移除时谁也摘不掉它们
    // (`remove::remove` 只按 `state.links` 摘链)。要建关联走「勾选工具」
    // (`converge::set_agents`),那条路自己会建账。
    // `remote_changed: true` 是这一档的定义:库里那一版与本地这一份内容不同。
    if matches!(checked, Precheck::LocalDiffers { .. }) && req.resolution == Some(Resolution::KeepLocal) {
        return Ok(AcquireOutcome::Kept { remote_changed: true });
    }

    // 本体位置:本地已有一份实体就装在**同一位置**(本体永不搬家);
    // 否则落回账上记的位置,再否则是 canonical。
    let home = match &existing_body {
        Some(body) => installer.home(req.dir_slug, Some(body))?,
        None => crate::core::converge::home_of(&installer, &loaded.value, req.dir_slug)?,
    };

    // 保留本地:只补建链接,绝不碰本体。
    let keep_local = needs_decision && req.resolution == Some(Resolution::KeepLocal);
    // 本地那一份与库里逐字节相同:装 = 记账 + 建链,**本体一个字节都不写**。
    let already_here = matches!(checked, Precheck::AlreadyHere { .. });

    let mut report = if keep_local || already_here {
        progress(Stage::Linking);
        installer.link_only(&home, req.agent_names)?
    } else {
        progress(Stage::Writing);
        // agent 目录那侧的实体目录占位是另一回事:保持 Fail,由 converge 在下面
        // 逐个按内容判定——同内容进废纸篓换链接(无损、可逆),内容不同一个字节都不动。
        //
        // install() 内部是"先写后链"一气呵成,编排层插不进中间那一刻。报 Linking 是因为
        // 落盘之后紧接着就是建链——少报一个阶段会让进度条从写入直接跳到记账。
        let report = installer.install(&home, &payload, req.agent_names)?;
        progress(Stage::Linking);
        report
    };

    // 其余同名实体副本收成链接。**放在落盘之后**:落盘之前它们与旧本体相同、
    // 之后与新本体不同,`converge` 会如实报 `Differs` 并一个字节都不动
    // ——那正是要的(用户没为这些副本拍过板)。`AlreadyHere` 那一档没有落盘,
    // 副本与本体仍然逐字节相同,于是会被静默收成链接。
    //
    // 🔴 **不用 `?`**:这里已经在写盘窗口内(install/link_only 之后、`record`
    // 之前),中断会让"磁盘已动、账未存"——每处结果并进 `report.links`,由
    // `active_accounting` 一并记账,失败的那条按既有口径不记(见 `link_mode`)。
    merge_converged_others(&installer, registry, env, &home, &others, &mut report);

    progress(Stage::Recording);
    // 记进账的 agents 还要加上**本体所在那个工具**:它读的就是本体自己,
    // `link_targets_for` 有意跳过它(对着自己建链接毫无意义),于是它永远不会
    // 出现在 `report.links` 里——只看 links 的话,把技能装进 `~/.claude/skills`
    // 的用户会看到 claude-code 没被勾上。本体落在 canonical 时这一项与
    // `canonical_visible_agents` 恰好等价,不改变任何既有安装的记账。
    let mut extra_agents = installer.canonical_visible_agents(req.agent_names)?;
    extra_agents.extend(
        body_agents(registry, env, &home)
            .into_iter()
            .filter(|a| req.agent_names.contains(a)),
    );
    let origin = if already_here {
        state::ORIGIN_ADOPTED
    } else {
        ORIGIN_ACQUIRED
    };
    let lock = record(
        store,
        env,
        &loaded.value,
        &report,
        &home,
        skill,
        req,
        remote_sha,
        now,
        keep_local,
        mine,
        extra_agents,
        origin,
    )?;

    progress(Stage::Done);
    Ok(AcquireOutcome::Installed {
        report,
        local_kept: keep_local,
        lock,
    })
}

/// 本体所在那个工具目录对应的 agent 名单(可能不止一个:多个工具共用同一个
/// 全局技能目录是常态)。
fn body_agents(
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    home: &crate::core::installer::SkillHome,
) -> Vec<String> {
    home.body
        .parent()
        .and_then(|dir| registry.group_by_global_dir(env).get(dir).cloned())
        .unwrap_or_default()
}

/// 把「其余同名实体副本」逐个收成指向本体的链接,结果并进安装报告。
///
/// 只有 `Converged::Linked`(确实建成了)与 `Err`(试过但没成功)会进报告:
/// `Unchanged`/`SameLocation`/`Differs` 都不产生一条"本次建立的关联"
/// ——`Differs` 尤其不能记,它的定义就是**一个字节都没动**。
///
/// 同一个目录在 `report.links` 里已有条目时**覆盖那一条,不追加**:安装时
/// `link_dir` 撞上占位会记一条 `Failed`,收敛成功之后那条已经不是事实了,
/// 两条都留着会让 `active_accounting` 给同一个目录记出两条 `LinkRecord`。
fn merge_converged_others(
    installer: &Installer<'_>,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    home: &crate::core::installer::SkillHome,
    others: &[std::path::PathBuf],
    report: &mut InstallReport,
) {
    use crate::core::converge::Converged;
    use crate::core::installer::{LinkReport, LinkResult};
    let grouped = registry.group_by_global_dir(env);
    for other in others {
        // 不必再判 `other == home.body`:`locate` 给出的 `others` 已经排除了 body,
        // 而 `converge` 自己还有 `SameLocation` 早退。同一条规则查三遍是本项目的
        // 空转模式 ①,多余的闸会吞掉注入信号(修复轮 1,M-7)。
        let Some(dir) = other.parent() else { continue };
        let result = match crate::core::converge::converge(installer, other, &home.body) {
            Ok(Converged::Linked { mode }) => LinkResult::Linked { mode },
            Ok(Converged::Unchanged | Converged::SameLocation | Converged::Differs { .. }) => continue,
            Err(error) => LinkResult::Failed { error },
        };
        let dir_label = dir.to_string_lossy().into_owned();
        match report
            .links
            .iter_mut()
            .find(|l| std::path::Path::new(&l.dir) == dir)
        {
            Some(existing) => existing.result = result,
            None => report.links.push(LinkReport {
                dir: dir_label,
                agents: grouped.get(dir).cloned().unwrap_or_default(),
                result,
            }),
        }
    }
}

// ============================================================ 批量获取(向导)

/// 批量结果里单个技能的结局。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum BatchOutcome {
    Installed { report: InstallReport },
    /// 没装,但不是错误:原因是给用户看的一句话。
    Skipped { reason: String },
    Failed { error: AppError },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub dir_slug: String,
    #[serde(flatten)]
    pub outcome: BatchOutcome,
}

/// 批量安装/更新时,每个技能的链接目标从哪来。
#[derive(Debug, Clone, Copy)]
pub enum BatchAgents<'a> {
    /// 统一列表(首次启动向导:全新环境,所有技能关联同一批工具)。
    Uniform(&'a [String]),
    /// 各技能用**自己账上的** agents(定时更新:自动流程绝不改写用户的关联)。
    /// 不在账上的技能一律跳过——这一档只服务"更新已装的",不服务"装新的"。
    FromAccount,
}

/// 一次下载装多个技能(首次启动向导的"一键全装",与 scheduler 的批量更新)。
///
/// 与逐个 [`acquire`] 的关键差异:**冲突不弹窗,一律跳过**。向导面向刚装上 app 的
/// 用户,真撞上"改过/被占用"说明那不是全新环境——跳过并说明,比在向导里
/// 展开三选弹窗要诚实也要轻。单个技能失败不中断其余。
#[allow(clippy::too_many_arguments)]
pub async fn acquire_batch(
    client: &impl RepoSource,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    source: SourceMeta<'_>,
    repo: &RepoRef,
    dir_slugs: &[String],
    agents: BatchAgents<'_>,
    now: &str,
    fetched_at: i64,
    // 同 `acquire`/`finish`:更新覆盖旧本体会经它进废纸篓,测试必须注入
    // `SandboxTrash`(v6 二期任务 2)。
    trasher: &dyn fsops::Trasher,
) -> Result<Vec<BatchItem>, AppError> {
    // 这段期间的文件事件不上报:`Installer::install` 的写入顺序是
    // staging → 旧本体进废纸篓 → rename,"旧本体进废纸篓"与"新内容 rename 进来"
    // 之间仍有一个目标路径不存在的瞬间,监听器若在此时触发,前端会拿到一个技能
    // 凭空消失的瞬间(见 core::watcher 模块头)。
    let _quiet = crate::core::watcher::app_write();
    let head = client.branch_head(repo).await?;
    let archive = client.download_archive(repo).await?;
    let index = store_index::build_index(source.registry_id, repo, &head, &archive, fetched_at);
    let cache = store_index::cache_path(store.dir(), source.registry_id, repo);
    if let Err(err) = store_index::save_cache(&cache, &index) {
        eprintln!("[acquire] 刷新索引缓存失败(不影响安装): {err}");
    }

    let installer = Installer::new(registry, env).with_trasher(trasher);
    // 身份读一次就够:整批共用同一个 (源, 库),`identities` 是按 registryId 存的。
    let config = store.load_config()?;
    let me = config.value.identities.get(source.registry_id);
    let mut out = Vec::new();
    for dir_slug in dir_slugs {
        let item = install_one_from_archive(
            &installer,
            registry,
            env,
            store,
            source,
            repo,
            &index,
            &archive,
            &head.sha,
            dir_slug,
            agents,
            me,
            now,
        );
        out.push(BatchItem {
            dir_slug: dir_slug.clone(),
            outcome: item,
        });
    }
    Ok(out)
}

/// 批量里的单个技能:预检 → 落盘 → 记账。任何一步不顺都折成结果,不向上抛。
#[allow(clippy::too_many_arguments)]
fn install_one_from_archive(
    installer: &Installer<'_>,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    source: SourceMeta<'_>,
    repo: &RepoRef,
    index: &store_index::StoreIndex,
    archive: &RepoArchive,
    head_sha: &str,
    dir_slug: &str,
    agents: BatchAgents<'_>,
    me: Option<&Identity>,
    now: &str,
) -> BatchOutcome {
    let Some(skill) = index.skills.iter().find(|s| s.dir_slug == dir_slug) else {
        return BatchOutcome::Skipped {
            reason: "已不在该技能库中".into(),
        };
    };
    let ctx = PrecheckContext {
        me,
        author: skill.attribution.as_ref().map(|a| a.author.as_str()),
        remote_content_hash: Some(skill.content_hash.as_str()),
    };

    // 每轮重新读 state:上一轮的记账已经写回,拿旧快照会互相覆盖
    let run = || -> Result<BatchOutcome, AppError> {
        let loaded = store.load_state()?;
        // 查账键是**清洗后**的目录名,不是 `dir_slug`(见 `converge::record_key`)。
        let key = crate::core::converge::record_key(installer, dir_slug)?;
        let located = crate::core::converge::locate(installer, registry, env, &loaded.value, dir_slug)?;
        let (existing_body, others) = match located {
            crate::core::converge::Located::Body { body, others } if body.is_dir() => (Some(body), others),
            _ => (None, Vec::new()),
        };
        // 与逐个安装同一份判定:向导在新机器上一键全装,对「我分享的」技能同样要建
        // 分享基线(那正是换电脑场景)。同一件事在两个入口给两种结果是本项目栽过的跟头。
        let mine = is_mine(&ctx, existing_body.is_some());

        // 链接目标:向导给统一列表;定时更新用账上的,绝不改写用户的关联
        let agent_names: Vec<String> = match agents {
            BatchAgents::Uniform(list) => list.to_vec(),
            BatchAgents::FromAccount => {
                let Some(record) = loaded.value.installed.iter().find(|s| s.name == key) else {
                    return Ok(BatchOutcome::Skipped {
                        reason: "未安装,已跳过".into(),
                    });
                };
                record.agents.clone()
            }
        };
        let agent_names = agent_names.as_slice();

        let checked = precheck(installer, registry, env, &loaded.value, dir_slug, head_sha, Some(repo), ctx)?;
        match &checked {
            // 自动流程绝不覆盖作者本地的内容(设计文档「不做」一节:scheduler 仍只管
            // 「我安装的」)。两边都新时该弹的拍板弹窗在批量流程里没有位置,
            // 而"库新本地没改"这一档虽然覆盖是安全的,自动替作者更新他自己的技能
            // 仍然越界——统一跳过,把动作留给他在「我的技能」上自己点。
            Precheck::Mine { .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: "这是你分享的技能,不自动覆盖".into(),
                })
            }
            Precheck::LocallyModified { .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: "已安装且有你的本地改动,未覆盖".into(),
                })
            }
            // 本地已有一份内容不同的实体:该走两选(用库里的 / 保留本地),
            // 而批量流程按定义不弹拍板——跳过并说人话。
            Precheck::LocalDiffers { .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: "这台电脑上已有一份内容不同的同名技能,未替换".into(),
                })
            }
            // 同名技能在多处各有一份、内容还不一样:先让用户拍板留哪份,
            // 自动流程不替他挑。
            Precheck::NeedsVersionChoice { .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: "这台电脑上有好几份内容不同的同名技能,请先选留哪一份".into(),
                })
            }
            // 同名但装自另一个技能库:批量流程一律跳过并说人话
            // (定时更新绝不替换用户的技能,向导也不该拿别的库覆盖已装的)
            Precheck::OtherLibrary { source_owner, source_repo, .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: format!("同名技能已从 {source_owner}/{source_repo} 获取,未替换"),
                })
            }
            Precheck::Managed { up_to_date: true, .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: "已安装,且是最新版本".into(),
                })
            }
            // 本地已有一份、且与库里逐字节相同:记账 + 建链就够,一个字节都不写。
            Precheck::AlreadyHere { .. } | Precheck::Fresh | Precheck::Managed { .. } => {}
        }

        let already_here = matches!(checked, Precheck::AlreadyHere { .. });
        let home = match &existing_body {
            Some(body) => installer.home(dir_slug, Some(body))?,
            None => crate::core::converge::home_of(installer, &loaded.value, dir_slug)?,
        };

        let payload = extract_payload(archive, skill);
        if payload.is_empty() {
            return Err(AppError::new(
                "REPO_EMPTY_SKILL",
                "这个技能在该技能库里是空的,请联系它的维护者",
            ));
        }
        let mut report = if already_here {
            installer.link_only(&home, agent_names)?
        } else {
            installer.install(&home, &payload, agent_names)?
        };
        merge_converged_others(installer, registry, env, &home, &others, &mut report);
        let mut extra_agents = installer.canonical_visible_agents(agent_names)?;
        extra_agents.extend(
            body_agents(registry, env, &home)
                .into_iter()
                .filter(|a| agent_names.contains(a)),
        );
        record(
            store,
            env,
            &loaded.value,
            &report,
            &home,
            skill,
            AcquireRequest {
                source,
                repo,
                dir_slug,
                agent_names,
                resolution: None,
            },
            head_sha,
            now,
            false,
            mine,
            extra_agents,
            if already_here {
                state::ORIGIN_ADOPTED
            } else {
                ORIGIN_ACQUIRED
            },
        )?;
        Ok(BatchOutcome::Installed { report })
    };
    run().unwrap_or_else(|error| BatchOutcome::Failed { error })
}

/// 写 `state.json` 并双写 `.skill-lock.json`。
#[allow(clippy::too_many_arguments)]
fn record(
    store: &Store,
    env: &dyn AgentEnv,
    previous: &state::State,
    report: &InstallReport,
    home: &crate::core::installer::SkillHome,
    skill: &IndexedSkill,
    req: AcquireRequest<'_>,
    remote_sha: &str,
    now: &str,
    keep_local: bool,
    // 技能库里记的分享者就是当前登录的这个人(见 `is_mine`)。
    mine: bool,
    // 不经由 `report.links` 表达、但技能确实对其生效的 agent:落在 canonical
    // 就能读到的那些(universal),以及**本体所在那个工具**(见 `finish`)。
    extra_agents: Vec<String>,
    // `ORIGIN_ACQUIRED` 或 `state::ORIGIN_ADOPTED`。纯留痕,不驱动任何判定。
    origin: &str,
) -> Result<String, AppError> {
    let mut next = previous.clone();
    let existing = next.installed.iter().position(|s| s.name == report.dir_name);

    // 内容 hash 必须从**落盘后的本体目录**算,而不是从 payload 算:
    // dir_content_hash 有自己的排除清单,口径必须与它一致,否则刚装完就被判成
    // "用户改过",更新流程会永远停在冲突提示上。
    //
    // 🔴 算的是 `home.body` 不是 `report.canonical_dir`(v6 二期任务 4):本体
    // 住在工具目录里时,canonical 是一条**链接**,对着它算等于隔着链接去读——
    // 而 `precheck` 比对的那一侧算的是 body。两侧口径必须是同一个。
    let content_hash = fsops::dir_content_hash(&home.body)?;
    // 本体就住在 canonical 时不记 body(既有 `state.json` 的形状一个字不变);
    // 住在别处才记——那是"本体永不搬家"这条承诺唯一的落点。
    let body_record = (!home.body_is_canonical()).then(|| home.body.to_string_lossy().into_owned());

    let (links, agents) = active_accounting(report, extra_agents);

    match existing {
        Some(idx) => {
            let record = &mut next.installed[idx];
            record.body = body_record;
            record.agents = agents;
            record.links = links;
            record.updated_at = now.to_string();
            // 保留本地改动:关于**内容**的字段一个都不动。
            // commitSha 保持旧值 → "有可用更新"仍然成立;
            // contentHash 保持安装时的值 → "有未分享的改动"仍然成立。
            // 这两个标记就是分享流程找到这条记录的依据,更新了就等于把它藏起来。
            if !keep_local {
                record.source = source_of(&req, skill, remote_sha);
                record.commit_sha = remote_sha.to_string();
                record.content_hash = content_hash;
            }
        }
        None => next.installed.push(InstalledSkill {
            name: report.dir_name.clone(),
            source: source_of(&req, skill, remote_sha),
            commit_sha: remote_sha.to_string(),
            content_hash,
            origin: Some(origin.to_string()),
            body: body_record,
            agents,
            links,
            installed_at: now.to_string(),
            updated_at: now.to_string(),
        }),
    }

    if mine && !keep_local {
        seed_shared_baseline(&mut next, report, home, skill, &req, remote_sha);
    }

    store.save_state(&next)?;

    // 双写外部契约。任何结果都不阻断——技能已经装好了,记账失败只该记日志。
    let outcome = match skill_lock::lock_path(env) {
        None => LockOutcome::Skipped {
            reason: "找不到 lock 文件落点".into(),
        },
        Some(path) => skill_lock::upsert(
            &path,
            // 键用**清洗后的目录名**,与 canonical 目录名同一个值
            &report.dir_name,
            &LockEntry {
                source: format!("{}/{}", req.repo.owner, req.repo.repo),
                source_type: req.source.kind.to_string(),
                source_url: req.source.source_url(req.repo),
                git_ref: Some(req.repo.branch.clone()),
                skill_path: Some(skill.path.clone()),
                // 非 GitHub 源填空串——上游对 well-known 源就是这么填的(add.ts:916)
                skill_folder_hash: String::new(),
            },
            now,
        ),
    };
    Ok(match outcome {
        LockOutcome::Written => "written".into(),
        LockOutcome::Skipped { reason } => {
            eprintln!("[acquire] 跳过 lock 双写: {reason}");
            "skipped".into()
        }
        LockOutcome::Failed { reason } => {
            eprintln!("[acquire] lock 双写失败: {reason}");
            "failed".into()
        }
    })
}

/// 「我分享的」技能装完之后,把 `state.shared` 的内容基线对齐到刚落盘的这一版。
///
/// `state.shared[].content_hash` 是「有改动未分享」唯一的判据(与当前目录实际 hash
/// 不符即有未分享的改动)。**换电脑 / app 数据丢了之后重新取回,本地一条 shared 都
/// 没有**——不建这条基线,作者回到自己的技能上永远看不出"改了没有"。
///
/// 🔴 **不能只在 [`Precheck::Mine`] 那一档做**:换电脑那一档 canonical 上什么都没有,
/// 走的是 `Fresh`,根本不经过 Mine 的折叠。判据因此是 [`is_mine`](与档位无关),
/// 而 `Fresh` 恰恰是这条基线最需要从无到有建起来的场景。
///
/// 已有条目时**只对齐内容基线,不动 `last_pushed_sha`**:那个字段记的是"上次分享
/// 推上去的那一版",这次是取回不是分享,改了就是假话。
fn seed_shared_baseline(
    next: &mut state::State,
    report: &InstallReport,
    home: &crate::core::installer::SkillHome,
    skill: &IndexedSkill,
    req: &AcquireRequest<'_>,
    remote_sha: &str,
) {
    // 内容基线必须与 `share.rs` 同口径:从落盘后的**本体**目录现算
    // (v6 二期起本体不一定在 canonical,理由同 `record` 里那段)。
    // 算不出来(目录刚被别的进程动了)就不记——宁可没有基线,也不记一个错的:
    // 错的基线会让界面长期显示一个假的「有改动未分享」。
    let Ok(content_hash) = fsops::dir_content_hash(&home.body) else {
        tracing::warn!(dir = %report.dir_name, "算不出内容指纹,本次不建分享基线");
        return;
    };
    let target = SkillSource {
        registry_id: req.source.registry_id.to_string(),
        owner: req.repo.owner.clone(),
        repo: req.repo.repo.clone(),
        path: skill.path.clone(),
        git_ref: req.repo.branch.clone(),
    };
    // 🔴 **`state.shared` 的钥匙只有一把:本体路径,按 `Path` 比**
    //   (v6 二期任务 6 修复轮 2,R26)。三处现在完全一致:
    //   - 本函数(取回时对齐内容基线);
    //   - `share::share`(分享时写记账);
    //   - `share::candidate`(读"分享过没有、改动过没有")。
    //
    // ⚠️ **这里原先按 `name` 定位,那不只是"口径不齐",在存量数据上是个真缺陷**:
    // 任务 6 之前 `share::share` 写记账用的是**远端名**,而当时那套(已被推翻的)
    // 中文名分享策略**明确允许远端名 ≠ 本地文件夹名** —— 所以用户的 `state.json`
    // 里**现在就可能存在** `name != leaf(local_path)` 的行。按 `name` 找不到它,
    // 就会 push 出**第二条 `local_path` 相同**的记账;而 `share::candidate` 用的是
    // `find`(取第一条),于是界面从此一直读那条**旧的、`content_hash` 已过期的**行,
    // 永远显示"有未分享的改动"。这正是 CLAUDE.md 记着的"读写双键不一致"隐患
    // 在存量数据里的翻版(护栏:`acquire_flow::
    // a_legacy_row_whose_name_differs_from_its_path_is_updated_in_place`)。
    //
    // **为什么按 `local_path` 比按 `name` 更对(不只是"统一")**:`content_hash` 是
    // 从**某个目录**算出来的指纹,它的身份就是那个目录。一条 `local_path` 指向别处的
    // 记账说的是另一个目录的事,拿本目录的 hash 去覆盖它就是在替那个目录撒谎。
    // 反过来,同名不同目录的两行各自成立,`name` 重复无害
    // ——真正有害的是 `local_path` 重复,而按 `local_path` 定位从根上消灭它。
    let local_path = home.body.to_string_lossy().into_owned();
    match next
        .shared
        .iter()
        .position(|s| Path::new(&s.local_path) == home.body.as_path())
    {
        Some(idx) => {
            next.shared[idx].local_path = local_path;
            next.shared[idx].target = target;
            next.shared[idx].content_hash = content_hash;
        }
        None => next.shared.push(state::SharedSkill {
            name: report.dir_name.clone(),
            local_path,
            // 文件是用户自己的技能,不是别的工具装的
            origin: "local".to_string(),
            target,
            last_pushed_sha: remote_sha.to_string(),
            content_hash,
        }),
    }
}

/// 从建链报告推导 state 记账:`links` 只记成功建立的,`agents` 是技能**实际对哪些工具生效**。
///
/// 两者必须讲同一件事:成功建链的 + 落在 canonical 就能读到、无需建链的(universal)。
/// 早先直接把 report.links 里的 agents 全收下来,同时错两头——
/// 建链失败的被记成已生效(界面会把它画成启用中),universal 的又被整个漏掉。
fn active_accounting(
    report: &InstallReport,
    extra_agents: Vec<String>,
) -> (Vec<LinkRecord>, Vec<String>) {
    let links: Vec<LinkRecord> = report
        .links
        .iter()
        .filter_map(|l| link_mode(l).map(|mode| LinkRecord { dir: l.dir.clone(), mode }))
        .collect();
    let mut agents: Vec<String> = report
        .links
        .iter()
        .filter(|l| link_mode(l).is_some())
        .flat_map(|l| l.agents.clone())
        .collect();
    agents.extend(extra_agents);
    agents.sort();
    agents.dedup();
    (links, agents)
}

// v6 二期任务 4:`repair_links` / `link_agents` 已删除。
//
// 「修复关联」作为一个独立按钮的概念被整体取消——用户看到某个工具的勾异常时,
// 唯一要做的动作就是再点一次那个勾,自愈落在 `converge::set_agents`(它对
// `wanted` 里**每一个**目标都跑一次幂等的 `converge`,不是只处理新增的差集)。
// 那条路同时消掉了这两个函数各自带的 `replace_occupied` 布尔开关:占位目录该不该
// 替换,由 `converge` 先比内容再决定(同→进废纸篓换链接、异→停下问用户),
// 不再由调用方传一个裸的"是/否"。

fn source_of(req: &AcquireRequest<'_>, skill: &IndexedSkill, sha: &str) -> SkillSource {
    SkillSource {
        registry_id: req.source.registry_id.to_string(),
        owner: req.repo.owner.clone(),
        repo: req.repo.repo.clone(),
        path: skill.path.clone(),
        git_ref: sha.to_string(),
    }
}

/// 从建链结果里取出该记账的 mode。失败与"同一位置"都不记——记了卸载时会去动不该动的目录。
fn link_mode(report: &crate::core::installer::LinkReport) -> Option<String> {
    use crate::core::installer::LinkResult;
    match &report.result {
        LinkResult::Linked { mode } | LinkResult::Unchanged { mode } => Some(mode.clone()),
        LinkResult::SameLocation | LinkResult::Failed { .. } => None,
    }
}

/// 找"这个技能属于哪个已配置的技能库"时要看的全部坐标。
///
/// **内建源必须单独传**:它锁定且不落 `config.registries`(坐标是编译期常量),
/// 光传 `config.registries` 的话公司库来的技能永远绑不上——M3 起认领对主线场景
/// 从来没生效过,根因就是这里少了一份坐标(M6 任务 4 修)。
///
/// **广场同理必须单独传**(M9 任务 2):它也锁定、也不落 `config.registries`
/// (坐标是 `registry::PLAZA_REGISTRY_ID` / `registry::PLAZA_BASE_URL` 常量),
/// 与内建源是完全同款的"对 config 枚举不可见"陷阱——这正是本任务要堵的口子。
pub struct BindingSources<'a> {
    pub builtin_base_url: Option<&'a str>,
    pub builtin_repo: Option<(&'a str, &'a str)>,
    /// 内建源的追加库(M4 任务 1,落在 `config.builtinExtraRepos`)。
    pub builtin_extra: &'a [state::RepoConfig],
    pub custom: &'a [state::RegistryConfig],
    /// 广场上用户接触过的技能库(`config.plazaRepos`)。广场没有主仓,
    /// 因此不像内建源那样另有一对 `plaza_base_url`/`plaza_repo`——
    /// 访问坐标固定是 `registry::PLAZA_BASE_URL`,不需要参数化。
    pub plaza_repos: &'a [state::RepoConfig],
}

/// 一个候选库:`(源 id, 源地址, owner, repo)`。
type Candidate<'a> = (&'a str, &'a str, &'a str, &'a str);

impl BindingSources<'_> {
    /// 摊平成候选库清单,内建、自定义、广场一视同仁。
    fn candidates(&self) -> Vec<Candidate<'_>> {
        let mut out: Vec<Candidate<'_>> = Vec::new();
        if let (Some(base), Some((o, r))) = (self.builtin_base_url, self.builtin_repo) {
            out.push((crate::core::registry::BUILTIN_REGISTRY_ID, base, o, r));
            for c in self.builtin_extra {
                out.push((
                    crate::core::registry::BUILTIN_REGISTRY_ID,
                    base,
                    &c.owner,
                    &c.repo,
                ));
            }
        }
        for reg in self.custom {
            for c in &reg.repos {
                out.push((&reg.id, &reg.base_url, &c.owner, &c.repo));
            }
        }
        for c in self.plaza_repos {
            out.push((
                crate::core::registry::PLAZA_REGISTRY_ID,
                crate::core::registry::PLAZA_BASE_URL,
                &c.owner,
                &c.repo,
            ));
        }
        out
    }
}

/// 上游来源与已配置源的对应关系。
///
/// **`NoSource` 与 `RepoNotListed` 是两句不同的话**:后者来源好好的,只是这个技能库
/// 不在它的列表里,说成"来源没了"会让用户去找一个根本没丢的东西
/// (`commands::source_state` 早就踩过同一个坑)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum SourceBinding {
    /// 绑得上:更新与「分享改动」都有去处。
    Bound {
        registry_id: String,
        owner: String,
        repo: String,
    },
    /// 没有能对上的来源(一个源都没配 / 不同源 / 来源类型无从判定)。
    NoSource,
    /// 有同源的来源,但这个技能库不在它的库列表里。
    RepoNotListed,
}

/// 绑定解析的唯一实现。返回 `(结论, owner, repo)`——owner/repo 无论绑不绑得上都要留,
/// 界面靠它显示"这个技能来自哪里"。
///
/// 两条判据,按可信度排序:
/// 1. **`sourceUrl` 是 URL** → 要求同源 + 这个库在该源的库列表里(M4 任务 1 的老规矩:
///    同源还不够,源里没有这个库时更新只会去主库找同名技能——找不到就报错,
///    找到就装错内容)。
/// 2. **`sourceUrl` 不是 URL** → 只能按 `owner/repo` 找,**唯一命中才绑**。
///    本 app 自己写的 lock 条目就是这一档(`sourceUrl` 存的是 `"owner/repo"`)。
///    多个源都有同名库时绑谁都是猜,宁可不绑——与"任一侧指纹缺失按没有更新处理"同一姿态。
///
/// 参数是 `(source, source_url)` 而不是某一种 lock 条目:全局 lock(v3)与项目级
/// `skills-lock.json`(v1)是两份不同的契约,但"这个来源对应哪个已配置源"这件事
/// 两边**必须是同一把尺子**——各写一份正是 M6「认领对主线场景从来没生效过」那类
/// 静默失效的温床。项目级的调用方见 [`crate::core::project::update_target`]。
pub fn resolve_binding_of(
    source: &str,
    source_url: &str,
    sources: &BindingSources,
) -> (SourceBinding, String, String) {
    let (owner, repo) = source
        .split_once('/')
        .map(|(o, r)| (o.to_string(), r.to_string()))
        .unwrap_or_else(|| (source.to_string(), String::new()));
    let bound = |id: &str| {
        (
            SourceBinding::Bound {
                registry_id: id.to_string(),
                owner: owner.clone(),
                repo: repo.clone(),
            },
            owner.clone(),
            repo.clone(),
        )
    };
    let candidates = sources.candidates();

    if url::Url::parse(source_url).is_ok() {
        let same_origin: Vec<&Candidate> = candidates
            .iter()
            .filter(|(_, base, _, _)| crate::core::gitea::is_same_origin(base, source_url))
            .collect();
        if let Some((id, _, _, _)) = same_origin
            .iter()
            .find(|(_, _, o, r)| *o == owner && *r == repo)
        {
            return bound(id);
        }
        // 源好好的,只是这个技能库不在它的列表里——与"没有来源"是两句不同的话
        if !same_origin.is_empty() {
            return (SourceBinding::RepoNotListed, owner, repo);
        }
        return (SourceBinding::NoSource, owner, repo);
    }

    let mut hits = candidates.iter().filter(|(_, _, o, r)| *o == owner && *r == repo);
    match (hits.next(), hits.next()) {
        (Some((id, _, _, _)), None) => bound(id),
        _ => (SourceBinding::NoSource, owner, repo),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::gitea::ArchiveEntry;
    use crate::core::skills::MemTree;
    use crate::core::store::SkillFile;

    fn skill(path: &str) -> IndexedSkill {
        IndexedSkill {
            name: "周报生成".into(),
            dir_slug: "weekly-report".into(),
            description: "汇总本周工作".into(),
            path: path.into(),
            skill_md: String::new(),
            files: vec![SkillFile { path: "SKILL.md".into(), size: Some(1) }],
            has_scripts: false,
            content_hash: String::new(),
            tags: Vec::new(),
            attribution: None,
            updated_at: crate::core::store::SkillUpdatedAt::Unknown,
        }
    }

    fn archive(root: &str, files: &[(&str, &[u8], Option<u32>)]) -> RepoArchive {
        let mut entries = std::collections::BTreeMap::new();
        let mut list = Vec::new();
        for (path, bytes, mode) in files {
            entries.insert(
                path.to_string(),
                ArchiveEntry { bytes: bytes.to_vec(), unix_mode: *mode },
            );
            list.push(path.to_string());
        }
        RepoArchive {
            root: root.to_string(),
            tree: MemTree::new(),
            files: list,
            entries,
        }
    }

    /// prefix 拼接是 extract_payload 里唯一可能出错的地方,也是唯一能让上层那道
    /// `is_empty()` 守卫真正触发的原因,所以单独钉住。
    #[test]
    fn extract_payload_takes_only_the_skill_dir_and_strips_the_archive_root() {
        let a = archive(
            "skills",
            &[
                ("skills/skills/weekly-report/SKILL.md", b"md", None),
                ("skills/skills/weekly-report/templates/dept.md", b"tpl", None),
                ("skills/skills/weekly-report/run.sh", b"sh", Some(0o755)),
                // 隔壁技能与仓库根上的文件都不该被卷进来
                ("skills/skills/other-skill/SKILL.md", b"other", None),
                ("skills/README.md", b"readme", None),
            ],
        );

        let payload = extract_payload(&a, &skill("skills/weekly-report"));
        let mut paths: Vec<&String> = payload.files().keys().collect();
        paths.sort();
        assert_eq!(
            paths,
            vec!["SKILL.md", "run.sh", "templates/dept.md"],
            "路径必须相对技能目录,且不含隔壁技能"
        );
        // 可执行位随字节一起带过来
        assert_eq!(payload.files()["run.sh"].unix_mode, Some(0o755));
        assert_eq!(payload.files()["SKILL.md"].unix_mode, None);
    }

    #[test]
    fn extract_payload_is_empty_when_the_path_does_not_match() {
        // 这就是上层 `is_empty()` 守卫存在的理由:prefix 算错时宁可报错,
        // 也不能让 install() 把 canonical 清成空目录。
        let a = archive("skills", &[("skills/skills/weekly-report/SKILL.md", b"md", None)]);
        assert!(extract_payload(&a, &skill("skills/wrong-name")).is_empty());
        assert!(extract_payload(&a, &skill("weekly-report")).is_empty());
    }

    #[test]
    fn extract_payload_handles_an_archive_without_a_root_dir() {
        // GitHub 的压缩包顶层是 `<repo>-<ref>/`,Gitea 是仓库名;理论上也可能没有顶层目录。
        let a = archive("", &[("skills/weekly-report/SKILL.md", b"md", None)]);
        let payload = extract_payload(&a, &skill("skills/weekly-report"));
        assert_eq!(payload.files().keys().collect::<Vec<_>>(), vec!["SKILL.md"]);
    }
}
