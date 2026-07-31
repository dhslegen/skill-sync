import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSettings } from "./settings";
import type { AutoUpdate } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

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
  useSettings.setState({ agents: null, autoUpdate: null, error: null });
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
});
