import { describe, expect, it } from "vitest";

import { useDetailCollapse } from "./detail-collapse";

const KEY = "skillsync.detailWhereExpanded";

/**
 * 🔴 「默认收起」这条命题必须在**这个文件**里钉:store 是模块级单例,
 * `read()` 只在模块第一次求值时跑一次。别的测试文件里到处 `setState`,
 * 在那些文件里断言"默认值"只是在断言最后一次 setState 的结果。
 * 这个文件不写 localStorage 就 import,读到的就是真正的默认值。
 */
describe("详情面板「在哪」折叠状态", () => {
  it("从未设置过时默认收起(与「我的技能」三区默认展开刻意相反)", () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(useDetailCollapse.getState().whereExpanded).toBe(false);
  });

  it("展开会落盘,再收起也会落盘", () => {
    useDetailCollapse.getState().toggleWhere();
    expect(useDetailCollapse.getState().whereExpanded).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");

    useDetailCollapse.getState().toggleWhere();
    expect(useDetailCollapse.getState().whereExpanded).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
  });

  it("localStorage 抛异常时不拖垮页面(隐私模式/禁站点数据)", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("SecurityError");
    };
    try {
      expect(() => useDetailCollapse.getState().toggleWhere()).not.toThrow();
      // 存不下也要在本次会话内生效
      expect(useDetailCollapse.getState().whereExpanded).toBe(true);
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
