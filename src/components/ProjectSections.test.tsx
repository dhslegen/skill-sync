import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSections } from "@/components/ProjectSections";
import type { ProjectGroupView, ProjectSkillView } from "@/lib/ipc";
import { useMineSearch } from "@/store/mine-search";
import { useProjects } from "@/store/project";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

/** 与真实 `agents_detected` 形状对齐的候选工具:两个各自独占一个目录的 agent
 *  (不用 trae/trae-cn 这类共享目录的,断言才有确定性——与 `project_flow.rs`
 *  的既有取舍同一个理由)。 */
const AGENT_FIXTURES = [
  { name: "claude-code", displayName: "Claude Code", installed: true, skillsDir: ".claude/skills", isUniversal: false, needsLink: true, disabled: false },
  { name: "junie", displayName: "Junie", installed: true, skillsDir: ".junie/skills", isUniversal: false, needsLink: true, disabled: false },
  // universal agent 摆进探测结果里,验证它不会混进 picker——项目级
  // current_agents/link_dirs 都跳过它,摆出来就是一个点了没效果的死勾。
  { name: "cursor", displayName: "Cursor", installed: true, skillsDir: ".cursor/skills", isUniversal: true, needsLink: false, disabled: false },
  // 🔴 M2 修复:真实 `agents_detected` 是 `detect_all`,注册表里的 75 个 agent
  // **全部**出现,没装的那些带 `installed: false`——不是"这台机器没探测到就
  // 从列表里消失"。zed 摆在这里就是这个真实形态:候选(installed 的那些)里
  // 没有它,但 `agentNames` 这份全量 name→displayName 映射里有,所以"已关联
  // 但没被探测装上"的那一档仍然能解析出真实展示名,不会退回内部 id。
  { name: "zed", displayName: "Zed", installed: false, skillsDir: ".zed/skills", isUniversal: false, needsLink: true, disabled: false },
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

    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
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

    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "移除" }));

    // 🔴 M1 修复:正面断言确认块真的渲染出来了,不能只断言"没有说谎的词"
    // ——那种断言区分不了"文案对"和"整个确认块没渲染出来"。
    expect(
      screen.getByText('从这个文件夹移除「React 最佳实践」?'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/废纸篓/)).toBeNull();
    expect(screen.queryByText(/可以找回/)).toBeNull();
  });

  it("目录不在了:说明情况,且不摆任何会动到它的按钮", async () => {
    seed([group({ missing: true, skills: [] })]);
    render(<ProjectSections />);

    await screen.findByText("这个文件夹不在了");
    // 「从列表移除」现在收在标题行的「更多」里
    await userEvent.click(screen.getByRole("button", { name: /更多/ }));
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

    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "移除" }));
    await userEvent.click(within(row).getByRole("button", { name: "移除" }));

    // core 刻意不删内容不一样的实体目录,界面必须说出来,不能装作全清干净了
    await screen.findByText(/有 1 个位置没有清理/);
  });
});

describe("终审 M-3:「项目里」页签接上页头那个搜索框", () => {
  // 此前 `ProjectSections` 完全不读 `useMineSearch`——页头搜索框是「我的技能」
  // 整页共用的单例(`Toolbar.tsx` 按 `page === "mine"` 渲染,不分子页签),
  // 用户切到「项目里」往里敲字,界面一个字都不会变,是一颗死控件。
  beforeEach(() => {
    useMineSearch.setState({ query: "" });
  });

  it("按展示名过滤,不匹配的技能不显示", async () => {
    seed([
      group({
        skills: [
          skill({ key: "a", displayName: "周报生成", source: "skills/skills" }),
          skill({ key: "b", displayName: "React 最佳实践", source: "vercel-labs/agent-skills" }),
        ],
      }),
    ]);
    render(<ProjectSections />);
    await screen.findByText("周报生成");

    useMineSearch.setState({ query: "React" });

    await waitFor(() => {
      expect(screen.queryByText("周报生成")).toBeNull();
      expect(screen.getByText("React 最佳实践")).toBeInTheDocument();
    });
  });

  it("也按仓库目录名(key)与来源匹配——同一份判据,不是只认展示名", async () => {
    seed([
      group({
        skills: [
          skill({ key: "weekly-report", displayName: "周报生成", source: "skills/skills" }),
        ],
      }),
    ]);
    render(<ProjectSections />);
    await screen.findByText("周报生成");

    useMineSearch.setState({ query: "skills/skills" });
    await waitFor(() => expect(screen.getByText("周报生成")).toBeInTheDocument());

    useMineSearch.setState({ query: "没有任何技能会匹配这串" });
    await waitFor(() => expect(screen.queryByText("周报生成")).toBeNull());
  });

  it("搜索把某个项目的技能全部过滤掉时,说「没有匹配」,不是说「这个文件夹里还没有技能」", async () => {
    seed([group()]); // 默认技能叫「React 最佳实践」
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    useMineSearch.setState({ query: "查无此技能" });

    await waitFor(() => {
      expect(screen.getByText('没有匹配「查无此技能」的技能。')).toBeInTheDocument();
      // 与"这个文件夹里还没有技能"是两句不同的话——项目里其实是有技能的
      expect(screen.queryByText("这个文件夹里还没有技能")).toBeNull();
    });
  });

  it("清空搜索词,过滤掉的技能重新出现", async () => {
    seed([
      group({
        skills: [
          skill({ key: "a", displayName: "周报生成", source: "skills/skills" }),
          skill({ key: "b", displayName: "React 最佳实践", source: "vercel-labs/agent-skills" }),
        ],
      }),
    ]);
    render(<ProjectSections />);
    await screen.findByText("周报生成");

    useMineSearch.setState({ query: "React" });
    await waitFor(() => expect(screen.queryByText("周报生成")).toBeNull());

    useMineSearch.setState({ query: "" });
    await waitFor(() => expect(screen.getByText("周报生成")).toBeInTheDocument());
  });

  it("空查询词不影响真正空项目的既有文案", async () => {
    seed([group({ skills: [] })]);
    render(<ProjectSections />);
    await screen.findByText("这个文件夹里还没有技能");
  });
});

describe("v7 任务 8:项目卡片压扁", () => {
  it("项目名与路径挤在标题行同一行,不再各占一行", async () => {
    seed([group()]);
    render(<ProjectSections />);
    await screen.findByText("我的项目");

    const name = screen.getByText("我的项目");
    const path = screen.getByText("/w/我的项目");
    expect(name.parentElement).toBe(path.parentElement);
  });

  it("项目级动作在卡片标题行的「…」里", async () => {
    seedProjects([proj("erp", [])]);
    render(<ProjectSections />);
    await screen.findByText("erp");

    await userEvent.click(screen.getByRole("button", { name: /更多/ }));
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

  it("K3(0.6.x):每个工具带项目内的落点路径,候选与「已关联但不在候选」两档都有", async () => {
    // 此前 path 恒为 ""(DetectedAgent 只有全局目录,摆在项目语境里是撒谎)。
    // 现在拼的是 <项目>/<注册表 skillsDir>——与 core 建链用的同一个字段。
    seedProjects([
      group({
        folderName: "erp",
        path: "/w/erp",
        skills: [skill({ key: "weekly-report", displayName: "weekly-report", dirSlug: "weekly-report", agents: ["zed"] })],
      }),
    ]);
    render(<ProjectSections />);
    await screen.findByText("weekly-report");
    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    await screen.findByRole("checkbox", { name: /Junie/ });
    // 候选(installed 且非 universal)
    expect(screen.getByText("/w/erp/.claude/skills")).toBeInTheDocument();
    expect(screen.getByText("/w/erp/.junie/skills")).toBeInTheDocument();
    // 已关联但这台机器没探测装上(zed installed:false):只有 agent 名,路径从
    // agentSkillsDirs 查——那一档同样不能留空
    expect(screen.getByText("/w/erp/.zed/skills")).toBeInTheDocument();
  });

  it("真机走查(2026-09-14):Trae 与 Trae CN 共用 .trae/skills → 合并成一个勾,取消时两个一起从提交名单去掉", async () => {
    // 此前各摆一个勾:取消 Trae 提交的是 ["trae-cn"],那个目录仍然要链,刷新后两个勾又回来,永远取消不掉。
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_list") {
        return [
          group({
            folderName: "erp",
            path: "/w/erp",
            skills: [skill({ key: "weekly-report", displayName: "weekly-report", dirSlug: "weekly-report", agents: ["trae-cn", "trae"] })],
          }),
        ];
      }
      if (cmd === "agents_detected") {
        return {
          agents: [
            { name: "claude-code", displayName: "Claude Code", installed: true, skillsDir: ".claude/skills", isUniversal: false, needsLink: true, disabled: false },
            { name: "trae", displayName: "Trae", installed: true, skillsDir: ".trae/skills", isUniversal: false, needsLink: true, disabled: false },
            { name: "trae-cn", displayName: "Trae CN", installed: true, skillsDir: ".trae/skills", isUniversal: false, needsLink: true, disabled: false },
          ],
        };
      }
      return null;
    });
    render(<ProjectSections />);
    await screen.findByText("weekly-report");
    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));

    const traeBoxes = (await screen.findAllByRole("checkbox")).filter((b) => /Trae/.test(b.closest("label")?.textContent ?? ""));
    expect(traeBoxes).toHaveLength(1);
    expect(traeBoxes[0]).toBeChecked();
    // 一个勾、一条路径,两个名字都在
    const label = traeBoxes[0].closest("label")!;
    expect(label.textContent).toContain("Trae CN");
    expect(label.textContent).toMatch(/Trae(?! CN)/);
    expect(within(label).getByText("/w/erp/.trae/skills")).toBeInTheDocument();

    await userEvent.click(traeBoxes[0]);
    const sent = lastInvoke("project_skill_set_agents")?.args.agentIds as string[];
    expect(sent).not.toContain("trae");
    expect(sent).not.toContain("trae-cn");
  });

  it("🔴 复验回归(2026-09-14):取消合并勾之后,列表顺序不变、名字不变(Trae 本机未装)", async () => {
    let linked = ["trae-cn", "trae"];
    invoke.mockImplementation(async (cmd: string, payload?: { args?: { agentIds?: string[] } }) => {
      if (cmd === "project_skill_set_agents") {
        linked = payload?.args?.agentIds ?? [];
        return { linked: [], unlinked: [], kept: [] };
      }
      if (cmd === "project_list") {
        return [
          group({
            folderName: "erp",
            path: "/w/erp",
            skills: [skill({ key: "weekly-report", displayName: "weekly-report", dirSlug: "weekly-report", agents: linked })],
          }),
        ];
      }
      if (cmd === "agents_detected") {
        return {
          agents: [
            { name: "claude-code", displayName: "Claude Code", installed: true, skillsDir: ".claude/skills", isUniversal: false, needsLink: true, disabled: false },
            { name: "junie", displayName: "Junie", installed: true, skillsDir: ".junie/skills", isUniversal: false, needsLink: true, disabled: false },
            { name: "trae", displayName: "Trae", installed: false, skillsDir: ".trae/skills", isUniversal: false, needsLink: true, disabled: false },
            { name: "trae-cn", displayName: "Trae CN", installed: true, skillsDir: ".trae/skills", isUniversal: false, needsLink: true, disabled: false },
          ],
        };
      }
      return null;
    });
    render(<ProjectSections />);
    await screen.findByText("weekly-report");
    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    await screen.findByRole("checkbox", { name: /Trae CN/ });
    const labels = () => screen.getAllByRole("checkbox").map((b) => b.closest("label")!.firstChild!.nextSibling!.textContent);
    const before = labels();
    expect(before).toEqual(["Trae CN", "Claude Code", "Junie"]);

    await userEvent.click(screen.getByRole("checkbox", { name: /Trae CN/ }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Trae CN/ })).not.toBeChecked());
    expect(labels()).toEqual(before);
  });

  it("🔴 I2:取消勾选也要真的从提交名单里去掉,不能恒加", async () => {
    seedProjects([
      group({
        folderName: "erp",
        path: "/w/erp",
        skills: [
          skill({
            key: "weekly-report",
            displayName: "weekly-report",
            agents: ["claude-code", "junie"],
          }),
        ],
      }),
    ]);
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));
    await userEvent.click(screen.getByRole("checkbox", { name: /Junie/ }));

    // 🔴 用 toEqual,不用 arrayContaining——后者拦不住"多发了一个"(比如
    // 取消勾选那一支坏成恒加,提交出去的仍然含 junie,arrayContaining 照样通过)。
    const call = lastInvoke("project_skill_set_agents");
    expect(call?.args.agentIds).toEqual(["claude-code"]);
  });

  it("🔴 I1:这台机器的工具列表探测失败时,走独立的失败态文案,不能说成没有能改选的工具", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_list") return [proj("erp", ["weekly-report"])];
      if (cmd === "agents_detected") throw { code: "IPC_FAILED", message: "探测失败" };
      return null;
    });
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));

    // "探测失败,候选未知" 与 "确实没有可选的工具" 是两件不同的事,不能说成后者
    await screen.findByText(/暂时读不到这台机器上的工具列表/);
    expect(screen.queryByText("这台机器上没有能改选的工具")).toBeNull();
  });

  it("探测失败时,已经关联的工具仍然显示、仍能取消勾选", async () => {
    // 模拟"上一次刷新探测成功过,这一次失败"——比"从第一次就没成功过"更贴近
    // 真实场景(agents_detected 是本机同步探测,基本不会失败;失败的更可能是
    // 后续某一次刷新)。这样 agentNames 里已经有 junie 的真实展示名,断言不会
    // 无意中把"内部 id 上屏"这个边界情形钉成预期行为。
    useProjects.setState({ agentNames: new Map([["junie", "Junie"]]) });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_list") {
        return [
          group({
            folderName: "erp",
            path: "/w/erp",
            skills: [
              skill({ key: "weekly-report", displayName: "weekly-report", agents: ["junie"] }),
            ],
          }),
        ];
      }
      if (cmd === "agents_detected") throw { code: "IPC_FAILED", message: "探测失败" };
      return null;
    });
    render(<ProjectSections />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByTestId("prow-weekly-report-body"));

    const junieBox = screen.getByRole("checkbox", { name: /Junie/ });
    expect(junieBox).toBeChecked();

    await userEvent.click(junieBox);
    const call = lastInvoke("project_skill_set_agents");
    expect(call?.args.agentIds).toEqual([]);
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
    // zed 没被这台机器探测装上(installed:false),不在候选(可勾选安装项)
    // 里,但已经关联,必须仍然可见且是勾上的——展示名走真实的 "Zed",
    // 不是内部 id "zed"(内部标识不能上屏,本仓已踩过两次)。
    const zedBox = screen.getByRole("checkbox", { name: /Zed/ });
    expect(zedBox).toBeChecked();
    expect(screen.queryByText("zed")).toBeNull();

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
