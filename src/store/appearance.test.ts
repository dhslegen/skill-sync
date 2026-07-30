import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initAppearance, resolveTheme, useAppearance } from "./appearance";

/** 可控的 matchMedia:能主动派发 change 事件,用来验"跟随系统实时生效"。 */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let dark = initialDark;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return dark;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  return {
    setSystemDark(next: boolean) {
      dark = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

describe("resolveTheme", () => {
  it("显式两档不看系统偏好", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("跟随系统时听系统的", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("initAppearance", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
    useAppearance.setState({ mode: "light", accent: "clay", prefersDark: false });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
  });

  it("启动即把主题与强调色写到 <html>", () => {
    installMatchMedia(false);
    cleanup = initAppearance();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.accent).toBe("clay");
  });

  it("改强调色立刻反映到 <html>(整套换肤靠这个属性)", () => {
    installMatchMedia(false);
    cleanup = initAppearance();
    useAppearance.getState().setAccent("teal");
    expect(document.documentElement.dataset.accent).toBe("teal");
  });

  it("跟随系统档下,系统切深色时实时生效", () => {
    const media = installMatchMedia(false);
    cleanup = initAppearance();
    useAppearance.getState().setMode("system");
    expect(document.documentElement.dataset.theme).toBe("light");

    // 用户在系统设置里切到深色 —— 不重启应用也要跟着变(UI 规范 §6.5)
    media.setSystemDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("显式选了浅色时,系统切深色不该把界面掀过去", () => {
    const media = installMatchMedia(false);
    cleanup = initAppearance();
    useAppearance.getState().setMode("light");
    media.setSystemDark(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("清理函数摘掉系统主题监听,不留悬挂订阅", () => {
    const media = installMatchMedia(false);
    const dispose = initAppearance();
    expect(media.listenerCount).toBe(1);
    dispose();
    expect(media.listenerCount).toBe(0);
  });

  it("偏好写进 localStorage,重启后还在", () => {
    installMatchMedia(false);
    cleanup = initAppearance();
    useAppearance.getState().setMode("dark");
    useAppearance.getState().setAccent("ink");
    expect(localStorage.getItem("skillsync.theme")).toBe("dark");
    expect(localStorage.getItem("skillsync.accent")).toBe("ink");
  });

  it("顶栏那个按钮只在浅深之间切", () => {
    installMatchMedia(true);
    cleanup = initAppearance();
    // 从「跟随系统」且系统为深色出发,点一下应落到浅色而不是又回到 system
    useAppearance.setState({ mode: "system", prefersDark: true });
    useAppearance.getState().toggleTheme();
    expect(useAppearance.getState().mode).toBe("light");
    useAppearance.getState().toggleTheme();
    expect(useAppearance.getState().mode).toBe("dark");
  });
});
