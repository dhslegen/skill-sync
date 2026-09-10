import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactElement } from "react";

import { bodyLocationText, WhereBlocks, whereSummary } from "./WhereBlocks";
import type { InstalledSkillView, Section } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

async function defaultInvoke(cmd: string, args?: unknown): Promise<unknown> {
  void args;
  if (cmd === "skill_reveal") return undefined;
  if (cmd === "open_library_url") return undefined;
  // setAgents 落地后会重刷 installed_list/agents_detected(useMySkills.load()
  // 与 useInstall.refreshInstalled()),给最小可用形状,不然那两次调用会抛异常
  // 把 setAgentsBusy/toolFailures 带偏。
  if (cmd === "installed_list") return [];
  if (cmd === "agents_detected") return { agents: [], canonicalDir: "" };
  // 🔴 v7.6 任务 2:块 4「项目里」(`ProjectsBlock`)挂载即 `load()` 一次,
  // 必须**回读** `useProjects.getState().groups`,不能固定返回 `[]`——
  // 固定值会把用例刚 `setState` 喂的 groups 整体冲掉,变成 CLAUDE.md 记的
  // 那种"时绿时红"(`InstalledScopes.test.tsx` 当年就是这么写的,原样照抄)。
  if (cmd === "project_list") return useProjects.getState().groups;
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
    libraryUrl: null,
    canonicalReaders: null,
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
  // 🔴 v7.6 任务 2:块 4「项目里」读这个 store,每条用例显式重置——不重置的话
  // 上一条用例 `setState` 的 groups 会残留到下一条(全局单例,见 CLAUDE.md
  // 「注入脚本自己会骗人」附近那条"时绿时红"教训的同款处置)。
  useProjects.setState({ groups: [] });
  // 折叠头默认收起(v7.1 任务 3;v7.2 需求 3 起它是组件本地 state,不再有
  // 可以 setState 的 store)。下面这一大批用例断言的是**展开之后**的三块,
  // 所以统一走 {@link renderExpanded} 真点一下折叠头——这是给测试补一步交互,
  // 不是把断言放宽:"默认收起"这条命题由 describe("折叠头") 里自己的用例正面钉住。
});

/** 渲染并展开「在哪」折叠头。v7.2 起展开是组件本地 state,只能靠真点一下。 */
function renderExpanded(ui: ReactElement) {
  const r = render(ui);
  fireEvent.click(screen.getByTestId("where-toggle"));
  return r;
}

describe("WhereBlocks", () => {
  it("三块都在,顺序是 这台电脑上 → 各个工具里 → 技能库里", () => {
    renderExpanded(<WhereBlocks skill={mk("x", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    const titles = screen.getAllByTestId("where-title").map((e) => e.textContent);
    expect(titles).toEqual(["这台电脑上", "各个工具里", "技能库里"]);
  });

  it("块 1:本体住统一目录时,「这台电脑上」不点名任何工具,且路径原样展示", () => {
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    // 路径在折叠头上也有一份,所以断言范围收进展开出来的那三块
    const blocks = within(screen.getByTestId("where-blocks"));
    expect(blocks.getByText(/统一技能目录/)).toBeInTheDocument();
    expect(blocks.getByText(`${CANONICAL}/weekly-report`)).toBeInTheDocument();
    expect(screen.queryByText(/Zed 本体在这里/)).not.toBeInTheDocument();
  });

  // 🔴 原先这里有两条用例:「打开文件夹」传 body 不传 dirSlug、失败要有渲染点。
  // Q3 拍板把这个动作收进详情面板的固定页脚(同一个动作此前有两个入口两种叫法),
  // 所以**那两条命题原样搬去了 `SkillActionsBlock.test.tsx`**(见那边的
  // describe「打开文件夹(Q3:详情面板里只此一处)」),不是被删掉了。
  // 这里留一条负向断言,钉住"这一块里不再有第二个入口"。
  it("块 1:不再摆「打开文件夹」——那个动作只在页脚出现一次(Q3)", () => {
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.queryByRole("button", { name: "打开文件夹" })).not.toBeInTheDocument();
  });

  it("块 1:本体不在这台电脑上时,给出对应文案,不显示路径与打开按钮", () => {
    renderExpanded(
      <WhereBlocks
        skill={mk("gone", "sharedTo", { localPresent: false, body: "", tools: [] })}
        agentNames={NAMES} remoteChanged={false}
      />,
    );
    const blocks = within(screen.getByTestId("where-blocks"));
    expect(blocks.getByText("这台电脑上没有这个技能的文件")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开文件夹" })).not.toBeInTheDocument();
  });

  it("块 2:内容委托给 ToolChecks,不是裸拼一份新的 checkbox 列表", () => {
    renderExpanded(
      <WhereBlocks
        skill={mk("weekly-report", "installedFrom", {
          tools: [
            { agent: "claude-code", state: "linked" },
            { agent: "zed", state: "off" },
          ],
        })}
        agentNames={NAMES} remoteChanged={false}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Claude Code/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Zed/ })).not.toBeChecked();
  });

  it("块 2:没有本体、没有工具可显示时给中性提示,不是空白", () => {
    renderExpanded(
      <WhereBlocks
        skill={mk("gone", "sharedTo", { localPresent: false, body: "", tools: [] })}
        agentNames={NAMES} remoteChanged={false}
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
      renderExpanded(
        <WhereBlocks
          skill={mk("weekly-report", "installedFrom", {
            tools: [
              { agent: "claude-code", state: "linked" },
              { agent: "zed", state: "off" },
            ],
          })}
          agentNames={NAMES} remoteChanged={false}
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
      renderExpanded(
        <WhereBlocks
          skill={mk("weekly-report", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES} remoteChanged={false}
        />,
      );
      expect(screen.getByRole("checkbox", { name: /Claude Code/ })).toBeDisabled();
    });

    it("请求本身失败(抛错)时也要有渲染点,与 Differs 是不同的量", () => {
      useMySkills.setState({
        setAgentsError: { code: "FS_LINK_FAILED", message: "统一目录那一处没配上" },
        toolFailuresFor: "weekly-report",
      });
      renderExpanded(
        <WhereBlocks
          skill={mk("weekly-report", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES} remoteChanged={false}
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

      renderExpanded(
        <WhereBlocks
          skill={mk("skill-b", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES} remoteChanged={false}
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

      renderExpanded(
        <WhereBlocks
          skill={mk("skill-a", "installedFrom", {
            tools: [{ agent: "claude-code", state: "linked" }],
          })}
          agentNames={NAMES} remoteChanged={false}
        />,
      );
      expect(screen.getByText("有 1 处需要你看一下")).toBeInTheDocument();
      expect(screen.getByText(/Zed 那个位置上已经有一份内容不同的技能/)).toBeInTheDocument();
    });
  });

  it("块 3:显示这个技能在公司技能库里的分区与来源", () => {
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "sharedTo")} agentNames={NAMES} remoteChanged={false} />);
    // 区名在折叠头的结论行上也有一份,断言范围收进展开出来的三块
    const blocks = within(screen.getByTestId("where-blocks"));
    expect(blocks.getByText("已分享到技能库")).toBeInTheDocument();
    expect(blocks.getByText("来源 skills/skills")).toBeInTheDocument();
  });

  it("块 3:草稿(还没分享过)不编造来源,说清还没分享到任何技能库", () => {
    renderExpanded(
      <WhereBlocks
        skill={mk("draft-x", "shareable", { sourceLabel: null })}
        agentNames={NAMES} remoteChanged={false}
      />,
    );
    const blocks = within(screen.getByTestId("where-blocks"));
    expect(blocks.getByText("可分享到技能库")).toBeInTheDocument();
    expect(blocks.getByText("还没有分享到任何技能库")).toBeInTheDocument();
  });

  // 「库里那一版变了没有」自 v7.1 任务 3 起由调用方按 section 分流算好后喂进来
  // (`hasUpdate` / `remoteChangedForShareable`),这一块不再自己算——判定本身
  // 的护栏在 `store/my-skills.ts` 的单测与 `DetailPanel.test.tsx`(那边从真实的
  // `useStoreIndex` 索引出发,断言结论行真的说出了「库里有新版」)。
  it("块 3:确定库里有新版本时才说「有新版本」", () => {
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={true} />);
    expect(screen.getByText("技能库里有新版本")).toBeInTheDocument();
  });

  it("块 3:内容指纹一致时不显示「有新版本」,不猜", () => {
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.queryByText("技能库里有新版本")).not.toBeInTheDocument();
  });

  it("块 3:审核中且有链接时可点开查看,调用 open_library_url", async () => {
    const user = userEvent.setup();
    renderExpanded(
      <WhereBlocks
        skill={mk("weekly-report", "shareable", {
          review: { url: "http://gitea.local/skills/skills/pulls/9" },
        })}
        agentNames={NAMES} remoteChanged={false}
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

  // 🔴 v7.1 任务 5:行上与详情动作区的「在技能库里查看」已按画布撤掉,
  // `review.url` 在详情面板里的渲染点只剩这一处——**打开失败的渲染点也随之
  // 只剩这一处**,所以在这里正面钉住它,别让那条不变量随旧测试一起消失。
  it("🔴 块 3:「查看审核」打开失败要有渲染点,不能静默吞掉", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "open_library_url")
        throw { code: "NET_BLOCKED", message: "这个地址不允许打开" };
      return null;
    });
    const user = userEvent.setup();
    renderExpanded(
      <WhereBlocks
        skill={mk("weekly-report", "shareable", { review: { url: "http://gitea.local/pulls/9" } })}
        agentNames={NAMES} remoteChanged={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "查看审核" }));
    expect(await screen.findByText(/这个地址不允许打开/)).toBeInTheDocument();
  });

  it("块 3:审核中但 url 为 null(直推留下的记录)时,「审核中」照摆,不用空串冒充链接", () => {
    renderExpanded(
      <WhereBlocks
        skill={mk("weekly-report", "shareable", { review: { url: null } })}
        agentNames={NAMES} remoteChanged={false}
      />,
    );
    expect(screen.getByText("审核中")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看审核" })).not.toBeInTheDocument();
  });

  it("三块外层左右留白与元信息行一致(px-5)", () => {
    const { container } = renderExpanded(
      <WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />,
    );
    expect(container.firstElementChild?.className).toContain("px-5");
  });
});

/** 项目分组 fixture,与 `InstalledScopes.test.tsx`(已删,并进本文件)当年的
 *  同名 helper 逐字同构。 */
function projectWith(dirSlug: string | null, path = "/w/我的项目", folderName = "我的项目") {
  return {
    path,
    folderName,
    missing: false,
    readOnly: false,
    skills: dirSlug
      ? [
          {
            key: "k", displayName: "周报生成", description: "",
            source: "skills/skills", sourceType: "git", dirSlug,
            registryId: "company", repo: "skills/skills", updatable: true, agents: [],
          },
        ]
      : [],
  };
}

/**
 * 块 4:项目里(Q46-A,v7.6 任务 2)。原是 `InstalledScopes.test.tsx` 的用例
 * (已删,并进本文件),门控改成了"只看项目行"(见 `ProjectsBlock` 的组件文档
 * ——不再带原组件的「这台电脑」那一行,那半句判断权交给块 1)。
 */
describe("WhereBlocks · 块 4「项目里」(Q46-A)", () => {
  it("没有任何项目装过时,整块不摆——不要摆一个空块", () => {
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.queryByText("项目里")).not.toBeInTheDocument();
  });

  it("有项目装过时,列出块 4,标题「项目里」,完整路径挂 title", () => {
    useProjects.setState({ groups: [projectWith("weekly-report")] });
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);

    const blocks = within(screen.getByTestId("where-blocks"));
    expect(blocks.getByText("项目里")).toBeInTheDocument();
    const row = blocks.getByRole("button", { name: /我的项目/ });
    expect(row.getAttribute("title")).toBe("/w/我的项目");
  });

  it("按仓库目录名匹配,不按安装键——广场技能两者经常不同", () => {
    // key 是 frontmatter name(vercel-react-best-practices),商店与详情面板用的
    // 是仓库目录名(react-best-practices)。按 key 匹配会全都对不上。
    useProjects.setState({
      groups: [
        {
          ...projectWith(null),
          skills: [
            {
              key: "vercel-react-best-practices", displayName: "React 最佳实践", description: "",
              source: "vercel-labs/agent-skills", sourceType: "github",
              dirSlug: "react-best-practices", registryId: "plaza",
              repo: "vercel-labs/agent-skills", updatable: true, agents: [],
            },
          ],
        },
      ],
    });
    renderExpanded(
      <WhereBlocks skill={mk("react-best-practices", "installedFrom")} agentNames={NAMES} remoteChanged={false} />,
    );
    expect(screen.getByRole("button", { name: /我的项目/ })).toBeInTheDocument();
  });

  it("目录不在了的项目不列——它已经不是一个能去的地方", () => {
    useProjects.setState({
      groups: [{ ...projectWith("weekly-report", "/w/没了", "没了"), missing: true }],
    });
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.queryByText("项目里")).not.toBeInTheDocument();
  });

  it("点项目一行跳到「我的技能」", async () => {
    useProjects.setState({ groups: [projectWith("weekly-report")] });
    renderExpanded(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);

    await userEvent.click(screen.getByRole("button", { name: /我的项目/ }));
    expect(useUi.getState().page).toBe("mine");
  });
});

// ---------------------------------------------------------------------------
// v7.1 任务 3(Q2):「在哪」压成一行折叠头,默认收起,结论恒可见。
// ---------------------------------------------------------------------------

describe("whereSummary:折起来之后那一行结论", () => {
  // v7.1 用户裁定:结论行**不数"几个工具开着"**(容易算错还不讨好)。
  // 常态就只有一句区名;"有没有事在等你"那几句照旧(下面几条钉住)。
  it("常态:只有区名,不数工具", () => {
    expect(whereSummary(mk("x", "installedFrom"), false)).toEqual(["安装自技能库"]);
  });

  // 🔴 这是折叠必须过的那道闸:收起来的东西里"有没有在等我",结论行要说出来。
  it("库里有新版时,结论里必须出现「库里有新版」", () => {
    expect(whereSummary(mk("x", "installedFrom"), true)).toContain("库里有新版");
  });

  it("审核中时,结论里必须出现「审核中」", () => {
    const skill = mk("x", "shareable", { review: { url: null } });
    expect(whereSummary(skill, false)).toContain("审核中");
  });

  it("两件事同时成立时两句都在,一件都不许被另一件挤掉", () => {
    const skill = mk("x", "shareable", { review: { url: null } });
    const parts = whereSummary(skill, true);
    expect(parts).toContain("库里有新版");
    expect(parts).toContain("审核中");
  });

  it("🔴 无论工具怎么摆,结论行都不出现工具计数", () => {
    const skill = mk("x", "installedFrom", {
      tools: [{ agent: "claude-code", state: "linked" }],
      canonicalReaders: ["Cline", "Cursor", "Zed"],
    });
    expect(whereSummary(skill, false).join("|")).not.toMatch(/工具|个/);
  });

  it("本体不在这台电脑上时整句退回「没有这个技能的文件」,不编工具数", () => {
    const skill = mk("gone", "sharedTo", { localPresent: false, body: "", tools: [] });
    expect(whereSummary(skill, false)).toEqual(["这台电脑上没有这个技能的文件"]);
  });
});

/**
 * v7.1 任务 4:本体住统一技能目录那一档(Q8C+)。
 *
 * 这一组是用户最初报告的那个缺陷的终点:「各个工具里」的清单里**不许出现 Zed**
 * (它不需要单独勾选,任务 1 已经把它从 core 的 `tools` 里拿掉了),它进上面
 * 那个「…」。⚠️ 负向断言必须**双向**——只断言"哪里都没有 Zed"的话,
 * `canonicalReaders` 整个不渲染也照样绿(本项目栽过 6 次的
 * 「core 备好事实却没有渲染点」),所以每一条都配一句"名单里有 Zed"。
 */
describe("WhereBlocks · 本体在统一技能目录(canonicalReaders)", () => {
  const canonical = (over: Partial<InstalledSkillView> = {}) =>
    mk("api-test-expert", "installedFrom", {
      tools: [{ agent: "claude-code", state: "linked" }],
      canonicalReaders: ["Cline", "Zed"],
      ...over,
    });

  it("🔴 勾选清单里不出现 Zed,而「…」展开后的名单里有它(双向)", async () => {
    useMySkills.setState({ installedAgents: new Set(["claude-code", "zed", "cline"]) });
    renderExpanded(<WhereBlocks skill={canonical()} agentNames={NAMES} remoteChanged={false} />);

    const toolsBlock = screen.getByTestId("where-block-tools");
    expect(within(toolsBlock).getByRole("checkbox", { name: /Claude Code/ })).toBeInTheDocument();
    expect(within(toolsBlock).queryByText("Zed")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "哪些工具" }));
    const card = screen.getByTestId("where-readers");
    // M-4:断言这份名单**真的到达了展示层**,不是"函数被调用过"
    expect(card).toHaveTextContent("Zed");
    expect(card).toHaveTextContent("Cline");
  });

  it("「…」默认收起,再点一次收回去", async () => {
    renderExpanded(<WhereBlocks skill={canonical()} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.queryByTestId("where-readers")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "哪些工具" });
    await userEvent.click(toggle);
    expect(screen.getByTestId("where-readers")).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByTestId("where-readers")).not.toBeInTheDocument();
  });

  it("🔴 名单是空数组(那几个工具一个都没装)时连按钮都不摆 —— 不展开一个空标题", () => {
    renderExpanded(<WhereBlocks skill={canonical({ canonicalReaders: [] })} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.queryByRole("button", { name: "哪些工具" })).not.toBeInTheDocument();
  });

  it("本体不在统一目录(null)时也不摆按钮", () => {
    renderExpanded(
      <WhereBlocks
        skill={canonical({ canonicalReaders: null, body: "/h/.claude/skills/api-test-expert" })}
        agentNames={NAMES}
        remoteChanged={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "哪些工具" })).not.toBeInTheDocument();
  });

  it("工具清单每行右侧显示那个工具的技能目录(store 里的 toolDirs,零新 IPC)", () => {
    useMySkills.setState({ installedAgents: new Set(["claude-code"]) });
    renderExpanded(<WhereBlocks skill={canonical()} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.getByText("/h/.claude/skills")).toBeInTheDocument();
  });
});

/**
 * C-1(任务 1 复审转交,Critical):勾选清单为空时那句话必须**按成因**分流。
 * 任务 1 之后,空列表多了"工具都通过统一目录读它、没有需要单独勾选的"这种全新
 * 成因,而原来那句「这台电脑上没有本体」在这一档是假话——同屏正上方就写着本体的
 * 绝对路径。三种成因各钉一条。
 */
describe("WhereBlocks · 空勾选清单按成因分流(C-1)", () => {
  beforeEach(() => {
    // 收窄到"一个工具都没装",让三档都走到空清单那条分支
    useMySkills.setState({ installedAgents: new Set<string>() });
  });

  it("成因一:本体不在这台电脑上 —— 仍然说「没有本体」", () => {
    const skill = mk("gone", "sharedTo", { localPresent: false, body: "", tools: [], canonicalReaders: null });
    renderExpanded(<WhereBlocks skill={skill} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.getByTestId("where-block-tools")).toHaveTextContent(
      "这台电脑上没有本体,暂时没有工具在用它",
    );
  });

  it("🔴 成因二:本体在统一技能目录 —— 说位置 + 「暂时没有可以勾选的工具」,不许说「没有本体」", () => {
    const skill = mk("x", "installedFrom", { tools: [], canonicalReaders: ["Zed"] });
    const block = () => screen.getByTestId("where-block-tools");
    renderExpanded(<WhereBlocks skill={skill} agentNames={NAMES} remoteChanged={false} />);
    expect(block()).toHaveTextContent("本体放在统一技能目录,暂时没有可以勾选的工具");
    expect(block()).not.toHaveTextContent(/没有本体/);
    // 这一句刻意不点名任何工具:readers 可能是空数组,说"都在读它"又是一句假话
    expect(block()).not.toHaveTextContent("Zed");
  });

  it("成因三:本体在某个工具目录、但没有可勾的 —— 中性话,不提统一技能目录", () => {
    const skill = mk("x", "installedFrom", {
      tools: [],
      canonicalReaders: null,
      body: "/h/.claude/skills/x",
    });
    renderExpanded(<WhereBlocks skill={skill} agentNames={NAMES} remoteChanged={false} />);
    const el = screen.getByTestId("where-block-tools");
    expect(el).toHaveTextContent("这台电脑上暂时没有可以勾选的工具");
    expect(el).not.toHaveTextContent(/没有本体|统一技能目录/);
  });
});

describe("WhereBlocks 折叠头", () => {
  it("收起时三块都不渲染,只剩路径与结论那一行", () => {
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    expect(screen.queryAllByTestId("where-title")).toHaveLength(0);
    expect(screen.getByTestId("where-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(`${CANONICAL}/weekly-report`)).toBeInTheDocument();
  });

  it("🔴 收起状态下,「库里有新版」照样看得见——折叠不得把例外藏掉", () => {
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={true} />);
    expect(screen.getByTestId("where-toggle").textContent).toMatch(/库里有新版/);
  });

  // 🔴 复审抓到的回归:折叠头的等宽行原先写成 `skill.body || whereNotHere`,
  // 而 `whereSummary` 对同一类行返回的**就是**那句话——收起态同一句话上下叠两遍,
  // 展开后加上块 1 是三遍。可达路径是第 4 源(库里记着是我分享的、本地没有本体)。
  it("本体不在这台电脑上时,那句话在收起态恰好出现一次(不叠两遍)", () => {
    render(
      <WhereBlocks
        skill={mk("gone", "sharedTo", { localPresent: false, body: "", tools: [] })}
        agentNames={NAMES}
        remoteChanged={false}
      />,
    );
    expect(screen.getAllByText("这台电脑上没有这个技能的文件")).toHaveLength(1);
  });

  it("点一下折叠头就展开,三块出现", async () => {
    const user = userEvent.setup();
    render(<WhereBlocks skill={mk("weekly-report", "installedFrom")} agentNames={NAMES} remoteChanged={false} />);
    await user.click(screen.getByTestId("where-toggle"));
    expect(screen.getAllByTestId("where-title").map((e) => e.textContent)).toEqual([
      "这台电脑上",
      "各个工具里",
      "技能库里",
    ]);
    expect(screen.getByTestId("where-toggle")).toHaveAttribute("aria-expanded", "true");
  });
});
