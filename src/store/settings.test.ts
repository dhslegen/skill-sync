import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSettings } from "./settings";
import type { AutoUpdate } from "@/lib/ipc";

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

const AGENTS = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "trae", displayName: "Trae", installed: true, globalSkillsDir: "~/.trae/skills", isUniversal: false, needsLink: true, disabled: true },
  ],
  canonicalDir: "~/.agents/skills",
};

const AUTO: AutoUpdate = { skills: { enabled: true, intervalHours: 4 }, app: true };

function seed() {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "agents_detected") return AGENTS;
    if (cmd === "auto_update_get") return AUTO;
    return undefined;
  });
}

function reset() {
  invoke.mockReset();
  seed();
  listeners.clear();
  useSettings.setState({
    agents: null,
    autoUpdate: null,
    error: null,
    lastReport: null,
    checking: false,
    appUpdate: { phase: "idle" },
  });
}

describe("设置 store", () => {
  beforeEach(reset);

  it("load 合并探测结果与更新配置", async () => {
    await useSettings.getState().load();

    const s = useSettings.getState();
    expect(s.agents).toHaveLength(2);
    expect(s.agents?.[1].disabled).toBe(true);
    expect(s.autoUpdate).toEqual(AUTO);
  });

  it("关掉一个 agent:整份禁用列表推给 core", async () => {
    await useSettings.getState().load();

    await useSettings.getState().toggleAgent("claude-code");

    // trae 原本就是关的,claude-code 新关:两个都在名单里
    expect(invoke).toHaveBeenCalledWith("agents_set_disabled", {
      args: { disabled: ["claude-code", "trae"] },
    });
  });

  it("重新打开:从禁用列表里移出", async () => {
    await useSettings.getState().load();

    await useSettings.getState().toggleAgent("trae");

    expect(invoke).toHaveBeenCalledWith("agents_set_disabled", { args: { disabled: [] } });
    expect(useSettings.getState().agents?.[1].disabled).toBe(false);
  });

  it("写入失败:状态回滚并亮出错误,不装作已生效", async () => {
    await useSettings.getState().load();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_set_disabled")
        throw { code: "STATE_WRITE_FAILED", message: "保存本地数据失败,请检查磁盘空间与权限" };
      return undefined;
    });

    await useSettings.getState().toggleAgent("claude-code");

    const s = useSettings.getState();
    expect(s.agents?.[0].disabled).toBe(false);
    expect(s.error?.message).toContain("保存本地数据失败");
  });

  it("切「手动」只关开关,频率保留——回头再打开档位还在", async () => {
    await useSettings.getState().load();

    await useSettings.getState().setSkillsUpdate({ enabled: false });

    expect(invoke).toHaveBeenCalledWith("auto_update_set", {
      args: { autoUpdate: { skills: { enabled: false, intervalHours: 4 }, app: true } },
    });
  });

  it("切「每天」写入 24 小时档", async () => {
    await useSettings.getState().load();

    await useSettings.getState().setSkillsUpdate({ enabled: true, intervalHours: 24 });

    expect(invoke).toHaveBeenCalledWith("auto_update_set", {
      args: { autoUpdate: { skills: { enabled: true, intervalHours: 24 }, app: true } },
    });
  });

  it("应用自更新开关翻转", async () => {
    await useSettings.getState().load();

    await useSettings.getState().setAppUpdate(false);

    expect(invoke).toHaveBeenCalledWith("auto_update_set", {
      args: { autoUpdate: { skills: { enabled: true, intervalHours: 4 }, app: false } },
    });
  });

  it("立即检查:发命令进入检查中,结果事件到达后落地并复位", async () => {
    await useSettings.getState().attachReportListener();

    await useSettings.getState().checkNow();
    expect(invoke).toHaveBeenCalledWith("update_check_now", undefined);
    expect(useSettings.getState().checking).toBe(true);

    const report = {
      status: "checked",
      headSha: "sha-2",
      updated: ["alpha"],
      skipped: [{ dirSlug: "beta", reason: "已安装且有你的本地改动,未覆盖" }],
      failed: [],
    };
    listeners.get("scheduler://report")?.({ payload: report });

    const s = useSettings.getState();
    expect(s.checking).toBe(false);
    expect(s.lastReport).toEqual(report);
  });

  it("App 自更新:检查到新版本 → 安装 → 提示重启", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "app_update_check") return { status: "available", version: "0.3.0" };
      return undefined;
    });

    await useSettings.getState().checkAppUpdate();
    expect(useSettings.getState().appUpdate).toEqual({ phase: "available", version: "0.3.0" });

    await useSettings.getState().installAppUpdate();
    expect(invoke).toHaveBeenCalledWith("app_update_install", undefined);
    // 安装完成不自动重启:用户可能正开着别的操作,由他自己决定什么时候切过去
    expect(useSettings.getState().appUpdate).toEqual({ phase: "installed" });
    expect(invoke).not.toHaveBeenCalledWith("app_restart", undefined);

    await useSettings.getState().restartApp();
    expect(invoke).toHaveBeenCalledWith("app_restart", undefined);
  });

  it("App 自更新:已是最新", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "app_update_check" ? { status: "upToDate" } : undefined,
    );

    await useSettings.getState().checkAppUpdate();

    expect(useSettings.getState().appUpdate).toEqual({ phase: "upToDate" });
  });

  it("App 自更新:后台已静默装好 → 检查直接提示重启,不谎报已最新", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "app_update_check" ? { status: "ready", version: "0.3.0" } : undefined,
    );

    await useSettings.getState().checkAppUpdate();

    expect(useSettings.getState().appUpdate).toEqual({ phase: "installed" });
  });

  it("App 自更新:安装失败保持当前版本并亮错误", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "app_update_check") return { status: "available", version: "0.3.0" };
      if (cmd === "app_update_install")
        throw { code: "UPDATE_INSTALL_FAILED", message: "应用更新安装失败,已保持当前版本" };
      return undefined;
    });
    await useSettings.getState().checkAppUpdate();

    await useSettings.getState().installAppUpdate();

    const s = useSettings.getState();
    expect(s.appUpdate.phase).toBe("failed");
    expect(s.appUpdate.phase === "failed" && s.appUpdate.error.message).toContain("保持当前版本");
  });

  it("命令失败时复位检查中并亮错误", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "update_check_now")
        throw { code: "AUTH_NOT_CONFIGURED", message: "这个版本没有配置公司技能库,请向 IT 索取正式安装包" };
      return undefined;
    });

    await useSettings.getState().checkNow();

    expect(useSettings.getState().checking).toBe(false);
    expect(useSettings.getState().error?.message).toContain("IT");
  });
});
