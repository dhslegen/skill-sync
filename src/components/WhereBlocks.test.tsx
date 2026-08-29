import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bodyLocationText, WhereBlocks } from "./WhereBlocks";
import type { InstalledSkillView, Section } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

async function defaultInvoke(cmd: string, args?: unknown): Promise<unknown> {
  void args;
  if (cmd === "skill_reveal") return undefined;
  if (cmd === "open_library_url") return undefined;
  // setAgents 落地后会重刷 installed_list/agents_detected(useMySkills.load()
  // 与 useInstall.refreshInstalled()),给最小可用形状,不然那两次调用会抛异常
  // 把 setAgentsBusy/toolFailures 带偏。
  if (cmd === "installed_list") return [];
  if (cmd === "agents_detected") return { agents: [], canonicalDir: "" };
  return null;
}
const invoke = vi.fn(defaultInvoke);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

// 修 Zed 缺陷的 fixture:6 个 agent 共用统一技能目录是真实注册表形状
// (cline/dexto/kimi-code-cli/loaf/warp/zed),这里只取其中两个够用来证明
// "先比 canonical、不按目录反查"这条判定顺序。
const CANONICAL = "/h/.agents/skills";
const NAMES = new Map([
  ["claude-code", "Claude Code"],
  ["zed", "Zed"],
  ["cline", "Cline"],
  ["warp", "Warp"],
]);
const TOOL_DIRS = new Map([
  ["claude-code", "/h/.claude/skills"],
  // 🔴 刻意不把这两个从 toolDirs 里滤掉:正确性必须靠 bodyLocationText 内部
  // "先比 canonical"的判定顺序保证,不是靠"数据里没有它们"侥幸成立。
  ["zed", CANONICAL],
  ["cline", CANONICAL],
]);

describe("bodyLocationText", () => {
  it("本体住统一技能目录时不点名任何工具 —— 修掉「Zed 本体在这里」", () => {
    const text = bodyLocationText(`${CANONICAL}/x`, CANONICAL, NAMES, TOOL_DIRS);
    expect(text).toMatch(/统一技能目录/);
    expect(text).not.toMatch(/Zed|Cline|Warp/);
  });

  it("本体住工具目录时点名那一个工具", () => {
    const text = bodyLocationText("/h/.claude/skills/x", CANONICAL, NAMES, TOOL_DIRS);
    expect(text).toMatch(/Claude Code/);
  });

  it("两处路径都对不上时给中性话,不编造工具名", () => {
    const text = bodyLocationText("/h/somewhere/else/x", CANONICAL, NAMES, TOOL_DIRS);
    expect(text).not.toMatch(/Zed|Cline|Warp|Claude Code/);
    expect(text.length).toBeGreaterThan(0);
  });

  it("末尾斜杠不影响比较(canonicalDir 带尾斜杠)", () => {
    const text = bodyLocationText(`${CANONICAL}/x`, `${CANONICAL}/`, NAMES, TOOL_DIRS);
    expect(text).toMatch(/统一技能目录/);
  });

  it("Windows 反斜杠路径同样能正确判定", () => {
    const text = bodyLocationText(
      "C:\\Users\\u\\.claude\\skills\\x",
      "C:\\Users\\u\\.agents\\skills",
      NAMES,
      new Map([["claude-code", "C:\\Users\\u\\.claude\\skills"]]),
    );
    expect(text).toMatch(/Claude Code/);
  });

  it("agentNames 里查不到显示名时退回内部 agent 名而不是崩溃", () => {
    const text = bodyLocationText(
      "/h/.claude/skills/x",
      CANONICAL,
      new Map(),
      new Map([["claude-code", "/h/.claude/skills"]]),
    );
    expect(text).toMatch(/claude-code/);
  });
});

function mk(
  dirSlug: string,
  section: Section,
  over: Partial<InstalledSkillView> = {},
): InstalledSkillView {
  const relation: InstalledSkillView["relation"] =
    section === "sharedTo" ? "shared" : section === "shareable" ? "draft" : "installed";
  return {
    dirSlug,
    commitSha: "a1b2c3d",
    contentHash: "sha256:base",
    agents: ["claude-code"],
    installedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    localModified: false,
    sourceOwner: "skills",
    sourceRepo: "skills",
    registryId: "company",
    sourceRemoved: false,
    libraryRemoved: false,
    relation,
    localPresent: true,
    sourceLabel: "skills/skills",
    body: `${CANONICAL}/${dirSlug}`,
    localHash: "sha256:base",
    tools: [{ agent: "claude-code", state: "linked" }],
    versions: [],
    shareBlocked: null,
    section,
    review: null,
    ...over,
  };
}

beforeEach(() => {
  // 有的用例会用 invoke.mockImplementation(...) 整个换掉实现(测 skill_set_agents
  // 的 Differs 结果),mockClear 只清调用记录、不清实现——不 mockReset 的话
  // 下一条用例会带着上一条的假实现跑。
  invoke.mockReset();
  invoke.mockImplementation(defaultInvoke);
  useMySkills.setState({
    canonicalDir: CANONICAL,
    toolDirs: TOOL_DIRS,
    installedAgents: null,
    setAgentsBusy: null,
    toolFailures: null,
    setAgentsError: null,
    toolFailuresFor: null,
  });
  useStoreIndex.setState({ index: null });
});

describe("WhereBlocks", () => {
  it("三块都在,顺序是 这台电脑上 → 各个工具里 → 技能库里", () => {
    render(<WhereBlocks skill={mk("x", "installedFrom")} agentNames={NAMES} />);
    const titles = screen.getAllByTestId("where-title").map((e) => e.textContent);
    expect(titles).toEqual(["这台电脑上", "各个工具里", "技能库里"]);
  });

  it("块 1:本体住统一目录时,「这台电脑上」不点名任何工具,且路径原样展示", () => {
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} />);
    expect(screen.getByText(/统一技能目录/)).toBeInTheDocument();
    expect(screen.getByText(`${CANONICAL}/weekly-report`)).toBeInTheDocument();
    expect(screen.queryByText(/Zed 本体在这里/)).not.toBeInTheDocument();
  });

  it("块 1:「打开文件夹」传 body(本体绝对路径),绝不传 dirSlug", async () => {
    const user = userEvent.setup();
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("skill_reveal", expect.anything()));
    const call = invoke.mock.calls.find((c) => c[0] === "skill_reveal");
    expect(call?.[1]).toEqual({ args: { path: `${CANONICAL}/weekly-report` } });
  });

  it("块 1:打开文件夹失败要显示错误,不能静默吞掉", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_reveal") throw { code: "FS_NOT_A_SKILL", message: "那不是一个技能目录" };
      return null;
    });
    const user = userEvent.setup();
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(await screen.findByText(/那不是一个技能目录/)).toBeInTheDocument();
  });

  it("块 1:本体不在这台电脑上时,给出对应文案,不显示路径与打开按钮", () => {
    render(
      <WhereBlocks
        skill={mk("gone", "sharedTo", { localPresent: false, body: "", tools: [] })}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByText("这台电脑上没有这个技能的文件")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开文件夹" })).not.toBeInTheDocument();
  });

  it("块 2:内容委托给 ToolChecks,不是裸拼一份新的 checkbox 列表", () => {
    render(
      <WhereBlocks
        skill={mk("weekly-report", "installedFrom", {
          tools: [
            { agent: "claude-code", state: "linked" },
            { agent: "zed", state: "off" },
          ],
        })}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Claude Code/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Zed/ })).not.toBeChecked();
  });

  it("块 2:没有本体、没有工具可显示时给中性提示,不是空白", () => {
    render(
      <WhereBlocks
        skill={mk("gone", "sharedTo", { localPresent: false, body: "", tools: [] })}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByText("这台电脑上没有本体,暂时没有工具在用它")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  // 修复轮 1 Critical-1:setAgents 的失败此前只写进 store,详情面板里没有渲染点
  // ——点一个勾遇到 Differs(位置被一份内容不同的东西占着),用户看到的是勾自己
  // 弹回未选中、零错误、零提示。这几条钉住"这里必须有自己的渲染点"这件事。
  describe("块 2:setAgents 的失败必须有渲染点(修复轮 1 Critical-1)", () => {
    it("点勾遇到 Differs 时,显示「需要你看一下」+ 占用说明,且「打开文件夹」能点开占用的位置", async () => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "skill_set_agents") {
          return {
            outcome: "done",
            homeBody: `${CANONICAL}/weekly-report`,
            canonical: { Ok: { kind: "unchanged" } },
            results: [
              [
                "zed",
                { Ok: { kind: "differs", existing: "/h/.zed/skills/weekly-report" } },
              ],
            ],
            unlinked: [],
            unlinkFailed: [],
          };
        }
        if (cmd === "installed_list") return [];
        if (cmd === "agents_detected") return { agents: [], canonicalDir: "" };
        return null;
      });
      const user = userEvent.setup();
      render(
        <WhereBlocks
          skill={mk("weekly-report", "installedFrom", {
            tools: [
              { agent: "claude-code", state: "linked" },
              { agent: "zed", state: "off" },
            ],
          })}
          agentNames={NAMES}
        />,
      );
      await user.click(screen.getByRole("checkbox", { name: /Zed/ }));
      expect(await screen.findByText("有 1 处需要你看一下")).toBeInTheDocument();
      expect(screen.getByText(/Zed 那个位置上已经有一份内容不同的技能/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "打开 Zed 那个位置的文件夹" }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "skill_reveal",
          expect.objectContaining({ args: { path: "/h/.zed/skills/weekly-report" } }),
        ),
      );
    });

    it("勾选中的动作正在处理时,ToolChecks 的 checkbox 整体禁用(不传 disabled 会连点打架)", () => {
      useMySkills.setState({ setAgentsBusy: "weekly-report" });
      render(
        <WhereBlocks
          skill={mk("weekly-report", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES}
        />,
      );
      expect(screen.getByRole("checkbox", { name: /Claude Code/ })).toBeDisabled();
    });

    it("请求本身失败(抛错)时也要有渲染点,与 Differs 是不同的量", () => {
      useMySkills.setState({
        setAgentsError: { code: "FS_LINK_FAILED", message: "统一目录那一处没配上" },
        toolFailuresFor: "weekly-report",
      });
      render(
        <WhereBlocks
          skill={mk("weekly-report", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES}
        />,
      );
      expect(screen.getByText(/没能改动 AI 工具的启用状态/)).toBeInTheDocument();
      expect(screen.getByText(/统一目录那一处没配上/)).toBeInTheDocument();
    });

    // R19:跨技能状态泄漏——toolFailures/setAgentsError 是全局字段,不按
    // toolFailuresFor 过滤的话,对技能 A 打勾失败后不点「知道了」就打开技能 B
    // 的详情,B 的面板会显示 A 的占用路径。拆成两条独立的 it(而不是同一条里
    // 先后 render 两次):协调者要单独回报"A 的面板看得到"那条是否保持绿,
    // 合在一条里的话,注入让"B 看不到"红了之后,断言会在同一条测试内**提前
    // 中断**,"A 看得到"那半永远跑不到、也就永远不知道它是不是保持绿。
    it("技能 A 的失败不会泄漏进技能 B 的面板(跨技能状态泄漏,R19)", () => {
      useMySkills.setState({
        toolFailures: [{ kind: "differs", agent: "zed", existing: "/h/.zed/skills/skill-a" }],
        toolFailuresFor: "skill-a",
      });

      render(
        <WhereBlocks
          skill={mk("skill-b", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES}
        />,
      );
      expect(screen.queryByText("有 1 处需要你看一下")).not.toBeInTheDocument();
    });

    // 正对照:同一份 store 状态,渲染的是它真正归属的技能 A,必须看得到
    // ——否则"哪儿都不显示"这种坏实现也能让上面那条断言通过。
    it("技能 A 自己的面板看得到自己的失败(正对照,防「哪儿都不显示」蒙混过关)", () => {
      useMySkills.setState({
        toolFailures: [{ kind: "differs", agent: "zed", existing: "/h/.zed/skills/skill-a" }],
        toolFailuresFor: "skill-a",
      });

      render(
        <WhereBlocks
          skill={mk("skill-a", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES}
        />,
      );
      expect(screen.getByText("有 1 处需要你看一下")).toBeInTheDocument();
      expect(screen.getByText(/Zed 那个位置上已经有一份内容不同的技能/)).toBeInTheDocument();
    });
  });

  it("块 3:显示这个技能在公司技能库里的分区与来源", () => {
    render(<WhereBlocks skill={mk("weekly-report", "sharedTo")} agentNames={NAMES} />);
    expect(screen.getByText("已分享到技能库")).toBeInTheDocument();
    expect(screen.getByText("来源 skills/skills")).toBeInTheDocument();
  });

  it("块 3:草稿(还没分享过)不编造来源,说清还没分享到任何技能库", () => {
    render(
      <WhereBlocks
        skill={mk("draft-x", "shareable", { sourceLabel: null })}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByText("可分享到技能库")).toBeInTheDocument();
    expect(screen.getByText("还没有分享到任何技能库")).toBeInTheDocument();
  });

  it("块 3:确定库里有新版本时才说「有新版本」,复用既有的唯一判定 hasUpdate", () => {
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "z",
        committedAt: "2026-08-20T00:00:00.000Z",
        fetchedAt: 1,
        skills: [{ dirSlug: "weekly-report", contentHash: "sha256:newer" } as never],
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
      },
    });
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} />);
    expect(screen.getByText("技能库里有新版本")).toBeInTheDocument();
  });

  it("块 3:内容指纹一致时不显示「有新版本」,不猜", () => {
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "z",
        committedAt: "2026-08-20T00:00:00.000Z",
        fetchedAt: 1,
        skills: [{ dirSlug: "weekly-report", contentHash: "sha256:base" } as never],
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
      },
    });
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} />);
    expect(screen.queryByText("技能库里有新版本")).not.toBeInTheDocument();
  });

  it("块 3:审核中且有链接时可点开查看,调用 open_library_url", async () => {
    const user = userEvent.setup();
    render(
      <WhereBlocks
        skill={mk("weekly-report", "shareable", {
          review: { url: "http://gitea.local/skills/skills/pulls/9" },
        })}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByText("审核中")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看审核" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "open_library_url",
        expect.objectContaining({ args: { url: "http://gitea.local/skills/skills/pulls/9" } }),
      ),
    );
  });

  it("块 3:审核中但 url 为 null(直推留下的记录)时,「审核中」照摆,不用空串冒充链接", () => {
    render(
      <WhereBlocks
        skill={mk("weekly-report", "shareable", { review: { url: null } })}
        agentNames={NAMES}
      />,
    );
    expect(screen.getByText("审核中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看审核" })).not.toBeInTheDocument();
  });

  it("三块外层左右留白与元信息行一致(px-5)", () => {
    const { container } = render(
      <WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} />,
    );
    expect(container.firstElementChild?.className).toContain("px-5");
  });
});
