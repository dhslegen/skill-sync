import { describe, expect, it } from "vitest";

import { skillGlyph, skillHue } from "./tint";

describe("skillGlyph", () => {
  it("中文取首字,拉丁字母大写", () => {
    expect(skillGlyph("周报生成")).toBe("周");
    expect(skillGlyph("weekly-report")).toBe("W");
    expect(skillGlyph("Word 转 Markdown")).toBe("W");
  });

  it("按码点取字符,不会把 emoji 或代理对切一半", () => {
    // 名字来自技能库,不可信输入;按 UTF-16 下标取会切出乱码方块
    expect(skillGlyph("𝔸bc")).toBe("𝔸");
  });

  it("空名字给中性占位符而不是空白方块", () => {
    expect(skillGlyph("")).toBe("·");
    expect(skillGlyph("   ")).toBe("·");
  });
});

describe("skillHue", () => {
  it("同一个名字永远同色", () => {
    expect(skillHue("周报生成")).toBe(skillHue("周报生成"));
  });

  it("不同名字大概率不同色", () => {
    const hues = new Set(
      ["周报生成", "合同审查助手", "会议纪要整理", "Word 转 Markdown", "邮件润色"].map(skillHue),
    );
    expect(hues.size).toBeGreaterThan(3);
  });

  it("色相始终落在合法区间", () => {
    for (const name of ["", "a", "周报生成", "x".repeat(500)]) {
      const h = skillHue(name);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
