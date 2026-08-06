import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUpdatePrompt } from "./update-prompt";
import { useSettings } from "./settings";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));

/** 可触发的事件桩:按事件名收集回调,测试里手动派发。 */
const listeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

function reset() {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  listeners.clear();
  useUpdatePrompt.setState({ readyVersion: null, dismissed: false });
  useSettings.setState({ appUpdate: { phase: "idle" } });
}

describe("全局更新提示 store", () => {
  beforeEach(reset);

  it("ready 事件:版本落进 store,设置页联动到\"装完提示重启\"", async () => {
    await useUpdatePrompt.getState().attach();
    listeners.get("app-update://ready")?.({ payload: "0.3.0" });

    expect(useUpdatePrompt.getState().readyVersion).toBe("0.3.0");
    expect(useSettings.getState().appUpdate).toEqual({ phase: "installed" });
  });

  it("设置页正在手动安装时不打断它的状态机", async () => {
    useSettings.setState({ appUpdate: { phase: "installing", version: "0.3.0" } });
    await useUpdatePrompt.getState().attach();
    listeners.get("app-update://ready")?.({ payload: "0.3.0" });

    expect(useUpdatePrompt.getState().readyVersion).toBe("0.3.0");
    expect(useSettings.getState().appUpdate).toEqual({ phase: "installing", version: "0.3.0" });
  });

  it("暂不重启只管本次会话;更新的版本就绪时重新亮出来", async () => {
    await useUpdatePrompt.getState().attach();
    listeners.get("app-update://ready")?.({ payload: "0.3.0" });
    useUpdatePrompt.getState().dismiss();
    expect(useUpdatePrompt.getState().dismissed).toBe(true);

    // 0.3.0 就绪期间 0.3.1 又发布并装好了:那是一件新事,提示要回来
    listeners.get("app-update://ready")?.({ payload: "0.3.1" });
    expect(useUpdatePrompt.getState()).toMatchObject({ readyVersion: "0.3.1", dismissed: false });
  });

  it("立即重启调 app_restart", async () => {
    await useUpdatePrompt.getState().restart();
    expect(invoke).toHaveBeenCalledWith("app_restart", undefined);
  });
});
