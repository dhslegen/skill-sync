//! 文件系统操作统一入口(架构铁律 3)。
//! 含 symlink→junction→copy 降级链、realpath 防环;禁止在其他模块直接调用 std::fs 链接 API。
//! M1 任务 6 实现。
