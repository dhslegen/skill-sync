import { render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstallPanel } from "@/components/InstallPanel";
import { ToolChecks } from "@/components/ToolChecks";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "skill_set_agents") {
      return {
        outcome: "done",
        homeBody: "/b",
        canonical: { Ok: { kind: "unchanged" } },
        results: [],
        unlinked: [],
        unlinkFailed: [],
      };
    }
    return null;
  });
  useProjects.setState({
    groups: [],
    loading: false,
    error: null,
    installing: null,
    notice: null,
    decision: null,
    busyKey: null,
    confirm: null,
  });
  useStoreIndex.setState({ activeRegistry: "company", activeRepo: "skills/skills" });
});

/**
 * v7 任务 5 的 DoD:「我的技能」的 `ToolChecks` 与获取面板私有的 `AgentChooser`
 * 现在都是 `ToolPicker` 的薄壳,两处渲染出来的 checkbox 与 label 必须是
 * **同一副 DOM 骨架**(同一批 className),不是各自维护一套标记再凑巧长得像。
 *
 * 🔴 R17 裁定(修复轮 1):**容器排布刻意不要求一致**——`ToolChecks` 用
 * `layout="inline"`(chip 流),`AgentChooser` 用 `layout="list"`(竖排清单,
 * 带分隔线/hover/路径靠右对齐)。「三处统一」统一的是同一个组件与同一套
 * checkbox/label token,不是同一种排布方向;安装面板天然要展示"工具名 + 落点
 * 路径"这份竖排清单,硬拉平成 chip 流会把长 mono 路径和工具名混排,是真实的
 * 可读性回归。所以这里**只断言 checkbox 与 label 的 className**,不再断言
 * 外层容器——容器不同不代表没统一。
 *
 * 🔴 修复轮 1 之前这条测试是**全量空转**:两次 `render` 都往 `document.body`
 * 追加内容(RTL 的 `cleanup` 只在 `afterEach`),用全局 `screen.getAllByRole
 * ("checkbox")[0]` 取到的其实是文档序上第一次 render(`ToolChecks`)自己的
 * checkbox——三条断言全部退化成"自己等于自己",哪怕 `AgentChooser` 整个不渲染
 * checkbox 也照样绿。改成 `within(container)` 把两次 render 的查询各自限定在
 * 自己的容器里,并显式断言两个 box **不是同一个 DOM 节点**,防止再次退化。
 */
describe("ToolChecks 与 AgentChooser 共用同一副 checkbox/label 骨架", () => {
  it("checkbox 与 label 的 className 逐字相同,且确实取自两个不同的 render", () => {
    useMySkills.setState({ installedAgents: new Set(["claude-code"]), setAgentsBusy: null });
    const { container: mineContainer } = render(
      <ToolChecks
        dirSlug="weekly-report"
        tools={[{ agent: "claude-code", state: "linked" }]}
        agentNames={new Map([["claude-code", "Claude Code"]])}
      />,
    );
    const mineBox = within(mineContainer).getByRole("checkbox");
    const mineLabel = mineBox.closest("label")!;

    useInstall.setState({
      phase: "choosing",
      dirSlug: "weekly-report",
      agents: [
        {
          name: "claude-code",
          displayName: "Claude Code",
          installed: true,
          disabled: false,
          isUniversal: false,
          needsLink: true,
          globalSkillsDir: "/h/.claude/skills",
        },
      ],
      selected: new Set(["claude-code"]),
      registryId: "company",
      repo: null,
    });
    const { container: installContainer } = render(<InstallPanel dirSlug="weekly-report" />);
    const installBox = within(installContainer).getByRole("checkbox");
    const installLabel = installBox.closest("label")!;

    // 防呆:两个查询必须真的取自两个不同的 render,否则上面的等式检查毫无意义
    // ——这正是修复轮 1 之前被静默退化成的样子。
    expect(installBox).not.toBe(mineBox);
    expect(installBox.className).toBe(mineBox.className);
    expect(installLabel.className).toBe(mineLabel.className);
  });
});
