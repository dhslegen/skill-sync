#!/usr/bin/env node
/**
 * 录制上游 vercel-labs/skills 的**项目级** lock(`<项目根>/skills-lock.json`, schema v1)真实行为。
 *
 * 用法:
 *   node scripts/verify-project-lock.mjs           # 生成 fixture
 *   node scripts/verify-project-lock.mjs --check   # 只跑不写
 *   SKILLSYNC_UPSTREAM_DIR=/path/to/skills/src node scripts/verify-project-lock.mjs
 *
 * 与 verify-skill-lock.mjs(全局 v3)的关系:**两份完全不同的契约**,别混。
 * 项目级是 `skills-lock.json`(无点前缀)、schema v1、**有尾随换行**、
 * 键在写入前排序、**不含任何时间戳**(上游注释:timestamp-free 是为了让两个分支
 * 各自加技能时 git 能自动合并)。因此这里不需要 verify-skill-lock 那套时间戳归一化。
 *
 * 录两类 ground truth:
 * 1. **lock 字节形状**:各场景下上游写出的原始字节。本 app 写同样的内容必须逐字节相同,
 *    否则 npx skills 每次都会看到一份被无谓改写过的文件(它会进用户的版本控制)。
 * 2. **computedHash 口径**:上游按 `localeCompare` 排文件名,我们按字节序。真实技能的
 *    文件名很可能两种排法一致,那样差分测试会**假绿**而分歧潜伏——日后表现为
 *    npx 与本 app 互判"本地改过"。所以专门喂一组**故意混排**的合成文件名
 *    (连字符/下划线/数字/大小写混合),把上游算出的 hash 录下来当第二道 ground truth。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_VERSION = "v1.5.23";
const UPSTREAM_BASE = `https://raw.githubusercontent.com/vercel-labs/skills/${UPSTREAM_VERSION}/src`;
/** local-lock.ts 只 import node 内置模块,工作区不需要 npm install 任何东西。 */
const UPSTREAM_FILES = ["local-lock.ts"];
const FIXTURE = join(REPO, "src-tauri/tests/fixtures/upstream-project-lock.json");
const CHECK_ONLY = process.argv.includes("--check");

/** 本 app 从内建 Gitea 装一个技能时会写的条目。Gitea 归 `git` 档,必须带完整 sourceUrl。 */
const GITEA_ENTRY = {
  source: "skills/skills",
  sourceUrl: "http://gitea.example.internal:3000/skills/skills.git",
  ref: "main",
  sourceType: "git",
  skillPath: "skills/weekly-report/SKILL.md",
  computedHash: "0".repeat(64),
};

/** 广场/GitHub 源的条目形状(与真实录制的 vercel-labs 条目同构)。 */
const GITHUB_ENTRY = {
  source: "vercel-labs/agent-skills",
  sourceType: "github",
  skillPath: "skills/react-best-practices/SKILL.md",
  computedHash: "ca7b0c0c6e5f2750043f7f0cd72d16ac4e2abc48f9b5500d047a4b77a2506212",
};

/** 别人(或 npx 自己)已经在 lock 里的条目,我们双写时一个字节都不该动。 */
const FOREIGN_LOCK = {
  version: 1,
  skills: {
    "someone-elses-skill": {
      source: "other/repo",
      sourceType: "github",
      skillPath: "skills/pdf/SKILL.md",
      computedHash: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    },
  },
};

const SCENARIOS = [
  {
    name: "文件不存在时新建",
    initial: null,
    ops: [{ add: ["weekly-report", GITEA_ENTRY] }],
  },
  {
    name: "v1 文件中新增条目,保留他人条目",
    initial: JSON.stringify(FOREIGN_LOCK, null, 2) + "\n",
    ops: [{ add: ["weekly-report", GITEA_ENTRY] }],
  },
  {
    // 上游 writeLocalLock 每次都对键排序。乱序写入必须得到字母序的产出。
    name: "多条目乱序写入:产出必须按键字母序",
    initial: null,
    ops: [
      { add: ["zzz-last", GITHUB_ENTRY] },
      { add: ["aaa-first", GITEA_ENTRY] },
      { add: ["mmm-middle", GITHUB_ENTRY] },
    ],
  },
  {
    name: "覆盖同名条目",
    initial: JSON.stringify(FOREIGN_LOCK, null, 2) + "\n",
    ops: [
      { add: ["weekly-report", GITEA_ENTRY] },
      { add: ["weekly-report", { ...GITEA_ENTRY, ref: "dev", computedHash: "1".repeat(64) }] },
    ],
  },
  {
    name: "可选字段缺省:sourceUrl/ref/skillPath 全不给",
    initial: null,
    ops: [
      {
        add: [
          "minimal",
          { source: "some-pkg", sourceType: "node_modules", computedHash: "2".repeat(64) },
        ],
      },
    ],
  },
  {
    name: "移除条目",
    initial: JSON.stringify(FOREIGN_LOCK, null, 2) + "\n",
    ops: [{ add: ["weekly-report", GITEA_ENTRY] }, { remove: "weekly-report" }],
  },
  {
    name: "移除最后一条:空 skills 与文件都保留",
    initial: null,
    ops: [{ add: ["only-one", GITEA_ENTRY] }, { remove: "only-one" }],
  },
  {
    name: "移除不存在的条目",
    initial: JSON.stringify(FOREIGN_LOCK, null, 2) + "\n",
    ops: [{ remove: "从来没装过" }],
  },
  {
    // ⚠️ 这个场景是**注入验证逼出来的**:上面那条的初始文件键序恰好已是字母序,
    // 于是"提前 return 不写盘"与"照样重写一遍"产出完全相同的字节,测试分辨不出来
    // ——把 remove 的提前 return 删掉,测试照样全绿(2026-08-21 实测)。
    // 键序**故意不排序**之后,两种实现的产出才会不同:上游不写(文件保持乱序),
    // 我们若照写就会把它重排成字母序,对用户是一次无谓的版本控制改动。
    name: "移除不存在的条目(初始键序未排序,不得改写文件)",
    initial:
      JSON.stringify(
        {
          version: 1,
          skills: {
            "zzz-installed-first": FOREIGN_LOCK.skills["someone-elses-skill"],
            "aaa-installed-later": FOREIGN_LOCK.skills["someone-elses-skill"],
          },
        },
        null,
        2,
      ) + "\n",
    ops: [{ remove: "从来没装过" }],
  },
  {
    // 对照组:同一份乱序文件,这次**真的写入**——上游会把键排成字母序。
    // 有它才说得清上面那条不是"我们永远不排序"。
    name: "乱序初始文件中新增条目:产出被排成字母序",
    initial:
      JSON.stringify(
        {
          version: 1,
          skills: {
            "zzz-installed-first": FOREIGN_LOCK.skills["someone-elses-skill"],
            "aaa-installed-later": FOREIGN_LOCK.skills["someone-elses-skill"],
          },
        },
        null,
        2,
      ) + "\n",
    ops: [{ add: ["mmm-new", GITEA_ENTRY] }],
  },
  {
    // 下面四个是上游"看不懂就整份重建"的档。本 app **有意分歧**:一个字节都不动。
    // Rust 侧对着这些 initial 断言"文件保持原样",所以必须把上游行为也录下来做对照。
    name: "更高版本 v2:上游整份丢弃重建(本 app 有意分歧)",
    initial: JSON.stringify({ ...FOREIGN_LOCK, version: 2 }, null, 2) + "\n",
    ops: [{ add: ["weekly-report", GITEA_ENTRY] }],
  },
  {
    name: "version 字段缺失",
    initial: JSON.stringify({ skills: {} }, null, 2) + "\n",
    ops: [{ add: ["weekly-report", GITEA_ENTRY] }],
  },
  {
    name: "version 非数字",
    initial: JSON.stringify({ version: "1", skills: {} }, null, 2) + "\n",
    ops: [{ add: ["weekly-report", GITEA_ENTRY] }],
  },
  {
    name: "JSON 损坏(合并冲突标记)",
    initial: "<<<<<<< HEAD\n{ 这不是合法 JSON\n",
    ops: [{ add: ["weekly-report", GITEA_ENTRY] }],
  },
  {
    name: "中文技能名作为键",
    initial: null,
    ops: [{ add: ["周报生成", GITEA_ENTRY] }],
  },
];

/**
 * hash 场景。每个是一组"文件名 → 内容",喂给上游 computeSkillFolderHash。
 *
 * 重点是 `排序分歧探针`:localeCompare 在 ICU 下会把连字符/下划线当作次要权重
 * (`a-b` 与 `ab` 的相对位置可能与字节序相反),而我们按字节序排。这组名字就是
 * 冲着那个差异去的——**如果两种排法真的等价,这组也会等价;一旦不等价,
 * Rust 侧的差分测试会立刻变红**,而不是等用户在真机上撞见。
 */
const HASH_CASES = [
  {
    name: "单文件",
    files: { "SKILL.md": "---\nname: x\n---\n正文\n" },
  },
  {
    name: "嵌套目录",
    files: {
      "SKILL.md": "a",
      "rules/one.md": "b",
      "rules/nested/two.md": "c",
    },
  },
  {
    name: "排序分歧探针:连字符/下划线/数字/大小写混排",
    files: {
      "a-b.md": "1",
      "ab.md": "2",
      "a_b.md": "3",
      "a.md": "4",
      "A.md": "5",
      "a1.md": "6",
      "a10.md": "7",
      "a2.md": "8",
      "a-.md": "9",
      "a b.md": "10",
      "-a.md": "11",
      "_a.md": "12",
      "1.md": "13",
    },
  },
  {
    name: "非 ASCII 文件名",
    files: { "周报.md": "中文内容", "SKILL.md": "x", "café.md": "é" },
  },
  {
    name: "二进制内容与空文件",
    files: { "SKILL.md": "x", "empty.txt": "", "bin.dat": " ÿ" },
  },
  {
    name: "排除 .git 与 node_modules,但保留 metadata.json",
    files: {
      "SKILL.md": "x",
      "metadata.json": '{"a":1}',
      ".git/config": "should be skipped",
      "node_modules/pkg/index.js": "should be skipped",
      ".hidden": "kept",
    },
  },
];

/**
 * 真实技能的文件名组合。合成场景再全,也不如一组真的文件名有说服力——
 * 这组取自 2026-08-20 用 `npx skills add vercel-labs/agent-skills` 装出来的
 * `vercel-react-best-practices`,`SKILL.md`(大写)与 `metadata.json` / `rules/*`
 * (小写)混在一起,**正是字节序与 collation 分歧的现场**:collation 下
 * `metadata.json` 落在 `AGENTS.md` 与 `README.md` 之间,字节序下它排在 `SKILL.md` 之后。
 *
 * 内容用占位符(我们要钉的是**排序口径**,不是上游仓库的具体正文——
 * 正文一变 hash 就变,fixture 会无谓地天天红)。
 */
const REAL_WORLD_FILES = {
  "SKILL.md": "skill body",
  "AGENTS.md": "agents body",
  "README.md": "readme body",
  "metadata.json": '{"version":"1.0.0"}',
  "rules/_template.md": "t",
  "rules/_sections.md": "s",
  "rules/js-early-exit.md": "e",
  "rules/rerender-memo.md": "m",
  "rules/async-parallel.md": "p",
};

const LOCK_PROBE = `import { addSkillToLocalLock, removeSkillFromLocalLock, getLocalLockPath } from "./local-lock.ts";
import { readFileSync, existsSync } from "node:fs";
const ops = JSON.parse(process.env.PROBE_OPS);
const cwd = process.env.PROBE_CWD;
for (const op of ops) {
  if (op.add) await addSkillToLocalLock(op.add[0], op.add[1], cwd);
  else if (op.remove) await removeSkillFromLocalLock(op.remove, cwd);
}
const p = getLocalLockPath(cwd);
process.stdout.write(JSON.stringify({
  exists: existsSync(p),
  bytes: existsSync(p) ? readFileSync(p, "utf-8") : null,
}));
`;

const HASH_PROBE = `import { computeSkillFolderHash } from "./local-lock.ts";
process.stdout.write(await computeSkillFolderHash(process.env.PROBE_DIR));
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
  const ws = mkdtempSync(join(tmpdir(), "skillsync-projlock-"));
  for (const f of UPSTREAM_FILES) download(f, join(ws, f));
  writeFileSync(join(ws, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(ws, "lock-probe.mjs"), LOCK_PROBE);
  writeFileSync(join(ws, "hash-probe.mjs"), HASH_PROBE);
  return ws;
}

function runNode(ws, script, env) {
  return execFileSync("node", ["--experimental-strip-types", script], {
    cwd: ws,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runLockScenario(ws, scenario) {
  const proj = mkdtempSync(join(tmpdir(), "skillsync-proj-"));
  const lockPath = join(proj, "skills-lock.json");
  if (scenario.initial !== null) writeFileSync(lockPath, scenario.initial, "utf-8");

  const out = runNode(ws, "lock-probe.mjs", {
    PROBE_OPS: JSON.stringify(scenario.ops),
    PROBE_CWD: proj,
  });
  const result = JSON.parse(out);
  rmSync(proj, { recursive: true, force: true });

  return {
    name: scenario.name,
    initial: scenario.initial,
    ops: scenario.ops,
    exists: result.exists,
    bytes: result.bytes,
  };
}

/** 内容一律按 UTF-8 落盘;二进制用码点 0-255 逐字节写,避免 fixture 里出现不可打印字符。 */
function materialize(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, Buffer.from(content, "utf-8"));
  }
}

function runHashCase(ws, hashCase) {
  const dir = mkdtempSync(join(tmpdir(), "skillsync-hash-"));
  materialize(dir, hashCase.files);
  const hash = runNode(ws, "hash-probe.mjs", { PROBE_DIR: dir }).trim();
  rmSync(dir, { recursive: true, force: true });
  return { name: hashCase.name, files: hashCase.files, hash };
}

const ws = setupWorkspace();
let recorded;
try {
  recorded = {
    upstreamVersion: UPSTREAM_VERSION,
    lockFileName: "skills-lock.json",
    schemaVersion: 1,
    scenarios: SCENARIOS.map((s) => runLockScenario(ws, s)),
    hashCases: HASH_CASES.map((c) => runHashCase(ws, c)),
    realWorld: runHashCase(ws, { name: "真实技能的文件名组合", files: REAL_WORLD_FILES }),
  };
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
  console.log(`已写入 ${FIXTURE}`);
  for (const s of recorded.scenarios) {
    console.log(`  [lock] ${s.name} → ${s.bytes === null ? "(无文件)" : `${s.bytes.length} 字节`}`);
  }
  for (const c of recorded.hashCases) {
    console.log(`  [hash] ${c.name} → ${c.hash.slice(0, 16)}…`);
  }
}
