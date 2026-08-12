//! 仓库源管理:内建公司 Gitea(builtin,锁定不可删不可改)+ 用户自定义 Gitea/GitHub 源。
//!
//! M3 任务 1 落地的解析层:把「编译期注入的内建常量 + `config.registries`」合成一份
//! 可解析的源列表,`commands.rs` 一律经 [`resolve`] 拿访问坐标,不再直取常量。
//!
//! 设计要点:
//! - **内建源永远在列且锁定**:[`list`] 首位固定是它;[`remove`] 对它报 `REPO_BUILTIN_LOCKED`。
//!   它不落 `config.registries`(坐标是编译期常量,落盘只会造出第二份真相)。
//! - **纯函数收参数**:内建常量经 [`BuiltinSource`] 传入而不是在函数里读
//!   `option_env!`——测试构建不注入常量,直接读会让所有测试都只能测"未配置"分支
//!   (与 M1 `store_target` 同一套路)。
//! - **解析不看 OAuth 配置**:技能库公开可匿名读,商店浏览先于登录,签名里就没有
//!   client_id(产品前提,有测试钉住)。
//! - kind=github 的源可以入 config(schema 早已支持),但访问在 [`ResolvedRegistry::require_gitea`]
//!   处被拦——GitHub client 归 M3 任务 4,接通后摘除该闸门。
//! - **一源多仓**(M4 任务 1):浏览/获取/分享的最小单位是「(源, 技能库)」。
//!   仓库寻址键 = `owner/repo`(源内唯一,添加时查重);[`resolve`] 不带键时落主仓
//!   (内建 = 编译期常量,自定义 = `repos[0]`),既有调用方外部行为不变。
//!   内建源的追加仓落 `config.builtinExtraRepos`,**base_url 永远取编译期常量**
//!   ——同源由构造保证,不需要 URL 校验;内建主仓本身仍不落盘。

use serde::Serialize;

use crate::core::gitea::{self, RepoRef};
use crate::core::state::{RegistryConfig, RepoConfig};
use crate::error::AppError;

/// 内建技能库的 registry id。M1 只有这一个源,多源起按 id 区分凭证与缓存。
pub const BUILTIN_REGISTRY_ID: &str = "company";

/// 技能广场(skills.sh 搜索,M9 任务 1)的 registry id。与 [`BUILTIN_REGISTRY_ID`]
/// 同款锁定源:**不落 `config.registries`**,坐标是常量而不是用户配置。
///
/// 与内建源的关键差异:广场**没有主仓概念**——它是搜索态,不存在"默认技能库"。
/// `resolve(PLAZA_REGISTRY_ID, key=None)` 因此必须报错,不能像内建源那样落回一个
/// 编译期写死的主仓(见 [`resolve`] 里的专门注释)。
pub const PLAZA_REGISTRY_ID: &str = "plaza";
/// 广场技能一律来自 GitHub(skills.sh 的 `source` 字段就是 GitHub `owner/repo`,
/// 见 `core::plaza` 模块头),因此广场源的访问坐标固定指向 github.com——
/// 与 skills.sh 本身(`core::plaza::PLAZA_API_BASE`,只用于**搜索**)是两个不同的域名。
pub const PLAZA_BASE_URL: &str = "https://github.com";

/// 编译期注入的内建源坐标。生产走 [`BuiltinSource::from_build`],测试注入假值。
#[derive(Debug, Clone)]
pub struct BuiltinSource {
    pub base_url: Option<&'static str>,
    pub repo: Option<(&'static str, &'static str)>,
    pub branch: &'static str,
}

impl BuiltinSource {
    pub fn from_build() -> Self {
        Self {
            base_url: crate::core::builtin::BUILTIN_GITEA_URL,
            repo: crate::core::builtin::builtin_repo(),
            branch: crate::core::builtin::builtin_branch(),
        }
    }
}

/// 源类型。config 里存小写字符串(`gitea`/`github`),经 [`RegistryKind::parse`] 收严。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistryKind {
    Gitea,
    Github,
}

impl RegistryKind {
    /// 写外部契约(`.skill-lock.json` 的 sourceType)时用的字符串,与 config 同一套值。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gitea => "gitea",
            Self::Github => "github",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "gitea" => Some(Self::Gitea),
            "github" => Some(Self::Github),
            _ => None,
        }
    }
}

/// 设置页「仓库源管理」的整行数据。`repo` 为 `None` 仅发生在内建源未注入配置的构建上,
/// 前端据此显示"构建未配置"而不是空白行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryView {
    pub id: String,
    /// 自定义源:用户起的名字。内建源:固定"公司技能库"(前端可按 `builtin` 标记
    /// 换 i18n 文案,这里给的是兜底)。
    pub name: String,
    /// 原样透出 config 里的字符串(合法值 `gitea`/`github`),不做粉饰——
    /// 手改出的垃圾值在 [`resolve`] 处被拦,列表层如实展示才好排查。
    pub kind: String,
    pub base_url: String,
    pub builtin: bool,
    /// 主仓(`repos` 首位)的快捷方式,内建未注入配置时为 `None`。
    pub repo: Option<RepoRef>,
    /// 该源下的全部技能库,主仓在首位(M4 任务 1)。
    pub repos: Vec<RepoView>,
}

/// 一个技能库在设置页/商店过滤里的展示数据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoView {
    /// 仓库寻址键 `owner/repo`,IPC 的 `repo` 参数原样带回。
    pub key: String,
    pub owner: String,
    pub repo: String,
    pub branch: String,
    /// 用户起的展示名;`None` 时前端回退 repo slug。
    pub name: Option<String>,
    /// 主仓(resolve 缺省落点)。
    pub primary: bool,
    /// 锁定不可移除(仅内建源主仓:坐标是编译期常量)。
    pub locked: bool,
}

/// 一次访问所需的全部坐标。拿到它就不再需要 config 或编译期常量。
#[derive(Debug, Clone)]
pub struct ResolvedRegistry {
    pub id: String,
    pub kind: RegistryKind,
    pub base_url: String,
    pub repo: RepoRef,
    pub builtin: bool,
}

impl ResolvedRegistry {
    /// 该源的登录配置(M3 任务 2)。
    ///
    /// - 内建源:OAuth PKCE,需要编译期注入的 Client ID,缺了报 `AUTH_NOT_CONFIGURED`。
    /// - 自定义源:PAT 通道,`client_id` 留空——PAT 凭证 `expires_at=0`,
    ///   `ensure_access_token` 永不走 OAuth 续期端点,空 client_id 不会被用到;
    ///   **内建的 Client ID 绝不塞给自定义源**(那是别家 Gitea,发过去只会泄露内网配置)。
    ///
    /// 判定逻辑与 [`ResolvedSource::auth_config`] 共享 [`build_auth_config`]——
    /// 两个类型都可能代表"同一个源",分叉维护是下一次 M6 式静默漂移的温床。
    pub fn auth_config(
        &self,
        builtin_client_id: Option<&str>,
    ) -> Result<crate::core::auth::OAuthConfig, AppError> {
        build_auth_config(&self.base_url, self.builtin, builtin_client_id)
    }

    /// Gitea 专用链路的类型闸门。任务 4 起**读链路已放行 GitHub**(走 `RepoSource`),
    /// 本闸门只剩登录与分享两条 Gitea 专属通道在用;GitHub 侧凭证与分享归任务 5,
    /// 接通后按通道逐个摘除。
    ///
    /// 判定逻辑与 [`ResolvedSource::require_gitea`] 共享 [`require_gitea_kind`]。
    pub fn require_gitea(&self) -> Result<&Self, AppError> {
        require_gitea_kind(self.kind, &self.id)?;
        Ok(self)
    }
}

/// 源级访问坐标:只有 kind/base_url/builtin,**不含任何仓库**(M9 终审修复)。
///
/// 用于与具体技能库无关的操作——目前唯一的调用方是五个 `auth_*` command(登录/
/// 凭证管理)。之所以要单独开一个类型而不是把 [`ResolvedRegistry::repo`] 改成
/// `Option<RepoRef>`:登录本来就不需要"默认技能库"这个概念,但套用 [`resolve`]
/// 的仓库解析会让**广场**必然报错——广场没有主仓,`resolve(PLAZA_REGISTRY_ID,
/// key=None)` 是故意设计成报错的(见 [`resolve`] 里 plaza 分支的注释,那条报错
/// 对"选技能库"场景是对的),但登录压根不该被这条"仓级"约束卡住。把 `repo` 改成
/// `Option` 会让全仓所有读 `.repo` 的调用方都要多处理一层 None,波及面远大于
/// 加一个专用的源级类型。
#[derive(Debug, Clone)]
pub struct ResolvedSource {
    pub id: String,
    pub kind: RegistryKind,
    pub base_url: String,
    pub builtin: bool,
}

impl ResolvedSource {
    /// 与 [`ResolvedRegistry::require_gitea`] 同一判定(共享 [`require_gitea_kind`])。
    pub fn require_gitea(&self) -> Result<&Self, AppError> {
        require_gitea_kind(self.kind, &self.id)?;
        Ok(self)
    }

    /// 与 [`ResolvedRegistry::auth_config`] 同一判定(共享 [`build_auth_config`])。
    pub fn auth_config(
        &self,
        builtin_client_id: Option<&str>,
    ) -> Result<crate::core::auth::OAuthConfig, AppError> {
        build_auth_config(&self.base_url, self.builtin, builtin_client_id)
    }
}

fn require_gitea_kind(kind: RegistryKind, id: &str) -> Result<(), AppError> {
    match kind {
        RegistryKind::Gitea => Ok(()),
        RegistryKind::Github => Err(AppError::new(
            "REPO_KIND_UNSUPPORTED",
            "这个操作只适用于 Gitea 类型的技能库来源",
        )
        .with_detail(format!("registry {id} kind=github"))),
    }
}

fn build_auth_config(
    base_url: &str,
    builtin: bool,
    builtin_client_id: Option<&str>,
) -> Result<crate::core::auth::OAuthConfig, AppError> {
    let client_id = if builtin {
        builtin_client_id
            .filter(|c| !c.is_empty())
            .ok_or_else(|| {
                AppError::new(
                    "AUTH_NOT_CONFIGURED",
                    "这个版本没有配置公司技能库,请向 IT 索取正式安装包",
                )
            })?
            .to_string()
    } else {
        String::new()
    };
    Ok(crate::core::auth::OAuthConfig {
        base_url: base_url.to_string(),
        client_id,
    })
}

/// 新增自定义源的请求。`branch` 缺省按 `main`。
#[derive(Debug)]
pub struct AddRegistryRequest<'a> {
    pub name: &'a str,
    pub kind: &'a str,
    pub base_url: &'a str,
    pub owner: &'a str,
    pub repo: &'a str,
    pub branch: Option<&'a str>,
}

/// 仓库寻址键:`owner/repo`。源内唯一([`add_repo`] 查重),IPC 的 `repo` 参数原样带回。
pub fn repo_key(owner: &str, repo: &str) -> String {
    format!("{owner}/{repo}")
}

/// 源级坐标(kind + base_url + builtin 标记),**不含任何仓**。[`resolve`] 与
/// [`resolve_source`] 共用这一段——两处各自维护一份"id → kind/base_url"的判定
/// 正是 M9 任务 3/4 两次被判 DRY 违规的同类风险(同一段判定抄两遍,改一处漏一处)。
///
/// 三个分支与 [`resolve`] 逐条对应:plaza 给固定常量;builtin 只做 base_url 这一层
/// 检查(repo 是否配置是 [`resolve`] 自己的第二层检查,与"源"无关,留在调用方);
/// 自定义源做 id 查找 + kind 解析。
fn source_coords(
    builtin: &BuiltinSource,
    registries: &[RegistryConfig],
    id: &str,
) -> Result<(RegistryKind, String, bool), AppError> {
    if id == PLAZA_REGISTRY_ID {
        return Ok((RegistryKind::Github, PLAZA_BASE_URL.to_string(), false));
    }
    if id == BUILTIN_REGISTRY_ID {
        // 报错沿用 M1 `store_target` 的原文:文案已过术语守卫,前端也按它引导用户。
        let Some(base_url) = builtin.base_url.filter(|u| !u.is_empty()) else {
            return Err(AppError::new(
                "REPO_NOT_CONFIGURED",
                "这个版本没有配置公司技能库,请向 IT 索取正式安装包",
            ));
        };
        return Ok((RegistryKind::Gitea, base_url.to_string(), true));
    }
    let cfg = registries
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| unknown_registry(id))?;
    let kind = RegistryKind::parse(&cfg.kind)
        .ok_or_else(|| invalid_registry(format!("kind={}", cfg.kind)))?;
    Ok((kind, cfg.base_url.clone(), false))
}

/// 按 id + 仓库键解析出访问坐标。`BUILTIN_REGISTRY_ID` 的主仓走编译期常量、
/// 追加仓查 `builtin_extra`;`PLAZA_REGISTRY_ID` 查 `plaza_repos`(**没有主仓**,
/// `key = None` 报错——见该分支注释);其余查 `registries`。`repo_key = None`
/// 落主仓(内建 = 常量,自定义 = `repos[0]`)——既有调用方外部行为不变。
///
/// 与仓库无关的调用方(目前只有登录)请用 [`resolve_source`]:它不要求"默认
/// 技能库"存在,plaza 也能正常解出源级坐标。
pub fn resolve(
    builtin: &BuiltinSource,
    registries: &[RegistryConfig],
    builtin_extra: &[RepoConfig],
    id: &str,
    key: Option<&str>,
    plaza_repos: &[RepoConfig],
) -> Result<ResolvedRegistry, AppError> {
    if id == PLAZA_REGISTRY_ID {
        // 广场是搜索态,没有"默认技能库"这回事——`key=None` 不能像内建源那样落回
        // 一个编译期写死的主仓(广场压根没有主仓),必须报错。
        let Some(k) = key else {
            return Err(plaza_has_no_default_repo());
        };
        let repo = plaza_repos
            .iter()
            .find(|r| repo_key(&r.owner, &r.repo) == k)
            .ok_or_else(|| unknown_repo(k))?;
        return Ok(ResolvedRegistry {
            id: PLAZA_REGISTRY_ID.to_string(),
            kind: RegistryKind::Github,
            base_url: PLAZA_BASE_URL.to_string(),
            repo: RepoRef {
                owner: repo.owner.clone(),
                repo: repo.repo.clone(),
                branch: repo.branch.clone(),
            },
            builtin: false,
        });
    }
    if id == BUILTIN_REGISTRY_ID {
        let (kind, base_url, _) = source_coords(builtin, registries, id)?;
        let Some((owner, repo)) = builtin.repo else {
            return Err(AppError::new(
                "REPO_NOT_CONFIGURED",
                "这个版本没有指定公司技能库,请向 IT 索取正式安装包",
            ));
        };
        let primary = RepoRef {
            owner: owner.to_string(),
            repo: repo.to_string(),
            branch: builtin.branch.to_string(),
        };
        let selected = match key {
            None => primary,
            Some(k) if k == repo_key(&primary.owner, &primary.repo) => primary,
            Some(k) => builtin_extra
                .iter()
                .find(|r| repo_key(&r.owner, &r.repo) == k)
                .map(|r| RepoRef {
                    owner: r.owner.clone(),
                    repo: r.repo.clone(),
                    branch: r.branch.clone(),
                })
                .ok_or_else(|| unknown_repo(k))?,
        };
        return Ok(ResolvedRegistry {
            id: BUILTIN_REGISTRY_ID.to_string(),
            kind,
            base_url,
            repo: selected,
            builtin: true,
        });
    }
    let (kind, base_url, _) = source_coords(builtin, registries, id)?;
    // 上面已经确认过这个 id 存在(否则已经在 source_coords 里报错返回),这里的
    // find 保证命中——重新查一遍是为了拿到 `repos`(source_coords 只给 kind/base_url,
    // 不含仓库列表)。
    let cfg = registries
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| unknown_registry(id))?;
    let repo = match key {
        None => cfg.repos.first(),
        Some(k) => cfg.repos.iter().find(|r| repo_key(&r.owner, &r.repo) == k),
    }
    .ok_or_else(|| match key {
        None => invalid_registry("repos is empty".into()),
        Some(k) => unknown_repo(k),
    })?;
    Ok(ResolvedRegistry {
        id: cfg.id.clone(),
        kind,
        base_url,
        repo: RepoRef {
            owner: repo.owner.clone(),
            repo: repo.repo.clone(),
            branch: repo.branch.clone(),
        },
        builtin: false,
    })
}

/// 源级解析:只给 kind/base_url/builtin,不含任何仓库坐标(M9 终审修复)。
/// 行为与 [`resolve`] 对应分支完全一致(共享 [`source_coords`])。
///
/// 目前唯一的调用方是五个 `auth_*` command:登录/凭证管理不需要"默认技能库"这个
/// 概念,用 [`resolve`] 会让广场(没有主仓)必然报错——那个报错在登录语境下文不对题
/// (登录跟选哪个技能库无关)。广场因此在这里能正常解出 `kind=Github,
/// base_url=https://github.com`,不必先挂一个仓。
pub fn resolve_source(
    builtin: &BuiltinSource,
    registries: &[RegistryConfig],
    id: &str,
) -> Result<ResolvedSource, AppError> {
    let (kind, base_url, is_builtin) = source_coords(builtin, registries, id)?;
    Ok(ResolvedSource {
        id: id.to_string(),
        kind,
        base_url,
        builtin: is_builtin,
    })
}

/// 设置页的完整源列表:内建源永远第一位,其后按 config 中的顺序,**广场永远在末尾**。
///
/// 自定义条目的 `kind` 原样透出(不做"认不出就当 gitea"的粉饰):config 只可能被
/// 手改出垃圾值,真正的访问在 [`resolve`] 处会被拦,列表层如实展示才好排查。
///
/// 广场行**没有 `repo`**(广场无主仓概念,即便 `plaza_repos` 非空也不给)、
/// `repos` 里的每一条都 `locked: false`(仓本身可删,只是 v1 还没给它接 UI 入口;
/// **源**本身仍不可删,见 [`remove`])。`plaza_repos` 为空时这一行仍要出现——
/// 库切换器要能渲染出"空广场"这个状态,不能因为没有仓就整行消失。
pub fn list(
    builtin: &BuiltinSource,
    registries: &[RegistryConfig],
    builtin_extra: &[RepoConfig],
    plaza_repos: &[RepoConfig],
) -> Vec<RegistryView> {
    let mut out = Vec::with_capacity(registries.len() + 1);
    let mut builtin_repos = Vec::with_capacity(builtin_extra.len() + 1);
    if let Some((owner, repo)) = builtin.repo {
        builtin_repos.push(RepoView {
            key: repo_key(owner, repo),
            owner: owner.to_string(),
            repo: repo.to_string(),
            branch: builtin.branch.to_string(),
            name: None,
            primary: true,
            locked: true,
        });
        for r in builtin_extra {
            builtin_repos.push(repo_view(r, false));
        }
    }
    // 内建未注入配置时连追加仓也不列:没有主仓的"多仓"是无根的,前端只显示"构建未配置"。
    out.push(RegistryView {
        id: BUILTIN_REGISTRY_ID.to_string(),
        name: "公司技能库".to_string(),
        kind: "gitea".to_string(),
        base_url: builtin.base_url.unwrap_or("").to_string(),
        builtin: true,
        repo: builtin.repo.map(|(owner, repo)| RepoRef {
            owner: owner.to_string(),
            repo: repo.to_string(),
            branch: builtin.branch.to_string(),
        }),
        repos: builtin_repos,
    });
    for cfg in registries {
        out.push(RegistryView {
            id: cfg.id.clone(),
            name: cfg.name.clone(),
            kind: cfg.kind.clone(),
            base_url: cfg.base_url.clone(),
            builtin: false,
            repo: cfg.repos.first().map(|r| RepoRef {
                owner: r.owner.clone(),
                repo: r.repo.clone(),
                branch: r.branch.clone(),
            }),
            repos: cfg
                .repos
                .iter()
                .enumerate()
                .map(|(i, r)| repo_view(r, i == 0))
                .collect(),
        });
    }
    // 广场永远在末尾:它是搜索态,不是用户配置出来的源,排在自定义源之后最不显眼。
    out.push(RegistryView {
        id: PLAZA_REGISTRY_ID.to_string(),
        name: "技能广场".to_string(),
        kind: "github".to_string(),
        base_url: PLAZA_BASE_URL.to_string(),
        builtin: false,
        // 广场没有主仓概念,即便 plaza_repos 非空也不给——与内建/自定义源的
        // "首仓即主仓"语义刻意不同。
        repo: None,
        repos: plaza_repos.iter().map(|r| repo_view(r, false)).collect(),
    });
    out
}

fn repo_view(r: &RepoConfig, primary: bool) -> RepoView {
    RepoView {
        key: repo_key(&r.owner, &r.repo),
        owner: r.owner.clone(),
        repo: r.repo.clone(),
        branch: r.branch.clone(),
        name: r.name.clone(),
        primary,
        locked: false,
    }
}

/// 校验并追加自定义源,生成不与既有 id(含内建)冲突的新 id。返回新条目。
pub fn add(
    registries: &mut Vec<RegistryConfig>,
    req: &AddRegistryRequest,
) -> Result<RegistryConfig, AppError> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(invalid_registry("name is empty".into()));
    }
    if RegistryKind::parse(req.kind).is_none() {
        return Err(invalid_registry(format!("kind={}", req.kind)));
    }
    let base_url = normalize_base_url(req.base_url)
        .ok_or_else(|| invalid_registry(format!("baseUrl={}", req.base_url)))?;
    let (owner, repo) = (req.owner.trim(), req.repo.trim());
    if owner.is_empty() || repo.is_empty() {
        return Err(invalid_registry("owner/repo is empty".into()));
    }
    let branch = req
        .branch
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or("main");
    let cfg = RegistryConfig {
        id: next_id(registries),
        name: name.to_string(),
        kind: req.kind.to_string(),
        base_url,
        builtin: false,
        repos: vec![RepoConfig {
            owner: owner.to_string(),
            repo: repo.to_string(),
            branch: branch.to_string(),
            name: None,
        }],
    };
    registries.push(cfg.clone());
    Ok(cfg)
}

/// 给某个源追加技能库的请求。`branch` 缺省**跟随该源的主库**(见 [`add_repo`]);
/// `name` 是可选展示名。
#[derive(Debug)]
pub struct AddRepoRequest<'a> {
    pub owner: &'a str,
    pub repo: &'a str,
    pub branch: Option<&'a str>,
    pub name: Option<&'a str>,
}

/// 给源追加一个技能库(M4 任务 1)。
///
/// - 内建源:追加仓落 `builtin_extra`(即 `config.builtinExtraRepos`),坐标只有
///   owner/repo/branch——base_url 永远取编译期常量,同源由构造保证。
///   内建未注入配置时拒绝:没有主仓谈不上追加。
/// - 自定义源:落该源的 `repos`。
/// - 查重按寻址键 `owner/repo` 精确匹配(假设:同键异大小写视为不同仓,
///   Gitea/GitHub 的 URL 虽不区分大小写,但改写用户输入的坐标更危险)。
/// - **分支缺省跟随该源的主库**,不是写死 `main`:追加库与主库同在一台服务器上,
///   沿用主库的分支约定更接近事实。写死 `main` 会让一台默认分支是 `master` 的
///   服务器上加进来的库变成永久报错的死条目——而表单不给分支输入,用户救不回来。
/// - **广场(`PLAZA_REGISTRY_ID`)不接受这条通用入口**,报 `REPO_BUILTIN_LOCKED`:
///   `config.plazaRepos` 只该由"获取一个搜索结果"这个动作追加(广场没有手填
///   owner/repo 的表单),经这条入口手工塞坐标绕开了那份来源语义。
pub fn add_repo(
    builtin: &BuiltinSource,
    registries: &mut [RegistryConfig],
    builtin_extra: &mut Vec<RepoConfig>,
    id: &str,
    req: &AddRepoRequest,
) -> Result<RepoConfig, AppError> {
    if id == PLAZA_REGISTRY_ID {
        return Err(AppError::new(
            "REPO_BUILTIN_LOCKED",
            "技能广场是内建来源,不能手动添加技能库",
        ));
    }
    let (owner, repo) = (req.owner.trim(), req.repo.trim());
    if owner.is_empty() || repo.is_empty() {
        return Err(invalid_registry("owner/repo is empty".into()));
    }
    let key = repo_key(owner, repo);
    let explicit_branch = req.branch.map(str::trim).filter(|b| !b.is_empty());
    let name = req.name.map(str::trim).filter(|n| !n.is_empty()).map(String::from);
    let make = |default_branch: &str| RepoConfig {
        owner: owner.to_string(),
        repo: repo.to_string(),
        branch: explicit_branch.unwrap_or(default_branch).to_string(),
        name: name.clone(),
    };

    if id == BUILTIN_REGISTRY_ID {
        let Some((owner0, repo0)) = builtin.repo else {
            return Err(AppError::new(
                "REPO_NOT_CONFIGURED",
                "这个版本没有配置公司技能库,请向 IT 索取正式安装包",
            ));
        };
        let taken = repo_key(owner0, repo0) == key
            || builtin_extra.iter().any(|r| repo_key(&r.owner, &r.repo) == key);
        if taken {
            return Err(duplicate_repo(&key));
        }
        let entry = make(builtin.branch);
        builtin_extra.push(entry.clone());
        return Ok(entry);
    }
    let cfg = registries
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| unknown_registry(id))?;
    if cfg.repos.iter().any(|r| repo_key(&r.owner, &r.repo) == key) {
        return Err(duplicate_repo(&key));
    }
    let default_branch = cfg.repos.first().map(|r| r.branch.as_str()).unwrap_or("main");
    let entry = make(default_branch);
    cfg.repos.push(entry.clone());
    Ok(entry)
}

/// 广场专用的挂仓判定(M9 任务 3)。**唯一**被允许写 `config.plazaRepos` 的入口的
/// 前半段——`add_repo` 对 `PLAZA_REGISTRY_ID` 锁死(见其文档),广场坐标只能由
/// "获取一个搜索结果"这件事产生,不接受手填 owner/repo 的表单。
///
/// 这个坐标是否已经挂过。已挂 → 给出它的视图(`commands::plaza_ensure_repo`
/// 据此免发一次网络探测,幂等的关键就在这一步)。
pub fn find_plaza_repo(plaza_repos: &[RepoConfig], owner: &str, repo: &str) -> Option<RepoView> {
    let key = repo_key(owner, repo);
    plaza_repos
        .iter()
        .find(|r| repo_key(&r.owner, &r.repo) == key)
        .map(|r| repo_view(r, false))
}

/// 把一个新探测到的坐标追加进 `plaza_repos`,给出它的视图。
///
/// **调用前必须先 [`find_plaza_repo`] 确认不存在**——本函数不做去重。刻意不在这里
/// 重复查一遍:CLAUDE.md 测试要求点名的空转模式之一就是"同一条规则查两遍",
/// 其中一遍在正常调用路径下永远不触发,改坏也不会变红。去重判据只此一处。
pub fn record_plaza_repo(
    plaza_repos: &mut Vec<RepoConfig>,
    owner: &str,
    repo: &str,
    branch: String,
) -> RepoView {
    let entry = RepoConfig {
        owner: owner.to_string(),
        repo: repo.to_string(),
        branch,
        name: None,
    };
    plaza_repos.push(entry.clone());
    repo_view(&entry, false)
}

/// 从源里移除一个技能库。内建主仓锁定;自定义源不允许删到空
/// (最后一个仓请直接移除整个来源,免得留下一个解析必败的空壳源)。
pub fn remove_repo(
    builtin: &BuiltinSource,
    registries: &mut [RegistryConfig],
    builtin_extra: &mut Vec<RepoConfig>,
    id: &str,
    key: &str,
) -> Result<RepoConfig, AppError> {
    if id == BUILTIN_REGISTRY_ID {
        if builtin
            .repo
            .is_some_and(|(owner, repo)| repo_key(owner, repo) == key)
        {
            return Err(AppError::new(
                "REPO_BUILTIN_LOCKED",
                "公司主技能库是内建的,不能移除",
            ));
        }
        let pos = builtin_extra
            .iter()
            .position(|r| repo_key(&r.owner, &r.repo) == key)
            .ok_or_else(|| unknown_repo(key))?;
        return Ok(builtin_extra.remove(pos));
    }
    let cfg = registries
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| unknown_registry(id))?;
    let pos = cfg
        .repos
        .iter()
        .position(|r| repo_key(&r.owner, &r.repo) == key)
        .ok_or_else(|| unknown_repo(key))?;
    if cfg.repos.len() == 1 {
        return Err(AppError::new(
            "REPO_LAST_REPO",
            "这是该来源仅剩的技能库,请直接移除整个来源",
        ));
    }
    Ok(cfg.repos.remove(pos))
}

/// 移除自定义源。内建源、广场都报 `REPO_BUILTIN_LOCKED`;不存在报 `REPO_UNKNOWN_REGISTRY`。
pub fn remove(registries: &mut Vec<RegistryConfig>, id: &str) -> Result<RegistryConfig, AppError> {
    if id == BUILTIN_REGISTRY_ID {
        return Err(AppError::new(
            "REPO_BUILTIN_LOCKED",
            "公司技能库是内建来源,不能移除",
        ));
    }
    if id == PLAZA_REGISTRY_ID {
        return Err(AppError::new(
            "REPO_BUILTIN_LOCKED",
            "技能广场是内建来源,不能移除",
        ));
    }
    let pos = registries
        .iter()
        .position(|r| r.id == id)
        .ok_or_else(|| unknown_registry(id))?;
    Ok(registries.remove(pos))
}

/// `open_library_url` 的白名单判定:与任一已配置源(内建 + 自定义)同源才放行,
/// **加上 skills.sh 的技能详情页**(技能广场的搜索结果指向那里,不是 github.com——
/// `PLAZA_BASE_URL` 只是广场技能的**访问坐标**,不是它的展示页面)。
/// 非 http(s) scheme(`javascript:`/`file:` 等)在 [`gitea::is_same_origin`] 一层就被拒;
/// skills.sh 这一条同样借它判定,天然只放行 **https**(常量本身就是 https,
/// `is_same_origin` 要求 scheme 一致,`http://skills.sh` 因此被拒)。
pub fn url_allowed(builtin: &BuiltinSource, registries: &[RegistryConfig], url: &str) -> bool {
    builtin
        .base_url
        .filter(|u| !u.is_empty())
        .is_some_and(|b| gitea::is_same_origin(b, url))
        || registries
            .iter()
            .any(|r| gitea::is_same_origin(&r.base_url, url))
        || gitea::is_same_origin(crate::core::plaza::PLAZA_API_BASE, url)
}

fn unknown_registry(id: &str) -> AppError {
    AppError::new(
        "REPO_UNKNOWN_REGISTRY",
        "找不到这个技能库来源,可能已被移除,请刷新后再试",
    )
    .with_detail(id.to_string())
}

fn invalid_registry(detail: String) -> AppError {
    AppError::new(
        "REPO_INVALID_REGISTRY",
        "技能库来源的信息不完整或不合法,请检查后重试",
    )
    .with_detail(detail)
}

/// 广场没有主仓概念,`resolve(PLAZA_REGISTRY_ID, key=None)` 走到这里。
/// 独立错误码(不是 `unknown_registry`/`unknown_repo`)——广场本身认识,缺的是"默认"这件事。
fn plaza_has_no_default_repo() -> AppError {
    AppError::new(
        "REPO_UNKNOWN",
        "技能广场没有默认技能库,请先在广场里选择一个具体的技能",
    )
}

fn unknown_repo(key: &str) -> AppError {
    AppError::new(
        "REPO_UNKNOWN_REPO",
        "找不到这个技能库,可能已被移除,请刷新后再试",
    )
    .with_detail(key.to_string())
}

fn duplicate_repo(key: &str) -> AppError {
    AppError::new("REPO_DUPLICATE_REPO", "这个技能库已经在列表里了")
        .with_detail(key.to_string())
}

/// 校验并规整 base_url:仅认 http(s) 且必须有主机名,去掉尾部斜杠。
fn normalize_base_url(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.host_str()?;
    Some(url.as_str().trim_end_matches('/').to_string())
}

/// 生成 `custom-N`:取现存最大 N 加一,**绝不复用旧 id**——缓存文件与钥匙串凭证
/// 都按 id 落,复用会让新源捡到旧源的遗产。
fn next_id(registries: &[RegistryConfig]) -> String {
    let max = registries
        .iter()
        .filter_map(|r| r.id.strip_prefix("custom-"))
        .filter_map(|n| n.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("custom-{}", max + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_builtin() -> BuiltinSource {
        BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "main",
        }
    }

    /// 与内建源处处取不同值的自定义源,免得"两个概念同值"把差别测没。
    fn custom_cfg() -> RegistryConfig {
        RegistryConfig {
            id: "custom-1".into(),
            name: "部门工具库".into(),
            kind: "gitea".into(),
            base_url: "http://tools.example:8080".into(),
            builtin: false,
            repos: vec![RepoConfig {
                owner: "ai-skills".into(),
                repo: "dept-skills".into(),
                branch: "release".into(),
                name: None,
            }],
        }
    }

    /// 内建源上的追加仓。owner/branch 都与主仓取不同值,展示名非空——
    /// 每个字段的流转都能被单独验证。
    fn extra_repo() -> RepoConfig {
        RepoConfig {
            owner: "design".into(),
            repo: "design-skills".into(),
            branch: "stable".into(),
            name: Some("设计部技能库".into()),
        }
    }

    fn add_req<'a>() -> AddRegistryRequest<'a> {
        AddRegistryRequest {
            name: "部门工具库",
            kind: "gitea",
            base_url: "http://tools.example:8080",
            owner: "ai-skills",
            repo: "dept-skills",
            branch: None,
        }
    }

    #[test]
    fn builtin_is_always_listed_first_and_locked() {
        // 内建 + 一个自定义源 + 广场(永远在末尾,见下面 plaza 专属测试)= 3
        let listed = list(&fake_builtin(), &[custom_cfg()], &[], &[]);
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].id, BUILTIN_REGISTRY_ID);
        assert!(listed[0].builtin);
        assert_eq!(listed[0].base_url, "http://gitea.internal:3000");
        assert_eq!(
            listed[0].repo,
            Some(RepoRef {
                owner: "skills".into(),
                repo: "skills".into(),
                branch: "main".into(),
            })
        );
        assert_eq!(listed[1].id, "custom-1");
        assert!(!listed[1].builtin);
        assert_eq!(listed[1].name, "部门工具库");
        // 空 config 下内建源与广场也都在:列表永远不为空
        let only_builtin = list(&fake_builtin(), &[], &[], &[]);
        assert_eq!(only_builtin.len(), 2);
        assert!(only_builtin[0].builtin);
    }

    #[test]
    fn resolving_builtin_without_injection_gives_actionable_error() {
        for (base_url, repo) in [
            (None, Some(("skills", "skills"))),
            (Some(""), Some(("skills", "skills"))),
            (Some("http://gitea.internal:3000"), None),
        ] {
            let builtin = BuiltinSource {
                base_url,
                repo,
                branch: "main",
            };
            let err = resolve(&builtin, &[], &[], BUILTIN_REGISTRY_ID, None, &[]).unwrap_err();
            assert_eq!(err.code, "REPO_NOT_CONFIGURED");
            // 文案规范:必须给下一步动作,且不含 git 术语
            assert!(err.message.contains("IT"), "{}", err.message);
            assert!(!err.message.contains("仓库"), "{}", err.message);
        }
    }

    #[test]
    fn resolve_does_not_depend_on_oauth_configuration() {
        // 签名里根本没有 client_id——"商店浏览先于登录"这条产品前提的机器可读证据
        // (迁移自 commands.rs 的 store_target 同名测试,守的是同一件事)。
        let resolved = resolve(&fake_builtin(), &[], &[], BUILTIN_REGISTRY_ID, None, &[]).unwrap();
        assert_eq!(resolved.base_url, "http://gitea.internal:3000");
        assert_eq!(resolved.repo.owner, "skills");
        assert_eq!(resolved.repo.repo, "skills");
        assert_eq!(resolved.repo.branch, "main");
        assert_eq!(resolved.kind, RegistryKind::Gitea);
        assert!(resolved.builtin);
    }

    #[test]
    fn custom_gitea_source_resolves_from_config() {
        let resolved = resolve(&fake_builtin(), &[custom_cfg()], &[], "custom-1", None, &[]).unwrap();
        assert_eq!(resolved.id, "custom-1");
        assert_eq!(resolved.base_url, "http://tools.example:8080");
        assert_eq!(resolved.repo.owner, "ai-skills");
        assert_eq!(resolved.repo.repo, "dept-skills");
        assert_eq!(resolved.repo.branch, "release");
        assert!(!resolved.builtin);
        assert!(resolved.require_gitea().is_ok());
    }

    #[test]
    fn unknown_registry_id_gets_readable_error() {
        let err = resolve(&fake_builtin(), &[custom_cfg()], &[], "custom-99", None, &[]).unwrap_err();
        assert_eq!(err.code, "REPO_UNKNOWN_REGISTRY");
        // 人话 + 下一步动作;不把内部 id 塞进 message(那不是人话,detail 里才放)
        assert!(!err.message.contains("custom-99"), "{}", err.message);
        assert_eq!(err.detail.as_deref(), Some("custom-99"));
    }

    #[test]
    fn add_generates_unique_ids_never_colliding_with_builtin() {
        let mut regs = Vec::new();
        let first = add(&mut regs, &add_req()).unwrap();
        assert_eq!(first.id, "custom-1");
        let second = add(&mut regs, &add_req()).unwrap();
        assert_eq!(second.id, "custom-2");
        // 删掉 1 号再加:id 取 max+1,绝不复用旧 id(缓存文件与凭证都按 id 存)
        remove(&mut regs, "custom-1").unwrap();
        let third = add(&mut regs, &add_req()).unwrap();
        assert_eq!(third.id, "custom-3");
        for r in &regs {
            assert_ne!(r.id, BUILTIN_REGISTRY_ID);
            assert!(!r.builtin);
        }
        // 缺省分支落 main;显式给了就用给的
        assert_eq!(regs[0].repos[0].branch, "main");
        let mut req = add_req();
        req.branch = Some("release");
        let with_branch = add(&mut regs, &req).unwrap();
        assert_eq!(with_branch.repos[0].branch, "release");
    }

    #[test]
    fn add_validates_fields_and_rejects_garbage() {
        let cases: Vec<AddRegistryRequest> = vec![
            AddRegistryRequest { name: "  ", ..add_req() },
            AddRegistryRequest { kind: "svn", ..add_req() },
            AddRegistryRequest { base_url: "not a url", ..add_req() },
            AddRegistryRequest { base_url: "ftp://tools.example", ..add_req() },
            AddRegistryRequest { base_url: "javascript:alert(1)", ..add_req() },
            AddRegistryRequest { owner: "", ..add_req() },
            AddRegistryRequest { repo: "", ..add_req() },
        ];
        for req in &cases {
            let mut regs = Vec::new();
            let err = add(&mut regs, req).unwrap_err();
            assert_eq!(err.code, "REPO_INVALID_REGISTRY", "req={req:?}");
            assert!(regs.is_empty(), "垃圾请求不得留下半个条目:req={req:?}");
        }
    }

    #[test]
    fn remove_builtin_is_refused() {
        let mut regs = vec![custom_cfg()];
        let err = remove(&mut regs, BUILTIN_REGISTRY_ID).unwrap_err();
        assert_eq!(err.code, "REPO_BUILTIN_LOCKED");
        assert_eq!(regs.len(), 1, "拒绝内建源移除时不得动其他条目");
    }

    #[test]
    fn remove_unknown_is_reported() {
        let mut regs = vec![custom_cfg()];
        let err = remove(&mut regs, "custom-99").unwrap_err();
        assert_eq!(err.code, "REPO_UNKNOWN_REGISTRY");
        assert_eq!(regs.len(), 1);
        // 正常移除:返回被移除的条目
        let removed = remove(&mut regs, "custom-1").unwrap();
        assert_eq!(removed.id, "custom-1");
        assert!(regs.is_empty());
    }

    #[test]
    fn github_kind_is_stored_but_not_yet_accessible() {
        let mut regs = Vec::new();
        let mut req = add_req();
        req.kind = "github";
        req.base_url = "https://github.example";
        add(&mut regs, &req).unwrap();
        let resolved = resolve(&fake_builtin(), &regs, &[], "custom-1", None, &[]).unwrap();
        assert_eq!(resolved.kind, RegistryKind::Github);
        // GitHub client 归任务 4:在那之前访问被拦,且是人话
        let err = resolved.require_gitea().unwrap_err();
        assert_eq!(err.code, "REPO_KIND_UNSUPPORTED");
    }

    #[test]
    fn auth_config_for_builtin_requires_the_injected_client_id() {
        let resolved = resolve(&fake_builtin(), &[], &[], BUILTIN_REGISTRY_ID, None, &[]).unwrap();
        let cfg = resolved.auth_config(Some("client-abc")).unwrap();
        assert_eq!(cfg.base_url, "http://gitea.internal:3000");
        assert_eq!(cfg.client_id, "client-abc");
        for missing in [None, Some("")] {
            let err = resolved.auth_config(missing).unwrap_err();
            assert_eq!(err.code, "AUTH_NOT_CONFIGURED");
        }
    }

    #[test]
    fn auth_config_for_custom_source_never_borrows_the_builtin_client_id() {
        let resolved = resolve(&fake_builtin(), &[custom_cfg()], &[], "custom-1", None, &[]).unwrap();
        // 就算调用方把内建 Client ID 递进来,自定义源也不接:那是别家 Gitea
        let cfg = resolved.auth_config(Some("client-abc")).unwrap();
        assert_eq!(cfg.base_url, "http://tools.example:8080");
        assert_eq!(cfg.client_id, "");
    }

    #[test]
    fn config_roundtrip_preserves_registries() {
        use crate::core::state::Store;
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path());

        let mut config = store.load_config().unwrap().value;
        let auto_before = config.auto_update.clone();
        add(&mut config.registries, &add_req()).unwrap();
        store.save_config(&config).unwrap();

        let back = store.load_config().unwrap().value;
        assert_eq!(back.registries.len(), 1);
        assert_eq!(back.registries[0].id, "custom-1");
        assert_eq!(back.registries[0].name, "部门工具库");
        assert_eq!(back.registries[0].base_url, "http://tools.example:8080");
        // load-modify-save 只动 registries,其余字段原样
        assert_eq!(back.auto_update.skills.enabled, auto_before.skills.enabled);
        assert_eq!(
            back.auto_update.skills.interval_minutes,
            auto_before.skills.interval_minutes
        );
    }

    #[test]
    fn url_allowlist_covers_every_configured_origin() {
        let builtin = fake_builtin();
        let regs = vec![custom_cfg()];
        // 内建源与自定义源的同源地址都放行(含子路径)
        assert!(url_allowed(&builtin, &regs, "http://gitea.internal:3000/skills/skills/pulls/7"));
        assert!(url_allowed(&builtin, &regs, "http://tools.example:8080/ai-skills/dept-skills"));
        // 陌生 host、错端口、危险 scheme 一律拒
        assert!(!url_allowed(&builtin, &regs, "http://evil.example/skills"));
        assert!(!url_allowed(&builtin, &regs, "http://gitea.internal:9999/skills"));
        assert!(!url_allowed(&builtin, &regs, "javascript:alert(1)"));
        assert!(!url_allowed(&builtin, &regs, "file:///etc/passwd"));
        // 内建未注入的构建:自定义源照常放行,别的仍拒
        let unconfigured = BuiltinSource { base_url: None, repo: None, branch: "main" };
        assert!(url_allowed(&unconfigured, &regs, "http://tools.example:8080/x"));
        assert!(!url_allowed(&unconfigured, &regs, "http://gitea.internal:3000/x"));
    }

    // ============================================================ 一源多仓(M4 任务 1)

    #[test]
    fn builtin_repos_list_primary_first_with_lock_flags() {
        let listed = list(&fake_builtin(), &[], &[extra_repo()], &[]);
        let repos = &listed[0].repos;
        assert_eq!(repos.len(), 2);
        // 主仓:锁定、primary、键取编译期常量
        // (内建 fixture 的 owner 与 repo 同为 `skills`,拼错顺序看不出来——
        //  下面追加仓的两值不同,那条才是「键 = owner/repo 而非 repo/owner」的护栏)
        assert_eq!(repos[0].key, "skills/skills");
        assert!(repos[0].primary);
        assert!(repos[0].locked);
        assert_eq!(repos[0].branch, "main");
        // 追加仓:全部字段来自 config,可移除。owner 与 repo 取不同值,
        // 键拼成 `repo/owner` 会在这里变红
        assert_eq!(repos[1].key, "design/design-skills");
        assert_eq!(repos[1].owner, "design");
        assert_eq!(repos[1].repo, "design-skills");
        assert_eq!(repos[1].branch, "stable");
        assert_eq!(repos[1].name.as_deref(), Some("设计部技能库"));
        assert!(!repos[1].primary);
        assert!(!repos[1].locked);
        // 自定义源:首仓 primary 不锁定
        let listed = list(&fake_builtin(), &[custom_cfg()], &[], &[]);
        let repos = &listed[1].repos;
        assert_eq!(repos.len(), 1);
        assert!(repos[0].primary);
        assert!(!repos[0].locked);
        assert_eq!(repos[0].key, "ai-skills/dept-skills");
    }

    #[test]
    fn builtin_unconfigured_lists_no_repos_even_with_extras() {
        // 没有主仓的"多仓"是无根的:前端只显示"构建未配置"
        let unconfigured = BuiltinSource { base_url: None, repo: None, branch: "main" };
        let listed = list(&unconfigured, &[], &[extra_repo()], &[]);
        assert!(listed[0].repos.is_empty());
        assert!(listed[0].repo.is_none());
    }

    #[test]
    fn resolve_selects_repo_by_key() {
        let extras = [extra_repo()];
        // 内建:显式主仓键 = 缺省
        let primary = resolve(&fake_builtin(), &[], &extras, BUILTIN_REGISTRY_ID, Some("skills/skills"), &[]).unwrap();
        assert_eq!(primary.repo.owner, "skills");
        assert_eq!(primary.repo.repo, "skills");
        assert_eq!(primary.repo.branch, "main");
        // 内建:追加仓键 → 坐标来自 config,base_url 仍是编译期常量
        let extra = resolve(&fake_builtin(), &[], &extras, BUILTIN_REGISTRY_ID, Some("design/design-skills"), &[]).unwrap();
        assert_eq!(extra.base_url, "http://gitea.internal:3000");
        assert_eq!(extra.repo.owner, "design");
        assert_eq!(extra.repo.branch, "stable");
        assert!(extra.builtin);
        // 自定义:第二仓按键选中
        let mut cfg = custom_cfg();
        cfg.repos.push(RepoConfig {
            owner: "ai-skills".into(),
            repo: "qa-skills".into(),
            branch: "main".into(),
            name: None,
        });
        let second = resolve(&fake_builtin(), &[cfg], &[], "custom-1", Some("ai-skills/qa-skills"), &[]).unwrap();
        assert_eq!(second.repo.owner, "ai-skills");
        assert_eq!(second.repo.repo, "qa-skills");
        assert_eq!(second.repo.branch, "main");
    }

    #[test]
    fn resolve_unknown_repo_key_is_reported() {
        for (regs, id) in [
            (vec![], BUILTIN_REGISTRY_ID),
            (vec![custom_cfg()], "custom-1"),
        ] {
            let err = resolve(&fake_builtin(), &regs, &[extra_repo()], id, Some("ghost/none"), &[]).unwrap_err();
            assert_eq!(err.code, "REPO_UNKNOWN_REPO", "id={id}");
            // 键不是人话,只进 detail
            assert!(!err.message.contains("ghost"), "{}", err.message);
            assert_eq!(err.detail.as_deref(), Some("ghost/none"));
        }
    }

    #[test]
    fn add_repo_to_builtin_lands_in_extras() {
        let mut extras = Vec::new();
        let added = add_repo(
            &fake_builtin(),
            &mut [],
            &mut extras,
            BUILTIN_REGISTRY_ID,
            &AddRepoRequest { owner: "design", repo: "design-skills", branch: None, name: Some("  设计部技能库  ") },
        )
        .unwrap();
        // branch 缺省跟随主库(fixture 的主库是 main);展示名去空白
        assert_eq!(added.branch, "main");
        assert_eq!(added.name.as_deref(), Some("设计部技能库"));
        assert_eq!(extras.len(), 1);
        // 空展示名折成 None,不留空串污染 config
        let added2 = add_repo(
            &fake_builtin(),
            &mut [],
            &mut extras,
            BUILTIN_REGISTRY_ID,
            &AddRepoRequest { owner: "qa", repo: "qa-skills", branch: Some("release"), name: Some("  ") },
        )
        .unwrap();
        assert_eq!(added2.branch, "release");
        assert_eq!(added2.name, None);
    }

    #[test]
    fn added_repo_follows_the_primary_branch_not_a_hardcoded_main() {
        // 一台默认分支是 master 的服务器上,写死 main 会造出永久报错的死条目
        // ——而表单不给分支输入,用户救不回来。
        let master_builtin = BuiltinSource {
            base_url: Some("http://gitea.internal:3000"),
            repo: Some(("skills", "skills")),
            branch: "master",
        };
        let mut extras = Vec::new();
        let added = add_repo(
            &master_builtin,
            &mut [],
            &mut extras,
            BUILTIN_REGISTRY_ID,
            &AddRepoRequest { owner: "design", repo: "design-skills", branch: None, name: None },
        )
        .unwrap();
        assert_eq!(added.branch, "master");

        // 自定义源同理:跟随它自己的主库(fixture 的主库是 release)
        let mut regs = vec![custom_cfg()];
        let added = add_repo(
            &fake_builtin(),
            &mut regs,
            &mut Vec::new(),
            "custom-1",
            &AddRepoRequest { owner: "ai-skills", repo: "qa-skills", branch: None, name: None },
        )
        .unwrap();
        assert_eq!(added.branch, "release");

        // 显式给了就用给的,不被主库覆盖
        let explicit = add_repo(
            &fake_builtin(),
            &mut regs,
            &mut Vec::new(),
            "custom-1",
            &AddRepoRequest { owner: "ai-skills", repo: "dev-skills", branch: Some("develop"), name: None },
        )
        .unwrap();
        assert_eq!(explicit.branch, "develop");
    }

    #[test]
    fn add_repo_to_builtin_requires_configured_build() {
        let unconfigured = BuiltinSource { base_url: None, repo: None, branch: "main" };
        let mut extras = Vec::new();
        let err = add_repo(
            &unconfigured,
            &mut [],
            &mut extras,
            BUILTIN_REGISTRY_ID,
            &AddRepoRequest { owner: "a", repo: "b", branch: None, name: None },
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_NOT_CONFIGURED");
        assert!(extras.is_empty());
    }

    #[test]
    fn add_repo_rejects_duplicates_against_primary_and_extras() {
        let mut extras = vec![extra_repo()];
        // 与内建主仓撞键
        let err = add_repo(
            &fake_builtin(),
            &mut [],
            &mut extras,
            BUILTIN_REGISTRY_ID,
            &AddRepoRequest { owner: "skills", repo: "skills", branch: None, name: None },
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_DUPLICATE_REPO");
        // 与追加仓撞键
        let err = add_repo(
            &fake_builtin(),
            &mut [],
            &mut extras,
            BUILTIN_REGISTRY_ID,
            &AddRepoRequest { owner: "design", repo: "design-skills", branch: Some("other"), name: None },
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_DUPLICATE_REPO");
        assert_eq!(extras.len(), 1, "拒绝时不得留下条目");
        // 自定义源内撞键
        let mut regs = vec![custom_cfg()];
        let err = add_repo(
            &fake_builtin(),
            &mut regs,
            &mut Vec::new(),
            "custom-1",
            &AddRepoRequest { owner: "ai-skills", repo: "dept-skills", branch: None, name: None },
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_DUPLICATE_REPO");
        assert_eq!(regs[0].repos.len(), 1);
    }

    #[test]
    fn add_repo_validates_owner_and_repo() {
        for (owner, repo) in [("", "b"), ("a", ""), ("  ", "b")] {
            let err = add_repo(
                &fake_builtin(),
                &mut [],
                &mut Vec::new(),
                BUILTIN_REGISTRY_ID,
                &AddRepoRequest { owner, repo, branch: None, name: None },
            )
            .unwrap_err();
            assert_eq!(err.code, "REPO_INVALID_REGISTRY", "owner={owner:?} repo={repo:?}");
        }
        // 未知源
        let err = add_repo(
            &fake_builtin(),
            &mut [],
            &mut Vec::new(),
            "custom-99",
            &AddRepoRequest { owner: "a", repo: "b", branch: None, name: None },
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_UNKNOWN_REGISTRY");
    }

    #[test]
    fn remove_repo_builtin_primary_is_locked() {
        let mut extras = vec![extra_repo()];
        let err = remove_repo(&fake_builtin(), &mut [], &mut extras, BUILTIN_REGISTRY_ID, "skills/skills")
            .unwrap_err();
        assert_eq!(err.code, "REPO_BUILTIN_LOCKED");
        assert_eq!(extras.len(), 1, "拒绝时不得动追加仓");
        // 追加仓可移除,返回被移除的条目
        let removed = remove_repo(&fake_builtin(), &mut [], &mut extras, BUILTIN_REGISTRY_ID, "design/design-skills")
            .unwrap();
        assert_eq!(removed.repo, "design-skills");
        assert!(extras.is_empty());
        // 再删:已经不在了
        let err = remove_repo(&fake_builtin(), &mut [], &mut extras, BUILTIN_REGISTRY_ID, "design/design-skills")
            .unwrap_err();
        assert_eq!(err.code, "REPO_UNKNOWN_REPO");
    }

    #[test]
    fn remove_repo_refuses_to_empty_a_custom_source() {
        let mut regs = vec![custom_cfg()];
        let err = remove_repo(&fake_builtin(), &mut regs, &mut Vec::new(), "custom-1", "ai-skills/dept-skills")
            .unwrap_err();
        assert_eq!(err.code, "REPO_LAST_REPO");
        assert_eq!(regs[0].repos.len(), 1, "拒绝时仓列表不得被动过");
        // 有两个仓时可删,剩下的成为主仓
        regs[0].repos.push(RepoConfig {
            owner: "ai-skills".into(),
            repo: "qa-skills".into(),
            branch: "main".into(),
            name: None,
        });
        let removed = remove_repo(&fake_builtin(), &mut regs, &mut Vec::new(), "custom-1", "ai-skills/dept-skills")
            .unwrap();
        assert_eq!(removed.repo, "dept-skills");
        let primary = resolve(&fake_builtin(), &regs, &[], "custom-1", None, &[]).unwrap();
        assert_eq!(primary.repo.repo, "qa-skills");
    }

    #[test]
    fn config_roundtrip_preserves_builtin_extra_repos() {
        use crate::core::state::Store;
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::new(tmp.path());

        let mut config = store.load_config().unwrap().value;
        add_repo(
            &fake_builtin(),
            &mut config.registries,
            &mut config.builtin_extra_repos,
            BUILTIN_REGISTRY_ID,
            &AddRepoRequest { owner: "design", repo: "design-skills", branch: Some("stable"), name: Some("设计部技能库") },
        )
        .unwrap();
        store.save_config(&config).unwrap();

        let back = store.load_config().unwrap().value;
        assert_eq!(back.builtin_extra_repos.len(), 1);
        assert_eq!(back.builtin_extra_repos[0].owner, "design");
        assert_eq!(back.builtin_extra_repos[0].branch, "stable");
        assert_eq!(back.builtin_extra_repos[0].name.as_deref(), Some("设计部技能库"));
        // 旧 config 没有该字段:serde default 兜住,schemaVersion 不动(有既有闸门测试)
        assert_eq!(back.schema_version, crate::core::state::SCHEMA_VERSION);
    }

    // ============================================================ 技能广场(M9 任务 2)
    //
    // 动机见模块头新增的 PLAZA_REGISTRY_ID 注释:广场是内建源同款的锁定源,
    // 对"从 config 枚举"的代码不可见——下面每条测试独立盯住一处穿线,
    // 不合并成一条笼统断言(五处穿线的第一处:resolve/list/add/remove/防撞)。

    fn plaza_repo() -> RepoConfig {
        RepoConfig {
            owner: "vercel-labs".into(),
            repo: "skills".into(),
            branch: "main".into(),
            name: None,
        }
    }

    #[test]
    fn resolve_plaza_repo_by_key() {
        let resolved = resolve(
            &fake_builtin(),
            &[],
            &[],
            PLAZA_REGISTRY_ID,
            Some("vercel-labs/skills"),
            &[plaza_repo()],
        )
        .unwrap();
        assert_eq!(resolved.id, PLAZA_REGISTRY_ID);
        assert_eq!(resolved.kind, RegistryKind::Github);
        assert_eq!(resolved.base_url, PLAZA_BASE_URL);
        assert_eq!(resolved.repo.owner, "vercel-labs");
        assert_eq!(resolved.repo.repo, "skills");
        assert_eq!(resolved.repo.branch, "main");
        assert!(!resolved.builtin, "广场不是内建源(它没有 OAuth PKCE 登录这回事)");
    }

    /// 广场没有主仓概念:`key=None` 不能像内建源那样落回一个编译期写死的主仓,
    /// 必须报错——这是广场与内建源"同为锁定源"但语义不同的关键分歧点。
    #[test]
    fn resolve_plaza_without_a_key_is_an_error() {
        let err = resolve(
            &fake_builtin(),
            &[],
            &[],
            PLAZA_REGISTRY_ID,
            None,
            &[plaza_repo()],
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_UNKNOWN");
        // 人话,不是内部标识
        assert!(!err.message.contains("plaza"), "{}", err.message);
        assert!(!err.message.is_empty());
        // 上面传入的 plaza_repos 非空(&[plaza_repo()])仍然报错——
        // "有仓"不等于"有默认仓",广场压根没有"默认"这回事。
    }

    #[test]
    fn resolve_plaza_unknown_repo_key_is_reported() {
        let err = resolve(
            &fake_builtin(),
            &[],
            &[],
            PLAZA_REGISTRY_ID,
            Some("ghost/none"),
            &[plaza_repo()],
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_UNKNOWN_REPO", "与 unknown_repo() 同款,不是另起一套码");
        assert!(!err.message.contains("ghost"), "{}", err.message);
        assert_eq!(err.detail.as_deref(), Some("ghost/none"));
    }

    #[test]
    fn list_includes_the_plaza_row_even_when_it_has_no_repos() {
        // 库切换器要能渲染出"空广场"这个状态,不能因为没有仓就整行消失。
        let listed = list(&fake_builtin(), &[custom_cfg()], &[], &[]);
        let plaza_row = listed.last().expect("广场必须在,哪怕是空的");
        assert_eq!(plaza_row.id, PLAZA_REGISTRY_ID);
        assert_eq!(plaza_row.kind, "github");
        assert_eq!(plaza_row.base_url, PLAZA_BASE_URL);
        assert!(!plaza_row.builtin);
        assert!(plaza_row.repo.is_none(), "广场没有主仓概念,即便将来 plaza_repos 非空也不给");
        assert!(plaza_row.repos.is_empty());
        // 广场永远在末尾:内建 + 一个自定义源 + 广场 = 3
        assert_eq!(listed.len(), 3);
    }

    #[test]
    fn list_plaza_row_reflects_configured_repos_all_unlocked() {
        let listed = list(&fake_builtin(), &[], &[], &[plaza_repo()]);
        let plaza_row = listed.last().unwrap();
        assert_eq!(plaza_row.repos.len(), 1);
        assert_eq!(plaza_row.repos[0].key, "vercel-labs/skills");
        assert_eq!(plaza_row.repos[0].owner, "vercel-labs");
        assert_eq!(plaza_row.repos[0].repo, "skills");
        // 仓本身可删(v1 还没接 UI 入口,但不锁定);也没有"主仓"这回事
        assert!(!plaza_row.repos[0].locked);
        assert!(!plaza_row.repos[0].primary);
        assert!(plaza_row.repo.is_none());
    }

    #[test]
    fn remove_plaza_is_refused() {
        let mut regs = vec![custom_cfg()];
        let err = remove(&mut regs, PLAZA_REGISTRY_ID).unwrap_err();
        assert_eq!(err.code, "REPO_BUILTIN_LOCKED");
        assert_eq!(regs.len(), 1, "拒绝时不得动其他条目");
    }

    /// 广场的 `repos` 只该由"获取一个搜索结果"这个动作追加(没有手填 owner/repo 的表单),
    /// 通用的 `add_repo` 入口对它锁死——不锁的话就绕开了广场"仓来自搜索"的来源语义。
    #[test]
    fn add_repo_to_plaza_is_refused() {
        let mut extras = Vec::new();
        let err = add_repo(
            &fake_builtin(),
            &mut [],
            &mut extras,
            PLAZA_REGISTRY_ID,
            &AddRepoRequest { owner: "vercel-labs", repo: "skills", branch: None, name: None },
        )
        .unwrap_err();
        assert_eq!(err.code, "REPO_BUILTIN_LOCKED");
        assert!(extras.is_empty(), "拒绝时不得留下条目(这里的 extras 是内建源的,别误伤)");
    }

    /// 结构性护栏(2026-08-12 用户裁决):`next_id` 只产出 `custom-N`,天然不会撞上
    /// `PLAZA_REGISTRY_ID`。这条断言的价值在于将来有人改 id 生成规则时它会红,
    /// 不是现在会红——不为了让它现在变红而扭曲 `next_id` 的实现。
    #[test]
    fn generated_custom_ids_never_collide_with_the_plaza_id() {
        let mut regs = Vec::new();
        for _ in 0..5 {
            let added = add(&mut regs, &add_req()).unwrap();
            assert_ne!(added.id, PLAZA_REGISTRY_ID);
        }
    }

    /// skills.sh 的技能详情页(广场搜索结果指向那里)必须放行,且只放行 https,
    /// 不放宽成任意 URL——这个函数是从 webview 通往系统的通道。
    #[test]
    fn url_allowlist_permits_the_skills_dot_sh_detail_pages_over_https_only() {
        let builtin = fake_builtin();
        let regs = vec![custom_cfg()];
        assert!(url_allowed(&builtin, &regs, "https://skills.sh/vercel-labs/skills/weekly-report"));
        assert!(url_allowed(&builtin, &regs, "https://skills.sh"));
        // 仅 https:同一个 host 换成 http 就拒
        assert!(!url_allowed(&builtin, &regs, "http://skills.sh/vercel-labs/skills/weekly-report"));
        // 陌生 host、危险 scheme 仍然照旧拒绝
        assert!(!url_allowed(&builtin, &regs, "https://evil.example"));
        assert!(!url_allowed(&builtin, &regs, "javascript:alert(1)"));
        // 与是否配置了任何源无关:一个源都没有,skills.sh 仍然放行
        let unconfigured = BuiltinSource { base_url: None, repo: None, branch: "main" };
        assert!(url_allowed(&unconfigured, &[], "https://skills.sh/x"));
    }

    // ============================================================ 广场挂仓(M9 任务 3)

    #[test]
    fn find_plaza_repo_returns_none_when_not_yet_hung() {
        assert!(find_plaza_repo(&[], "vercel-labs", "skills").is_none());
        assert!(find_plaza_repo(&[plaza_repo()], "someone", "else").is_none());
    }

    #[test]
    fn find_plaza_repo_returns_the_view_when_present() {
        let view = find_plaza_repo(&[plaza_repo()], "vercel-labs", "skills")
            .expect("已挂过的坐标应能找到");
        assert_eq!(view.key, "vercel-labs/skills");
        assert_eq!(view.owner, "vercel-labs");
        assert_eq!(view.repo, "skills");
        assert_eq!(view.branch, "main");
        // 与 list() 里广场行的口径一致:没有主仓,仓本身不锁定
        assert!(!view.primary);
        assert!(!view.locked);
    }

    #[test]
    fn record_plaza_repo_appends_and_returns_a_matching_view() {
        let mut repos = Vec::new();
        let view = record_plaza_repo(&mut repos, "vercel-labs", "skills", "develop".into());
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].owner, "vercel-labs");
        assert_eq!(repos[0].repo, "skills");
        assert_eq!(repos[0].branch, "develop");
        assert_eq!(view.key, "vercel-labs/skills");
        assert_eq!(view.branch, "develop");
        assert!(!view.primary);
        assert!(!view.locked);

        // 挂完之后立刻能被 find 到,且分支是刚探测出的值——这正是 commands::plaza_ensure_repo
        // 幂等判定要用的路径。
        let found = find_plaza_repo(&repos, "vercel-labs", "skills").unwrap();
        assert_eq!(found.branch, "develop");
    }

    /// 挂完之后 `resolve(plaza, key)` 立即可用,分支取的正是刚记下的探测值
    /// ——这是 `plaza_ensure_repo` 与既有获取 IPC 之间唯一的耦合点,必须闭环。
    #[test]
    fn resolve_sees_a_repo_immediately_after_record_plaza_repo() {
        let mut repos = Vec::new();
        record_plaza_repo(&mut repos, "vercel-labs", "skills", "develop".into());

        let resolved = resolve(
            &fake_builtin(),
            &[],
            &[],
            PLAZA_REGISTRY_ID,
            Some("vercel-labs/skills"),
            &repos,
        )
        .unwrap();
        assert_eq!(resolved.repo.branch, "develop");
        assert_eq!(resolved.base_url, PLAZA_BASE_URL);
        assert_eq!(resolved.kind, RegistryKind::Github);
    }

    // ==================================================== resolve_source(M9 终审修复)

    /// 核心断言:广场**没有挂任何仓**时,`resolve_source` 仍能解出源级坐标——
    /// 这正是终审揪出的缺陷本身(登录五个 command 此前全部调 `resolve(id, None)`,
    /// 广场的这一条必然报 `REPO_UNKNOWN`)。故意注入验证的靶子:把这个分支删掉
    /// 换成走通用 `unknown_registry` 路径,这条断言必须变红。
    #[test]
    fn resolve_source_resolves_plaza_without_any_mounted_repo() {
        let resolved = resolve_source(&fake_builtin(), &[], PLAZA_REGISTRY_ID).unwrap();
        assert_eq!(resolved.id, PLAZA_REGISTRY_ID);
        assert_eq!(resolved.kind, RegistryKind::Github);
        assert_eq!(resolved.base_url, PLAZA_BASE_URL);
        assert!(!resolved.builtin);
        // 挂了仓也不影响——源级坐标压根不看 plaza_repos
        let mut repos = Vec::new();
        record_plaza_repo(&mut repos, "vercel-labs", "skills", "main".into());
        let resolved_with_repo = resolve_source(&fake_builtin(), &[], PLAZA_REGISTRY_ID).unwrap();
        assert_eq!(resolved_with_repo.base_url, PLAZA_BASE_URL);
    }

    /// `resolve_source` 与 `resolve(.., key=None)` 对内建源/自定义源给出完全一致的
    /// kind/base_url/builtin——两者是同一份坐标的两种"视角",不该在这三个字段上分叉。
    #[test]
    fn resolve_source_matches_resolve_for_builtin_and_custom() {
        let builtin = fake_builtin();
        let custom = vec![custom_cfg()];

        let via_source = resolve_source(&builtin, &[], BUILTIN_REGISTRY_ID).unwrap();
        let via_resolve = resolve(&builtin, &[], &[], BUILTIN_REGISTRY_ID, None, &[]).unwrap();
        assert_eq!(via_source.kind, via_resolve.kind);
        assert_eq!(via_source.base_url, via_resolve.base_url);
        assert_eq!(via_source.builtin, via_resolve.builtin);

        let via_source = resolve_source(&builtin, &custom, "custom-1").unwrap();
        let via_resolve = resolve(&builtin, &custom, &[], "custom-1", None, &[]).unwrap();
        assert_eq!(via_source.kind, via_resolve.kind);
        assert_eq!(via_source.base_url, via_resolve.base_url);
        assert_eq!(via_source.builtin, via_resolve.builtin);
    }

    /// 内建未注入配置的构建:`resolve_source` 与 `resolve` 报同一个错误码
    /// ——登录也该被同一句"请向 IT 索取正式安装包"挡住,不是另一套文案。
    #[test]
    fn resolve_source_reports_the_same_error_as_resolve_when_builtin_unconfigured() {
        let unconfigured = BuiltinSource { base_url: None, repo: None, branch: "main" };
        let err = resolve_source(&unconfigured, &[], BUILTIN_REGISTRY_ID).unwrap_err();
        assert_eq!(err.code, "REPO_NOT_CONFIGURED");
        assert!(err.message.contains("IT"), "{}", err.message);
    }

    #[test]
    fn resolve_source_unknown_registry_id_gets_readable_error() {
        let err = resolve_source(&fake_builtin(), &[custom_cfg()], "custom-99").unwrap_err();
        assert_eq!(err.code, "REPO_UNKNOWN_REGISTRY");
        assert!(!err.message.contains("custom-99"), "{}", err.message);
    }

    /// `require_gitea`/`auth_config` 在 `ResolvedRegistry` 与 `ResolvedSource` 两个
    /// 类型上必须给出相同判定——它们共享同一段逻辑(`require_gitea_kind`/
    /// `build_auth_config`),这条测试钉住"共享"这件事本身,而不只是各自测一遍。
    #[test]
    fn resolved_source_and_resolved_registry_share_the_same_gate_logic() {
        let builtin = fake_builtin();

        // Gitea 源:两条路都通过 require_gitea,auth_config 都要求注入 client id
        let via_registry = resolve(&builtin, &[], &[], BUILTIN_REGISTRY_ID, None, &[]).unwrap();
        let via_source = resolve_source(&builtin, &[], BUILTIN_REGISTRY_ID).unwrap();
        assert!(via_registry.require_gitea().is_ok());
        assert!(via_source.require_gitea().is_ok());
        assert_eq!(
            via_registry.auth_config(None).unwrap_err().code,
            via_source.auth_config(None).unwrap_err().code
        );
        assert_eq!(
            via_registry.auth_config(Some("cid")).unwrap().client_id,
            via_source.auth_config(Some("cid")).unwrap().client_id
        );

        // GitHub 源(广场):两条路都被 require_gitea 拒,错误码一致
        let mut repos = Vec::new();
        record_plaza_repo(&mut repos, "vercel-labs", "skills", "main".into());
        let via_registry =
            resolve(&builtin, &[], &[], PLAZA_REGISTRY_ID, Some("vercel-labs/skills"), &repos).unwrap();
        let via_source = resolve_source(&builtin, &[], PLAZA_REGISTRY_ID).unwrap();
        assert_eq!(
            via_registry.require_gitea().unwrap_err().code,
            via_source.require_gitea().unwrap_err().code
        );
    }
}
