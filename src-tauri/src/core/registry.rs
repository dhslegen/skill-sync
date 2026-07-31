//! 仓库源管理:内建公司 Gitea(builtin,不可删)+ 用户自定义 Gitea/GitHub 源。
//!
//! **仍是空壳,归 M3**。M1/M2 全程只有内建源一个,`commands.rs` 里到处是
//! `BUILTIN_REGISTRY_ID = "company"` 的硬编码,坐标直接取编译期常量
//! (`builtin_store_target()`)——多源要从这两处开刀。
//!
//! 数据结构已经就位:`state::Config::registries`(`RegistryConfig`/`RepoConfig`)
//! 定义好了但没人读;凭证也已经按 registryId 分开存(`auth::CredentialStore`
//! 的 `account` 参数就是它),这两样 M3 不必重做。
