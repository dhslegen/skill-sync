//! 打包配置守卫(任务 13)。
//!
//! tauri.conf.json 没有编译期检查,这里把 DoD 依赖的关键项钉住:
//! 改坏任何一条,拿到安装包的非研发同事就会在第一步卡住。

fn conf() -> serde_json::Value {
    let raw = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"),
    )
    .unwrap();
    serde_json::from_str(&raw).unwrap()
}

/// updater 插件**必须**在 conf 里有 `plugins.updater` 节,哪怕是空占位。
///
/// 这条是真机跑出来的:插件 setup 会反序列化 `plugins.updater`,缺这一节直接
/// `PluginInitialization` panic——**应用根本起不来**,而所有单测都照常绿(它们不启动 Tauri)。
/// 真值仍走编译期注入并在运行时用 `updater_builder()` 覆盖,所以这里的 pubkey/endpoints
/// 必须是空占位:填了真值就等于把内网地址写进仓库(铁律 5)。
#[test]
fn updater_plugin_needs_an_empty_placeholder_config() {
    let c = conf();
    let updater = &c["plugins"]["updater"];
    assert!(
        updater.is_object(),
        "缺 plugins.updater 节,应用启动时会 panic(插件初始化失败)"
    );
    assert_eq!(updater["pubkey"], "", "conf 里的 pubkey 必须是空占位,真值走编译期注入");
    assert_eq!(
        updater["endpoints"].as_array().map(Vec::len),
        Some(0),
        "conf 里不得出现真实更新源地址"
    );
}

/// updater 产物开关(M2 任务 5)的两侧配对:
/// - 主 conf **不开** createUpdaterArtifacts——否则没有签名私钥的日常构建直接失败;
/// - 发布通道(build-release.sh 与 release.yml)**必须开**——否则发布包没有 .sig,
///   自更新链路整个哑火。release.yml 上是**条件开**(私钥存在才开),见下一条测试。
///
/// 两侧一起断言,字段名拼错在任何一侧都逃不掉。
#[test]
fn updater_artifacts_are_release_only() {
    let c = conf();
    assert!(
        c["bundle"].get("createUpdaterArtifacts").is_none(),
        "createUpdaterArtifacts 不能进主 conf:日常构建没有签名私钥会直接失败"
    );

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let script = std::fs::read_to_string(root.join("scripts/build-release.sh")).unwrap();
    let workflow = std::fs::read_to_string(root.join(".github/workflows/release.yml")).unwrap();

    // 按**语义**断言而不是字面命令行:overlay 现在是动态拼的 JSON(要把 pubkey
    // 从环境变量注进去,见下一条断言),写死整串会在合理重构时误报。
    for (name, text) in [("build-release.sh", &script), ("release.yml", &workflow)] {
        assert!(
            text.contains("createUpdaterArtifacts"),
            "{name} 必须以 overlay 打开 updater 产物"
        );
        // 签名发生在**构建那一刻**,读的是 plugins.updater.pubkey;主 conf 里按铁律 5
        // 只有空占位,不在这里注入就会报 `Missing comment in public key`
        // ——2026-08-05 本地发版时真撞上,当时 CI 这条通道也一样漏了。
        assert!(
            text.contains("plugins") && text.contains("pubkey"),
            "{name} 必须把 updater 公钥注入构建期配置,否则出不了 .sig"
        );
        // tauri updater 默认拒绝 http 端点(连请求都不发就报错,还被包成 NET_UPDATE
        // 这种"看起来像网络问题"的文案)。内网 Gitea 是 http,不开这个口子,
        // 发布出去的每一个包都永远收不到更新——2026-08-05 用 0.1.0 实测自更新
        // 端到端时抓到,0.1.0 与第一版 0.2.0 都带着这个缺陷。完整性由 minisign
        // 签名兜底,明文传输在内网可接受(build-release.sh 对 http 另有显式警告)。
        assert!(
            text.contains("dangerousInsecureTransportProtocol"),
            "{name} 必须打开 dangerousInsecureTransportProtocol,否则 http 内网源的更新检查永远失败"
        );
    }

    // 发布闸门:更新三件套在本地通道全部必需;公开 CI 通道只必需前两个(见下一条测试)
    for name in ["SKILLSYNC_UPDATE_URL", "SKILLSYNC_UPDATE_PUBKEY", "TAURI_SIGNING_PRIVATE_KEY"] {
        assert!(script.contains(name), "build-release.sh 缺 {name} 的校验");
    }
    for name in ["SKILLSYNC_UPDATE_URL", "SKILLSYNC_UPDATE_PUBKEY"] {
        assert!(workflow.contains(name), "release.yml 缺 {name} 的注入/校验");
    }
}

/// 公开 CI 的保密边界(2026-08-07 用户拍板,M8):
/// 内网地址/坐标/公钥可以进公开仓 secrets 与 artifact,但 **minisign 私钥这类真秘密
/// 绝不配进公开仓**——release.yml 的 guard 不得把 TAURI_SIGNING_PRIVATE_KEY 列为必需,
/// 否则要么发布永远被拦,要么诱使人把私钥配上去。CI 产物因此不带 .sig,
/// 由本地 `pnpm tauri signer sign` 离线补签(私钥永不离开发布机)。
#[test]
fn public_ci_never_requires_the_signing_private_key() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let workflow = std::fs::read_to_string(root.join(".github/workflows/release.yml")).unwrap();

    // guard 校验私钥的历史写法是把它拼进 "NAME=$VALUE" 对;env 传递写法(NAME: ${{...}})
    // 不含 `TAURI_SIGNING_PRIVATE_KEY=$`。有人把私钥加回 guard 必需名单时这里变红。
    assert!(
        !workflow.contains("TAURI_SIGNING_PRIVATE_KEY=$"),
        "release.yml 的 guard 把签名私钥列为必需了——公开仓绝不配真秘密,\
         Windows 的 .sig 走本地离线补签,别把这道闸改回去"
    );
    // 哨兵注释:语义提醒必须留在 workflow 里,删注释视同删约束
    assert!(
        workflow.contains("故意不在必需名单"),
        "release.yml 里解释私钥为何不必需的注释被删了——下一个人会把它当遗漏补回去"
    );
    // 条件开关必须存在:私钥存在才开 createUpdaterArtifacts(迁内网 CI 后自动恢复出 .sig)
    assert!(
        workflow.contains("TAURI_SIGNING_PRIVATE_KEY)c.bundle={createUpdaterArtifacts:true}"),
        "release.yml 丢了「有私钥才开 createUpdaterArtifacts」的条件——\
         无条件开会让无私钥的 CI 构建直接失败"
    );
}

/// 发版脚本的 latest.json 必须三平台齐全(M8 任务 2)。
///
/// 公告牌是**整份重建**的:漏掉任何一个平台键,那个平台的老用户从此查更新永远
/// "已最新"、停在旧版——v0.1.0/v0.2.0 在 macOS 上踩过的坑,不能在 Windows 上重演。
/// 同时钉住 CI artifact 名的两侧接口:release.yml 上传 `skillsync-${{ runner.os }}`,
/// 发版脚本按 `skillsync-Windows` 下载,任一侧改名另一侧就断。
#[test]
fn publish_script_feeds_all_three_platforms() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let script = std::fs::read_to_string(root.join("scripts/publish-release.sh")).unwrap();
    let workflow = std::fs::read_to_string(root.join(".github/workflows/release.yml")).unwrap();

    for key in ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"] {
        assert!(script.contains(key), "publish-release.sh 的 latest.json 缺平台键 {key}");
    }
    assert!(
        script.contains("skillsync-Windows"),
        "publish-release.sh 不再按 skillsync-Windows 下载 CI artifact——与 release.yml 的接口断了"
    );
    assert!(
        workflow.contains("skillsync-${{ runner.os }}"),
        "release.yml 的 artifact 命名变了——publish-release.sh 按 skillsync-Windows 下载会 404"
    );
    assert!(
        script.contains("x64-setup.exe"),
        "publish-release.sh 丢了 NSIS exe 的产物名——Windows 包传不上发布仓"
    );
}

/// 发版必须带发版说明(2026-08-07 用户拍板,指定记进项目记忆)。
///
/// 此前所有 release 的正文都是脚本里写死的同一句"内部发布",同事拿到新包不知道
/// 该不该升。现在说明的唯一真相是 `RELEASE_NOTES.md`,发布脚本读不到对应版本的
/// 章节就拒绝发版。这条守卫钉住三件事:文件在、脚本确实读它、当前版本有章节
/// ——把"发版说明"从自觉变成闸门。
#[test]
fn every_release_must_carry_release_notes() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let notes = std::fs::read_to_string(root.join("RELEASE_NOTES.md"))
        .expect("缺 RELEASE_NOTES.md——发版说明的唯一真相,README 与内网 release 都从它来");
    let script = std::fs::read_to_string(root.join("scripts/publish-release.sh")).unwrap();

    assert!(
        script.contains("RELEASE_NOTES.md"),
        "publish-release.sh 不再读 RELEASE_NOTES.md——发版说明这道闸被绕过了"
    );

    // 当前版本必须已经有章节,否则下一次发版会在最后一刻才被拦下
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("src-tauri/tauri.conf.json")).unwrap())
            .unwrap();
    let version = conf["version"].as_str().expect("conf 必须有 version");
    assert!(
        notes.lines().any(|l| l.starts_with("## ") && l.contains(version)),
        "RELEASE_NOTES.md 里没有当前版本 {version} 的章节——发版会被脚本拒绝"
    );
}

#[test]
fn windows_installer_must_not_require_admin() {
    // DoD:非研发配置的 Windows 机、普通用户、零命令行。
    // perMachine 安装会弹 UAC 要管理员——公司受限机器上直接装不了。
    let c = conf();
    assert_eq!(
        c["bundle"]["windows"]["nsis"]["installMode"], "currentUser",
        "NSIS 必须按当前用户安装,普通员工没有管理员权限"
    );
}

#[test]
fn bundle_targets_are_the_two_platforms_we_ship() {
    let c = conf();
    let targets: Vec<&str> = c["bundle"]["targets"]
        .as_array()
        .expect("targets 应当是明确的清单,不是 all")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    for need in ["dmg", "nsis"] {
        assert!(targets.contains(&need), "缺 {need}:对应平台的安装包发不出去");
    }
    assert!(
        !targets.iter().any(|t| ["deb", "rpm", "appimage"].contains(t)),
        "M1 不发 Linux 包,留着只会拖慢构建还引来没人测过的产物"
    );
}

#[test]
fn csp_is_locked_down() {
    // 架构铁律 1:前端不发任何 HTTP。CSP 是这条铁律在运行时的自动门——
    // 就算未来某个依赖偷偷 fetch 外部资源,也会被 WebView 当场拦下。
    let c = conf();
    let csp = c["app"]["security"]["csp"]
        .as_str()
        .expect("CSP 不能是 null:那等于把铁律 1 交给自觉");
    assert!(csp.contains("default-src 'self'"), "CSP 必须以 self 为基线: {csp}");
    assert!(
        !csp.contains("http:") && !csp.contains("https:"),
        "CSP 不该放行外部网络来源: {csp}"
    );
}

#[test]
fn macos_uses_the_overlay_titlebar_the_shell_was_built_for() {
    // 任务 8 起外壳就给红绿灯让出了 44px 拖拽区;不开 Overlay 会出现双标题栏
    let c = conf();
    assert_eq!(c["app"]["windows"][0]["titleBarStyle"], "Overlay");
    assert_eq!(c["app"]["windows"][0]["hiddenTitle"], true);
}

#[test]
fn version_is_consistent_across_manifests() {
    // 三处版本号不一致时,"关于"里显示的与安装包文件名对不上,排障全乱套
    let c = conf();
    let cargo: toml::Value = toml::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        )
        .unwrap(),
    )
    .unwrap();
    let pkg: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../package.json"),
        )
        .unwrap(),
    )
    .unwrap();

    let conf_ver = c["version"].as_str().unwrap();
    assert_eq!(cargo["package"]["version"].as_str().unwrap(), conf_ver);
    assert_eq!(pkg["version"].as_str().unwrap(), conf_ver);
}

/// `build.rs` 的 `rerun-if-env-changed` 清单必须覆盖 `builtin.rs` 里的每一个
/// `option_env!` 变量。
///
/// 漏一个的后果是**静默的**:只改那个变量时 cargo 不认为需要重编译,
/// `option_env!` 仍展开成上一次构建的值,二进制里留着旧地址/旧仓库坐标——
/// 表现为"配置明明改了却不生效"。历史上 REPO/BRANCH 与两个 UPDATE_* 就漏在外面。
#[test]
fn build_rs_watches_every_compile_time_constant() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let builtin = std::fs::read_to_string(dir.join("src/core/builtin.rs")).unwrap();
    let build_rs = std::fs::read_to_string(dir.join("build.rs")).unwrap();

    let used: Vec<String> = builtin
        .match_indices("option_env!(\"")
        .map(|(i, pat)| {
            let rest = &builtin[i + pat.len()..];
            rest[..rest.find('"').unwrap()].to_string()
        })
        .collect();
    assert!(!used.is_empty(), "没扫到 option_env!,守卫本身失效了");

    let missing: Vec<&String> = used.iter().filter(|v| !build_rs.contains(*v)).collect();
    assert!(
        missing.is_empty(),
        "build.rs 漏了这些变量的 rerun-if-env-changed,改它们不会触发重编译:{missing:?}"
    );
}

/// 钥匙串的 service 名**故意与 bundle identifier 不一致**,别"顺手对齐"。
///
/// 2026-08-04 把 identifier 从 `com.skillsync.app` 改成 `com.dhslegen.skillsync`
/// (原值以 `.app` 结尾,与 macOS 应用包扩展名冲突)。`KEYRING_SERVICE` 保持旧值——
/// keyring 是**按 service 名查凭证**的,跟着改等于让所有已登录用户的凭证突然读不到、
/// 得重新登录一次。而这个后果是**静默的**:测试全绿、应用照常启动,
/// 要到用户手里才发现自己被登出了。所以用一条守卫钉死它。
#[test]
fn keyring_service_name_is_pinned_independently_of_the_bundle_id() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let auth = std::fs::read_to_string(dir.join("src/core/auth.rs")).unwrap();
    assert!(
        auth.contains(r#"const KEYRING_SERVICE: &str = "com.skillsync.app";"#),
        "KEYRING_SERVICE 被改了。改它会让所有已登录用户丢失凭证——\
         若确实要改,得先设计一次凭证迁移(读旧 service 名、写新的),而不是直接换字符串"
    );

    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("tauri.conf.json")).unwrap())
            .unwrap();
    let id = conf["identifier"].as_str().expect("identifier 必须有");
    assert!(
        !id.ends_with(".app"),
        "bundle identifier 不能以 .app 结尾:与 macOS 应用包扩展名冲突,tauri 会告警"
    );
}
