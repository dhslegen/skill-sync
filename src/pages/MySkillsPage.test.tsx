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
  libraryRemoved: false,
  unclaimed: false,
  claimBindable: false,
  localOnly: false,
  claimed: false,
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
          tags: [],
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

  it("其他工具装的、绑得上技能库:摆「纳入管理」,点了就纳入(M6 任务 4)", async () => {
    const calls: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "installed_list")
        return [
          view({
            dirSlug: "upstream-skill",
            unclaimed: true,
            claimBindable: true,
            sourceOwner: "vercel-labs",
            sourceRepo: "skills",
            agents: [],
            links: [],
          }),
        ];
      if (cmd === "skill_claim") return { dirSlug: "upstream-skill", adoptedLinks: 1, bound: true };
      if (cmd === "agents_detected") return { agents: [], canonicalDir: "~/.agents/skills" };
      return [];
    });
    seedIndex();
    render(<MySkillsPage />);

    await screen.findByText("其他工具装的");
    // 尚未纳入管理:更新/移除/分享改动都不该出现
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    const claimButton = screen.getByRole("button", { name: "纳入管理" });
    await userEvent.click(claimButton);
    await vi.waitFor(() => {
      expect(calls).toContain("skill_claim");
    });

  });

  it("其他工具装的、绑不上技能库:不摆「纳入管理」,给「分享到技能库」(M6 任务 4)", async () => {
    // 绑不上时纳入管理只多出"修复关联"与"移除",换不来更新也换不来分享改动
    // ——摆出来就是引诱用户点一个没有意义的按钮。真正的出路是先推进公司库。
    seedIpc([
      view({
        dirSlug: "from-github",
        unclaimed: true,
        claimBindable: false,
        sourceOwner: "vercel-labs",
        sourceRepo: "skills",
        agents: [],
        links: [],
      }),
    ]);
    render(<MySkillsPage />);

    await screen.findByText("其他工具装的");
    expect(screen.queryByRole("button", { name: "纳入管理" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "分享到技能库" }));
    expect(useUi.getState().page).toBe("share");
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

  it("三档按分区展示:由技能库管理 → 本地创建 → 其他工具装的,固定顺序", async () => {
    // M5 任务 2(用户拍板):彻底放弃徽标归类,改为分区;归类判据在 core
    // (localOnly 来自文件系统扫描、unclaimed 来自 lock 文件,均为文件系统真相)
    seedIpc([
      view(),
      view({ dirSlug: "my-draft", localOnly: true, agents: [], links: [] }),
      view({ dirSlug: "upstream-skill", unclaimed: true, agents: [], links: [] }),
    ]);
    render(<MySkillsPage />);

    await screen.findByText("weekly-report");
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["由技能库管理", "本地创建", "其他工具装的"]);
  });

  it("空分区不显示标题", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);

    await screen.findByText("weekly-report");
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["由技能库管理"]);
  });

  it("归类徽标(含 npx 警示色)彻底撤掉,分区标题即区分", async () => {
    seedIpc([
      view({ dirSlug: "my-draft", localOnly: true, agents: [], links: [] }),
      view({ dirSlug: "upstream-skill", unclaimed: true, agents: [], links: [] }),
    ]);
    render(<MySkillsPage />);

    await screen.findByText("my-draft");
    // 旧徽标靠 title 提示语辨认:它们不该再出现在任何行内
    expect(
      screen.queryByTitle("这个技能是在本机创建的,还没有分享到技能库。"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("这个技能由命令行工具装入,纳入管理后就能在这里更新、修复与移除。"),
    ).not.toBeInTheDocument();
    // 「本地创建」只出现一次(分区标题),不再有同文本的行内徽标
    expect(screen.getAllByText("本地创建")).toHaveLength(1);
    expect(screen.getAllByText("其他工具装的")).toHaveLength(1);
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
    seedIpc([view({ localModified: true })]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view({ localModified: true })];
      if (cmd === "skill_share_changes")
        return { kind: "submitted", mode: "pushed", commitSha: "new", reviewUrl: null };
      return { agents: [], canonicalDir: "" };
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享改动" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(call?.[1].args.dirSlug).toBe("weekly-report");
    expect(await screen.findByText(/改动已分享/)).toBeInTheDocument();
  });

  it("分享改动撞上他人的新版:进冲突档等拍板,不当错误展示", async () => {
    seedIpc([view({ localModified: true })]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view({ localModified: true })];
      if (cmd === "skill_share_changes")
        return { kind: "remoteChanged", historyUrl: "http://g/skills/skills/commits/x" };
      return { agents: [], canonicalDir: "" };
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
    seedIpc([view({ localModified: true })]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view({ localModified: true })];
      if (cmd === "skill_share_changes")
        return { kind: "submitted", mode: "reviewRequested", commitSha: "new", reviewUrl: "http://x/pulls/3" };
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

  it("尚未纳入管理的行同样能点开详情", async () => {
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    seedIpc([view({ unclaimed: true, sourceOwner: "vercel-labs", sourceRepo: "skills" })]);
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /weekly-report|周报生成/ }));

    expect(invoke).toHaveBeenCalledWith("skill_local_detail", {
      args: { dirSlug: "weekly-report" },
    });
  });

  it("本地新建的技能出现在列表里,且不摆任何它做不到的动作", async () => {
    // 页面叫「我的技能」,用户的直觉是"我拥有的技能"。新建的技能不进
    // state.installed(会让 precheck 撒谎),但那不等于它不该出现在这一页。
    seedIpc([view({ dirSlug: "my-draft", localOnly: true, registryId: "", contentHash: "" })]);
    render(<MySkillsPage />);

    expect(await screen.findByText("本地创建")).toBeInTheDocument();
    // 它没有来源、没建过关联:这些按钮摆出来就是引诱用户点必然失败的东西
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "修复关联" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享改动" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    // 能做的是去分享——那正是这类技能的下一步
    expect(screen.getByRole("button", { name: "分享到技能库" })).toBeInTheDocument();
  });

  it("纳入管理来的才给「移出管理」,获取来的不给", async () => {
    seedIpc([view({ claimed: true })]);
    const { unmount } = render(<MySkillsPage />);
    expect(await screen.findByRole("button", { name: "移出管理" })).toBeInTheDocument();
    unmount();

    seedIpc([view({ claimed: false })]);
    render(<MySkillsPage />);
    expect(await screen.findByRole("button", { name: "移除" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移出管理" })).not.toBeInTheDocument();
  });

  it("点「移出管理」走的是 skill_unclaim,不是破坏性的 skill_remove", async () => {
    seedIpc([view({ claimed: true })]);
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "移出管理" }));

    expect(invoke).toHaveBeenCalledWith("skill_unclaim", { args: { dirSlug: "weekly-report" } });
    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_remove")).toBe(false);
  });
});
