import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasUpdate, updateCount, useMySkills } from "./my-skills";
import { useInstall } from "@/store/install";
import type { InstalledSkillView } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const view = (over: Partial<InstalledSkillView> = {}): InstalledSkillView => ({
  dirSlug: "weekly-report",
  commitSha: "aaa1111",
  contentHash: "sha256:mine",
  agents: ["claude-code", "cursor"],
  installedAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
  localModified: false,
  sourceOwner: "skills",
  sourceRepo: "skills",
  registryId: "company",
  sourceRemoved: false,
  libraryRemoved: false,
  unclaimed: false,
  localOnly: false,
  claimed: false,
  links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "healthy" }],
  ...over,
});

const AGENTS = { agents: [], canonicalDir: "~/.agents/skills" };

function reset() {
  invoke.mockReset();
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
  });
}

describe("我的技能列表", () => {
  beforeEach(reset);

  it("读取失败保留上次内容并报错,不画成空状态", async () => {
    // "读不到" ≠ "你还没装任何技能"——后者会引着用户去商店重装一遍
    useMySkills.setState({ list: [view()] });
    invoke.mockRejectedValue({ code: "FS_TASK", message: "读取已安装列表失败,请重试" });

    await useMySkills.getState().load();

    const s = useMySkills.getState();
    expect(s.loadError?.message).toContain("失败");
    expect(s.list).toHaveLength(1);
  });

  it("agent 显示名拿不到时不挂掉整页", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [view()];
      throw new Error("agents boom");
    });

    await useMySkills.getState().load();

    expect(useMySkills.getState().list).toHaveLength(1);
    expect(useMySkills.getState().loadError).toBeNull();
  });
});

describe("移除流程", () => {
  beforeEach(reset);

  it("确认第一步不带 force —— 让 core 有机会拦下改过的技能", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_remove") return { outcome: "removed", report: { dirName: "weekly-report", unlinks: [], canonicalRemoved: true }, lock: "written" };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_remove");
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", force: false });
    expect(useMySkills.getState().removePhase).toBe("idle");
  });

  it("core 说要再确认 → 升级为第二重,不自作主张带 force 重试", async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === "skill_remove" ? { outcome: "needsDecision" } : AGENTS,
    );

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();

    expect(useMySkills.getState().removePhase).toBe("confirmingForce");
    // 关键:只发过一次,没有替用户决定
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_remove")).toHaveLength(1);
  });

  it("第二重确认才带 force", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [];
      if (cmd !== "skill_remove") return AGENTS;
      calls += 1;
      return calls === 1
        ? { outcome: "needsDecision" }
        : { outcome: "removed", report: { dirName: "weekly-report", unlinks: [], canonicalRemoved: true }, lock: "written" };
    });

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();
    await useMySkills.getState().confirmRemove();

    const second = invoke.mock.calls.filter(([cmd]) => cmd === "skill_remove")[1];
    expect(second?.[1].args.force).toBe(true);
    expect(useMySkills.getState().removePhase).toBe("idle");
  });

  it("移除成功后刷新列表与商店状态", async () => {
    const refreshInstalled = vi.fn();
    useInstall.setState({ refreshInstalled });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_remove")
        return { outcome: "removed", report: { dirName: "weekly-report", unlinks: [], canonicalRemoved: true }, lock: "written" };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();

    expect(useMySkills.getState().list).toEqual([]);
    expect(refreshInstalled).toHaveBeenCalled();
  });

  it("移除失败:错误可读、弹窗留在原地可重试", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_remove") throw { code: "FS_TASK", message: "移除操作未能完成,请重试" };
      return AGENTS;
    });

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();

    const s = useMySkills.getState();
    expect(s.removePhase).toBe("confirming");
    expect(s.removeError?.message).toContain("未能完成");
  });

  it("取消清空移除状态", () => {
    useMySkills.getState().askRemove("weekly-report");
    useMySkills.getState().cancelRemove();
    expect(useMySkills.getState().removePhase).toBe("idle");
    expect(useMySkills.getState().removeTarget).toBeNull();
  });
});

describe("修复流程", () => {
  beforeEach(reset);

  it("断链等链接形态直接修,不弹确认", async () => {
    useMySkills.setState({
      list: [view({ links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "broken" }] })],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_repair") return { dirName: "weekly-report", canonicalDir: "/c", links: [] };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    await useMySkills.getState().repair("weekly-report");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_repair");
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", replaceOccupied: false });
  });

  it("位置被实体目录占用:先弹确认,不直接动手", async () => {
    useMySkills.setState({
      list: [view({ links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "occupied" }] })],
    });

    await useMySkills.getState().repair("weekly-report");

    expect(useMySkills.getState().repairConfirmTarget).toBe("weekly-report");
    expect(invoke).not.toHaveBeenCalledWith("skill_repair", expect.anything());
  });

  it("确认替换才带 replaceOccupied", async () => {
    useMySkills.setState({ repairConfirmTarget: "weekly-report" });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_repair") return { dirName: "weekly-report", canonicalDir: "/c", links: [] };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    await useMySkills.getState().confirmRepair();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_repair");
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", replaceOccupied: true });
    expect(useMySkills.getState().repairConfirmTarget).toBeNull();
  });

  it("取消替换什么都不发", async () => {
    useMySkills.setState({ repairConfirmTarget: "weekly-report" });
    useMySkills.getState().cancelRepair();
    expect(useMySkills.getState().repairConfirmTarget).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("skill_repair", expect.anything());
  });

  it("修复后刷新列表,健康徽标才会消失", async () => {
    useMySkills.setState({
      list: [view({ links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "missing" }] })],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_repair") return { dirName: "weekly-report", canonicalDir: "/c", links: [] };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().repair("weekly-report");

    expect(useMySkills.getState().list?.[0].links[0].health).toBe("healthy");
  });

  it("修复失败给可读错误", async () => {
    useMySkills.setState({
      list: [view({ links: [{ dir: "/h/.claude/skills", mode: "symlink", health: "missing" }] })],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_repair") throw { code: "FS_TASK", message: "修复操作未能完成,请重试" };
      return AGENTS;
    });

    await useMySkills.getState().repair("weekly-report");

    expect(useMySkills.getState().repairError?.message).toContain("未能完成");
    expect(useMySkills.getState().repairBusy).toBeNull();
  });
});

describe("分享改动的冲突档(M5 任务 1)", () => {
  beforeEach(reset);

  const modified = () => view({ localModified: true });

  it("远端变过:进冲突档等拍板,不当成错误", async () => {
    useMySkills.setState({ list: [modified()] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        return { kind: "remoteChanged", historyUrl: "http://g/skills/skills/commits/x" };
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");

    const s = useMySkills.getState();
    expect(s.shareConflict).toEqual({
      dirSlug: "weekly-report",
      historyUrl: "http://g/skills/skills/commits/x",
    });
    expect(s.shareError).toBeNull();
    expect(s.shareDone).toBeNull();
  });

  it("确认后带 forceReview 重试,结果按「已提交审核」展示", async () => {
    useMySkills.setState({
      list: [modified()],
      shareConflict: { dirSlug: "weekly-report", historyUrl: null },
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        return { kind: "submitted", mode: "reviewRequested", commitSha: "n", reviewUrl: "http://x/pulls/7" };
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().confirmShareReview();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect((call?.[1] as { args: { forceReview?: boolean } }).args.forceReview).toBe(true);
    const s = useMySkills.getState();
    expect(s.shareConflict).toBeNull();
    expect(s.shareDone).toEqual({ dirSlug: "weekly-report", mode: "reviewRequested" });
  });

  it("提交瞬间被人抢先(CONFLICT_STALE)进同一个冲突档", async () => {
    // 前置检测过了、提交仍撞上 422:检测与提交之间被人抢先,语义相同,
    // 不该退化成一句通用错误让用户干瞪眼
    useMySkills.setState({ list: [modified()] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        throw { code: "CONFLICT_STALE", message: "这个技能在你操作期间被其他人改过了,请重新确认后再提交" };
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");

    const s = useMySkills.getState();
    expect(s.shareConflict).toEqual({ dirSlug: "weekly-report", historyUrl: null });
    expect(s.shareError).toBeNull();
  });

  it("取消冲突档:不发第二跳,改动留在本地", async () => {
    useMySkills.setState({
      shareConflict: { dirSlug: "weekly-report", historyUrl: null },
    });

    useMySkills.getState().cancelShareConflict();

    expect(useMySkills.getState().shareConflict).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("skill_share_changes", expect.anything());
  });
});

describe("更新判定与更新动作", () => {
  beforeEach(reset);

  it("逐技能比内容指纹:只有这个技能自己变了才提示更新", () => {
    const idx = (hash: string, registryId = "company") => ({
      registryId,
      owner: "skills",
      repo: "skills",
      skills: [{ dirSlug: "weekly-report", contentHash: hash }],
    });
    expect(hasUpdate(view(), idx("sha256:mine"))).toBe(false);
    expect(hasUpdate(view(), idx("sha256:newer"))).toBe(true);
    // 索引还没加载出来时不能凭空提示有更新
    expect(hasUpdate(view(), undefined)).toBe(false);
    // 商店当前浏览的是别的源:它的内容说明不了这个技能有没有更新
    expect(hasUpdate(view(), idx("sha256:newer", "custom-1"))).toBe(false);
    // 来源已移除:更新没有去处,绝不能亮"有新版本"
    expect(hasUpdate(view({ sourceRemoved: true }), idx("sha256:newer"))).toBe(false);
  });

  it("角标计数与逐条判定同口径,不亮更新的三档不计入", () => {
    const index = {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [
        { dirSlug: "weekly-report", contentHash: "sha256:newer" },
        { dirSlug: "code-review", contentHash: "sha256:newer" },
        { dirSlug: "local-thing", contentHash: "sha256:newer" },
        { dirSlug: "from-npx", contentHash: "sha256:newer" },
        { dirSlug: "orphan", contentHash: "sha256:newer" },
      ],
    };
    const list = [
      view({ dirSlug: "weekly-report" }),
      view({ dirSlug: "code-review" }),
      // 下面三档都没有更新去处,摆进角标就是虚报
      view({ dirSlug: "local-thing", localOnly: true }),
      view({ dirSlug: "from-npx", unclaimed: true }),
      view({ dirSlug: "orphan", sourceRemoved: true }),
      // 已经是最新的那个不计
      view({ dirSlug: "up-to-date", contentHash: "sha256:newer" }),
    ];

    expect(updateCount(list, index)).toBe(2);
    // 索引还没加载出来:不猜,报 0
    expect(updateCount(list, null)).toBe(0);
    expect(updateCount(null, index)).toBe(0);
  });

  it("角标必须比到技能库,不能按源比(同源两库有同名技能)", () => {
    // 按源比会把设计库的同名技能算成主库那个的更新——与 hasUpdate 同一条护栏,
    // 角标另写一套判定的话这里就是它唯一的拦截点
    const designIndex = {
      registryId: "company",
      owner: "design",
      repo: "design-skills",
      skills: [{ dirSlug: "weekly-report", contentHash: "sha256:design-version" }],
    };
    expect(updateCount([view()], designIndex)).toBe(0);
  });

  it("同一个源、另一个技能库的索引不能用来判定(M4 一源多仓)", () => {
    // 一源多仓后同一个 registryId 有多份索引:商店切到「设计部技能库」浏览时,
    // 它的内容说明不了主库装的技能。两库有同名技能时,按源比会直接比出错误结论。
    const designIndex = {
      registryId: "company",
      owner: "design",
      repo: "design-skills",
      // 同名技能在两个库里各有一份,指纹不同——这正是会比错的场景
      skills: [{ dirSlug: "weekly-report", contentHash: "sha256:design-version" }],
    };
    expect(hasUpdate(view(), designIndex)).toBe(false);

    // 反过来:装自设计库的技能,对着设计库的索引照常判定
    const fromDesign = view({ sourceOwner: "design", sourceRepo: "design-skills" });
    expect(hasUpdate(fromDesign, designIndex)).toBe(true);
    // owner 与 repo 不能互换着比(fixture 特意取不同值,换了就红)
    expect(
      hasUpdate(fromDesign, { ...designIndex, owner: "design-skills", repo: "design" }),
    ).toBe(false);
  });

  it("库里别的技能变了,不影响这个技能(分享一个技能不该让全部亮更新)", () => {
    // 这是 2026-08-03 用户实测的缺陷:旧实现比整库 HEAD sha,
    // 别人分享任意一个技能都会让所有已装技能同时提示更新。
    const index = {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [
        { dirSlug: "weekly-report", contentHash: "sha256:mine" },
        { dirSlug: "other-skill", contentHash: "sha256:justchanged" },
      ],
    };
    expect(hasUpdate(view(), index)).toBe(false);
  });

  it("任一侧指纹缺失时按没有更新处理:宁可漏报也不误报", () => {
    const base = { registryId: "company", owner: "skills", repo: "skills" };
    expect(
      hasUpdate(view(), { ...base, skills: [{ dirSlug: "weekly-report", contentHash: "" }] }),
    ).toBe(false);
    expect(
      hasUpdate(view({ contentHash: "" }), {
        ...base,
        skills: [{ dirSlug: "weekly-report", contentHash: "sha256:remote" }],
      }),
    ).toBe(false);
    // 索引里根本没有这个技能(已从库里删掉)
    expect(hasUpdate(view(), { ...base, skills: [] })).toBe(false);
  });

  it("更新沿用上次记账的工具,不再弹 agent 选择", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [];
      if (cmd === "skill_install")
        return {
          outcome: "installed",
          report: { dirName: "weekly-report", canonicalDir: "/c", links: [] },
          localKept: false,
          lock: "written",
        };
      return AGENTS;
    });

    await useInstall.getState().beginUpdate("weekly-report", ["claude-code", "cursor"]);

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    const sent = call?.[1].args;
    expect([...sent.agentIds].sort()).toEqual(["claude-code", "cursor"]);
    // 没有进入 choosing,也没拉 agent 列表让用户重选
    expect(invoke.mock.calls.some(([cmd]) => cmd === "agents_detected")).toBe(false);
    expect(useInstall.getState().phase).toBe("done");
  });

  it("更新把账上的来源仓原样带回(M4 一源多仓:缺省会打到主库)", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [];
      if (cmd === "skill_install")
        return {
          outcome: "installed",
          report: { dirName: "weekly-report", canonicalDir: "/c", links: [] },
          localKept: false,
          lock: "written",
        };
      return AGENTS;
    });

    await useInstall
      .getState()
      .beginUpdate("weekly-report", ["claude-code"], "company", "design/design-skills");

    const sent = invoke.mock.calls.find(([cmd]) => cmd === "skill_install")?.[1].args;
    // 正面断言值:只断言"字段在"分不出主库与追加库
    expect(sent.registryId).toBe("company");
    expect(sent.repo).toBe("design/design-skills");
  });

  it("更新遇到本地改动:停在冲突态交给 ConflictDialog,不静默覆盖", async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === "skill_install"
        ? { outcome: "needsDecision", precheck: { status: "locallyModified", installedSha: "aaa" } }
        : AGENTS,
    );

    await useInstall.getState().beginUpdate("weekly-report", ["claude-code"]);

    expect(useInstall.getState().phase).toBe("conflict");
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(1);
  });

  it("取消认领只发一条命令,不碰移除那条破坏性通道", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "installed_list" ? [] : AGENTS));

    await useMySkills.getState().unclaim("weekly-report");

    expect(invoke).toHaveBeenCalledWith("skill_unclaim", {
      args: { dirSlug: "weekly-report" },
    });
    // 移除会解链、删本体、清 lock 条目——取消认领绝不能顺手走那条路
    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_remove")).toBe(false);
    // 列表与商店卡片状态都要跟上
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "installed_list").length).toBeGreaterThan(0);
  });

  it("取消认领失败要把原因摆出来,不静默", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_unclaim") {
        throw { code: "CONFLICT_NOT_CLAIMED", message: "这个技能是从技能库获取的,不能取消认领" };
      }
      return cmd === "installed_list" ? [] : AGENTS;
    });

    await useMySkills.getState().unclaim("weekly-report");

    expect(useMySkills.getState().claimError?.code).toBe("CONFLICT_NOT_CLAIMED");
    expect(useMySkills.getState().claimBusy).toBeNull();
  });
});

describe("hasUpdate 对没有来源的两档", () => {
  const index = {
    registryId: "company",
    owner: "skills",
    repo: "skills",
    skills: [{ dirSlug: "weekly-report", contentHash: "sha256:remote" }],
  };

  it("本地新建的永远没有更新——它不来自任何技能库", () => {
    // 显式判掉,不靠"空 registryId 恰好对不上 index"碰运气
    expect(hasUpdate(view({ localOnly: true, registryId: "", contentHash: "" }), index)).toBe(false);
    // 就算某天空字段被填上,也不该亮更新
    expect(hasUpdate(view({ localOnly: true }), index)).toBe(false);
  });

  it("未认领的同理", () => {
    expect(hasUpdate(view({ unclaimed: true }), index)).toBe(false);
  });
});
