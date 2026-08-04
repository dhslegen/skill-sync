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
///   自更新链路整个哑火。
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
    let overlay = r#"--config '{"bundle":{"createUpdaterArtifacts":true}}'"#;
    let script = std::fs::read_to_string(root.join("scripts/build-release.sh")).unwrap();
    assert!(script.contains(overlay), "build-release.sh 必须以 overlay 打开 updater 产物");
    let workflow = std::fs::read_to_string(root.join(".github/workflows/release.yml")).unwrap();
    assert!(workflow.contains(overlay), "release.yml 必须以 overlay 打开 updater 产物");

    // 发布闸门:三个新变量在两条发布通道里都有校验
    for name in ["SKILLSYNC_UPDATE_URL", "SKILLSYNC_UPDATE_PUBKEY", "TAURI_SIGNING_PRIVATE_KEY"] {
        assert!(script.contains(name), "build-release.sh 缺 {name} 的校验");
        assert!(workflow.contains(name), "release.yml 缺 {name} 的注入/校验");
    }
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
