#!/usr/bin/env node
/**
 * 录制上游 vercel-labs/skills 的全局 lock(`~/.agents/.skill-lock.json`, schema v3)真实行为。
 *
 * 用法:
 *   node scripts/verify-skill-lock.mjs           # 生成 fixture
 *   node scripts/verify-skill-lock.mjs --check   # 只跑不写
 *   SKILLSYNC_UPSTREAM_DIR=/path/to/skills/src node scripts/verify-skill-lock.mjs
 *
 * 为什么要录:这个文件是**外部契约**——`npx skills` 与本 app 同时读写它。
 * 字节级格式(缩进、有无末尾换行)、版本探测行为、未知字段是否被保留,
 * 任何一处理解错都会在用户机器上悄悄破坏另一个工具的数据,而单测永远发现不了。
 *
 * 做法:每个场景在**子进程**里跑,HOME 指向临时目录(上游 getSkillLockPath 在调用时才读 homedir,
 * 但 XDG_STATE_HOME 分支也要覆盖,故统一用子进程注入环境变量),把最终文件原始字节记进 fixture。
 * 时间戳是 new Date() 产生的,记录前归一化成固定值,Rust 侧注入同一个时钟即可逐字节比对。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_VERSION = "v1.5.20";
const UPSTREAM_BASE = `https://raw.githubusercontent.com/vercel-labs/skills/${UPSTREAM_VERSION}/src`;
const UPSTREAM_FILES = ["skill-lock.ts"];
const FIXTURE = join(REPO, "src-tauri/tests/fixtures/upstream-skill-lock.json");
const CHECK_ONLY = process.argv.includes("--check");

/** 归一化后的时间戳,Rust 侧注入同一个值。 */
const FIXED_NOW = "2026-07-30T00:00:00.000Z";
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/**
 * 只把**本次运行期间**由 `new Date()` 生成的时间戳换成固定值。
 *
 * 不能无差别替换:场景里特意预置了旧的 `installedAt`(2026-01-01),
 * 而"重复写入时 installedAt 是否被保留"正是要验的行为——一刀切替换会把它抹平,
 * fixture 就再也证明不了这条。ISO-8601 UTC 串的字典序等同时间序,按运行窗口筛选即可。
 */
const normalizeRunTimestamps = (text, from, to) =>
  text.replace(ISO_RE, (m) => (m >= from && m <= to ? FIXED_NOW : m));

/** 一条我们要写入的条目,字段取值贴合本 app 的真实用法(Gitea 源,无 GitHub tree SHA)。 */
const OUR_ENTRY = {
  source: "skills/skills",
  sourceType: "gitea",
  sourceUrl: "http://gitea.example.internal:3000/skills/skills",
  ref: "main",
  skillPath: "skills/docx-to-markdown/SKILL.md",
  // 上游对拿不到 GitHub tree SHA 的源(well-known)就是填空串,见 add.ts:916。
  // 我们是 Gitea,同样没有 tree SHA,照此填空串而不是硬塞一个 sha256 冒充。
  skillFolderHash: "",
};

/** 别的工具/用户已经在 lock 里的内容,双写时一个字节都不该动。 */
const FOREIGN_LOCK = {
  version: 3,
  skills: {
    "someone-elses-skill": {
      source: "vercel-labs/agent-skills",
      sourceType: "github",
      sourceUrl: "https://github.com/vercel-labs/agent-skills",
      ref: "main",
      skillPath: "skills/pdf/SKILL.md",
      skillFolderHash: "aabbccddeeff00112233445566778899aabbccdd",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  },
  dismissed: { findSkillsPrompt: true },
  lastSelectedAgents: ["claude-code", "cursor"],
};

/**
 * 场景清单。`initial` 是跑之前 lock 文件的内容(null = 文件不存在,字符串 = 原样写入),
 * `ops` 是依次执行的操作。
 */
const SCENARIOS = [
  {
    name: "文件不存在时新建",
    initial: null,
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
  {
    name: "v3 文件中新增条目,保留他人条目与未知顶层字段",
    initial: JSON.stringify(FOREIGN_LOCK, null, 2),
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
  {
    // 必须预置一条带**旧** installedAt 的同名条目:两次都在本次运行内写入的话,
    // 两个时间戳都会被归一化,fixture 就证明不了 installedAt 到底有没有被保留。
    name: "覆盖已有条目:installedAt 保留,updatedAt 刷新",
    initial: JSON.stringify(
      {
        ...FOREIGN_LOCK,
        skills: {
          ...FOREIGN_LOCK.skills,
          "docx-to-markdown": {
            ...OUR_ENTRY,
            installedAt: "2026-01-05T00:00:00.000Z",
            updatedAt: "2026-01-06T00:00:00.000Z",
          },
        },
      },
      null,
      2,
    ),
    ops: [{ add: ["docx-to-markdown", { ...OUR_ENTRY, ref: "dev" }] }],
  },
  {
    name: "移除条目",
    initial: JSON.stringify(FOREIGN_LOCK, null, 2),
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }, { remove: "docx-to-markdown" }],
  },
  {
    name: "移除不存在的条目",
    initial: JSON.stringify(FOREIGN_LOCK, null, 2),
    ops: [{ remove: "从来没装过" }],
  },
  {
    name: "旧版本 v2:上游整体丢弃重建(本 app 有意分歧,见 Rust 侧测试)",
    initial: JSON.stringify({ ...FOREIGN_LOCK, version: 2 }, null, 2),
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
  {
    name: "更高版本 v4:上游原样保留并写入(本 app 有意分歧)",
    initial: JSON.stringify({ ...FOREIGN_LOCK, version: 4 }, null, 2),
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
  {
    name: "version 字段缺失",
    initial: JSON.stringify({ skills: {} }, null, 2),
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
  {
    name: "version 非数字",
    initial: JSON.stringify({ version: "3", skills: {} }, null, 2),
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
  {
    name: "JSON 损坏",
    initial: "{ 这不是合法 JSON",
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
  {
    name: "中文技能名作为键",
    initial: null,
    ops: [{ add: ["周报生成", OUR_ENTRY] }],
  },
  {
    name: "XDG_STATE_HOME 改变落点",
    initial: null,
    xdg: true,
    ops: [{ add: ["docx-to-markdown", OUR_ENTRY] }],
  },
];

const PROBE = `import { addSkillToLock, removeSkillFromLock, getSkillLockPath } from "./skill-lock.ts";
import { readFileSync, existsSync } from "node:fs";
const ops = JSON.parse(process.env.PROBE_OPS);
for (const op of ops) {
  if (op.add) await addSkillToLock(op.add[0], op.add[1]);
  else if (op.remove) await removeSkillFromLock(op.remove);
}
const p = getSkillLockPath();
process.stdout.write(JSON.stringify({
  path: p,
  exists: existsSync(p),
  bytes: existsSync(p) ? readFileSync(p, "utf-8") : null,
}));
`;

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
  const ws = mkdtempSync(join(tmpdir(), "skillsync-lock-"));
  for (const f of UPSTREAM_FILES) download(f, join(ws, f));
  writeFileSync(join(ws, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(ws, "probe.mjs"), PROBE);
  // skill-lock.ts 唯一的静态外部依赖(fetchSkillFolderHash 里的 ./blob.ts 是动态 import,不会触发)
  execFileSync("npm", ["install", "--silent", "--no-save", "--no-audit", "--no-fund", "picocolors"], {
    cwd: ws,
    stdio: "pipe",
  });
  return ws;
}

function runScenario(ws, scenario) {
  const home = mkdtempSync(join(tmpdir(), "skillsync-home-"));
  const xdgState = scenario.xdg ? join(home, "xdgstate") : undefined;
  const lockPath = xdgState
    ? join(xdgState, "skills", ".skill-lock.json")
    : join(home, ".agents", ".skill-lock.json");

  if (scenario.initial !== null) {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, scenario.initial, "utf-8");
  }

  const env = { ...process.env, HOME: home, USERPROFILE: home, PROBE_OPS: JSON.stringify(scenario.ops) };
  delete env.XDG_STATE_HOME;
  if (xdgState) env.XDG_STATE_HOME = xdgState;

  const t0 = new Date().toISOString();
  const out = execFileSync("node", ["--experimental-strip-types", "probe.mjs"], {
    cwd: ws,
    env,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const t1 = new Date().toISOString();
  const result = JSON.parse(out);
  rmSync(home, { recursive: true, force: true });

  return {
    name: scenario.name,
    initial: scenario.initial,
    ops: scenario.ops,
    // 落点相对 HOME,避免把临时路径写进 fixture
    lockPathUnderHome: xdgState ? "xdgstate/skills/.skill-lock.json" : ".agents/.skill-lock.json",
    xdg: !!scenario.xdg,
    exists: result.exists,
    bytes: result.bytes === null ? null : normalizeRunTimestamps(result.bytes, t0, t1),
  };
}

const ws = setupWorkspace();
let recorded;
try {
  recorded = { upstreamVersion: UPSTREAM_VERSION, fixedNow: FIXED_NOW, scenarios: SCENARIOS.map((s) => runScenario(ws, s)) };
} finally {
  rmSync(ws, { recursive: true, force: true });
}

const json = JSON.stringify(recorded, null, 2) + "\n";
if (CHECK_ONLY) {
  const existing = existsSync(FIXTURE) ? readFileSync(FIXTURE, "utf-8") : "";
  if (existing !== json) {
    console.error("fixture 与上游当前行为不一致,请重新生成");
    process.exit(1);
  }
  console.log("fixture 与上游一致");
} else {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, json, "utf-8");
  console.log(`已写入 ${FIXTURE}(${recorded.scenarios.length} 个场景)`);
  for (const s of recorded.scenarios) {
    const summary = s.bytes === null ? "(无文件)" : `${s.bytes.length} 字节`;
    console.log(`  ${s.name} → ${summary}`);
  }
}
