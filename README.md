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
pnpm test       # 前端单测
pnpm lint       # eslint
cd src-tauri && cargo test && cargo clippy -- -D warnings
```
