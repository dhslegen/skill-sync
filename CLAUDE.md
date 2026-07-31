# SkillSync — 企业内网 AI Skill 共享桌面客户端

给非研发同事一个"应用商店"式界面,从公司 Gitea 一键获取/分享/自动更新 AI agent skills,零 git 概念。

## 技术栈(锁定,勿擅自更换)
- Tauri 2.x + Rust (edition 2021, stable toolchain) / 前端 React 19 + TypeScript + Vite(假设:交接包草案写 React 18,但 create-tauri-app 与 shadcn/ui Base UI 底座当前默认 React 19,按 19 执行)
- 样式 Tailwind v4(`@theme` token,已接入);包管理 pnpm;Rust 侧 workspace: src-tauri/
- Rust 侧已接入:reqwest(rustls)、serde、keyring(按平台指定原生后端)、saphyr(YAML)、zip、sha2、getrandom、url
- 前端已接入(任务 8):Zustand、cmdk(命令面板)、lucide-react、react-markdown、clsx + tailwind-merge(`lib/cn.ts`)
- Rust 侧已接入(M2 任务 3):tokio(time/sync)、tracing + tracing-appender
  (滚动文件日志落 `~/.skillsync/logs/`,按天切割保留 7 份,init 失败不拦启动)
- **关于 shadcn/ui**(C-UI 拍板):任务 8 只引入了它的**基础设施**(`cn()` 工具 + CSS 变量换肤),
  组件目录没建。原因是 UI-Demo 已把 card/chip/24px 按钮的形态定死,用 shadcn 默认样式再逐个剥
  (删 `shadow-sm`、压 h-10→h-8、收 Card padding)比直接照 Demo 写更费事。
  **假设**:设置页表单与向导那类真正需要焦点管理/ARIA 的组件,到对应任务再 `npx shadcn add` 逐个加。
  交互组件的键盘与焦点行为目前是手写的,并有测试钉住(Esc/Tab/aria-*)。

## 架构铁律
1. 所有业务逻辑在 Rust core(src-tauri/src/core/),前端只做展示与交互;**前端不直接发任何 HTTP 请求**
2. 与 Gitea/GitHub 的一切交互走 REST/GraphQL API,**禁止引入 git2/libgit2/嵌入式 git**
3. 文件系统操作全部经过 core::fsops 模块,禁止散落各处直接 std::fs::symlink / remove_dir_all
   —— 「symlink→junction→copy」指的是本模块**具备的能力集合**,不是任一平台上的尝试顺序:
   实际降级链 Windows 是 `[Junction, Copy]`(不试 symlink),POSIX 是 `[Symlink, Copy]`
4. canonical 目录布局必须与 npx skills 兼容(`~/.agents/skills/` + `~/.agents/.skill-lock.json` 双写)
5. 内网 Gitea baseUrl 来自编译期环境变量 `SKILLSYNC_BUILTIN_GITEA_URL`,OAuth Client ID 来自 `SKILLSYNC_OAUTH_CLIENT_ID`;**源码中不得出现真实内网地址,不得出现任何 OAuth secret**(公共客户端 + PKCE,无 secret)
6. 用户可见文案全部走 i18n 资源文件(zh-CN 为主),禁用 git 术语(见 docs/terminology.md):commit→保存、push→分享、pull→获取、repository→技能库、branch/PR→提交审核
7. **绝不静默删除用户文件**;所有破坏性操作需前端确认结果作为参数传入

## 常用命令
```
pnpm dev            # tauri dev
pnpm build          # tauri build(无签名变量时产出未签名包,仅内部测试)
./scripts/build-release.sh   # 发布构建:强校验编译期内网配置,缺任一变量拒绝出包
pnpm test           # 前端 vitest
cargo test --workspace   # Rust 单测(在 src-tauri/ 下)
pnpm lint           # eslint
cargo clippy -- -D warnings
pnpm verify:agents     # 与上游 vercel-labs/skills 差分校验 agents.json 并重生成 fixture(需联网)
pnpm verify:discovery  # 同上,校验技能发现规则
pnpm verify:lock       # 同上,录制 .skill-lock.json(v3)的真实读写行为
```

## 目录结构
```
src/
  i18n/              # ✅ 文案资源 + t() 插值;测试里带术语与禁 emoji 的自动门
  styles/global.css  # ✅ 设计 token、dark: 变体绑定 data-theme、.md/.skill-tint 等少量非 utility 样式
  lib/               # ✅ ipc(唯一 invoke 通道 + core 返回类型)、format、search、tint、cn
  store/             # ✅ Zustand:appearance(主题/强调色)、store-index(商店)、install(获取流程)、
                     #    session(登录)、ui(页/面板/IME)、my-skills(我的技能列表/移除/修复/分享改动)、
                     #    share(分享候选/表单/占用三选)
  components/        # ✅ Sidebar/Toolbar/SearchBox/SkillCard/InstallButton/DetailPanel/
                     #    CommandPalette/Markdown/Icon/InstallPanel/ConflictDialog(三选:保留并分享为默认)/
                     #    RemoveDialog(移除双确认)/RepairDialog(占位替换确认)/ShareTakenDialog(占用三选)
  pages/StorePage.tsx    # ✅ 商店页
  pages/MySkillsPage.tsx # ✅ 我的技能页(行式列表 + 徽标 + 更新/修复/移除/分享改动)
  pages/SharePage.tsx    # ✅ 分享页(候选列表 + 来源标签 + 行内表单)
  pages/SettingsPage.tsx # ✅ 设置页(M2 任务 1:账号/外观;技能库/agent/更新分区随任务 2)
  store/prefs.ts         # ✅ 偏好落盘协调:config.ui 为准,localStorage 降为首帧缓存
  components/Wizard.tsx  # ✅ 首次启动向导(三步:认识工具/登录可跳过/精选一键装)
  hooks/             # ✅ useDesktopChrome(快捷键 + 右键拦截)
src-tauri/src/
  core/builtin.rs    # ✅ 编译期注入的常量(地址/ClientID/仓库坐标)
  core/agents.rs     # ✅ agent 注册表加载与探测(数据在 resources/agents.json)
  core/skills.rs     # ✅ SKILL.md 解析 + 仓库发现规则 + SkillTree(MemTree/FsTree)
  core/gitea.rs      # ✅ Gitea API client(分支/压缩包/多文件提交/提交审核/fork)
  core/auth.rs       # ✅ OAuth PKCE 原语 + 回环回调 + 凭证存储抽象
  core/session.rs    # ✅ 登录态编排(登录/查状态/退出)
  core/installer.rs  # ✅ canonical 落盘 + 按目录建链/解链编排(不碰 state)
  core/fsops.rs      # ✅ 链接原语:降级链、自指防护、链接健康态、安全复制/删除
  core/state.rs      # ✅ config.json/state.json + schema 版本闸门 + 原子写
  core/skill_lock.rs # ✅ npx skills 的 .skill-lock.json(v3)双写,外部契约
  core/store.rs      # ✅ 商店索引:压缩包→技能发现→可离线复用的缓存 + 前端 DTO
  core/acquire.rs    # ✅ 获取编排:下载→预检(contentHash 守卫)→落盘→建链→记账+双写;
                     #    repair_links;acquire_batch(向导批量:一次下载装多个,冲突一律跳过)
  core/remove.rs     # ✅ 移除编排:改过预检(NeedsDecision)→解链→删本体→清账+lock 移除
  core/share.rs      # ✅ 分享编排:排除法扫描→预检三分支→收编→按权限矩阵提交→shared 记账;
                     #    share_installed(把已装技能的改动推回来源)
  core/scheduler.rs  # ✅ 定时更新检查:run_check(head 比对→FromAccount 批量)+ 可测的调度循环
  core/registry.rs   # ⬜ 仓库源管理(内建 Gitea + 自定义)
  core/github.rs     # ⬜ GitHub client(M3 前留空壳)
  commands.rs        # Tauri IPC command 定义(薄壳,逻辑在 core)
resources/agents.json   # 75-agent 注册表(移植自 vercel-labs/skills v1.5.20,MIT,保留出处注释)
scripts/             # 维护脚本(verify-*.mjs:跑上游源码生成 ground-truth fixture,供 Rust 差分测试)
fixtures/            # docker Gitea 测试环境 + 样例技能仓库
docs/                # ⚠️ 设计方案/交接包/UI 规范/UI-Demo **不进版本控制**(在 .git/info/exclude 中),
                     #    只有 terminology.md 是受版本控制的;换机器需另行拷贝这些文档
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
- **写完测试必做注入验证**(本项目最有价值的一条实践):故意改坏实现,确认对应测试真的变红。
  M1 全程累计抓出十余处空转测试,几乎都属于下面四种写法——写测试时优先自查:
  1. **同一条规则查了两遍** → 其中一遍永远不触发,改坏也不红(store.rs 的 schemaVersion、
     fsops 的链接位置守卫、format.ts 里多余的 `Math.max(0, …)`)。发现即删掉多余那道。
  2. **断言只查"不存在"** → 区分不了"字段被省略"和"字段名拼错"
     (`assert!(json.get("new_branch").is_none())` 放过了 `newBranch`,见下面「关键事实」)。
     要么断言键的完整集合,要么正面断言值。
  3. **fixture 让两个不同概念取了同值** → 它们的差别就测没了
     (`name: weekly-report` + 目录名 `weekly-report`,让"安装目录名取目录名而非 name"失去保护)。
  4. **测试环境有隐性豁免,把被测行为整个短路** → 怎么写都是绿的
     (reqwest 对 loopback 目标默认豁免代理,拿 wiremock 当目标测代理策略必然空转;
     `tests/proxy_bypass.rs` 用 `.invalid` 保留域名 + 对照组绕开)。
  注入脚本自身的判定也会骗人:删 match 分支的注入被**编译器**拦下,只 grep "FAILED" 会误判
  "没抓到"——判定要分三态(测试红/编译拦下/真没抓到),编译拦下的换成可编译的坏实现重验。
- **注入脚本恢复现场必须用"先备份、后回拷",禁用 `git checkout <file>`**:
  工作区带着未提交的修复时,checkout 会连修复一起抹掉(任务 9 收尾时真实发生过一次,
  靠上下文里留存的完整代码才恢复回来)。
- Rust 侧也有术语守卫(`tests/terminology.rs`):把所有 `AppError::new` 的 message 抠出来,
  过与 src/i18n/index.test.ts 同一份禁词表,并要求 message 必须是中文——它是用户可见文案的
  第二条通道,前端守卫扫不到。
- 前端测试用 vitest + jsdom(`vitest.config.ts`,**注意它优先于 vite.config.ts**,后者里的
  `test` 字段读不到)。IME 组合输入、快捷键让路、不渲染不可信 HTML 这几条都有专门用例。

## 关键事实(已实测确认,勿按文档旧说法重新推导)

**技能库与权限**
- Gitea **1.25.3**;内建技能库坐标 **`skills/skills`**,默认分支 `main`
  ——设计文档里的 `ai-skills/team-skills` 只是示例,以此为准
- 技能库**公开可匿名读**:商店浏览与详情预览可以先于登录,登录只是分享与个性化的前提
- 普通员工对该库是**写权限 + main 受保护**:分享默认走「开分支 + 提交审核」(决策 C3 的正是这一档);
  直推仅在 main 未保护时可用;纯只读用户走不通开分支,须 fork 后提交审核(见 core/gitea.rs 权限矩阵)
- 真实布局 `skills/<slug>/SKILL.md`;**2026-07-30 实测为 20 个技能**(交接包写的 8 个是更早的快照),
  发现规则零跳过全部解析成功

**Gitea 请求体的字段名是 snake_case,不是驼峰**(任务 8 撞出的真实缺陷,已修)
- `ChangeFilesRequest` 原本带 `#[serde(rename_all = "camelCase")]`,`new_branch` 因此被发成
  `newBranch`。Gitea 对不认识的字段**静默忽略**,于是「先开分支再提交审核」会悄悄退化成
  **直推 main**——决策 C3 的主路径整个失效,而且不报任何错。
- 发给 Gitea 的请求体结构一律**不加 `rename_all`**。现有字段大多是单个单词、驼峰化后不变,
  所以这个坑只在有人加带下划线的字段时才炸,平时看不出来。
- 当时的单测写的是 `assert!(json.get("new_branch").is_none())`(针对 `new_branch: None` 的场景),
  这句话在字段被拼成 `newBranch` 时同样通过,拼错完全没被拦住。现已补上正面断言。


**压缩包里的权限位与二进制内容**(任务 9 实测,fixture 已录)
- Gitea 的 `archive/{branch}.zip` **只给可执行文件写 mode `0o755`,普通文件写 `0`**
  ——`0` 是"没记录"、不是 `0o644`。判定必须是"带 `0o111` 任一位才算可执行"。
  实测产物存在 `tests/fixtures/gitea-archive-modes.zip`(真实 push + archive 下载得到)。
- zip crate 的 `unix_mode()` 返回**完整 st_mode**(可执行文件是 `0o100755`),必须 `& 0o777` 掩掉类型位。
- `RepoArchive` 有两套内容:`tree`(仅文本,给技能发现扫描)与 `entries`(全部字节 + 权限位,给落盘)。
  **落盘必须走 entries**——文本树里没有二进制文件(带图片的技能会装成残缺品),也没有可执行位。
- 上游 `npx skills` 用 `chmod(dest, sourceStats.mode & 0o777)` 保留 mode(它 git clone 到临时目录,
  文件系统上就有);我们走压缩包,所以只能从 zip 里取。

**内部标识不能露给用户**(任务 9 连撞两次)
- core 里流转的一直是**目录名**(`weekly-report`)与 **agent name**(`claude-code`),
  到界面这一层必须换成展示名(「周报生成」、Claude Code)。
- 已撞过两处:安装结果文案"已启用到 claude-code、trae"、冲突弹窗标题「weekly-report」。
  两处都是视觉验证时才看出来的——单测断言的是"有没有这个词",没人断言"是不是人话"。

**命名与目录**
- 安装目录名取「**仓库中的技能目录名**」,不是 frontmatter 的 `name`——对齐上游远端安装
  (`installer.ts` 用 `installName: entry.name`)。真实公司技能库现有 **20 个技能,全为 ASCII kebab-case**。
  `Installer::install(dir_slug, ...)` 的第一个参数就是它。
- 纯中文名会被 `sanitize_name` 整体折成 `unnamed-skill`,两个中文技能会装进同一目录互相覆盖。
  installer 对"信息全丢"的名字报 `FS_UNUSABLE_NAME` 拒绝,**不放宽 `sanitize_name`**
  (它同时决定 `.skill-lock.json` 的键)。**中文名技能的分享策略已定**(任务 11,见 share.rs
  模块头):分享时表单强制起 ASCII kebab 的远端目录名,frontmatter `name` 保持中文显示名;
  本地目录一律不改名。

**建链与解链**
- **以「目录」为单位,不是按 agent**:多个 agent 共用同一 `globalSkillsDir` 是常态
  (6 个共用 canonical、zencoder 与 zenflow 共用),按 agent 逐个解链会删掉别人还在用的目录。
  用 `AgentRegistry::group_by_global_dir`,有测试钉住该契约。
- **universal agent 全局安装不建链**:`skillsDir == ".agents/skills"` 的(含 cursor/codex)
  落在 canonical 即可见;只有 claude-code/trae 这类才需要。判定用 `global_install_needs_link()`。
- **canonical 永不作为建链目标**。真实可达场景:`CLAUDE_CONFIG_DIR` 指到 `~/.agents` 时
  claude-code 的目录恰好等于 canonical,若当成目标,解链就等于删技能本体。
- Windows 用 `junction` crate(2.0,MIT,免提权,delete 只摘 reparse point)。

**外部契约 `.skill-lock.json`(npx skills,v3)**
- **落点有两个**:`XDG_STATE_HOME` 设了就是 `$XDG_STATE_HOME/skills/.skill-lock.json`,否则才是
  `~/.agents/.skill-lock.json`。设计文档只写了后者,漏掉会双写到一个 npx skills 根本不看的位置。
- **上游对不认识的版本会破坏用户数据**(已录进 fixture):v2 → 整份抹掉重建(他人条目、
  `dismissed`、`lastSelectedAgents` 全没);v4 → 照写不误。本 app 一律**跳过、一个字节不动**。
- `skillFolderHash` 对非 GitHub 源填**空串**(上游对 well-known 源就这么填,`add.ts:916`)。
- `serde_json` 必须开 `preserve_order`,否则双写会把用户 lock 的键重排成字母序。
- 已实证:临时 HOME 下跑真实 `npx skills@1.5.20 list -g --json`,能看到技能、Claude Code 关联,
  以及我们写进 lock 的 source/sourceUrl/sourceType。

**数据模型偏离设计文档处**
- `state.json` 的 `links` 按**目录**记(`[{dir, mode}]`),不是设计方案 2.4 的单个 `linkMode`
  ——同一次安装的不同目录可能落在不同档,且卸载降级复制的副本必须凭这份记账才敢动。

**Windows 验证的边界**
- 整包 `cargo check --target x86_64-pc-windows-msvc` 在 macOS 上**跑不通**(aws-lc-sys 需 Windows SDK
  头文件);要验 Windows 分支,把 fsops.rs 单独拷进一个 scratch crate 做定向 check。
- CI 已在 Windows runner 上真实跑通 junction 建链/摘链,且断言"必须是 junction 而不是 symlink"
  ——带提权的 runner 也会被挡下(C11 的提权假阳性有护栏了)。但 runner ≠ 普通员工受限机器。


## 编译期注入的常量(源码中不得出现真实值)
`SKILLSYNC_BUILTIN_GITEA_URL` / `SKILLSYNC_OAUTH_CLIENT_ID` / `SKILLSYNC_BUILTIN_REPO` / `SKILLSYNC_BUILTIN_BRANCH`

## 开发纪律
- M1 按交接包 3.5 的任务 1→13 顺序推进,**已全部完成**;M2 开工前先按同粒度做任务分解
  (范围见设计方案 2.7),之后同样逐任务:先写测试清单,再实现,DoD 全满足才进下一任务
- 每完成一个任务 git commit,信息格式:`M2-任务N: 摘要`(M1 历史为 `M1-任务N: 摘要`)
- 决策记录 C1-C12 + C-UI + C-OAuth 已全部拍板(见交接包),直接执行不复议
- 文档未覆盖的决策:按决策记录精神自行选择,在 commit message 与代码注释中显式标注"假设:xxx";涉及删除用户数据、安全、对外网络请求的新增行为必须停下询问
- 保障 agent 范围(CI 验收矩阵):Claude Code / Cursor / Codex / Trae(国际版 `trae` 与国内版 `trae-cn` 都要覆盖),
  其余注册表 agent 尽力支持

## 当前进度(2026-07-31,M1 收官)

**M1 任务 1–13 全部完成并提交**。远端 `origin` = github.com/dhslegen/skill-sync(**私有**)。
本机测试 **Rust 286 通过 + 前端 213 通过**、clippy 与 eslint 干净;双平台 CI 已真实跑通
(Windows 上少跑的 8 个是 `cfg(unix)` 用例,已逐一核对)。本机 `pnpm tauri build`
真实出过包(dmg 6.0MB)。**M2 进行中**(分解见 docs/M2-任务分解.md,本地文档,6 任务;
用户已拍板:①按此分解执行;②关窗缩到托盘,「退出」只在托盘菜单)。
交接材料见 docs/新会话交接提示词.md。

| M2 任务 | 状态 | 关键产物 |
|---|---|---|
| 1 设置页 A | ✅ | config 新增可选 ui 字段(serde default,schemaVersion 仍 1)+ store/prefs.ts 同步(config 赢/一次性迁移/失败不硬推)+ 设置页账号区(退出登录接通)与外观区;6+11 新测试,7 处注入验证 |
| 2 设置页 B | ✅ | AI 工具开关(config.disabledAgents,只影响默认勾选)+ 更新三档(手动/4h/每天,「手动」保留频率)+ open_library_url(同源白名单)接通评审链接;9+16 新测试,5 处注入验证 |
| 3 scheduler | ✅ | run_check(head 未变不下载)+ `BatchAgents::FromAccount`(更新用账上 agents,自动流程不改写关联)+ 注入闭包的调度循环(paused clock 测频率/重排/关断)+ tracing 滚动日志;9+4 新测试,5 处注入验证 |
| 4 托盘+通知 | ⬜ | 关窗缩托盘(已拍板)+ 更新结果通知 |
| 5 App 自更新 | ⬜ | tauri-plugin-updater + minisign(未签名先打通) |
| 6 收尾打磨 | ⬜ | 占位替换重试 + Windows 外观(可选) |

| 任务 | 状态 | 关键产物 |
|---|---|---|
| 1 脚手架 | ✅ | Tauri2+React19+Tailwind v4、双平台 CI、i18n 骨架与禁 git 术语守卫 |
| 2 agents.json | ✅ | 75 条注册表 + 声明式探测 + 与上游的差分测试 |
| 3 SKILL.md 解析 | ✅ | frontmatter 校验 + 发现规则 + 18 布局差分测试 |
| 4 Gitea client | ✅ | REST 原语 + 14 wiremock + 实机全链路;fixture 环境可一键起 |
| 5 登录 | ✅ | OAuth PKCE + 回环回调 + 钥匙串;**登录界面留到任务 8 随外壳一起做** |
| 6 installer 链接层 | ✅ | fsops 降级链/自指防护/健康态 + installer 编排;40 单测,4 处注入验证 |
| 7 state 双写 | ✅ | state/config schema 闸门 + 原子写;lock 双写对上游做**字节级**差分;`npx skills list` 实测可见 |
| 8 商店页 | ✅ | core/store.rs 索引缓存(离线可浏览)+ 外壳/商店页/详情面板/命令面板;9+12 处注入验证 |
| 9 获取流程 | ✅ | core/acquire.rs 编排 + contentHash 守卫接上;agent 多选/进度/结果/冲突弹窗;16+10 处注入验证 |
| 10 我的技能 | ✅ | core/remove.rs + repair_links + link_health;行式列表/徽标/更新/修复/移除双确认;8+15 处注入验证 |
| 11 分享 | ✅ | core/share.rs 全链路 + live e2e(三分支/竞态/只读 fork 对真 Gitea);冲突弹窗三选(保留并分享为默认);8+9 处注入验证 |
| 12 向导 | ✅ | curated.json 进索引 + acquire_batch(一次下载/冲突跳过);三步向导每步都可走通;7+5 处注入验证 |
| 13 打包 | ✅ | bundle 配置守卫测试 + 免代理直连 + build-release.sh/release.yml + 部署分发指南;真机验收清单待外部条件 |

### 任务 13 交付说明(需外部条件才能闭环的部分)
- **能自动化的已全部落地**:bundle 配置(NSIS 免管理员 currentUser、CSP 收紧、双平台 targets、
  版本号一致性)有守卫测试钉住(`tests/bundle_config.rs`);`scripts/build-release.sh` 与
  `release.yml` 在缺内网配置时拒绝出包;本机 `pnpm tauri build` 真实出过 dmg。
- **待外部条件**(清单同部署指南 §6):Apple Developer ID 证书 + 公证凭证;Windows 内部 CA
  签名或 IT 软件中心白名单;干净双平台真机的 ≤5 分钟验收(含 Windows 普通权限 junction 实测,
  这同时补上任务 6 欠的那一档)。
- 部署文档:`docs/部署分发指南.md`(**受版本控制**,与 terminology.md 同为 docs/ 白名单)。

### 已知待处理
- **`Installer::install` 依然会无条件清空重建 canonical**——守卫在 `core/acquire.rs`,不在它自己身上。
  任何**新的**调用方(自动更新 scheduler、向导批量安装)都必须走 `acquire::acquire`,
  或自行先跑 `acquire::precheck` 拿到用户结论。直接调 `install()` 就是在静默抹用户改动。
- **「把本地改动分享上去」已接通**(任务 11):冲突弹窗三选,「保留并分享」为默认
  (用户拍板)。core 的 `Resolution` 仍只有两档——"分享"是前端编排:先 `run("keepLocal")`
  落稳,成功后再调 `skill_share_changes`;分享失败不影响"保留成功"的结果呈现。
  回推走了评审(分支保护/只读)时 **installed 记账一个字不动**:改动没进 main,
  清了 contentHash 等于把「已改动」标记藏起来。
- **分享页的「新建技能」向导没做**(Demo 里有):交接包任务 11 范围不含它,
  不摆点了没反应的按钮;等价 `skills init` 的脚手架随任务 12 向导一起考虑。
- ~~评审链接只展示不可点~~:已随 M2 任务 2 接通(`open_library_url`,白名单只放行与
  内建 Gitea **同源**的地址;`gitea::is_same_origin` 拒绝 javascript:/file: 等 scheme)。
- **frontmatter 补齐会重建头部**:只在 SKILL.md 不合规时发生,重写后只保证
  name/description 与正文;坏头部里残存的其他字段(license 等)不保证保留(见 share.rs 模块头)。
- **agent 目录占位:事后可修,安装当下仍只报不处理**。任务 10 给了「我的技能」页的
  修复通道(`acquire::repair_links` + 替换确认弹窗):断链/丢失/被改指直接重建,
  实体目录占位需确认后替换。但**安装那一刻**的占位失败仍是 `OnOccupied::Fail` 只报不重试,
  且修复按账上的 agents 全量重链——安装时就失败的 agent 不在账上,修复够不到它,
  用户得回详情面板重装。给安装结果面板的失败项做逐条「替换」重试属后续任务
  (动 `AcquireRequest`/InstallPanel 的范围)。
- **批量安装已接**(任务 12):`acquire::acquire_batch` 一次下载装多个,冲突(改过/外来)
  一律跳过并说明,不弹三选——向导面向全新环境,静默覆盖比装不上危险得多。
  安装时的占位失败逐条「替换」重试仍未做(见上一条)。
- **偏好与向导标记已落 config.json**(M2 任务 1):config 的可选 `ui` 字段
  (theme/accent/wizardDone,serde default 兼容,schemaVersion 仍 1)。同步方向唯一:
  **config 有值则 config 赢**;localStorage(`skillsync.theme`/`accent`/`wizardDone`)降为
  首帧防闪与 IPC 不可用时的兜底缓存。入口 `store/prefs.ts`:未同步成功绝不反推 config
  (不拿猜的值覆盖真数据);向导 maybeOpen 现在会先发一次 `ui_prefs_get`。
- **curated.json 约定**(fixture 即此约定):技能库根目录,`{"curated": ["<frontmatter name>", …]}`,
  按显示名记;对不上的条目在 view 层直接丢弃。真实公司库(2026-07-30 快照)还没有这个文件,
  向导第三步会引导去商店——需要技能库管理员补一份才有"一键全装"。
- **任务 6 的 DoD 还差"普通权限真机"这一档**(CI 已覆盖的部分见下):
  - ✅ 已验:Windows runner 上 `junction::create` / `remove_dir` 摘链 / `junction::get_target`
    真实执行通过,且建链测试断言"**必须是 junction 而不是 symlink**"——runner 即便有足够权限
    创建 symlink 也会被这条挡下,C11 的提权假阳性从此有自动护栏。
  - ❌ 未验:GitHub runner 权限宽松,**不等于**普通员工的受限机器;
    "不开开发者模式、普通用户权限下安装成功且 Claude Code 能读到 skill"仍欠一次真机验证。
  - ❌ 未验:8 个 `cfg(unix)` 测试在 Windows 上不跑(自指防护、坏软链跳过、软链子目录解引用、
    被改指链接的卸载)。它们要构造场景就得先有 symlink 权限,而那正是 Windows 上假定没有的东西。
    若要在 Windows 上覆盖这几条,需另想构造方式(如用 junction 代替 symlink 搭场景)。
- **系统代理已拍板:一律直连**(任务 13):`gitea::app_http_client` 对全部请求 `.no_proxy()`
  ——M1 只有内建源且必在内网,直连即正确语义。极端的全代理网络需 IT 放行,见部署指南 §4。
  M3 自定义外网源时再按 registry 决定代理策略。
  测试注意:reqwest 对 loopback 目标**默认豁免代理**,拿 wiremock 当目标测代理行为
  必然空转;`tests/proxy_bypass.rs` 用 `.invalid` 保留域名 + 对照组的写法绕开了这一点。
- **商店卡片上没有作者、也没有安装量**(任务 8 的假设,见 `core/store.rs` 模块头):
  frontmatter 只有 name/description/metadata.internal,而逐技能的提交人归因要对每个目录各发
  一次 commits 请求,50 个技能撑不住首屏 <2s。UI-Demo 里那两栏因此留空——**不编造**。
  安装量本就是 C5 预留字段,等 M4 埋点服务。若以后要作者,需先给 gitea.rs 加 commits API
  并想清楚 50 次请求怎么摊。
- **UI-Demo 的分类 chip(文档/代码/数据/办公)换成了"全部/未安装/已安装"**(任务 8 的假设):
  SKILL.md 里没有分类字段,硬造分类等于在界面上撒谎。形态与密度保持 Demo 原样。
  若以后要分类,需要技能库侧先约定 frontmatter 字段或 `curated.json`。
- **任务 8 的性能数字来自 loopback docker fixture,不是内网真机**:
  53 个技能实测冷启动 76.6ms、缓存命中 28.1ms(`cargo test --test store_live -- --nocapture`),
  远低于 DoD 的 2s / 300ms。但那是本机 docker,真实内网要加网络往返与更大的压缩包。
  `tests/store_index.rs` 里的 300ms 断言跑在 wiremock 上、进 CI;`tests/store_live.rs` 需要
  `./fixtures/init.sh`,环境不在时自动跳过(会往 fixture 建 `store-perf-50` 分支,幂等复用)。
- **Windows 平台外观细节未做**:任务 13 只启用了 macOS 的 Overlay 标题栏(红绿灯浮在
  44px 拖拽区);Windows 保持系统默认装饰,原生窗口控制(tauri-plugin-decorum)、
  vibrancy、实色化属 M2 打磨项,不影响 DoD。
- **进度事件只报阶段,不报字节**:压缩包是一次性下完的,没有可信的字节级进度可报。
  阶段(取内容/检查/写入/关联/记账)是当前最诚实的粒度。
- ~~退出登录还没有界面入口~~:已随 M2 任务 1 的设置页账号区落地。
- 本机 Rust 环境需走镜像:`RUSTUP_DIST_SERVER` 用清华、crates.io 用 rsproxy(已配在 `~/.cargo/config.toml`);
  `~/.cargo/bin` 不在非交互 shell 的 PATH 中,跑 cargo 前需 `export PATH="$HOME/.cargo/bin:$PATH"`。
