#!/usr/bin/env node
/**
 * 校验我们的技能发现规则与上游 vercel-labs/skills 的 discoverSkills 是否一致。
 *
 * 用法:
 *   node scripts/verify-skill-discovery.mjs           # 生成 fixture
 *   node scripts/verify-skill-discovery.mjs --check   # 只跑不写
 *   SKILLSYNC_UPSTREAM_DIR=/path/to/skills/src node scripts/verify-skill-discovery.mjs   # 用本地上游副本
 *
 * 做法:下面的 LAYOUTS 是一份声明式仓库布局清单,两边各自执行——
 * 本脚本把布局落到临时目录后调用上游 discoverSkills,把结果写进 fixture;
 * Rust 侧 tests/skills_upstream_fixture.rs 用同一份布局构造内存树跑自己的实现,断言两者一致。
 * 布局只写一遍,ground truth 来自上游真实执行,不存在"两边同源误读一起通过"的情况。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_VERSION = "v1.5.20";
const UPSTREAM_BASE = `https://raw.githubusercontent.com/vercel-labs/skills/${UPSTREAM_VERSION}/src`;
const UPSTREAM_FILES = [
  "skills.ts",
  "frontmatter.ts",
  "sanitize.ts",
  "types.ts",
  "plugin-manifest.ts",
  "local-lock.ts",
];
const FIXTURE = join(REPO, "src-tauri/tests/fixtures/upstream-discovery.json");
const CHECK_ONLY = process.argv.includes("--check");

/** 生成一个最小可用的 SKILL.md。 */
const md = (name, description = `${name} 的说明`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;

/**
 * 待验证的仓库布局。覆盖交接包 3.5 任务 3 要求的边界样例,以及发现规则的每条分支。
 * files 的键是仓库内相对路径,值是文件内容。
 */
const LAYOUTS = [
  {
    name: "根目录本身就是技能",
    files: { "SKILL.md": md("根技能"), "skills/其他/SKILL.md": md("其他技能") },
  },
  {
    name: "skills 目录下的扁平布局",
    files: { "skills/a/SKILL.md": md("甲"), "skills/b/SKILL.md": md("乙") },
  },
  {
    name: "skills 下按类目再分一层",
    files: { "skills/办公/周报/SKILL.md": md("周报"), "skills/研发/代码走查/SKILL.md": md("代码走查") },
  },
  {
    name: "三层嵌套且另有技能时不应被发现",
    files: { "skills/a/SKILL.md": md("甲"), "skills/太/深/了/SKILL.md": md("深藏") },
  },
  {
    name: "三层嵌套且别无所获时由递归兜底发现",
    files: { "杂物/很/深/的技能/SKILL.md": md("深藏") },
  },
  {
    name: "curated 与实验目录",
    files: {
      "skills/.curated/精选/SKILL.md": md("精选"),
      "skills/.experimental/实验/SKILL.md": md("实验"),
      "skills/.system/系统/SKILL.md": md("系统"),
    },
  },
  {
    name: "agent 约定目录",
    files: {
      ".claude/skills/克劳德/SKILL.md": md("克劳德"),
      ".github/skills/copilot/SKILL.md": md("copilot"),
      ".trae/skills/trae技能/SKILL.md": md("trae技能"),
    },
  },
  {
    name: "同名遮蔽",
    files: {
      "skills/dup/SKILL.md": md("重名技能", "来自 skills 目录"),
      ".claude/skills/dup/SKILL.md": md("重名技能", "来自 claude 目录"),
    },
  },
  {
    name: "技能目录内部还有技能时不再下探",
    files: { "skills/外层/SKILL.md": md("外层"), "skills/外层/内层/SKILL.md": md("内层") },
  },
  {
    name: "跳过 node_modules 与 dist",
    files: {
      "skills/正常/SKILL.md": md("正常"),
      "skills/node_modules/pkg/SKILL.md": md("不该出现"),
      "skills/dist/built/SKILL.md": md("也不该出现"),
    },
  },
  {
    name: "缺 description 的技能被跳过但不影响其他",
    files: {
      "skills/好的/SKILL.md": md("好的"),
      "skills/缺项/SKILL.md": "---\nname: 只有名字\n---\n正文\n",
    },
  },
  {
    name: "frontmatter 字段类型错误",
    files: {
      "skills/好的/SKILL.md": md("好的"),
      "skills/数字名/SKILL.md": "---\nname: 42\ndescription: d\n---\n",
    },
  },
  {
    name: "YAML 语法错误",
    files: {
      "skills/好的/SKILL.md": md("好的"),
      "skills/坏语法/SKILL.md": "---\nname: [没闭合\n---\n",
    },
  },
  {
    name: "完全没有 frontmatter",
    files: { "skills/好的/SKILL.md": md("好的"), "skills/纯文档/SKILL.md": "# 只是文档\n" },
  },
  {
    name: "空仓库",
    files: { "README.md": "# 空仓库\n" },
  },
  {
    name: "internal 技能默认隐藏",
    files: {
      "skills/公开/SKILL.md": md("公开"),
      "skills/内部/SKILL.md":
        "---\nname: 内部技能\ndescription: d\nmetadata:\n  internal: true\n---\n",
    },
  },
  {
    name: "名称含终端转义与多行描述",
    files: {
      "skills/花哨/SKILL.md":
        '---\nname: "\\e[31m红色\\e[0m"\ndescription: |\n  第一行\n  第二行\n---\n',
    },
  },
  {
    name: "CRLF 行尾",
    files: {
      "skills/win/SKILL.md": "---\r\nname: win\r\ndescription: 来自 Windows 仓库\r\n---\r\n正文\r\n",
    },
  },
];

const PROBE = `import { discoverSkills } from "./skills.ts";
import { relative } from "node:path";
const base = process.env.PROBE_BASE;
const skills = await discoverSkills(base);
process.stdout.write(
  JSON.stringify(
    skills.map((s) => ({
      name: s.name,
      description: s.description,
      dir: relative(base, s.path).split(/[\\\\/]/).join("/"),
    })),
  ),
);
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
  const ws = mkdtempSync(join(tmpdir(), "skillsync-discovery-"));
  for (const f of UPSTREAM_FILES) download(f, join(ws, f));
  writeFileSync(join(ws, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(ws, "probe.mjs"), PROBE);
  // 上游 skills.ts 唯一的外部依赖
  execFileSync("npm", ["install", "--silent", "--no-save", "--no-audit", "--no-fund", "yaml@2"], {
    cwd: ws,
    stdio: "pipe",
  });
  return ws;
}

function materialize(files) {
  const repo = mkdtempSync(join(tmpdir(), "skillsync-repo-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return repo;
}

const ws = setupWorkspace();
const cases = [];
try {
  for (const layout of LAYOUTS) {
    const repo = materialize(layout.files);
    try {
      const out = execFileSync(process.execPath, ["probe.mjs"], {
        cwd: ws,
        env: { ...process.env, PROBE_BASE: repo },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
      const expected = JSON.parse(out);
      cases.push({ name: layout.name, files: layout.files, expected });
      console.log(`  ✓ ${layout.name} → ${expected.map((s) => s.name).join(", ") || "(无)"}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(ws, { recursive: true, force: true });
}

if (!CHECK_ONLY) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        $comment: [
          "由 scripts/verify-skill-discovery.mjs 从上游 discoverSkills 的实际执行结果生成,请勿手改。",
          "files 是仓库布局,expected 是上游在该布局下发现的技能(顺序即优先级)。",
        ],
        source: { project: "vercel-labs/skills", version: UPSTREAM_VERSION, file: "src/skills.ts" },
        cases,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\n已写入 ${FIXTURE}`);
}
console.log(`\n完成:${cases.length} 个布局`);
