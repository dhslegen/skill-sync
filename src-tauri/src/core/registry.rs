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
//! - 每个源当前只用 `repos[0]`(M1 起就是单仓模型)。假设:一源多仓的产品形态未定,归 M4。

use serde::Serialize;

use crate::core::gitea::{self, RepoRef};
use crate::core::state::{RegistryConfig, RepoConfig};
use crate::error::AppError;

/// 内建技能库的 registry id。M1 只有这一个源,多源起按 id 区分凭证与缓存。
pub const BUILTIN_REGISTRY_ID: &str = "company";

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
    pub repo: Option<RepoRef>,
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
    /// Gitea 专用链路(商店/获取/分享/scheduler)的类型闸门。
    /// GitHub client 是 M3 任务 4:接通后此闸门摘除。
    pub fn require_gitea(&self) -> Result<&Self, AppError> {
        match self.kind {
            RegistryKind::Gitea => Ok(self),
            RegistryKind::Github => Err(AppError::new(
                "REPO_KIND_UNSUPPORTED",
                "GitHub 技能库来源将在后续版本开放,当前还不能访问",
            )
            .with_detail(format!("registry {} kind=github", self.id))),
        }
    }
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

/// 按 id 解析出访问坐标。`BUILTIN_REGISTRY_ID` 走编译期常量,其余查 `registries`。
pub fn resolve(
    builtin: &BuiltinSource,
    registries: &[RegistryConfig],
    id: &str,
) -> Result<ResolvedRegistry, AppError> {
    if id == BUILTIN_REGISTRY_ID {
        // 两条报错沿用 M1 `store_target` 的原文:文案已过术语守卫,前端也按它引导用户。
        let Some(base_url) = builtin.base_url.filter(|u| !u.is_empty()) else {
            return Err(AppError::new(
                "REPO_NOT_CONFIGURED",
                "这个版本没有配置公司技能库,请向 IT 索取正式安装包",
            ));
        };
        let Some((owner, repo)) = builtin.repo else {
            return Err(AppError::new(
                "REPO_NOT_CONFIGURED",
                "这个版本没有指定公司技能库,请向 IT 索取正式安装包",
            ));
        };
        return Ok(ResolvedRegistry {
            id: BUILTIN_REGISTRY_ID.to_string(),
            kind: RegistryKind::Gitea,
            base_url: base_url.to_string(),
            repo: RepoRef {
                owner: owner.to_string(),
                repo: repo.to_string(),
                branch: builtin.branch.to_string(),
            },
            builtin: true,
        });
    }
    let cfg = registries
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| unknown_registry(id))?;
    let kind = RegistryKind::parse(&cfg.kind)
        .ok_or_else(|| invalid_registry(format!("kind={}", cfg.kind)))?;
    let repo = cfg
        .repos
        .first()
        .ok_or_else(|| invalid_registry("repos is empty".into()))?;
    Ok(ResolvedRegistry {
        id: cfg.id.clone(),
        kind,
        base_url: cfg.base_url.clone(),
        repo: RepoRef {
            owner: repo.owner.clone(),
            repo: repo.repo.clone(),
            branch: repo.branch.clone(),
        },
        builtin: false,
    })
}

/// 设置页的完整源列表:内建源永远第一位,其后按 config 中的顺序。
///
/// 自定义条目的 `kind` 原样透出(不做"认不出就当 gitea"的粉饰):config 只可能被
/// 手改出垃圾值,真正的访问在 [`resolve`] 处会被拦,列表层如实展示才好排查。
pub fn list(builtin: &BuiltinSource, registries: &[RegistryConfig]) -> Vec<RegistryView> {
    let mut out = Vec::with_capacity(registries.len() + 1);
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
        });
    }
    out
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
        }],
    };
    registries.push(cfg.clone());
    Ok(cfg)
}

/// 移除自定义源。内建源报 `REPO_BUILTIN_LOCKED`;不存在报 `REPO_UNKNOWN_REGISTRY`。
pub fn remove(registries: &mut Vec<RegistryConfig>, id: &str) -> Result<RegistryConfig, AppError> {
    if id == BUILTIN_REGISTRY_ID {
        return Err(AppError::new(
            "REPO_BUILTIN_LOCKED",
            "公司技能库是内建来源,不能移除",
        ));
    }
    let pos = registries
        .iter()
        .position(|r| r.id == id)
        .ok_or_else(|| unknown_registry(id))?;
    Ok(registries.remove(pos))
}

/// `open_library_url` 的白名单判定:与任一已配置源(内建 + 自定义)同源才放行。
/// 非 http(s) scheme(`javascript:`/`file:` 等)在 [`gitea::is_same_origin`] 一层就被拒。
pub fn url_allowed(builtin: &BuiltinSource, registries: &[RegistryConfig], url: &str) -> bool {
    builtin
        .base_url
        .filter(|u| !u.is_empty())
        .is_some_and(|b| gitea::is_same_origin(b, url))
        || registries
            .iter()
            .any(|r| gitea::is_same_origin(&r.base_url, url))
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
            }],
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
        let listed = list(&fake_builtin(), &[custom_cfg()]);
        assert_eq!(listed.len(), 2);
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
        // 空 config 下内建源也在:列表永远不为空
        let only_builtin = list(&fake_builtin(), &[]);
        assert_eq!(only_builtin.len(), 1);
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
            let err = resolve(&builtin, &[], BUILTIN_REGISTRY_ID).unwrap_err();
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
        let resolved = resolve(&fake_builtin(), &[], BUILTIN_REGISTRY_ID).unwrap();
        assert_eq!(resolved.base_url, "http://gitea.internal:3000");
        assert_eq!(resolved.repo.owner, "skills");
        assert_eq!(resolved.repo.repo, "skills");
        assert_eq!(resolved.repo.branch, "main");
        assert_eq!(resolved.kind, RegistryKind::Gitea);
        assert!(resolved.builtin);
    }

    #[test]
    fn custom_gitea_source_resolves_from_config() {
        let resolved = resolve(&fake_builtin(), &[custom_cfg()], "custom-1").unwrap();
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
        let err = resolve(&fake_builtin(), &[custom_cfg()], "custom-99").unwrap_err();
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
        let resolved = resolve(&fake_builtin(), &regs, "custom-1").unwrap();
        assert_eq!(resolved.kind, RegistryKind::Github);
        // GitHub client 归任务 4:在那之前访问被拦,且是人话
        let err = resolved.require_gitea().unwrap_err();
        assert_eq!(err.code, "REPO_KIND_UNSUPPORTED");
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
            back.auto_update.skills.interval_hours,
            auto_before.skills.interval_hours
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
}
