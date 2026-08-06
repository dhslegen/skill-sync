#!/usr/bin/env node
/**
 * 从技能库 clone 的 git 历史生成库根 authors.json(M7 任务 3,库侧维护工具)。
 *
 * 用法:
 *   node scripts/gen-authors.mjs /path/to/skills-repo-clone           # 生成并写回 clone 根(有变化才写)
 *   node scripts/gen-authors.mjs /path/to/skills-repo-clone --check   # 只打印结果,不写文件
 *
 * 归因语义(与 App 侧 core/store.rs::parse_authors 的契约一致,改形状两边一起改):
 *   - 作者     = 该技能目录路径下最早那条提交的作者(%an,只取名字,不取邮箱);
 *   - 贡献者   = 其余提交的作者去重(不含作者本人),按提交次数降序,次数相同按首次出现先后。
 *
 * 产出形状:{"authors": {"<技能目录名>": {"author": "…", "contributors": ["…"]}}}
 *   - 键按目录名排序,保证重复运行产出稳定、diff 干净;
 *   - contributors 为空时省略该字段(App 侧 serde default 补空,文件更瘦)。
 *
 * 防自触发循环:本脚本用于 push 触发的自动化(Actions/webhook/cron 皆可)时,
 *   1) 产出与库里现有 authors.json 逐字节相同则不写文件(调用方据此跳过提交);
 *   2) authors.json 在库根、不在任何 skills/<dir>/ 之下,机器人提交它永远不会
 *      进入任何技能的归因——两道保险相互独立。
 *
 * 本脚本是维护工具,跑在库侧/管理员机器上;架构铁律"禁止 git"只约束 App 本体。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHECK_ONLY = process.argv.includes("--check");
const repoRoot = process.argv.filter((a) => !a.startsWith("--"))[2];
if (!repoRoot || !existsSync(join(repoRoot, ".git"))) {
  console.error("用法:node scripts/gen-authors.mjs /path/to/skills-repo-clone [--check]");
  console.error("(参数必须指向一个 git clone 的根目录)");
  process.exit(2);
}

/** 技能所在子目录,与技能库真实布局 skills/<slug>/SKILL.md 一致。 */
const SKILLS_SUBDIR = process.env.SKILLS_SUBDIR ?? "skills";

const skillsDir = join(repoRoot, SKILLS_SUBDIR);
if (!existsSync(skillsDir)) {
  console.error(`找不到技能目录:${skillsDir}(可用 SKILLS_SUBDIR 覆盖)`);
  process.exit(2);
}

const slugs = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
  .map((e) => e.name)
  .sort();

const authors = {};
for (const slug of slugs) {
  // --reverse:最早的提交排第一;路径过滤下 git 默认做历史简化,merge 提交不进列表。
  // 只要 %an(名字),邮箱从一开始就不进产物——隐私在数据源头掐掉。
  const out = execFileSync(
    "git",
    ["-C", repoRoot, "log", "--format=%an", "--reverse", "--", `${SKILLS_SUBDIR}/${slug}`],
    { encoding: "utf8" },
  );
  const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    // 目录在工作区但没有任何提交(比如刚 add 未 commit):没有历史就没有归因,跳过不编造
    console.error(`跳过 ${slug}:路径下没有提交历史`);
    continue;
  }
  const author = names[0];
  const counts = new Map();
  for (const n of names.slice(1)) {
    if (n !== author) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  // 次数降序;Map 迭代保插入序,次数相同自然按首次出现先后
  const contributors = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  authors[slug] = contributors.length > 0 ? { author, contributors } : { author };
}

const text = `${JSON.stringify({ authors }, null, 2)}\n`;
const target = join(repoRoot, "authors.json");
const before = existsSync(target) ? readFileSync(target, "utf8") : null;

if (before === text) {
  console.log("authors.json 无变化,不写文件");
  process.exit(0);
}
if (CHECK_ONLY) {
  console.log(text);
  console.log(`--check:不写文件(${before === null ? "库里还没有 authors.json" : "与库里现有内容不同"})`);
  process.exit(0);
}
writeFileSync(target, text);
console.log(`已写 ${target}(${slugs.length} 个技能,${Object.keys(authors).length} 条归因)`);
