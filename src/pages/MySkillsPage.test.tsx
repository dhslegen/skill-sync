import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySkillsPage } from "./MySkillsPage";
import type { InstalledSkillView } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const view = (over: Partial<InstalledSkillView> = {}): InstalledSkillView => ({
  dirSlug: "weekly-report",
  commitSha: "aaa1111",
  agents: ["claude-code"],
  installedAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
  localModified: false,
  sourceOwner: "skills",
  sourceRepo: "skills",
  bodyPresent: true,
  links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "healthy" }],
  ...over,
});

/** 页面挂载即 load(),测试数据从 mock 的 IPC 里来——绕过它去 setState 会被 load 的结果冲掉。 */
function seedIpc(list: InstalledSkillView[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "installed_list") return list;
    if (cmd === "agents_detected")
      return {
        agents: [
          { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true },
          { name: "cursor", displayName: "Cursor", installed: true, globalSkillsDir: "~/.agents/skills", isUniversal: true, needsLink: false },
        ],
        canonicalDir: "~/.agents/skills",
      };
    return null;
  });
}

function seedIndex(commitSha = "aaa1111") {
  useStoreIndex.setState({
    index: {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      branch: "main",
      commitSha,
      committedAt: "2026-07-30T10:00:00Z",
      fetchedAt: 0,
      skipped: [],
      fromCache: false,
      offline: false,
      skills: [
        {
          name: "周报生成",
          dirSlug: "weekly-report",
          description: "",
          path: "",
          hasScripts: false,
          fileCount: 1,
        },
      ],
    },
  });
}

function reset() {
  invoke.mockReset();
  seedIpc([]);
  useMySkills.setState({
    list: null,
    loadError: null,
    loading: false,
    agentNames: new Map(),
    removePhase: "idle",
    removeTarget: null,
    removeError: null,
    repairConfirmTarget: null,
    repairBusy: null,
    repairError: null,
    shareBusy: null,
    shareDone: null,
    shareError: null,
  });
  useInstall.setState({ phase: "idle", dirSlug: null });
  useStoreIndex.setState({ index: null });
  useUi.setState({ page: "mine" });
}

describe("我的技能页", () => {
  beforeEach(reset);

  it("空列表引导去商店;点按钮切页", async () => {
    render(<MySkillsPage />);

    expect(await screen.findByText("还没有获取任何技能。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "去技能商店看看" }));
    expect(useUi.getState().page).toBe("store");
  });

  it("读取失败显示错误与重试,绝不显示空状态文案", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") throw { code: "FS_TASK", message: "读取已安装列表失败,请重试" };
      return { agents: [], canonicalDir: "" };
    });
    render(<MySkillsPage />);

    expect(await screen.findByText(/读取已安装列表失败/)).toBeInTheDocument();
    expect(screen.queryByText("还没有获取任何技能。")).not.toBeInTheDocument();
  });

  it("行里是展示名与工具显示名,不是内部标识", async () => {
    seedIndex();
    seedIpc([view()]);
    render(<MySkillsPage />);

    expect(await screen.findByText("周报生成")).toBeInTheDocument();
    expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
    expect(screen.queryByText(/weekly-report/)).not.toBeInTheDocument();
    // 来源用 owner/repo 说清楚
    expect(screen.getByText(/skills\/skills/)).toBeInTheDocument();
  });

  it("索引查不到时退回目录名,而不是留空", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();
  });

  it("版本一致时没有更新按钮 —— 不能引诱用户做无意义的重装", async () => {
    seedIndex("aaa1111");
    seedIpc([view()]);
    render(<MySkillsPage />);

    await screen.findByText("周报生成");
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
  });

  it("库里有新版本时出现更新按钮;点击沿用记账的工具直接更新", async () => {
    seedIndex("bbb2222");
    seedIpc([view({ agents: ["claude-code", "cursor"] })]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view({ agents: ["claude-code", "cursor"] })];
      if (cmd === "skill_install")
        return {
          outcome: "installed",
          report: { dirName: "weekly-report", canonicalDir: "/c", links: [] },
          localKept: false,
          lock: "written",
        };
      return { agents: [], canonicalDir: "" };
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "更新" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect([...call![1].args.agentIds].sort()).toEqual(["claude-code", "cursor"]);
  });

  it("改过的技能带「已改动」徽标", async () => {
    seedIpc([view({ localModified: true })]);
    render(<MySkillsPage />);
    expect(await screen.findByText("已改动")).toBeInTheDocument();
  });

  it("本体丢失要正面说出来", async () => {
    seedIpc([view({ bodyPresent: false })]);
    render(<MySkillsPage />);
    expect(await screen.findByText("本地文件缺失")).toBeInTheDocument();
  });

  it("关联异常按条数报,悬停给人话说明", async () => {
    seedIpc([
      view({
        links: [
          { dir: "/h/.claude/skills", mode: "symlink", health: "broken" },
          { dir: "/h/.trae/skills", mode: "junction", health: "healthy" },
        ],
      }),
    ]);
    render(<MySkillsPage />);

    const badge = await screen.findByText("1 处关联异常");
    // title 里是给人读的解释,不是 broken 这种内部枚举值
    expect(badge.getAttribute("title")).toContain("关联指向的内容已不存在");
    expect(badge.getAttribute("title")).not.toContain("broken");
  });

  it("链接全部健康时没有异常徽标", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);
    await screen.findByText("weekly-report");
    expect(screen.queryByText(/关联异常/)).not.toBeInTheDocument();
  });

  it("有关联异常且本体在:给「修复」按钮", async () => {
    seedIpc([
      view({ links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "missing" }] }),
    ]);
    render(<MySkillsPage />);
    expect(await screen.findByRole("button", { name: "修复" })).toBeInTheDocument();
  });

  it("本体丢失时不给「修复」—— 链接修不了,该走的是更新重新获取", async () => {
    seedIpc([
      view({
        bodyPresent: false,
        links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "broken" }],
      }),
    ]);
    render(<MySkillsPage />);
    await screen.findByText("本地文件缺失");
    expect(screen.queryByRole("button", { name: "修复" })).not.toBeInTheDocument();
  });

  it("链接健康时没有「修复」按钮", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);
    await screen.findByText("weekly-report");
    expect(screen.queryByRole("button", { name: "修复" })).not.toBeInTheDocument();
  });

  it("改过的技能给「分享改动」按钮;点击把改动推回来源", async () => {
    seedIpc([view({ localModified: true })]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view({ localModified: true })];
      if (cmd === "skill_share_changes")
        return { mode: "pushed", commitSha: "new", reviewUrl: null };
      return { agents: [], canonicalDir: "" };
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享改动" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(call?.[1].args.dirSlug).toBe("weekly-report");
    expect(await screen.findByText(/改动已分享/)).toBeInTheDocument();
  });

  it("没改过的技能没有「分享改动」按钮", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);
    await screen.findByText("weekly-report");
    expect(screen.queryByRole("button", { name: "分享改动" })).not.toBeInTheDocument();
  });

  it("改动走了评审:提示审核中,「已改动」徽标不消失", async () => {
    seedIpc([view({ localModified: true })]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view({ localModified: true })];
      if (cmd === "skill_share_changes")
        return { mode: "reviewRequested", commitSha: "new", reviewUrl: "http://x/pulls/3" };
      return { agents: [], canonicalDir: "" };
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享改动" }));

    expect(await screen.findByText(/已提交审核/)).toBeInTheDocument();
    expect(screen.getByText("已改动")).toBeInTheDocument();
  });

  it("点移除进入确认流程,磁盘未被碰过", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "移除" }));

    expect(useMySkills.getState().removePhase).toBe("confirming");
    expect(useMySkills.getState().removeTarget).toBe("weekly-report");
    expect(invoke).not.toHaveBeenCalledWith("skill_remove", expect.anything());
  });
});
