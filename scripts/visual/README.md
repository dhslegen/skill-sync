# 视觉走查 harness(v7.1 任务 2)

把界面**真的渲染出来**、截成图,好和设计画布并排看。

## 为什么有它

v7 九个任务、每个都有独立审查、都通过了,真机走查仍然发现大量与设计稿的偏差
(卡片 vs 一行字、chip vs 文字链、横排 vs 竖排、按钮在中间 vs 在页脚)。根因是
**整条链路上没有任何一个环节把"渲染出来的样子"和设计稿放在一起看过**:实现者拿到
的是文字转述,审查者拿到的是 diff,而 jsdom 里
`toHaveTextContent("各个工具里")` 对"横向 chip 流"和"竖排带路径清单"**同样通过**。

这个 harness 就是那个缺失的环节。

## 怎么跑

```bash
node scripts/visual/shoot.mjs --out /tmp/shots
```

参数:

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--out <目录>` | `<repo>/.visual-shots` | 截图落点。**建议显式传一个 scratchpad 目录**,别把 png 留在仓库里 |
| `--port <n>` | `5199` | dev server 端口(`--strictPort`,占用即失败,不静默换端口) |
| `--only <id,id>` | 全部 | 只跑指定的几屏,调某一屏时省时间 |
| `--headed` | 关 | 开一个看得见的浏览器窗口,用来手动确认交互步骤对不对 |

跑完除了 png 还会写一份 `index.json`(时间、视口、每屏的标题与路径、页面报的错)。

它自己起 `pnpm exec vite`(**纯前端 dev server**,不是 `pnpm dev` —— 后者会把整个
Tauri 一起起来,要内网配置且慢得多),跑完 `SIGTERM` 掉。

### 前置条件

- **本机装了 Google Chrome**。脚本用 `channel: "chrome"` 驱动它,**不下载任何浏览器
  二进制**(Playwright 自带的 chromium 要几百 MB)。没有 Chrome 的机器上会报
  `Chromium distribution 'chrome' is not found`,那时才需要商量装浏览器。
- `playwright-core` 是 devDependency(只是驱动库,没有下载浏览器的 postinstall)。
- 脚本给 Chrome 传了 `--no-proxy-server`:开发机上常年开着 HTTP 代理
  (`http_proxy=http://127.0.0.1:7890`),不加这个参数,Chrome 会把 `127.0.0.1:5199`
  也交给代理,拿回 502。同理 vite 显式 `--host 127.0.0.1`(默认只绑 `localhost`,
  在 macOS 上优先解析成 `::1`,Chrome 走 IPv4 会 `ERR_CONNECTION_REFUSED`)。

## 怎么加一屏

改 `shoot.mjs` 里的 `SCREENS` 数组,加一个条目就行:

```js
{
  id: "30-projects-something",          // 也是文件名
  title: "「项目里的技能」· 某一屏",      // 只进 index.json 与控制台
  viewport: { width: 1200, height: 1200 }, // 可选,默认 1200×1000(= 画板尺寸)
  async run(page, ctx) {
    await ctx.gotoProjects(page);       // 等到真有一行渲染出来才算到了
    await page.getByTestId("prow-weekly-report-body").click();
  },
}
```

（「项目里」自 v7.3 起是独立一页 `nav.projects`「项目里的技能」，不再是「我的技能」
下的页签；`ctx.gotoMine` / `ctx.gotoProjects` / `ctx.openStoreDetail` 三个入口都等一个
**只有有数据才会出现**的元素，别再用"点一下侧栏 + 睡 400ms"那种写法。）

约定:

- **`run` 只做导航与交互,不截图**。截图、命名、缩放(`deviceScaleFactor: 2`)、
  焦点环清理由外层统一做,这样每一屏的口径一致。
- 定位优先用 `data-testid`(行是 `row-<dirSlug>` / `row-<dirSlug>-body`)与
  `getByRole`,别按 class 找 —— class 正是这几个任务要改的东西。
- 等待用 `waitFor`,别用 `waitForTimeout` 猜(现有几处 `waitForTimeout` 是给
  动画/过渡留的,不是等数据)。

## fixture 在哪改

`scripts/visual/fixtures.mjs`,**一份数据派生出两侧**。

`SKILLS` 那张表是唯一的真相:每一行写清 `section`(落哪个区)、`contentHash`
(安装基线)、`remote`(库里那一版的指纹)、`localModified`,脚本据此同时生成
`installed_list` 与 `store_index` 两份响应。

🔴 **别把两侧分开手写**。一行摆哪颗按钮是这两份数据比对出来的
(`store/my-skills.ts::hasUpdate` → `lib/ownership.ts::rowAction`),只要
`dirSlug` 拼错、或 `registryId`/`sourceOwner`/`sourceRepo` 与索引对不上,那一行就
**静默**退回「没有更新」——截图看着像界面缺陷,其实是 fixture 自己不自洽。

想让某一行落到某个档:

| 想要的档 | 怎么写 |
| --- | --- |
| 「更新」 | `section: "installedFrom"`,`remote` ≠ `contentHash`,`localModified: false` |
| 「库里有新版…」(conflict) | 同上但 `localModified: true` |
| 「贡献更改」 | `remote` == `contentHash`,`localModified: true` |
| 无主按钮 | 两者相同且 `localModified: false` |
| 「分享改动」 | `section: "sharedTo"`,`localModified: true` |
| 「分享」 | `section: "shareable"` |
| 分享被拦 | `section: "shareable"` + `shareBlocked: "nameMismatch"` |
| 「审核中」 | `section: "shareable"` + `review: { url: "..." }` |
| 「可分享到」区的「更新」 | `section: "shareable"` + `source`(外部源坐标)+ `externalRemote` ≠ `contentHash`,并且截图前要**点开这一行**(见下) |

两个容易踩的点:

1. **`section` 与 `relation` 必须成对**(core 侧是 `ownership::section(relation)` 的
   一一映射:installed→installedFrom / shared→sharedTo / draft→shareable)。
   fixtures 里由 `RELATION_OF` 保证,别绕过它直接塞 `relation`。
2. **「可分享到」区外部来源的索引,只有点开那一行才会去取**
   (`ensureShareableIndexes`:翻页本身不发请求)。所以 `01-my-skills` 那一屏
   先点一下 React 那行再 `Escape` 关掉,截出来的才是用户真正看到的样子。

未覆盖的 command 会被 mock **拒绝**并打进控制台(`MOCK_MISSING: …`),脚本收尾时
汇总打印。**不要**把默认分支改成回一个空对象——那样界面会画出一屏看起来像应用缺陷
的空白,而真正的原因只是 fixture 少了一条。

## 注入点(为什么 `src/` 一行没改)

`src/lib/ipc.ts` 是与 core 的唯一通道,它经 `@tauri-apps/api` 调用,而那个包最终
只碰两个全局对象:

- `window.__TAURI_INTERNALS__` —— `invoke` / `transformCallback` /
  `unregisterCallback` / `convertFileSrc` / `metadata`
- `window.__TAURI_EVENT_PLUGIN_INTERNALS__` —— `unregisterListener`
  (`listen()` 返回的 unlisten 走这条,漏了会在卸载时抛异常)

`mock.mjs` 用 Playwright 的 `addInitScript` 在**页面任何脚本之前**装上它们
(`page.evaluate` 事后补来不及:`@tauri-apps/api/core` 在模块求值时就会读)。
所以生产代码里没有任何"测试专用分支"。

事件通道(`plugin:event|listen` / `unlisten`)只是**接住不报错**,不会真的派发
事件——`scheduler://report`、`app-update://ready`、`local-skills://changed`
这几条链路在 harness 里是死的。

## 🔴 送审截图必须覆盖**最宽 / 最密**的那一档

2026-09-10 一天之内犯了两次，两次都是用户或顾问替我们抓的：

1. 页脚那一屏送审时主按钮是「**更新**」（2 字 ≈55px），恰好放得下；真机上主按钮是
   「**已在电脑上**」（5 字 + 绿勾 ≈100px），五个元素合计约 472px > 页脚可用的
   440px（面板固定宽 `480px`），`flex-wrap` 把「…」挤到第二行，用户原话"白折叠了"。
2. 确认条那一屏 fixture 只有 **2 个**可选工具；用户真机是 **9 个**。等于拿一张
   **不含故障密度**的图去请求批准。

**判据**：一屏若有随数据变宽/变多的元素（按钮文案随状态变、列表随探测结果变），
送审前先问一句「**我截的是不是最挤的那一档**」。不是就换一档，或加一屏专门截它
（见 `21-detail-store-footer-widest`）。

## 🔴 这个 harness 证明不了什么

**先读这一条（v7.7 复审加，0.6.x 已填）**：`project_list` 曾经是 `[]`，「项目里的
技能」整页在 harness 里因此永远是空态——v7 任务 8（项目页签）与 v7.6 的项目行菜单
从未被截图验证过，而每一轮报告里"截图全部正常产出"都是真的，**空页也能截**。
0.6.x 起 `fixtures.mjs` 有了 `PROJECTS` 表（五种档：正常 / 目录不在 / 只读 / 空项目 /
单技能），24–29 六屏与「在哪」第四块「项目里」（28）都在它之上；`ctx.gotoProjects`
等的是真的有行渲染出来，fixture 若再退回空数组那几屏会**红**。留下这段是为了教训本身：
**"跑了截图"不等于"截到了东西"**，加一屏时先确认它的 fixture 真的有数据，并让 `run`
等一个**只有有数据才会出现**的元素。

⚠️ 顺带一条：24/25 起有了**带断言**的屏（几何断言、行为断言），一屏抛错不再中止整轮
——记进 `problems`、照样截图、其余屏继续、收尾非零退出。看到 `run failed` 先看那张图。



按本项目的规矩(「守卫是烟雾报警不是防火墙,文档必须如实写明它挡不住什么」),
下面这些**不在覆盖范围内**,截图绿了不代表它们没问题:

1. **渲染引擎不是真机的那个。** 这里是 macOS 上的 Chrome(Blink);应用里是
   **WKWebView**。字体渲染(字重、抗锯齿)、滚动条、`-webkit-` 前缀行为、
   窗口装饰都可能不同。**像素级的字重/间距差异必须以真机为准。**
2. **core 的行为完全没被覆盖。** IPC 返回值是手写的,`skill_set_agents` 到底
   会不会失败、`converge` 会不会走到 `Differs`、废纸篓能不能删——一个都没验。
   本项目吃过的亏正是这一类:jsdom 里 mock 掉 invoke,永远拿不到 core 的拒绝。
3. **fixture 是**手抄的形状,**没有被 `tsc` 检查过。** `scripts/` 不在 `tsconfig`
   的 `include` 里(这也正是它不打扰五道闸的原因)。`InstalledSkillView` 之类的
   DTO 一旦改字段,harness **不会报错**,只会安静地渲染出一个过时的状态
   ——**截图会撒谎**。改 core DTO 时要顺手把这里对一遍。
4. **跑的是 vite dev 构建**,不是打包后的应用:没有 Tauri 的 CSP、没有 asset
   协议、没有窗口拖拽区的真实行为。
5. **只有浅色主题、只有 1200 宽这一档、只有中文**。深色主题、窄窗口、系统跟随
   主题都没截。要看深色就再加一屏(`colorScheme: "dark"`)。
6. **交互只走了脚本写死的那几步**。键盘可达性、焦点顺序、IME、右键菜单一概没碰
   ——那些仍然是 vitest 用例的活,截图看不出来。
7. **`01-my-skills` 的视口比画板高**(1760 vs 1000)。同样十二行,画布装得下、
   当前实现装不下,这本身就是一条待校准的密度差——并排比密度时别忘了这个差别。
