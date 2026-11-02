import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompareSection } from "./CompareSection";
import { CompareView } from "./CompareView";
import { keepMineFor } from "./DetailPanel";
import { t } from "@/i18n";
import type { Comparison, InstalledSkillView } from "@/lib/ipc";
import { useCompare } from "@/store/compare";
import { useInstall } from "@/store/install";
import { hasUpdate, keptNow, useMySkills } from "@/store/my-skills";

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

const KEEP = { kind: "remember" as const, run: async () => {} };

describe("CompareSection(详情面板里的「看看哪里不同」)", () => {
  it("默认收起,点开才去比", async () => {
    answer(comparison());
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={KEEP} />);
    expect(screen.getByText(t("compare.summary"))).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("skill_compare_library", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: t("compare.toggle") }));
    expect(await screen.findByText(new RegExp(t("compare.planOnlyMine")))).toBeInTheDocument();
  });

  it("从「与库里不同」点进来的直接展开;卸载重挂(加载期间判定闪一下)后仍展开;用户收起才清意图", async () => {
    answer(comparison());
    useCompare.getState().expand("weekly-report");
    const { unmount } = render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={KEEP} />);
    expect(await screen.findByText(new RegExp(t("compare.planOnlyMine")))).toBeInTheDocument();
    unmount();
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={KEEP} />);
    expect(screen.getByRole("button", { name: t("compare.toggleClose") })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: t("compare.toggleClose") }));
    expect(useCompare.getState().expandedFor).toBeNull();
  });

  it("别的技能的展开意图不作数", () => {
    answer(comparison());
    useCompare.getState().expand("other-skill");
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={KEEP} />);
    expect(screen.getByRole("button", { name: t("compare.toggle") })).toHaveAttribute("aria-expanded", "false");
    expect(useCompare.getState().expandedFor).toBe("other-skill");
  });

  it("「换成库里的版本」交给宿主;正在换这个技能时置灰", async () => {
    answer(comparison());
    const onReplace = vi.fn();
    useCompare.getState().expand("weekly-report");
    render(<CompareSection dirSlug="weekly-report" onReplace={onReplace} keepMine={KEEP} />);
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

// ---- 0.8.0 任务 4:「保留我的版本」
describe("CompareSection 的「保留我的版本」", () => {
  it("非作者:按钮叫「保留我的版本」,点了就记住并收起", async () => {
    answer(comparison());
    const run = vi.fn(async () => {});
    useCompare.getState().expand("weekly-report");
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={{ kind: "remember", run }} />);
    await userEvent.click(await screen.findByRole("button", { name: t("compare.keepMine") }));
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("compare.toggle") })).toHaveAttribute("aria-expanded", "false"),
    );
    expect(useCompare.getState().expandedFor).toBeNull();
  });

  it("作者:按钮叫「保留并分享我的版本」", async () => {
    answer(comparison());
    useCompare.getState().expand("weekly-report");
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={{ kind: "share", run: async () => {} }} />);
    expect(await screen.findByRole("button", { name: t("compare.shareMine") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("compare.keepMine") })).toBeNull();
  });

  it("失败要在这一块说出来,并且不收起", async () => {
    answer(comparison());
    useCompare.getState().expand("weekly-report");
    const run = vi.fn(async () => {
      throw { code: "REPO_NOT_FOUND", message: "技能库里这个技能的版本信息还没准备好,请刷新后再试" };
    });
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={{ kind: "remember", run }} />);
    await userEvent.click(await screen.findByRole("button", { name: t("compare.keepMine") }));
    expect(await screen.findByText(/版本信息还没准备好/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(t("compare.keepFailed")))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("compare.toggleClose") })).toBeInTheDocument();
  });

  it("已经保留过:摘要换成安静的一句,不再摆「保留」那颗", async () => {
    answer(comparison());
    useCompare.getState().expand("weekly-report");
    render(<CompareSection dirSlug="weekly-report" onReplace={() => {}} keepMine={KEEP} kept />);
    expect(screen.getByText(t("compare.keptSummary"))).toBeInTheDocument();
    expect(screen.queryByText(t("compare.summary"))).toBeNull();
    await screen.findByRole("button", { name: t("compare.useLibrary") });
    expect(screen.queryByRole("button", { name: t("compare.keepMine") })).toBeNull();
  });
});

describe("keepMine / keptNow / hasUpdate(0.8.0 任务 4)", () => {
  const view = (over: Partial<InstalledSkillView> = {}) =>
    ({
      dirSlug: "weekly-report", agents: [], registryId: "company", sourceOwner: "skills", sourceRepo: "skills",
      contentHash: "h-base", relation: "installed", sourceRemoved: false, libraryRemoved: false, keptAgainst: null,
      ...over,
    }) as InstalledSkillView;
  const index = (hash: string) => ({
    registryId: "company", owner: "skills", repo: "skills", skills: [{ dirSlug: "weekly-report", contentHash: hash }],
  });

  it("keptNow 只在记的那一版 = 此刻库里那一版时算数", () => {
    expect(keptNow(view({ keptAgainst: "h-lib" }), "h-lib")).toBe(true);
    expect(keptNow(view({ keptAgainst: "h-lib" }), "h-lib-2")).toBe(false);
    expect(keptNow(view({ keptAgainst: null }), "h-lib")).toBe(false);
    expect(keptNow(view({ keptAgainst: "h-lib" }), "")).toBe(false);
  });

  it("对库里这一版保留过 → 不再算「库里有新版」;库里再更新 → 照常算", () => {
    expect(hasUpdate(view(), index("h-lib"))).toBe(true);
    expect(hasUpdate(view({ keptAgainst: "h-lib" }), index("h-lib"))).toBe(false);
    expect(hasUpdate(view({ keptAgainst: "h-lib" }), index("h-lib-2"))).toBe(true);
  });

  it("keepMine 按给的库坐标记,记完重读列表", async () => {
    invoke.mockImplementation(async () => null);
    useMySkills.setState({ list: [view()] });
    await useMySkills.getState().keepMine("weekly-report", { registryId: "custom-1", repo: "team/lib" });
    expect(invoke).toHaveBeenCalledWith("skill_keep_against", {
      args: { dirSlug: "weekly-report", registryId: "custom-1", repo: "team/lib" },
    });
    expect(invoke).toHaveBeenCalledWith("installed_list", undefined);
  });

  it("keepMine 失败往外抛(由按钮那一块渲染)", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_keep_against") throw { code: "REPO_NOT_FOUND", message: "x" };
      return null;
    });
    useMySkills.setState({ list: [view()] });
    await expect(useMySkills.getState().keepMine("weekly-report")).rejects.toMatchObject({ code: "REPO_NOT_FOUND" });
  });
});

describe("冲突弹窗「保留本地的」也记住这个决定(keepLocalAndRemember)", () => {
  it("保留成功后记一笔,带上这次安装的库坐标", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install") return { outcome: "installed", report: { links: [] }, localKept: true };
      return cmd === "installed_list" ? [] : null;
    });
    useInstall.setState({ phase: "conflict", dirSlug: "weekly-report", registryId: "custom-1", repo: "team/lib", selected: new Set() });
    await useInstall.getState().keepLocalAndRemember();
    expect(invoke).toHaveBeenCalledWith("skill_keep_against", {
      args: { dirSlug: "weekly-report", registryId: "custom-1", repo: "team/lib" },
    });
  });

  it("保留本身失败了就不记", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install") throw { code: "NET_FAILED", message: "断网了" };
      return null;
    });
    useInstall.setState({ phase: "conflict", dirSlug: "weekly-report", registryId: null, repo: null, selected: new Set() });
    await useInstall.getState().keepLocalAndRemember();
    expect(invoke).not.toHaveBeenCalledWith("skill_keep_against", expect.anything());
  });
});

describe("keepMineFor:按是不是作者分两档(0.8.0 任务 4)", () => {
  const view = (over: Partial<InstalledSkillView> = {}) =>
    ({ dirSlug: "weekly-report", relation: "installed", contentHash: "h-base", ...over }) as InstalledSkillView;

  it("非作者 → 记住这一版,带宿主给的库坐标", async () => {
    const keepMine = vi.fn(async () => {});
    useMySkills.setState({ keepMine });
    const k = keepMineFor(view(), "weekly-report", "周报生成", { registryId: "custom-1", repo: "team/lib" });
    expect(k.kind).toBe("remember");
    await k.run();
    expect(keepMine).toHaveBeenCalledWith("weekly-report", { registryId: "custom-1", repo: "team/lib" });
  });

  it("作者且有记账 → 走「分享改动」;预览失败归属这个技能时抛回给按钮那一块", async () => {
    const shareChanges = vi.fn(async () => {
      useMySkills.setState({ shareError: { dirSlug: "weekly-report", error: { code: "NET_FAILED", message: "断网了" }, flow: "changes" } });
    });
    useMySkills.setState({ shareChanges, shareError: null });
    const k = keepMineFor(view({ relation: "shared" }), "weekly-report", "周报生成");
    expect(k.kind).toBe("share");
    await expect(k.run()).rejects.toMatchObject({ message: "断网了" });
    expect(shareChanges).toHaveBeenCalledWith("weekly-report", "周报生成");
  });

  it("作者但没有记账 → 走「分享」确认屏", async () => {
    const beginShare = vi.fn();
    useMySkills.setState({ beginShare, shareError: null });
    await keepMineFor(view({ relation: "shared", contentHash: "" }), "weekly-report", "周报生成").run();
    expect(beginShare).toHaveBeenCalledWith("weekly-report");
  });
});
