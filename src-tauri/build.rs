fn main() {
    // 编译期注入的内建常量(架构铁律 5):变量变化时触发重新编译,
    // 避免切换构建环境后残留旧地址。
    //
    // 必须与 core/builtin.rs 里 option_env! 的清单**逐个对齐**:漏声明的那个
    // 在"只改它"时不会触发重编译,二进制里留着上一次构建的值——改了仓库坐标
    // 却仍指向旧库这类问题,表现是"配置明明改了却不生效",极难查。
    for var in [
        "SKILLSYNC_BUILTIN_GITEA_URL",
        "SKILLSYNC_OAUTH_CLIENT_ID",
        "SKILLSYNC_BUILTIN_REPO",
        "SKILLSYNC_BUILTIN_BRANCH",
        "SKILLSYNC_GITHUB_CLIENT_ID",
        "SKILLSYNC_UPDATE_URL",
        "SKILLSYNC_UPDATE_PUBKEY",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    tauri_build::build()
}
