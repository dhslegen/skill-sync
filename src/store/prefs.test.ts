import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppearance } from "./appearance";
import {
  bindAppearanceToConfig,
  markWizardDone,
  resetPrefsForTests,
  syncUiPrefs,
  WIZARD_DONE_KEY,
} from "./prefs";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

let unbind: (() => void) | undefined;

function reset() {
  invoke.mockReset();
  localStorage.clear();
  resetPrefsForTests();
  useAppearance.setState({ mode: "light", accent: "clay", prefersDark: false });
}

afterEach(() => {
  unbind?.();
  unbind = undefined;
});

describe("偏好落盘同步(config.json 为准,localStorage 只是缓存)", () => {
  beforeEach(reset);

  it("config 从未设置过:拿本机现状一次性迁移写入,含向导标记", async () => {
    // 主题与强调色取"档位序号不同"的组合,字段串位时才测得出来
    useAppearance.setState({ mode: "dark", accent: "teal" });
    localStorage.setItem(WIZARD_DONE_KEY, "1");
    invoke.mockImplementation(async (cmd) => (cmd === "ui_prefs_get" ? null : undefined));

    const result = await syncUiPrefs();

    expect(invoke).toHaveBeenCalledWith("ui_prefs_set", {
      args: { prefs: { theme: "dark", accent: "teal", wizardDone: true } },
    });
    expect(result).toEqual({ theme: "dark", accent: "teal", wizardDone: true });
  });

  it("config 有值:config 赢,回灌 store 并刷新本机缓存,且不触发一轮空写", async () => {
    unbind = bindAppearanceToConfig();
    localStorage.setItem("skillsync.theme", "light");
    invoke.mockImplementation(async (cmd) =>
      cmd === "ui_prefs_get" ? { theme: "dark", accent: "ink", wizardDone: false } : undefined,
    );

    await syncUiPrefs();

    expect(useAppearance.getState().mode).toBe("dark");
    expect(useAppearance.getState().accent).toBe("ink");
    expect(localStorage.getItem("skillsync.theme")).toBe("dark");
    expect(localStorage.getItem("skillsync.accent")).toBe("ink");
    // 回灌是 config → store 的单向动作,不该反弹出 ui_prefs_set
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("同步之后外观一变,完整偏好推进 config(其余字段不丢)", async () => {
    unbind = bindAppearanceToConfig();
    invoke.mockImplementation(async (cmd) =>
      cmd === "ui_prefs_get" ? { theme: "light", accent: "clay", wizardDone: true } : undefined,
    );
    await syncUiPrefs();
    invoke.mockClear();

    useAppearance.getState().setMode("dark");

    expect(invoke).toHaveBeenCalledWith("ui_prefs_set", {
      args: { prefs: { theme: "dark", accent: "clay", wizardDone: true } },
    });
  });

  it("向导完成:缓存与 config 双写", async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === "ui_prefs_get" ? { theme: "light", accent: "clay", wizardDone: false } : undefined,
    );
    await syncUiPrefs();
    invoke.mockClear();

    markWizardDone();

    expect(localStorage.getItem(WIZARD_DONE_KEY)).toBe("1");
    expect(invoke).toHaveBeenCalledWith("ui_prefs_set", {
      args: { prefs: { theme: "light", accent: "clay", wizardDone: true } },
    });
  });

  it("IPC 不可用:退回缓存行为,绝不拿猜的值写 config", async () => {
    unbind = bindAppearanceToConfig();
    invoke.mockRejectedValue(new Error("not in tauri"));

    const result = await syncUiPrefs();
    useAppearance.getState().setMode("dark");
    markWizardDone();

    expect(result).toBeNull();
    const setCalls = invoke.mock.calls.filter(([cmd]) => cmd === "ui_prefs_set");
    expect(setCalls).toHaveLength(0);
    // 缓存照常工作,本次会话内偏好仍然生效、向导不会再弹
    expect(localStorage.getItem(WIZARD_DONE_KEY)).toBe("1");
    expect(localStorage.getItem("skillsync.theme")).toBe("dark");
  });
});
