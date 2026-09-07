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
    title: "「我的技能」· 通用页签(三区 + conflict 行 + 审核中行)",
    // 🔴 比画板高:同样的十二行,画布用 1000px 装得下,当前实现装不下
    //(这本身就是一条待校准的密度差)。这一屏要求「三区都有内容 + conflict 行 +
    // 审核中行」同时可见,所以放宽高度;与画布并排比**密度**时记得这个差别。
    viewport: { width: 1200, height: 1760 },
    async run(page, ctx) {
      await ctx.gotoMine(page);
      // 「可分享到」区里有外部来源的那一行,名字与「有没有新版」都来自它自己的
      // 来源索引,而那一趟请求**只有点开这一行才会发**(store/my-skills.ts 的
      // ensureShareableIndexes:翻页本身不发请求)。所以先点一下再关掉,
      // 截出来的才是用户真正会看到的那一行。
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
      await page.getByTestId("row-riso-editorial-deck-body").click();
      await page.waitForTimeout(500);
      await ctx.scrollPanelToBottom(page);
      await page.waitForTimeout(300);
    },
  },
];

// ---------------------------------------------------------------- 交互小工具
const ctx = {
  async gotoMine(page) {
    await page.getByRole("button", { name: "我的技能" }).first().click();
    // 等到真的有行渲染出来为止,不靠 sleep 猜
    await page.getByTestId("row-api-test-expert").waitFor({ state: "visible" });
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
      deviceScaleFactor: 2,
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
    await screen.run(page, ctx);
    // 键盘焦点环是交互残留,不是设计的一部分——留着会让并排比对多一层噪音
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    const file = path.join(OUT, `${screen.id}.png`);
    await page.screenshot({ path: file });
    shots.push({ id: screen.id, title: screen.title, file });
    console.log(`✓ ${screen.id}  ${screen.title}\n  ${file}`);
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
