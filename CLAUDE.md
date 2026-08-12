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
./scripts/publish-release.sh 0.2.3   # **发版就跑它**:改版本号→commit+tag+push(触发
                                     # GitHub CI 出 Windows 包)→本地构建 macOS 签名公证
                                     # →打 dmg→等 CI 下载 exe 补签→传内网发布仓
                                     # →更新三平台 latest 公告牌→验收(见「发版」一节)
./scripts/build-release.sh   # 只出包不发布(publish-release.sh 内部调它);强校验编译期内网配置
pnpm test           # 前端 vitest
cargo test --workspace   # Rust 单测(在 src-tauri/ 下)
pnpm lint           # eslint
pnpm build:web      # tsc + vite build —— **提交前必跑**,见下
cargo clippy --all-targets -- -D warnings   # --all-targets 必带,见下
pnpm verify:agents     # 与上游 vercel-labs/skills 差分校验 agents.json 并重生成 fixture(需联网)
pnpm verify:discovery  # 同上,校验技能发现规则
pnpm verify:lock       # 同上,录制 .skill-lock.json(v3)的真实读写行为
```

**提交前的四道闸**:`pnpm test` + `pnpm lint` + **`pnpm build:web`** + `cargo test --workspace`
+ `cargo clippy --all-targets -- -D warnings`。`build:web` 那道最容易漏——vitest **不做类型检查**,
eslint 也不管,只有 `tsc` 会拦。M2 任务 6 就因为只跑了 test+lint,把一处 `.at(-1)`
(超出 tsconfig 的 ES2020 lib)提交进去,双平台 CI 一起红。

**clippy 必带 `--all-targets`**(M4 任务 1 起):不带它**只查 lib**,`tests/` 下的
集成测试一行都不过 clippy。M1–M3 全程漏查,攒下三处告警(两个未用导入 + 一处文档缩进)
一直没人发现——测试代码也是代码,同一把尺子量。
(ci.yml 的 clippy 直到 M8 任务 3 才补上 `--all-targets`,此前 CI 侧一直只查 lib。)

⚠️ **本机 clippy 绿 ≠ 另一个平台绿**(M8 任务 3 实测):有 `#[cfg(target_os = ...)]`
分支时,两个平台看到的代码形状不同,lint 结论也可能不同。真撞过一次:
`RunEvent` 的 match 在 macOS 上多一条 `Reopen` 分支,Windows 上没有,于是同一段
`if code.is_none()` 只在 Windows 触发 `collapsible_match`——**本地怎么跑都是绿的,
只有 CI 的 windows job 拦得住**。动带 cfg 的代码后,别把本地绿当成过关。

## 目录结构

下列模块均已实现(M3 起两个前空壳模块也已落地)。

```
src/
  i18n/          文案资源 + t() 插值;测试里带术语与禁 emoji 的自动门
  styles/        设计 token、dark: 变体绑定 data-theme、少量非 utility 样式
  lib/           ipc(唯一 invoke 通道 + core 返回类型)、format、search、tint、cn、
                 slug(与 core 同一把尺子,口径在 fixtures/slug-samples.json)、update(cardState)
  store/         Zustand:appearance/store-index/install/session/ui/my-skills/share/
                 wizard/settings(agent 开关+更新档位+App 自更新)/prefs(偏好落盘协调)/
                 registries(多源)/local-detail(本地详情)/create(新建技能向导)
  components/    Sidebar/Toolbar/SearchBox/SkillCard/InstallButton/DetailPanel/CommandPalette/
                 Markdown/Icon/SkillIcon/InstallPanel/Wizard + 五个弹窗:
                 ConflictDialog(三选)/RemoveDialog(双确认)/RepairDialog(占位替换)/
                 ShareTakenDialog(占用三选)/RetryLinkDialog(重试时的占位替换)
  pages/         StorePage / MySkillsPage / SharePage / SettingsPage
  hooks/         useDesktopChrome(快捷键 + 右键拦截)、
                 useLocalRefresh(本地技能变更的三级刷新:焦点/切页/文件监听)
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
  core/create.rs     新建技能(等价 skills init):只落 canonical 一个 SKILL.md,
                     不建链/不写 lock/不进 state;slug 必须是 sanitize_name 的不动点
  core/watcher.rs    本地技能目录的文件监听:app_write 静音守卫 + 防抖 + 变更过滤
  core/local_detail.rs 本地技能详情(守卫只放行含 SKILL.md 的真实目录)
  core/app_update.rs App 自更新的纯逻辑:进程内就绪记账 + 检查节拍 + 通知判定 +
                     macOS 包路径推导(重启要走 LaunchServices)
  core/registry.rs   多源解析层:BuiltinSource(编译期常量经参数传入)+ resolve/list/
                     add/remove/url_allowed/auth_config;内建源锁定不落 config
  core/github.rs     GitHub client:读链路(branches/zipball,RepoSource trait)+
                     device flow 原语 + current_user + 写链路(M3-5b:repo_view 权限、
                     createCommitOnBranch、git/refs、pulls、fork+就绪轮询)
  commands.rs        Tauri IPC command 定义(薄壳,逻辑在 core)+ 托盘/updater 接线在 lib.rs
resources/agents.json  75-agent 注册表(移植自 vercel-labs/skills v1.5.20,MIT,保留出处注释)
scripts/           维护脚本(verify-*.mjs 跑上游源码生成 ground-truth fixture;
                   gen-authors.mjs 从技能库 git 历史生成 authors.json,库侧维护工具;
                   build-release.sh / make-dmg.sh / publish-release.sh 发版三件套)
fixtures/          docker Gitea 测试环境 + 样例技能仓库(含 curated.json / tags.json 样例)
docs/              ⚠️ 整个目录在 `.git/info/exclude` 的 `docs/*` 里,**默认不进版本控制**
                   ——设计方案/交接包/UI 规范/任务分解/候选范围/交接提示词都只在本地。
                   **例外只有两个**(exclude 里用 `!` 放行):`terminology.md` 与
                   `部署分发指南.md`——后者自 M1-任务13 起就受版本控制,2026-08-06
                   逐行复审确认已完全脱敏(敏感位全是 `<内网域名>` `<公司名>` `<TEAMID>`
                   这类占位符),用户确认维持公开。
                   **再往 docs/ 加受控文件前必须先做同样的脱敏审计**——推公开仓不可逆。
                   ⚠️ 查文件是否受控别用 `git ls-files | grep "^docs/"`:git 会给非 ASCII
                   路径加引号转义(`"docs/\351\203\250..."`),`^` 锚点直接失配,
                   会得出"没提交"的**假结论**(2026-08-06 真踩过)。
                   用 `git -c core.quotepath=false ls-files docs/`。
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
- `config.json` / `state.json` 顶部必带 `"schemaVersion"`,**当前是 2**(M6 收尾升的:
  技能检查间隔从小时改成分钟,为了加「每 5 分钟」档)。启动时按版本链式迁移,
  未知更高版本→只读模式+提示升级 app,绝不写回破坏。
  **迁移发生在读取路径上,写回是惰性的**:load 之后内存里已是新结构,文件要等下一次
  save 才被盖成新版本——真机实测过(v1 的 `intervalHours:4` 读成 240 分钟,
  用户在设置页点一下档位才把文件落成 v2,期间 `ui`/`registries` 原样保留)。
- `~/.agents/.skill-lock.json`(npx skills,schema v3)是**外部契约**:写入前探测 version 字段,非 3 则跳过双写并记日志,不得报错阻断主流程

## 测试要求
- core 模块单测覆盖:installer 降级链、SKILL.md 解析边界、state 迁移、同名预检三分支
- Gitea client 用 wiremock-rs 模拟;e2e 用 docker compose 起 gitea(见 fixtures/)
- Windows 相关(junction、路径、CRLF)必须在 Windows CI runner 上跑,不得只测 macOS
- **路径一律按 `Path` 比,不按字符串比**(M4 任务 4 的 CI 教训):`home.join(".agents/skills")`
  在 Windows 上产出 `.agents/skills\x`,而分段 join 产出 `.agents\skills\x`——同一个目录,
  字符串却不等。`create.rs` 的 shared 撞名检查原先按字符串比,在 Windows 上直接失配放行;
  macOS 上两种写法恰好相同,本地怎么跑都是绿的。**同类隐患仍在 `share.rs`**
  (`s.local_path == path.to_string_lossy()`),目前靠"两侧都出自 `canonical_global_dir`"
  才碰巧一致,那是巧合不是保证。
- **别靠 `drop(MockServer)` 空出端口来模拟"连不上"**(M4 任务 4 的 macOS CI 教训):
  测试是并发跑的,另一个 MockServer 完全可能立刻绑上刚空出来的随机端口,请求打到别人
  身上拿到正常响应。用保留域名 `.invalid`(DNS 必然解析失败)——与 `proxy_bypass.rs`
  绕开 loopback 豁免是同一个套路。这条测试之前一直绿**只是运气好**。
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
- **GitHub API 对无 User-Agent 的请求一律 403**:live 测试必须用
  `app_http_client_proxied()`,不能用裸 reqwest Client(2026-08-03 撞过,已修并注释)。
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
- **M1–M5 全部完成**(分解文档在 docs/,只在本地)。新里程碑开工前**先做任务分解并给
  用户过目拍板**,之后逐任务:先写测试清单,再实现,DoD 全满足才进下一任务
- 每完成一个任务 git commit,信息格式:`M<当前里程碑>-任务N: 摘要`(历史为 `M1-`…`M5-`)
- 决策记录 C1-C12 + C-UI + C-OAuth 已全部拍板(见交接包),直接执行不复议
- 文档未覆盖的决策:按决策记录精神自行选择,在 commit message 与代码注释中显式标注"假设:xxx";涉及删除用户数据、安全、对外网络请求的新增行为必须停下询问
- 保障 agent 范围(CI 验收矩阵):Claude Code / Cursor / Codex / Trae(国际版 `trae` 与国内版 `trae-cn` 都要覆盖),
  其余注册表 agent 尽力支持
- **本文件体量已拍板维持现状**(2026-08-06):它 730 行 / 64KB,是平台建议预算(~200 行)
  的 3.6 倍。**不要再提议拆分或压缩**——`docs/*` 默认不进版本控制,内容挪过去换机器就丢;
  而本文件是这个项目唯一受控的开发者文档。里面的「现役机制约束」与「关键事实」
  是逐条用实测换来的,长是它的成本,不是它的缺陷。
- **本项目对全局「隐藏 AI 痕迹」规则有例外**(2026-08-06 用户拍板):`CLAUDE.md` 本身
  **受版本控制且在公开仓里**,README 也公开链接它——理由是单人开发的开源项目,
  它就是这个项目的开发者文档。**别按全局规则把它加进 exclude 或重写历史**。
  仍然适用的部分:`docs/*`(除放行的两个)、`_*.md`、AI 流程产物一律不进版本控制。

## 当前进度(2026-08-11,M7 完成 + M8 任务 1-3 完成,现役 v0.3.13)

**M7 = 作者/贡献者展示**(M6 候选三,方案在拍板过程中被用户推翻两次,终稿是
tags/curated 同款的库侧静态文件,分解在 docs/M7-任务分解.md,只在本地):
任务 1 parse_authors 进索引 → 任务 2 卡片/详情展示(全离线)→ 任务 3 gen-authors
脚本 + 部署指南 §5 契约 → 任务 4 本节与 README 的承诺同步 → 任务 5(追加拍板)
分享链路自动维护 authors.json(起因:git 历史把代传技能都算到上传者头上,
"谁分享的"比"谁提交的"更接近真相)。细节见「关键事实」的作者条目与 git log。

**下一阶段 = M8:Windows 发版**(2026-08-07 定,分解在 docs/M8-任务分解.md,只在本地)。
用 Windows 的同事至今拿不到包,已经表达失望——**这是 M8 的首要目标,其余欠账全部
排在它后面**(顺延清单见 M8 文档第三节,每条都有既有的推迟理由,别当遗漏重做)。
**构建路线 = 公开 GitHub Actions**(2026-08-07 用户拍板,**推翻了当日早前
「不能走公开 CI」的红线**——理由:Windows 本机构建太麻烦)。保密边界随之重划:
- **可以进公开 CI 的 secrets 与 artifact**:内网地址、仓库坐标、OAuth Client ID
  (公共客户端无 secret)、minisign 公钥——artifact 任何人可下载,用户明确接受;
- **仍绝不进公开仓的**:minisign 私钥、任何 token/密码。`TAURI_SIGNING_PRIVATE_KEY`
  不在 release.yml guard 的必需名单里,CI 产物**不带 .sig**,由本地
  `pnpm tauri signer sign` 离线补签(已实测可行;私钥永不离开这台 mac)。
  守卫:`bundle_config.rs::public_ci_never_requires_the_signing_private_key`。
- 铁律 5(源码/仓库文件中不得出现真实内网地址与 OAuth secret)**不变**
  ——secrets 是 CI 配置,不是源码。
macOS 交叉编译仍不通(aws-lc-sys 要 Windows SDK),但已无所谓——不再需要本机构建。
原「先验收再搭构建环境」的顺序陷阱**随之解除**:用户那台公司 Windows 机不装任何
开发工具,保持干净,直接当「Windows 普通权限真机」验收环境用。

**M1–M6 全部完成并提交**(M6 分解与拍板见 docs/M6-任务分解.md;任务 4/5 中途被用户
推翻重做过,经过在 git log)。
**现役版本 v0.3.13**(2026-08-11 发布,公告牌实测指向它:三平台条目齐全,
从发布仓下载的 exe 用公告牌里的签名 + 打进包的公钥 minisign 验签通过)。
**v0.3.10 是首个含 Windows 包的版本**;**v0.3.11 修 Windows 登录失败**
(凭据管理器大小上限,见「关键事实」的钥匙串分片条目);
**v0.3.12 = Windows 自更新"下载好再等用户点" + 程序坞图标 / 托盘左右键**;
**v0.3.13 = 窗口终于能拖动**(真根因是 ACL 缺 start-dragging,见现役约束)。0.3.1–0.3.7 是**为了验证自更新链路连发的**
——改更新机制天然要两跳:一跳把机制送到用户机器上,一跳才能让它自己跑起来。
自更新新链路(静默备好 → 左下角 pill → 重启生效)与 macOS 重启激活修复
**在 macOS 上已真机端到端验过**(见下面的现役机制约束);
**Windows 侧的自更新至今一次都没真跑过**——0.3.12 发出去只是把第二跳的条件备齐
(0.3.10/0.3.11 → 0.3.12 现在才第一次有旧版可升),**跑没跑通仍要用户在真机上看**:
pill 出现 → 点了才装 → 应用不再自己退出。**别把"发出去了"写成"验过了"。**
**M6 候选五条的处置**:候选二(标签)当日提交 tags.json + curated.json 到真实库,
用户已验证生效;候选一(更新提示)= 任务 1–3;候选四(认领语义)= 任务 4–5;
候选三(作者/贡献者展示)= **M7 已做**,且没按当初"详情面板破例联网"的思路——
方案两次被用户推翻后落在 authors.json 静态文件上,"详情面板不联网"的例一次都没破
(见「关键事实」的作者条目)。

M5 任务 2 要点:「我的技能」三分区,归类徽标全撤;
`installed_list` 只列 canonical 真实存在的目录(记账保留,重获取时 precheck 走 Fresh 对齐),
`body_present` 字段已删——别再往 DTO 里加"存在性"字段,存在性由 core 过滤保证。
M5 任务 3 要点:技能库根 `tags.json`(`{"tags":{"<dirSlug>":["标签",…]}}`,管理员契约在
部署指南 §5)→ `store::parse_tags` 宽容解析进索引 → 商店 chip 单选(切库清筛选)+
搜索匹配 + 详情展示。当时的记载是"缓存版本没升也不用升"(tags.json 改动必伴随库提交,
head 一变缓存即重建)。⚠️ **这条推理已于 2026-08-07 被 M7 的真机缺陷证明不完整,别再照抄**
——它只在"数据后于代码到达"时成立;数据先于代码时,旧版本会用最新 head 建一份缺字段的
缓存,新版本永远命中它。**加新字段一律升 `INDEX_SCHEMA_VERSION`**(现为 3,见「关键事实」)。
tags 当时侥幸没出问题,是因为支持它的版本先到了用户机器上。
✅ **`tags.json` 与 `curated.json` 已于 2026-08-06 提交到真实内网技能库**(8 类标签 / 精选 7 项,
用户已验证商店标签行与向导一键全装均生效)。此前"双 404"的记载已过期。
**这条经验仍然成立**:界面什么都不显示时先查数据源存不存在,别当成功能坏了。
逐任务的产物与假设见 `git log`。远端 `origin` =
github.com/dhslegen/skill-sync(2026-08-03 起转为**公开**——为免私有仓 Actions 计费,用户拍板)。

- 本机:Rust 483 + 前端 411 测试通过(2026-08-11 v0.3.13 起),clippy(**--all-targets**)/eslint/tsc 干净,
  `pnpm dev` 启动冒烟通过(带内网配置实测:商店读到真实库 30 个技能)
- **双平台 CI**:**M4 任务 1 的两笔(`3857720` / `a7a1de3`)macOS + Windows 双 job 全绿**(2026-08-04 逐 job 实测);
  M3 任务 1–5a(`2006213`…`5259ea2`)连续五次全绿;`de7b233`/`2eb0595` 当时因账号计费
  被拒,仓库转公开后 2026-08-03 rerun 双 job 全绿(任务 6 的 claim_flow junction 路径
  首次真实过 CI)。**下一个提交的 CI 结论自己 `gh run list` 看,别照抄这一行**
- **真实 GitHub e2e 已跑通**:读链路(任务 4,`github_live` 对 dhslegen/skills
  走完 索引→发现→安装→lock 双写)、device flow 登录(5a,`device_flow_live`,
  身份 dhslegen)、分享写路径(5b,`share_github_live` 对一次性测试仓走完
  新增分享→更新分享,两笔真实提交);三个 live 测试都默认跳过不进 CI

> ⚠️ **"CI 绿"这句话曾经假了很久**:macOS job 一直绿,**Windows job 从 M1 任务 10 起
> 连红六个提交**没被发现——M1 交接材料里"双平台 CI 已真实跑通"在任务 9 之后就不成立,
> 而 M2 全程照抄了它。根因在测试侧:`remove_flow.rs` 用 `remove_file` 删关联,而 Windows
> 上关联是 **junction**(目录重解析点),直接 `Access is denied`。已修。
> **教训:写任何"CI 绿"的结论前先 `gh run list` 看一眼,别把上一份文档的结论当事实抄下去。**

M2 新增的 IPC:`ui_prefs_get/set`、`auto_update_get/set`、`agents_set_disabled`、
`open_library_url`、`update_check_now`、`app_update_check/install`、`app_restart`、
`skill_link_agents`;新增事件:`scheduler://report`、`app-update://available`。
M3 新增的 IPC:`registry_list/add/remove`、`auth_device_start/wait`、`skill_claim`;
M3 后补(2026-08-03):`skill_local_detail`/`skill_reveal`(本地详情面板 + 在访达/
资源管理器中显示,core/local_detail.rs,守卫只放行含 SKILL.md 的真实目录);
既有读写类 command 全部接受 `registryId`(缺省内建);编译期新常量
`SKILLSYNC_GITHUB_CLIENT_ID`(未注入仅登录不可用,浏览获取照常)。
M4 任务 1 新增的 IPC:`registry_add_repo`/`registry_remove_repo`;
读写类 command 再加可选 `repo` 参数(寻址键 `owner/repo`,缺省 = 该源主仓)。
M4 后续新增的 IPC:`share_preview`(任务 2)、`skill_create`(任务 4)、
`skill_unclaim`(任务 6a);新增事件 `local-skills://changed`(任务 6c,载荷为空,
只是"去重新扫描一下"的信号,core 侧已滤掉本应用自己写盘引发的那些)。
`InstalledSkillView` 新增 `localOnly` / `claimed` 两个字段(任务 6a 的第三档与取消认领)。
M6 的契约变更:新增事件 `app-update://ready`(载荷为版本号;探测路径**不再发**
`app-update://available`,前端那条监听已删);`AppUpdateStatus` 新增 `ready` 档;
`InstalledSkillView` 新增 `claimBindable`;**没有**新增 command
(原计划的 `skill_claim_preview` 已撤——判定并进了 `installed_list`,不留没人用的 API)。
M7 的契约变更:`StoreSkillCard` 新增 `author`(`string | null`)、`SkillDetail` 新增
`attribution`(`{author, contributors} | null`);**没有**新增 command 与事件
——归因随索引一起下来,前端零新增请求。新增 core 原语 `gitea::file_content`
(contents API 读单文件内容 + blob sha)。

### 现役机制约束(动相关代码前必读)

这些**都已实现**,列在这里是因为它们的不变量不看就会破坏。已完成的过程叙事在 git log。

- **术语:「认领」已于 M6 任务 4 改名为「纳入管理」**(反向 = 「移出管理」),
  分区标题「npx skills 安装」→「其他工具装的」、「商店安装」→「由技能库管理」。
  理由:"认领"的语义前提是"这东西暂时没主",而技能就在用户自己电脑上——词与事实相反。
  **代码里的标识符仍叫 claim/unclaim/claimed**(ID 用英文,只有用户可见文案改了)。

- **App 自更新是"静默备好 + 提示重启"**(M6 任务 1–2,对齐 Cursor/Claude 桌面端):
  检出新版 → 后台准备好(不重启)→ emit `app-update://ready` → 左下角 pill。
  - ⚠️ **"备好"在两个平台是两件事,`stage_app_update` 必须分平台走**
    (2026-08-07 Windows 真机暴露,用户问"为什么 Windows 是自动更新的"):
    macOS 上安装 = 替换 `.app` 目录包,应用照常运行,所以**下载即安装**;
    Windows 上**替换不了正在运行的 exe**,tauri 的 `install()` 会先
    `std::process::exit(0)` 把应用杀掉再跑 NSIS——在自动轮次里装,用户看到的就是
    "用着用着应用自己没了"(每分钟检查一次,新版一发出去就会撞上)。
    所以 Windows 只**下载**、把字节留在 `ReadyState.pending_install`,
    等用户点了 pill 才在 `app_restart` 里 `install()`。
    - 对外语义**刻意保持一致**:`ready` = 新版内容已备好、点一下就生效,
      因此 `app-update://ready` 事件与前端 pill **一个字都不用改**;
    - `take_pending_install` **取走即清空**:`install()` 正常情况下不返回(进程已退出),
      万一失败返回了,字节还留着就会在下次点重启时重复安装;
    - install 要 `Update` 对象而下载那轮的早已 drop,`app_restart` 里**重新 check 一次**
      拿回来;拿不到(网络断)就照常重启旧版——不能因为更新装不上就不让用户重启;
    - Windows 分支在 macOS 上**根本不编译**,本地测不到,靠 CI 的 windows job 把关。
  - 就绪记账在**进程内**(`core/app_update.rs` 的 `ReadyState`),不落盘:
    tauri updater 的 `check()` 永远拿**运行中进程**的版本比远端,装好等重启这件事
    只有我们自己记得。重启后状态天然作废,所以也不需要"忽略此版本"的记忆;
  - **窗口可见就不发系统通知**(pill 已经在),缩托盘才发——同一件事只打扰一次;
  - **App 检查有自己的常驻循环**(`spawn_app_update_probe`:启动后 20 秒 + 每
    `app_update::CHECK_INTERVAL` = **1 分钟**),**与技能检查彻底解耦**,只受
    「自动更新应用」开关控制。开关关掉时循环**不退出**(退出了要重启应用才恢复)。
    ⚠️ 原设计是"寄生技能检查那一拍、不新增档位",**已被实测推翻**:技能档位设「手动」
    时 `scheduler::next_delay` 返回 None、调度循环根本不 tick,App 自更新就只剩启动
    那一次——用户等到的是"什么都没发生"(2026-08-06)。
  - **手动安装(设置页)也发 `app-update://ready`**:pill 挂在它上面,只有自动轮次发的话
    两条路两种表现。日志佐证很好用——只有"应用更新已安装"没有"已在后台就绪",
    一眼看出走的是手动通道。
  - **这条链路已端到端验证**(2026-08-06,0.3.4→0.3.5):自动静默装好 → pill →
    点重启 → 新版起来且窗口在前台,四行日志齐全。要再验只能两连发,单测证明不了它。

- **macOS 上重启必须走 LaunchServices**(2026-08-06 实测):`AppHandle::restart()`
  直接 spawn 包内可执行文件、绕开 LaunchServices,新进程在父进程随即退出时
  **拿不到激活权**——窗口建出来了却沉在所有应用后面,用户看到的是"重启完没有界面,
  点程序坞图标才出来"。控制变量对照(旧实例在新实例起来后立刻退出):
  直接跑二进制 → `frontmost: false`;`open -n -a <bundle>` → `frontmost: true`。
  `commands::app_restart` 因此在 macOS 上走 `open -n -a` 再 `app.exit(0)`
  (防退出只挡 code=None,`exit(0)` 走得通),认不出 `.app` 或 open 失败才回退
  `restart()`——重启不成比激活不了严重。路径推导在 `app_update::macos_bundle_path`。

- **更新提示的三处出口口径一致**(M6 任务 3):侧边栏「我的技能」角标 = `updateCount`,
  它**逐条走 `hasUpdate`**,不另写判定——角标与页内徽标是同一件事的两个说法,
  口径一漂就是"角标说 3、点进去只有 1"。`attachReportListener` 在 `status === "checked"`
  时**连索引一起重载**:检查发现新内容但因本地改动跳过时,磁盘与账上都没变、
  变的是远端,不重载索引就会一起装作无事发生。

- **来源绑定只有一份实现 `acquire::resolve_binding`**(M6 任务 4),两条判据:
  `sourceUrl` 是 URL → 同源 + 该库在源的库列表里;不是 URL → 按 owner/repo 找、
  **唯一命中才绑**(多个源有同名库时绑谁都是猜)。
  - **内建源必须显式传进去**(`BindingSources`):它锁定且不落 `config.registries`,
    只传 config 的话公司库技能绝无可能绑上——M3 起"认领对主线场景从来没生效过"就是这个根因;
  - `installed_list` 给未纳入管理的行带 `claimBindable`(同一份判定),界面据此摆
    「纳入管理」或「分享到技能库」。**绑不上就不摆那个按钮——不摆比解释好**。

- **写 `.skill-lock.json` 的 sourceUrl 必须是完整 URL、sourceType 必须是真实类型**
  (M6 任务 6 修):此前写的是 `"owner/repo"`、类型一律写死 `gitea`,与自己录的
  ground truth(`tests/fixtures/upstream-skill-lock.json`)不符,也让上面那条同源判据
  对本 app 自己装的技能整个失效。载体是 `acquire::SourceMeta`(registry_id + kind +
  base_url),`acquire` / `acquire_batch` / `scheduler::run_check` 都收它。

- **分享直推进库后自动纳入管理**(M6 任务 5,`share::adopt_into_management`),四道闸:
  只认直推(走评审的还没进库)/ 只认 canonical / **本地目录名必须等于远端目录名**
  (中文名技能另起 ASCII 远端名,两者不同时记账键对不上)/ 已有记账不覆盖。
  `origin` 记 `claimed`——文件是用户自己的,必须留着「移出管理」这条无损退路。

- **回推前必须过远端变更检测**(M5 任务 1,`share::share_installed`):
  乐观锁(CONFLICT_STALE)只拦"拉 sha 与提交之间"的瞬间竞态——提交用的是**当前**
  远端 blob sha,「A 基于旧版改、B 早已推新版」会拿最新 sha 通过校验**静默覆盖 B**。
  检测判据 = 远端 zip 指纹 ≠ 账上 `content_hash`,**与本地改没改无关**(本地没改时
  回推的是旧版,照样覆盖);命中即返回 `ShareInstalledOutcome::RemoteChanged`
  (NeedsDecision 同款:不是错误,磁盘与远端零写入)。要点:
  - 指纹路径必须拼 `archive.root`(entries 键带压缩包顶层目录)——不拼会**恒判冲突**,
    而且冲突侧测试自己发现不了,要靠"远端一致应直通"的对照组;
  - 基线(`content_hash`)为空跳过检测:空串与任何指纹都不等,不跳会恒拦;
  - 确认后的第二跳带 `force_review: true`:跳过检测 + submit 矩阵**砍掉直推**
    (其余分流不变),记账照旧一个字不动;**没有「强行覆盖」入口**(用户拍板);
  - `CONFLICT_STALE`(检测与提交之间被抢先)在前端导入**同一个**冲突档;
  - `install.ts` 的 `keepLocalAndShare` **恒带 forceReview**——那条路的前提就是
    "远端有新版",直推等于覆盖对方,是同一缺陷的第三个入口;
  - 检测走**读链路**(`read_source`,内建源匿名),提交走**写链路**(实名),不能省成一个;
  - live 用例**直推 main 必须拿 `share_live.rs` 的 `MAIN_BRANCH_LOCK` 并自清理**:
    并发直推同分支在真 Gitea 上撞车、残留技能打红 gitea_live 清单断言,两个都真实发生过。

- **多源解析只有一个入口**(M3 任务 1):commands 一律经 `registry::resolve`
  (`BuiltinSource` 把编译期常量当参数传——测试构建不注入常量,直读会让测试只能测
  "未配置"分支)。内建源锁定且**不落 config.registries**(坐标是编译期常量,落盘会造出
  第二份真相);自定义源 id 生成 `custom-N` 取 max+1 **绝不复用**(缓存与凭证按 id 落)。
- **一源多仓:浏览/获取/分享的最小单位是「(源, 技能库)」**(M4 任务 1)。
  寻址键 = `owner/repo`,`resolve(.., key)` 不带键时落主仓(内建 = 编译期常量,
  自定义 = `repos[0]`),既有调用方外部行为不变。要点:
  - 内建源的追加仓落 `config.builtinExtraRepos`,**base_url 永远取编译期常量**
    ——同源由构造保证,不需要 URL 校验,也不违反铁律 5(用户输入的坐标不算源码泄漏);
    内建**主仓**仍不落盘、不可移除(`REPO_BUILTIN_LOCKED`);自定义源不许删到空
    (`REPO_LAST_REPO`,引导删整个来源)。
  - **索引缓存按 (源,仓) 分文件**:`index-<id>-<owner>-<repo>.json`。M3 的
    `index-<id>.json` 升级后成孤儿(内建源不可移除,清不掉),**这不是缺陷**——
    派生数据,重下即可;删自定义源时 `drop_caches_for_registry` 新旧命名一起清,
    前缀带尾横杠所以 `custom-1` 不误伤 `custom-10`。
  - **更新与回推必须带账上的仓库坐标**,缺省会打到主仓:「我的技能」的更新传
    `sourceOwner/sourceRepo`,回推在 `commands::installed_repo_key` 取账上坐标
    (`share_installed` 的 owner/repo 本来就取账上,但 **branch 由调用方给**)。
  - **「有无可用更新」的判定要比到仓**,两处都要:`my-skills.ts` 的 `hasUpdate`
    与 `lib/update.ts` 的 `cardState`(商店卡片 + 详情面板底部共用)。源相同还不够
    ——同源两库有同名技能时,内容当然不一样,按源比会把它判成"更新"。
  - **「同名技能装自另一个技能库」是独立的一档,不是更新**:
    core 侧 `acquire::precheck` 收 `target: Option<&RepoRef>`,来源库不同即返回
    `Precheck::OtherLibrary` 并进"需要拍板"分支(批量流程跳过并给人话原因);
    UI 侧 `cardState` 给 `otherLibrary` 档,按钮文案是「替换」不是「更新」,
    冲突弹窗另有一档文案(套外来目录那句"不是本应用安装的"是假话——它就是本应用装的)。
    **来源库比对必须先于内容 hash 比对**:用户没改过本体时 hash 照样不等,
    落进 `Managed` 就会被当成一次正常更新静默做掉——清空重建 canonical 并把记账
    改指过去,全程不问用户一句。有测试断言"拍板之前磁盘一个字节都没动"。
  - `install.ts` 的 `refreshInstalled` **必须把 registryId/sourceOwner/sourceRepo
    一起收进 `installed` map**:少了它 `cardState` 拿不到库,判定静默退回 M3 口径。
    别的测试都直接 setState 塞 map 走不到这条路,`install.test.ts` 里那条是唯一护栏。
  - **认领绑源要求"同源 + 该库在源的库列表里"**(`acquire::bind_source`):
    只比同源会把 `host/someone/other-repo` 的技能绑到该 host 的源上,而更新只会
    去主库找同名技能——M3 起就静默存在,M4 任务 1 修掉。
  - **商店的库切换器在加载中/出错两档也要渲染**:早退分支把它挡掉后,用户切到
    连不上的库就再也点不回来(2026-08-04 真机视觉自查抓到,有测试钉住)。
- **分享前的路径预告**(M4 任务 2,`share::preview_permission`):
  - **`permissions.push` 单独用会说谎**——目标分支受保护时它仍是 true,而直推必然 403。
    准确判据是 `GET /repos/{o}/{r}/branches/{branch}` 的 **`user_can_push`**
    (合并了仓库写权限与该分支的保护规则,只读用户也读得到;管理员在受保护分支上
    同样是 false)。两个字段合起来才分得出三条路,录制见
    `tests/fixtures/gitea-permissions/NOTES.md`。
  - **预检必须走带凭证的 client**(`share_source`,不是 `read_source`):匿名与只读的
    `permissions` 完全相同,而内建源的读链路硬编码匿名——顺手复用就会让每次预检
    都预告"无权限"。wiremock 用 `header_exists("authorization")` 钉住。
  - **探不到一律 `Unknown`,绝不落进"无权限"档**(`permissions` 的 serde default 会把
    读不到变成 `push:false`,方向恰好是反的);界面对 Unknown **整条不显示**。
    预检失败绝不拦分享——它只是提示,提交时刻的权限矩阵仍是权威判定。
  - **GitHub 的分支保护预检不到**(REST branch-protection 端点要 admin 权限),
    有写权限时只给 `MaybeDirect`「可能直接生效」,**不假装知道**。
  - core 返回枚举不返回中文句子:两道术语门都扫不到 core 里的散装文案
    (`tests/terminology.rs` 只扒 `AppError::new`,前端守卫只扫 `src/`)。
  - **「源没了」与「库不在源的列表里」是两句不同的话**(`commands::source_state`):
    后者源好好的,说成"来源已移除"是假话(M3 `bind_source` 绑歪的存量条目会走到这档)。
    两者都让「更新」按钮消失——摆出来就是引诱用户点一个必然报错的按钮。
- **读链路对来源类型无感**(M3 任务 4):store/acquire/scheduler 只吃 `gitea::RepoSource`
  trait(branch_head + download_archive),分发在 `commands::read_source` 的 SourceClient
  枚举。**写链路(分享)刻意不进 trait**——两家提交/评审 API 形状完全不同,
  分享走 share.rs 的 `ShareClient` 枚举分发(M3-5b,与 SourceClient 同款模式);
  GitHub 写路径错误判定用 GraphQL `errors[].type`(STALE_DATA /
  BRANCH_PROTECTION_RULE_VIOLATION),不 grep message,依据是真实录制
  (tests/fixtures/github-write/NOTES.md)。`require_gitea` 如今只守 Gitea
  专属的登录配置通道。
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
- **钥匙串里的凭证是分片存的,因为 Windows 只给 1280 个字符**(M8,2026-08-07,
  v0.3.10 Windows 首个真机版登录失败的根因):Windows 凭据管理器的
  `CRED_MAX_CREDENTIAL_BLOB_SIZE = 5*512 = 2560` **字节**,而
  `windows-native-keyring-store` 写入前把密码转成 **UTF-16**(字节数翻倍,
  见该 crate `utils.rs`:`blob = vec![0; blob_u16.len()*2]`,超了返回 `TooLong`)
  ——实际上限 = **1280 个 ASCII 字符**。而 Gitea 一对 JWT 序列化后约 **1778 字符**
  (实测 access 859 + refresh 859),**每次登录必然超限**。macOS 钥匙串没有这个限制,
  所以本机与 CI 全绿、只有 Windows 用户中招。
  - 现在 `KeyringStore` 按 UTF-16 码元数切片(`MAX_UTF16_UNITS_PER_CHUNK = 1200`,
    不顶格 1280 是给令牌长度浮动留余量),分片存 `{account}.part{i}`,
    主条目改存清单 `{"chunks":N}`;**分片全写成功才更新主条目**
    (反序会留下指向半份内容的清单),**覆盖写前先清旧分片**(否则旧令牌碎片
    长期留在系统凭据管理器里,是泄漏面)。
  - **旧格式必须继续读得出来**:v0.3.10 及更早写的是整份 `Credentials` JSON,
    `parse_primary` 先试它再试清单——不然升级会把已登录用户全部踢下线。
    反向降级(≤0.3.10 读到新清单)会 serde 失败 → `.ok()` → None → 视为未登录,
    重新登录即可,不会崩。
  - **切片必须按 `char` 边界并按 `len_utf16()` 累计**,不能按字节:UTF-8 字节数与
    UTF-16 码元数没有固定比例(ASCII 1:1、中文 3:1、BMP 外 4:2),按字节估会估反。
  - 护栏:`core::auth` 的纯逻辑测试(每片不超限 / 往返一致 / 旧格式可读,三轮注入验证过)
    **+ `tests/keyring_windows.rs` 的真机往返**——后者才是关键。这个缺陷发生时
    Rust 470 + 前端 408 全绿、双平台 CI 也绿,**因为没有一条测试碰过真实的
    Windows 凭据管理器**(全走 `MemoryStore` 或纯逻辑)。
  - ⚠️ 排查时别把浏览器那句「登录成功」当成登录成功:那个页面是
    `handle_callback_request` 在**拿到授权码的当场**回的,换令牌与存凭证都还没发生。
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
- **`state.shared` 的记账键与展示键不一致(潜在,已用 UI 锁死堵住入口)**:
  写记账按**远端目录名** `next.shared.iter().position(|s| s.name == req.share_name)`,
  读状态按**本地路径** `state.shared.iter().find(|s| s.local_path == ...)` 且 `find` 只取第一条。
  只要同一个本地目录用两个远端名分享过,两把钥匙就对不上:远端留下无人维护的孤儿,
  `shared` 里两条记录指向同一目录,界面之后一直显示**第一条**(旧的那条)。
  M4 任务 6b 把「分享改动」的远端名字段改成只读堵住了唯一入口(`share_installed`
  走账上坐标不经表单),**但底层的双键不一致仍在**——将来若再开放改名,必须先统一成
  一把钥匙(建议记账也按 `local_path`,或改名时显式迁移旧条目)。
- **保留本地改动时,关于内容的记账一个字不动**:`commitSha` 与 `contentHash` 保持旧值,
  它们不符正是"有可用更新 / 有未分享的改动"两个标记的判据。回推走了评审(分支保护/只读)时同理
  ——改动没进 main,清了 contentHash 等于把「已改动」标记藏起来。
  「保留并分享」是前端编排(先 `run("keepLocal")` 落稳再 `skill_share_changes`),core 的
  `Resolution` 仍只有两档。
- **偏好落 `config.json` 的 `ui` 字段**(theme/accent/wizardDone,serde default 兼容,
  schemaVersion 当时仍 1,现已随 v2 一起走)。同步方向唯一:**config 有值则 config 赢**;localStorage 降为首帧防闪
  与 IPC 不可用时的兜底。入口 `store/prefs.ts`:**未同步成功绝不反推 config**(不拿猜的值
  覆盖真数据)。agent 开关记在 `disabledAgents`(禁用名单而非启用白名单——注册表会新增 agent)。
- **系统代理:一律直连**(任务 13):`gitea::app_http_client` 对全部请求 `.no_proxy()`
  ——M1 只有内建源且必在内网,直连即正确语义。**M3 接外网源时必须按 registry 重新决定**。
  测试坑:reqwest 对 loopback 目标**默认豁免代理**,拿 wiremock 当目标测代理行为必然空转;
  `tests/proxy_bypass.rs` 用 `.invalid` 域名 + 对照组绕开。
- **`open_library_url` 只放行与内建 Gitea 同源的地址**(scheme+host+port 全等),
  `javascript:`/`file:` 一律拒绝——那是从 webview 通往系统的通道。多源之后要按 registry 放行,
  但别放宽成"任意 URL"。
- **窗口拖动要两个条件同时成立:前端有拖拽区 + capability 授了
  `core:window:allow-start-dragging`**(2026-08-11 真机验证)。
  - 🔴 **`core:window:default` 里没有 `allow-start-dragging`**,必须在
    `capabilities/default.json` 里显式加(项目自己的 `gen/schemas/acl-manifests.json`
    可核实:默认集 28 条,有 `allow-internal-toggle-maximize`、唯独没有它)。
    缺了它的表现极具迷惑性:tauri 注入的 `drag.js` 在 `document` 上照常收到 mousedown、
    判定也过了,只是最后那句 `invoke('plugin:window|start_dragging')` 被 ACL 拒掉
    ——**前端毫无异常,控制台之外零痕迹**。这个应用从 M1 到 v0.3.12 的窗口
    **一次都没能拖动过**,期间两轮"修复"(删死代码层、给 Sidebar 顶部加拖拽区)
    修的都是没坏的地方:DOM 一直是对的。守卫
    `bundle_config.rs::drag_regions_require_the_start_dragging_permission`。
    ⚠️ 可证伪的对照:**双击最大化用的是默认就给的那条权限**,所以"双击能最大化、
    按住拖不动"就是 ACL 缺权限的现场指纹,别再去查 DOM。
  - 拖拽区在三处:Sidebar 顶部那条 52px(给 macOS 红绿灯让位的空白)、Toolbar 容器、
    向导顶部 h-11,都挂 `data-tauri-drag-region`。
  - ⚠️ **别再往顶部加"横跨全宽的拖拽层"**:那样会盖住 Toolbar 上的所有控件,
    唯一的补救是 `pointer-events-none`,而它把拖拽也一起废掉——两者不可兼得。
    App.tsx 里原先就有这么一层,写着 drag region 却从来没生效过。
  - **裸写的 `data-tauri-drag-region` 是 self 语义**(`drag.js` 里
    `el === composedPath[0]`):只有直接点在该元素上才算,想让整个子树可拖要写
    `data-tauri-drag-region="deep"`。所以拖拽区只挂在**容器**上,内部每个可点控件
    都不在拖拽区内,否则按下按钮会被当成拖窗口、点击永远发不出去(UI 规范 §6.1)。
  - **`drag.js` 的监听器挂在 `document` 的冒泡阶段**:路径上任何一处
    `stopPropagation()` 都能让拖拽整体失效(React 合成事件的 stopPropagation
    会连原生事件一起停在 root 容器上,根本到不了 `document`)。
  - 守卫:`Sidebar.test.tsx` 断言拖拽区存在**且不带 `pointer-events-none`**;
    权限那条由 `bundle_config.rs` 守着,判据是"前端有没有拖拽区",拖拽区搬家也不失效。
- **托盘/菜单栏:左键开窗口,右键出菜单**(2026-08-07 用户提,两个平台的系统惯例):
  `show_menu_on_left_click(false)` + `on_tray_icon_event` 里只认
  **左键 + 抬起**(`MouseButtonState::Up`)。认"按下"会在 macOS 上用户
  Cmd 拖动菜单栏项时误触发。
- **macOS 上必须接 `RunEvent::Reopen`**(同上):关窗只是隐藏,应用仍在程序坞里,
  此时点程序坞图标系统发的是 `applicationShouldHandleReopen`。不接它,
  用户点了**什么都不会发生**,而图标还在——看起来就是"应用卡死了"。
  Windows 没有这个概念(任务栏图标随窗口一起消失,入口只剩通知区图标)。
- **托盘与退出**:关窗 = 缩到托盘(用户拍板),「退出」只在托盘菜单。
  **`ExitRequested{code: None}` 的防退出不挡 Cmd+Q**——macOS 的退出走 `app.exit`(code=Some),
  这条特意实测过,别照 tauri 文档"code 是 None 就是用户交互"的字面去推翻它。
  **它同样不挡「重启」**(2026-08-07 查 tauri 2.11.5 源码确认):`app.restart()` 从非主线程
  调用时走 `request_exit(RESTART_EXIT_CODE)`,code 也是 `Some`。两条重启路径
  (macOS 的 `app.exit(0)`、Windows 的 `restart()`)都退得出去,不必担心与防退出打架。
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
- **「有可用更新」按逐技能内容指纹判定,绝不用整库 HEAD sha**(2026-08-03 用户实测缺陷):
  `store.rs` 建索引时对每个技能目录的压缩包条目算 `content_hash`,与安装后
  `fsops::dir_content_hash(canonical)` **必须逐字节相等**——两侧共用
  `fsops::ContentHasher` 与 `is_excluded_rel`,有测试钉住这条等式。等式一破的表现是
  界面永远显示"有更新"(比没有这个功能更糟)。曾经比的是 `commitSha != index.commitSha`,
  于是**别人分享任意一个技能都会让全部已装技能同时亮"有更新"**。
  判定只有一处实现:`src/lib/update.ts` 的 `cardState`/`remoteHashOf`,商店卡片、
  详情面板底部、我的技能三处共用——各写一份正是缺陷温床(详情面板曾只认两档,
  于是卡片显示"更新"、点进去按钮是禁用的「已启用」,点了没反应)。
  任一侧指纹为空时按"没有更新"处理:宁可漏报,不误报。
- **索引缓存版本现在是 3**,而**往索引里加"从压缩包解析出来的新字段"必须升它**
  ——2 是逐技能指纹(旧缓存没有它,判定会退化成"未知"),3 是 M7 的 `attribution`。
  **判据不是"数据会不会变",而是"建这份缓存的代码有没有解析它的能力"**:
  `refresh_index` 只比 `commit_sha == head.sha`,head 只反映数据新鲜度。
  ⚠️ M7 起初按 tags 的先例判断"不用升版本"(理由:authors.json 改动必伴随库提交、
  head 一变缓存即重建),**2026-08-07 真机推翻**:authors.json 先提交进库,用户机器上
  **还没升级的旧版本**用最新 head 写了一份没有归因的缓存;0.3.8 装上后 head 比对相同
  → 永远命中那份缺字段的缓存 → 作者栏永不出现。手动「重新获取」(force=true)能出来,
  正说明数据与解析都没问题、只是缓存挡着。tags 那条推理只在"数据后于代码到达"时成立,
  这次是**数据先于代码**。守卫:`changing_the_cached_skill_shape_forces_a_version_decision`
  断言 `IndexedSkill` 序列化后的**完整键集合** + 当前版本号,加字段时当场变红
  (注入验证过:只断言"某个键存在"会放过新增字段,等于空转)。
- **作者/贡献者来自库根 `authors.json`,不是现场归因**(M7 任务 1–3,推翻了
  "商店卡片上没有作者"的旧结论):frontmatter 没有作者字段,逐技能问 commits 接口
  又撑不住首屏 <2s——M7 的解法是 tags.json 同款的库侧静态文件
  (`scripts/gen-authors.mjs` 从 git 历史生成:作者 = 最早提交人,贡献者 = 其余提交人
  按次数降序),App 只读展示、**零新增请求**。
  没有条目整栏不摆(卡片与详情都是)——仍然**不编造**。
  (缓存版本**已随它升到 3**;起初判断"不用升",发版后被真机推翻,见上一条。)
  **归因由分享链路自动维护**(M7 任务 5,`share.rs` 的 `attribution_file_change` /
  `upsert_attribution`):新增分享记分享者为 author(展示名 full_name 优先、空则 login,
  用户拍板),更新/覆盖他人技能追加进 contributors;**已有条目的 author 绝不改写**;
  修订与技能文件在**同一笔提交**里,走评审随分支合并才生效;身份/文件读不到、
  文件形状不对 → 跳过维护**绝不拦分享**(锦上添花不挡正事)。GitHub 臂刻意不做。
  - **blob sha 不跨仓通用**:归因的 sha 必须按**实际提交目标仓**取——只读用户走 fork,
    拿上游的 sha 往 fork 上 update 会得到 `404 object does not exist`,**整笔提交连技能
    文件一起失败**,只读用户分享必然报错。这条假设是 `share_live` 的 fork 用例当场
    证伪的(本地起着 docker Gitea 才跑到),纯逻辑与 wiremock 测试都看不见跨仓这回事。
    因此追加归因的位置在 `submit_gitea` **内部**、三条路各自取自己的目标仓。
  - **「归因绝不拦分享」必须在提交边界也成立**(`change_files_sparing_skill`):
    Gitea 多文件提交是原子的,authors.json 现在**每次分享都写**,两个人同时分享
    **不同**技能也会撞在这一个文件的 blob sha 上——归因一条过期就把技能文件一起
    拖垮,用户看到的是一句与归因毫无关系的冲突错误、分享根本没进去。
    所以提交被拒时**剥掉归因重试一次**(`REPO_FORBIDDEN` 除外,那是分支保护、
    调用方要据此降级)。归因丢了下次分享补上,用户的技能必须进得去。
  - **判定"是不是同一个人"要比别名**(展示名 + 登录名):存量 authors.json 按 Gitea
    **登录名**记(初版手工填的、gen-authors 从 git 历史算的都是),而 App 用 full_name
    ——只比展示名的话,作者本人一分享就把自己追加进自己的 contributors。写进文件的
    永远是展示名,别名只用于比对。
  ⚠️ gen-authors.mjs 是**一次性引导/修复工具**:按 git 历史整份重算,会把代传技能
  算到上传者头上、冲掉 App 维护的语义数据——产出须人工核对,App 接管后别定期跑
  (最初设想的 Actions/cron 自动化已废弃,理由之一:内网技能库 runner 实测为 0)。
  安装量仍没有(C5 预留,埋点服务落点未定)。
- **UI-Demo 的分类 chip 换成了"全部/未安装/已安装"**:SKILL.md 里没有分类字段,
  硬造分类等于在界面上撒谎。要分类得技能库侧先约定 frontmatter 字段。
- **「我的技能」有三档,`installed_list` 返回的不等于 `state.installed`**(M4 任务 6a)。
  这一页的语义是"这台电脑上我拥有的技能",不是"本 app 记了账的东西":
  1. 从技能库获取的(`state.installed`);
  2. 别的工具装的、未认领的(判据是 `.skill-lock.json` 里有条目);
  3. **本地技能**——canonical 下有 SKILL.md 的实体目录,前两档都不属于。
     发现逻辑复用 `share::scan_candidates`(取 `in_canonical && origin == Local`),
     **不另写扫描**;agent 目录里的不算(那些归分享页收编)。
  第三档没有来源、没有关联记账,所以**更新 / 修复关联 / 分享改动 / 移除一概不摆**,
  `hasUpdate` 也**显式判掉**(不靠"空 registryId 恰好对不上 index"碰运气)。
  **`install.ts` 的 `refreshInstalled` 必须排除第 2、3 档**:混进那张 map,商店里的
  同名技能会显示「已启用」——用户装的是自己那个,不是库里这个。
- **认领是纯记账,取消认领也必须是纯记账**(M4 任务 6a):`claim` 全程只调一次
  `save_state`,磁盘/npx 建的链接/lock 一个字节不动。在 `unclaim` 存在之前,认领后
  唯一的退路是「移除」,而移除会解链 → 删本体 → **从 lock 删条目**——用户点一个
  零副作用的动作,反悔时唯一的按钮会把技能从 npx skills 那边一并毁掉。
  判据是 `InstalledSkill.origin`(`claimed`/`acquired`,serde default 不升 schemaVersion),
  存量条目 fallback 到 `commit_sha.is_empty()`(已实证 `state.installed` 全仓只有两处
  写入,只有 claim 留空 sha)。**保守方向:拿不准就当"获取来的"不许取消**。
  比测试更硬的保障是签名——`unclaim(store, dir_slug)` 没有 `Installer` 也没有
  `AgentEnv`,结构上拿不到 canonical 路径与 lock 落点,动不了磁盘。
- **本地技能变更的三级刷新**(M4 任务 6c):
  1. 窗口重获焦点(`hooks/useLocalRefresh.ts`,只刷当前页,用 ref 存页面避免重复注册);
  2. 切页(页面组件挂载时 load,有测试钉住,不再是"靠组件重挂"的巧合);
  3. 文件监听(`core/watcher.rs` + `commands::spawn_watcher`)。
  **级别 3 的头号风险是它会对本应用自己的写入触发**:`Installer::install` 是清空重建,
  监听器在那期间上报会让前端读到技能凭空消失的瞬间;防抖救不了(一次安装比任何
  合理的防抖窗口都长)。靠 `watcher::app_write()` 这个 RAII 守卫 + 800ms 静默期,
  **加在 core 层而不是 commands 层**——scheduler 的自动更新不经过 commands,
  commands 不是真咽喉。四个写盘入口:acquire / acquire_batch / remove / create_skill。
  判定放在防抖**吐出来的那一刻**(记录事件时还不知道这批是不是自己造的)。
  其余:只盯 canonical(agent 目录由别的工具主动写,递归监听只换噪音);
  canonical 不在就盯父目录、父目录也不在就不起监听(**绝不创建用户没要求的目录**);
  起不来只记日志不拦启动。**不给 CI 加时序测试**——FSEvents 与 ReadDirectoryChangesW
  的合并策略各不相同,断言"N 毫秒内到达"等于埋定时炸弹;测纯逻辑,OS 集成交给启动冒烟。
  ⚠️ `watcher::now_ms()` **永不返回 0**(+1):0 是 `should_report_at` 里"从未写过盘"的
  哨兵。曾经不加这个 +1,于是 `OnceLock` 首次调用返回 0、`LAST_WRITE_END_MS` 初值也是 0,
  `0 - 0 >= 800` 为假——**第一次外部文件变更必然被吞掉**;而守卫 drop 时若拿到 0
  又会把自己的静音取消掉。两面都是真机验证才抓到的,纯逻辑单测直接传参走不到那条路。
- **新建技能只创建文件**(M4 任务 4,`core/create.rs` 模块头):落 canonical 的
  `<slug>/SKILL.md` 一个文件,**不建关联、不写 lock、不进 `state`**——对齐上游
  `npx skills init`(它同样只产出这一个文件、同样不写 lock)。新建的技能靠
  `share::scan_candidates` 的排除法出现在分享页,那是它唯一的出路;进了
  `state.installed` 就从候选里消失,而且会让 `acquire::precheck` 撒谎(见「待处理」里
  那条推迟项)。三种撞名(canonical 目录非空 / installed 同名 / shared 同路径)一律拒,
  **空目录放行**(写 SKILL.md 失败会留空壳,一律拒等于同名再也建不成)。
- **slug 的口径只有一份真相:`fixtures/slug-samples.json`**。判据是 `sanitize_name` 的
  **不动点**(填什么就得到什么),不是"看起来像 kebab"。core 侧 `create::usable_slug`
  与前端 `lib/slug.ts` 各有一条测试读**同一个文件**——手抄两份样本表的话,口径漂了
  两边照样各自全绿,那道护栏就是空转的(空转测试模式 #1)。
  前端原先那个正则 `/^[a-z0-9][a-z0-9._-]*$/` **已实测不准**:放行 `a--b`(折成 `a-b`)、
  `trail-`(trim 成 `trail`)、超 255 字符(截断),按它放行就是静默改名,已修。
- **写 frontmatter 时值要不要加引号,交给 YAML 解析器自己判定**(`create::yaml_scalar`):
  裸写一遍再读回来,读到的不是等值字符串才加引号。手写"危险字符表"必漏,而且会猜错——
  实测 saphyr 走 YAML 1.2 core schema,`yes`/`no` 裸写就是字符串(YAML 1.1 才当布尔),
  但 `123`/`3.14`/`null`/`~`/`&anchor` 会走样。往返测试是唯一可靠的护栏。

### 待处理

**下阶段候选(2026-08-12 用户点名保留,⚠️ 留给下次会话头脑风暴,别在这里替它做设计)**

这两条只登记诉求,**不含方案**——用户明确说了"这些都留给下次会话头脑风暴,不在此讨论,
保留空间"。下次动它们时先走 brainstorming,别把下面这几行当成已拍板的方向。

1. **技能装到指定项目里,不只是全局**。现在全链路只有 canonical 全局目录一条路
   (`~/.agents/skills/` + 按目录建链),"装到某个项目下"整个不存在。
   已知会牵动的面(仅供估量,不是方案):`installer` / `state.installed` 的记账粒度、
   `.skill-lock.json` 的落点(上游对项目级有自己的约定,**先去录 ground truth**)、
   `installed_list` 的三档语义、卸载与更新要按哪个作用域走。
2. **调查 `npx skills find` 有没有开放 API,能否接进商店与公司技能库并存**
   (互为补充,不是替换)。没有 API 的话还有没有别的路子。
   ⚠️ 这条**先做调查再谈接入**:结论可能是"做不了"或"代价不值",
   调查本身就是交付物。注意铁律 2(禁 git2/嵌入式 git)与"前端不发 HTTP"仍然适用,
   外网请求属于**必须停下来问用户**的那一类新增行为。

**功能缺口**
- **存量 lock 条目仍是旧形状**(M6 任务 6 顺带发现,不打算修):`sourceUrl` 的写入已
  改成完整 URL,但 v0.3.0 之前装的技能,lock 里留的还是 `"owner/repo"`。它们的
  「纳入管理」只能退回按 owner/repo 唯一匹配那条弱判据(同源判据用不上)。
  重新获取一次就会被覆写成新形状,不值得为它写迁移。
- **`.DS_Store` 会参与 `dir_content_hash`**(M4 任务 6c 顺带发现,未修):
  `fsops` 的排除名单只有 `metadata.json` / `.git` / `__pycache__` / `__pypackages__`。
  于是在访达里打开过某个技能目录、macOS 生成 `.DS_Store` 之后,该技能的内容 hash
  就变了,界面会显示「你改过这个技能」,更新时还会弹冲突对话框问要不要保留改动。
  **不要顺手改名单**:排除项一变,所有已装技能的 hash 都会变,全部误报「有更新」
  ——那比当前的问题更糟。要修得连带设计一次"hash 口径升级"(比如记 hash 版本号,
  版本不符时按"未知"处理而不是按"有更新")。同一份名单还被
  `store.rs` 建索引时用着,两侧必须同时改,否则等式一破就永远显示有更新。
- **给本地技能建关联的能力仍然没有**(M4 任务 4 显式推迟,不是遗漏):
  新建的技能只落 canonical,`skillsDir` 等于 `.agents/skills` 的工具(Cursor / Codex /
  universal 那六个)立刻读得到,**Claude Code 与 Trae 读不到**,要走「分享到技能库 →
  从商店获取」才能用上。这条限制对**所有**本地技能都成立(用户手放的、npx 装的一样),
  不是向导造出来的。补它需要一处能记链接的账:`link_agents` 硬要 `state.installed`
  有条目,而把无来源的技能塞进 `installed` 会让 `acquire::precheck` 撒谎
  (空 owner 必然不等于商店的 owner → 同名技能的卡片说「装自另一个技能库」)。
  真要做,得加一档 `Precheck` + 一个 `localOnly` 标记 + 放宽 `share::scan_candidates`
  的排除条件 + 审一遍 scheduler / share_installed / installed_repo_key / remove / repair,
  是 M4 任务 1 那个量级,不该塞进脚手架任务里。
- **Windows 外观打磨决定不做**(M2 任务 6 的判断):UI 规范 §75 要 tauri-plugin-decorum,
  但没有 Windows 真机,装上等于把能用的系统窗口装饰换成无法目视验证的自绘控件——画不出
  窗口控制的话用户连关窗都做不到,而关窗现在还接着"缩到托盘"。等有真机再做,连同 vibrancy。

**只能在真机/真实环境验的**
> ⚠️ 下面前三条(Windows 真机 / cfg(unix) 测试 / Windows GUI)**已归入 M8**,
> 见 docs/M8-任务分解.md 任务 3;它们欠的不是代码,是一台 x64 Windows 机器。
> Windows 发布链路的两个缺口(latest.json 无 windows 条目、发版脚本只发 macOS)
> **已于 M8 任务 1-2 补齐并真发版实证**(2026-08-07,v0.3.10):CI 出 exe →
> 本地补签 → 三平台公告牌,守卫在
> `bundle_config.rs::publish_script_feeds_all_three_platforms`。
> **仍欠的是 Windows 侧的自更新整跳**:0.3.10 是首个 Windows 包,老版本根本不存在。
> **v0.3.12 与 v0.3.13 已于 2026-08-11 先后发出**(0.3.12 含"下载好再等用户点"的修复),
> 条件到此备齐,而且第二跳现在有**两次**机会(0.3.11→0.3.12→0.3.13,走通任意一跳都算数)。
> 但**这一跳有没有跑通仍未知**,要用户在 Windows 真机上看:
> pill 出现 → 点了才装 → 应用不再自己退出。
> (macOS 侧同一条链路 2026-08-11 当天真机走通两次:0.3.11→0.3.12、0.3.12→0.3.13,
> 日志四行齐全——但那证明不了 Windows,两个平台的"装好"根本不是一件事。)

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
- **任务 8 的性能数字来自 loopback docker,不是内网真机**:53 个技能冷启动 76.6ms、
  缓存命中 28.1ms(`cargo test --test store_live -- --nocapture`),远低于 DoD 的 2s/300ms,
  但真实内网要加网络往返与更大的压缩包。`tests/store_index.rs` 的 300ms 断言跑在 wiremock 上、进 CI。
- **正式分发的外部条件**(完整清单见部署指南 §6):macOS 侧(证书+公证+发布+自更新)
  **已全部跑通**(见下);仍缺 Windows 内部 CA 签名或 IT 软件中心白名单、
  干净双平台真机 ≤5 分钟验收。

### 发版:一条命令(2026-08-06 起;macOS 全链路已跑通并验证自更新)

证书 `Developer ID Application: Wenhao Zhao (79H4J7GB4N)`;凭证在
`fixtures/.env.apple.local`、发布仓令牌在 `fixtures/.env.release.local`
(`*.local` 已被 .gitignore 排除,权限 600)。minisign 密钥对在 `~/.tauri/skillsync.key`
(**丢了这批已发出去的包永远收不到更新**)。更新源 = 内网 Gitea 发布仓
`skills/skillsync-releases` 的固定 `latest` 标签(URL 因此恒定)。

**发版前必须先写发版说明**(2026-08-07 用户拍板,指定记进项目记忆):
在 `RELEASE_NOTES.md` 顶部加一段 `## <版本号> —— 一句话主题`,写给**使用者**看
(改了什么、他们会看到什么变化,不写内部实现)。**没有这一段脚本会拒绝发布**
——此前所有 release 的正文都是脚本里写死的同一句"内部发布",同事拿到新包
不知道该不该升。这份文件是**发版说明的唯一真相**:内网 release 的 body 与
README 的版本历史都从它来,不手抄第二份。README 的「版本历史」一节也要同步。

**发版 = `./scripts/publish-release.sh <版本号>`**(完整环境变量与一次性准备见
部署指南 §7.4)。它包办:改三处版本号 → **commit + tag + push**(tag 触发 GitHub CI
出 Windows 包,与本地构建并行;版本号必须先进 tag,这步没法留给人)→ 本地构建
macOS(签名+公证)→ 打 dmg → 等 CI → 下载 exe 本地补签(私钥不进公开 CI)→
建版本 release 传五个产物 → 重建**三平台** latest 公告牌 → curl 验收 →
**同步 README.md + RELEASE_NOTES.md 到发布仓**(2026-08-11 加:发布仓首页是同事
下载安装包时唯一会看到的说明,此前一直是建仓那句空壳;两个文件走一笔提交,
README 里指向 RELEASE_NOTES 的相对链接才不是死链;开发者文档链接改写成公开仓绝对地址;
失败只警告不让发版非零退出)→ 清理公开 CI artifact → 回收 Rust 孤儿产物
(`cargo sweep --maxsize 20GB`,单位默认 MB、PATH 收项目目录,两个坑见脚本注释)。
版本号 commit 已由脚本推送,跑完不用再手动 commit(但 **Cargo.lock 每次都会剩一笔**,
脚本只 add 三个版本号文件)。应急开关 `SKIP_WINDOWS=1`
只发 macOS(公告牌将没有 windows 条目,Windows 用户收不到那版更新)。

**已实测的发布终态**(2026-08-06):发布仓有 v0.2.1/v0.2.2,latest 公告牌指向 0.2.2;
**自更新端到端第一次真跑通**——0.2.1 检出 0.2.2 → 下载验签安装 → 重启后版本变了
(日志 `应用更新已安装,等待重启生效 version=0.2.2`)。

**改这三个脚本前必须知道的五个坑**(都已修在脚本里并写了注释):
1. **构建期需要 updater 公钥**,编译期常量不顶用——签名发生在构建那一刻,
   tauri 读的是 `plugins.updater.pubkey`,而主 conf 里按铁律 5 只有空占位。
   现从环境变量拼进 `--config`。CI 的 `release.yml` 同理(它当时也漏了)。
2. **tauri updater 默认拒绝 http 端点**,而内网 Gitea 就是 http:不在构建期 overlay 里
   开 `dangerousInsecureTransportProtocol`,`endpoints()` 直接报错、**一个请求都不发**,
   还被 `update_err` 包成 `NET_UPDATE`"请确认已接入公司内网"——一个配置问题
   披着网络问题的皮。**v0.1.0 与第一版 v0.2.0 都带着这个缺陷发了出去**(v0.2.0 已下架),
   靠自更新端到端实测才抓到。完整性由 minisign 验签兜底,明文传输在内网可接受。
   `tests/bundle_config.rs` 现在钉住两条发布通道都要有它。
3. **不能让 tauri 打 dmg**:它的 `bundle_dmg.sh` 在造好 dmg **之后**才调
   `hdiutil internet-enable`(macOS 10.15 已移除),非零退出 + `set -e` → tauri
   判定失败并**清理整个 bundle 目录**,把刚公证好的 .app 一起删掉。
4. `codesign -dv` **不打印 Authority 行**,判签名要 `--verbose=2`。
5. `cmd | grep -q` 配 `set -o pipefail` 会因 SIGPIPE 拿到 141;
   `spctl` 不带 `-vvv` 成功时**一个字都不打印**。两者都会把好包判成坏包。

**分发只发 dmg 或 release 页链接,绝不用 IM 直接发 `.app`**(2026-08-07 踩过):
`.app` 是目录包,IM 传输会压缩再解压,可执行位/符号链接/扩展属性丢失 → 签名失效 →
「应用程序"SkillSync"无法打开」。同一版本从 release 页下载的一切正常。
**排查"只有我这台能打开"时先问传的是哪个文件**——那次把包本身、签名、公证票据、
universal 双切片、minos、动态库依赖、下载文件 sha256 全验过一遍都合格,根因在传输方式。

**苹果公证偶发超时**(`HTTPClientError.deadlineExceeded`)不是脚本缺陷,重跑即可
——已编译产物会复用,第二次快得多。

**本机环境**
- Rust 走镜像:`RUSTUP_DIST_SERVER` 用清华、crates.io 用 rsproxy(已配在 `~/.cargo/config.toml`);
  `~/.cargo/bin` 不在非交互 shell 的 PATH 中,跑 cargo 前需 `export PATH="$HOME/.cargo/bin:$PATH"`。
- Node 版本以 `.nvmrc`(22,与 CI 一致)为准;本机 Homebrew 的 node 已升到 26。
  Node 26 在 globalThis 上自带 localStorage accessor(getter 返回 undefined),曾让 45 个
  前端测试假红而 CI 全绿——`src/test/setup.ts` 已补内存级 shim 兜底,任何 Node 版本都能跑,
  但日常仍建议 `export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"` 与 CI 对齐。
- vitest 与 cargo test **别并发跑**:互抢 CPU 会让 vitest 的 5 秒超时用例偶发假红
  (实测 environment 阶段被拖到 566s)。
