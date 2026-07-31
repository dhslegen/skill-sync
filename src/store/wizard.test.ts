import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetPrefsForTests } from "./prefs";
import { useWizard } from "./wizard";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const AGENTS = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true },
    { name: "trae", displayName: "Trae", installed: false, globalSkillsDir: "~/.trae/skills", isUniversal: false, needsLink: true },
  ],
  canonicalDir: "~/.agents/skills",
};

function reset() {
  invoke.mockReset();
  localStorage.clear();
  resetPrefsForTests();
  useWizard.setState({
    open: false,
    step: "agents",
    agents: [],
    selected: new Set(),
    seeded: false,
    installing: false,
    results: null,
    error: null,
  });
}

describe("首次启动向导状态机", () => {
  beforeEach(reset);

  it("没有完成标记:打开并检测工具", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? AGENTS : null));

    await useWizard.getState().maybeOpen();

    const s = useWizard.getState();
    expect(s.open).toBe(true);
    expect(s.step).toBe("agents");
    expect(s.agents).toHaveLength(2);
  });

  it("本机缓存有完成标记(config 不可用):不打开、不发向导相关请求", async () => {
    // config 读取失败 → 退回 localStorage 判定,与 M1 行为一致
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "ui_prefs_get") throw new Error("not in tauri");
      return null;
    });
    localStorage.setItem("skillsync.wizardDone", "1");

    await useWizard.getState().maybeOpen();

    expect(useWizard.getState().open).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("agents_detected");
  });

  it("config 说已完成:即便本机没有缓存标记也不打开(config 赢)", async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === "ui_prefs_get" ? { theme: "light", accent: "clay", wizardDone: true } : null,
    );

    await useWizard.getState().maybeOpen();

    expect(useWizard.getState().open).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("agents_detected");
  });

  it("完成写标记(缓存+config 双写),下次启动不再出现", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? AGENTS : null));
    await useWizard.getState().maybeOpen();

    useWizard.getState().finish();

    expect(useWizard.getState().open).toBe(false);
    expect(localStorage.getItem("skillsync.wizardDone")).toBe("1");
    expect(invoke).toHaveBeenCalledWith(
      "ui_prefs_set",
      expect.objectContaining({
        args: expect.objectContaining({ prefs: expect.objectContaining({ wizardDone: true }) }),
      }),
    );
    await useWizard.getState().maybeOpen();
    expect(useWizard.getState().open).toBe(false);
  });

  it("检测失败不拦向导 —— 第一步显示没检测到,后面照走", async () => {
    invoke.mockRejectedValue(new Error("boom"));

    await useWizard.getState().maybeOpen();

    expect(useWizard.getState().open).toBe(true);
    expect(useWizard.getState().agents).toHaveLength(0);
  });

  it("一键安装:勾选的技能 + 已检测到的工具", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_install_batch")
        return [{ dirSlug: "weekly-report", outcome: "installed", report: { dirName: "weekly-report", canonicalDir: "/c", links: [] } }];
      if (cmd === "installed_list") return [];
      return AGENTS;
    });
    useWizard.setState({ agents: AGENTS.agents, selected: new Set(["weekly-report"]) });

    await useWizard.getState().installSelected();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install_batch");
    expect(call?.[1].args.dirSlugs).toEqual(["weekly-report"]);
    // 没装的工具(trae)不该被带上——与获取流程的默认勾选同一口径
    expect(call?.[1].args.agentIds).toEqual(["claude-code"]);
    expect(useWizard.getState().results).toHaveLength(1);
  });

  it("什么都没勾:不发请求", async () => {
    useWizard.setState({ selected: new Set() });
    await useWizard.getState().installSelected();
    expect(invoke).not.toHaveBeenCalledWith("skill_install_batch", expect.anything());
  });

  it("安装失败给可读错误并允许重试", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_install_batch")
        throw { code: "NET_UNREACHABLE", message: "连不上公司技能库,请确认已接入公司内网或 VPN" };
      return AGENTS;
    });
    useWizard.setState({ agents: AGENTS.agents, selected: new Set(["weekly-report"]) });

    await useWizard.getState().installSelected();

    const s = useWizard.getState();
    expect(s.error?.message).toContain("公司内网");
    expect(s.installing).toBe(false);
    expect(s.results).toBeNull();
  });

  it("播种默认全选只发生一次 —— 用户取消的勾不会被刷新打回来", () => {
    useWizard.getState().seedSelection(["a", "b"]);
    expect([...useWizard.getState().selected].sort()).toEqual(["a", "b"]);

    useWizard.getState().toggle("a");
    useWizard.getState().toggle("b");
    expect(useWizard.getState().selected.size).toBe(0);

    useWizard.getState().seedSelection(["a", "b"]);
    expect(useWizard.getState().selected.size).toBe(0);
  });
});