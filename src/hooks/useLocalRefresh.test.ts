import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERIODIC_REFRESH_MS, refreshLocalFor, useLocalRefresh } from "./useLocalRefresh";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
let changedCb: (() => void) | null = null;
const eventUnlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    if (name === "local-skills://changed") changedCb = cb;
    return eventUnlisten;
  }),
}));

// 捕获注册进来的焦点回调,好在测试里手动触发
let windowVisible = true;
let focusCb: ((e: { payload: boolean }) => void) | null = null;
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (cb: (e: { payload: boolean }) => void) => {
      focusCb = cb;
      return unlistenSpy;
    },
    isVisible: async () => windowVisible,
  }),
}));

function reset() {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "installed_list") return [];
    if (cmd === "agents_detected") return { agents: [], canonicalDir: "" };
    return null;
  });
}

const sent = () => invoke.mock.calls.map(([cmd]) => cmd);

describe("按页刷新", () => {
  beforeEach(reset);

  it("我的技能页刷列表", async () => {
    refreshLocalFor("mine");
    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
  });

  it("商店页刷已装状态:技能可能在外部被删了,该显示「获取」而不是「已在电脑上」", async () => {
    refreshLocalFor("store");
    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
  });

  // 🔴 v7.3:「项目里的技能」升成独立一页之后必须一起接进这条刷新链路
  // ——它展示的同样是磁盘上的真实内容(项目根的 skills-lock.json),切到编辑器
  // 里删掉一个技能再切回来,不刷新就会一直显示一条已经不存在的行。
  it("项目页刷项目清单(v7.3:它已经是独立一页了)", async () => {
    refreshLocalFor("projects");
    await vi.waitFor(() => expect(sent()).toContain("project_list"));
    // 它与「我的技能」是两条链路,别顺手把另一条也发了
    expect(sent()).not.toContain("installed_list");
  });

  it("🔴 我的技能页顺带触发「可分享到」外源索引的被动兜底(v7 任务 7 修复轮 1,I3)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") {
        return [
          {
            dirSlug: "a",
            commitSha: "sha",
            contentHash: "sha256:old",
            agents: [],
            installedAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            localModified: false,
            sourceOwner: "vercel-labs",
            sourceRepo: "agent-skills",
            registryId: "plaza",
            sourceRemoved: false,
            libraryRemoved: false,
            relation: "draft",
            localPresent: true,
            sourceLabel: "vercel-labs/agent-skills",
            body: "/h/a",
            localHash: "sha256:old",
            tools: [],
            versions: [],
            shareBlocked: null,
            section: "shareable",
            review: null,
            libraryUrl: null,
            canonicalReaders: null,
          },
        ];
      }
      if (cmd === "agents_detected") return { agents: [], canonicalDir: "" };
      return null;
    });

    refreshLocalFor("mine");

    await vi.waitFor(() => expect(sent()).toContain("store_index"));
  });

  it("设置页不展示技能,一个请求都不该发", async () => {
    refreshLocalFor("settings");
    // 给足够的机会让异步请求发出来
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("刷新只写列表,不动正在开着的分享确认屏", async () => {
    // 用户切到编辑器看一眼再切回来,确认屏被关掉是不可接受的
    // (分享页整页已撤,这条守的是取代它的那一屏)
    useMySkills.setState({ shareTarget: { dirSlug: "my-notes" } });

    refreshLocalFor("mine");
    await vi.waitFor(() => expect(sent()).toContain("installed_list"));

    expect(useMySkills.getState().shareTarget).toEqual({ dirSlug: "my-notes" });
  });
});

describe("store 之间互不牵连", () => {
  beforeEach(reset);

  it("刷我的技能不会顺手重拉商店索引", async () => {
    refreshLocalFor("mine");
    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
    expect(sent()).not.toContain("store_index");
  });

  it("刷新失败不抛到调用方——它是锦上添花,挂掉不该让界面炸掉", async () => {
    invoke.mockImplementation(async () => {
      throw { code: "FS_TASK", message: "读取失败" };
    });
    expect(() => refreshLocalFor("mine")).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(useMySkills.getState().loadError?.code).toBe("FS_TASK");
    expect(useInstall.getState()).toBeDefined();
  });
});

describe("窗口焦点监听(级别 1)", () => {
  beforeEach(() => {
    reset();
    focusCb = null;
    unlistenSpy.mockReset();
    useUi.setState({ page: "store" });
  });

  it("**重获**焦点才刷新——方向反了的话,切走时刷新、切回来还是旧的", async () => {
    renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(focusCb).not.toBeNull());
    invoke.mockClear();

    // 失去焦点:什么都不该发生
    focusCb!({ payload: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();

    // 重获焦点:这才是"改完切回来"的那一刻
    focusCb!({ payload: true });
    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
  });

  it("刷的是切回来时所在的那一页,不是注册监听时的那一页", async () => {
    renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(focusCb).not.toBeNull());

    // act 包裹:zustand 的外部 setState 要经 React 重渲染才会更新 hook 里的 pageRef
    act(() => useUi.setState({ page: "mine" }));
    invoke.mockClear();
    focusCb!({ payload: true });

    // 判别信号是 `agents_detected`:商店页那一档只刷已装状态(installed_list),
    // 只有「我的技能」那一档会连 agent 显示名一起拉——拿 installed_list 断言的话
    // 两页都发它,这条测试就分不出刷的到底是哪一页(空转)。
    await vi.waitFor(() => expect(sent()).toContain("agents_detected"));
  });

  it("卸载时摘掉原生监听,不留野回调", async () => {
    const { unmount } = renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(focusCb).not.toBeNull());
    unmount();
    expect(unlistenSpy).toHaveBeenCalled();
  });
});

describe("文件监听(级别 3)", () => {
  beforeEach(() => {
    reset();
    changedCb = null;
    eventUnlisten.mockReset();
    useUi.setState({ page: "store" });
  });

  it("core 报来变更就刷新当前页——窗口有焦点时改动也能立刻反映", async () => {
    renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(changedCb).not.toBeNull());
    invoke.mockClear();

    changedCb!();

    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
  });

  it("刷的同样是此刻所在的那一页", async () => {
    renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(changedCb).not.toBeNull());

    act(() => useUi.setState({ page: "mine" }));
    invoke.mockClear();
    changedCb!();

    // 同上:用 agents_detected 才分得出是「我的技能」那一档(见上一条注释)
    await vi.waitFor(() => expect(sent()).toContain("agents_detected"));
  });

  it("卸载时退订,不留野回调", async () => {
    const { unmount } = renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(changedCb).not.toBeNull());
    unmount();
    expect(eventUnlisten).toHaveBeenCalled();
  });
});

// 0.6.x(2026-09-14 用户拍板「只读刷新恒定 5 分钟」):不能指望用户频繁点刷新。
// 与设置里「技能更新检查」档位分开——那个会**安装**,这个只读、从不装任何东西。
describe("5 分钟只读兜底刷新", () => {
  beforeEach(() => {
    reset();
    windowVisible = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.useFakeTimers();
    useStoreIndex.setState({ activeRegistry: "company", activeRepo: null });
    useProjects.setState({ loading: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  async function tick() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERIODIC_REFRESH_MS);
    });
  }

  it("间隔就是 5 分钟", () => {
    expect(PERIODIC_REFRESH_MS).toBe(5 * 60_000);
  });

  it("到点刷新当前页:项目页重读项目清单,不碰别页", async () => {
    useUi.setState({ page: "projects" });
    const { unmount } = renderHook(() => useLocalRefresh());
    invoke.mockClear();
    await tick();
    expect(sent()).toContain("project_list");
    expect(sent()).not.toContain("installed_list");
    unmount();
  });

  it("商店页:非强制检查技能库(head 没变就不下载),并重读已装状态", async () => {
    useUi.setState({ page: "store" });
    const { unmount } = renderHook(() => useLocalRefresh());
    invoke.mockClear();
    await tick();
    const indexCall = invoke.mock.calls.find(([cmd]) => cmd === "store_index");
    expect(indexCall?.[1]).toMatchObject({ args: { force: false } });
    expect(sent()).toContain("installed_list");
    unmount();
  });

  it("我的技能页:重扫本地并检查技能库", async () => {
    useUi.setState({ page: "mine" });
    const { unmount } = renderHook(() => useLocalRefresh());
    invoke.mockClear();
    await tick();
    expect(sent()).toContain("installed_list");
    expect(invoke.mock.calls.find(([cmd]) => cmd === "store_index")?.[1]).toMatchObject({ args: { force: false } });
    unmount();
  });

  it("🔴 只读:兜底刷新绝不安装任何东西", async () => {
    useUi.setState({ page: "mine" });
    const { unmount } = renderHook(() => useLocalRefresh());
    await tick();
    await tick();
    expect(sent().some((c) => /acquire|install_batch|skill_install|update_check_now/.test(c))).toBe(false);
    unmount();
  });

  it("页面被隐藏(缩到托盘)时暂停", async () => {
    useUi.setState({ page: "projects" });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const { unmount } = renderHook(() => useLocalRefresh());
    invoke.mockClear();
    await tick();
    expect(sent()).not.toContain("project_list");
    unmount();
  });

  it("窗口不可见时暂停(webview 未必把隐藏窗口报成 hidden,两道都查)", async () => {
    useUi.setState({ page: "projects" });
    windowVisible = false;
    const { unmount } = renderHook(() => useLocalRefresh());
    invoke.mockClear();
    await tick();
    expect(sent()).not.toContain("project_list");
    unmount();
  });

  it("设置页不刷新", async () => {
    useUi.setState({ page: "settings" });
    const { unmount } = renderHook(() => useLocalRefresh());
    invoke.mockClear();
    await tick();
    expect(sent()).toEqual([]);
    unmount();
  });

  it("卸载后定时器停掉", async () => {
    useUi.setState({ page: "projects" });
    const { unmount } = renderHook(() => useLocalRefresh());
    unmount();
    invoke.mockClear();
    await tick();
    expect(sent()).not.toContain("project_list");
  });
});
