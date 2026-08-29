import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSections } from "@/components/ProjectSections";
import type { ProjectGroupView, ProjectSkillView } from "@/lib/ipc";
import { useProjects } from "@/store/project";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

/** 与真实 `agents_detected` 形状对齐的候选工具:两个各自独占一个目录的 agent
 *  (不用 trae/trae-cn 这类共享目录的,断言才有确定性——与 `project_flow.rs`
 *  的既有取舍同一个理由)。 */
const AGENT_FIXTURES = [
  { name: "claude-code", displayName: "Claude Code", installed: true, isUniversal: false, needsLink: true, disabled: false },
  { name: "junie", displayName: "Junie", installed: true, isUniversal: false, needsLink: true, disabled: false },
  // universal agent 摆进探测结果里,验证它不会混进 picker——项目级
  // current_agents/link_dirs 都跳过它,摆出来就是一个点了没效果的死勾。
  { name: "cursor", displayName: "Cursor", installed: true, isUniversal: true, needsLink: false, disabled: false },
];

function skill(over: Partial<ProjectSkillView> = {}): ProjectSkillView {
  return {
    key: "vercel-react-best-practices",
    displayName: "React 最佳实践",
    description: "写 React 的规范",
    source: "vercel-labs/agent-skills",
    sourceType: "github",
    dirSlug: "react-best-practices",
    registryId: "plaza",
    repo: "vercel-labs/agent-skills",
    updatable: true,
    agents: [],
    ...over,
  };
}

function group(over: Partial<ProjectGroupView> = {}): ProjectGroupView {
  return {
    path: "/w/我的项目",
    folderName: "我的项目",
    missing: false,
    readOnly: false,
    skills: [skill()],
    ...over,
  };
}

/** brief 用的简化建组辅助:一个项目 + 一批技能键(展示名与 key 相同,够用于断言)。 */
function proj(folderName: string, skillKeys: string[]): ProjectGroupView {
  return group({
    folderName,
    path: `/w/${folderName}`,
    skills: skillKeys.map((key) => skill({ key, displayName: key, dirSlug: key })),
  });
}

function seed(groups: ProjectGroupView[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "project_list") return groups;
    if (cmd === "agents_detected") return { agents: AGENT_FIXTURES };
    return null;
  });
}

const seedProjects = seed;

/** 最近一次调用某个 command 的参数(与 `MySkillsPage.test.tsx` 同一实现)。 */
function lastInvoke(cmd: string): { args: Record<string, unknown> } | undefined {
  const matches = invoke.mock.calls.filter(([c]) => c === cmd) as [
    string,
    { args: Record<string, unknown> },
  ][];
  return matches[matches.length - 1]?.[1];
}

beforeEach(() => {
  invoke.mockReset();
  useProjects.setState({
    groups: [],
    loading: false,
    error: null,
    installing: null,
    notice: null,
    decision: null,
    busyKey: null,
    confirm: null,
    agentNames: new Map(),
    pickableAgents: null,
    setAgentsBusy: null,
    setAgentsError: null,
    toolFailures: null,
    toolFailuresFor: null,
  });
});

describe("项目分区", () => {
  it("列出项目与里面的技能,展示名不是内部键", async () => {
    seed([group()]);
    render(<ProjectSections />);

    await screen.findByText("我的项目");
    expect(screen.getByText("React 最佳实践")).toBeTruthy();
    // 内部键(frontmatter name 的 sanitize 结果)绝不能出现在界面上
    expect(screen.queryByText("vercel-react-best-practices")).toBeNull();
  });

  it("更新按 dirSlug 取数,不是按 key —— 两者常不同,拿 key 取会找不到技能", async () => {
    seed([group()]);
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    await userEvent.click(screen.getByRole("button", { name: "更新" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "project_skill_update");
      expect(call).toBeTruthy();
      const args = (call![1] as { args: Record<string, unknown> }).args;
      expect(args.dirSlug).toBe("react-best-practices");
      expect(args.key).toBe("vercel-react-best-practices");
      // 🔴 死参数已清:`project_skill_update` 早就不吃 agentIds 了
      // (v7 任务 3 改成从磁盘反推,任务 8 顺手把前端那半也删掉)
      expect(args.agentIds).toBeUndefined();
    });
  });

  it("更新带上账上的源与库坐标 —— 缺省会打到内建源主仓,装错技能", async () => {
    seed([group()]);
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    await userEvent.click(screen.getByRole("button", { name: "更新" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "project_skill_update");
      expect(call).toBeTruthy();
      const args = (call![1] as { args: Record<string, unknown> }).args;
      // 项目 lock 里只有 source/sourceUrl,core 已把它还原成"源 + 库坐标";
      // 这一层不传下去等于白还原(M4「更新必须带账上的仓库坐标」同一类缺陷)
      expect(args.registryId).toBe("plaza");
      expect(args.repo).toBe("vercel-labs/agent-skills");
    });
  });

  it("来源还原不了的技能不摆更新按钮 —— 不摆比摆一个必然报错的按钮好", async () => {
    seed([group({ skills: [skill({ sourceType: "local", updatable: false })] })]);
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("移除要两步:「更多」里点移除只是展开确认,再点一次才真的调 IPC", async () => {
    seed([group()]);
    render(<ProjectSections />);
    const row = await screen.findByTestId(`prow-${skill().key}`);
    await screen.findByText("React 最佳实践");

    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "移除" }));
    // 第一步只是展开确认,不能有任何 IPC
    expect(invoke.mock.calls.find(([cmd]) => cmd === "project_skill_remove")).toBeUndefined();

    await userEvent.click(within(row).getByRole("button", { name: "移除" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "project_skill_remove");
      expect(call).toBeTruthy();
      // confirmed 必须为 true(铁律 7:破坏性操作带前端确认结果)
      expect((call![1] as { confirmed: boolean }).confirmed).toBe(true);
    });
  });

  it("🔴 移除确认文案不能照抄「通用」页——项目级删除不可逆,不进废纸篓", async () => {
    seed([group()]);
    render(<ProjectSections />);
    const row = await screen.findByTestId(`prow-${skill().key}`);
    await screen.findByText("React 最佳实践");

    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "移除" }));

    expect(screen.queryByText(/废纸篓/)).toBeNull();
    expect(screen.queryByText(/可以找回/)).toBeNull();
  });

  it("目录不在了:说明情况,且不摆任何会动到它的按钮", async () => {
    seed([group({ missing: true, skills: [] })]);
    render(<ProjectSections />);

    await screen.findByText("这个文件夹不在了");
    // 「从列表移除」现在收在标题行的「更多」里
    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menuitem", { name: "从列表移除" })).toBeInTheDocument();
    // 目录都不在了,「在文件夹中显示」摆出来就是引诱用户点一个必然失败的按钮
    expect(screen.queryByRole("menuitem", { name: "在文件夹中显示" })).toBeNull();
  });

  it("清单文件看不懂:只读提示,不列技能", async () => {
    seed([group({ readOnly: true, skills: [] })]);
    render(<ProjectSections />);

    await screen.findByText("这个文件夹的清单文件本应用看不懂,只能查看");
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("一个项目都没有时摆引导语,而不是空白", async () => {
    seed([]);
    render(<ProjectSections />);

    await screen.findByText("还没有把技能装到任何项目里。");
  });

  it("移除后有位置没清理干净时,如实告诉用户", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_list") return [group()];
      if (cmd === "agents_detected") return { agents: AGENT_FIXTURES };
      if (cmd === "project_skill_remove") {
        return { bodyRemoved: true, unlinked: [], kept: [{ kind: "keptForeignDir", dir: "/w/x" }] };
      }
      return null;
    });
    render(<ProjectSections />);
    const row = await screen.findByTestId(`prow-${skill().key}`);
    await screen.findByText("React 最佳实践");

    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "移除" }));
    await userEvent.click(within(row).getByRole("button", { name: "移除" }));

    // core 刻意不删内容不一样的实体目录,界面必须说出来,不能装作全清干净了
    await screen.findByText(/有 1 个位置没有清理/);
  });
});

describe("v7 任务 8:项目卡片压扁", () => {
  it("项目名与路径挤在标题行同一行,不再各占一行", async () => {
    seed([group()]);
    const { container } = render(<ProjectSections />);
    await screen.findByText("我的项目");

    const name = screen.getByText("我的项目");
    const path = screen.getByText("/w/我的项目");
    expect(name.parentElement).toBe(path.parentElement);
    void container;
  });

  it("项目级动作在卡片标题行的「…」里", async () => {
    seedProjects([proj("erp", [])]);
    render(<ProjectSections />);
    await screen.findByText("erp");

    await userEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menuitem", { name: /在文件夹中显示/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /从列表移除/ })).toBeInTheDocument();
  });
});

describe("v7 任务 8:项目行事后改选工具", () => {
  it("点技能行能展开工具改选,勾一个就带上当前全量再发出去", async () => {
    seedProjects([proj("erp", ["weekly-report"])]);
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    await userEvent.click(screen.getByRole("checkbox", { name: /Junie/ }));

    expect(lastInvoke("project_skill_set_agents")?.args.agentIds).toContain("junie");
  });

  it("universal agent(如 cursor)不摆进 picker —— 落点与本体同一处,点了没有效果", async () => {
    seedProjects([proj("erp", ["weekly-report"])]);
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    expect(screen.queryByRole("checkbox", { name: /Cursor/ })).toBeNull();
  });

  it("🔴 已关联但没被这台机器探测到的工具,仍作为独立一项摆出来,不会被静默停用", async () => {
    seedProjects([
      group({
        folderName: "erp",
        path: "/w/erp",
        skills: [skill({ key: "weekly-report", displayName: "weekly-report", agents: ["zed"] })],
      }),
    ]);
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    // zed 不在 AGENT_FIXTURES 的候选列表里,但已经关联,必须仍然可见且是勾上的
    const zedBox = screen.getByRole("checkbox", { name: /zed/ });
    expect(zedBox).toBeChecked();

    // 再勾一个 Junie,提交名单必须仍含 zed(藏起来的已启用工具不能被静默停用)
    await userEvent.click(screen.getByRole("checkbox", { name: /Junie/ }));
    const call = lastInvoke("project_skill_set_agents");
    expect(call?.args.agentIds).toEqual(expect.arrayContaining(["zed", "junie"]));
  });

  it("🔴 占用位置(kept)必须有渲染点 —— 这一档不是没做成,是停下来问你", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_list") return [proj("erp", ["weekly-report"])];
      if (cmd === "agents_detected") return { agents: AGENT_FIXTURES };
      if (cmd === "project_skill_set_agents") return { linked: [], unlinked: [], kept: ["junie"] };
      return null;
    });
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    await userEvent.click(screen.getByRole("checkbox", { name: /Junie/ }));

    await screen.findByText(/有 1 个工具没能按这次选择变化/);
  });

  it("改选失败(IPC 报错)也要有渲染点", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_list") return [proj("erp", ["weekly-report"])];
      if (cmd === "agents_detected") return { agents: AGENT_FIXTURES };
      if (cmd === "project_skill_set_agents") {
        throw { code: "FS_MISSING_SKILL", message: "这个技能的本体不在项目里了" };
      }
      return null;
    });
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    await userEvent.click(screen.getByRole("checkbox", { name: /Junie/ }));

    await screen.findByText(/这个技能的本体不在项目里了/);
  });
});
