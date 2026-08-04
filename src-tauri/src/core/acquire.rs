//! 获取流程编排:下载 → 预检 → 落盘 → 建链 → 记账。
//!
//! 各模块刻意都只管自己那一段:[`crate::core::installer`] 不碰 `state.json`、
//! [`crate::core::store`] 只管索引、[`crate::core::skill_lock`] 是外部契约。
//! 把它们串起来的这段编排放在这里,`commands.rs` 保持薄壳。
//!
//! # 这里是 contentHash 守卫真正生效的地方
//!
//! `Installer::install` 会**无条件清空重建 canonical**(它的文档里写明了)。
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
use crate::core::fsops::{self, OnOccupied};
use crate::core::gitea::{RepoArchive, RepoRef, RepoSource};
use crate::core::installer::{InstallReport, Installer, SkillPayload};
use crate::core::skill_lock::{self, LockEntry, LockOutcome};
use crate::core::state::{self, InstalledSkill, LinkRecord, SkillSource, Store};
use crate::core::store::{self as store_index, IndexedSkill};
use crate::error::AppError;

// ============================================================ 预检

/// canonical 目录当前的状况。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum Precheck {
    /// 没有同名目录,直接装。
    Fresh,
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
    /// 有同名目录但不在本应用的记账里——别的工具装的,或用户自己建的。
    ///
    /// 这一档**没有"你的改动"可分享**,所以默认动作是取消,不是保留后分享。
    Foreign { origin: ForeignOrigin },
}

/// 外来目录的来源。用排除法判定(设计方案 2.5②):能在 npx skills 的 lock 里查到就是它装的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ForeignOrigin {
    /// npx skills 装的,`source` 是它记的原始来源(如 `owner/repo`)。
    NpxSkills { source: String },
    /// 两处记账都查不到,视为用户本地创建。
    Unknown,
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

/// 读磁盘与 state,判断 canonical 上的现状。不写任何东西。
pub fn precheck(
    installer: &Installer,
    env: &dyn AgentEnv,
    state: &state::State,
    dir_slug: &str,
    remote_sha: &str,
    // target:本次请求的目标库。`None` = 调用方不关心来源,跳过库比对。
    target: Option<&RepoRef>,
) -> Result<Precheck, AppError> {
    let canonical = installer.canonical_dir(dir_slug)?;
    if !canonical.exists() {
        return Ok(Precheck::Fresh);
    }

    let dir_name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir_slug.to_string());

    let Some(recorded) = state.installed.iter().find(|s| s.name == dir_name) else {
        return Ok(Precheck::Foreign {
            origin: foreign_origin(env, &dir_name),
        });
    };

    // 来源库不同要**先于**内容比对:用户没改过本体时 hash 照样不等(两个库的同名
    // 技能内容本就不同),落进 Managed 就会被当成一次正常更新静默做掉。
    if let Some(t) = target {
        if recorded.source.owner != t.owner || recorded.source.repo != t.repo {
            return Ok(Precheck::OtherLibrary {
                installed_sha: recorded.commit_sha.clone(),
                source_owner: recorded.source.owner.clone(),
                source_repo: recorded.source.repo.clone(),
            });
        }
    }

    let actual = fsops::dir_content_hash(&canonical)?;
    if actual != recorded.content_hash {
        return Ok(Precheck::LocallyModified {
            installed_sha: recorded.commit_sha.clone(),
        });
    }
    Ok(Precheck::Managed {
        installed_sha: recorded.commit_sha.clone(),
        up_to_date: recorded.commit_sha == remote_sha,
    })
}

/// 查 npx skills 的 lock 判断外来目录的出处。查不到就是"未知来源"。
fn foreign_origin(env: &dyn AgentEnv, dir_name: &str) -> ForeignOrigin {
    let Some(path) = skill_lock::lock_path(env) else {
        return ForeignOrigin::Unknown;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ForeignOrigin::Unknown;
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        return ForeignOrigin::Unknown;
    };
    match doc["skills"][dir_name]["source"].as_str() {
        Some(source) if !source.is_empty() => ForeignOrigin::NpxSkills {
            source: source.to_string(),
        },
        _ => ForeignOrigin::Unknown,
    }
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum AcquireOutcome {
    /// 需要用户先决定怎么处理本地内容。**磁盘一个字节都没动。**
    NeedsDecision { precheck: Precheck },
    Installed {
        report: InstallReport,
        /// 本次保留了用户的本地改动(没有覆盖本体)。
        local_kept: bool,
        /// `.skill-lock.json` 双写的结果。失败或跳过都不影响安装本身。
        lock: String,
    },
}

pub struct AcquireRequest<'a> {
    pub registry_id: &'a str,
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
    progress: ProgressSink<'_>,
) -> Result<AcquireOutcome, AppError> {
    progress(Stage::Fetching);
    // 先问分支头再下载:记账要记**实际装下来的那个版本**。
    // 拿商店缓存里的 sha 去记会在"浏览时是 A、点安装时远端已到 B"的情况下永久记错,
    // 而且错得毫无提示——之后的更新检查全部失灵。
    let head = client.branch_head(req.repo).await?;
    let archive = client.download_archive(req.repo).await?;

    // 压缩包已经在手上,顺带把索引缓存刷新到同一版本:一次下载服务两处。
    let index = store_index::build_index(req.registry_id, req.repo, &head, &archive, fetched_at);
    let cache = store_index::cache_path(store.dir(), req.registry_id, req.repo);
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
                "这个技能已不在公司技能库中,请返回列表刷新后再试",
            )
            .with_detail(format!("dir_slug not in index: {}", req.dir_slug))
        })?;

    let payload = extract_payload(&archive, skill);
    // install() 一进去就 reset_dir。空 payload 会把 canonical 清成空目录,
    // 也就是"技能还在列表里,装完却是个空壳"——宁可报错。
    //
    // 说明:走到这里 payload 理论上不可能为空——索引是从同一份压缩包的文本树建的,
    // 发现到 SKILL.md 就意味着 entries 里也有它(tree ⊂ entries)。留着这道检查是因为
    // 它守的是 `reset_dir` 这个破坏性动作,而**唯一可能让它触发的是 prefix 拼错**
    // ——那条逻辑另有单测(`extract_payload_*`)直接钉住。
    if payload.is_empty() {
        return Err(AppError::new(
            "REPO_EMPTY_SKILL",
            "这个技能在公司技能库里是空的,请联系它的维护者",
        )
        .with_detail(format!("empty payload for {}", skill.path)));
    }

    progress(Stage::Checking);
    let installer = Installer::new(registry, env);
    let loaded = store.load_state()?;
    let checked = precheck(
        &installer,
        env,
        &loaded.value,
        req.dir_slug,
        &head.sha,
        Some(req.repo),
    )?;

    // 需要用户拍板的三种情况:改过本体、目录是别人的、或它装自另一个技能库。
    // 此时不动磁盘。
    let needs_decision = matches!(
        checked,
        Precheck::LocallyModified { .. } | Precheck::Foreign { .. } | Precheck::OtherLibrary { .. }
    );
    if needs_decision && req.resolution.is_none() {
        return Ok(AcquireOutcome::NeedsDecision { precheck: checked });
    }

    // 外来目录里没有"你的改动"可留:接受 KeepLocal 会把别人的内容当成我们装的记进 state
    // (contentHash 从外来字节算、commitSha 记成远端版本),之后更新检查会永远显示"已是最新"。
    // 界面本来就不给这个选项,但**新的调用方**(向导批量安装)很可能一律传 KeepLocal,
    // 所以在 core 这层直接堵掉,不靠界面的形状保证。
    if matches!(checked, Precheck::Foreign { .. }) && req.resolution == Some(Resolution::KeepLocal) {
        return Err(AppError::new(
            "CONFLICT_FOREIGN_DIR",
            "这个位置上的技能不是本应用安装的,请先确认要不要替换它",
        )
        .with_detail("KeepLocal is not a valid resolution for a foreign directory"));
    }

    // 保留本地:只补建链接,绝不碰本体。
    let keep_local = needs_decision && req.resolution == Some(Resolution::KeepLocal);

    let report = if keep_local {
        progress(Stage::Linking);
        installer.link_only(req.dir_slug, req.agent_names, OnOccupied::Fail)?
    } else {
        progress(Stage::Writing);
        // agent 目录那侧的实体目录占位是另一回事:保持 Fail,由结果面板逐目录报出来,
        // 不在这里替用户决定要不要替换他自己建的目录。
        //
        // install() 内部是"先写后链"一气呵成,编排层插不进中间那一刻。报 Linking 是因为
        // 落盘之后紧接着就是建链——少报一个阶段会让进度条从写入直接跳到记账。
        let report = installer.install(req.dir_slug, &payload, req.agent_names, OnOccupied::Fail)?;
        progress(Stage::Linking);
        report
    };

    progress(Stage::Recording);
    let canonical_visible = installer.canonical_visible_agents(req.agent_names)?;
    let lock = record(
        store,
        env,
        &loaded.value,
        &report,
        skill,
        req,
        &head.sha,
        now,
        keep_local,
        canonical_visible,
    )?;

    progress(Stage::Done);
    Ok(AcquireOutcome::Installed {
        report,
        local_kept: keep_local,
        lock,
    })
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
    registry_id: &str,
    repo: &RepoRef,
    dir_slugs: &[String],
    agents: BatchAgents<'_>,
    now: &str,
    fetched_at: i64,
) -> Result<Vec<BatchItem>, AppError> {
    let head = client.branch_head(repo).await?;
    let archive = client.download_archive(repo).await?;
    let index = store_index::build_index(registry_id, repo, &head, &archive, fetched_at);
    let cache = store_index::cache_path(store.dir(), registry_id, repo);
    if let Err(err) = store_index::save_cache(&cache, &index) {
        eprintln!("[acquire] 刷新索引缓存失败(不影响安装): {err}");
    }

    let installer = Installer::new(registry, env);
    let mut out = Vec::new();
    for dir_slug in dir_slugs {
        let item = install_one_from_archive(
            &installer,
            env,
            store,
            registry_id,
            repo,
            &index,
            &archive,
            &head.sha,
            dir_slug,
            agents,
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
    env: &dyn AgentEnv,
    store: &Store,
    registry_id: &str,
    repo: &RepoRef,
    index: &store_index::StoreIndex,
    archive: &RepoArchive,
    head_sha: &str,
    dir_slug: &str,
    agents: BatchAgents<'_>,
    now: &str,
) -> BatchOutcome {
    let Some(skill) = index.skills.iter().find(|s| s.dir_slug == dir_slug) else {
        return BatchOutcome::Skipped {
            reason: "已不在公司技能库中".into(),
        };
    };

    // 每轮重新读 state:上一轮的记账已经写回,拿旧快照会互相覆盖
    let run = || -> Result<BatchOutcome, AppError> {
        let loaded = store.load_state()?;

        // 链接目标:向导给统一列表;定时更新用账上的,绝不改写用户的关联
        let agent_names: Vec<String> = match agents {
            BatchAgents::Uniform(list) => list.to_vec(),
            BatchAgents::FromAccount => {
                let Some(record) = loaded.value.installed.iter().find(|s| s.name == *dir_slug)
                else {
                    return Ok(BatchOutcome::Skipped {
                        reason: "未安装,已跳过".into(),
                    });
                };
                record.agents.clone()
            }
        };
        let agent_names = agent_names.as_slice();

        match precheck(installer, env, &loaded.value, dir_slug, head_sha, Some(repo))? {
            Precheck::LocallyModified { .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: "已安装且有你的本地改动,未覆盖".into(),
                })
            }
            Precheck::Foreign { .. } => {
                return Ok(BatchOutcome::Skipped {
                    reason: "这个位置已有其他来源的技能,未替换".into(),
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
            Precheck::Fresh | Precheck::Managed { .. } => {}
        }

        let payload = extract_payload(archive, skill);
        if payload.is_empty() {
            return Err(AppError::new(
                "REPO_EMPTY_SKILL",
                "这个技能在公司技能库里是空的,请联系它的维护者",
            ));
        }
        let report = installer.install(dir_slug, &payload, agent_names, OnOccupied::Fail)?;
        let canonical_visible = installer.canonical_visible_agents(agent_names)?;
        record(
            store,
            env,
            &loaded.value,
            &report,
            skill,
            AcquireRequest {
                registry_id,
                repo,
                dir_slug,
                agent_names,
                resolution: None,
            },
            head_sha,
            now,
            false,
            canonical_visible,
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
    skill: &IndexedSkill,
    req: AcquireRequest<'_>,
    remote_sha: &str,
    now: &str,
    keep_local: bool,
    canonical_visible: Vec<String>,
) -> Result<String, AppError> {
    let mut next = previous.clone();
    let existing = next.installed.iter().position(|s| s.name == report.dir_name);

    // 内容 hash 必须从**落盘后的 canonical 目录**算,而不是从 payload 算:
    // dir_content_hash 有自己的排除清单,口径必须与它一致,否则刚装完就被判成
    // "用户改过",更新流程会永远停在冲突提示上。
    let content_hash = fsops::dir_content_hash(Path::new(&report.canonical_dir))?;

    let (links, agents) = active_accounting(report, canonical_visible);

    match existing {
        // 保留本地改动:关于**内容**的字段一个都不动。
        // commitSha 保持旧值 → "有可用更新"仍然成立;
        // contentHash 保持安装时的值 → "有未分享的改动"仍然成立。
        // 这两个标记就是分享流程(任务 11)找到这条记录的依据,更新了就等于把它藏起来。
        Some(idx) if keep_local => {
            let record = &mut next.installed[idx];
            record.agents = agents;
            record.links = links;
            record.updated_at = now.to_string();
        }
        Some(idx) => {
            let record = &mut next.installed[idx];
            record.source = source_of(&req, skill, remote_sha);
            record.commit_sha = remote_sha.to_string();
            record.content_hash = content_hash;
            record.agents = agents;
            record.links = links;
            record.updated_at = now.to_string();
        }
        None => next.installed.push(InstalledSkill {
            name: report.dir_name.clone(),
            source: source_of(&req, skill, remote_sha),
            commit_sha: remote_sha.to_string(),
            content_hash,
            // 从技能库获取的:文件是本 app 装的,**不可取消认领**
            // (只删记账会留下孤儿目录与孤儿链接)
            origin: Some(ORIGIN_ACQUIRED.to_string()),
            agents,
            links,
            installed_at: now.to_string(),
            updated_at: now.to_string(),
        }),
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
                source_type: "gitea".into(),
                source_url: format!("{}/{}", req.repo.owner, req.repo.repo),
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

/// 从建链报告推导 state 记账:`links` 只记成功建立的,`agents` 是技能**实际对哪些工具生效**。
///
/// 两者必须讲同一件事:成功建链的 + 落在 canonical 就能读到、无需建链的(universal)。
/// 早先直接把 report.links 里的 agents 全收下来,同时错两头——
/// 建链失败的被记成已生效(界面会把它画成启用中),universal 的又被整个漏掉。
fn active_accounting(
    report: &InstallReport,
    canonical_visible: Vec<String>,
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
    agents.extend(canonical_visible);
    agents.sort();
    agents.dedup();
    (links, agents)
}

/// 修复关联:按 state 记账里的 agents 重建链接,**不碰技能本体**,并把账更新为实际结果。
///
/// [`fsops::link_dir`] 对各异常形态的语义正好是修复需要的:missing 重建、
/// 被改指/断链的**链接**直接换回来(链接不是用户数据本体,无需确认),
/// 而实体目录占位是否替换必须由 `replace_occupied`(前端确认结果,铁律 7)决定。
/// 本体已丢时 `link_only` 会拒绝——那要走"重新获取",不是修复能解决的。
pub fn repair_links(
    installer: &Installer<'_>,
    store: &Store,
    dir_slug: &str,
    replace_occupied: bool,
) -> Result<InstallReport, AppError> {
    let loaded = store.load_state()?;
    let Some(idx) = loaded.value.installed.iter().position(|s| s.name == dir_slug) else {
        return Err(AppError::new(
            "FS_NOT_INSTALLED",
            "这个技能不在已获取列表中,请先重新获取",
        )
        .with_detail(format!("not in state.installed: {dir_slug}")));
    };
    let record = &loaded.value.installed[idx];

    let on_occupied = if replace_occupied {
        OnOccupied::Replace
    } else {
        OnOccupied::Fail
    };
    let report = installer.link_only(dir_slug, &record.agents, on_occupied)?;

    let canonical_visible = installer.canonical_visible_agents(&record.agents)?;
    let (links, agents) = active_accounting(&report, canonical_visible);
    let mut next = loaded.value.clone();
    next.installed[idx].links = links;
    next.installed[idx].agents = agents;
    store.save_state(&next)?;

    Ok(report)
}

/// 把已装技能**补关联**到指定的一批工具上,并把成功的并进账里。
///
/// 与 [`repair_links`] 的分工:repair 处理"账上有、链接坏了",按账上的 agents **整体重来**;
/// 本函数处理"安装那一刻就没建成、因而根本没进账"的 agent(M1 遗留:安装时占位是
/// `OnOccupied::Fail` 只报不重试,修复够不到它们,用户只能回详情面板整个重装)。
///
/// 记账是**并集合并**而不是覆盖:只重链了一部分工具,拿这次的结果整份覆盖会把
/// 其余工具从账上抹掉,卸载时就不会去解它们的链接了。
///
/// `replace_occupied` 必须是前端拿到的用户确认结果(铁律 7):那个位置上是别人的
/// 实体目录,替换等于删用户文件。
pub fn link_agents(
    installer: &Installer<'_>,
    store: &Store,
    dir_slug: &str,
    agent_names: &[String],
    replace_occupied: bool,
) -> Result<InstallReport, AppError> {
    let loaded = store.load_state()?;
    let Some(idx) = loaded.value.installed.iter().position(|s| s.name == dir_slug) else {
        return Err(AppError::new(
            "FS_NOT_INSTALLED",
            "这个技能不在已获取列表中,请先重新获取",
        )
        .with_detail(format!("not in state.installed: {dir_slug}")));
    };

    let on_occupied = if replace_occupied {
        OnOccupied::Replace
    } else {
        OnOccupied::Fail
    };
    let report = installer.link_only(dir_slug, agent_names, on_occupied)?;

    let canonical_visible = installer.canonical_visible_agents(agent_names)?;
    let (new_links, new_agents) = active_accounting(&report, canonical_visible);

    let mut next = loaded.value.clone();
    let record = &mut next.installed[idx];
    for link in new_links {
        // 同一目录只留一条记账:重链后 mode 可能变了(比如从复制升回链接)
        match record.links.iter_mut().find(|l| l.dir == link.dir) {
            Some(existing) => existing.mode = link.mode,
            None => record.links.push(link),
        }
    }
    record.agents.extend(new_agents);
    record.agents.sort();
    record.agents.dedup();
    store.save_state(&next)?;

    Ok(report)
}

fn source_of(req: &AcquireRequest<'_>, skill: &IndexedSkill, sha: &str) -> SkillSource {
    SkillSource {
        registry_id: req.registry_id.to_string(),
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

// ============================================================ 认领上游安装(M3 任务 6)
//
// `npx skills` 装的技能只在 lock 里有记账、不在 state.json——本 app 对它们
// 只读不管。「认领」是用户显式动作:补 state 记账,让更新/修复/移除走本 app
// 既有流程。铁律:**lock 一个字节不动**(认领只读它),未认领的条目更是碰都不碰。

/// 「我的技能」里的未认领行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnclaimedSkill {
    pub dir_slug: String,
    /// 上游记账的来源(如 `owner/repo`),仅展示。
    pub source: String,
}

/// 扫出「上游装的、本体还在、我们没记账」的技能。
/// 本体已不在的不列——摆一个认领了也用不了的行是撒谎。
pub fn unclaimed_skills(
    env: &dyn AgentEnv,
    installer: &Installer,
    st: &state::State,
) -> Vec<UnclaimedSkill> {
    let Some(lock) = skill_lock::lock_path(env) else {
        return Vec::new();
    };
    skill_lock::read_entries(&lock)
        .into_iter()
        .filter(|e| !st.installed.iter().any(|s| s.name == e.key))
        .filter(|e| {
            installer
                .canonical_dir(&e.key)
                .map(|p| p.is_dir())
                .unwrap_or(false)
        })
        .map(|e| UnclaimedSkill {
            dir_slug: e.key,
            source: e.source,
        })
        .collect()
}

/// 认领结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimReport {
    pub dir_slug: String,
    /// 收编入账的关联数。npx 建的链接不入账的话,移除时没人解,会留一地断链。
    pub adopted_links: usize,
    /// 是否绑定到了某个已配置的源。绑不上 = 仅本地管理(不提供更新与回推)。
    pub bound: bool,
}

/// 认领一个上游装的技能。
///
/// 记账基线:`content_hash` 取**认领此刻**的目录内容(此后的改动才算"已改动");
/// `commit_sha` 留空——基线版本未知,与远端头一比必然"有更新",第一次更新即对齐,
/// 覆盖前照走既有预检(内容没动过才直接覆盖,动过必弹三选,绝不静默覆盖)。
/// `state.installed` 里 `origin` 的两个取值。
///
/// 它决定一条记账**能不能被取消认领**:认领来的文件是别的工具装的,本 app 只记了账,
/// 删账无损;获取来的文件是本 app 装的,只删账会留下孤儿目录与孤儿链接。
pub const ORIGIN_CLAIMED: &str = "claimed";
pub const ORIGIN_ACQUIRED: &str = "acquired";

/// 这条记账是不是认领来的(因而可以取消认领)。
///
/// `origin` 缺席是旧版 state 的存量条目,退回判据 `commit_sha.is_empty()`
/// ——已实证 `state.installed` 全仓只有两处写入,正常安装写远端 sha、只有 claim 留空。
/// 判据保守:拿不准就当成"获取来的"不许取消,宁可少给一个按钮,不可误删记账留下孤儿。
pub fn is_claimed(skill: &state::InstalledSkill) -> bool {
    match skill.origin.as_deref() {
        Some(ORIGIN_CLAIMED) => true,
        Some(_) => false,
        None => skill.commit_sha.is_empty(),
    }
}

/// 取消认领:[`claim`] 的**精确逆操作**。
///
/// 只从 `state.installed` 删掉这条记账——**磁盘、各工具下的链接、
/// `.skill-lock.json` 一个字节都不动**。认领本身就是纯记账(claim 全程只调一次
/// `save_state`),所以它的撤销也必须是纯记账。
///
/// 这个函数存在的理由(M4 任务 6a,用户 2026-08-04 实测报的):在它之前,认领后唯一的
/// 退出路径是「移除」,而移除会解链 → 删本体 → **从 `.skill-lock.json` 删掉条目**。
/// 于是用户点一个零副作用的记账动作,反悔时唯一的按钮会把这个技能从 npx skills
/// 那边一并毁掉。无害的进入,破坏性的退出。
pub fn unclaim(store: &Store, dir_slug: &str) -> Result<(), AppError> {
    let loaded = store.load_state()?;
    let Some(idx) = loaded.value.installed.iter().position(|s| s.name == dir_slug) else {
        return Err(AppError::new(
            "FS_NOT_INSTALLED",
            "这个技能不在管理列表中,无需取消",
        )
        .with_detail(format!("not in state.installed: {dir_slug}")));
    };
    if !is_claimed(&loaded.value.installed[idx]) {
        return Err(AppError::new(
            "CONFLICT_NOT_CLAIMED",
            "这个技能是从技能库获取的,不能取消认领。不想要的话请用「移除」",
        )
        .with_detail(format!("origin is not claimed: {dir_slug}")));
    }

    let mut next = loaded.value.clone();
    next.installed.remove(idx);
    store.save_state(&next)?;
    Ok(())
}

pub fn claim(
    installer: &Installer,
    registry: &AgentRegistry,
    env: &dyn AgentEnv,
    store: &Store,
    registries: &[state::RegistryConfig],
    dir_slug: &str,
    now: &str,
) -> Result<ClaimReport, AppError> {
    let mut st = store.load_state()?.value;
    if st.installed.iter().any(|s| s.name == dir_slug) {
        return Err(AppError::new(
            "CONFLICT_ALREADY_MANAGED",
            "这个技能已在管理中,无需认领",
        ));
    }
    let canonical = installer.canonical_dir(dir_slug)?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            "FS_NOT_CLAIMABLE",
            "本地已没有这个技能的文件,无法认领",
        ));
    }
    let lock = skill_lock::lock_path(env).ok_or_else(|| {
        AppError::new("FS_NO_HOME", "找不到用户主目录,无法保存本地数据")
    })?;
    let entry = skill_lock::read_entries(&lock)
        .into_iter()
        .find(|e| e.key == dir_slug)
        .ok_or_else(|| {
            AppError::new(
                "FS_NOT_CLAIMABLE",
                "这个技能不是由 npx skills 安装的,可以在分享页把它收编进来",
            )
        })?;

    let (registry_id, owner, repo) = bind_source(&entry, registries);
    let content_hash = fsops::dir_content_hash(&canonical)?;

    // 收编 npx 建的链接。只认「确实指向这个 canonical 的链接」;实体目录(npx 的
    // 降级复制)与用户自己的目录无从区分,不敢认——那正是"凭猜测动用户文件"。
    let all_names: Vec<String> = registry.agents().iter().map(|a| a.name.clone()).collect();
    let mut links = Vec::new();
    let mut agent_names = std::collections::BTreeSet::new();
    for target in installer.link_targets(&all_names)? {
        let link = target.dir.join(dir_slug);
        if let fsops::LinkState::Linked(kind) = fsops::link_state(&link, &canonical) {
            links.push(LinkRecord {
                dir: target.dir.to_string_lossy().into_owned(),
                mode: kind.as_str().to_string(),
            });
            agent_names.extend(target.agents.iter().cloned());
        }
    }

    let report = ClaimReport {
        dir_slug: dir_slug.to_string(),
        adopted_links: links.len(),
        bound: !registry_id.is_empty(),
    };
    st.installed.push(InstalledSkill {
        name: dir_slug.to_string(),
        source: SkillSource {
            registry_id,
            owner,
            repo,
            path: entry.skill_path.clone(),
            git_ref: entry.git_ref.clone(),
        },
        commit_sha: String::new(),
        content_hash,
        // 认领来的:文件是别的工具装的,本 app 只是记了账,因此**可以取消认领**
        origin: Some(ORIGIN_CLAIMED.to_string()),
        agents: agent_names.into_iter().collect(),
        links,
        // 上游记的安装时间照抄(它更接近事实),没有才用现在
        installed_at: entry.installed_at.clone().unwrap_or_else(|| now.to_string()),
        updated_at: now.to_string(),
    });
    store.save_state(&st)?;
    Ok(report)
}

/// 上游来源 ↔ 已配置源的绑定。GitHub 条目按 `sourceUrl` 与源地址同源比对;
/// 绑不上就只留展示用的 owner/repo,registry_id 空(更新与回推没有去处)。
fn bind_source(
    entry: &skill_lock::UpstreamEntry,
    registries: &[state::RegistryConfig],
) -> (String, String, String) {
    let (owner, repo) = entry
        .source
        .split_once('/')
        .map(|(o, r)| (o.to_string(), r.to_string()))
        .unwrap_or_else(|| (entry.source.clone(), String::new()));
    if entry.source_type == "github" {
        if let Some(m) = registries.iter().find(|r| {
            r.kind == "github"
                && crate::core::gitea::is_same_origin(&r.base_url, &entry.source_url)
                // 同源还不够,**这个技能库本身也得在源的库列表里**(M4 任务 1):
                // 绑上去等于对用户承诺"能从这个来源更新它",而源里没有这个库时,
                // 更新只会去该源的主库找同名技能——找不到就报错,找到就装错内容。
                && r.repos.iter().any(|c| c.owner == owner && c.repo == repo)
        }) {
            return (m.id.clone(), owner, repo);
        }
    }
    (String::new(), owner, repo)
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
