import { render, screen } from "@testing-library/react";
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
 * 现在都是 `ToolPicker` 的薄壳,两处渲染出来的每一项必须是**同一副 DOM 骨架**
 * (同一个 label 容器、同一个 checkbox className、同一层外壳),不是各自维护
 * 一套标记再凑巧长得像。断言 className 逐字相同,能拦住"其中一处悄悄漂回自己
 * 那一套样式"这种回归。
 */
describe("ToolChecks 与 AgentChooser 共用同一副 DOM 骨架", () => {
  it("checkbox / label / 外层容器的 className 逐字相同", () => {
    useMySkills.setState({ installedAgents: new Set(["claude-code"]), setAgentsBusy: null });
    render(
      <ToolChecks
        dirSlug="weekly-report"
        tools={[{ agent: "claude-code", state: "linked" }]}
        agentNames={new Map([["claude-code", "Claude Code"]])}
      />,
    );
    const mineBox = screen.getByRole("checkbox");
    const mineLabel = mineBox.closest("label")!;
    const mine = {
      box: mineBox.className,
      label: mineLabel.className,
      container: mineLabel.parentElement!.className,
    };

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
    render(<InstallPanel dirSlug="weekly-report" />);
    const installBox = screen.getAllByRole("checkbox")[0];
    const installLabel = installBox.closest("label")!;

    expect(installBox.className).toBe(mine.box);
    expect(installLabel.className).toBe(mine.label);
    expect(installLabel.parentElement!.className).toBe(mine.container);
  });
});
