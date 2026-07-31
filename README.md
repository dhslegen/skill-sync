# SkillSync

企业内网 AI Skill 共享桌面客户端。给非研发同事一个"应用商店"式界面,一键获取/分享/自动更新 AI agent skills。

- 技术栈:Tauri 2 + Rust / React 19 + TypeScript + Tailwind v4
- 开发规范与架构铁律见 [CLAUDE.md](./CLAUDE.md)

## 开发

```bash
pnpm install
# 本地联调内建技能库时,先在 shell 导出编译期常量(不要写入任何仓库文件):
# export SKILLSYNC_BUILTIN_GITEA_URL=...   # 内网 Gitea 地址
# export SKILLSYNC_OAUTH_CLIENT_ID=...     # OAuth2 公共客户端 ID(PKCE,无 secret)
pnpm dev        # 启动桌面应用(tauri dev)
```

提交前跑完这四道闸(缺一不可,`build:web` 最容易漏——vitest 不做类型检查):

```bash
pnpm test        # 前端单测
pnpm lint        # eslint
pnpm build:web   # tsc + vite build
cd src-tauri && cargo test --workspace && cargo clippy -- -D warnings
```

动了 `tauri::Builder` 的插件/setup/窗口配置后,还要跑一次 `pnpm dev` 启动冒烟
——两套测试都不启动 Tauri runtime,插件初始化失败会让应用起不来而测试全绿。
