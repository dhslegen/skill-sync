//! skill 安装器:canonical 落盘(`~/.agents/skills/`)+ 各 agent 目录链接。
//!
//! 链接策略经由 [`crate::core::fsops`]。本模块只负责编排,不碰 `state.json`(任务 7)。
//!
//! **建链与解链一律以「目录」为单位,不是按 agent**:多个 agent 共用同一 `globalSkillsDir`
//! 是常态(cline/dexto/warp/zed 等直接指向 canonical,zencoder 与 zenflow 同指一处)。
//! 按 agent 逐个解链会删掉别的 agent 仍在用的目录——直接违反"绝不静默删除用户文件"。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::core::agents::{AgentEnv, AgentRegistry};
use crate::core::fsops::{self, LinkKind, LinkOutcome, LinkState, Trasher};
use crate::core::skills::sanitize_name;
use crate::error::AppError;

/// 一个技能「住在哪里」:本体的实际位置 + canonical 位置的对应关系(v6 二期)。
///
/// 新模型:**本体只有一份,住在它现在所在的地方,永不搬动**;canonical 与各工具
/// 目录一律是指向本体的链接,除非本体本来就住在 canonical(此时 `body == canonical`,
/// 这也是迄今为止唯一真实存在过的形态——本任务只打通解析层,不改变任何既有安装的落点)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillHome {
    pub dir_slug: String,
    /// 目录名(sanitize 后),canonical 与各工具目录下都用它。
    pub dir_name: String,
    /// 本体所在(实体目录)。
    pub body: PathBuf,
    /// `canonical/<dir_name>`;`body` 不在这里时它是一条指向 `body` 的链接。
    pub canonical: PathBuf,
}

impl SkillHome {
    /// 本体是否就住在 canonical。**不按字面 `PathBuf` 比**(审查修复轮 1 Minor):
    /// `home()` 不做 realpath 归一化,而 macOS 上 `/var` → `/private/var` 这类
    /// 软链会让同一处磁盘位置在字面上写成两条不同的路径,比字面值会比出假阴性
    /// ——`project_pick` 的守卫已经吃过同一个亏,这里按同样的姿势兜住。
    ///
    /// ⚠️ **必须用 [`fsops::same_intended_location`],不能用 `fsops::same_physical_path`**
    /// (第一版试过用后者,被自己新写的注入验证抓回来了):`same_physical_path` 在两边都
    /// 存在时会连最后一级也走 realpath——一旦 `Installer::install` 已经把 canonical
    /// 建成指向 body 的符号链接,连叶子一起解析就会"看穿"这条链接,让 `body_is_canonical`
    /// 在 `uninstall` 里对着一条明明存在的链接误判成"就是 canonical",于是那条链接
    /// 永远不会被摘掉。`same_intended_location` 只解析父目录、保留叶子名,不会被
    /// 我们自己建的链接影响。
    pub fn body_is_canonical(&self) -> bool {
        self.body == self.canonical
            || fsops::same_intended_location(&self.body, &self.canonical)
    }
}

/// 待落盘的技能内容。来源可以是仓库压缩包(任务 8/9)或本机目录(任务 11 收编)。
#[derive(Debug, Default, Clone)]
pub struct SkillPayload {
    files: BTreeMap<String, PayloadFile>,
}

#[derive(Debug, Clone)]
pub struct PayloadFile {
    pub bytes: Vec<u8>,
    /// unix 权限位。`None` 表示按普通文件落盘;脚本类技能靠它保住可执行位。
    pub unix_mode: Option<u32>,
}

impl SkillPayload {
    pub fn new() -> Self {
        Self::default()
    }

    /// 放入一个文件,路径为 `/` 分隔的技能内相对路径。
    pub fn with_file(mut self, path: &str, bytes: impl Into<Vec<u8>>) -> Self {
        self.files.insert(
            path.to_string(),
            PayloadFile {
                bytes: bytes.into(),
                unix_mode: None,
            },
        );
        self
    }

    pub fn with_executable(mut self, path: &str, bytes: impl Into<Vec<u8>>) -> Self {
        self.files.insert(
            path.to_string(),
            PayloadFile {
                bytes: bytes.into(),
                unix_mode: Some(0o755),
            },
        );
        self
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// 已放入的文件。供编排层的测试断言"取了哪些、权限位对不对"。
    pub fn files(&self) -> &BTreeMap<String, PayloadFile> {
        &self.files
    }
}

/// 一个建链目标目录,以及共用它的 agent 名单。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTarget {
    pub dir: PathBuf,
    pub agents: Vec<String>,
}

/// 单个目录的建链结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum LinkResult {
    /// 建链成功(或降级复制)。
    Linked { mode: String },
    /// 本就已正确关联,未做改动。
    Unchanged { mode: String },
    /// 该目录与 canonical 是同一处磁盘位置,无需建链。
    SameLocation,
    /// 失败,`error` 给用户可读原因。
    Failed { error: AppError },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReport {
    pub dir: String,
    pub agents: Vec<String>,
    pub result: LinkResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    /// 清洗后的目录名(即 canonical 与各 agent 目录下的目录名)。
    pub dir_name: String,
    pub canonical_dir: String,
    pub links: Vec<LinkReport>,
}

/// 卸载时对某个目录的处置结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum UnlinkResult {
    /// 已解除关联。
    Unlinked,
    /// 本来就不存在。
    Missing,
    /// 跳过,`reason` 说明为何不动它(用户改过、是实体目录、无记录等)。
    Skipped { reason: String },
    Failed { error: AppError },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkReport {
    pub dir: String,
    pub result: UnlinkResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    pub dir_name: String,
    pub unlinks: Vec<UnlinkReport>,
    /// canonical 本体是否已删除。
    pub canonical_removed: bool,
}

/// 卸载所需的一条链接记账。来自 `state.json`(任务 7),此处只消费。
#[derive(Debug, Clone)]
pub struct RecordedLink {
    pub dir: PathBuf,
    pub mode: LinkKind,
}

/// 一条关联当前的健康程度,给「我的技能」页显示用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkHealth {
    /// 形态与记账相符,技能可被对应工具读到。
    Healthy,
    /// 链接还在,但指向的内容已不存在。
    Broken,
    /// 被改指到别处,或副本被换成了别的形态——都不是我们放的那份了。
    Redirected,
    /// 位置被一个实体目录顶掉了。
    Occupied,
    /// 关联整个不见了。
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkHealthReport {
    pub dir: String,
    /// `symlink` / `junction` / `copy`,来自安装时的记账。
    pub mode: String,
    pub health: LinkHealth,
}

pub struct Installer<'a> {
    registry: &'a AgentRegistry,
    env: &'a dyn AgentEnv,
    chain: Vec<LinkKind>,
    trasher: &'a dyn Trasher,
}

impl<'a> Installer<'a> {
    pub fn new(registry: &'a AgentRegistry, env: &'a dyn AgentEnv) -> Self {
        Self {
            registry,
            env,
            chain: fsops::default_link_chain().to_vec(),
            trasher: &fsops::SYSTEM_TRASH,
        }
    }

    /// 覆盖降级链。仅测试与诊断用。
    pub fn with_chain(mut self, chain: Vec<LinkKind>) -> Self {
        self.chain = chain;
        self
    }

    /// 覆盖废纸篓实现。默认是真实系统废纸篓([`fsops::SYSTEM_TRASH`]);
    /// 测试必须显式注入 `SandboxTrash`,否则会把测试产物丢进这台机器真实的系统废纸篓。
    pub fn with_trasher(mut self, t: &'a dyn Trasher) -> Self {
        self.trasher = t;
        self
    }

    /// 当前生效的废纸篓实现。供 `converge` 那组原语复用同一个实例,
    /// 不必另外把 trasher 到处再传一遍。
    pub fn trasher(&self) -> &dyn Trasher {
        self.trasher
    }

    /// 当前生效的降级链。理由同 [`Self::trasher`]。
    pub fn chain(&self) -> &[LinkKind] {
        &self.chain
    }

    /// canonical 技能库根目录 `~/.agents/skills`。
    fn canonical_base(&self) -> Result<PathBuf, AppError> {
        self.registry.canonical_global_dir(self.env).ok_or_else(|| {
            AppError::new("FS_NO_HOME", "找不到你的用户目录,无法安装技能")
                .with_detail("home dir unavailable")
        })
    }

    /// canonical 技能目录:`~/.agents/skills/<清洗后的 slug>`。
    ///
    /// `dir_slug` 是**技能在仓库中的目录名**(如 `skills/docx-to-markdown` 取 `docx-to-markdown`),
    /// 不是 frontmatter 里的 `name`。
    ///
    /// ⚠️ **这是一次刻意的分叉,不是"对齐上游"**(2026-08-19 查上游产物证伪了原来那句
    /// 「对齐 `installer.ts:640` 的 `installName: entry.name`」,CLAUDE.md 已记):上游
    /// 1.5.20/1.5.23 的远端安装两条路**都用 frontmatter `name`**,它自己是自洽的;
    /// 分叉的是本 app。理由换成了真的——目录名是 `store::build_index` 的索引键、
    /// `state.installed` 的记账键与 `.skill-lock.json` 键的**同一把尺子**,内部自洽;
    /// 而 frontmatter `name` 可以被作者随时改掉(改了就等于换了个技能),当键不稳。
    /// 官方判据另见 CLAUDE.md「命名与目录」:Claude Code 里调用名来自**目录名**,
    /// frontmatter `name` 只是显示标签。
    ///
    /// 真实公司技能库 20 个技能全为 ASCII kebab-case,两个口径在那批技能上恰好相同;
    /// 中文展示名由 frontmatter 提供,不参与目录命名。
    ///
    /// 经 [`sanitize_name`] 清洗(与上游、与 `.skill-lock.json` 的键同一套规则);
    /// 清洗后已不可能含路径分隔符,`safe_join` 是第二道防线。
    ///
    /// ⚠️ **本模块与 `converge.rs` 之外禁止直接调用**:文本级守卫
    /// (`tests/body_guard.rs`)钉住这一条——本体路径的解析只许发生在这一层,
    /// 别处一律走 [`Self::home`]/`converge::home_of`。
    fn canonical_dir(&self, dir_slug: &str) -> Result<PathBuf, AppError> {
        let base = self.canonical_base()?;
        fsops::safe_join(&base, &usable_dir_name(dir_slug)?)
    }

    /// 解析一个技能「住在哪里」(v6 二期核心入口)。
    ///
    /// `body`:账上记的本体位置,`None` 表示没有记账或记账就是 canonical 本身
    /// ——两种情况下本体默认就落在 canonical(这也是迄今为止唯一真实存在过的形态)。
    /// `Some` 时校验目录名必须等于 `dir_name`(= `canonical_dir(dir_slug)` 的
    /// `file_name`):账上的 body 目录名与 canonical 目录名对不上,说明记账已经
    /// 损坏或来自别处,不能糊弄着继续走下去。
    ///
    /// 🔴 **比的是 body 叶子名 `sanitize_name` 之后的样子**(v6 二期任务 5):
    /// `dir_name` 出自 `canonical_dir`,已经清洗过(会小写化);而 body 是磁盘上
    /// 真实存在的目录,叶子名一个字符都没清洗过。用户在 `~/.claude/skills/` 下
    /// 手建的 `Weekly-Report` 就是这一档——按字面比会报 `FS_BAD_BODY`
    /// 「这个技能的记账已经损坏,请重新获取一次」,而它既没有记账、也不是从任何
    /// 技能库来的,**这句话对它是假话,而且是条死路**(「我的技能」页发现得了它,
    /// 每个动作却都必然报错)。
    ///
    /// 放宽的只有"清洗会折掉的那些差异"(大小写、空格折成连字符等),别的照旧拦:
    /// `/x/Weekly_Report` 清洗后是 `weekly_report`,与 `weekly-report` 仍不相等。
    /// **body 的叶子名保持字面,不改名不搬家**——canonical 与各工具目录下的链接
    /// 一律用清洗后的 `dir_name`,两者可以不同名,这正是「本体永不搬动」的形状。
    pub fn home(&self, dir_slug: &str, body: Option<&Path>) -> Result<SkillHome, AppError> {
        let canonical = self.canonical_dir(dir_slug)?;
        let dir_name = dir_name_of(&canonical);
        let body = match body {
            None => canonical.clone(),
            Some(b) => {
                if sanitize_name(&dir_name_of(b)) != dir_name {
                    return Err(AppError::new(
                        "FS_BAD_BODY",
                        "这个技能的安装信息已经损坏,请重新获取一次",
                    )
                    .with_detail(format!(
                        "recorded body {} does not match dir_name {dir_name}",
                        b.display()
                    )));
                }
                b.to_path_buf()
            }
        };
        Ok(SkillHome {
            dir_slug: dir_slug.to_string(),
            dir_name,
            body,
            canonical,
        })
    }

    /// 落在 canonical 就能读到、**无需建链**的 agent。
    ///
    /// [`Self::link_targets`] 会有意跳过它们(universal agent,以及目录恰好等于 canonical 的),
    /// 所以它们永远不会出现在 `links` 里——但技能对它们确实是生效的。
    /// 记账时若只看 `links`,cursor / codex 这类会被漏成"没启用"。
    pub fn canonical_visible_agents(&self, agent_names: &[String]) -> Result<Vec<String>, AppError> {
        let canonical = self.canonical_base()?;
        let mut out = Vec::new();
        for name in agent_names {
            let agent = self.registry.get(name).ok_or_else(|| {
                AppError::new("FS_UNKNOWN_AGENT", "这个 AI 工具不在支持列表中")
                    .with_detail(format!("unknown agent: {name}"))
            })?;
            let Some(dir) = self.registry.global_dir(agent, self.env) else {
                // 压根不支持全局安装(eve / promptscript):技能对它不生效,不能算进去
                continue;
            };
            if !agent.global_install_needs_link() || dir == canonical {
                out.push(name.clone());
            }
        }
        Ok(out)
    }

    /// 计算需要建链的目标目录集合。
    ///
    /// 三重过滤:universal agent 落在 canonical 即可见,不建链;不支持全局安装的 agent 跳过;
    /// **canonical 自身永不作为目标**——否则"解除某 agent 的关联"就等于删掉技能本体。
    ///
    /// ⚠️ 这一层还不知道本体住在哪(那是 [`Self::home`] 的事),所以它只挡 canonical——
    /// 本体住在别的工具目录时,还需要 [`Self::link_targets_for`] 再挡一道。
    pub fn link_targets(&self, agent_names: &[String]) -> Result<Vec<LinkTarget>, AppError> {
        let canonical = self.canonical_base()?;
        let mut grouped: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
        for name in agent_names {
            let agent = self.registry.get(name).ok_or_else(|| {
                AppError::new("FS_UNKNOWN_AGENT", "这个 AI 工具不在支持列表中")
                    .with_detail(format!("unknown agent: {name}"))
            })?;
            if !agent.global_install_needs_link() {
                continue;
            }
            let Some(dir) = self.registry.global_dir(agent, self.env) else {
                continue;
            };
            if dir == canonical {
                continue;
            }
            grouped.entry(dir).or_default().push(name.clone());
        }
        Ok(grouped
            .into_iter()
            .map(|(dir, agents)| LinkTarget { dir, agents })
            .collect())
    }

    /// [`Self::link_targets`] 之上再过滤掉**本体所在的那个工具目录**:那里已经有
    /// 本体本身,不需要、也不能再对着自己建一条链接(会撞上 `SameLocation`/自指软链)。
    pub fn link_targets_for(
        &self,
        home: &SkillHome,
        agent_names: &[String],
    ) -> Result<Vec<LinkTarget>, AppError> {
        let occupied = home.body.parent().map(Path::to_path_buf);
        Ok(self
            .link_targets(agent_names)?
            .into_iter()
            .filter(|t| Some(&t.dir) != occupied.as_ref())
            .collect())
    }

    /// 安装:内容落到本体位置,再链接到各 agent 目录(以及本体不在 canonical 时,
    /// canonical 本身也要链接回本体)。
    ///
    /// ⚠️ **本体会被无条件替换**(审查修复轮 1 I-4 订正:此前这里写的是"清空重建,
    /// `on_occupied` 管不到这里"——`on_occupied` 参数早已从这个函数的签名上删掉,
    /// 那句话已经过期)。若用户改过技能本体,重装/更新会把改动连同旧内容一起替换掉
    /// ——这正是铁律 7 所说的破坏性操作。守卫属于编排层(`core::acquire`):调用方必须
    /// 先拿 `state.installed[].contentHash` 与本地实际内容比对,不一致时按设计方案
    /// 2.5③ 弹"保留本地 / 用远端覆盖 / 把本地改动分享上去"三选一,拿到用户结论后才调
    /// 本函数。
    ///
    /// 写入顺序刻意"先落到 staging、再腾出本体位置、最后一次 rename"(而不是先清空
    /// 本体再写):目标可能是用户在别的工具目录里正维护着的本体,写到一半失败不能
    /// 把它变成一个内容残缺的半成品(见 `a_failed_write_leaves_the_old_body_and_staging_untouched`)。
    /// 旧本体经 [`fsops::trash_tree`] 进废纸篓,不是直接删——铁律 7 在这里的落点是
    /// "可逆",不只是"问过"。
    pub fn install(
        &self,
        home: &SkillHome,
        payload: &SkillPayload,
        agent_names: &[String],
    ) -> Result<InstallReport, AppError> {
        let targets = self.link_targets_for(home, agent_names)?;
        let parent = home.body.parent().ok_or_else(|| {
            AppError::new("FS_BAD_BODY", "技能本体的位置不合法")
                .with_detail(format!("body has no parent: {}", home.body.display()))
        })?;
        let staging = parent.join(format!(".{}.skillsync-new", home.dir_name));

        // 内容不可信,先整体校验路径再落盘,避免写到一半才发现 zip slip。
        let entries = payload
            .files
            .iter()
            .map(|(rel, file)| Ok((fsops::safe_join(&staging, rel)?, file)))
            .collect::<Result<Vec<_>, AppError>>()?;

        // staging 是我们自己刚建的临时目录,不是用户数据,可以直接清。
        fsops::reset_dir(&staging)?;
        let written = entries
            .into_iter()
            .try_for_each(|(path, file)| fsops::write_file(&path, &file.bytes, file.unix_mode));
        if let Err(e) = written {
            let _ = fsops::remove_tree(&staging);
            return Err(e);
        }

        // 旧本体(若有)进废纸篓;没有旧本体时 trash_tree 直接返回 Ok(false)。
        //
        // 🔴 失败(如 macOS Finder 自动化授权被拒)时必须清掉 staging 再返回错误
        // (审查修复轮 1 I-1,以硬约束为准,不是任务书那版裸 `?`):staging 带着完整的
        // SKILL.md,而扫描本地技能的两条路(`share::scan_candidates` 与
        // `converge::scan_all`)都不跳过点开头的目录,残骸留着就会冒出一个叫
        // `.<slug>.skillsync-new` 的幽灵技能。
        // ⚠️ 这里原先写的是"会在**分享列表**里冒出来"——分享页整页已在 v6 二期撤销,
        // 今天它冒在**「我的技能」**上。理由没变,措辞跟着走。
        if let Err(e) = fsops::trash_tree(self.trasher, &home.body) {
            let _ = fsops::remove_tree(&staging);
            return Err(e);
        }
        std::fs::rename(&staging, &home.body).map_err(|e| {
            let _ = fsops::remove_tree(&staging);
            AppError::new("FS_MOVE_FAILED", "技能写入最后一步没能完成,请重试")
                .with_detail(e.to_string())
        })?;

        let mut links = self.link_all(&home.body, &home.dir_name, targets);
        if !home.body_is_canonical() {
            // canonical ← body 的那条:失败也照样进报告,不拦下整次安装。
            links.push(self.canonical_link(home));
        }

        Ok(InstallReport {
            dir_name: home.dir_name.clone(),
            canonical_dir: home.canonical.to_string_lossy().into_owned(),
            links,
        })
    }

    /// 只建链,**不碰本体里的内容**。
    ///
    /// 用于两种场景:①用户改过技能本体、选择保留改动,但仍要把它关联到新的 agent;
    /// ②修复断链。走 [`Self::install`] 会先替换掉本体(旧内容进废纸篓),那正是要避开的事。
    ///
    /// 占位目录一律失败(v6 二期任务 4 起没有第二档了):该不该
    /// 替换由 [`crate::core::converge::converge`] 先比对内容再决定(同→进废纸篓
    /// 换链接,异→停下问用户),不再由调用方传一个裸的布尔开关。
    pub fn link_only(&self, home: &SkillHome, agent_names: &[String]) -> Result<InstallReport, AppError> {
        if !home.body.is_dir() {
            return Err(AppError::new(
                "FS_MISSING_SKILL",
                "这个技能的本体不在了,请重新获取一次",
            )
            .with_detail(format!("body absent: {}", home.body.display())));
        }
        let targets = self.link_targets_for(home, agent_names)?;
        let mut links = self.link_all(&home.body, &home.dir_name, targets);
        if !home.body_is_canonical() {
            links.push(self.canonical_link(home));
        }
        Ok(InstallReport {
            dir_name: home.dir_name.clone(),
            canonical_dir: home.canonical.to_string_lossy().into_owned(),
            links,
        })
    }

    fn link_all(
        &self,
        target: &Path,
        dir_name: &str,
        targets: Vec<LinkTarget>,
    ) -> Vec<LinkReport> {
        targets
            .into_iter()
            .map(|t| {
                let link = t.dir.join(dir_name);
                let result = Self::link_outcome(fsops::link_dir(target, &link, &self.chain));
                LinkReport {
                    dir: t.dir.to_string_lossy().into_owned(),
                    agents: t.agents,
                    result,
                }
            })
            .collect()
    }

    /// canonical ← body 的那条链接(本体不在 canonical 时才需要建)。
    fn canonical_link(&self, home: &SkillHome) -> LinkReport {
        let result = Self::link_outcome(fsops::link_dir(
            &home.body,
            &home.canonical,
            &self.chain,
        ));
        let dir = home
            .canonical
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        LinkReport {
            dir,
            agents: Vec::new(),
            result,
        }
    }

    fn link_outcome(outcome: Result<LinkOutcome, AppError>) -> LinkResult {
        match outcome {
            Ok(LinkOutcome::Created(kind)) => LinkResult::Linked {
                mode: kind.as_str().to_string(),
            },
            Ok(LinkOutcome::Unchanged(kind)) => LinkResult::Unchanged {
                mode: kind.as_str().to_string(),
            },
            Ok(LinkOutcome::SameLocation) => LinkResult::SameLocation,
            Err(error) => LinkResult::Failed { error },
        }
    }

    /// 按记账逐条检查关联的健康态,不动磁盘。
    ///
    /// 输出给「我的技能」页显示:mode 与判定都基于安装时的记账,
    /// 所以降级复制(Copy)的实体目录会被正确认成健康,而不是"被占位"。
    pub fn link_health(
        &self,
        home: &SkillHome,
        recorded: &[RecordedLink],
    ) -> Result<Vec<LinkHealthReport>, AppError> {
        Ok(recorded
            .iter()
            .map(|rec| {
                let link = rec.dir.join(&home.dir_name);
                let health = match (rec.mode, fsops::link_state(&link, &home.body)) {
                    // 降级复制:实体目录在,就是它该有的样子
                    (LinkKind::Copy, LinkState::Real) => LinkHealth::Healthy,
                    (LinkKind::Copy, LinkState::Missing) => LinkHealth::Missing,
                    // 副本被换成了链接/别的形态:不是我们放的那份了
                    (LinkKind::Copy, _) => LinkHealth::Redirected,
                    (_, LinkState::Linked(_)) | (_, LinkState::SameLocation) => LinkHealth::Healthy,
                    (_, LinkState::Broken) => LinkHealth::Broken,
                    (_, LinkState::Foreign(_)) => LinkHealth::Redirected,
                    (_, LinkState::Real) => LinkHealth::Occupied,
                    (_, LinkState::Missing) => LinkHealth::Missing,
                };
                LinkHealthReport {
                    dir: rec.dir.to_string_lossy().into_owned(),
                    mode: rec.mode.as_str().to_string(),
                    health,
                }
            })
            .collect())
    }

    /// 卸载:按记账逐个解除关联,`delete_body` 由前端确认后传入。
    ///
    /// 只处理 `recorded` 里列出的目录。没有记账就不动——降级复制出来的副本在磁盘上
    /// 与用户自己写的技能目录**无从区分**,凭猜测删除就是静默删用户文件。
    pub fn uninstall(
        &self,
        home: &SkillHome,
        recorded: &[RecordedLink],
        delete_body: bool,
    ) -> Result<UninstallReport, AppError> {
        let mut unlinks: Vec<UnlinkReport> = recorded
            .iter()
            .map(|rec| {
                let link = rec.dir.join(&home.dir_name);
                UnlinkReport {
                    dir: rec.dir.to_string_lossy().into_owned(),
                    result: unlink_one(&link, &home.body, rec.mode, self.trasher),
                }
            })
            .collect();

        if !home.body_is_canonical() {
            // canonical → body 那条链接不是用户数据本体,摘掉它不需要按 recorded 走、
            // 也不需要用户确认;摘不掉(它压根不是条链接,比如被别的实体目录占了)也
            // 不该拦下整个卸载——但**失败要并进报告,不能静默吞掉**(审查修复轮 1 I-3):
            // 静默吞的话,界面无从知道 canonical 位置还留着一个没清干净的东西。
            if let Err(error) = fsops::unlink_dir(&home.canonical) {
                unlinks.push(UnlinkReport {
                    dir: home
                        .canonical
                        .parent()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    result: UnlinkResult::Failed { error },
                });
            }
        }

        let canonical_removed = if delete_body {
            fsops::trash_tree(self.trasher, &home.body)?
        } else {
            false
        };

        Ok(UninstallReport {
            dir_name: home.dir_name.clone(),
            unlinks,
            canonical_removed,
        })
    }
}

/// 解除单个目录下的关联。
///
/// 🔴 **降级复制(Copy)出来的实体副本走 [`fsops::trash_tree`],不是 [`fsops::remove_tree`]**
/// (审查修复轮 1 C-1):Windows 上 junction 建链失败会回退成 Copy,agent 目录里那份是
/// **实体副本**——用户完全可能直接在这份副本上编辑过。`trash_tree` 对纯链接与
/// [`fsops::remove_tree`] 语义相同(只摘链接,不进废纸篓),但对实体目录/文件会
/// 送进废纸篓而不是直接删,铁律 7 在这条路上因此从"问过"升级成"可逆"。
///
/// ⚠️ **四句 `Skipped` 的文案写成内联的结构体字面量,不再走 `skip("…")` 闭包**
/// (终审 I-1):它们自此会真的渲染到「我的技能」的失败框里,因而受
/// `tests/terminology.rs::core_visible_reasons` 的禁词表管辖——而那个提取器按
/// `UnlinkResult::Skipped {` 锚定字面量,写在闭包调用点上它一个字都抓不到。
/// 收回闭包省下的几个字符,换来的是一道**看起来在守、实际空转**的守卫。
fn unlink_one(link: &Path, target: &Path, mode: LinkKind, trasher: &dyn Trasher) -> UnlinkResult {
    let state = fsops::link_state(link, target);
    let remove = || match fsops::trash_tree(trasher, link) {
        Ok(true) => UnlinkResult::Unlinked,
        Ok(false) => UnlinkResult::Missing,
        Err(error) => UnlinkResult::Failed { error },
    };

    match (mode, state) {
        (_, LinkState::Missing) => UnlinkResult::Missing,
        // 降级复制:账上说这份副本是我们放的,且磁盘上确实还是个实体目录,才清理。
        (LinkKind::Copy, LinkState::Real) => remove(),
        (LinkKind::Copy, _) => UnlinkResult::Skipped {
            reason: "那个位置上已经不是本应用放的副本了,没有改动它".into(),
        },
        (_, LinkState::Linked(_)) | (_, LinkState::Broken) => remove(),
        (_, LinkState::Foreign(_)) => UnlinkResult::Skipped {
            reason: "那个位置现在指向别处,没有改动它".into(),
        },
        (_, LinkState::Real) => UnlinkResult::Skipped {
            reason: "那个位置上是一个真实的技能文件夹,没有改动它".into(),
        },
        (_, LinkState::SameLocation) => UnlinkResult::Skipped {
            reason: "那个位置就是这个技能本身所在,不需要改动".into(),
        },
    }
}

/// 清洗目录名,并挡住"清洗后不再具有区分度"的输入。
///
/// [`sanitize_name`] 只保留 `[a-z0-9._]`,一个纯中文名会被整体折成 `unnamed-skill`——
/// 于是两个不同的中文技能会装进同一个目录、互相覆盖,这是静默的数据丢失。
/// 此处直接拒绝并给出独立错误码,由上层引导用户补一个合规名字
/// (设计方案 2.5② 的 frontmatter 补齐表单)。
///
/// 假设(文档未覆盖):**不改动 [`sanitize_name`] 本身**。它同时决定 `.skill-lock.json` 的键,
/// 放宽规则会让本 app 与 `npx skills` 对同一技能算出不同目录名,违反铁律 4。
///
/// 只挡"信息全丢"这一档;`周报-v2` 会被清成 `v2`,有损但仍可区分,留待任务 11(收编/分享)
/// 有真实需求时再定策略。
fn usable_dir_name(dir_slug: &str) -> Result<String, AppError> {
    let sanitized = sanitize_name(dir_slug);
    if sanitized == "unnamed-skill" && dir_slug != "unnamed-skill" {
        return Err(AppError::new(
            "FS_UNUSABLE_NAME",
            "这个技能的名称无法作为文件夹名,请改用英文字母、数字或短横线命名",
        )
        .with_detail(format!("name collapses to unnamed-skill: {dir_slug}")));
    }
    Ok(sanitized)
}

fn dir_name_of(canonical: &Path) -> String {
    canonical
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 以真实临时目录为 home 的环境。路径存在性走真实文件系统,以便探测与建链结果一致。
    struct TmpEnv {
        home: PathBuf,
        vars: std::collections::HashMap<String, String>,
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
            fs::read_to_string(path).ok()
        }
    }

    /// `SandboxTrash` 落在临时 HOME 之外的独立目录:装/卸测试里凡是会覆盖或删除
    /// 已有本体的路径都会经过它,绝不能让默认的 `SYSTEM_TRASH` 把测试产物
    /// 丢进这台机器真实的系统废纸篓。
    fn setup() -> (tempfile::TempDir, AgentRegistry, TmpEnv, fsops::SandboxTrash) {
        let tmp = tempfile::tempdir().unwrap();
        let env = TmpEnv {
            home: tmp.path().to_path_buf(),
            vars: std::collections::HashMap::new(),
        };
        let trash = fsops::SandboxTrash::new(tmp.path().join(".test-trash"));
        (tmp, AgentRegistry::builtin(), env, trash)
    }

    fn payload() -> SkillPayload {
        SkillPayload::new()
            .with_file("SKILL.md", "---\nname: 周报\ndescription: 写周报\n---\n正文\n")
            .with_file("模板/周报.md", "模板正文")
    }

    /// 带版本号的正文,给"重装换内容"一类测试用——纯 [`payload`] 内容固定,
    /// 分不清落盘的是旧版还是新版。
    fn versioned_payload(v: &str) -> SkillPayload {
        SkillPayload::new().with_file("SKILL.md", versioned_skill_md(v))
    }

    fn versioned_skill_md(v: &str) -> String {
        format!("---\nname: s\ndescription: d\n---\n{v}\n")
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // ---- SkillHome 解析 ----

    #[test]
    fn home_defaults_to_canonical_and_accepts_a_recorded_body() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);

        let h = inst.home("weekly-report", None).unwrap();
        assert_eq!(
            h.canonical,
            tmp.path().join(".agents").join("skills").join("weekly-report")
        );
        assert_eq!(h.body, h.canonical);
        assert!(h.body_is_canonical());

        let elsewhere = tmp.path().join(".claude").join("skills").join("weekly-report");
        let h = inst.home("weekly-report", Some(&elsewhere)).unwrap();
        assert_eq!(h.body, elsewhere);
        assert!(!h.body_is_canonical());

        let err = inst
            .home("weekly-report", Some(&tmp.path().join(".claude").join("skills").join("other")))
            .unwrap_err();
        assert_eq!(err.code, "FS_BAD_BODY", "账上 body 的目录名必须等于 dir_name");

        // v6 二期任务 5:守卫比的是**清洗后**的叶子名,所以用户手建的大写目录
        // 放得进来(本体不改名不搬家,`dir_name` 仍是清洗后的那个)。
        let upper = tmp.path().join(".claude").join("skills").join("Weekly-Report");
        let h = inst.home("weekly-report", Some(&upper)).unwrap();
        assert_eq!(h.body, upper, "本体叶子名保持字面");
        assert_eq!(h.dir_name, "weekly-report", "canonical 与各处链接一律用清洗后的名字");

        // 🔴 放宽的只有"清洗会折掉的那些差异",守卫本身照旧拦得住:
        // `Weekly_Report` 清洗后是 `weekly_report`(下划线不折成连字符),仍然不等。
        // 少了这条,守卫只有"放宽方向"被钉住,"还拦不拦得住"没人测。
        let err = inst
            .home("weekly-report", Some(&tmp.path().join(".claude").join("skills").join("Weekly_Report")))
            .unwrap_err();
        assert_eq!(err.code, "FS_BAD_BODY", "清洗折不掉的差异必须照旧拦下");
    }

    #[test]
    #[cfg(unix)]
    fn body_is_canonical_survives_a_symlinked_alias_for_the_same_location() {
        // Minor(审查修复轮 1):home() 不做 realpath 归一化,同一处磁盘位置换一条
        // 字面路径写法就会被 `==` 判成"不是 canonical"——macOS 上 `/var` →
        // `/private/var` 就是这么个真实场景(`project_pick` 的守卫已经吃过同一个亏)。
        // 这里用一个软链别名模拟:tmp/alias 整个指向 canonical 根,于是
        // tmp/alias/weekly-report 与 tmp/.agents/skills/weekly-report
        // 是同一处磁盘位置,只是字面路径不同。
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let canonical_base = tmp.path().join(".agents").join("skills");
        fs::create_dir_all(&canonical_base).unwrap();
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(&canonical_base, &alias).unwrap();
        let body_via_alias = alias.join("weekly-report");

        let home = inst.home("weekly-report", Some(&body_via_alias)).unwrap();

        assert_ne!(home.body, home.canonical, "sanity: 字面路径确实不同");
        assert!(
            home.body_is_canonical(),
            "同一处磁盘位置的别名应被判成就是 canonical,不该因为字面路径不同就判假"
        );
    }

    // ---- 只建链,不碰本体 ----

    #[test]
    fn link_only_leaves_the_skill_body_untouched() {
        // 「保留本地改动」走的就是这条路:用户改过的内容必须一个字节都不动
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        inst.install(&home, &payload(), &[]).unwrap();

        let canonical = tmp.path().join(".agents").join("skills").join("weekly-report");
        fs::write(canonical.join("SKILL.md"), "我改过的内容").unwrap();

        inst.link_only(&home, &names(&["claude-code"])).unwrap();

        assert_eq!(fs::read_to_string(canonical.join("SKILL.md")).unwrap(), "我改过的内容");
        // 链接照建
        assert!(tmp.path().join(".claude").join("skills").join("weekly-report").exists());
    }

    #[test]
    fn link_only_refuses_when_the_skill_body_is_gone() {
        // 本体不在还去建链,会造出一堆指向空处的坏链接。这道守卫在获取流程里不可达
        // (那条路上本体不存在就是"全新安装"),但"修复断链"会直接调它。
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("never-installed", None).unwrap();

        let err = inst.link_only(&home, &names(&["claude-code"])).unwrap_err();

        assert_eq!(err.code, "FS_MISSING_SKILL");
        assert!(err.message.contains("重新获取"), "{}", err.message);
    }

    // ---- 本体落盘 ----

    #[test]
    fn writes_payload_into_canonical_dir() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();

        let report = inst.install(&home, &payload(), &[]).unwrap();

        let canonical = tmp.path().join(".agents").join("skills").join("weekly-report");
        assert_eq!(report.canonical_dir, canonical.to_string_lossy());
        assert!(canonical.join("SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(canonical.join("模板").join("周报.md")).unwrap(),
            "模板正文"
        );
    }

    #[test]
    fn skill_name_is_sanitized_and_can_never_escape_canonical_base() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let base = tmp.path().join(".agents").join("skills");
        let home = inst.home("../evil-skill", None).unwrap();

        let report = inst.install(&home, &payload(), &[]).unwrap();

        assert!(
            Path::new(&report.canonical_dir).starts_with(&base),
            "落盘位置必须在 canonical 之内: {}",
            report.canonical_dir
        );
        assert!(!tmp.path().join("evil-skill").exists());
    }

    #[test]
    fn payload_paths_cannot_escape_the_skill_dir() {
        // 压缩包内容来自技能库,属不可信输入(zip slip)。
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        let evil = SkillPayload::new().with_file("../../坏文件", "不该写到这里");

        let err = inst.install(&home, &evil, &[]).unwrap_err();

        assert_eq!(err.code, "FS_UNSAFE_PATH");
        assert!(!tmp.path().join(".agents").join("坏文件").exists());
        assert!(!tmp.path().join("坏文件").exists());
    }

    #[test]
    fn a_name_that_sanitizes_to_nothing_is_rejected_instead_of_colliding() {
        // 纯中文名会被上游清洗规则整体折成 unnamed-skill,两个技能就会装进同一个目录互相覆盖。
        // 这道拒绝现在发生在 home() 这一层(canonical_dir 的清洗在这里被首先触达)。
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);

        let err = inst.home("周报生成", None).unwrap_err();

        assert_eq!(err.code, "FS_UNUSABLE_NAME");
        assert!(!tmp
            .path()
            .join(".agents")
            .join("skills")
            .join("unnamed-skill")
            .exists());
    }

    #[test]
    fn reinstall_clears_files_removed_upstream() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        inst.install(&home, &payload().with_file("旧文件.md", "上一版才有"), &[]).unwrap();

        inst.install(&home, &payload(), &[]).unwrap();

        let canonical = tmp.path().join(".agents").join("skills").join("weekly-report");
        assert!(!canonical.join("旧文件.md").exists(), "上一版遗留文件必须清掉");
        assert!(canonical.join("SKILL.md").exists());
    }

    #[test]
    fn reinstall_moves_the_old_body_to_trash_before_writing() {
        // 铁律 7 在这里的落点是"可逆",不是"清空重建"——旧本体连同用户自己加的文件
        // 整份进废纸篓,不是被直接删掉。
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("s", None).unwrap();
        inst.install(&home, &versioned_payload("v1"), &[]).unwrap();
        fs::write(home.body.join("notes.md"), "user file").unwrap();

        inst.install(&home, &versioned_payload("v2"), &[]).unwrap();

        assert_eq!(fs::read_to_string(home.body.join("SKILL.md")).unwrap(), versioned_skill_md("v2"));
        assert!(!home.body.join("notes.md").exists());
        assert_eq!(trash.trashed().len(), 1);
        assert!(trash.into.join("s").join("notes.md").is_file(), "旧本体整份在废纸篓里");
        assert!(
            !home.body.parent().unwrap().join(".s.skillsync-new").exists(),
            "临时目录不残留"
        );
    }

    #[test]
    fn a_failed_write_leaves_the_old_body_and_staging_untouched() {
        // "先落到 staging、再腾出本体位置、最后 rename" 这个写入顺序唯一的存在理由
        // 就是这条(审查修复轮 1 I-2):写到一半失败时旧本体必须原封不动。删掉整段
        // 错误处理这条测试也应该变红——用 BTreeMap 的键序制造一次必然失败的写入:
        // "a" 排在 "a/b" 之前(短字符串是长字符串的前缀,天然排前面),
        // 先把 "a" 写成文件,"a/b" 再想在它下面建目录就必然失败。
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("s", None).unwrap();
        inst.install(&home, &versioned_payload("v1"), &[]).unwrap();
        let old_body_content = fs::read_to_string(home.body.join("SKILL.md")).unwrap();

        let broken = SkillPayload::new()
            .with_file("SKILL.md", versioned_skill_md("v2"))
            .with_file("a", "占位")
            .with_file("a/b", "冲突");

        let err = inst.install(&home, &broken, &[]).unwrap_err();

        assert!(err.code.starts_with("FS_"), "{}", err.code);
        assert_eq!(
            fs::read_to_string(home.body.join("SKILL.md")).unwrap(),
            old_body_content,
            "写入失败时旧本体必须原封不动"
        );
        assert!(
            !home.body.parent().unwrap().join(".s.skillsync-new").exists(),
            "staging 不该残留"
        );
        assert!(trash.trashed().is_empty(), "还没到该把旧本体送进废纸篓的那一步");
    }

    #[test]
    fn a_failed_trash_of_the_old_body_leaves_no_staging_ghost() {
        // I-1(审查修复轮 1,以硬约束为准,不按任务书那版裸 `?`):trash_tree 失败
        // (比如 macOS Finder 自动化授权被拒)时,staging 残骸必须清掉——它带着完整的
        // SKILL.md,而扫描本地技能的两条路(`share::scan_candidates` 与
        // `converge::scan_all`)都不跳过点开头的目录,留着就会在「我的技能」上
        // 冒出一个叫 `.<slug>.skillsync-new` 的幽灵技能(分享页整页已撤,
        // 这句话此前还写着"分享列表")。
        struct BrokenTrasher;
        impl Trasher for BrokenTrasher {
            fn trash(&self, _: &Path) -> Result<(), AppError> {
                Err(AppError::new(
                    "FS_TRASH_FAILED",
                    "没能把文件移到废纸篓,请手动处理后重试",
                ))
            }
        }

        let (_tmp, reg, env, _trash) = setup();
        let inst = Installer::new(&reg, &env);
        let home = inst.home("s", None).unwrap();
        inst.install(&home, &versioned_payload("v1"), &[]).unwrap();

        let broken_inst = Installer::new(&reg, &env).with_trasher(&BrokenTrasher);
        let err = broken_inst.install(&home, &versioned_payload("v2"), &[]).unwrap_err();

        assert_eq!(err.code, "FS_TRASH_FAILED");
        assert!(
            !home.body.parent().unwrap().join(".s.skillsync-new").exists(),
            "staging 残骸不该留下(会被 share::scan_candidates 当成幽灵技能)"
        );
        // 旧本体因为 trash 失败而原地不动
        assert_eq!(
            fs::read_to_string(home.body.join("SKILL.md")).unwrap(),
            versioned_skill_md("v1")
        );
    }

    #[test]
    #[cfg(unix)]
    fn executable_bit_survives_installation() {
        use std::os::unix::fs::PermissionsExt;
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("with-scripts", None).unwrap();

        inst.install(&home, &payload().with_executable("run.sh", "#!/bin/sh\n"), &[]).unwrap();

        let script = tmp
            .path()
            .join(".agents/skills/with-scripts/run.sh".replace('/', std::path::MAIN_SEPARATOR_STR));
        let mode = fs::metadata(script).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111);
    }

    // ---- 建链目标集合 ----

    #[test]
    fn canonical_dir_is_never_a_link_target() {
        // zed/cline/warp 等的 globalSkillsDir 就是 canonical 本身。
        // 若把它当成建链目标,"解除 zed 的关联"就等于删掉技能本体。
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let canonical_base = tmp.path().join(".agents").join("skills");

        let targets = inst
            .link_targets(&names(&["zed", "cline", "warp", "claude-code"]))
            .unwrap();

        assert!(targets.iter().all(|t| t.dir != canonical_base));
        assert!(targets
            .iter()
            .any(|t| t.dir == tmp.path().join(".claude").join("skills")));
    }

    #[test]
    fn an_agent_whose_dir_resolves_to_canonical_is_not_a_link_target() {
        // 真实可达:CLAUDE_CONFIG_DIR 指到 ~/.agents 时,claude-code 的技能目录就等于 canonical。
        // 此时若把它当建链目标,建链会在 canonical 里造出自指软链,解链则直接删掉技能本体。
        let (tmp, reg, mut env, trash) = setup();
        env.vars.insert(
            "CLAUDE_CONFIG_DIR".into(),
            tmp.path().join(".agents").to_string_lossy().into_owned(),
        );
        let inst = Installer::new(&reg, &env).with_trasher(&trash);

        let targets = inst.link_targets(&names(&["claude-code"])).unwrap();

        assert!(
            targets.is_empty(),
            "目录等同 canonical 的 agent 不得成为建链目标: {targets:?}"
        );
    }

    #[test]
    fn universal_agents_produce_no_link_target() {
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);

        let targets = inst.link_targets(&names(&["cursor", "codex"])).unwrap();

        assert!(targets.is_empty(), "universal agent 落在 canonical 即可见");
    }

    #[test]
    fn agents_sharing_a_directory_yield_one_target() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);

        let targets = inst.link_targets(&names(&["zencoder", "zenflow"])).unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].dir, tmp.path().join(".zencoder").join("skills"));
        assert_eq!(targets[0].agents, names(&["zencoder", "zenflow"]));
    }

    #[test]
    fn agents_without_global_support_are_dropped() {
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);

        let targets = inst.link_targets(&names(&["eve", "promptscript"])).unwrap();

        assert!(targets.is_empty());
    }

    #[test]
    fn unknown_agent_name_is_rejected() {
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);

        let err = inst.link_targets(&names(&["根本没有这个"])).unwrap_err();

        assert_eq!(err.code, "FS_UNKNOWN_AGENT");
    }

    // ---- 本体不在 canonical(v6 二期)----

    #[test]
    fn install_writes_into_body_and_links_canonical_when_body_is_elsewhere() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let body = tmp.path().join(".claude").join("skills").join("s");
        let home = inst.home("s", Some(&body)).unwrap();

        inst.install(&home, &versioned_payload("v1"), &[]).unwrap();

        assert_eq!(fs::read_to_string(body.join("SKILL.md")).unwrap(), versioned_skill_md("v1"));
        assert_eq!(
            fsops::read_link_target(&home.canonical),
            Some(fsops::normalize(&body)),
            "canonical 是指向 body 的链接"
        );
    }

    #[test]
    fn link_targets_skip_the_directory_that_holds_the_body() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let body = tmp.path().join(".claude").join("skills").join("s");
        let home = inst.home("s", Some(&body)).unwrap();

        let targets = inst
            .link_targets_for(&home, &names(&["claude-code", "trae"]))
            .unwrap();

        assert!(
            targets.iter().all(|t| t.dir != tmp.path().join(".claude").join("skills")),
            "本体所在的工具目录不作为链接位置"
        );
        assert!(targets.iter().any(|t| t.dir == tmp.path().join(".trae").join("skills")));
    }

    // ---- 安装建链 ----

    #[test]
    fn install_links_every_non_universal_agent_dir() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();

        let report = inst
            .install(&home, &payload(), &names(&["claude-code", "trae", "trae-cn", "cursor"]))
            .unwrap();

        assert_eq!(report.links.len(), 3, "cursor 是 universal,不建链");
        for dir in [".claude", ".trae", ".trae-cn"] {
            let link = tmp.path().join(dir).join("skills").join("weekly-report");
            assert_eq!(
                fs::read_to_string(link.join("模板").join("周报.md")).unwrap(),
                "模板正文",
                "{dir} 未能读到技能内容"
            );
        }
        assert!(report
            .links
            .iter()
            .all(|l| matches!(l.result, LinkResult::Linked { .. })));
    }

    #[test]
    fn one_blocked_directory_does_not_abort_the_others() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        // 用户自己在 ~/.claude/skills/weekly-report 写过一个同名技能
        let occupied = tmp.path().join(".claude").join("skills").join("weekly-report");
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("SKILL.md"), "我自己写的").unwrap();

        let report = inst.install(&home, &payload(), &names(&["claude-code", "trae"])).unwrap();

        let claude = report
            .links
            .iter()
            .find(|l| l.dir.contains(".claude"))
            .unwrap();
        assert!(matches!(claude.result, LinkResult::Failed { .. }));
        assert_eq!(
            fs::read_to_string(occupied.join("SKILL.md")).unwrap(),
            "我自己写的"
        );
        let trae = report.links.iter().find(|l| l.dir.contains(".trae")).unwrap();
        assert!(matches!(trae.result, LinkResult::Linked { .. }));
    }

    #[test]
    fn reinstall_reports_unchanged_links() {
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        let agents = names(&["claude-code"]);
        inst.install(&home, &payload(), &agents).unwrap();

        let again = inst.install(&home, &payload(), &agents).unwrap();

        assert!(matches!(
            again.links[0].result,
            LinkResult::Unchanged { .. }
        ));
    }

    // ---- 卸载 ----

    fn recorded(dirs: &[PathBuf]) -> Vec<RecordedLink> {
        dirs.iter()
            .map(|d| RecordedLink {
                dir: d.clone(),
                mode: LinkKind::Symlink,
            })
            .collect()
    }

    #[test]
    fn uninstall_unlinks_recorded_dirs_and_keeps_canonical_by_default() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        let agents = names(&["claude-code", "trae"]);
        inst.install(&home, &payload(), &agents).unwrap();
        let dirs = vec![
            tmp.path().join(".claude").join("skills"),
            tmp.path().join(".trae").join("skills"),
        ];

        let report = inst.uninstall(&home, &recorded(&dirs), false).unwrap();

        assert!(report
            .unlinks
            .iter()
            .all(|u| matches!(u.result, UnlinkResult::Unlinked)));
        assert!(!report.canonical_removed);
        let canonical = tmp.path().join(".agents").join("skills").join("weekly-report");
        assert!(canonical.join("SKILL.md").exists(), "本体默认保留");
        for d in &dirs {
            let link = d.join("weekly-report");
            assert!(
                std::fs::symlink_metadata(&link).is_err(),
                "卸载后不得留下断链: {}",
                link.display()
            );
        }
    }

    #[test]
    fn uninstall_removes_canonical_when_confirmed() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        inst.install(&home, &payload(), &[]).unwrap();

        let report = inst.uninstall(&home, &[], true).unwrap();

        assert!(report.canonical_removed);
        assert!(!tmp.path().join(".agents").join("skills").join("weekly-report").exists());
    }

    #[test]
    #[cfg(unix)]
    fn uninstall_leaves_links_the_user_repointed_elsewhere() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("weekly-report", None).unwrap();
        let agents = names(&["claude-code"]);
        inst.install(&home, &payload(), &agents).unwrap();
        // 用户把链接改指到自己的目录
        let mine = tmp.path().join("我的周报");
        fs::create_dir_all(&mine).unwrap();
        let link = tmp.path().join(".claude").join("skills").join("weekly-report");
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&mine, &link).unwrap();
        let dirs = vec![tmp.path().join(".claude").join("skills")];

        let report = inst.uninstall(&home, &recorded(&dirs), false).unwrap();

        assert!(matches!(
            report.unlinks[0].result,
            UnlinkResult::Skipped { .. }
        ));
        assert!(link.exists(), "指向别处的链接不属于我们,不得删除");
    }

    #[test]
    fn uninstall_removes_copy_mode_dir_only_with_a_record() {
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash).with_chain(vec![LinkKind::Copy]);
        let home = inst.home("weekly-report", None).unwrap();
        let agents = names(&["claude-code"]);
        inst.install(&home, &payload(), &agents).unwrap();
        let dir = tmp.path().join(".claude").join("skills");
        let copied = dir.join("weekly-report");
        assert!(copied.join("SKILL.md").exists());

        // 无记录:磁盘上分辨不出这是我们的副本还是用户自己的目录,必须跳过
        let no_record = inst.uninstall(&home, &[], false).unwrap();
        assert!(no_record.unlinks.is_empty());
        assert!(copied.exists());

        let with_record = inst
            .uninstall(
                &home,
                &[RecordedLink {
                    dir: dir.clone(),
                    mode: LinkKind::Copy,
                }],
                false,
            )
            .unwrap();
        assert!(matches!(
            with_record.unlinks[0].result,
            UnlinkResult::Unlinked
        ));
        assert!(!copied.exists());
        // C-1(审查修复轮 1):降级复制出来的实体副本必须走废纸篓,不是直接物理删——
        // 用户完全可能在这份副本上编辑过,直接删就是铁律 7 在这条路上从"可逆"退回"问过"。
        assert_eq!(trash.trashed(), vec![copied.clone()]);
        assert!(trash.into.join("weekly-report").join("SKILL.md").is_file(), "副本整份在废纸篓里");
    }

    #[test]
    fn uninstalling_something_never_installed_is_harmless() {
        let (_tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let home = inst.home("never-installed", None).unwrap();

        let report = inst.uninstall(&home, &[], true).unwrap();

        assert!(!report.canonical_removed);
    }

    // ---- 卸载:本体不在 canonical(v6 二期,审查修复轮 1 I-3)----

    #[test]
    fn uninstall_unlinks_canonical_and_trashes_the_body_when_they_differ() {
        // 此前这一档(body ≠ canonical)在 uninstall 里完全没有测试覆盖——
        // installer.rs 里已经有构造这种 SkillHome 的先例
        // (install_writes_into_body_and_links_canonical_when_body_is_elsewhere),
        // 补齐不需要新的基建。
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let body = tmp.path().join(".claude").join("skills").join("s");
        let home = inst.home("s", Some(&body)).unwrap();
        inst.install(&home, &payload(), &[]).unwrap();
        assert!(
            fsops::read_link_target(&home.canonical).is_some(),
            "前置:canonical 应是指向 body 的链接"
        );

        let report = inst.uninstall(&home, &[], true).unwrap();

        assert!(
            std::fs::symlink_metadata(&home.canonical).is_err(),
            "canonical 那条链接应被摘掉,位置应完全清空"
        );
        assert!(report.canonical_removed);
        assert!(!home.body.exists(), "本体应从原位消失");
        assert_eq!(trash.trashed(), vec![home.body.clone()]);
    }

    #[test]
    fn uninstall_reports_a_failed_canonical_unlink_instead_of_swallowing_it() {
        // canonical 位置被一个与本应用无关的实体目录占了(不是我们建的链接):
        // 摘不掉,但**不能悄悄吞掉**——之前是 `let _ = fsops::unlink_dir(..)`,
        // 界面完全看不出 canonical 位置还留着一个没清干净的东西。
        let (tmp, reg, env, trash) = setup();
        let inst = Installer::new(&reg, &env).with_trasher(&trash);
        let body = tmp.path().join(".claude").join("skills").join("s");
        let canonical = tmp.path().join(".agents").join("skills").join("s");
        fs::create_dir_all(&canonical).unwrap();
        fs::write(canonical.join("SKILL.md"), "别处的东西").unwrap();
        let home = inst.home("s", Some(&body)).unwrap();
        // canonical 链接会因为占位而建链失败,但不阻断安装本身
        inst.install(&home, &payload(), &[]).unwrap();

        let report = inst.uninstall(&home, &[], true).unwrap();

        assert!(
            report.unlinks.iter().any(|u| matches!(
                &u.result,
                UnlinkResult::Failed { error } if error.code == "FS_NOT_A_LINK"
            )),
            "canonical 摘不掉的失败必须并进报告: {:?}",
            report.unlinks
        );
        // 那个与本应用无关的实体目录一个字节都不该被动
        assert_eq!(fs::read_to_string(canonical.join("SKILL.md")).unwrap(), "别处的东西");
    }
}
