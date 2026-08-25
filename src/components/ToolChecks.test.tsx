import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToolChecks } from "./ToolChecks";
import type { ToolView } from "@/lib/ipc";
import { useMySkills, visibleTools } from "@/store/my-skills";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const NAMES = new Map([
  ["claude-code", "Claude Code"],
  ["trae", "Trae"],
  ["cursor", "Cursor"],
  ["zed", "Zed"],
]);

const ALL_INSTALLED = new Set(["claude-code", "trae", "cursor", "zed"]);

function draw(tools: ToolView[], installed: Set<string> | null = ALL_INSTALLED) {
  useMySkills.setState({ installedAgents: installed, list: null });
  return render(
    <ToolChecks dirSlug="weekly-report" tools={tools} agentNames={NAMES} />,
  );
}

const box = (label: string) =>
  within(screen.getByText(label).closest("label")!).getByRole("checkbox");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "skill_set_agents")
      return {
        outcome: "done",
        homeBody: "/b",
        canonical: { Ok: { kind: "unchanged" } },
        results: [],
        unlinked: [],
        unlinkFailed: [],
      };
    if (cmd === "installed_list") return [];
    return { agents: [], canonicalDir: "" };
  });
  useMySkills.setState({ installedAgents: null, setAgentsBusy: null });
});

describe("本体所在的那个勾", () => {
  it("恒亮、点不动,并写明「本体在这里」", () => {
    // 🔴 取消它等于删用户的文件。这是「本体永不搬动」在界面上的直接体现。
    draw([{ agent: "claude-code", state: "body" }]);

    const check = box("Claude Code");
    expect(check).toBeChecked();
    expect(check).toBeDisabled();
    expect(check.closest("label")).toHaveAttribute("title", "本体在这里");
    expect(screen.getByText("本体在这里")).toBeInTheDocument();
  });

  it("点它不会发出任何请求", async () => {
    draw([{ agent: "claude-code", state: "body" }]);
    await userEvent.click(box("Claude Code")).catch(() => {});
    expect(invoke).not.toHaveBeenCalledWith("skill_set_agents", expect.anything());
  });
});

describe("勾选与取消", () => {
  it("点一个没启用的勾 → 带上原有的全部 + 这一个", async () => {
    // 🔴 `skill_set_agents` 收的是**完整期望名单**,不是增量:只传新点的这一个,
    // core 会把其余位置全部停用掉。
    draw([
      { agent: "claude-code", state: "linked" },
      { agent: "trae", state: "off" },
    ]);

    await userEvent.click(box("Trae"));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_set_agents");
    expect(call?.[1].args.dirSlug).toBe("weekly-report");
    expect(new Set(call?.[1].args.agents)).toEqual(new Set(["claude-code", "trae"]));
  });

  it("取消一个已启用的勾 → 名单里少它一个,其余原样", async () => {
    draw([
      { agent: "claude-code", state: "linked" },
      { agent: "trae", state: "linked" },
    ]);

    await userEvent.click(box("Trae"));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_set_agents");
    expect(call?.[1].args.agents).toEqual(["claude-code"]);
  });

  it("🔴 本体那一档必须留在提交的名单里 —— 漏掉它就是请求把本体停用掉", async () => {
    draw([
      { agent: "claude-code", state: "body" },
      { agent: "trae", state: "off" },
    ]);

    await userEvent.click(box("Trae"));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_set_agents");
    expect(call?.[1].args.agents).toContain("claude-code");
  });

  it("missing 显示成没启用:再点一次就是自愈,不需要第二个「修复」入口", async () => {
    draw([{ agent: "claude-code", state: "missing" }]);

    expect(box("Claude Code")).not.toBeChecked();
    await userEvent.click(box("Claude Code"));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_set_agents");
    expect(call?.[1].args.agents).toEqual(["claude-code"]);
  });

  it("copy 档如实标「副本」:改了本体它不会跟着变,用户有权知道", () => {
    draw([{ agent: "trae", state: "copy" }]);
    expect(box("Trae")).toBeChecked();
    expect(screen.getByText("副本")).toBeInTheDocument();
  });

  it("界面上只出现展示名,不出现内部 agent 名", () => {
    const { container } = draw([{ agent: "claude-code", state: "linked" }]);
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).not.toContain("claude-code");
  });
});

describe("visibleTools:按这台机器上确实装了的工具收窄(R21)", () => {
  const tools: ToolView[] = [
    { agent: "claude-code", state: "body" },
    { agent: "zed", state: "body" },
    { agent: "trae", state: "off" },
  ];

  it("🔴 装了才摆 —— 本体住统一目录时,共用它的六个工具全是恒亮不可取消的勾", () => {
    // 不收窄的话,用户机器上一个都没装的 cline/dexto/kimi-code-cli/loaf/warp/zed
    // 会摆出一串没法解释、也点不动的勾。这是今天每一条存量安装的形态。
    expect(visibleTools(tools, new Set(["claude-code", "trae"]))).toEqual([
      { agent: "claude-code", state: "body" },
      { agent: "trae", state: "off" },
    ]);
  });

  it("🔴 body 档一并收窄,不给豁免 —— 豁免掉它这条规则就什么也没做", () => {
    // R21 的动机场景恰恰就是那几个 body 勾。
    expect(visibleTools(tools, new Set(["trae"]))).toEqual([{ agent: "trae", state: "off" }]);
  });

  it("探测失败(null)时不收窄:那时没有依据说某个工具不在", () => {
    // 藏起来就是拿"不知道"当"没有"。宁可多摆几个,不凭空少摆。
    expect(visibleTools(tools, null)).toEqual(tools);
  });

  it("收窄到一个不剩时整组不渲染,不留一个空壳", () => {
    const { container } = draw(tools, new Set(["nobody"]));
    expect(container.querySelector("input")).toBeNull();
  });

  it("组件真的用了这份收窄结果", () => {
    draw(tools, new Set(["trae"]));
    expect(screen.queryByText("Claude Code")).toBeNull();
    expect(screen.getByText("Trae")).toBeInTheDocument();
  });
});

describe("忙碌态", () => {
  it("落地期间整组禁用,避免连点打架", () => {
    useMySkills.setState({ installedAgents: ALL_INSTALLED });
    render(
      <ToolChecks
        dirSlug="weekly-report"
        tools={[{ agent: "trae", state: "off" }]}
        agentNames={NAMES}
        disabled
      />,
    );
    expect(box("Trae")).toBeDisabled();
  });
});
