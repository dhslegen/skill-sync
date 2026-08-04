import { describe, expect, it } from "vitest";

import samples from "../../fixtures/slug-samples.json";
import { validSlug } from "./slug";

describe("validSlug", () => {
  /**
   * 与 Rust 侧共读同一份样本文件——**一份真相,两侧各测一次**。
   * 手抄两份的话,口径漂了两边照样各自全绿,那道护栏就是空转的。
   */
  it("与 fixtures/slug-samples.json 逐条一致", () => {
    expect(samples.samples.length).toBeGreaterThanOrEqual(15);
    for (const { slug, valid, why } of samples.samples) {
      expect(validSlug(slug), `${JSON.stringify(slug)}(${why})`).toBe(valid);
    }
  });

  it("超过 255 字符会被 sanitize 截断,因此不是不动点", () => {
    expect(validSlug("a".repeat(255))).toBe(true);
    expect(validSlug("a".repeat(256))).toBe(false);
  });
});
