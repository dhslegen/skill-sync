import { describe, expect, it } from "vitest";
import { t } from "./index";
import zhCN from "./zh-CN.json";

describe("i18n", () => {
  it("已有 key 返回中文文案", () => {
    expect(t("app.name")).toBe("SkillSync");
  });

  it("文案资源不得包含 git 术语(架构铁律 6)", () => {
    const banned = ["commit", "push", "pull", "branch", "repo", "clone", "merge"];
    for (const text of Object.values(zhCN)) {
      for (const word of banned) {
        expect(text.toLowerCase()).not.toContain(word);
      }
    }
  });
});
