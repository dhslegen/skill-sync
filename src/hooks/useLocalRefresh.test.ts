import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { refreshLocalFor, useLocalRefresh } from "./useLocalRefresh";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useShare } from "@/store/share";
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
let focusCb: ((e: { payload: boolean }) => void) | null = null;
const unlistenSpy = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (cb: (e: { payload: boolean }) => void) => {
      focusCb = cb;
      return unlistenSpy;
    },
  }),
}));

function reset() {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "installed_list") return [];
    if (cmd === "share_candidates") return [];
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
    expect(sent()).not.toContain("share_candidates");
  });

  it("分享页刷候选——那是改完 SKILL.md 后最该更新的一处", async () => {
    refreshLocalFor("share");
    await vi.waitFor(() => expect(sent()).toContain("share_candidates"));
  });

  it("商店页刷已装状态:技能可能在外部被删了,该显示「获取」而不是「已启用」", async () => {
    refreshLocalFor("store");
    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
    expect(sent()).not.toContain("share_candidates");
  });

  it("设置页不展示技能,一个请求都不该发", async () => {
    refreshLocalFor("settings");
    // 给足够的机会让异步请求发出来
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("刷新只写列表,不动正在填的分享表单", async () => {
    // 用户切到编辑器复制一段文字再切回来,表单被清空是不可接受的
    useShare.setState({
      phase: "form",
      form: { shareName: "my-notes", displayName: "我的笔记", description: "写了一半" },
    });

    refreshLocalFor("share");
    await vi.waitFor(() => expect(sent()).toContain("share_candidates"));

    expect(useShare.getState().phase).toBe("form");
    expect(useShare.getState().form.description).toBe("写了一半");
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
    useUi.setState({ page: "share" });
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
    await vi.waitFor(() => expect(sent()).toContain("share_candidates"));
  });

  it("刷的是切回来时所在的那一页,不是注册监听时的那一页", async () => {
    renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(focusCb).not.toBeNull());

    // act 包裹:zustand 的外部 setState 要经 React 重渲染才会更新 hook 里的 pageRef
    act(() => useUi.setState({ page: "mine" }));
    invoke.mockClear();
    focusCb!({ payload: true });

    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
    expect(sent()).not.toContain("share_candidates");
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
    useUi.setState({ page: "share" });
  });

  it("core 报来变更就刷新当前页——窗口有焦点时改动也能立刻反映", async () => {
    renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(changedCb).not.toBeNull());
    invoke.mockClear();

    changedCb!();

    await vi.waitFor(() => expect(sent()).toContain("share_candidates"));
  });

  it("刷的同样是此刻所在的那一页", async () => {
    renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(changedCb).not.toBeNull());

    act(() => useUi.setState({ page: "mine" }));
    invoke.mockClear();
    changedCb!();

    await vi.waitFor(() => expect(sent()).toContain("installed_list"));
    expect(sent()).not.toContain("share_candidates");
  });

  it("卸载时退订,不留野回调", async () => {
    const { unmount } = renderHook(() => useLocalRefresh());
    await vi.waitFor(() => expect(changedCb).not.toBeNull());
    unmount();
    expect(eventUnlisten).toHaveBeenCalled();
  });
});
