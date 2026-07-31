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
