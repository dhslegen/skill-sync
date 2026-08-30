import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "skillsync.mineCollapsed";

/** 每个用例都重新求值模块——`useMineCollapse` 的初值是在模块顶层从
 *  localStorage 读的(与 `appearance.ts` 同一个先例),不重置模块就永远
 *  测不到"重启后读回来"那条路。 */
async function fresh() {
  vi.resetModules();
  return (await import("./mine-collapse")).useMineCollapse;
}

beforeEach(() => {
  localStorage.clear();
});

describe("我的技能三区的折叠状态", () => {
  it("默认全部展开:没有存过任何东西时 collapsed 是空的", async () => {
    const store = await fresh();
    expect(store.getState().collapsed).toEqual([]);
  });

  it("折叠会写进 localStorage,下次启动读得回来", async () => {
    const store = await fresh();
    store.getState().toggle("installedFrom");
    expect(store.getState().collapsed).toEqual(["installedFrom"]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(["installedFrom"]);

    const restarted = await fresh();
    expect(restarted.getState().collapsed).toEqual(["installedFrom"]);
  });

  it("再点一次展开,并把这件事也落下去", async () => {
    const store = await fresh();
    store.getState().toggle("sharedTo");
    store.getState().toggle("sharedTo");
    expect(store.getState().collapsed).toEqual([]);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual([]);
  });

  it("存量里坏掉的记录不拖垮页面:不是数组、不认识的区名一律当没折叠", async () => {
    localStorage.setItem(KEY, '"installedFrom"');
    expect((await fresh()).getState().collapsed).toEqual([]);
    localStorage.setItem(KEY, '["installedFrom","不认识的区"]');
    expect((await fresh()).getState().collapsed).toEqual(["installedFrom"]);
    localStorage.setItem(KEY, "{ 这不是 JSON");
    expect((await fresh()).getState().collapsed).toEqual([]);
  });

  it("localStorage 访问器自己抛错时(隐私模式)照常起得来、照常能折", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("nope");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("nope");
    });
    try {
      const store = await fresh();
      expect(store.getState().collapsed).toEqual([]);
      store.getState().toggle("shareable");
      // 存不下,但本次会话内仍然生效
      expect(store.getState().collapsed).toEqual(["shareable"]);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
