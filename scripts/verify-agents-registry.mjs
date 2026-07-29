#!/usr/bin/env node
/**
 * 校验 resources/agents.json 与上游 vercel-labs/skills 的 agents.ts 是否一致。
 *
 * 用法:
 *   node scripts/verify-agents-registry.mjs              # 校验并重写 fixture
 *   node scripts/verify-agents-registry.mjs --check      # 只校验,不写 fixture
 *   SKILLSYNC_UPSTREAM_DIR=/path/to/skills/src node scripts/verify-agents-registry.mjs   # 离线,用本地副本
 *
 * 做三件事:
 *   1) 名称集合比对——我们的 75 条与上游 agents 记录逐一对应,无多无少;
 *   2) 路径解析 ground truth——在多组 env 场景下由上游源码算出真实路径,写入
 *      src-tauri/tests/fixtures/upstream-agents-resolved.json,由 Rust 单测断言自己的解析器与之逐条一致。
 *      注意:上游 agents.ts 在模块加载时就把 home/configHome/... 求值完毕,一个进程只能验证一种 env 组合,
 *      因此每个场景 fork 一个子进程;
 *   3) 探测路径反查——按我们 JSON 里的 detect 路径在临时 HOME 下逐个造目录,
 *      问上游 detectInstalledAgents() 是否认得出该 agent。路径写错则上游认不出,直接暴露。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_VERSION = "v1.5.20";
const UPSTREAM_BASE = `https://raw.githubusercontent.com/vercel-labs/skills/${UPSTREAM_VERSION}/src`;
const FIXTURE = join(REPO, "src-tauri/tests/fixtures/upstream-agents-resolved.json");
const CHECK_ONLY = process.argv.includes("--check");

/**
 * xdg-basedir@5.1.0 的实现,逐字取自上游 npm 包内 dist/_chunks/libs/xdg-basedir.mjs。
 * 之所以内联而不 npm install:让本脚本离线可跑,且 ground truth 与上游实际打包进产物的代码完全一致。
 */
const XDG_SHIM = `import path from "path";
import os from "os";
const homeDirectory = os.homedir();
const { env } = process;
const xdgConfig = env.XDG_CONFIG_HOME || (homeDirectory ? path.join(homeDirectory, ".config") : void 0);
export { xdgConfig };
`;

const PROBE = `const { agents, detectInstalledAgents } = await import("./agents.ts");
const mode = process.env.PROBE_MODE;
if (mode === "dump") {
  const out = {};
  for (const [name, cfg] of Object.entries(agents)) {
    out[name] = {
      displayName: cfg.displayName,
      skillsDir: cfg.skillsDir,
      globalSkillsDir: cfg.globalSkillsDir ?? null,
    };
  }
  process.stdout.write(JSON.stringify(out));
} else if (mode === "detect") {
  const { mkdirSync, rmSync } = await import("node:fs");
  const plan = JSON.parse(process.env.PROBE_PLAN);
  const out = {};
  for (const { agent, paths } of plan) {
    for (const p of paths) mkdirSync(p, { recursive: true });
    out[agent] = await detectInstalledAgents();
    for (const p of paths) rmSync(p, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(out));
}
`;

// ---------------------------------------------------------------- 工作区准备

function download(name, dest) {
  const local = process.env.SKILLSYNC_UPSTREAM_DIR;
  if (local && existsSync(join(local, name))) {
    writeFileSync(dest, readFileSync(join(local, name)));
    return;
  }
  const body = execFileSync("curl", ["-sSL", "--max-time", "60", `${UPSTREAM_BASE}/${name}`]);
  if (body.length === 0 || body.toString().startsWith("404")) {
    throw new Error(`下载上游 ${name} 失败,可用 SKILLSYNC_UPSTREAM_DIR 指向本地副本`);
  }
  writeFileSync(dest, body);
}

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "skillsync-agents-verify-"));
  for (const f of ["agents.ts", "types.ts", "constants.ts"]) download(f, join(ws, f));
  mkdirSync(join(ws, "node_modules/xdg-basedir"), { recursive: true });
  writeFileSync(join(ws, "node_modules/xdg-basedir/index.mjs"), XDG_SHIM);
  writeFileSync(
    join(ws, "node_modules/xdg-basedir/package.json"),
    JSON.stringify({ name: "xdg-basedir", version: "5.1.0", type: "module", main: "index.mjs" }),
  );
  writeFileSync(join(ws, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(ws, "probe.mjs"), PROBE);
  return ws;
}

/** 在干净的 env 下 fork 子进程跑 probe——上游模块级常量只在加载时求值一次,必须一场景一进程。 */
function runProbe(ws, env) {
  const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const out = execFileSync(process.execPath, ["probe.mjs"], {
    cwd: ws,
    env: { ...clean, ...env },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// ---------------------------------------------------------------- 场景定义

const FAKE_HOME = "/skillsync-fake-home";

/** 每个场景一种 env 组合,覆盖:默认值、env 覆盖、空白值回退、前后空格被 trim。 */
const SCENARIOS = [
  { name: "defaults", env: {} },
  {
    name: "envOverrides",
    env: {
      XDG_CONFIG_HOME: "/fake/xdg",
      CODEX_HOME: "/fake/codex",
      CLAUDE_CONFIG_DIR: "/fake/claude",
      VIBE_HOME: "/fake/vibe",
      HERMES_HOME: "/fake/hermes",
      AUTOHAND_HOME: "/fake/autohand",
      GROK_HOME: "/fake/grok",
      APPDATA: "/fake/appdata",
      FLATPAK_XDG_CONFIG_HOME: "/fake/flatpak",
    },
  },
  {
    // 空白值:六个 agent home 走 trim() 后回退默认;XDG_CONFIG_HOME 不 trim,空白值被原样采用
    name: "blankEnv",
    env: {
      XDG_CONFIG_HOME: "  ",
      CODEX_HOME: "   ",
      CLAUDE_CONFIG_DIR: "\t",
      VIBE_HOME: " ",
      HERMES_HOME: "  ",
      AUTOHAND_HOME: " ",
      GROK_HOME: " ",
    },
  },
  {
    name: "paddedEnv",
    env: { CODEX_HOME: "  /fake/padded-codex  ", CLAUDE_CONFIG_DIR: " /fake/padded-claude " },
  },
];

/** openclaw 的全局目录按 .openclaw → .clawdbot → .moltbot 顺序择首个存在者,需要真实目录才能验证。 */
const EXISTING_DIR_SCENARIOS = [
  { name: "openclawClawdbot", existingDirs: [".clawdbot"] },
  { name: "openclawMoltbot", existingDirs: [".moltbot"] },
  { name: "openclawBoth", existingDirs: [".openclaw", ".moltbot"] },
];

const toPosix = (s) => (typeof s === "string" ? s.replaceAll("\\", "/") : s);

/** 把机器相关的临时 HOME 换成占位符,fixture 才能 checked in 并跨机器复用。 */
function normalize(agentsDump, homeReplacements) {
  const out = {};
  for (const [name, cfg] of Object.entries(agentsDump)) {
    let global = toPosix(cfg.globalSkillsDir);
    for (const [from, to] of homeReplacements) {
      if (global) global = global.replaceAll(toPosix(from), to);
    }
    out[name] = {
      displayName: cfg.displayName,
      skillsDir: toPosix(cfg.skillsDir),
      globalSkillsDir: global,
    };
  }
  return out;
}

// ---------------------------------------------------------------- 校验主流程

const ours = JSON.parse(readFileSync(join(REPO, "resources/agents.json"), "utf8"));
const failures = [];
const ws = setupWorkspace();

try {
  // ---- 1) 名称集合比对
  const baseline = runProbe(ws, { HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, PROBE_MODE: "dump" });
  const upstreamNames = new Set(Object.keys(baseline));
  const ourNames = new Set(ours.agents.map((a) => a.name));
  for (const n of upstreamNames) if (!ourNames.has(n)) failures.push(`本地缺少上游 agent: ${n}`);
  for (const n of ourNames) if (!upstreamNames.has(n)) failures.push(`本地多出上游没有的 agent: ${n}`);
  console.log(`[1/3] 名称集合: 上游 ${upstreamNames.size} 条 / 本地 ${ourNames.size} 条`);

  // ---- 2) 各 env 场景下的路径 ground truth
  const scenarios = [];
  for (const s of SCENARIOS) {
    const env = { HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, ...s.env, PROBE_MODE: "dump" };
    const dump = runProbe(ws, env);
    scenarios.push({
      name: s.name,
      home: FAKE_HOME,
      env: s.env,
      existingDirs: [],
      agents: normalize(dump, []),
    });
  }
  for (const s of EXISTING_DIR_SCENARIOS) {
    const home = mkdtempSync(join(tmpdir(), "skillsync-home-"));
    for (const d of s.existingDirs) mkdirSync(join(home, d), { recursive: true });
    const dump = runProbe(ws, { HOME: home, USERPROFILE: home, PROBE_MODE: "dump" });
    scenarios.push({
      name: s.name,
      home: "{HOME}",
      env: {},
      existingDirs: s.existingDirs,
      agents: normalize(dump, [[home, "{HOME}"]]),
    });
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`[2/3] 路径 ground truth: ${scenarios.length} 个场景 × ${upstreamNames.size} 条`);

  // ---- 3) 探测路径反查:按我们的 detect 路径造目录,看上游认不认
  const home = mkdtempSync(join(tmpdir(), "skillsync-detect-"));
  // XDG_CONFIG_HOME 特意指向 ~/.config 以外的位置:上游有几个 agent(kimchi/crush)把 ~/.config 写死
  // 而非走 configHome,若两者恰好同值,把它们"修正"成 configHome 也不会被发现。错开即可区分。
  const probeEnv = { XDG_CONFIG_HOME: join(home, "xdg-config") };
  // 按 vars 定义把模板变量解析为探针目录。
  // 这不是 ground truth——只是"我们提议路径、上游裁决认不认",路径写错会表现为上游未检出而非静默通过。
  const resolveVars = { home, cwd: join(home, "__no_project__") };
  for (const [varName, spec] of Object.entries(ours.vars)) {
    if (spec.kind !== "env") continue;
    const raw = probeEnv[spec.name];
    const value = spec.trim === false ? raw : raw?.trim();
    if (value) {
      resolveVars[varName] = value;
    } else if (spec.default) {
      resolveVars[varName] = spec.default.replace(/\{(\w+)\}/g, (m, v) => resolveVars[v] ?? m);
    }
  }
  const plan = [];
  const skipped = [];
  for (const agent of ours.agents) {
    const paths = [];
    for (const rule of agent.detect) {
      if (typeof rule !== "string") continue; // 非字符串规则均为 project 作用域,全局探测不涉及
      const resolved = rule.replace(/\{(\w+)\}/g, (m, v) => resolveVars[v] ?? m);
      if (resolved.includes("{") || !resolved.startsWith(home)) continue; // 系统绝对路径造不出来,跳过
      paths.push(resolved);
    }
    if (paths.length === 0) skipped.push(agent.name);
    else plan.push({ agent: agent.name, paths });
  }
  const detectResults = runProbe(ws, {
    HOME: home,
    USERPROFILE: home,
    ...probeEnv,
    PROBE_MODE: "detect",
    PROBE_PLAN: JSON.stringify(plan),
  });
  const detectProbes = [];
  for (const { agent, paths } of plan) {
    if (!detectResults[agent]?.includes(agent)) {
      failures.push(`探测路径与上游不符: 造出 ${agent} 的目录后上游未检出它`);
      continue;
    }
    // 只把经上游确认过的路径写进 fixture,供 Rust 侧回归——改错探测路径时 CI 会红
    detectProbes.push({ agent, paths: paths.map((p) => p.replaceAll(home, "{HOME}")) });
  }
  for (const agent of skipped) detectProbes.push({ agent, paths: [] });
  detectProbes.sort((a, b) => a.agent.localeCompare(b.agent));
  rmSync(home, { recursive: true, force: true });
  console.log(
    `[3/3] 探测反查: ${plan.length} 条通过上游确认,${skipped.length} 条无全局探测路径已跳过(${skipped.join(", ")})`,
  );

  // ---- 写 fixture
  if (!CHECK_ONLY) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(
      FIXTURE,
      JSON.stringify(
        {
          $comment: [
            "由 scripts/verify-agents-registry.mjs 从上游源码实际执行结果生成,请勿手改。",
            "路径分隔符统一为 /,Rust 侧比对时同样归一化。",
            "scenarios: 各 env 组合下上游算出的 agent 目录。",
            "detectProbes: 造出 paths 里的目录后,上游 detectInstalledAgents() 确实检出了该 agent。",
            "  paths 为空表示该 agent 没有全局作用域的探测路径(只有项目级规则或恒不可探测),",
            "  是经确认的事实而非漏生成。",
          ],
          source: { project: "vercel-labs/skills", version: UPSTREAM_VERSION, file: "src/agents.ts" },
          scenarios,
          detectProbeEnv: Object.fromEntries(
            Object.entries(probeEnv).map(([k, v]) => [k, v.replaceAll(home, "{HOME}")]),
          ),
          detectProbes,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`已写入 ${FIXTURE}`);
  }
} finally {
  rmSync(ws, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("\n校验失败:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n校验通过:resources/agents.json 与上游一致");
