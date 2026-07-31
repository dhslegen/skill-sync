# SkillSync — 企业内网 AI Skill 共享桌面客户端

给非研发同事一个"应用商店"式界面,从公司 Gitea 一键获取/分享/自动更新 AI agent skills,零 git 概念。

## 技术栈(锁定,勿擅自更换)
- Tauri 2.x + Rust (edition 2021, stable toolchain) / 前端 React 19 + TypeScript + Vite(假设:交接包草案写 React 18,但 create-tauri-app 与 shadcn/ui Base UI 底座当前默认 React 19,按 19 执行)
- 样式 Tailwind v4(`@theme` token,已接入);包管理 pnpm;Rust 侧 workspace: src-tauri/
- Rust 侧已接入:reqwest(rustls)、serde、keyring(按平台指定原生后端)、saphyr(YAML)、zip、sha2、getrandom、url
- 前端已接入(任务 8):Zustand、cmdk(命令面板)、lucide-react、react-markdown、clsx + tailwind-merge(`lib/cn.ts`)
- Rust 侧已接入(M2 任务 3-4):tokio(time/sync)、tracing + tracing-appender
  (滚动文件日志落 `~/.skillsync/logs/`,按天切割保留 7 份,init 失败不拦启动;
  已实测落盘)、tauri `tray-icon` feature、tauri-plugin-notification
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
pnpm build:web      # tsc + vite build —— **提交前必跑**,见下
cargo clippy -- -D warnings
pnpm verify:agents     # 与上游 vercel-labs/skills 差分校验 agents.json 并重生成 fixture(需联网)
pnpm verify:discovery  # 同上,校验技能发现规则
pnpm verify:lock       # 同上,录制 .skill-lock.json(v3)的真实读写行为
```

**提交前的四道闸**:`pnpm test` + `pnpm lint` + **`pnpm build:web`** + `cargo test --workspace`
+ `cargo clippy -- -D warnings`。`build:web` 那道最容易漏——vitest **不做类型检查**,
eslint 也不管,只有 `tsc` 会拦。M2 任务 6 就因为只跑了 test+lint,把一处 `.at(-1)`
(超出 tsconfig 的 ES2020 lib)提交进去,双平台 CI 一起红。

## 目录结构

下列模块均已实现(M3 起两个前空壳模块也已落地)。

```
src/
  i18n/          文案资源 + t() 插值;测试里带术语与禁 emoji 的自动门
  styles/        设计 token、dark: 变体绑定 data-theme、少量非 utility 样式
  lib/           ipc(唯一 invoke 通道 + core 返回类型)、format、search、tint、cn
  store/         Zustand:appearance/store-index/install/session/ui/my-skills/share/
                 wizard/settings(agent 开关+更新档位+App 自更新)/prefs(偏好落盘协调)
  components/    Sidebar/Toolbar/SearchBox/SkillCard/InstallButton/DetailPanel/CommandPalette/
                 Markdown/Icon/SkillIcon/InstallPanel/Wizard + 五个弹窗:
                 ConflictDialog(三选)/RemoveDialog(双确认)/RepairDialog(占位替换)/
                 ShareTakenDialog(占用三选)/RetryLinkDialog(重试时的占位替换)
  pages/         StorePage / MySkillsPage / SharePage / SettingsPage
  hooks/         useDesktopChrome(快捷键 + 右键拦截)
src-tauri/src/
  core/builtin.rs    编译期注入的常量(内网地址/ClientID/仓库坐标/更新源+公钥)
  core/agents.rs     agent 注册表加载与探测 + disabled 标记(数据在 resources/agents.json)
  core/skills.rs     SKILL.md 解析 + 仓库发现规则 + SkillTree(MemTree/FsTree)
  core/gitea.rs      Gitea API client(分支/压缩包/多文件提交/提交审核/fork)+ is_same_origin
  core/auth.rs       OAuth PKCE 原语 + 回环回调 + 凭证存储抽象(按 registryId 存)
  core/session.rs    登录态编排(登录/查状态/退出)
  core/installer.rs  canonical 落盘 + 按目录建链/解链编排(不碰 state)
  core/fsops.rs      链接原语:降级链、自指防护、链接健康态、安全复制/删除
  core/state.rs      config.json/state.json + schema 版本闸门 + 原子写 + ui/disabledAgents
  core/skill_lock.rs npx skills 的 .skill-lock.json(v3)双写,外部契约
  core/store.rs      商店索引:压缩包→技能发现→可离线复用的缓存 + 前端 DTO
  core/acquire.rs    获取编排:下载→预检(contentHash 守卫)→落盘→建链→记账+双写;
                     repair_links / link_agents / acquire_batch(Uniform|FromAccount)
  core/remove.rs     移除编排:改过预检(NeedsDecision)→解链→删本体→清账+lock 移除
  core/share.rs      分享编排:排除法扫描→预检三分支→收编→按权限矩阵提交→shared 记账;
                     share_installed(把已装技能的改动推回来源)
  core/scheduler.rs  定时更新检查:run_check(head 比对→FromAccount 批量)+ 可测的调度循环
                     + notification_copy(通知判定与文案)
  core/registry.rs   多源解析层:BuiltinSource(编译期常量经参数传入)+ resolve/list/
                     add/remove/url_allowed/auth_config;内建源锁定不落 config
  core/github.rs     GitHub client:读链路(branches/zipball,RepoSource trait)+
                     device flow 原语 + current_user;分享写路径归 M3-5b(待外部条件)
  commands.rs        Tauri IPC command 定义(薄壳,逻辑在 core)+ 托盘/updater 接线在 lib.rs
resources/agents.json  75-agent 注册表(移植自 vercel-labs/skills v1.5.20,MIT,保留出处注释)
scripts/           维护脚本(verify-*.mjs 跑上游源码生成 ground-truth fixture;build-release.sh)
fixtures/          docker Gitea 测试环境 + 样例技能仓库
docs/              ⚠️ 设计方案/交接包/UI 规范/UI-Demo/任务分解/交接提示词 **不进版本控制**
                   (在 .git/info/exclude 中);只有 terminology.md 与 部署分发指南.md 受版本控制
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
- **动 `tauri::Builder` 的插件/setup/窗口配置后,必做一次 `pnpm dev` 启动冒烟**
  (M2 任务 6 的教训):cargo test 与 vitest **都不启动 Tauri runtime**,插件初始化、
  托盘构建、窗口事件这些路径一行都没覆盖。任务 5 加 updater 插件时 Rust 309 +
  前端 250 全绿、clippy 干净,但应用直接 panic 起不来——插件 setup 要反序列化
  `tauri.conf.json` 的 `plugins.<name>` 节,缺该节即 `PluginInitialization` 失败。
  冒烟方式:后台 `pnpm dev` → 等 `target/debug/skillsync` 进程存活 → 看
  `~/.skillsync/logs/`。同时把这类配置的存在性用 `tests/bundle_config.rs` 钉住。
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
App 自更新(M2 任务 5)另有 `SKILLSYNC_UPDATE_URL`(latest.json 地址)/ `SKILLSYNC_UPDATE_PUBKEY`
(minisign 公钥),签名私钥走 `TAURI_SIGNING_PRIVATE_KEY`(只在构建机上,绝不进仓库)。
M3 另有**可选**的 `SKILLSYNC_GITHUB_CLIENT_ID`(GitHub OAuth App,device flow,无 secret):
未注入不拦构建,GitHub 源仍可匿名浏览获取,仅「一键登录」报"未配置"。

## 开发纪律
- M1(交接包 3.5,任务 1→13)与 M2(docs/M2-任务分解.md,任务 1→6)**均已全部完成**;
  M3 开工前先按同粒度做任务分解(范围见设计方案 2.7),之后同样逐任务:
  先写测试清单,再实现,DoD 全满足才进下一任务
- 每完成一个任务 git commit,信息格式:`M3-任务N: 摘要`(历史为 `M1-`/`M2-`)
- 决策记录 C1-C12 + C-UI + C-OAuth 已全部拍板(见交接包),直接执行不复议
- 文档未覆盖的决策:按决策记录精神自行选择,在 commit message 与代码注释中显式标注"假设:xxx";涉及删除用户数据、安全、对外网络请求的新增行为必须停下询问
- 保障 agent 范围(CI 验收矩阵):Claude Code / Cursor / Codex / Trae(国际版 `trae` 与国内版 `trae-cn` 都要覆盖),
  其余注册表 agent 尽力支持

## 当前进度(2026-07-31,M3 主体完成)

**M1 任务 1–13、M2 任务 1–6、M3 任务 1–4 + 5a + 6 全部完成并提交**(分解与拍板记录
在 docs/M3-任务分解.md,本地文档),逐任务的产物与假设见 `git log`。远端 `origin` =
github.com/dhslegen/skill-sync(**私有**)。

- 本机:Rust 345 + 前端 272 测试通过,clippy/eslint/tsc 干净,`pnpm dev` 启动冒烟通过
- **双平台 CI 在 M3 任务 1–5a(`2006213`…`5259ea2`)连续五次全绿**;任务 6(`de7b233`)
  的 CI **因 GitHub 账号计费限额未运行**(job 4 秒被拒,非代码问题)——处理账单后
  `gh run rerun` 补验
- **真实 GitHub e2e 已跑通**(任务 4:`SKILLSYNC_GITHUB_LIVE=1 cargo test --test
  github_live`,对 dhslegen/skills 走完 索引→发现→安装→lock 双写)
- **M3 剩余 = 任务 5b**(GitHub 分享写路径):DoD 要求提交端点先对真实 GitHub 录行为
  再定,录制需要可写测试仓凭证(见待处理);其余 M3 范围已交付

> ⚠️ **"CI 绿"这句话曾经假了很久**:macOS job 一直绿,**Windows job 从 M1 任务 10 起
> 连红六个提交**没被发现——M1 交接材料里"双平台 CI 已真实跑通"在任务 9 之后就不成立,
> 而 M2 全程照抄了它。根因在测试侧:`remove_flow.rs` 用 `remove_file` 删关联,而 Windows
> 上关联是 **junction**(目录重解析点),直接 `Access is denied`。已修。
> **教训:写任何"CI 绿"的结论前先 `gh run list` 看一眼,别把上一份文档的结论当事实抄下去。**

M2 新增的 IPC:`ui_prefs_get/set`、`auto_update_get/set`、`agents_set_disabled`、
`open_library_url`、`update_check_now`、`app_update_check/install`、`app_restart`、
`skill_link_agents`;新增事件:`scheduler://report`、`app-update://available`。
M3 新增的 IPC:`registry_list/add/remove`、`auth_device_start/wait`、`skill_claim`;
既有读写类 command 全部接受 `registryId`(缺省内建);编译期新常量
`SKILLSYNC_GITHUB_CLIENT_ID`(未注入仅登录不可用,浏览获取照常)。

### 现役机制约束(动相关代码前必读)

这些**都已实现**,列在这里是因为它们的不变量不看就会破坏。已完成的过程叙事在 git log。

- **多源解析只有一个入口**(M3 任务 1):commands 一律经 `registry::resolve`
  (`BuiltinSource` 把编译期常量当参数传——测试构建不注入常量,直读会让测试只能测
  "未配置"分支)。内建源锁定且**不落 config.registries**(坐标是编译期常量,落盘会造出
  第二份真相);自定义源 id 生成 `custom-N` 取 max+1 **绝不复用**(缓存与凭证按 id 落)。
- **读链路对来源类型无感**(M3 任务 4):store/acquire/scheduler 只吃 `gitea::RepoSource`
  trait(branch_head + download_archive),分发在 `commands::read_source` 的 SourceClient
  枚举。**写链路(分享)刻意不进 trait**——两家提交/评审 API 形状完全不同。
  `require_gitea` 如今只守登录与分享两条通道。
- **GitHub zipball 前缀是 `{owner}-{repo}-{短sha}/`**(2026-07-31 实测,曾猜错为
  `<repo>-<ref>`);mode 语义与 Gitea 相同(可执行 0o755、其余 0=没记录)。
  fixture: `tests/fixtures/github-zipball-modes.zip`(真实录制裁剪,裁剪脚本必须保留
  原始 external_attr——python zipfile.writestr 会把 0 擅自补成 0o600)。
- **代理两档**(M3 任务 3,推翻 M1"一律直连"):内建源 `app_http_client()` 直连;
  外部源 `app_http_client_proxied()` 跟随系统代理;选择集中在 `commands::http_client_for`。
  不加每源开关(用户拍板)。
- **凭证按源分流**:内建 = OAuth PKCE;自定义 Gitea = PAT(`auth_config` 给空 client_id,
  PAT 凭证 expires_at=0 永不触发续期端点;**内建 Client ID 绝不发给别家 Gitea**);
  GitHub = device flow 主通道 + PAT 备用(`session.rs` 的 github 平行区段,不与 Gitea
  函数硬参数化合并)。内建源的读**永远匿名**(公开可读,带过期令牌反而 401)。
- **scheduler 逐源且常驻**(M3 任务 2):`run_all_sources_check` 一个源失败不拦其他源,
  全失败则本轮**不上报**(报 NothingInstalled 等于撒谎);合并在 `scheduler::merge_reports`。
- **删自定义源**:已装技能保留(界面标"来源已移除",更新/回推按钮消失),该源凭证与
  索引缓存一并清掉;`registry_id` 解析失败即 `sourceRemoved`,认领绑不上源的技能同理。
- **认领(M3 任务 6)读 lock 不写**:content_hash 以认领此刻为基线、commit_sha 留空
  (第一次更新即对齐,覆盖前照走预检);npx 建的**链接收编入账**(只认确实指向 canonical
  的链接,实体目录与用户目录无从区分不敢认),否则移除时留一地断链;来源绑定按
  sourceUrl **同源比对**(只看 kind 会把别家 GHE 错绑上,有测试钉住)。

- **`Installer::install` 无条件清空重建 canonical**——守卫在 `core/acquire.rs`,不在它自己身上。
  任何**新的**调用方都必须走 `acquire::acquire`/`acquire_batch`,或自行先跑
  `acquire::precheck` 拿到用户结论。直接调 `install()` 就是在静默抹用户改动。
- **建链/解链两条通道分工**:`repair_links` 按**账上**的 agents 整体重来(修断链/丢失/被改指);
  `link_agents` 补"安装那一刻就没建成、因而根本没进账"的 agent——repair 够不到它们。
  后者记账是**并集合并**不是覆盖(整份覆盖会把其余工具从账上抹掉,卸载时漏解链接)。
  前端先按不替换试一次,只有真撞上 `FS_LINK_OCCUPIED` 才升级成确认弹窗(默认焦点在取消)。
- **`acquire_batch` 的冲突语义**:改过/外来/已最新一律跳过并给人话原因,不弹三选。
  scheduler 的冲突保护直接复用它,**不要另写一套判定**。两档链接目标:
  `Uniform`(向导,统一列表)/ `FromAccount`(定时更新,各技能用账上 agents,自动流程绝不改写关联)。
- **保留本地改动时,关于内容的记账一个字不动**:`commitSha` 与 `contentHash` 保持旧值,
  它们不符正是"有可用更新 / 有未分享的改动"两个标记的判据。回推走了评审(分支保护/只读)时同理
  ——改动没进 main,清了 contentHash 等于把「已改动」标记藏起来。
  「保留并分享」是前端编排(先 `run("keepLocal")` 落稳再 `skill_share_changes`),core 的
  `Resolution` 仍只有两档。
- **偏好落 `config.json` 的 `ui` 字段**(theme/accent/wizardDone,serde default 兼容,
  schemaVersion 仍 1)。同步方向唯一:**config 有值则 config 赢**;localStorage 降为首帧防闪
  与 IPC 不可用时的兜底。入口 `store/prefs.ts`:**未同步成功绝不反推 config**(不拿猜的值
  覆盖真数据)。agent 开关记在 `disabledAgents`(禁用名单而非启用白名单——注册表会新增 agent)。
- **系统代理:一律直连**(任务 13):`gitea::app_http_client` 对全部请求 `.no_proxy()`
  ——M1 只有内建源且必在内网,直连即正确语义。**M3 接外网源时必须按 registry 重新决定**。
  测试坑:reqwest 对 loopback 目标**默认豁免代理**,拿 wiremock 当目标测代理行为必然空转;
  `tests/proxy_bypass.rs` 用 `.invalid` 域名 + 对照组绕开。
- **`open_library_url` 只放行与内建 Gitea 同源的地址**(scheme+host+port 全等),
  `javascript:`/`file:` 一律拒绝——那是从 webview 通往系统的通道。多源之后要按 registry 放行,
  但别放宽成"任意 URL"。
- **托盘与退出**:关窗 = 缩到托盘(用户拍板),「退出」只在托盘菜单。
  **`ExitRequested{code: None}` 的防退出不挡 Cmd+Q**——macOS 的退出走 `app.exit`(code=Some),
  这条特意实测过,别照 tauri 文档"code 是 None 就是用户交互"的字面去推翻它。
  macOS 托盘用 template image(`icons/tray-template.png`,单色只吃 alpha);图标加载失败
  只记日志不拦托盘——没有托盘就彻底没入口了。
- **通知只在有实际动作时发**(更新成功或失败),纯"已最新/全部跳过"的例行轮次不打扰;
  文案只报数量不露目录名,判定与文案在 `scheduler::notification_copy`(可单测)。
- **`plugins.updater` 在 conf 里必须有空占位**:插件 setup 会反序列化它,缺该节应用**起不来**。
  真值走编译期注入并在运行时用 `updater_builder()` 覆盖,conf 里填真值就等于把内网地址
  写进仓库(铁律 5)。有守卫测试钉住。
- **frontmatter 补齐会重建头部**:只在 SKILL.md 不合规时发生,重写后只保证 name/description
  与正文;坏头部里残存的其他字段(license 等)不保证保留(见 share.rs 模块头)。
- **进度事件只报阶段,不报字节**:压缩包一次性下完,没有可信的字节级进度可报。
- **curated.json 约定**(fixture 即此约定):技能库根目录,`{"curated": ["<frontmatter name>", …]}`,
  按显示名记;对不上的条目在 view 层丢弃。真实公司库(2026-07-30 快照)还没有这个文件,
  向导第三步会引导去商店——需要技能库管理员补一份才有"一键全装"。
- **商店卡片上没有作者、也没有安装量**(`core/store.rs` 模块头):frontmatter 只有
  name/description/metadata.internal,逐技能的提交人归因要对每个目录各发一次 commits 请求,
  50 个技能撑不住首屏 <2s。UI-Demo 里那两栏因此留空——**不编造**。安装量是 C5 预留字段,等 M4。
- **UI-Demo 的分类 chip 换成了"全部/未安装/已安装"**:SKILL.md 里没有分类字段,
  硬造分类等于在界面上撒谎。要分类得技能库侧先约定 frontmatter 字段。

### 待处理

**功能缺口**
- **M3-5b:GitHub 分享写路径**(唯一的 M3 剩余):权限矩阵 + 提交端点
  (createCommitOnBranch vs contents)+ fork 时序。DoD 要求先对真实 GitHub 录写行为
  再定端点——**待外部条件**:可写测试仓 + 凭证。开工点:share.rs 模块头 + gitea.rs
  RepoSource 注释("写链路刻意不进 trait")。
- **GitHub device flow 的真实联调**(代码侧已完成,任务 5a):需要用户在 github.com
  注册 OAuth App(勾选 Enable Device Flow)后注入 `SKILLSYNC_GITHUB_CLIENT_ID`。
- **分享页的「新建技能」向导没做**(Demo 里有):等价 `skills init` 的脚手架,
  用户拍板(2026-07-31)留 M4。
- **Windows 外观打磨决定不做**(M2 任务 6 的判断):UI 规范 §75 要 tauri-plugin-decorum,
  但没有 Windows 真机,装上等于把能用的系统窗口装饰换成无法目视验证的自绘控件——画不出
  窗口控制的话用户连关窗都做不到,而关窗现在还接着"缩到托盘"。等有真机再做,连同 vibrancy。

**只能在真机/真实环境验的**
- **Windows 普通权限真机**(任务 6 欠的最后一档):CI 已验 Windows runner 上 junction
  建链/摘链真实通过,且断言"必须是 junction 而不是 symlink"(C11 的提权假阳性有护栏);
  但 runner 权限宽松 ≠ 普通员工受限机器。"不开开发者模式、普通用户权限下装成功且
  Claude Code 读得到"仍欠一次验证。
- **8 个 `cfg(unix)` 测试在 Windows 上不跑**(自指防护、坏软链跳过、软链子目录解引用、
  被改指链接的卸载):要构造场景就得先有 symlink 权限,而那正是 Windows 上假定没有的。
  若要覆盖需另想构造方式(如用 junction 搭场景)。
- **Windows 上的 GUI 行为未验**:托盘、关窗缩托盘、防退出走的是另一条 `cfg` 分支,
  CI 只证明编译与测试通过。macOS 侧已用 AppleScript 实测通过(关窗后进程存活且窗口数归 0、
  托盘「打开」把窗口从 0 恢复到 1、Cmd+Q 正常退出)。
- **托盘图标外观没能目视确认**:本机菜单栏状态项过多把它挤进了溢出区。
- **系统通知未验**:要真实内网源才触发,macOS 首次还需授权。
- **App 自更新的端到端联调**:代码侧与发布通道已就绪,但要真验"旧版本 → 检出 → 装上 →
  重启后版本变了",需要 minisign 密钥对 + 内网静态更新源落点 + 一次真实的双版本发布。
  步骤见部署指南 §7.4。已自动验证的部分:未注入更新源时报 `UPDATE_NOT_CONFIGURED`、
  发布通道 overlay 与三个新变量的闸门、前端状态机(装完不自动重启/安装中不被事件打断/
  失败不吞成成功)。
- **任务 8 的性能数字来自 loopback docker,不是内网真机**:53 个技能冷启动 76.6ms、
  缓存命中 28.1ms(`cargo test --test store_live -- --nocapture`),远低于 DoD 的 2s/300ms,
  但真实内网要加网络往返与更大的压缩包。`tests/store_index.rs` 的 300ms 断言跑在 wiremock 上、进 CI。
- **正式分发的外部条件**(完整清单见部署指南 §6):Apple Developer ID 证书 + 公证凭证、
  Windows 内部 CA 签名或 IT 软件中心白名单、干净双平台真机 ≤5 分钟验收。

**本机环境**
- Rust 走镜像:`RUSTUP_DIST_SERVER` 用清华、crates.io 用 rsproxy(已配在 `~/.cargo/config.toml`);
  `~/.cargo/bin` 不在非交互 shell 的 PATH 中,跑 cargo 前需 `export PATH="$HOME/.cargo/bin:$PATH"`。
