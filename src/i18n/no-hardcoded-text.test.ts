// @vitest-environment node
// 这条守卫只读文件、不碰 DOM。jsdom 下 import.meta.url 是 http:// 而非 file://,
// fileURLToPath 会直接抛错,所以显式指定 node 环境。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 架构铁律 6 的自动门:用户可见文案一律走 i18n 资源,不得写死在组件里。
 *
 * `index.test.ts` 扫的是 zh-CN.json 的**值**——资源文件干干净净,组件里绕过 t() 直接写中文
 * 它一个字也看不见。任务 8 就正好踩在这个盲区上:错误消息在三处被硬编码,
 * 而同一个任务里还刚刚加强过那份守卫。
 *
 * 这里改扫**源码里的中文字符串字面量**。注释不算(项目要求注释写中文),
 * 所以先剥注释,再只看字面量。
 */

// fileURLToPath 而不是 .pathname:后者在 vitest 里会解析成相对路径 "/src"
const SRC = fileURLToPath(new URL("..", import.meta.url));
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 不扫的地方:i18n 资源本身、测试、测试前置。 */
function skip(path: string): boolean {
  // Windows 上 relative() 给的是反斜杠。不归一化的话下面的 "i18n/" 前缀判断会全部落空,
  // 于是本文件自己(测试里全是中文字面量)也被扫进去 —— 只有 Windows CI 会红,本机永远看不到。
  const rel = relative(SRC, path).split(sep).join("/");
  return (
    rel.startsWith("i18n/") ||
    rel.startsWith("test/") ||
    /\.test\.tsx?$/.test(rel)
  );
}

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      collect(path, out);
    } else if (/\.tsx?$/.test(name) && !skip(path)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * 极简扫描器:一边剥注释,一边收集字符串字面量。
 *
 * 只需要应付本项目自己的代码,不求通用——但必须先剥注释,否则中文注释会全员报警;
 * 也必须识别字面量边界,否则注释里的引号会把状态机带偏。
 */
export function stringLiterals(source: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      let value = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          value += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        value += source[i];
        i++;
      }
      i++;
      found.push(value);
      continue;
    }
    i++;
  }
  return found;
}

describe("架构铁律 6:文案不得写死在组件里", () => {
  const files = collect(SRC);

  it("扫到了源码文件(守卫本身别扫空)", () => {
    // 一旦目录结构变了导致扫不到东西,这条会先失败,而不是让守卫静默失效
    expect(files.length).toBeGreaterThan(15);
  });

  it("源码里没有中文字符串字面量", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
        if (CJK.test(literal)) {
          offenders.push(`${relative(SRC, file)}: ${JSON.stringify(literal.slice(0, 60))}`);
        }
      }
    }
    expect(offenders, `以下文案没走 i18n:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("stringLiterals", () => {
  it("剥掉行注释与块注释", () => {
    expect(stringLiterals('// 中文注释\nconst a = "x";')).toEqual(["x"]);
    expect(stringLiterals('/* 中文块注释 */ const a = "x";')).toEqual(["x"]);
  });

  it("注释里的引号不会把状态机带偏", () => {
    // 中文注释里出现「引号」很常见,不能让它吞掉后面的代码
    expect(stringLiterals('// 这里说的是 "某个值"\nconst a = "真实字面量";')).toEqual([
      "真实字面量",
    ]);
  });

  it("三种引号都认,转义不误判", () => {
    expect(stringLiterals("const a = 'x'; const b = `y`; const c = \"a\\\"b\";")).toEqual([
      "x",
      "y",
      'a"b',
    ]);
  });
});
