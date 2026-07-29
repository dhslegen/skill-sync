# SkillSync — 企业内网 AI Skill 共享桌面客户端

给非研发同事一个"应用商店"式界面,从公司 Gitea 一键获取/分享/自动更新 AI agent skills,零 git 概念。

## 技术栈(锁定,勿擅自更换)
- Tauri 2.x + Rust (edition 2021, stable toolchain) / 前端 React 19 + TypeScript + Vite(假设:交接包草案写 React 18,但 create-tauri-app 与 shadcn/ui Base UI 底座当前默认 React 19,按 19 执行)
- 样式 Tailwind v4(`@theme` token,已接入);包管理 pnpm;Rust 侧 workspace: src-tauri/
- Rust 侧已接入:reqwest(rustls)、serde、keyring(按平台指定原生后端)、saphyr(YAML)、zip、sha2、getrandom、url
- **已选型但尚未引入**(到对应任务再装,勿以为已可用):状态管理 Zustand、
  UI 组件库 shadcn/ui(Base UI 底座)+ tweakcn 换肤、日志 tracing + 滚动文件

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
src/                 # React 前端(目前只有 i18n/ 与 styles/,页面随任务 8 起建)
src-tauri/src/
  core/builtin.rs    # ✅ 编译期注入的常量(地址/ClientID/仓库坐标)
  core/agents.rs     # ✅ agent 注册表加载与探测(数据在 resources/agents.json)
  core/skills.rs     # ✅ SKILL.md 解析 + 仓库发现规则 + SkillTree(MemTree/FsTree)
  core/gitea.rs      # ✅ Gitea API client(分支/压缩包/多文件提交/提交审核/fork)
  core/auth.rs       # ✅ OAuth PKCE 原语 + 回环回调 + 凭证存储抽象
  core/session.rs    # ✅ 登录态编排(登录/查状态/退出)
  core/installer.rs  # ✅ canonical 落盘 + 按目录建链/解链编排(不碰 state)
  core/fsops.rs      # ✅ 链接原语:降级链、自指防护、链接健康态、安全复制/删除
  core/state.rs      # ⬜ 任务 7:config/state 读写 + skill-lock 双写 + schema 迁移
  core/registry.rs   # ⬜ 仓库源管理(内建 Gitea + 自定义)
  core/github.rs     # ⬜ GitHub client(M3 前留空壳)
  commands.rs        # Tauri IPC command 定义(薄壳,逻辑在 core)
resources/agents.json   # 75-agent 注册表(移植自 vercel-labs/skills v1.5.20,MIT,保留出处注释)
scripts/             # 维护脚本(verify-*.mjs:跑上游源码生成 ground-truth fixture,供 Rust 差分测试)
fixtures/            # docker Gitea 测试环境 + 样例技能仓库
docs/                # ⚠️ 设计方案/交接包/UI 规范/UI-Demo **不进版本控制**(在 .git/info/exclude 中),
                     #    只有 terminology.md 是受版本控制的;换机器需另行拷贝这些文档
```

> `core/scheduler.rs`(定时更新检查)属 M2,尚未创建。

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
- 保障 agent 范围(CI 验收矩阵):Claude Code / Cursor / Codex / Trae(国际版 `trae` 与国内版 `trae-cn` 都要覆盖),
  其余注册表 agent 尽力支持

## 当前进度(2026-07-29)

M1 任务 1–6 已完成并提交(本地仓库,尚无远端)。测试 151 通过、clippy 干净。

| 任务 | 状态 | 关键产物 |
|---|---|---|
| 1 脚手架 | ✅ | Tauri2+React19+Tailwind v4、双平台 CI、i18n 骨架与禁 git 术语守卫 |
| 2 agents.json | ✅ | 75 条注册表 + 声明式探测 + 与上游的差分测试 |
| 3 SKILL.md 解析 | ✅ | frontmatter 校验 + 发现规则 + 18 布局差分测试 |
| 4 Gitea client | ✅ | REST 原语 + 14 wiremock + 实机全链路;fixture 环境可一键起 |
| 5 登录 | ✅ | OAuth PKCE + 回环回调 + 钥匙串;**登录界面留到任务 8 随外壳一起做** |
| 6 installer 链接层 | ✅ | fsops 降级链/自指防护/健康态 + installer 编排;40 单测,4 处注入验证 |
| 7 state 双写 | ⬜ | **下一个任务** |
| 8–13 | ⬜ | 商店页 / 获取流程 / 我的技能 / 分享 / 向导 / 打包 |

### 任务 6 确立的事实(后续任务直接用,勿重新推导)
1. **安装目录名取「仓库中的技能目录名」,不是 frontmatter 的 `name`**——对齐上游远端安装
   (`installer.ts` 用 `installName: entry.name`)。真实公司技能库现有 **20 个技能,全为 ASCII kebab-case**。
   `Installer::install(dir_slug, ...)` 的第一个参数就是它。
2. **纯中文名会被 `sanitize_name` 整体折成 `unnamed-skill`**,两个中文技能会装进同一目录互相覆盖。
   installer 对"信息全丢"的名字直接报 `FS_UNUSABLE_NAME` 拒绝,不擅自放宽 `sanitize_name`
   (它同时决定 `.skill-lock.json` 的键)。任务 11 收编本地技能时会正面撞上这条,届时定策略。
3. **Windows 建链用 `junction` crate**(2.0,MIT,免提权,delete 只摘 reparse point)。
   降级链:Windows `[Junction, Copy]`、POSIX `[Symlink, Copy]`——**Windows 不试 symlink**。
4. **整包 `cargo check --target x86_64-pc-windows-msvc` 在 macOS 上跑不通**(aws-lc-sys 需 Windows SDK 头文件),
   要验 Windows 分支只能把 fsops.rs 单独拷进一个 scratch crate 做定向 check。

### 任务 6 之前已知、依然成立的三件事
1. **建链解链以「目录」为单位,不是按 agent**:多个 agent 共用同一 `globalSkillsDir` 是常态
   (6 个共用 canonical、zencoder 与 zenflow 共用),按 agent 逐个解链会删掉别人还在用的目录
   ——直接违反"绝不静默删除用户文件"。`AgentRegistry::group_by_global_dir` 已备好,并有测试钉住该契约。
2. **universal agent 全局安装不建链**:`skillsDir == ".agents/skills"` 的 agent(含 cursor/codex)
   技能落在 canonical 即可见;只有 claude-code/trae 这类才需要链接。判定用 `global_install_needs_link()`。
3. **Windows 是主战场**:junction 为主路径,symlink 需开发者模式,失败要降级复制。
   C11 记录首台机器的 symlink 成功可能是管理员提权造成的假阳性,需以普通权限复测。

### 已知待处理
- **`Installer::install` 会无条件清空重建 canonical**(任务 7 必须补的守卫):用户改过技能本体时,
  重装/更新会静默抹掉改动,属铁律 7 管的破坏性操作,而 `on_occupied` 只管 agent 目录那一侧。
  任务 7 须在 state 里记 `contentHash`,不一致时按设计方案 2.5③ 弹三选一
  (保留本地 / 用远端覆盖 / 把本地改动分享上去),拿到结论再调 install。
  **在此之前不要把 install 接到自动更新路径上。**
- **任务 6 的 DoD 有一半尚未验证**:"Windows 普通用户权限下安装成功且 Claude Code 能读到 skill"
  在本机无从验证——没有 Windows 机器,仓库无远端故 CI 从未真正跑过。代码里已把
  "必须是 junction 而不是 symlink"写成断言(`fsops` 的建链测试),一旦 CI 跑起来,
  带提权的 runner 也会被这条断言挡下;但**普通权限下的真机验证仍欠一次**。
- **系统代理会拦截内网请求**:企业机器普遍配了 `http_proxy`,内网 Gitea 若不在 `NO_PROXY` 中,
  用户会在登录第一步遇到看不懂的失败。任务 13 需二选一:随包设免代理,或部署文档要求 IT 配置。
  细节见 `core/gitea.rs` 模块头。
- 本机 Rust 环境需走镜像:`RUSTUP_DIST_SERVER` 用清华、crates.io 用 rsproxy(已配在 `~/.cargo/config.toml`);
  `~/.cargo/bin` 不在非交互 shell 的 PATH 中,跑 cargo 前需 `export PATH="$HOME/.cargo/bin:$PATH"`。
