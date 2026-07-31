import { beforeEach, describe, expect, it, vi } from "vitest";

import { failedLinks, linkedAgents, useInstall } from "./install";
import type { AcquireOutcome, InstallReport } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
const listen = vi.fn(async () => () => {});
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...(a as [])) }));

const AGENTS = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "trae", displayName: "Trae", installed: false, globalSkillsDir: "~/.trae/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "cursor", displayName: "Cursor", installed: true, globalSkillsDir: "~/.agents/skills", isUniversal: true, needsLink: false, disabled: false },
  ],
  canonicalDir: "~/.agents/skills",
};

const report = (over: Partial<InstallReport> = {}): InstallReport => ({
  dirName: "weekly-report",
  canonicalDir: "/home/u/.agents/skills/weekly-report",
  links: [{ dir: "/home/u/.claude/skills", agents: ["claude-code"], result: { status: "linked", mode: "symlink" } }],
  ...over,
});

function reset() {
  invoke.mockReset();
  listen.mockClear();
  useInstall.setState({
    phase: "idle",
    dirSlug: null,
    agents: [],
    selected: new Set(),
    stage: null,
    report: null,
    localKept: false,
    shareResult: null,
    precheck: null,
    error: null,
    installed: new Map(),
  });
}

describe("获取流程状态机", () => {
  beforeEach(reset);

  it("点安装先展开勾选,默认只勾已检测到的工具", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? AGENTS : null));

    await useInstall.getState().begin("weekly-report");

    const s = useInstall.getState();
    expect(s.phase).toBe("choosing");
    // 没装的工具不该被默认勾上 —— 勾了也建不成链接,只会在结果里报一堆失败
    expect([...s.selected]).toEqual(["claude-code", "cursor"]);
    // 磁盘还没被碰过
    expect(invoke).not.toHaveBeenCalledWith("skill_install", expect.anything());
  });

  it("设置页关掉的工具不进默认勾选(手动仍可勾)", async () => {
    const withDisabled = {
      ...AGENTS,
      agents: AGENTS.agents.map((a) =>
        a.name === "cursor" ? { ...a, disabled: true } : a,
      ),
    };
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? withDisabled : null));

    await useInstall.getState().begin("weekly-report");

    const s = useInstall.getState();
    expect([...s.selected]).toEqual(["claude-code"]);
    // 列表里 cursor 仍然在——开关只影响默认勾选,不把选项藏起来
    expect(s.agents.map((a) => a.name)).toContain("cursor");
  });

  it("确认后带着勾选的工具去装", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" } satisfies AcquireOutcome;
    });

    await useInstall.getState().begin("weekly-report");
    useInstall.getState().toggleAgent("trae");
    await useInstall.getState().run();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    const sent = call?.[1].args;
    expect(sent.dirSlug).toBe("weekly-report");
    expect([...sent.agentIds].sort()).toEqual(["claude-code", "cursor", "trae"]);
    // 首次调用不带 resolution:让 core 先做预检
    expect(sent.resolution).toBeUndefined();
    expect(useInstall.getState().phase).toBe("done");
  });

  it("core 说需要拍板时,停在冲突态且不重试", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      return {
        outcome: "needsDecision",
        precheck: { status: "locallyModified", installedSha: "aaa1111" },
      } satisfies AcquireOutcome;
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const s = useInstall.getState();
    expect(s.phase).toBe("conflict");
    expect(s.precheck).toEqual({ status: "locallyModified", installedSha: "aaa1111" });
    // 关键:不能自作主张再发一次带 resolution 的请求
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(1);
  });

  it("用户选了处置才带 resolution 重试", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      calls += 1;
      return calls === 1
        ? { outcome: "needsDecision", precheck: { status: "locallyModified", installedSha: "aaa" } }
        : { outcome: "installed", report: report(), localKept: true, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().run("keepLocal");

    const second = invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")[1];
    expect(second?.[1].args.resolution).toBe("keepLocal");
    expect(useInstall.getState().phase).toBe("done");
    expect(useInstall.getState().localKept).toBe(true);
  });

  it("保留并分享:先 keepLocal 落稳,再把改动推回去", async () => {
    let installCalls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      if (cmd === "skill_share_changes")
        return { mode: "pushed", commitSha: "new", reviewUrl: null };
      installCalls += 1;
      return installCalls === 1
        ? { outcome: "needsDecision", precheck: { status: "locallyModified", installedSha: "aaa" } }
        : { outcome: "installed", report: report(), localKept: true, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().keepLocalAndShare();

    // keepLocal 的重试带了 resolution
    const second = invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")[1];
    expect(second?.[1].args.resolution).toBe("keepLocal");
    // 分享确实发生,且发生在保留之后
    const shared = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(shared?.[1].args.dirSlug).toBe("weekly-report");
    expect(useInstall.getState().shareResult).toEqual({ mode: "pushed" });
    expect(useInstall.getState().phase).toBe("done");
  });

  it("保留那一步没成,绝不接着分享", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "skill_share_changes") return { mode: "pushed", commitSha: "n", reviewUrl: null };
      throw { code: "NET_UNREACHABLE", message: "连不上公司技能库,请确认已接入公司内网或 VPN" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().keepLocalAndShare();

    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share_changes")).toBe(false);
    expect(useInstall.getState().shareResult).toBeNull();
  });

  it("保留成功、分享失败:结果不能画成整体失败", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      if (cmd === "skill_share_changes")
        throw { code: "AUTH_REQUIRED", message: "分享前请先登录公司技能库" };
      return { outcome: "installed", report: report(), localKept: true, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().keepLocalAndShare();

    const s = useInstall.getState();
    expect(s.phase).toBe("done");
    expect(s.localKept).toBe(true);
    expect(s.shareResult && "error" in s.shareResult && s.shareResult.error.message).toContain(
      "登录",
    );
  });

  it("装完刷新已安装列表,卡片状态才跟得上", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list")
        return [{ dirSlug: "weekly-report", commitSha: "aaa1111", agents: [], installedAt: "", updatedAt: "", localModified: false }];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    expect(useInstall.getState().installed.get("weekly-report")).toEqual({
      commitSha: "aaa1111",
      localModified: false,
    });
  });

  it("每次安装用独立的进度频道,上一次的残余不会串进来", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const channels = listen.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("装失败给可读错误 + 允许重试", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      throw { code: "NET_UNREACHABLE", message: "连不上公司技能库,请确认已接入公司内网或 VPN" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const s = useInstall.getState();
    expect(s.phase).toBe("error");
    expect(s.error?.message).toContain("公司内网");
  });

  it("收不到进度事件也不该拦住安装", async () => {
    listen.mockRejectedValueOnce(new Error("no event bus"));
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    expect(useInstall.getState().phase).toBe("done");
  });

  it("取消回到初始态,不留残余", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? AGENTS : null));
    await useInstall.getState().begin("weekly-report");
    useInstall.getState().cancel();

    const s = useInstall.getState();
    expect(s.phase).toBe("idle");
    expect(s.dirSlug).toBeNull();
    expect(s.precheck).toBeNull();
  });

  it("读不到已安装列表时,商店照常可用", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await useInstall.getState().refreshInstalled();
    expect(useInstall.getState().installed.size).toBe(0);
  });
});

describe("结果摘要", () => {
  it("结果文案给显示名,不给内部标识", () => {
    // "已启用到 claude-code、trae" 是给机器看的名字,用户看到的应该是 Claude Code、Trae
    const r = report({
      links: [{ dir: "/a", agents: ["claude-code", "trae"], result: { status: "linked", mode: "symlink" } }],
    });
    expect(linkedAgents(r, AGENTS.agents)).toEqual(["Claude Code", "Trae"]);
    // 认不出来的标识原样保留,不该整项丢掉
    expect(linkedAgents(r, [])).toEqual(["claude-code", "trae"]);
  });

  it("数出建链失败的目录", () => {
    const r = report({
      links: [
        { dir: "/a", agents: ["claude-code"], result: { status: "linked", mode: "symlink" } },
        { dir: "/b", agents: ["trae"], result: { status: "failed", error: { code: "FS_OCCUPIED", message: "位置已被占用" } } },
      ],
    });
    expect(failedLinks(r)).toBe(1);
    // 失败的那个不该出现在"已启用到 …"里
    expect(linkedAgents(r)).toEqual(["claude-code"]);
  });

  it("同一位置(无需建链)不算成功也不算失败", () => {
    const r = report({ links: [{ dir: "/a", agents: ["cursor"], result: { status: "sameLocation" } }] });
    expect(failedLinks(r)).toBe(0);
    expect(linkedAgents(r)).toEqual([]);
  });
});
