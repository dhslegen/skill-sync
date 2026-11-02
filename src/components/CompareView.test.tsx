import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompareSection } from "./CompareSection";
import { CompareView } from "./CompareView";
import { t } from "@/i18n";
import type { Comparison, InstalledSkillView } from "@/lib/ipc";
import { useCompare } from "@/store/compare";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";

const invoke = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  void cmd;
  void args;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const BODY = "/home/u/.claude/skills/weekly-report";

const comparison = (over: Partial<Comparison> = {}): Comparison => ({
  plan: {
    added: [{ path: "mine-only.md", body: { kind: "text" } }],
    modified: [
      {
        path: "SKILL.md",
        diff: {
          kind: "hunks",
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ op: "delete", text: "库里" }, { op: "insert", text: "我的" }] }],
          hiddenHunks: 0,
        },
      },
    ],
    deleted: [{ path: "lib-only.md", body: { kind: "text", text: "只有库里有\n" } }],
  },
  localPath: BODY,
  remoteHash: "h-lib",
  identical: false,
  ...over,
});

function answer(result: unknown) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "skill_compare_library") return result;
    if (cmd === "skill_local_file_read") return { kind: "text", text: "我本地才有\n" };
    return null;
  });
}

beforeEach(() => {
  invoke.mockReset();
  useCompare.setState({ expandedFor: null });
  useInstall.setState({ phase: "idle", dirSlug: null, error: null });
});

describe("CompareView(0.8.0 任务 3)", () => {
  it("按调用方给的库坐标比,三栏用「比较」的说法,不出现分享那句删除后果", async () => {
    answer(comparison());
    render(<CompareView dirSlug="weekly-report" registryId="custom-1" repo="team/lib" />);
    expect(await screen.findByText(new RegExp(t("compare.planOnlyMine")))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(t("compare.planModified")))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(t("compare.planOnlyLibrary")))).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("skill_compare_library", {
      args: { dirSlug: "weekly-report", registryId: "custom-1", repo: "team/lib" },
    });
    // 「只有库里有」不是这次会发生的删除——分享那句红色后果交代不能出现
    expect(screen.queryByText(/会从技能库里删掉/)).toBeNull();
    expect(screen.queryByText(t("share.planTitle"))).toBeNull();
  });

  // 🔴 v8 定向复审 I-1 的同一个坑:本体在工具目录里、没有记账时,按 dirSlug 读会落回统一目录
  it("展开「只有你有」的文件时按 core 给的本体路径读,不按 dirSlug", async () => {
    answer(comparison());
    render(<CompareView dirSlug="weekly-report" />);
    await userEvent.click(await screen.findByRole("button", { name: "mine-only.md" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("skill_local_file_read", {
        args: { path: BODY, file: "mine-only.md" },
      }),
    );
  });

  it("比对失败要说出来,并且能重试", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_compare_library") throw { code: "REPO_NOT_FOUND", message: "技能库里没有找到这个技能,请刷新后再试" };
      return null;
    });
    render(<CompareView dirSlug="weekly-report" />);
    expect(await screen.findByText(/没有找到这个技能/)).toBeInTheDocument();
    answer(comparison());
    await userEvent.click(screen.getByRole("button", { name: t("compare.retry") }));
    expect(await screen.findByText(new RegExp(t("compare.planOnlyMine")))).toBeInTheDocument();
  });

  it("内容其实一样时不摆清单,只说一句", async () => {
    answer(comparison({ identical: true, plan: { added: [], modified: [], deleted: [] } }));
    render(<CompareView dirSlug="weekly-report" />);
    expect(await screen.findByText(t("compare.identical"))).toBeInTheDocument();
  });

  it("返回形状不对时按失败说出来,不让渲染崩掉", async () => {
    answer(undefined);
    render(<CompareView dirSlug="weekly-report" />);
    expect(await screen.findByText(new RegExp(t("compare.failed")))).toBeInTheDocument();
  });
});

describe("CompareSection(详情面板里的「看看哪里不同」)", () => {
  it("默认收起,点开才去比", async () => {
    answer(comparison());
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} />);
    expect(screen.getByText(t("compare.summary"))).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("skill_compare_library", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: t("compare.toggle") }));
    expect(await screen.findByText(new RegExp(t("compare.planOnlyMine")))).toBeInTheDocument();
  });

  it("从「与库里不同」点进来的直接展开;卸载重挂(加载期间判定闪一下)后仍展开;用户收起才清意图", async () => {
    answer(comparison());
    useCompare.getState().expand("weekly-report");
    const { unmount } = render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} />);
    expect(await screen.findByText(new RegExp(t("compare.planOnlyMine")))).toBeInTheDocument();
    unmount();
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} />);
    expect(screen.getByRole("button", { name: t("compare.toggleClose") })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: t("compare.toggleClose") }));
    expect(useCompare.getState().expandedFor).toBeNull();
  });

  it("别的技能的展开意图不作数", () => {
    answer(comparison());
    useCompare.getState().expand("other-skill");
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} />);
    expect(screen.getByRole("button", { name: t("compare.toggle") })).toHaveAttribute("aria-expanded", "false");
    expect(useCompare.getState().expandedFor).toBe("other-skill");
  });

  it("「换成库里的版本」交给宿主;正在换这个技能时置灰", async () => {
    answer(comparison());
    const onReplace = vi.fn();
    useCompare.getState().expand("weekly-report");
    render(<CompareSection dirSlug="weekly-report" onReplace={onReplace} />);
    await userEvent.click(await screen.findByRole("button", { name: t("compare.useLibrary") }));
    expect(onReplace).toHaveBeenCalledTimes(1);
    act(() => useInstall.setState({ phase: "running", dirSlug: "weekly-report" }));
    expect(screen.getByRole("button", { name: t("compare.useLibrary") })).toBeDisabled();
    act(() => useInstall.setState({ phase: "running", dirSlug: "another" }));
    expect(screen.getByRole("button", { name: t("compare.useLibrary") })).toBeEnabled();
  });
});

describe("replaceWithLibrary:看完差异就是拍板,直接带 overwrite", () => {
  const row = (over: Partial<InstalledSkillView> = {}) =>
    ({ dirSlug: "weekly-report", agents: ["claude-code"], registryId: "company", sourceOwner: "skills", sourceRepo: "skills", ...over }) as InstalledSkillView;

  beforeEach(() => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install") return { outcome: "installed", report: { links: [] }, localKept: false };
      if (cmd === "installed_list") return [];
      return null;
    });
  });

  it("默认按这一行的记账来源,只沿用账上已有的工具", async () => {
    useMySkills.setState({ list: [row()] });
    await useMySkills.getState().replaceWithLibrary("weekly-report");
    expect(invoke).toHaveBeenCalledWith(
      "skill_install",
      expect.objectContaining({
        args: expect.objectContaining({
          dirSlug: "weekly-report",
          agentIds: ["claude-code"],
          resolution: "overwrite",
          registryId: "company",
          repo: "skills/skills",
        }),
      }),
    );
  });

  it("商店详情给的库坐标优先;账上没有工具时不替用户补勾", async () => {
    useMySkills.setState({ list: [row({ agents: [] })] });
    await useMySkills.getState().replaceWithLibrary("weekly-report", { registryId: "custom-1", repo: "team/lib" });
    expect(invoke).not.toHaveBeenCalledWith("agents_detected", expect.anything());
    expect(invoke).toHaveBeenCalledWith(
      "skill_install",
      expect.objectContaining({
        args: expect.objectContaining({ agentIds: [], resolution: "overwrite", registryId: "custom-1", repo: "team/lib" }),
      }),
    );
  });

  it("列表里还没有这一行也不能零反馈:照样发出去", async () => {
    useMySkills.setState({ list: null });
    await useMySkills.getState().replaceWithLibrary("weekly-report", { registryId: "company" });
    expect(invoke).toHaveBeenCalledWith(
      "skill_install",
      expect.objectContaining({ args: expect.objectContaining({ resolution: "overwrite" }) }),
    );
  });
});
