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
    retryingDir: null,
    retryConfirmDir: null,
    retryError: null,
  });
}

/** 一次"claude-code 建成了、trae 那条被占位顶掉"的安装结果。 */
const OCCUPIED_ERROR = {
  code: "FS_LINK_OCCUPIED",
  message: "该工具的技能目录下已有同名技能,请先确认是否覆盖",
};
const partiallyFailed = (): InstallReport =>
  report({
    links: [
      { dir: "/home/u/.claude/skills", agents: ["claude-code"], result: { status: "linked", mode: "symlink" } },
      { dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "failed", error: OCCUPIED_ERROR } },
    ],
  });

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

  it("保留并分享:先 keepLocal 落稳,再以提交审核方式推改动(绝不直推)", async () => {
    // 这条路的前提就是"远端有新版":直推会把远端刚更新的版本顶掉——
    // M5 任务 1 起恒带 forceReview,合并交给技能库的评审流程
    let installCalls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      if (cmd === "skill_share_changes")
        return { kind: "submitted", mode: "reviewRequested", commitSha: "new", reviewUrl: "http://x/pulls/5" };
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
    // 分享确实发生,且发生在保留之后,且带着 forceReview
    const shared = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(shared?.[1].args.dirSlug).toBe("weekly-report");
    expect(shared?.[1].args.forceReview).toBe(true);
    expect(useInstall.getState().shareResult).toEqual({ mode: "reviewRequested" });
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

  it("从哪个源打开就装回哪个源:registryId 全程带着", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("dept-skill", "custom-1");
    await useInstall.getState().run();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect(call?.[1].args.registryId).toBe("custom-1");
  });

  it("「我的技能」的更新按记账的来源走,不跟着商店当前浏览的源", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().beginUpdate("dept-skill", ["claude-code"], "custom-1");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect(call?.[1].args.registryId).toBe("custom-1");
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

describe("逐条重试建链(安装当时没建成的)", () => {
  beforeEach(() => {
    reset();
    useInstall.setState({
      phase: "done",
      dirSlug: "weekly-report",
      report: partiallyFailed(),
    });
  });

  it("重试带上这条目录上的整组工具,先按不替换试", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_link_agents")
        return report({
          links: [{ dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "linked", mode: "symlink" } }],
        });
      return [];
    });

    await useInstall.getState().retryLink("/home/u/.trae/skills");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_link_agents");
    // 建链按目录做,一个目录可能服务多个工具:整组带上,不能只挑一个
    expect(call?.[1].args).toEqual({
      dirSlug: "weekly-report",
      agentIds: ["trae"],
      replaceOccupied: false,
    });
    // 成功的这条并回 report,列表里就不再显示它了
    expect(failedLinks(useInstall.getState().report)).toBe(0);
    expect(useInstall.getState().retryConfirmDir).toBeNull();
  });

  it("只并回这一条,其余目录的结局不被覆盖", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_link_agents")
        return report({
          links: [{ dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "linked", mode: "symlink" } }],
        });
      return [];
    });

    await useInstall.getState().retryLink("/home/u/.trae/skills");

    const links = useInstall.getState().report?.links ?? [];
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.dir === "/home/u/.claude/skills")?.result.status).toBe("linked");
  });

  it("撞上实体目录占位:升级成确认弹窗,不擅自替换", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_link_agents")
        return report({
          links: [{ dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "failed", error: OCCUPIED_ERROR } }],
        });
      return [];
    });

    await useInstall.getState().retryLink("/home/u/.trae/skills");

    expect(useInstall.getState().retryConfirmDir).toBe("/home/u/.trae/skills");
    // 第一次一定是不替换:没问过就动用户的目录是铁律 7 的红线
    const first = invoke.mock.calls.find(([cmd]) => cmd === "skill_link_agents");
    expect(first?.[1].args.replaceOccupied).toBe(false);
  });

  it("确认后才带 replaceOccupied 再来一次", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_link_agents")
        return report({
          links: [{ dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "failed", error: OCCUPIED_ERROR } }],
        });
      return [];
    });
    await useInstall.getState().retryLink("/home/u/.trae/skills");
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_link_agents")
        return report({
          links: [{ dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "linked", mode: "symlink" } }],
        });
      return [];
    });

    await useInstall.getState().confirmRetry();

    const calls = invoke.mock.calls.filter(([cmd]) => cmd === "skill_link_agents");
    expect(calls[calls.length - 1]?.[1].args.replaceOccupied).toBe(true);
    expect(useInstall.getState().retryConfirmDir).toBeNull();
    expect(failedLinks(useInstall.getState().report)).toBe(0);
  });

  it("取消确认:不发第二次请求,原状保留", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_link_agents")
        return report({
          links: [{ dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "failed", error: OCCUPIED_ERROR } }],
        });
      return [];
    });
    await useInstall.getState().retryLink("/home/u/.trae/skills");
    invoke.mockClear();

    useInstall.getState().cancelRetry();

    expect(useInstall.getState().retryConfirmDir).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("skill_link_agents", expect.anything());
    expect(failedLinks(useInstall.getState().report)).toBe(1);
  });
});

describe("已装记账的来源坐标(M4 一源多仓)", () => {
  beforeEach(() => {
    invoke.mockReset();
    useInstall.setState({ installed: new Map() });
  });

  it("refreshInstalled 必须把来源坐标一起收进来", async () => {
    // 少了这三个字段,cardState 就拿不到"这是哪个技能库装的",判定会**静默**退回
    // M3 口径:切到同源的另一个技能库时,那边的同名技能被标成「更新」,而点下去是替换。
    // 别的测试都直接 setState 塞 map,走不到这条路——这里是它唯一的护栏。
    invoke.mockResolvedValueOnce([
      {
        dirSlug: "weekly-report",
        commitSha: "aaa1111",
        contentHash: "sha256:mine",
        agents: [],
        installedAt: "",
        updatedAt: "",
        localModified: false,
        // owner 与 repo 取不同值:弄反了要能看出来
        sourceOwner: "design",
        sourceRepo: "design-skills",
        registryId: "company",
        sourceRemoved: false,
        unclaimed: false,
              links: [],
      },
    ]);

    await useInstall.getState().refreshInstalled();

    const record = useInstall.getState().installed.get("weekly-report");
    expect(record?.registryId).toBe("company");
    expect(record?.sourceOwner).toBe("design");
    expect(record?.sourceRepo).toBe("design-skills");
  });

  it("refreshInstalled 必须排除未认领与本地新建两档", async () => {
    // 它们不是从任何技能库获取的。混进这张 map,商店里的同名技能就会显示「已启用」
    // ——那是假话,用户装的是自己那个,不是库里这个。
    invoke.mockResolvedValueOnce([
      { ...row("from-library"), registryId: "company", sourceOwner: "skills", sourceRepo: "skills" },
      { ...row("npx-installed"), unclaimed: true },
      { ...row("my-draft"), localOnly: true },
    ]);

    await useInstall.getState().refreshInstalled();

    const map = useInstall.getState().installed;
    expect(map.has("from-library")).toBe(true);
    expect(map.has("npx-installed")).toBe(false);
    expect(map.has("my-draft")).toBe(false);
  });
});

function row(dirSlug: string) {
  return {
        dirSlug,
        commitSha: "",
        contentHash: "",
        agents: [],
        installedAt: "",
        updatedAt: "",
        localModified: false,
        sourceOwner: "",
        sourceRepo: "",
        registryId: "",
        sourceRemoved: false,
        libraryRemoved: false,
        unclaimed: false,
        localOnly: false,
        claimed: false,
              links: [],
  };
}
