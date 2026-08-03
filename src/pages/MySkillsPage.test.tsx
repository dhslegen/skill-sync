import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySkillsPage } from "./MySkillsPage";
import type { InstalledSkillView } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const view = (over: Partial<InstalledSkillView> = {}): InstalledSkillView => ({
  dirSlug: "weekly-report",
  commitSha: "aaa1111",
  contentHash: "sha256:mine",
  agents: ["claude-code"],
  installedAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
  localModified: false,
  sourceOwner: "skills",
  sourceRepo: "skills",
  registryId: "company",
  sourceRemoved: false,
  unclaimed: false,
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
          { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
          { name: "cursor", displayName: "Cursor", installed: true, globalSkillsDir: "~/.agents/skills", isUniversal: true, needsLink: false, disabled: false },
        ],
        canonicalDir: "~/.agents/skills",
      };
    return null;
  });
}

/** 远端这一版的内容指纹。与 view() 的 contentHash 一致 = 已是最新;
 *  不一致 = 有可用更新(判定按逐技能内容,不再看整库 sha)。 */
function seedIndex(remoteHash = "sha256:mine") {
  useStoreIndex.setState({
    index: {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      branch: "main",
      commitSha: "headsha",
      committedAt: "2026-07-30T10:00:00Z",
      fetchedAt: 0,
      skipped: [],
      fromCache: false,
      offline: false,
      curated: [],
      skills: [
        {
          name: "周报生成",
          dirSlug: "weekly-report",
          description: "",
          path: "",
          hasScripts: false,
          fileCount: 1,
          contentHash: remoteHash,
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
    seedIndex();
    seedIpc([view()]);
    render(<MySkillsPage />);

    await screen.findByText("周报生成");
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
  });

  it("上游装的未认领技能:标签 + 认领按钮,点击走 skill_claim", async () => {
    const calls: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "installed_list")
        return [
          view({
            dirSlug: "upstream-skill",
            unclaimed: true,
            sourceOwner: "vercel-labs",
            sourceRepo: "skills",
            agents: [],
            links: [],
          }),
        ];
      if (cmd === "skill_claim") return { dirSlug: "upstream-skill", adoptedLinks: 1, bound: false };
      if (cmd === "agents_detected") return { agents: [], canonicalDir: "~/.agents/skills" };
      return [];
    });
    seedIndex();
    render(<MySkillsPage />);

    await screen.findByText("npx skills 安装");
    // 未认领:更新/移除/分享改动都不该出现
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    const claimButton = screen.getByRole("button", { name: "认领" });
    await userEvent.click(claimButton);
    await vi.waitFor(() => {
      expect(calls).toContain("skill_claim");
    });
  });

  it("来源已移除:亮出徽标,且更新与分享改动都不再提供", async () => {
    // 索引有新版本、本体也有改动——正常情况下两个按钮都该在,
    // 但来源没了,更新与回推都没有去处,摆出来就是引诱用户撞错误
    seedIndex("sha256:newer");
    seedIpc([view({ sourceRemoved: true, localModified: true })]);
    render(<MySkillsPage />);

    await screen.findByText("周报生成");
    expect(screen.getByText("来源已移除")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享改动" })).not.toBeInTheDocument();
  });

  it("库里有新版本时出现更新按钮;点击沿用记账的工具直接更新", async () => {
    seedIndex("sha256:newer");
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

  it("点行内名称区打开本地详情(按 dirSlug 请求)", async () => {
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    seedIpc([view()]);
    seedIndex();
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /周报生成/ }));

    expect(invoke).toHaveBeenCalledWith("skill_local_detail", {
      args: { dirSlug: "weekly-report" },
    });
  });

  it("右侧动作按钮不会顺带打开详情", async () => {
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    seedIpc([view()]);
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "移除" }));

    expect(invoke).not.toHaveBeenCalledWith("skill_local_detail", expect.anything());
    expect(useLocalDetail.getState().target).toBeNull();
  });

  it("未认领行同样能点开详情", async () => {
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    seedIpc([view({ unclaimed: true, sourceOwner: "vercel-labs", sourceRepo: "skills" })]);
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /weekly-report|周报生成/ }));

    expect(invoke).toHaveBeenCalledWith("skill_local_detail", {
      args: { dirSlug: "weekly-report" },
    });
  });
});
