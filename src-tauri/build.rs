fn main() {
    // 编译期注入的内建常量(架构铁律 5):变量变化时触发重新编译,
    // 避免切换构建环境后残留旧地址。
    println!("cargo:rerun-if-env-changed=SKILLSYNC_BUILTIN_GITEA_URL");
    println!("cargo:rerun-if-env-changed=SKILLSYNC_OAUTH_CLIENT_ID");
    tauri_build::build()
}
