import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySkillsPage } from "./MySkillsPage";
import type { InstalledSkillView, ShareCandidate } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMySkills } from "@/store/my-skills";
import { useShare } from "@/store/share";
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
  libraryRemoved: false,
  relation: "installed",
  localPresent: true,
  sourceLabel: "skills/skills",
  links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "healthy" }],
  ...over,
});

const AGENT_LIST = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "cursor", displayName: "Cursor", installed: true, globalSkillsDir: "~/.agents/skills", isUniversal: true, needsLink: false, disabled: false },
  ],
  canonicalDir: "~/.agents/skills",
};

/** 页面挂载即 load(),测试数据从 mock 的 IPC 里来——绕过它去 setState 会被 load 的结果冲掉。 */
function seedIpc(list: InstalledSkillView[], extra: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "installed_list") return list;
    if (cmd === "agents_detected") return AGENT_LIST;
    if (cmd in extra) return extra[cmd];
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
          tags: [],
          author: null,
        },
      ],
    },
  });
}

function shareCandidate(over: Partial<ShareCandidate> = {}): ShareCandidate {
  return {
    dirName: "my-draft",
    path: "/canonical/my-draft",
    inCanonical: true,
    origin: { kind: "local" },
    name: "我的草稿",
    description: null,
    problem: null,
    shared: null,
    dirNameUsable: true,
    ...over,
  };
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
    shareConflict: null,
  });
  useInstall.setState({ phase: "idle", dirSlug: null, precheck: null });
  useStoreIndex.setState({ index: null });
  useUi.setState({ page: "mine" });
  useShare.setState({
    candidates: null,
    scanError: null,
    scanning: false,
    phase: "idle",
    target: null,
    form: { shareName: "", displayName: "", description: "" },
    targetRepo: null,
    preview: "unknown",
    staleNotice: false,
    shareError: null,
    done: null,
  });
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

  it("技能库不在列表里:说的是这句话,不是「来源已移除」(M4 任务 2)", async () => {
    // 源好好的,只是这个技能库不在你的库列表里(M3 绑歪的存量条目,
    // 或用户后来把库移除了)。去向与来源已移除相同,但**说法必须不同**
    // ——说"来源已移除"是假话,而且会把用户引去查一个根本没问题的来源。
    seedIndex("sha256:newer");
    seedIpc([view({ libraryRemoved: true, localModified: true })]);
    render(<MySkillsPage />);

    await screen.findByText("周报生成");
    expect(screen.getByText("技能库不在列表中")).toBeInTheDocument();
    expect(screen.queryByText("来源已移除")).not.toBeInTheDocument();
    // 与来源已移除同样:更新与回推没有去处,不摆按钮引诱用户撞错误
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享改动" })).not.toBeInTheDocument();
  });

  it("库里有新版本时出现更新按钮;点击沿用记账的工具直接更新", async () => {
    seedIndex("sha256:newer");
    seedIpc([view({ agents: ["claude-code", "cursor"] })], {
      skill_install: {
        outcome: "installed",
        report: { dirName: "weekly-report", canonicalDir: "/c", links: [] },
        localKept: false,
        lock: "written",
      },
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "更新" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect([...call![1].args.agentIds].sort()).toEqual(["claude-code", "cursor"]);
  });

  it("两分区固定顺序:我分享的 → 我安装的 → 装在项目里的", async () => {
    seedIpc([
      view({ dirSlug: "installed-one" }),
      view({ dirSlug: "shared-one", relation: "shared" }),
      view({ dirSlug: "draft-one", relation: "draft", agents: [], links: [], commitSha: "", contentHash: "" }),
    ]);
    render(<MySkillsPage />);

    await screen.findByText("installed-one");
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    // 「装在项目里的」(v5)恒在最后:它按项目分组、数据源也不同,
    // 空的时候摆引导语而不是隐藏——否则用户不知道有这条路。
    expect(headings).toEqual(["我分享的", "我安装的", "装在项目里的"]);
  });

  it("空分区不显示标题", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);

    await screen.findByText("weekly-report");
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["我安装的", "装在项目里的"]);
  });

  it("「纳入管理」「移出管理」「其他工具装的」三个字符串不再出现在 DOM(v6 撤销)", async () => {
    seedIpc([
      view({ dirSlug: "installed-one" }),
      view({ dirSlug: "shared-one", relation: "shared" }),
      view({ dirSlug: "draft-one", relation: "draft", agents: [], links: [], commitSha: "", contentHash: "" }),
      view({ dirSlug: "not-here", relation: "shared", localPresent: false, agents: [], links: [], commitSha: "", contentHash: "", sourceLabel: null }),
    ]);
    render(<MySkillsPage />);

    await screen.findByText("installed-one");
    expect(screen.queryByText("纳入管理")).not.toBeInTheDocument();
    expect(screen.queryByText("移出管理")).not.toBeInTheDocument();
    expect(screen.queryByText("其他工具装的")).not.toBeInTheDocument();
  });

  it("改过的技能带「已改动」徽标", async () => {
    seedIpc([view({ localModified: true })]);
    render(<MySkillsPage />);
    expect(await screen.findByText("已改动")).toBeInTheDocument();
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

  it("链接健康时没有「修复」按钮", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);
    await screen.findByText("weekly-report");
    expect(screen.queryByRole("button", { name: "修复" })).not.toBeInTheDocument();
  });

  it("改过的技能给「分享改动」按钮;点击把改动推回来源", async () => {
    seedIpc([view({ localModified: true })], {
      skill_share_changes: { kind: "submitted", mode: "pushed", commitSha: "new", reviewUrl: null },
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享改动" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(call?.[1].args.dirSlug).toBe("weekly-report");
    expect(await screen.findByText(/改动已分享/)).toBeInTheDocument();
  });

  it("分享改动撞上他人的新版:进冲突档等拍板,不当错误展示", async () => {
    seedIpc([view({ localModified: true })], {
      skill_share_changes: { kind: "remoteChanged", historyUrl: "http://g/skills/skills/commits/x" },
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享改动" }));

    expect(useMySkills.getState().shareConflict).toEqual({
      dirSlug: "weekly-report",
      historyUrl: "http://g/skills/skills/commits/x",
    });
    expect(useMySkills.getState().shareError).toBeNull();
    expect(screen.queryByText(/没能完成/)).not.toBeInTheDocument();
  });

  it("没改过的技能没有「分享改动」按钮", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);
    await screen.findByText("weekly-report");
    expect(screen.queryByRole("button", { name: "分享改动" })).not.toBeInTheDocument();
  });

  it("改动走了评审:提示审核中,「已改动」徽标不消失", async () => {
    seedIpc([view({ localModified: true })], {
      skill_share_changes: {
        kind: "submitted",
        mode: "reviewRequested",
        commitSha: "new",
        reviewUrl: "http://x/pulls/3",
      },
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
});

describe("「我分享的」区块 · 六状态机(v6 任务 4)", () => {
  beforeEach(reset);

  it("notHere:库里有、这台电脑没有本体 —— 摆「取回」,真实点击后 invoke 带 skill_install", async () => {
    seedIpc(
      [
        view({
          relation: "shared",
          localPresent: false,
          agents: [],
          links: [],
          commitSha: "",
          contentHash: "",
          sourceLabel: null,
        }),
      ],
      {
        skill_install: {
          outcome: "installed",
          report: { dirName: "weekly-report", canonicalDir: "/c", links: [] },
          localKept: false,
          lock: "written",
        },
      },
    );
    render(<MySkillsPage />);

    await screen.findByText("我分享的");
    expect(screen.getByText("不在这台电脑")).toBeInTheDocument();
    // 这台电脑从没装过:没有实体记账,「移除」「修复」都不该出现
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "取回" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect(call?.[1].args.dirSlug).toBe("weekly-report");
    // notHere 时账上没有工具可沿用,退化为默认规则(已探测到、未禁用)
    expect([...call![1].args.agentIds].sort()).toEqual(["claude-code", "cursor"]);
  });

  it("draft:尚未分享 —— 摆「分享」,点击跳分享页并预选那个候选", async () => {
    seedIpc(
      [
        view({
          dirSlug: "my-draft",
          relation: "draft",
          agents: [],
          links: [],
          commitSha: "",
          contentHash: "",
          sourceOwner: "",
          sourceRepo: "",
          registryId: "",
          sourceLabel: null,
        }),
      ],
      { share_candidates: [shareCandidate()], share_preview: "unknown" },
    );
    render(<MySkillsPage />);

    await screen.findByText("尚未分享");
    expect(screen.queryByRole("button", { name: "取回" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "分享" }));

    expect(useUi.getState().page).toBe("share");
    await vi.waitFor(() => {
      expect(useShare.getState().target?.dirName).toBe("my-draft");
    });
    expect(useShare.getState().phase).toBe("form");
  });

  it("remoteAhead:库里有新版、本地没改 —— 摆「取回」", async () => {
    seedIndex("sha256:newer");
    seedIpc([view({ relation: "shared" })]);
    render(<MySkillsPage />);

    await screen.findByText("库里有新版");
    expect(screen.getByRole("button", { name: "取回" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享更新" })).not.toBeInTheDocument();
  });

  it("localAhead:本地改过、库里没变 —— 摆「分享更新」,点击调用 skill_share_changes", async () => {
    seedIndex(); // 与 view() 的 contentHash 一致 = 库里没变
    seedIpc([view({ relation: "shared", localModified: true })], {
      skill_share_changes: { kind: "submitted", mode: "pushed", commitSha: "new", reviewUrl: null },
    });
    render(<MySkillsPage />);

    await screen.findByText("有改动未分享");
    expect(screen.queryByRole("button", { name: "取回" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "分享更新" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(call?.[1].args.dirSlug).toBe("weekly-report");
  });

  it("both:库里有新版 + 本地也有改动 —— 摆「取回」,core 返回 needsDecision 时进冲突态", async () => {
    seedIndex("sha256:newer");
    seedIpc([view({ relation: "shared", localModified: true })], {
      skill_install: {
        outcome: "needsDecision",
        precheck: { status: "mine", localChanged: true, remoteChanged: true },
      },
    });
    render(<MySkillsPage />);

    await screen.findByText("库里有新版,本地也有改动");
    await userEvent.click(screen.getByRole("button", { name: "取回" }));

    await vi.waitFor(() => {
      expect(useInstall.getState().phase).toBe("conflict");
    });
    expect(useInstall.getState().precheck).toEqual({
      status: "mine",
      localChanged: true,
      remoteChanged: true,
    });
  });

  it("synced:没有改动、库里也没有新版 —— 不摆任何主动作按钮", async () => {
    seedIndex(); // 与 view() 的 contentHash 一致
    seedIpc([view({ relation: "shared" })]);
    render(<MySkillsPage />);

    await screen.findByText("已同步");
    expect(screen.queryByRole("button", { name: "取回" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享" })).not.toBeInTheDocument();
    // 有真实记账(commitSha 非空)的行仍然可以移除
    expect(screen.getByRole("button", { name: "移除" })).toBeInTheDocument();
  });

  it("有来源标签时展示「来源 owner/repo」", async () => {
    seedIpc([view({ relation: "shared", sourceLabel: "vercel-labs/skills" })]);
    render(<MySkillsPage />);

    expect(await screen.findByText("来源 vercel-labs/skills")).toBeInTheDocument();
  });

  it("尚未分享/不在这台电脑的行同样能点开详情", async () => {
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    seedIpc([
      view({
        relation: "shared",
        localPresent: false,
        agents: [],
        links: [],
        commitSha: "",
        contentHash: "",
        sourceLabel: null,
      }),
    ]);
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /weekly-report|周报生成/ }));

    expect(invoke).toHaveBeenCalledWith("skill_local_detail", {
      args: { dirSlug: "weekly-report" },
    });
  });
});
