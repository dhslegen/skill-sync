import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasUpdate, localEqualsRemote, sections, updateCount, useMySkills } from "./my-skills";
import { useInstall } from "@/store/install";
import { useShare } from "@/store/share";
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
  relation: "installed",
  localPresent: true,
  sourceLabel: "skills/skills",
  body: "/h/.agents/skills/weekly-report",
  localHash: "sha256:mine",
  tools: [],
  versions: [],
  shareBlocked: null,
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
    installedAgents: null,
    removePhase: "idle",
    removeTarget: null,
    removeError: null,
    setAgentsBusy: null,
    setAgentsError: null,
    toolFailures: null,
    versionChoice: null,
    keepBusy: false,
    keepError: null,
    shareTarget: null,
    shareBusy: null,
    shareDone: null,
    shareError: null,
    shareConflict: null,
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

    const calls = invoke.mock.calls.filter(([cmd]) => cmd === "skill_remove");
    // 🔴 **只发一次,而且不带 force**(v6 二期):core 的二次确认档已删除,
    // 铁律 7 改由"本体进系统废纸篓、可逆"落实。带着一个 core 已经不认的字段
    // 发过去,只会让人以为那道闸还在。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1].args).toEqual({ dirSlug: "weekly-report" });
    expect(useMySkills.getState().removePhase).toBe("idle");
  });

  it("改过本体的技能同样一步到位:不再有第二重确认", async () => {
    // 上一版这里 core 会返回 needsDecision、界面升级成红色警示。那一档现在
    // 在 core 里已经不存在(`RemoveOutcome` 只剩 `Removed`),所以界面上
    // 也不该再有 `confirmingForce` 这个中间态——留着就是一条永远走不到的死路。
    useMySkills.setState({ list: [view({ localModified: true })] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_remove")
        return {
          outcome: "removed",
          report: { dirName: "weekly-report", unlinks: [], canonicalRemoved: true },
          lock: "written",
        };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();

    expect(useMySkills.getState().removePhase).toBe("idle");
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_remove")).toHaveLength(1);
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

  // ── 终审 I-1:没删掉的东西要如实回报 ────────────────────────────────
  //
  // `installer.uninstall` 对解不掉的位置返回 `Failed`/`Skipped` 而**自身照常
  // `Ok`**,`remove` 随后无条件清账。丢掉 `unlinks` 的后果:工具目录里留着一条
  // 悬空链接,而账已清、本体已进废纸篓、那一行从这一页消失——app 里再没有任何
  // 入口能驱动一次重试,用户还全程被告知"已移除"。
  it("解链失败与跳过的位置逐条进 toolFailures,不随记账一起消失", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_remove")
        return {
          outcome: "removed",
          report: {
            dirName: "weekly-report",
            unlinks: [
              { dir: "/h/.agents/skills", result: { status: "unlinked" } },
              { dir: "/h/.trae/skills", result: { status: "missing" } },
              {
                dir: "/h/.claude/skills",
                result: { status: "failed", error: { code: "FS_UNLINK_FAILED", message: "无法在该工具里停用这个技能,请重试" } },
              },
              {
                dir: "/h/.codex/skills",
                result: { status: "skipped", reason: "那个位置现在指向别处,没有改动它" },
              },
            ],
            canonicalRemoved: true,
          },
          lock: "written",
        };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();

    // 只收 failed 与 skipped:unlinked / missing 都是如愿的结果,摆出来是噪音
    expect(useMySkills.getState().toolFailures).toEqual([
      {
        kind: "location",
        path: "/h/.claude/skills",
        message: "无法在该工具里停用这个技能,请重试",
      },
      {
        kind: "location",
        path: "/h/.codex/skills",
        message: "那个位置现在指向别处,没有改动它",
      },
    ]);
  });

  it("全部解干净时不摆失败框", async () => {
    // 对照组:没有它,"永远摆一个空框"或"永远摆全部四条"都能过上一条
    useMySkills.setState({ toolFailures: [{ kind: "failed", agent: null, message: "旧的" }] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_remove")
        return {
          outcome: "removed",
          report: {
            dirName: "weekly-report",
            unlinks: [
              { dir: "/h/.agents/skills", result: { status: "unlinked" } },
              { dir: "/h/.trae/skills", result: { status: "missing" } },
            ],
            canonicalRemoved: true,
          },
          lock: "written",
        };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    useMySkills.getState().askRemove("weekly-report");
    await useMySkills.getState().confirmRemove();

    expect(useMySkills.getState().toolFailures).toBeNull();
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

describe("localEqualsRemote:第 4 档唯一的判据", () => {
  beforeEach(reset);

  // ⚠️ 这个函数此前**一条测试都没走过**(本任务链路上第七次撞见"那条路根本没人测")。
  // 它是六态机第 4 档(无安装基线)分 synced / differs 的唯一依据,判错的后果是
  // 对着两份逐字节相同的技能说「本地和库里不一样」,或者反过来。
  const index = (remoteHash: string, over: Record<string, unknown> = {}) => ({
    registryId: "company",
    owner: "skills",
    repo: "skills",
    skills: [{ dirSlug: "weekly-report", contentHash: remoteHash }],
    ...over,
  });

  it("两方指纹相同 → true", () => {
    expect(localEqualsRemote(view({ localHash: "h1" }), index("h1"))).toBe(true);
  });

  it("两方指纹不同 → false", () => {
    expect(localEqualsRemote(view({ localHash: "h1" }), index("h2"))).toBe(false);
  });

  it("没有索引 → null(不知道就说不知道)", () => {
    expect(localEqualsRemote(view({ localHash: "h1" }), null)).toBeNull();
  });

  it("🔴 本地指纹为空 → null,绝不让空串相等冒充「已同步」", () => {
    // `"" === ""` 会把"两边都读不出来"判成"已同步",那是编的。
    expect(localEqualsRemote(view({ localHash: "" }), index(""))).toBeNull();
    expect(localEqualsRemote(view({ localHash: "" }), index("h1"))).toBeNull();
  });

  it("库里没有这个技能(远端指纹取不到) → null", () => {
    expect(
      localEqualsRemote(view({ localHash: "h1" }), index("h1", { skills: [] })),
    ).toBeNull();
  });

  // ---- 坐标闸:三个字段各一条,防止"少判一个也照样绿" ----

  it("registryId 不同 → null(拿另一个源的索引比出来的结论不算数)", () => {
    expect(
      localEqualsRemote(view({ localHash: "h1", registryId: "custom-1" }), index("h1")),
    ).toBeNull();
  });

  it("owner 不同 → null", () => {
    expect(
      localEqualsRemote(view({ localHash: "h1", sourceOwner: "design" }), index("h1")),
    ).toBeNull();
  });

  it("repo 不同 → null(一源多仓:同源两库的同名技能是两个东西)", () => {
    expect(
      localEqualsRemote(view({ localHash: "h1", sourceRepo: "design-skills" }), index("h1")),
    ).toBeNull();
  });

  it("🔴 坐标为空串时同样落 null —— R27 之前 core 就是这么填的", () => {
    // 这正是修复轮 2 在 core 侧修掉的那条:无记账行的三个坐标是空串,
    // 于是坐标闸必然不等、`synced` 出口永远走不到。这条测试钉住**前端这一侧的
    // 判定是对的**(空坐标就是不知道),core 那一侧由
    // `installed_list.rs::a_row_without_an_account_still_carries_the_library_coordinates` 钉住。
    expect(
      localEqualsRemote(
        view({ localHash: "h1", registryId: "", sourceOwner: "", sourceRepo: "" }),
        index("h1"),
      ),
    ).toBeNull();
  });
});

describe("勾选哪些工具(skill_set_agents)", () => {
  beforeEach(reset);

  it("发出去的是完整期望名单,core 报的失败逐条摆出来", async () => {
    // 🔴 收集了不摆出来就是"静默撒谎":用户看到勾变了、以为成了,
    // 那个工具里其实什么都没发生。这里正面断言三个来源都被收进 toolFailures。
    useMySkills.setState({ list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return {
          outcome: "done",
          homeBody: "/h/.agents/skills/weekly-report",
          // 序列化契约:Result 是**大写**键,元组是 JSON 数组
          canonical: { Err: { code: "FS_LINK_FAILED", message: "统一目录没能收敛" } },
          results: [
            ["claude-code", { Ok: { kind: "linked", mode: "symlink" } }],
            ["trae", { Err: { code: "FS_LINK_FAILED", message: "trae 没配上" } }],
          ],
          unlinked: ["cursor"],
          unlinkFailed: [["zed", { code: "FS_UNLINK_FAILED", message: "zed 没能停用" }]],
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().setAgents("weekly-report", ["claude-code", "trae"]);

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_set_agents");
    expect(call?.[1].args).toEqual({
      dirSlug: "weekly-report",
      agents: ["claude-code", "trae"],
    });
    const failures = useMySkills.getState().toolFailures;
    expect(failures).toEqual([
      { kind: "failed", agent: null, message: "统一目录没能收敛" },
      { kind: "failed", agent: "trae", message: "trae 没配上" },
      { kind: "failed", agent: "zed", message: "zed 没能停用" },
    ]);
  });

  it("全都成功时不摆失败条", async () => {
    // 反向守卫:空数组要归一成 null,否则界面会摆一个"有 0 处没能完成"的框
    useMySkills.setState({ list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return {
          outcome: "done",
          homeBody: "/b",
          canonical: { Ok: { kind: "unchanged" } },
          results: [["claude-code", { Ok: { kind: "linked", mode: "symlink" } }]],
          unlinked: [],
          unlinkFailed: [],
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().setAgents("weekly-report", ["claude-code"]);
    expect(useMySkills.getState().toolFailures).toBeNull();
  });

  it("🔴 Ok(Differs) 必须进清单,而且与真正的失败分开标记", async () => {
    // 修复轮 2 修的问题:上一版把 Differs 排除在外,理由是"core 按设计没动它,
    // 下一轮 tools 会回显"。**顺着这一跳查进 core,那个理由是错的**——
    // `converge::merge_link_record` 对 Differs 直接 return 不写记录,
    // `tools_of` 因此算出 `Off`,用户看到的是**勾自己弹了回去、零错误零提示**。
    // 他再点一次还是一样,那是一条永久死路。
    useMySkills.setState({ list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return {
          outcome: "done",
          homeBody: "/b",
          canonical: { Ok: { kind: "differs", existing: "/h/.agents/skills/weekly-report" } },
          results: [
            ["trae", { Ok: { kind: "differs", existing: "/h/.trae/skills/weekly-report" } }],
            ["cursor", { Err: { code: "FS_LINK_FAILED", message: "cursor 没配上" } }],
          ],
          unlinked: [],
          unlinkFailed: [],
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().setAgents("weekly-report", ["trae", "cursor"]);

    expect(useMySkills.getState().toolFailures).toEqual([
      // 🔴 differs 那一档**没有 message 字段**(可辨联合):它携带的 `existing`
      // 是原始文件系统路径,属于内部标识,不是拿来直接渲染给用户的。
      { kind: "differs", agent: null, existing: "/h/.agents/skills/weekly-report" },
      { kind: "differs", agent: "trae", existing: "/h/.trae/skills/weekly-report" },
      // 真正的失败仍然是 failed,两者不能混成一档 —— 界面要说不同的话
      { kind: "failed", agent: "cursor", message: "cursor 没配上" },
    ]);
  });

  it("其余 Ok 档(linked/unchanged/sameLocation)不进清单", async () => {
    // 上一条的对照组:只有 differs 才算"需要你看一下",别把成功也报上来。
    useMySkills.setState({ list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return {
          outcome: "done",
          homeBody: "/b",
          canonical: { Ok: { kind: "sameLocation" } },
          results: [
            ["trae", { Ok: { kind: "linked", mode: "symlink" } }],
            ["cursor", { Ok: { kind: "unchanged" } }],
          ],
          unlinked: [],
          unlinkFailed: [],
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().setAgents("weekly-report", ["trae", "cursor"]);
    expect(useMySkills.getState().toolFailures).toBeNull();
  });

  it("core 说有几个版本:转去拍板,且 versions 取自本页 list 而不是 outcome", async () => {
    // 🔴 两者口径不对称:outcome 里那份含内容相同的重复品,list 上这份已经剔掉了。
    // 混用会让同一个技能在"点勾弹出来"和"页面上直接显示"两条路上看到不一样的份数。
    const listVersions = [
      { path: "/h/.claude/skills/w", modifiedAt: "2026-08-01T00:00:00Z", files: 2, contentHash: "a" },
      { path: "/h/.trae/skills/w", modifiedAt: "2026-08-02T00:00:00Z", files: 3, contentHash: "b" },
    ];
    useMySkills.setState({ list: [view({ versions: listVersions })] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return {
          outcome: "needsVersionChoice",
          versions: [
            ...listVersions,
            // outcome 多出来的这一份是内容相同的重复品:不该出现在拍板界面上
            { path: "/h/.cursor/skills/w", modifiedAt: "2026-08-03T00:00:00Z", files: 2, contentHash: "a" },
          ],
        };
      return AGENTS;
    });

    await useMySkills.getState().setAgents("weekly-report", ["trae"]);

    const choice = useMySkills.getState().versionChoice;
    expect(choice?.dirSlug).toBe("weekly-report");
    expect(choice?.versions).toEqual(listVersions);
    expect(choice?.after).toBe("agents");
    expect(choice?.agents).toEqual(["trae"]);
  });

  it("整条调用失败给可读错误,并把忙碌态放掉", async () => {
    useMySkills.setState({ list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        throw { code: "FS_TASK", message: "操作未能完成,请重试" };
      return AGENTS;
    });

    await useMySkills.getState().setAgents("weekly-report", ["trae"]);

    expect(useMySkills.getState().setAgentsError?.message).toContain("未能完成");
    expect(useMySkills.getState().setAgentsBusy).toBeNull();
  });
});

describe("拍板留哪一份(skill_keep_version)", () => {
  beforeEach(reset);

  const choice = (over = {}) => ({
    dirSlug: "weekly-report",
    versions: [
      { path: "/a", modifiedAt: "2026-08-01T00:00:00Z", files: 1, contentHash: "a" },
      { path: "/b", modifiedAt: "2026-08-02T00:00:00Z", files: 1, contentHash: "b" },
    ],
    ...over,
  });

  it("把选中的那一份传给 core,拍完关掉弹窗并刷新", async () => {
    useMySkills.setState({ versionChoice: choice(), list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_keep_version")
        return { body: "/a", trashed: ["/b"], links: [], canonical: { Ok: { kind: "unchanged" } } };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().keepVersion("weekly-report", "/a");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_keep_version");
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", keepPath: "/a" });
    expect(useMySkills.getState().versionChoice).toBeNull();
  });

  it("拍板前本来要做的事,拍完接着做——不让用户再点一次", async () => {
    useMySkills.setState({
      versionChoice: choice({ after: "agents", agents: ["trae"] }),
      list: [view()],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_keep_version")
        return { body: "/a", trashed: [], links: [], canonical: { Ok: { kind: "unchanged" } } };
      if (cmd === "skill_set_agents")
        return {
          outcome: "done",
          homeBody: "/a",
          canonical: { Ok: { kind: "unchanged" } },
          results: [],
          unlinked: [],
          unlinkFailed: [],
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().keepVersion("weekly-report", "/a");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_set_agents");
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", agents: ["trae"] });
  });

  // ── 终审 C-1:core 收集的失败必须真的到达界面 ────────────────────────
  //
  // `keep_version` 的三类失败**不抛错**——core 把它们逐条收进 `KeepReport`、
  // 函数照常返回 `Ok`。所以 `catch` 分支永远碰不到它们,只有取返回值这一条路。

  it("落选版本进废纸篓失败时,那条失败到达 toolFailures(不是静默关掉弹窗)", async () => {
    useMySkills.setState({ versionChoice: choice(), list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_keep_version")
        return {
          body: "/a",
          trashed: [],
          links: [["/b", { Err: { code: "FS_TRASH_FAILED", message: "移到废纸篓失败" } }]],
          canonical: { Ok: { kind: "unchanged" } },
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().keepVersion("weekly-report", "/a");

    const failures = useMySkills.getState().toolFailures;
    // 断言的是"那条失败真的到了清单里",不是"某段文案渲染了"
    expect(failures).toEqual([
      { kind: "location", path: "/b", message: "移到废纸篓失败" },
    ]);
  });

  it("canonical 那一处失败同样到达 toolFailures", async () => {
    useMySkills.setState({ versionChoice: choice(), list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_keep_version")
        return {
          body: "/a",
          trashed: ["/b"],
          links: [],
          canonical: { Err: { code: "FS_LINK_FAILED", message: "统一目录那一处没配上" } },
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().keepVersion("weekly-report", "/a");

    expect(useMySkills.getState().toolFailures).toEqual([
      { kind: "failed", agent: null, message: "统一目录那一处没配上" },
    ]);
  });

  // 🔴 **这一条是 C-1 修复里最容易自伤的地方,必须单独测**:
  // `after === "agents"` 是拍板最常见的入口(勾工具 → 顶回拍板 → 拍完接着落勾),
  // 而 `setAgents` 开头就是 `toolFailures: null`——接着跑等于把刚摆出来的失败
  // 自己清掉,C-1 在修它的代码里原样复现。
  it("有失败就不走 after 链:失败留在界面上,后续动作不再触发", async () => {
    useMySkills.setState({
      versionChoice: choice({ after: "agents", agents: ["trae"] }),
      list: [view()],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_keep_version")
        return {
          body: "/a",
          trashed: [],
          links: [["/b", { Err: { code: "FS_TRASH_FAILED", message: "移到废纸篓失败" } }]],
          canonical: { Ok: { kind: "unchanged" } },
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().keepVersion("weekly-report", "/a");

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_set_agents")).toHaveLength(0);
    expect(useMySkills.getState().toolFailures).toHaveLength(1);
  });

  it("全部成功时不摆失败框,after 链照常跑", async () => {
    // 对照组:没有它,上一条测试用"永远不跑 after"的坏实现也能过
    useMySkills.setState({
      versionChoice: choice({ after: "agents", agents: ["trae"] }),
      list: [view()],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_keep_version")
        return {
          body: "/a",
          trashed: ["/b"],
          links: [["/b", { Ok: { kind: "linked", mode: "symlink" } }]],
          canonical: { Ok: { kind: "unchanged" } },
        };
      if (cmd === "skill_set_agents")
        return {
          outcome: "done",
          homeBody: "/a",
          canonical: { Ok: { kind: "unchanged" } },
          results: [],
          unlinked: [],
          unlinkFailed: [],
        };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().keepVersion("weekly-report", "/a");

    expect(useMySkills.getState().toolFailures).toBeNull();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_set_agents")).toHaveLength(1);
  });

  it("失败时弹窗留在原地可重试,不静默关掉", async () => {
    useMySkills.setState({ versionChoice: choice(), list: [view()] });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_keep_version")
        throw { code: "FS_BAD_VERSION_CHOICE", message: "这个位置不在候选里" };
      return AGENTS;
    });

    await useMySkills.getState().keepVersion("weekly-report", "/x");

    expect(useMySkills.getState().versionChoice).not.toBeNull();
    expect(useMySkills.getState().keepError?.message).toContain("候选");
    expect(useMySkills.getState().keepBusy).toBe(false);
  });
});

describe("分享确认屏(零编辑)", () => {
  beforeEach(reset);

  it("beginShare 只记目标并探一次路径预告,一个字节都不推", async () => {
    useMySkills.setState({ list: [view({ relation: "draft" })] });
    invoke.mockImplementation(async () => "unknown");

    useMySkills.getState().beginShare("weekly-report");

    expect(useMySkills.getState().shareTarget).toEqual({ dirSlug: "weekly-report" });
    expect(invoke).not.toHaveBeenCalledWith("skill_share", expect.anything());
  });

  it("确认时带账上的来源坐标——缺省会推到该源主库,追加库的技能就推错了地方", async () => {
    useMySkills.setState({
      list: [view({ relation: "shared", sourceOwner: "design", sourceRepo: "skills" })],
      shareTarget: { dirSlug: "weekly-report" },
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_share") return { outcome: "shared", mode: "pushed", url: null };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
    expect(call?.[1].args).toEqual({
      dirSlug: "weekly-report",
      registryId: "company",
      repo: "design/skills",
    });
    expect(useMySkills.getState().shareDone).toEqual({
      dirSlug: "weekly-report",
      mode: "pushed",
    });
    // 成功后确认屏要关掉,否则用户会对着同一屏再点一次
    expect(useMySkills.getState().shareTarget).toBeNull();
  });

  it("🔴 无记账但库里有它的行,分享更新要打回**它自己那个库**,不是内建主库", async () => {
    // 第三个受害者(与 pull 打错库同根因):core 的 R27 修复之前,这种行的
    // source_owner/source_repo/registry_id 是空串,confirmShare 会退到
    // `targetRepo ?? undefined` → 缺省推到内建源主库,把改动推进一个
    // 与这个技能毫无关系的库。core 补齐坐标之后这条路才走得对。
    useMySkills.setState({
      list: [
        view({
          relation: "shared",
          contentHash: "", // 无安装基线 —— 正是 differs 那一档
          registryId: "custom-1",
          sourceOwner: "design",
          sourceRepo: "design-skills",
        }),
      ],
      shareTarget: { dirSlug: "weekly-report" },
    });
    // 确认屏上恰好选中的是**另一个**库:账上的坐标必须赢
    useShare.setState({ targetRepo: "skills/skills" });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_share") return { outcome: "shared", mode: "pushed", url: null };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
    expect(call?.[1].args).toEqual({
      dirSlug: "weekly-report",
      registryId: "custom-1",
      repo: "design/design-skills",
    });
  });

  it("草稿没有来源坐标:落到确认屏上选中的那个库", async () => {
    useMySkills.setState({
      list: [view({ relation: "draft", sourceOwner: "", sourceRepo: "", registryId: "" })],
      shareTarget: { dirSlug: "weekly-report" },
    });
    useShare.setState({ targetRepo: "skills/skills" });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_share") return { outcome: "shared", mode: "reviewRequested", url: null };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", repo: "skills/skills" });
  });

  it("失败时确认屏留着、错误可读——关掉就等于失败被静默吞掉", async () => {
    useMySkills.setState({
      list: [view({ relation: "draft" })],
      shareTarget: { dirSlug: "weekly-report" },
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_share")
        throw { code: "REPO_NAME_TAKEN", message: "库里已经有同名技能了" };
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    expect(useMySkills.getState().shareTarget).not.toBeNull();
    expect(useMySkills.getState().shareError?.message).toContain("同名");
    expect(useMySkills.getState().shareBusy).toBeNull();
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

  it("角标计数与逐条判定同口径,不亮更新的两档不计入", () => {
    const index = {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [
        { dirSlug: "weekly-report", contentHash: "sha256:newer" },
        { dirSlug: "code-review", contentHash: "sha256:newer" },
        { dirSlug: "my-draft", contentHash: "sha256:newer" },
        { dirSlug: "orphan", contentHash: "sha256:newer" },
      ],
    };
    const list = [
      view({ dirSlug: "weekly-report" }),
      view({ dirSlug: "code-review" }),
      // 下面两档都没有更新去处,摆进角标就是虚报
      view({ dirSlug: "my-draft", relation: "draft" }),
      view({ dirSlug: "orphan", sourceRemoved: true }),
      // 已经是最新的那个不计
      view({ dirSlug: "up-to-date", contentHash: "sha256:newer" }),
    ];

    expect(updateCount(list, index)).toBe(2);
    // 索引还没加载出来:不猜,报 0
    expect(updateCount(list, null)).toBe(0);
    expect(updateCount(null, index)).toBe(0);
  });

  it("relation === shared 且远端指纹不等时照常计入角标(v6:角标与页内 sharedState 同一份判定)", () => {
    const index = {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [{ dirSlug: "weekly-report", contentHash: "sha256:newer" }],
    };
    expect(updateCount([view({ relation: "shared" })], index)).toBe(1);
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

  it("取回(pull):有本体的行沿用账上已启用的工具,不再问一遍", async () => {
    useMySkills.setState({
      list: [view({ relation: "shared", agents: ["claude-code"], registryId: "company", sourceOwner: "skills", sourceRepo: "skills" })],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_install")
        return {
          outcome: "installed",
          report: { dirName: "weekly-report", canonicalDir: "/c", links: [] },
          localKept: false,
          lock: "written",
        };
      return AGENTS;
    });

    await useMySkills.getState().pull("weekly-report");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect(call?.[1].args.agentIds).toEqual(["claude-code"]);
    expect(call?.[1].args.registryId).toBe("company");
    expect(call?.[1].args.repo).toBe("skills/skills");
    // 沿用账上的工具,不该再问一遍
    expect(invoke.mock.calls.some(([cmd]) => cmd === "agents_detected")).toBe(false);
  });

  it("取回(pull):这台电脑从没装过(notHere,agents 为空)时按默认规则勾选", async () => {
    useMySkills.setState({
      list: [
        view({
          relation: "shared",
          localPresent: false,
          agents: [],
          registryId: "company",
          sourceOwner: "skills",
          sourceRepo: "skills",
        }),
      ],
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected")
        return {
          agents: [
            { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
            { name: "trae", displayName: "Trae", installed: true, globalSkillsDir: "~/.trae/skills", isUniversal: false, needsLink: true, disabled: true },
          ],
          canonicalDir: "~/.agents/skills",
        };
      if (cmd === "skill_install")
        return {
          outcome: "installed",
          report: { dirName: "weekly-report", canonicalDir: "/c", links: [] },
          localKept: false,
          lock: "written",
        };
      return AGENTS;
    });

    await useMySkills.getState().pull("weekly-report");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    // 已探测到、未在设置里禁用的才进默认勾选:trae 被禁用不该出现
    expect(call?.[1].args.agentIds).toEqual(["claude-code"]);
  });

  it("分享更新(shareUpdate):走的是 skill_share_changes,与「我安装的」区块的分享改动同一条编排", async () => {
    useMySkills.setState({ list: [view({ relation: "shared", localModified: true })] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        return { kind: "submitted", mode: "pushed", commitSha: "new", reviewUrl: null };
      if (cmd === "installed_list") return [view({ relation: "shared", localModified: true })];
      return AGENTS;
    });

    await useMySkills.getState().shareUpdate("weekly-report");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(call?.[1].args.dirSlug).toBe("weekly-report");
    expect(useMySkills.getState().shareDone).toEqual({ dirSlug: "weekly-report", mode: "pushed" });
  });
});

describe("sections(两分区)", () => {
  it("shared 与 draft 落同一区,installed 落另一区", () => {
    const list = [
      view({ dirSlug: "a", relation: "shared" }),
      view({ dirSlug: "b", relation: "draft" }),
      view({ dirSlug: "c", relation: "installed" }),
    ];

    const secs = sections(list);

    expect(secs).toHaveLength(2);
    expect(secs[0].key).toBe("shared");
    expect(secs[0].items.map((s) => s.dirSlug)).toEqual(["a", "b"]);
    expect(secs[1].key).toBe("installed");
    expect(secs[1].items.map((s) => s.dirSlug)).toEqual(["c"]);
  });

  it("空分区不出现在结果里", () => {
    const secs = sections([view({ relation: "installed" })]);
    expect(secs.map((s) => s.key)).toEqual(["installed"]);
  });
});

describe("hasUpdate 对草稿(relation === draft)", () => {
  const index = {
    registryId: "company",
    owner: "skills",
    repo: "skills",
    skills: [{ dirSlug: "weekly-report", contentHash: "sha256:remote" }],
  };

  it("草稿永远没有更新——它不来自任何技能库", () => {
    // 显式判掉,不靠"空 registryId 恰好对不上 index"碰运气
    expect(
      hasUpdate(view({ relation: "draft", registryId: "", contentHash: "" }), index),
    ).toBe(false);
    // 就算某天空字段被填上,也不该亮更新
    expect(hasUpdate(view({ relation: "draft" }), index)).toBe(false);
  });
});
