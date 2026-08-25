// @vitest-environment node
// 只读文件、不碰 DOM(与 no-hardcoded-text.test.ts 同款理由:jsdom 下
// import.meta.url 是 http:// 而非 file://,fileURLToPath 会直接抛错)。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import zhCN from "@/i18n/zh-CN.json";

/**
 * 「不合格的技能,界面能不能说出一句人话」的守卫。
 *
 * # 为什么读 fixture 而不是手抄一份清单
 *
 * `fixtures/share-validation-samples.json` 是**口径契约**:Rust 的
 * `core/skills.rs::validate_for_share` 有一条测试读它,这里也读它。手抄两份的话,
 * core 加了一档新的不合格理由、fixture 也跟着加了,而前端这份手抄清单不会知道
 * ——那一档在界面上就是**一片空白**(`t()` 拿不到键会把键名原样渲染出来)。
 * 这正是 CLAUDE.md 记的空转模式:两边各自全绿,口径却已经漂了。
 *
 * # 这条测试不校验判定逻辑
 *
 * 判定实现只有一处,在 Rust 里(`ShareBlock` 随 `installed_list` 一起下来)。
 * 前端不重算,所以这里只管一件事:**每一个可能出现的 `ShareBlock`,
 * 界面都有对应的文案**。
 */
const SAMPLES = fileURLToPath(
  new URL("../../fixtures/share-validation-samples.json", import.meta.url),
);

interface Sample {
  dir: string;
  name: string | null;
  description: string | null;
  expect: string;
  why: string;
}

const samples: Sample[] = (
  JSON.parse(readFileSync(SAMPLES, "utf8")) as { samples: Sample[] }
).samples;

const texts = zhCN as Record<string, string>;

describe("分享校验的每一档都有人话文案", () => {
  it("fixture 真的读到了(读空的话下面的断言全是空转)", () => {
    expect(samples.length).toBeGreaterThan(0);
    expect(new Set(samples.map((s) => s.expect)).size).toBeGreaterThan(1);
  });

  it("每一个 ShareBlock 字面量都能查到 mine.shareBlocked.*", () => {
    const kinds = new Set(samples.map((s) => s.expect));
    for (const kind of kinds) {
      if (kind === "ok") continue; // 合格那一档不需要文案
      const key = `mine.shareBlocked.${kind}`;
      expect(texts[key], `${key} 没有文案:界面会把键名原样显示给用户`).toBeTruthy();
    }
  });

  it("文案不能是占位式的空话 —— 用户要知道改哪里", () => {
    // 「这个技能不能分享」这种话等于没说。每一条都要短到能读、长到能指路。
    for (const [key, text] of Object.entries(texts)) {
      if (!key.startsWith("mine.shareBlocked.")) continue;
      expect(text.length, `${key} 太短,说不清该改什么`).toBeGreaterThan(10);
    }
  });

  it("core 侧的 skillMdUnreadable 也有文案 —— 它不在 fixture 里", () => {
    // ⚠️ fixture 只覆盖"SKILL.md 读得出来但内容不合格"这六档;读不出来那一档
    // 构造不出样本(它不是一组字段值,是一次读取失败)。**只按 fixture 补文案
    // 会漏掉它**,所以这里单独钉一条。
    expect(samples.some((s) => s.expect === "skillMdUnreadable")).toBe(false);
    expect(texts["mine.shareBlocked.skillMdUnreadable"]).toBeTruthy();
  });
});
