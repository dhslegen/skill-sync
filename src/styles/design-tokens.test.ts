// @vitest-environment node
// 只读文件不碰 DOM,理由同 no-hardcoded-text.test.ts。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 设计 token 拼写守卫。
 *
 * Tailwind v4 对**不存在的 token 静默不生成 CSS**:类名照常挂在元素上,样式却是空的。
 * 真实事故:首次启动向导写了 `bg-surface-0`(surface 只有 1/2/3),全屏层因此透明,
 * 向导文字与主界面叠在一起——测试全绿,只有眼睛看得见。
 *
 * 这里从 global.css 的 @theme 块提取真实存在的 color token,再扫组件里
 * `bg-/text-/border-` 前缀引用的自定义 token,对不上的直接红。
 * 标准色(white 等)与任意值语法(bg-[...])不在扫描范围。
 */

const root = join(fileURLToPath(import.meta.url), "..", "..");

function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSources(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

function themeColorTokens(): Set<string> {
  const css = readFileSync(join(root, "styles", "global.css"), "utf8");
  const theme = /@theme[^{]*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const tokens = new Set<string>();
  for (const m of theme.matchAll(/--color-([a-z0-9-]+)\s*:/g)) tokens.add(m[1]);
  return tokens;
}

// 我们的自定义 token 全是这些词开头;只有这样扫才不会把 text-left、border-t
// 这类 Tailwind 自带工具类误伤进来。
const CUSTOM_TOKEN_HEADS = ["surface", "bg", "text", "border", "accent", "ok"];

describe("设计 token 拼写守卫", () => {
  it("组件里引用的自定义 color token 必须真的存在于 @theme", () => {
    const tokens = themeColorTokens();
    expect(tokens.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of listSources(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:^|[\s"'`:])(?:bg|text|border)-([a-z][a-z0-9-]*)/g)) {
        const token = m[1];
        const head = token.split("-")[0];
        if (!CUSTOM_TOKEN_HEADS.includes(head)) continue;
        if (!tokens.has(token)) offenders.push(`${file.split("/src/")[1] ?? file}: ${m[0].trim()}`);
      }
    }
    expect(offenders, `引用了 @theme 里不存在的 token(Tailwind 会静默不生成样式):\n${offenders.join("\n")}`).toEqual([]);
  });
});
