import { describe, expect, it } from "vitest";
import { t } from "./index";
import zhCN from "./zh-CN.json";

const texts = Object.entries(zhCN);

describe("i18n", () => {
  it("已有 key 返回中文文案", () => {
    expect(t("app.name")).toBe("SkillSync");
  });

  it("占位符按参数替换", () => {
    expect(t("store.updatedAt", { when: "3 天前" })).toBe("更新于 3 天前");
    expect(t("detail.tabFiles", { count: 4 })).toBe("文件 (4)");
  });

  it("缺参数时占位符原样保留,不静默变成 undefined", () => {
    expect(t("store.updatedAt")).toBe("更新于 {when}");
    expect(t("detail.tabFiles", { other: 1 })).toBe("文件 ({count})");
  });

  // ---- 术语与观感的自动门(docs/terminology.md + UI 规范 §2) ----
  //
  // 早先这条测试只拦 ASCII 子串,而 terminology.md 的禁用项大半是中文,
  // 商店页一次性落进几十条文案,靠人工 review 挡不住。

  it("文案不得出现 git 术语的英文写法", () => {
    // 词边界匹配:否则 "report" 会被 "repo" 误伤,而真正的术语照样拦得住
    const banned = /\b(commit|push|pull|fetch|branch|repo|repository|clone|merge|token)\b/i;
    for (const [key, text] of texts) {
      expect(banned.test(text), `${key}: ${text}`).toBe(false);
    }
  });

  it("文案不得出现 git 术语的中文写法", () => {
    // 「提交」只允许出现在「提交审核」里(terminology.md 对 PR 的指定说法)
    const banned = ["仓库", "分支", "拉取", "推送", "克隆", "合并", "代码库"];
    for (const [key, text] of texts) {
      for (const word of banned) {
        expect(text.includes(word), `${key}: ${text}`).toBe(false);
      }
      const commits = text.replace(/提交审核/g, "");
      expect(commits.includes("提交"), `${key} 出现了裸的「提交」: ${text}`).toBe(false);
    }
  });

  it("文案不得含 emoji(UI 规范 §2:全站禁 emoji)", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const [key, text] of texts) {
      expect(emoji.test(text), `${key}: ${text}`).toBe(false);
    }
  });

  it("按钮与提示文案不得为空", () => {
    for (const [key, text] of texts) {
      expect(text.trim().length, `${key} 是空文案`).toBeGreaterThan(0);
    }
  });
});
