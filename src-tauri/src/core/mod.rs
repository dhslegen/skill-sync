//! SkillSync 业务核心。全部业务逻辑在此层实现,`commands.rs` 只做 IPC 薄壳。

pub mod acquire;
pub mod agents;
pub mod auth;
pub mod builtin;
pub mod create;
pub mod fsops;
pub mod gitea;
pub mod github;
pub mod installer;
pub mod local_detail;
pub mod registry;
pub mod remove;
pub mod scheduler;
pub mod session;
pub mod share;
pub mod skill_lock;
pub mod skills;
pub mod state;
pub mod store;
pub mod watcher;
