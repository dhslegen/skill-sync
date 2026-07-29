# SkillSync — 企业内网 AI Skill 共享桌面客户端

给非研发同事一个"应用商店"式界面,从公司 Gitea 一键获取/分享/自动更新 AI agent skills,零 git 概念。

## 技术栈(锁定,勿擅自更换)
- Tauri 2.x + Rust (edition 2021, stable toolchain) / 前端 React 19 + TypeScript + Vite(假设:交接包草案写 React 18,但 create-tauri-app 与 shadcn/ui Base UI 底座当前默认 React 19,按 19 执行)
- 状态管理 Zustand;UI 组件库 **shadcn/ui(Base UI 底座)+ tweakcn 换肤**;样式 Tailwind(v4, `@theme` token)
- HTTP: Rust 侧 reqwest;序列化 serde;密钥存储 keyring crate;日志 tracing + 滚动文件
- 包管理 pnpm;Rust 侧 workspace: src-tauri/

## 架构铁律
1. 所有业务逻辑在 Rust core(src-tauri/src/core/),前端只做展示与交互;**前端不直接发任何 HTTP 请求**
2. 与 Gitea/GitHub 的一切交互走 REST/GraphQL API,**禁止引入 git2/libgit2/嵌入式 git**
3. 文件系统操作全部经过 core::fsops 模块(含 symlink→junction→copy 降级链),禁止散落各处直接 std::fs::symlink
4. canonical 目录布局必须与 npx skills 兼容(`~/.agents/skills/` + `~/.agents/.skill-lock.json` 双写)
5. 内网 Gitea baseUrl 来自编译期环境变量 `SKILLSYNC_BUILTIN_GITEA_URL`,OAuth Client ID 来自 `SKILLSYNC_OAUTH_CLIENT_ID`;**源码中不得出现真实内网地址,不得出现任何 OAuth secret**(公共客户端 + PKCE,无 secret)
6. 用户可见文案全部走 i18n 资源文件(zh-CN 为主),禁用 git 术语(见 docs/terminology.md):commit→保存、push→分享、pull→获取、repository→技能库、branch/PR→提交审核
7. **绝不静默删除用户文件**;所有破坏性操作需前端确认结果作为参数传入

## 常用命令
```
pnpm dev            # tauri dev
pnpm build          # tauri build(需签名环境变量,本地开发跳过)
pnpm test           # 前端 vitest
cargo test --workspace   # Rust 单测(在 src-tauri/ 下)
pnpm lint           # eslint
cargo clippy -- -D warnings
pnpm verify:agents     # 与上游 vercel-labs/skills 差分校验 agents.json 并重生成 fixture(需联网)
pnpm verify:discovery  # 同上,校验技能发现规则
```

## 目录结构
```
src/                 # React 前端(pages/ store/ components/ i18n/)
src-tauri/src/
  core/registry.rs   # 仓库源管理(内建 Gitea + 自定义)
  core/auth.rs       # OAuth PKCE(主)+ PAT(备用)+ keyring
  core/gitea.rs      # Gitea API client(archive 下载、contents 提交、branches、pulls)
  core/github.rs     # GitHub client(M3 前留空壳)
  core/skills.rs     # skill 发现/解析(SKILL.md frontmatter)
  core/installer.rs  # canonical + 链接层(symlink→junction→copy 降级)
  core/agents.rs     # agent 注册表加载与探测(数据在 resources/agents.json)
  core/fsops.rs      # 文件系统操作统一入口
  core/state.rs      # config.json/state.json 读写 + skill-lock 双写 + schema 迁移
  core/scheduler.rs  # 定时更新检查(M2)
  commands.rs        # Tauri IPC command 定义(薄壳,逻辑在 core)
resources/agents.json   # 75-agent 注册表(移植自 vercel-labs/skills v1.5.20,MIT,保留出处注释)
scripts/             # 维护脚本(verify-*.mjs:跑上游源码生成 ground-truth fixture,供 Rust 差分测试)
fixtures/            # docker Gitea 测试环境 + 样例技能仓库(见交接包 3.6)
docs/                # 设计方案、交接包、UI 规范、UI-Demo、术语表
```

## UI 规范(已拍板,详见 docs/UI设计规范.md,违反第 2 节即打回)
- **视觉基准 = docs/SkillSync-UI-Demo.html**,最终实现观感必须与它一致;信息密度对齐该 Demo,不得放宽
- 强调色默认陶土橙 `#c2410c`(深色 `#e05d2a`),可切深青绿 `#0d7a68` / 墨蓝 `#1e5a8a`,全套走 CSS 变量整体换肤
- 主题默认浅色;设置提供 浅色/深色/跟随系统 三档,跟随系统需监听系统主题切换事件实时生效
- 硬规则:零渐变/零 glow/零毛玻璃卡片、全站禁 emoji、图标 Lucide stroke 1.5、卡片圆角 ≤8px、13px 正文基准、左对齐、等宽字体展示 slug/sha
- 桌面细节:全局 `cursor: default`、`user-select: none`(详情正文例外)、拦截默认右键菜单、`Cmd/Ctrl+K` 命令面板(cmdk)、搜索处理 IME composition 事件

## IPC 契约(见 docs/开发交接包-待澄清与任务分解.md 3.3)
- 所有 command 返回 `Result<T, AppError>`;`AppError { code, message(用户可读中文), detail? }`
- 错误码前缀:`AUTH_*` / `NET_*` / `REPO_*` / `FS_*` / `CONFLICT_*`
- 长任务通过 Tauri event 上报进度:`progress://{taskId}`

## 数据 Schema 要点(见交接包 3.4)
- `config.json` / `state.json` 顶部必带 `"schemaVersion": 1`;启动时按版本链式迁移,未知更高版本→只读模式+提示升级 app,绝不写回破坏
- `~/.agents/.skill-lock.json`(npx skills,schema v3)是**外部契约**:写入前探测 version 字段,非 3 则跳过双写并记日志,不得报错阻断主流程

## 测试要求
- core 模块单测覆盖:installer 降级链、SKILL.md 解析边界、state 迁移、同名预检三分支
- Gitea client 用 wiremock-rs 模拟;e2e 用 docker compose 起 gitea(见 fixtures/)
- Windows 相关(junction、路径、CRLF)必须在 Windows CI runner 上跑,不得只测 macOS

## 生产环境事实(已实测确认,勿再按文档旧假设推导)
- Gitea **1.25.3**;内建技能库坐标 **`skills/skills`**,默认分支 `main`
  ——设计文档里的 `ai-skills/team-skills` 只是示例,以此为准
- 技能库**公开可匿名读**:商店浏览与详情预览可以先于登录,登录只是分享与个性化的前提
- 普通员工对该库是**写权限 + main 受保护**:分享默认走「开分支 + 提交审核」(决策 C3 描述的正是这一档);
  直推仅在 main 未保护时可用;纯只读用户走不通开分支,须 fork 后提交审核(见 core/gitea.rs 权限矩阵)
- 真实仓库布局为 `skills/<名称>/SKILL.md`,8 个技能全部能被发现规则正确解析(冒烟测试已验证)
- CI 验收矩阵的 Trae **国际版 `trae` 与国内版 `trae-cn` 都要覆盖**(补充决策 C10),两者链接目标不同

## 编译期注入的常量(源码中不得出现真实值)
`SKILLSYNC_BUILTIN_GITEA_URL` / `SKILLSYNC_OAUTH_CLIENT_ID` / `SKILLSYNC_BUILTIN_REPO` / `SKILLSYNC_BUILTIN_BRANCH`

## 开发纪律
- 严格按交接包 3.5 的 M1 任务 1→13 顺序推进;每任务先写测试清单,再实现,DoD 全部满足才进下一任务
- 每完成一个任务 git commit,信息格式:`M1-任务N: 摘要`
- 决策记录 C1-C12 + C-UI + C-OAuth 已全部拍板(见交接包),直接执行不复议
- 文档未覆盖的决策:按决策记录精神自行选择,在 commit message 与代码注释中显式标注"假设:xxx";涉及删除用户数据、安全、对外网络请求的新增行为必须停下询问
- 保障 agent 范围(CI 验收矩阵):Claude Code / Cursor / Codex / Trae,其余注册表 agent 尽力支持
