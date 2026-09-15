#!/usr/bin/env node
// 视觉走查 harness 的入口(v7.1 任务 2)。
//
//   node scripts/visual/shoot.mjs [--out <目录>] [--port 5199] [--headed] [--only <id,id>]
//
// 起一个**纯前端** vite dev server(不是 `pnpm dev`——那会连 Tauri 一起起,
// 需要内网配置且慢得多),用本机已装的 Chrome 打开它,把 IPC 换成
// `scripts/visual/fixtures.mjs` 的假数据,逐屏截图。
//
// 🔴 它证明不了什么,见 README「这个 harness 挡不住什么」一节——那不是免责声明,
// 是使用前必须知道的边界。
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { buildFixtures } from "./fixtures.mjs";
import { installTauriMock } from "./mock.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// ---------------------------------------------------------------- 命令行参数
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT = path.resolve(arg("out", path.join(ROOT, ".visual-shots")));
const PORT = Number(arg("port", "5199"));
const HEADED = process.argv.includes("--headed");
const ONLY = arg("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------- 屏幕清单
//
// **加一屏 = 往这个数组里加一个条目**,不用改别的地方。
// `run(page, ctx)` 里做导航与交互,截图由外层统一负责(名字、缩放、路径一致)。
const SCREENS = [
  {
    id: "01-my-skills",
    title: "「我的技能」·「安装自技能库」页签(v7.2 需求 1:三区改页签)",
    viewport: { width: 1200, height: 1000 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
    },
  },
  {
    id: "01b-my-skills-shared-to",
    title: "「我的技能」·「已分享到技能库」页签",
    viewport: { width: 1200, height: 1000 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByRole("tab", { name: /已分享到技能库/ }).click();
      await page.waitForTimeout(200);
    },
  },
  {
    id: "01c-my-skills-shareable",
    title: "「我的技能」·「可分享到技能库」页签(v7.2 需求 4:按来源分组)",
    viewport: { width: 1200, height: 1000 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByRole("tab", { name: /可分享到技能库/ }).click();
      // 外部来源那两行的名字与「有没有新版」来自它们自己的来源索引,而那一趟
      // 请求**只有点开这一行才会发**(store/my-skills.ts 的 ensureShareableIndexes)。
      // 先点一下再关掉,截出来的才是用户真正会看到的那一行。
      await page.getByTestId("row-react-best-practices-body").click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    },
  },
  {
    id: "02-detail-top",
    title: "详情面板 · 顶部(「在哪」三块的现状)",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-code-annotator-body").click();
      await page.waitForTimeout(500);
    },
  },
  {
    id: "03-detail-bottom",
    title: "详情面板 · 滚到底(固定页脚;正文滚动不影响它)",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-code-annotator-body").click();
      await page.waitForTimeout(500);
      await ctx.scrollPanelToBottom(page);
      await page.waitForTimeout(300);
    },
  },
  {
    id: "04-detail-where-expanded",
    title: "详情面板 ·「在哪」折叠头展开态(本体住在工具目录里)",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-code-annotator-body").click();
      await page.waitForTimeout(500);
      await page.getByTestId("where-toggle").click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "05-detail-canonical-collapsed",
    title: "详情面板 · 本体住统一技能目录(canonicalReaders 那一档)· 收起态",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-api-test-expert-body").click();
      await page.waitForTimeout(500);
    },
  },
  {
    id: "06-detail-canonical-expanded",
    title: "详情面板 · 本体住统一技能目录 · 展开态(任务 4 要改的就是这一屏)",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-api-test-expert-body").click();
      await page.waitForTimeout(500);
      await page.getByTestId("where-toggle").click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "07-detail-canonical-readers",
    title: "详情面板 · 本体住统一技能目录 ·「…」展开(这台电脑上读这个目录的工具)",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-api-test-expert-body").click();
      await page.waitForTimeout(500);
      await page.getByTestId("where-toggle").click();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "哪些工具" }).click();
      await page.getByTestId("where-readers").waitFor({ state: "visible" });
    },
  },
  // ---------------------------------------------------------------- 终审修复波
  // 🔴 08/09 是 I-2 要看的两屏:任务 4 把共享常量 `LIST_ROW_EXTRA` 从
  // `border-t … px-3 py-2 … hover:bg-surface-2` 压成 `py-1.5`,而**只有这两个
  // 调用方**把 `ToolPicker` 包在带边框的盒子里、横向留白原本全靠那个 `px-3`。
  // 四个调用方里另外两个(详情面板「各个工具里」、项目行改选)是裸清单,不受影响。
  {
    id: "08-install-agent-chooser",
    title: "商店 · 获取时的工具多选(I-2:带边框盒子里的 ToolPicker)",
    async run(page, ctx) {
      await ctx.openStoreDetail(page, "安全评审清单");
      await page.getByRole("button", { name: "安装", exact: true }).click();
      await page.getByRole("checkbox").first().waitFor({ state: "visible" });
      await page.waitForTimeout(300);
    },
  },
  {
    id: "09-install-project-confirm",
    title: "商店 · 装到项目的确认条(I-2:第二个带边框盒子)",
    async run(page, ctx) {
      await ctx.openStoreDetail(page, "安全评审清单");
      await page.getByRole("button", { name: "选择安装位置" }).click();
      await page.getByRole("menuitem", { name: "装到项目…" }).click();
      await page.getByRole("button", { name: "装到这里" }).waitFor({ state: "visible" });
      await page.waitForTimeout(300);
    },
  },
  // 🔴 10 是 I-1 要看的那屏:「审核中」那一行的详情面板页脚,此前恒无库链接。
  {
    id: "10-detail-under-review-footer",
    title: "详情面板 ·「审核中」那一档的页脚(I-1:库链接退回 review.url)",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByRole("tab", { name: /可分享到技能库/ }).click();
      await page.getByTestId("row-riso-editorial-deck-body").click();
      await page.waitForTimeout(500);
      await ctx.scrollPanelToBottom(page);
      await page.waitForTimeout(300);
    },
  },
  // 🔴 11 是 v7.2 需求 2 唯一能证明问题的那一屏:**必须用矮视口**。
  // 1000px 高的默认视口里正文区还有余量,页脚本来就不会动,截出来什么都证明不了;
  // 640px 高时 v7.1 的实现会把页脚顶出视口(实测「移除」按钮 y 从 596 跳到 626)。
  {
    id: "11-detail-readers-short-viewport",
    title: "详情面板 ·「…」展开 · 矮窗口(需求 2:页脚必须原地不动)",
    viewport: { width: 1000, height: 640 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-api-test-expert-body").click();
      await page.waitForTimeout(500);
      await page.getByTestId("where-toggle").click();
      await page.waitForTimeout(200);
      await page.getByRole("button", { name: "哪些工具" }).click();
      await page.getByTestId("where-readers").waitFor({ state: "visible" });
    },
  },
  // ---------------------------------------------------------------- v7.3
  // 12/13 是 v7.3 需求 6 与需求 3 唯一能证明问题的两屏(筛选态、搜索穿透);
  // 14–17 是四档窄视口——页签少了一个但多了角标,页签行会不会被挤/被切
  // 只有真的量一遍才知道(v7.2 就在 1000px 上把文字挤到换行、上下切掉)。
  {
    id: "12-tab-badge-filter",
    title: "「我的技能」· 点角标筛选(需求 6:切到该页签 + 只看要处理的)",
    viewport: { width: 1200, height: 1000 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      // 「已分享到」区共 2 行,其中 1 行要处理——点它的角标应当切过去并只剩那 1 行
      await page.getByTestId("tab-badge-sharedTo").click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "13-search-across-tabs",
    title: "「我的技能」· 搜索穿透页签(需求 3:页签整行让位 + 按栏分组)",
    viewport: { width: 1200, height: 1000 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      // 「生成」同时命中「安装自」(周报生成)与「已分享到」(接口脚本生成、
      // 数据库逆向生成)——当前页签是「安装自」,另外那一栏的命中照样要出来。
      await page.getByTestId("store-search").fill("生成");
      await page.waitForTimeout(300);
    },
  },
  ...[1200, 1000, 900, 800].map((width, i) => ({
    id: `1${4 + i}-tabs-width-${width}`,
    title: `「我的技能」· 页签行在 ${width}px 窗口下(名字 + 角标 +「全部更新 · N」+「新建技能」不许被切)`,
    viewport: { width, height: 700 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.waitForTimeout(200);
    },
  })),
  {
    id: "19-store-cards",
    title: "技能商店 · 卡片(需求 5 复查:满屏「获取」降成 chip,「有更新」才实心)",
    viewport: { width: 1200, height: 1000 },
    async run(page) {
      await page.getByRole("button", { name: "技能商店" }).first().click();
      await page.waitForTimeout(500);
    },
  },
  // 🔴 这一屏在 0.6.x 之前**一直截的是空态**:`fixtures.mjs` 的 `project_list`
  // 是 `[]`,而这里的 `run` 只是点一下侧边栏、睡 400ms——空页也能截,所以每一轮
  // "截图全部产出"都成立,却没有任何人看见过这一页有数据的样子。现在走
  // `ctx.gotoProjects`:等到真的有 `prow-*` 行渲染出来才算到了,fixture 若再退回
  // 空数组,这一屏会**红**而不是安静地截一张空页。
  {
    id: "18-projects-page",
    title: "「项目里的技能」整页(五种档:正常 / 目录不在 / 只读 / 空项目 / 单技能;行内混可更新与不可更新)",
    viewport: { width: 1200, height: 1000 },
    async run(page, ctx) {
      await ctx.gotoProjects(page);
    },
  },
  // ---------------------------------------------------------------- v7.6 任务 3
  // 20 是 Q44-A 唯一能证明"页脚并成一行"的一屏:此前(task-2)商店详情面板是
  // "一行主按钮 + 另起一行次要动作,末尾露着一颗常驻「移除」",这一屏截的正是
  // 改正后的样子——"接口测试专家"是 installedFrom + localModified:false +
  // remote 不同(见 fixtures.mjs),cardState 落「更新」,次要动作有打开文件夹/
  // 在技能库里查看(section=installedFrom 时 libraryUrl 非空)/「…」三样齐全,
  // 是这个改动能展示得最完整的一行。
  //
  // 🔴 这一屏当初"截不到「…」展开"的那段说明**已经作废,原委留在这里当教训**:
  // 页脚贴着 `fixed inset-y-0` 面板的底边,而 `SkillRowMenu` 当时硬编码
  // `top-full`(往下开),于是下拉必然画到视口之外、怎么加高视口都截不到。
  // 当时把它写成了"截图工具的局限 + 留给用户判断是否要加碰撞检测"——**判错了**:
  // 那不是取景问题,是同一笔任务自己造出来的可达缺陷(「移除」被收进这个菜单、
  // 菜单又被摆到了页脚),真机上用户点「…」什么都看不到。现已修复:
  // `SkillRowMenu` 收必填的 `placement`,页脚传 `"up"`(见该组件文档)。
  // **留在这里的教训**:截图工具截不到某样东西时,先问一句"是截不到,还是它
  // 本来就不该在那儿"——前者是 harness 的局限,后者是产品缺陷,而两者的现象一样。
  {
    id: "20-detail-store-footer-merged",
    title: "商店详情面板 · 页脚并成一行(v7.6 任务 3,Q44-A:主按钮+装到项目+次要动作+「…」同排)",
    async run(page, ctx) {
      await ctx.openStoreDetail(page, "接口测试专家");
      await page.waitForTimeout(300);
    },
  },
  // 🔴 **这一屏是「最宽档」,不能省**(2026-09-10 用户真机 + 顾问先后各抓一次):
  // 上面那一屏的主按钮是「更新」(2 字 ≈55px),恰好是最短的一档,页脚放得下;
  // 而「已在电脑上」是 5 字 + 绿勾(≈100px),五个元素合计约 472px > 可用的 440px
  // ——`flex-wrap` 把「…」挤到第二行,用户原话"白折叠了"。
  // **送审截图必须覆盖最宽/最密的那一档,不是随手一档**:同一个教训这一轮犯了
  // 两次(另一次是确认条的 picker 只截了 2 个工具、不含密度)。
  {
    id: "21-detail-store-footer-widest",
    title: "商店详情面板 · 页脚最宽档(主按钮=「已在电脑上」,验证不折行)",
    async run(page, ctx) {
      await ctx.openStoreDetail(page, "Word 转 Markdown");
      await page.waitForTimeout(300);
    },
  },
  // ---------------------------------------------------------------- v7.7
  // 用户真机报告:「我的技能」列表**倒数第二行**点「…」,菜单被 `RowCard` 的
  // `overflow-hidden` 裁掉一半(那个 `overflow-hidden` 的本职是裁圆角,不是
  // 拿来防菜单的)。改成 portal 到 `document.body` 之后,`page.screenshot()`
  // **终于能截到菜单展开态**了——此前(见上面 20/21 两屏之间那段教训注释)
  // 这类"菜单画到容器外/被裁"的场景,harness 记的是"截不到",这一屏正是补上
  // 那段历史欠账:不用行号写死("接口测试专家"这类具体技能名会随 fixture 改动
  // 漂移),而是动态取"当前渲染的最后一行往前数第二行",真实还原用户报告的
  // 那个操作("倒数第二行"),不是随便挑一行。
  {
    id: "22-my-skills-row-menu",
    title: "「我的技能」· 倒数第二行点开「…」(v7.7:portal 之后菜单完整可见,不再被 RowCard 裁剪)",
    viewport: { width: 1200, height: 1000 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      // 行容器是 `row-<dirSlug>`,名字块另有 `row-<dirSlug>-body`——排除后者
      // 才是"一行"的计数口径。
      const rows = page.locator('[data-testid^="row-"]:not([data-testid$="-body"])');
      const count = await rows.count();
      await rows
        .nth(count - 2)
        .getByRole("button", { name: "更多" })
        .click();
      await page.getByRole("menu").waitFor({ state: "visible" });
    },
  },
  {
    id: "23-detail-footer-row-menu-up",
    title: "商店详情面板 · 页脚「…」仍向上开(v7.7:portal 之后正面验证 preferred=up 这条路)",
    async run(page, ctx) {
      // 🔴 这一屏的存在有个原委:第一版接线时 `SkillRowMenu` 的菜单量得到了
      // 完全正确的 rect(`boundingBox()` 与 `style` 都对),但截图里却是空的
      // ——真因是 portal 到 `document.body` 之后,这个 div 与
      // `DetailPanel` 的 `fixed z-51` 面板成了根层叠上下文里的兄弟,旧的
      // `z-20`(只在"菜单是面板子孙"时才够用)被面板整个盖住。改成 `z-90`
      // 之后才补上这一屏——只有真机(或这个 harness)截得到这类"量对了、
      // 层叠错了"的缺陷,jsdom 不画层叠、看不见这一类问题。
      await ctx.openStoreDetail(page, "Word 转 Markdown");
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "更多" }).click();
      await page.getByRole("menu").waitFor({ state: "visible" });
    },
  },
  // ---------------------------------------------------------------- 0.6.x:项目页
  // 走查清单「v7.7 追加」里的两条**此前只能真机验**:「项目里的技能」页底部行点
  // 「…」菜单要完整、再滚一下页面菜单要关。根因是 `project_list` fixture 为空。
  // 现在 fixture 有了数据,这两条落成下面 24/25 两屏——24 是截图 + 一条几何断言
  // (菜单矩形落在视口内;截图本身证明不了"没被裁",裁掉的部分在图上就是不存在),
  // 25 是这个 harness 的**第一条行为断言**(滚动后菜单必须消失)。
  //
  // 🔴 顺序必须是**先滚到底、再开菜单**:`useFloatingMenu` 在 `document` 的捕获
  // 阶段监听 `scroll`,反过来做的话菜单会被自己触发的那次滚动立刻关掉——那时
  // 截到的"没有菜单"是流程错了,不是产品缺陷。`scrollMain` 里的短等待就是让
  // 滚动事件先派发完。
  {
    id: "24-projects-bottom-row-menu",
    title: "「项目里的技能」· 整页最底下那一行点开「…」(v7.7:portal 之后菜单完整且落在视口内)",
    viewport: { width: 1200, height: 760 },
    async run(page, ctx) {
      await ctx.gotoProjects(page);
      await ctx.scrollMain(page, "bottom");
      const rows = page.locator('[data-testid^="prow-"]:not([data-testid$="-body"])');
      const count = await rows.count();
      await rows.nth(count - 1).getByRole("button", { name: "更多" }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor({ state: "visible" });
      const box = await menu.boundingBox();
      const vp = page.viewportSize();
      if (!box || box.y < 0 || box.x < 0 || box.y + box.height > vp.height || box.x + box.width > vp.width) {
        throw new Error(`菜单画到了视口之外:menu=${JSON.stringify(box)} viewport=${JSON.stringify(vp)}`);
      }
    },
  },
  {
    id: "25-projects-menu-closes-on-scroll",
    title: "「项目里的技能」· 菜单开着再滚一下页面 → 菜单关闭(v7.7:不悬在半空)",
    viewport: { width: 1200, height: 760 },
    async run(page, ctx) {
      await ctx.gotoProjects(page);
      await ctx.scrollMain(page, "bottom");
      const rows = page.locator('[data-testid^="prow-"]:not([data-testid$="-body"])');
      const count = await rows.count();
      await rows.nth(count - 1).getByRole("button", { name: "更多" }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor({ state: "visible" });
      await ctx.scrollMain(page, -80);
      // 行为断言:滚动之后菜单必须已经不在。超时即这一屏红(见主循环的处置)。
      await menu.waitFor({ state: "hidden", timeout: 2000 });
    },
  },
  // ⚠️ 这一屏截的是**稀档**:harness 探测到的非 universal 工具只有 Claude Code /
  // Trae 两个,`list` 布局的 picker 因此只有两行。用户真机是 9 个工具——这一屏
  // 看不出 `ProjectSections` 那个 `list` 布局在密档下的样子(CLAUDE.md 登记的
  // "第五处 list 布局、只登记不动"),要看密档得给 `AGENTS` 加工具,而那会连带
  // 改 08/09 的观感,单独一笔再做。
  {
    id: "26-projects-row-picker",
    title: "「项目里的技能」· 点技能名展开事后改选(list 布局;⚠️ 稀档:只有 2 个候选工具)",
    async run(page, ctx) {
      await ctx.gotoProjects(page);
      await page.getByTestId("prow-weekly-report-body").click();
      await page.getByRole("checkbox").first().waitFor({ state: "visible" });
      await page.waitForTimeout(200);
    },
  },
  {
    id: "27-projects-group-menu",
    title: "「项目里的技能」· 项目标题行的「…」(在文件夹中显示 / 从列表移除)",
    async run(page, ctx) {
      await ctx.gotoProjects(page);
      // 分组卡片没有 testid:从它里面的一行往上一层找到卡片,卡片里第一颗「更多」
      // 就是标题行那颗(行上的都排在它后面)。
      await page
        .getByTestId("prow-weekly-report")
        .locator("xpath=..")
        .getByRole("button", { name: "更多" })
        .first()
        .click();
      await page.getByRole("menu").waitFor({ state: "visible" });
    },
  },
  // 详情面板「在哪」的第四块「项目里」(v7.6 Q46-A)——与项目页同一个空洞:
  // 它按 `dirSlug` 从 `project_list` 派生,fixture 为空时整块不摆,此前从未出现在
  // 任何截图里。刻意用「周报生成」而不是 02–07 屏在用的技能,让那几屏保持可比。
  {
    id: "28-detail-projects-block",
    title: "详情面板 ·「在哪」第四块「项目里」(fixture 有项目数据后第一次出现)",
    async run(page, ctx) {
      await ctx.gotoMine(page);
      await page.getByTestId("row-weekly-report-body").click();
      // 「在哪」几块默认折在 `where-toggle` 后面(04/06 屏同款),不点开这一块不渲染
      await page.getByTestId("where-toggle").click();
      await page.getByTestId("where-block-projects").waitFor({ state: "visible" });
      await page.waitForTimeout(300);
    },
  },
  // 走查清单 F4:已装过的项目仍可点,确认条主动作换成「覆盖重装」(2026-08-22 用户
  // 拍板"标出已装是知情不是禁止")。「周报生成」已在 erp-backend 里,从「最近的项目」
  // 点它——与 09 屏(没装过 → 「装到这里」)是同一条确认条的两档。
  {
    id: "29-install-project-confirm-reinstall",
    title: "商店 · 装到已装过的项目 → 确认条主动作是「覆盖重装」(走查清单 F4)",
    async run(page, ctx) {
      await ctx.openStoreDetail(page, "周报生成");
      // 主按钮是终态(「已在电脑上」)时作用域入口显性化成「装到项目… ⌄」文字按钮,
      // 可访问名随之是那段文字;没装过时才是图标按钮「选择安装位置」。
      await page.getByRole("button", { name: /装到项目…|选择安装位置/ }).first().click();
      await page.getByRole("menuitem", { name: /erp-backend/ }).click();
      await page.getByRole("button", { name: "覆盖重装" }).waitFor({ state: "visible" });
      await page.waitForTimeout(300);
    },
  },
  // ---------------------------------------------------------------- 0.6.x 全屏
  // 用户真机全屏(~2000px)截图:内容列靠左封顶、顶栏全出血,右半边一大片空白。
  // 此前所有屏都是 1200 宽,**全屏这一档从来没人截过**——送审截图要覆盖最宽的窗口,
  // 与 21 号屏「最宽档」是同一条教训。`scale: 1`:2000px 再乘 2 的图太大,看布局不需要。
  ...[
    ["30-wide-store", "技能商店", null],
    ["31-wide-my-skills", "我的技能", "gotoMine"],
    ["32-wide-projects", "项目里的技能", "gotoProjects"],
    ["33-wide-settings", "设置", null],
    ["34-ultrawide-store", "技能商店", null, 2560],
  ].map(([id, nav, go, width = 2000]) => ({
    id,
    title: `全屏 ${width}×1200 ·「${nav}」(内容左锚定铺满、顶栏全出血;设置页维持 620)`,
    viewport: { width, height: 1200 },
    scale: 1,
    async run(page, ctx) {
      if (go) await ctx[go](page);
      else await page.getByRole("button", { name: nav }).first().click();
      await page.waitForTimeout(500);
    },
  })),
];

// ---------------------------------------------------------------- 交互小工具
const ctx = {
  async gotoMine(page) {
    await page.getByRole("button", { name: "我的技能" }).first().click();
    // 等到真的有行渲染出来为止,不靠 sleep 猜
    await page.getByTestId("row-api-test-expert").waitFor({ state: "visible" });
  },
  /** 「项目里的技能」页。等到真的有一行 `prow-*` 渲染出来才算到了——这就是
   *  对"空页也能截"那个空洞的结构性修复:fixture 退回空数组时这里会超时变红。 */
  async gotoProjects(page) {
    await page.getByRole("button", { name: "项目里的技能" }).first().click();
    await page.locator('[data-testid^="prow-"]').first().waitFor({ state: "visible" });
  },
  /** 滚主内容区(`main > div.overflow-y-auto`,见 App.tsx;body 是 overflow:hidden
   *  滚不动)。`to` 是 `"bottom"` 或一个相对像素数。滚完短等一下,让 `scroll`
   *  事件派发完——`useFloatingMenu` 就靠它关菜单,不等的话"先滚再开菜单"会被
   *  自己的滚动事件追上。 */
  async scrollMain(page, to) {
    await page.evaluate((to) => {
      const el = document.querySelector("main > div.overflow-y-auto");
      if (!el) throw new Error("找不到主滚动容器 main > div.overflow-y-auto(App.tsx 布局变了?)");
      el.scrollTop = to === "bottom" ? el.scrollHeight : el.scrollTop + to;
    }, to);
    await page.waitForTimeout(150);
  },
  /** 商店页(默认页)里点开一张卡片的详情。卡片的 `aria-label` 就是技能名,
   *  但卡片内部还有一颗同名相关的按钮,所以取 `.first()`(外层卡片先出现)。 */
  async openStoreDetail(page, name) {
    await page.getByRole("button", { name }).first().click();
    await page.getByRole("heading", { name, level: 2 }).waitFor({ state: "visible" });
    await page.waitForTimeout(400);
  },
  /** 滚动详情面板自己的滚动容器(不是页面 body——body 是 overflow:hidden)。 */
  async scrollPanelToBottom(page) {
    await page.evaluate(() => {
      const scrollable = [...document.querySelectorAll("*")].filter(
        (el) => el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY === "auto",
      );
      const el = scrollable[scrollable.length - 1];
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
};

// ---------------------------------------------------------------- dev server
function startVite() {
  // 🔴 必须显式 `--host 127.0.0.1`:vite 默认只绑 `localhost`,在这台机器上
  // 优先解析成 ::1,而 Chrome 走 IPv4 直连会拿到 ERR_CONNECTION_REFUSED。
  const child = spawn("pnpm", ["exec", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  child.stderr.on("data", (b) => process.stderr.write(`[vite] ${b}`));
  return child;
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) throw new Error(`vite 在 ${timeoutMs}ms 内没有起来:${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------------------------------------------------------------- 主流程
const fixtures = buildFixtures();
const base = `http://127.0.0.1:${PORT}/`;
const vite = startVite();
let browser;
const problems = [];
/** `run` 抛错的屏数。>0 时进程非零退出——截图产出了,但有屏没走到该截的状态。 */
let failures = 0;

try {
  await waitForServer(base);
  await mkdir(OUT, { recursive: true });

  // `--no-proxy-server`:开发机上常年开着 HTTP 代理(http_proxy 指向本机 7890),
  // Chrome 会把 127.0.0.1 也交给代理,拿回一个 502。截图跑的是本机 dev server,
  // 一律直连。
  browser = await chromium.launch({
    channel: "chrome",
    headless: !HEADED,
    args: ["--no-proxy-server"],
  });
  /** 与设计画布的画板同尺寸;某一屏可以用 `viewport` 覆盖。 */
  const DEFAULT_VIEWPORT = { width: 1200, height: 1000 };

  const shots = [];
  for (const screen of SCREENS) {
    if (ONLY.length && !ONLY.includes(screen.id)) continue;
    const context = await browser.newContext({
      viewport: screen.viewport ?? DEFAULT_VIEWPORT,
      deviceScaleFactor: screen.scale ?? 2,
      locale: "zh-CN",
      colorScheme: "light",
    });
    const page = await context.newPage();
    // 页面里的报错要浮上来,不能让它们静静地把某一块画成空白
    page.on("pageerror", (e) => problems.push(`[${screen.id}] pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`[${screen.id}] console: ${m.text()}`);
    });
    await installTauriMock(page, fixtures);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    // 24/25 起有了带断言的屏(几何断言、行为断言)。一屏抛错**不中止整轮**:
    // 记进 problems、照样把那一刻的样子截下来(排查时那张图比一句错误有用)、
    // 其余屏继续跑,收尾时非零退出——别让断言退化成 `waitForTimeout`,也别让
    // 一条红把 `index.json` 和后面二十几张图一起吞掉。
    let runFailed = false;
    try {
      await screen.run(page, ctx);
    } catch (e) {
      problems.push(`[${screen.id}] run failed: ${e?.message ?? e}`);
      failures += 1;
      runFailed = true;
    }
    // 键盘焦点环是交互残留,不是设计的一部分——留着会让并排比对多一层噪音
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    const file = path.join(OUT, `${screen.id}.png`);
    await page.screenshot({ path: file });
    shots.push({ id: screen.id, title: screen.title, file });
    console.log(`${runFailed ? "✗" : "✓"} ${screen.id}  ${screen.title}\n  ${file}`);
    await page.close();
    await context.close();
  }

  await writeFile(
    path.join(OUT, "index.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), viewport: "1200x1000@2x", shots, problems }, null, 2),
    "utf8",
  );

  if (problems.length) {
    console.log("\n⚠️ 页面报了这些错(fixture 没覆盖到的 command 会以 MOCK_MISSING 出现):");
    for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
  }
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
if (failures > 0) {
  console.log(`\n✗ ${failures} 屏的 run 抛错(见上面的 run failed),截图仍已产出`);
  process.exitCode = 1;
}
