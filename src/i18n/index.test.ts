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

  it("文案不得出现已撤销的功能术语(v6:「纳入管理/移出管理」整条链路已删除)", () => {
    // 不与上面的 git 术语共用同一份数组:这三个词不是 git 术语,与
    // docs/terminology.md 无关,是 v6 撤掉「认领」语义之后新增的项目内部禁词。
    // 别把 "npx" 也塞进来——RELEASE_NOTES.md 里「与 npx skills 完全互通」是
    // 合法的功能承诺,禁它是误伤(v6 任务 6 拍板)。
    const banned = ["纳入管理", "移出管理", "其他工具装的"];
    for (const [key, text] of texts) {
      for (const word of banned) {
        expect(text.includes(word), `${key}: ${text}`).toBe(false);
      }
    }
  });

  it("文案不得出现实现术语(v6 二期:用户只看「一个技能,三个在哪」)", () => {
    // 第三份独立禁词表,**刻意不与上面两份合并**:
    // - git 术语那份出自 docs/terminology.md(对外术语约定);
    // - 「纳入管理」那份是 v6 撤掉认领语义留下的;
    // - 这一份是 v6 二期撤掉「本体/链接」实现模型之后的产物。
    // 三份的存废理由各不相同,合并之后再想删其中一条就得连带论证另外两条。
    //
    // 「关联」是这批里影响面最大的一个:它把"技能在某个工具里能用"这件事
    // 说成了一个实现细节(建了一条链接),而用户要的说法是「在 X 里启用」。
    // 「修复关联」单列是因为它曾是一个按钮名——概念本身已撤销,不只是措辞问题。
    const banned = ["修复关联", "关联", "收编", "记账", "占位"];
    for (const [key, text] of texts) {
      for (const word of banned) {
        expect(text.includes(word), `${key}: ${text}`).toBe(false);
      }
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
