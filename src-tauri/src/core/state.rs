//! 本地状态:`config.json` / `state.json` 读写与 schema 版本闸门。
//!
//! 落点 `~/.skillsync/`。两份文件顶部必带 `schemaVersion`(交接包 3.4)。
//!
//! 三条不可让步的规则:
//! 1. **遇到比自己新的 schema 一律只读**,绝不写回——写回等于用旧结构覆盖新结构,是不可逆的数据破坏;
//! 2. **文件损坏时报错而非静默重置**,用户的安装记录比"程序能跑下去"重要;
//! 3. **写入是原子的**(临时文件 + rename),断电或崩溃只会留下旧版本,不会留下半截文件。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::agents::AgentEnv;
use crate::error::AppError;

/// 当前 schema 版本。加新版本时:提升此值,并在 `migrate` 里补一段 `n => n+1` 的搬运。
///
/// **v2**(2026-08-06):技能检查间隔的单位从**小时**换成**分钟**——加 5 分钟档时
/// 小时字段表达不了。这是本项目第一次真的走迁移链;`migrate` 的形态一直备着,
/// 就是为了这一天不用临时造轮子。
pub const SCHEMA_VERSION: u32 = 2;

const APP_DIR: &str = ".skillsync";
const CONFIG_FILE: &str = "config.json";
const STATE_FILE: &str = "state.json";

/// 文件的打开方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum Access {
    ReadWrite,
    /// 文件来自更新版本的本应用。界面须提示升级,且一切写入都会被拒绝。
    ReadOnly { found: u32 },
}

#[derive(Debug, Clone)]
pub struct Loaded<T> {
    pub value: T,
    pub access: Access,
}

// ============================================================ config.json

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub schema_version: u32,
    #[serde(default)]
    pub registries: Vec<RegistryConfig>,
    /// 内建源上用户追加的技能库(M4 任务 1)。只存 owner/repo/branch/展示名,
    /// **base_url 永远取编译期常量**——同源由构造保证;内建主仓本身仍不落盘
    /// (坐标是编译期常量,落盘会造出第二份真相),这里只有"追加"的部分。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub builtin_extra_repos: Vec<RepoConfig>,
    /// 技能广场(skills.sh,M9 任务 2)锁定源 `plaza` 上,用户实际接触过的技能库坐标。
    /// 与 `builtin_extra_repos` 同一种处理:`plaza` 本身不落盘(id/base_url 是编译期
    /// 同款的常量,见 `core::registry::PLAZA_REGISTRY_ID`),这里只存追加坐标——
    /// 加可选字段不升 `SCHEMA_VERSION`(先例见上一条字段)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plaza_repos: Vec<RepoConfig>,
    /// 用户装过技能的项目目录路径,最近用的在前(v5)。
    ///
    /// **只是路径清单,不是技能记账**:项目里装了什么、装的哪个版本,真相全在各项目根的
    /// `skills-lock.json` 里(与 `npx skills` 共用同一份,天然互认)。这里记路径只为了
    /// 界面能把「我的技能」的项目分区列出来、以及提供「最近项目」快捷入口。
    /// 项目被删或移走时这条记录天然降级成"目录不存在",不留孤儿记账。
    /// 加可选字段不升 `SCHEMA_VERSION`(先例见 `plaza_repos`)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
    #[serde(default)]
    pub auto_update: AutoUpdate,
    /// 界面偏好。`None` = 从未设置过(前端据此做 localStorage 一次性迁移),
    /// 与 `Some(默认值)` 是两种不同状态,所以不能用 `#[serde(default)]` 折掉。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<UiPrefs>,
    /// 用户上次看过更新日志的版本号(目标 ②)。
    ///
    /// **必须落盘,不能用进程内状态**:`app_update::ReadyState` 记的是"装好了等重启",
    /// 重启即作废——而"刚升级完"这件事恰恰只在重启之后才成立。落盘还顺带覆盖了
    /// 自更新之外的升级方式(同事直接发个新包过来),那条路根本不经过 updater。
    ///
    /// 🔴 **刻意放在顶层而不是塞进 `ui`**:上面那个 `Option` 的 `None` 有独立语义
    /// (从未设置过外观 → 前端做 localStorage 一次性迁移)。把这个标记放进去的话,
    /// 第一次写"已读"就会把 `ui` 物化成 `Some(默认值)`,**用户存在 localStorage 里的
    /// 主题从此丢失**——一个与外观毫无关系的动作,毁掉外观设置。它也确实不是外观偏好。
    ///
    /// 缺席时分不出"存量用户第一次升上来"与"全新安装",靠 `ui.wizard_done` 区分
    /// (见 `release_notes::pending`)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_version: Option<String>,
    /// 用户在设置页关掉的 agent(存 agent name)。语义只有一条:**不进默认勾选**
    /// (获取流程与向导);已装技能的既有关联不动,手动勾选也不拦。
    /// 假设(M2 任务 2,文档未覆盖):按"禁用名单"记而不是"启用名单"——
    /// 注册表会随版本新增 agent,新 agent 默认应当可用,白名单会把它们全关掉。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_agents: Vec<String>,
    /// 登录身份,按 registryId 分开存(v6 任务 1,`core::ownership::relation` 的输入)。
    /// 由 `session.rs` 在登录成功/查状态刷新时写入,退出登录时删除对应键——
    /// 落盘而不是进程内状态,因为"技能是不是我分享的"这个判定要跨重启成立。
    /// 加可选字段不升 `SCHEMA_VERSION`(先例见 `plaza_repos`/`projects`)。
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub identities: std::collections::BTreeMap<String, crate::core::ownership::Identity>,
}

/// 界面偏好(M2 任务 1 起落盘,此前在前端 localStorage)。
///
/// 取值集合与前端 `store/appearance.ts` 的类型一一对应,写入前经 [`UiPrefs::validate`]
/// 把关——config.json 是跨版本的长命文件,进来什么就得认什么,垃圾值只能挡在门外。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPrefs {
    /// `light` / `dark` / `system`
    pub theme: String,
    /// `clay` / `teal` / `ink`
    pub accent: String,
    /// 首次启动向导是否已完成(「每台机器一次」的标记,随偏好同档落盘)。
    #[serde(default)]
    pub wizard_done: bool,
}

impl UiPrefs {
    pub fn validate(&self) -> Result<(), AppError> {
        let theme_ok = matches!(self.theme.as_str(), "light" | "dark" | "system");
        let accent_ok = matches!(self.accent.as_str(), "clay" | "teal" | "ink");
        if theme_ok && accent_ok {
            return Ok(());
        }
        Err(
            AppError::new("STATE_INVALID_PREFS", "外观设置的取值不合法,请重新选择").with_detail(
                format!("theme={:?} accent={:?}", self.theme, self.accent),
            ),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    pub owner: String,
    pub repo: String,
    pub branch: String,
    /// 界面展示名(M4 任务 1)。`None` 时界面回退 repo slug——
    /// slug 是 ASCII kebab 不算内部标识,但允许用户起个人话名字。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdate {
    pub skills: SkillAutoUpdate,
    pub app: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAutoUpdate {
    pub enabled: bool,
    /// 检查间隔(**分钟**)。v1 存的是 `intervalHours`,读取路径上换算过来。
    pub interval_minutes: u32,
}

impl Default for AutoUpdate {
    fn default() -> Self {
        Self {
            skills: SkillAutoUpdate {
                enabled: true,
                // 全新安装盯紧一点(2026-08-06 用户拍板):装上就能及时拿到技能库的新内容,
                // 不用先摸进设置页找档位。老用户不受影响——他们的档位由 v1→v2 迁移
                // 原样带过来(4 小时 → 240 分钟),不会被这个默认值覆盖。
                interval_minutes: 5,
            },
            app: true,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            registries: Vec::new(),
            builtin_extra_repos: Vec::new(),
            plaza_repos: Vec::new(),
            projects: Vec::new(),
            auto_update: AutoUpdate::default(),
            ui: None,
            last_seen_version: None,
            disabled_agents: Vec::new(),
            identities: std::collections::BTreeMap::new(),
        }
    }
}

// ============================================================ state.json

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub schema_version: u32,
    #[serde(default)]
    pub installed: Vec<InstalledSkill>,
    #[serde(default)]
    pub shared: Vec<SharedSkill>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            installed: Vec::new(),
            shared: Vec::new(),
        }
    }
}

/// `InstalledSkill.origin` 的第三个取值(v6 二期):本体本来就住在某个工具目录、
/// 被"就地收进管理"而来的记账——与 `acquire::ORIGIN_ACQUIRED`(本 app 下载装的)、
/// `acquire::ORIGIN_CLAIMED`(分享直推后自动记账)是同一族的第三种来历。
///
/// ⚠️ 本任务(v6 二期任务 2)只声明这个常量,**尚无任何写入路径会用到它**——
/// "就地收进管理"这个动作本身是后续任务的范围。留在这里是为了让常量本身与它
/// 描述的语义同批登记,不必等到真正实现那一天再补文档。
pub const ORIGIN_ADOPTED: &str = "adopted";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    /// 仓库中的技能目录名,也是 canonical 与各 agent 目录下的目录名(见 installer 的 `dir_slug`)。
    pub name: String,
    pub source: SkillSource,
    pub commit_sha: String,
    /// 安装当时 canonical 目录的内容 hash。与当前实际值不符即说明用户改过本体。
    pub content_hash: String,
    pub agents: Vec<String>,
    /// 这条记账是怎么来的。`Some("claimed")` = 曾经的「纳入管理」认领而来
    /// (`skill_claim`/`skill_unclaim` 已随 v6 删除,见 `core::acquire::ORIGIN_CLAIMED`
    /// 的文档),或分享直推后 `share::adopt_into_management` 自动记账——两种情况都是
    /// "文件不是本 app 装的,本 app 只记了账"。
    ///
    /// v6 起技能与"我"的关系不再靠这个字段驱动(改由 `core::ownership::relation`
    /// 从技能库 `authors.json` 现场判定),这里**只读、不再由用户动作写入新值**。
    ///
    /// `None` 是旧版 state 的存量条目(serde default),此时退回判据
    /// `commit_sha.is_empty()`——已实证 `state.installed` 只有两处写入,
    /// 正常安装写远端 sha,只有当年的 claim 留空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 本体的实际位置(v6 二期)。`None` = 没记账过,或本体就住在 canonical
    /// ——两种情况下 `converge::home_of` 都会落回 canonical,这也是迄今为止
    /// 唯一真实存在过的形态。`Some` 时是账上记的绝对路径,目录名必须与
    /// `name` 一致(`Installer::home` 的 `FS_BAD_BODY` 守卫)。
    ///
    /// 本任务(v6 二期任务 2)尚无任何写入路径会填非 `None` 值——把本体「留在
    /// 原地收进管理」是后续任务的范围,这里先把字段与读取路径打通。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// 逐目录的关联记账。
    ///
    /// 设计方案 2.4 写的是单个 `linkMode`,但任务 6 确认关联是**按目录**建立的,
    /// 同一次安装里不同目录完全可能落在不同档(一个建成 junction、另一个降级复制),
    /// 且卸载时必须凭这份记账才敢动降级复制出来的副本。故此处按目录记。
    #[serde(default)]
    pub links: Vec<LinkRecord>,
    pub installed_at: String,
    pub updated_at: String,
}

impl InstalledSkill {
    /// 这条记账有没有一个真实的来源技能库——`registry_id`/`owner`/`repo` 三者皆非空
    /// 才算数(与 `SkillSource` 各字段"必填但可以是空字符串占位"的既有口径一致)。
    ///
    /// **这是判断"这条记账有没有来源"的唯一判据,下游不得各自手搓**——本项目最贵的
    /// 教训就是同一判定散在多处各自漂移。`origin == Some(ORIGIN_ADOPTED)` 的账
    /// (`converge::keep_version`/`converge::set_agents` 首次给纯本地技能建账)
    /// 用空字符串占位三个字段,因为它压根没有经过任何技能库,`has_source()` 对它
    /// 恒为 `false`;正常获取/分享直推来的账三个字段都是真值,恒为 `true`。
    ///
    /// 已知至少四处下游判据都得先问这一句,才不会对着一条没有来源的记账做出
    /// "这是从另一个技能库装的"(`acquire::precheck` 的 `OtherLibrary`)、
    /// "来源已移除"(`my_skills::library_reachability`)之类的误判——接线在
    /// 各自任务里做,这里只登记这唯一的判据。
    pub fn has_source(&self) -> bool {
        !self.source.registry_id.is_empty() && !self.source.owner.is_empty() && !self.source.repo.is_empty()
    }

    /// 这个技能在**技能库里的原始目录名**(取 `source.path` 的末段)。
    ///
    /// 🔴 **`name` 不是它**(v6 二期任务 4 修复轮 2):`name` 是**清洗后**的目录名
    /// (`sanitize_name`,会小写化),那是 canonical 与各工具目录下的落点、也是
    /// 这本账自己的键;而 `store::IndexedSkill::dir_slug` 是**仓库里的原始目录名,
    /// 一个字符都不清洗**。拿 `name` 去索引里找技能,`Weekly-Report` 这样的目录名
    /// **必然找不到**——`acquire::acquire_batch` 会给出「已不在该技能库中」,于是
    /// 那个技能**每一轮定时更新都被静默跳过**,还不报任何错。
    ///
    /// **这是"从账上推出取数用的目录名"的唯一判据,下游不得各自手搓**(理由同
    /// [`Self::has_source`])。判据本身与 v5 项目级那条同款:
    /// `project::update_target` 就是从 lock 的 `skillPath` 倒数第二段推目录名,
    /// **推不出来就不摆更新按钮**(不做比做错好)。这里对应的姿势是**跳过并说人话**,
    /// 绝不静默当成功。
    ///
    /// 🔴 **这不是启发式,是对索引侧的等价重算**(复审给的判据,写在这里防住
    /// 后来人"顺手改成更聪明的猜法"):`store::build_index` 里
    /// `dir_slug = s.dir.rsplit('/').next()`、`path = s.dir.strip_prefix(root_prefix)`,
    /// 而 `root_prefix` **以 `/` 结尾**——剥掉一个以 `/` 收尾的前缀不可能改变最后
    /// 一个 `/` 分段,所以 `rsplit(path) ≡ rsplit(s.dir) ≡ dir_slug` 是**恒等**,
    /// 不是"大多数时候成立"。
    ///
    /// **没有目录分隔符时返回整串**,这也是等式的一部分而不是兜底:技能直接躺在
    /// 仓根时 `path` 本身就没有分隔符,索引侧那边 `dir_slug` 同样等于整串,两侧一致。
    ///
    /// 返回 `None` 的只有一种形状:`path` 去掉尾部 `/` 之后为空(即 `path` 是
    /// `""` / `"/"` / `"//"` 这类)。⚠️ **`"skills/"` 不在此列**——尾斜杠先被
    /// `trim_end_matches` 去掉,它返回 `Some("skills")`(八种形状逐个实测过)。
    /// 存量记账的 `path` 一直是 `skills/<目录名>` 这个形状(`acquire::source_of`
    /// 写的就是 `IndexedSkill::path`),所以 `None` 只可能来自手改过的 `state.json`
    /// 或空来源账。
    ///
    /// (v6 二期任务 4 收尾订正:原注释写「或没有目录分隔符返回 `None`」是**假话**
    /// ——`rsplit` 对任何字符串都至少产出一项,那个 `?` 从来不会触发,是**死出口**,
    /// 读的人会以为它就是 `None` 的来源。现在改成显式的 `rsplit_once` 分支,
    /// 行为逐字节不变,但没有永不触发的路径可以误导人。)
    pub fn library_dir_slug(&self) -> Option<String> {
        let path = self.source.path.trim_end_matches('/');
        let last = match path.rsplit_once('/') {
            Some((_, last)) => last,
            // 没有分隔符 = 技能就在仓根,整串就是目录名(见上,与索引侧一致)
            None => path,
        };
        (!last.is_empty()).then(|| last.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRecord {
    pub dir: String,
    /// `symlink` / `junction` / `copy`,取自 `fsops::LinkKind::as_str`。
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSource {
    pub registry_id: String,
    pub owner: String,
    pub repo: String,
    pub path: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSkill {
    pub name: String,
    pub local_path: String,
    /// `local` | `npx-skills`
    pub origin: String,
    pub target: SkillSource,
    pub last_pushed_sha: String,
    /// 上次分享时本地目录的内容 hash。与当前实际值不符 = 有未分享的改动。
    ///
    /// 旧版 state 没有这个字段(serde default 补空串):空串永远不等于实际 hash,
    /// 效果是"显示可再推"——宁可多推一次,也不把用户的改动藏起来。
    #[serde(default)]
    pub content_hash: String,
}

// ============================================================ 读写

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// 生产落点 `~/.skillsync`。
    pub fn for_env(env: &dyn AgentEnv) -> Option<Self> {
        Some(Self::new(env.home()?.join(APP_DIR)))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn load_config(&self) -> Result<Loaded<Config>, AppError> {
        load(&self.dir.join(CONFIG_FILE))
    }

    pub fn save_config(&self, value: &Config) -> Result<(), AppError> {
        save(&self.dir.join(CONFIG_FILE), value)
    }

    pub fn load_state(&self) -> Result<Loaded<State>, AppError> {
        load(&self.dir.join(STATE_FILE))
    }

    pub fn load_ui_prefs(&self) -> Result<Option<UiPrefs>, AppError> {
        Ok(self.load_config()?.value.ui)
    }

    /// 界面偏好写回 config.json。load-modify-save:只动 `ui` 一个字段,
    /// registries/autoUpdate 原样保留。
    ///
    /// 只读闸门不在这里重复设卡:文件来自更新版本时 `load_config` 给的是默认值,
    /// 但 `save`(基于磁盘重读的那道现有守卫)会拒绝写入,新版数据一个字节不会被动。
    pub fn save_ui_prefs(&self, prefs: &UiPrefs) -> Result<(), AppError> {
        prefs.validate()?;
        let mut config = self.load_config()?.value;
        config.ui = Some(prefs.clone());
        self.save_config(&config)
    }

    /// 自动更新配置写回(load-modify-save,同 save_ui_prefs 的只读闸门策略)。
    pub fn save_auto_update(&self, auto_update: &AutoUpdate) -> Result<(), AppError> {
        if auto_update.skills.interval_minutes == 0 {
            return Err(AppError::new(
                "STATE_INVALID_CONFIG",
                "自动更新的时间间隔不合法,请重新选择",
            )
            .with_detail("intervalMinutes must be >= 1"));
        }
        let mut config = self.load_config()?.value;
        config.auto_update = auto_update.clone();
        self.save_config(&config)
    }

    /// agent 禁用名单写回(去重排序,让 config 内容稳定可比对)。
    pub fn save_disabled_agents(&self, disabled: &[String]) -> Result<(), AppError> {
        let mut list: Vec<String> = disabled.to_vec();
        list.sort();
        list.dedup();
        let mut config = self.load_config()?.value;
        config.disabled_agents = list;
        self.save_config(&config)
    }

    pub fn save_state(&self, value: &State) -> Result<(), AppError> {
        save(&self.dir.join(STATE_FILE), value)
    }

    /// 登录成功(或查状态时刷新)后记一条身份(v6 任务 1,load-modify-save)。
    ///
    /// **等值跳过守卫**(2026-08-23 补,与 [`Self::remove_identity`] 的"键不在就不写"
    /// 对称):`auth_status`/`github_status` 是查状态的读路径,应用启动时每个源都会调
    /// 一次,身份却极少变化——不加这道守卫,一条读路径会退化成一条无条件写路径,
    /// 每次都 load-modify-save 一整份 config.json。这不只是浪费:`config.json`
    /// 还有别的写入方(界面偏好、来源增删),每一次无谓的 load-modify-save 都是
    /// 一个新的互相覆盖窗口——加到一条本该只读的路径上是净增风险,不是零成本的幂等写。
    pub fn save_identity(
        &self,
        registry_id: &str,
        identity: &crate::core::ownership::Identity,
    ) -> Result<(), AppError> {
        let mut config = self.load_config()?.value;
        if config.identities.get(registry_id) == Some(identity) {
            return Ok(());
        }
        config.identities.insert(registry_id.to_string(), identity.clone());
        self.save_config(&config)
    }

    /// 退出登录(或续期/校验判定为未登录)时删掉对应身份记录。
    /// 键本来就不在时不写盘——避免每次退出都无谓地 touch 文件。
    pub fn remove_identity(&self, registry_id: &str) -> Result<(), AppError> {
        let mut config = self.load_config()?.value;
        if config.identities.remove(registry_id).is_some() {
            self.save_config(&config)?;
        }
        Ok(())
    }
}

fn load<T>(path: &Path) -> Result<Loaded<T>, AppError>
where
    T: serde::de::DeserializeOwned + Default,
{
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                value: T::default(),
                access: Access::ReadWrite,
            })
        }
        Err(e) => {
            return Err(AppError::new("STATE_READ_FAILED", "读取本地数据失败,请检查文件权限")
                .with_detail(format!("read {}: {e}", path.display())))
        }
    };

    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        AppError::new(
            "STATE_CORRUPT",
            "本地数据文件已损坏。为免丢失记录,应用没有改动它,请联系 IT 协助处理",
        )
        .with_detail(format!("parse {}: {e}", path.display()))
    })?;

    // 缺 schemaVersion 视为第 1 版:该字段是随 v1 一同引入的,不带它的文件只能是 v1 之前的写法。
    let found = raw
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(SCHEMA_VERSION as u64) as u32;

    if found > SCHEMA_VERSION {
        // 只读:结构未知,任何写回都可能把新版本的字段抹掉。
        return Ok(Loaded {
            value: T::default(),
            access: Access::ReadOnly { found },
        });
    }

    let migrated = migrate(raw, found)?;
    let value = serde_json::from_value(migrated).map_err(|e| {
        AppError::new(
            "STATE_CORRUPT",
            "本地数据文件的内容不符合预期。为免丢失记录,应用没有改动它,请联系 IT 协助处理",
        )
        .with_detail(format!("decode {}: {e}", path.display()))
    })?;

    Ok(Loaded {
        value,
        access: Access::ReadWrite,
    })
}

/// 版本链式迁移。
///
/// 目前只有第 1 版,链上没有任何一段;新增 v2 时在此补 `1 => {...}` 并提升 [`SCHEMA_VERSION`]。
/// 保留这个函数形态而不是等到那天再引入,是为了让"迁移发生在读取路径上"这件事现在就成立。
fn migrate(mut raw: serde_json::Value, from: u32) -> Result<serde_json::Value, AppError> {
    if from > SCHEMA_VERSION {
        // 调用处已经拦过更高版本(只读模式),这里只是兜底
        return Err(AppError::new(
            "STATE_MIGRATE_UNSUPPORTED",
            "本地数据来自更高版本的应用,请升级后再用",
        )
        .with_detail(format!("no migration path from v{from}")));
    }
    if from < 2 {
        // v1 → v2:技能检查间隔换算成分钟。config.json 才有 autoUpdate,
        // state.json 走同一条链但没有这一节,原样跳过(只补版本号)。
        if let Some(skills) = raw
            .get_mut("autoUpdate")
            .and_then(|a| a.get_mut("skills"))
            .and_then(|s| s.as_object_mut())
        {
            let hours = skills.remove("intervalHours").and_then(|v| v.as_u64());
            if let Some(h) = hours {
                skills.insert("intervalMinutes".into(), (h * 60).into());
            }
        }
    }
    if let Some(obj) = raw.as_object_mut() {
        obj.insert("schemaVersion".into(), SCHEMA_VERSION.into());
    }
    Ok(raw)
}

fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let existing = std::fs::read_to_string(path).ok();
    if let Some(text) = &existing {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(text) {
            let found = raw.get("schemaVersion").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if found > SCHEMA_VERSION {
                return Err(AppError::new(
                    "STATE_READ_ONLY",
                    "本地数据来自更新版本的 SkillSync,请先升级应用后再操作",
                )
                .with_detail(format!("refuse to write over v{found} at {}", path.display())));
            }
        }
    }

    let failed = |e: std::io::Error| {
        AppError::new("STATE_WRITE_FAILED", "保存本地数据失败,请检查磁盘空间与权限")
            .with_detail(format!("write {}: {e}", path.display()))
    };

    let dir = path.parent().ok_or_else(|| {
        AppError::new("STATE_WRITE_FAILED", "保存本地数据失败:路径不合法")
            .with_detail(format!("no parent for {}", path.display()))
    })?;
    std::fs::create_dir_all(dir).map_err(failed)?;

    let text = serde_json::to_string_pretty(value).map_err(|e| {
        AppError::new("STATE_WRITE_FAILED", "保存本地数据失败").with_detail(e.to_string())
    })?;

    // 原子写:先落到同目录下的临时文件,再 rename 顶替。
    // 同目录是必要条件——跨文件系统的 rename 不是原子操作,会退化成"复制+删除"。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(failed)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        failed(e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ownership::Identity;

    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::new(tmp.path().join(".skillsync"));
        (tmp, s)
    }

    fn sample_state() -> State {
        State {
            schema_version: SCHEMA_VERSION,
            installed: vec![InstalledSkill {
                name: "docx-to-markdown".into(),
                source: SkillSource {
                    registry_id: "company".into(),
                    owner: "skills".into(),
                    repo: "skills".into(),
                    path: "skills/docx-to-markdown".into(),
                    git_ref: "main".into(),
                },
                commit_sha: "abc123".into(),
                content_hash: "sha256:deadbeef".into(),
                origin: None,
                body: None,
                agents: vec!["claude-code".into()],
                links: vec![LinkRecord {
                    dir: "/h/.claude/skills".into(),
                    mode: "symlink".into(),
                }],
                installed_at: "2026-07-30T00:00:00.000Z".into(),
                updated_at: "2026-07-30T00:00:00.000Z".into(),
            }],
            shared: vec![],
        }
    }

    #[test]
    fn has_source_requires_all_three_coordinate_fields_non_empty() {
        let full = sample_state().installed.remove(0);
        assert!(full.has_source(), "sample_state 三个字段都是真值");

        let mut adopted = full.clone();
        adopted.source = SkillSource {
            registry_id: String::new(),
            owner: String::new(),
            repo: String::new(),
            path: String::new(),
            git_ref: String::new(),
        };
        assert!(!adopted.has_source(), "adopted 账三个字段全空");

        // 三选一漏填也算没有来源——不是"三者都空才算没有",是"三者都非空才算有"。
        // 三个字段各自单独试一遍(审查修复轮 2:此前只单独试了 owner 一个,
        // 把实现削成只看 owner 照样绿,是本项目最贵的一类问题——空转测试)。
        let mut missing_registry_id = full.clone();
        missing_registry_id.source.registry_id = String::new();
        assert!(!missing_registry_id.has_source(), "registry_id 空应当为 false");

        let mut missing_owner = full.clone();
        missing_owner.source.owner = String::new();
        assert!(!missing_owner.has_source(), "owner 空应当为 false");

        let mut missing_repo = full;
        missing_repo.source.repo = String::new();
        assert!(!missing_repo.has_source(), "repo 空应当为 false");
    }

    #[test]
    fn missing_files_yield_defaults_without_writing_anything() {
        let (_tmp, s) = store();

        let cfg = s.load_config().unwrap();
        let st = s.load_state().unwrap();

        assert_eq!(cfg.value.schema_version, SCHEMA_VERSION);
        assert!(st.value.installed.is_empty());
        assert!(matches!(cfg.access, Access::ReadWrite));
        assert!(!s.dir().exists(), "只读不该在磁盘上留下任何东西");
    }

    #[test]
    fn state_survives_a_round_trip() {
        let (_tmp, s) = store();
        let original = sample_state();

        s.save_state(&original).unwrap();
        let back = s.load_state().unwrap().value;

        assert_eq!(back.installed.len(), 1);
        assert_eq!(back.installed[0].name, "docx-to-markdown");
        assert_eq!(back.installed[0].links[0].mode, "symlink");
        assert_eq!(back.installed[0].source.owner, "skills");
    }

    #[test]
    fn files_are_written_with_a_schema_version_on_top() {
        let (_tmp, s) = store();
        s.save_state(&sample_state()).unwrap();

        let text = std::fs::read_to_string(s.dir().join("state.json")).unwrap();

        assert!(
            text.starts_with(&format!("{{\n  \"schemaVersion\": {SCHEMA_VERSION}")),
            "{text}"
        );
    }

    #[test]
    fn a_file_without_schema_version_is_treated_as_the_oldest_version() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(s.dir().join("state.json"), r#"{"installed":[],"shared":[]}"#).unwrap();

        let loaded = s.load_state().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite));
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn a_newer_schema_becomes_read_only_and_is_never_written_back() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        let path = s.dir().join("state.json");
        let future = r#"{"schemaVersion":99,"installed":[],"shared":[],"未来字段":true}"#;
        std::fs::write(&path, future).unwrap();

        let loaded = s.load_state().unwrap();
        assert!(matches!(loaded.access, Access::ReadOnly { found: 99 }));

        let err = s.save_state(&sample_state()).unwrap_err();
        assert_eq!(err.code, "STATE_READ_ONLY");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            future,
            "只读模式下文件必须一个字节都不变"
        );
    }

    #[test]
    fn corrupt_json_is_reported_and_the_users_file_is_left_alone() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        let path = s.dir().join("state.json");
        std::fs::write(&path, "{ 半截文件").unwrap();

        let err = s.load_state().unwrap_err();

        assert_eq!(err.code, "STATE_CORRUPT");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ 半截文件");
    }

    #[test]
    fn writing_leaves_no_temporary_files_behind() {
        let (_tmp, s) = store();
        s.save_state(&sample_state()).unwrap();
        s.save_config(&Config::default()).unwrap();

        let names: Vec<String> = std::fs::read_dir(s.dir())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();

        assert_eq!(names.len(), 2, "残留了临时文件: {names:?}");
        assert!(names.contains(&"state.json".to_string()));
        assert!(names.contains(&"config.json".to_string()));
    }

    #[test]
    fn a_write_that_dies_halfway_leaves_the_previous_content_intact() {
        // 让**临时文件**那一步失败(该位置摆一个目录),从而真的走到"先写临时文件"这条路上。
        // 若实现改成直接写目标文件,这条就会挂——原内容会被截断成半截。
        let (_tmp, s) = store();
        s.save_state(&sample_state()).unwrap();
        let path = s.dir().join("state.json");
        let before = std::fs::read_to_string(&path).unwrap();
        std::fs::create_dir(s.dir().join("state.json.tmp")).unwrap();

        let err = s.save_state(&State::default()).unwrap_err();

        assert_eq!(err.code, "STATE_WRITE_FAILED");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    /// theme 与 accent 特意取"档位序号不同"的组合(深色 + 默认强调色),
    /// 避免两个概念在 fixture 里取同值,把字段串位测没了(CLAUDE.md 空转模式 3)。
    fn sample_prefs() -> UiPrefs {
        UiPrefs {
            theme: "dark".into(),
            accent: "clay".into(),
            wizard_done: true,
        }
    }

    #[test]
    fn ui_prefs_survive_a_round_trip() {
        let (_tmp, s) = store();

        s.save_ui_prefs(&sample_prefs()).unwrap();
        let back = s.load_ui_prefs().unwrap().expect("保存过就该读得到");

        assert_eq!(back.theme, "dark");
        assert_eq!(back.accent, "clay");
        assert!(back.wizard_done);
    }

    #[test]
    fn a_config_from_before_ui_prefs_reads_as_none_on_schema_v1() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("config.json"),
            r#"{"schemaVersion":1,"registries":[],"autoUpdate":{"skills":{"enabled":false,"intervalHours":8},"app":true}}"#,
        )
        .unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite), "能迁移就不该降只读");
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
        assert!(loaded.value.ui.is_none());
        // 顺带确认旧值没被 default 吃掉(8 小时 → 480 分钟,v2 迁移)
        assert!(!loaded.value.auto_update.skills.enabled);
        assert_eq!(loaded.value.auto_update.skills.interval_minutes, 480);
    }

    /// v1 的 `intervalHours` 要在读取路径上换算成 v2 的 `intervalMinutes`
    /// ——加 5 分钟档必须让间隔有分钟精度(2026-08-06 用户要求),
    /// 而**小时字段没法表达 5 分钟**,只能升一版把单位换掉。
    /// 这是本项目第一次真的走迁移链;`migrate` 的形态早就备在那里了。
    #[test]
    fn a_v1_config_migrates_its_hourly_interval_into_minutes() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("config.json"),
            r#"{"schemaVersion":1,"registries":[],"autoUpdate":{"skills":{"enabled":true,"intervalHours":4},"app":true}}"#,
        )
        .unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite), "能迁移就不该降只读");
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
        // 4 小时 = 240 分钟:档位语义一个字不变,只是单位换了
        assert_eq!(loaded.value.auto_update.skills.interval_minutes, 240);
        assert!(loaded.value.auto_update.skills.enabled);

        // 写回之后文件里只剩新字段——留着旧字段就是两份真相
        s.save_auto_update(&loaded.value.auto_update).unwrap();
        let raw = std::fs::read_to_string(s.dir().join("config.json")).unwrap();
        assert!(raw.contains("intervalMinutes"), "{raw}");
        assert!(!raw.contains("intervalHours"), "旧字段该随写回消失: {raw}");
    }

    /// 迁移只认识 `autoUpdate` 这一处;state.json 走同一条链,不该被误伤。
    #[test]
    fn migrating_state_json_only_stamps_the_version() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("state.json"),
            r#"{"schemaVersion":1,"installed":[],"shared":[]}"#,
        )
        .unwrap();

        let loaded = s.load_state().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite));
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
        assert!(loaded.value.installed.is_empty());
    }

    #[test]
    fn a_default_config_serializes_without_a_ui_key() {
        // 断言键的完整集合而不是"没有 ui"——字段名拼错时"不存在"式断言照样绿(空转模式 2)。
        let json = serde_json::to_value(Config::default()).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, ["schemaVersion", "registries", "autoUpdate"]);
    }

    #[test]
    fn invalid_pref_values_are_rejected_and_the_file_is_untouched() {
        let (_tmp, s) = store();
        s.save_ui_prefs(&sample_prefs()).unwrap();
        let before = std::fs::read_to_string(s.dir().join("config.json")).unwrap();

        for bad in [
            UiPrefs { theme: "purple".into(), ..sample_prefs() },
            UiPrefs { accent: "rainbow".into(), ..sample_prefs() },
        ] {
            let err = s.save_ui_prefs(&bad).unwrap_err();
            assert_eq!(err.code, "STATE_INVALID_PREFS");
        }
        assert_eq!(
            std::fs::read_to_string(s.dir().join("config.json")).unwrap(),
            before,
            "被拒的写入不该碰文件"
        );
    }

    #[test]
    fn saving_ui_prefs_preserves_the_rest_of_the_config() {
        let (_tmp, s) = store();
        let mut config = Config::default();
        config.registries.push(RegistryConfig {
            id: "company".into(),
            name: "公司技能库".into(),
            kind: "gitea".into(),
            base_url: "https://gitea.internal.example".into(),
            builtin: true,
            repos: vec![RepoConfig {
                owner: "skills".into(),
                repo: "skills".into(),
                branch: "main".into(),
                name: None,
            }],
        });
        config.auto_update.skills.interval_minutes = 24 * 60;
        s.save_config(&config).unwrap();

        s.save_ui_prefs(&sample_prefs()).unwrap();
        let back = s.load_config().unwrap().value;

        assert_eq!(back.registries.len(), 1, "save_ui_prefs 整份覆盖了 config");
        assert_eq!(back.registries[0].id, "company");
        assert_eq!(back.auto_update.skills.interval_minutes, 24 * 60);
        assert_eq!(back.ui, Some(sample_prefs()));
    }

    #[test]
    fn ui_prefs_respect_the_read_only_gate() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        let path = s.dir().join("config.json");
        let future = r#"{"schemaVersion":99,"未来字段":true}"#;
        std::fs::write(&path, future).unwrap();

        let err = s.save_ui_prefs(&sample_prefs()).unwrap_err();

        assert_eq!(err.code, "STATE_READ_ONLY");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), future, "新版文件必须一字节不动");
    }

    #[test]
    fn disabled_agents_survive_a_round_trip_and_preserve_the_rest() {
        let (_tmp, s) = store();
        s.save_ui_prefs(&sample_prefs()).unwrap();

        s.save_disabled_agents(&["trae".into(), "cursor".into(), "trae".into()]).unwrap();
        let back = s.load_config().unwrap().value;

        // 去重 + 排序,内容稳定
        assert_eq!(back.disabled_agents, vec!["cursor".to_string(), "trae".to_string()]);
        assert_eq!(back.ui, Some(sample_prefs()), "写禁用名单不该动界面偏好");
    }

    #[test]
    fn an_old_config_without_disabled_agents_reads_as_empty() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(s.dir().join("config.json"), r#"{"schemaVersion":1}"#).unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite));
        assert!(loaded.value.disabled_agents.is_empty());
    }

    #[test]
    fn auto_update_settings_are_validated_and_preserve_the_rest() {
        let (_tmp, s) = store();
        s.save_disabled_agents(&["trae".into()]).unwrap();
        let before = std::fs::read_to_string(s.dir().join("config.json")).unwrap();

        let bad = AutoUpdate {
            skills: SkillAutoUpdate { enabled: true, interval_minutes: 0 },
            app: true,
        };
        let err = s.save_auto_update(&bad).unwrap_err();
        assert_eq!(err.code, "STATE_INVALID_CONFIG");
        assert_eq!(
            std::fs::read_to_string(s.dir().join("config.json")).unwrap(),
            before,
            "被拒的写入不该碰文件"
        );

        let ok = AutoUpdate {
            skills: SkillAutoUpdate { enabled: false, interval_minutes: 24 * 60 },
            app: false,
        };
        s.save_auto_update(&ok).unwrap();
        let back = s.load_config().unwrap().value;
        assert!(!back.auto_update.skills.enabled);
        assert_eq!(back.auto_update.skills.interval_minutes, 24 * 60);
        assert!(!back.auto_update.app);
        assert_eq!(back.disabled_agents, vec!["trae".to_string()], "写更新配置不该动禁用名单");
    }

    #[test]
    fn config_carries_the_builtin_registry_by_default() {
        let cfg = Config::default();
        assert_eq!(cfg.schema_version, SCHEMA_VERSION);
        assert!(cfg.auto_update.skills.enabled);
        // 全新安装默认盯得紧一点(2026-08-06 用户拍板):新人装上就能及时拿到
        // 技能库的新内容,不用先去设置里找档位。老用户的档位由迁移原样带过来,不受影响。
        assert_eq!(cfg.auto_update.skills.interval_minutes, 5);
    }

    // ============================================================ projects(v5)

    /// 旧 config 没有 `projects`,必须读得出且落成空列表、**不降只读**。
    #[test]
    fn an_old_config_without_the_last_seen_version_reads_as_absent() {
        // 加可选字段是兼容变更,不升 schemaVersion(同 projects / plazaRepos 先例)。
        // 缺席**不能**被读成空串:空串会在文件里匹配不到任何段落,
        // 判定就退回"只给当前版本",与"新装不打扰"那一档混成一档。
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("config.json"),
            r#"{"schemaVersion":2,"registries":[],"autoUpdate":{"skills":{"enabled":true,"intervalMinutes":5},"app":true}}"#,
        )
        .unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite), "加可选字段不该降只读");
        assert_eq!(loaded.value.last_seen_version, None);
        assert!(loaded.value.ui.is_none(), "读一份旧 config 不该凭空物化出 ui");
    }

    #[test]
    fn an_old_config_without_projects_reads_as_empty() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("config.json"),
            r#"{"schemaVersion":2,"registries":[],"autoUpdate":{"skills":{"enabled":true,"intervalMinutes":5},"app":true}}"#,
        )
        .unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite), "加可选字段不该降只读");
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
        assert!(loaded.value.projects.is_empty());
    }

    /// 往返保住 `projects` 的**顺序**(最近用的在前,界面靠它取「最近项目」)
    /// 以及 config 其余部分。
    #[test]
    fn config_roundtrip_preserves_projects_in_order() {
        let (_tmp, s) = store();
        let mut config = s.load_config().unwrap().value;
        config.projects = vec!["/w/最近".into(), "/w/更早".into()];
        config.plaza_repos.push(RepoConfig {
            owner: "vercel-labs".into(),
            repo: "agent-skills".into(),
            branch: "main".into(),
            name: None,
        });
        s.save_config(&config).unwrap();

        let back = s.load_config().unwrap().value;

        assert_eq!(back.projects, vec!["/w/最近".to_string(), "/w/更早".to_string()]);
        assert_eq!(back.plaza_repos.len(), 1, "其余字段必须原样保留");
    }

    // ============================================================ plaza_repos(M9 任务 2)

    /// 旧 config(v2,来自 `builtin_extra_repos` 之后但早于本字段)没有 `plazaRepos`,
    /// 必须读得出且落成空列表——与 `an_old_config_without_disabled_agents_reads_as_empty`
    /// 同一套护栏,加可选字段不该让老用户的文件读不出来。
    #[test]
    fn an_old_config_without_plaza_repos_reads_as_empty() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("config.json"),
            r#"{"schemaVersion":2,"registries":[],"autoUpdate":{"skills":{"enabled":true,"intervalMinutes":5},"app":true}}"#,
        )
        .unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite), "加可选字段不该降只读");
        assert_eq!(loaded.value.schema_version, SCHEMA_VERSION);
        assert!(loaded.value.plaza_repos.is_empty());
    }

    /// 写回含 `plazaRepos`,且 `ui`/`registries` 原样保留——对照
    /// `registry.rs::config_roundtrip_preserves_builtin_extra_repos` 的既有测试形状,
    /// 换成没有专属 add 原语的 plaza(v1 直接改字段,没有 UI 入口)。
    #[test]
    fn config_roundtrip_preserves_plaza_repos_and_the_rest_of_the_config() {
        let (_tmp, s) = store();
        s.save_ui_prefs(&sample_prefs()).unwrap();
        let mut config = s.load_config().unwrap().value;
        config.registries.push(RegistryConfig {
            id: "custom-1".into(),
            name: "部门工具库".into(),
            kind: "gitea".into(),
            base_url: "http://tools.example:8080".into(),
            builtin: false,
            repos: vec![RepoConfig {
                owner: "ai-skills".into(),
                repo: "dept-skills".into(),
                branch: "main".into(),
                name: None,
            }],
        });
        config.plaza_repos.push(RepoConfig {
            owner: "vercel-labs".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        });
        s.save_config(&config).unwrap();

        let back = s.load_config().unwrap().value;
        assert_eq!(back.plaza_repos.len(), 1);
        assert_eq!(back.plaza_repos[0].owner, "vercel-labs");
        assert_eq!(back.plaza_repos[0].repo, "skills");
        // 其余字段一个不少:ui 与 registries 都是在这次 save 之前就落好的
        assert_eq!(back.ui, Some(sample_prefs()));
        assert_eq!(back.registries.len(), 1);
        assert_eq!(back.registries[0].id, "custom-1");
        assert_eq!(back.schema_version, SCHEMA_VERSION);

        // 落盘的键里确实带 plazaRepos,不是只在内存里存在
        let raw = std::fs::read_to_string(s.dir().join("config.json")).unwrap();
        assert!(raw.contains("plazaRepos"), "{raw}");
    }

    // ============================================================ identities(v6 任务 1)

    /// 旧 config 没有 `identities`,必须读得出且落成空 map——与 `plazaRepos`/
    /// `disabledAgents` 同一套护栏,加可选字段不该让老用户的文件读不出来。
    #[test]
    fn an_old_config_without_identities_reads_as_empty() {
        let (_tmp, s) = store();
        std::fs::create_dir_all(s.dir()).unwrap();
        std::fs::write(
            s.dir().join("config.json"),
            r#"{"schemaVersion":2,"registries":[],"autoUpdate":{"skills":{"enabled":true,"intervalMinutes":5},"app":true}}"#,
        )
        .unwrap();

        let loaded = s.load_config().unwrap();

        assert!(matches!(loaded.access, Access::ReadWrite), "加可选字段不该降只读");
        assert!(loaded.value.identities.is_empty());
    }

    // 空 map 不落盘出一个空对象(`skip_serializing_if` 生效)已由既有的
    // `a_default_config_serializes_without_a_ui_key` 覆盖——它断言的是**完整键集合**,
    // 新字段序列化出来这条测试就会先红,不必再抄一份同样的断言(CLAUDE.md 空转模式 1)。

    /// `save_identity`/`remove_identity` 往返一致,且不动 config 其余部分。
    #[test]
    fn identities_round_trip_and_preserve_the_rest_of_the_config() {
        let (_tmp, s) = store();
        s.save_ui_prefs(&sample_prefs()).unwrap();

        s.save_identity(
            "company",
            &crate::core::ownership::Identity {
                login: "dhslegen".into(),
                display_name: "赵文浩".into(),
            },
        )
        .unwrap();
        let back = s.load_config().unwrap().value;
        assert_eq!(back.identities.len(), 1);
        assert_eq!(back.identities["company"].login, "dhslegen");
        assert_eq!(back.identities["company"].display_name, "赵文浩");
        assert_eq!(back.ui, Some(sample_prefs()), "写身份不该动界面偏好");

        let raw = std::fs::read_to_string(s.dir().join("config.json")).unwrap();
        assert!(raw.contains("identities"), "{raw}");
        assert!(raw.contains("displayName"), "{raw}");

        s.remove_identity("company").unwrap();
        let after_remove = s.load_config().unwrap().value;
        assert!(!after_remove.identities.contains_key("company"));
        assert_eq!(after_remove.ui, Some(sample_prefs()), "退出登录不该动界面偏好");
    }

    /// 删一个不存在的键是没有效果的成功,不该报错也不该 touch 文件。
    #[test]
    fn removing_an_absent_identity_is_a_harmless_no_op() {
        let (_tmp, s) = store();
        s.save_ui_prefs(&sample_prefs()).unwrap();
        let before = std::fs::read_to_string(s.dir().join("config.json")).unwrap();

        s.remove_identity("nobody-here").unwrap();

        assert_eq!(std::fs::read_to_string(s.dir().join("config.json")).unwrap(), before);
    }

    /// `save_identity` 的等值跳过守卫(2026-08-23 补):同一个身份连续存两次,
    /// 第二次不该重写文件——`auth_status`/`github_status` 是查状态的读路径,
    /// 身份极少变化,不加这道守卫它就退化成一条无条件写路径。
    ///
    /// 判定手法:第一次存完后,手工在 config.json 里塞一个 `Config` 结构体不认识的
    /// 顶层字段当"标记"。**如果第二次调用真的走了 load-modify-save**,序列化时
    /// 这个未知字段会被 serde 直接抹掉(往返 mtime 在快速连续调用下可能落在同一秒,
    /// 不够可靠;这个标记字段是否还在则是非黑即白的判据)。
    #[test]
    fn saving_the_same_identity_twice_does_not_rewrite_the_file() {
        let (_tmp, s) = store();
        let identity = Identity { login: "dhslegen".into(), display_name: "赵文浩".into() };
        s.save_identity("company", &identity).unwrap();

        let path = s.dir().join("config.json");
        let mut doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        doc.as_object_mut().unwrap().insert("哨兵标记".into(), serde_json::json!("不该被抹掉"));
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();

        // 存的是完全相同的身份:应当直接跳过写盘
        s.save_identity("company", &identity).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("哨兵标记"), "身份没变时不该重写文件,标记字段应该还在:{after}");
    }

    /// 对照组:身份**确实变了**时必须照常写盘,证明上面那条守卫不是把
    /// `save_identity` 整个改成空函数就能蒙混过去的空转测试。
    #[test]
    fn saving_a_different_identity_overwrites_the_previous_one() {
        let (_tmp, s) = store();
        s.save_identity(
            "company",
            &Identity { login: "dhslegen".into(), display_name: "赵文浩".into() },
        )
        .unwrap();

        s.save_identity(
            "company",
            &Identity { login: "someone-else".into(), display_name: "李四".into() },
        )
        .unwrap();

        let back = s.load_config().unwrap().value;
        assert_eq!(back.identities["company"].login, "someone-else");
        assert_eq!(back.identities["company"].display_name, "李四");
    }
}
