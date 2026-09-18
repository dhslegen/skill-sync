import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  baselineNeedsAlign,
  groupBySource,
  hasUpdate,
  localDiffersNoBaseline,
  remoteChangedForShareable,
  sections,
  shareableSourceKey,
  updateCount,
  useMySkills,
} from "./my-skills";
import { t } from "@/i18n";
import { useInstall } from "@/store/install";
import { useOverwrite } from "@/store/overwrite";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";
import type { InstalledSkillView, Section } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/**
 * `core::ownership::section(relation)` 的镜像(v7 任务 4 修复轮 1 I2):
 * Shared → sharedTo / Installed → installedFrom / Draft → shareable。
 *
 * 🔴 **`section` 不能是 `view()` 里一个与 `relation` 无关的独立常量**——core 侧
 * `section` 恒等于 `relation` 的这个 1:1 映射,`relation:"shared" +
 * section:"installedFrom"` 这类组合在生产上永不存在。此前 `view()` 把两者当成
 * 两个各自独立的字段,覆盖 `relation` 而不覆盖 `section` 时会静默构造出这种不可能
 * 组合,让依赖 `section` 的判定(`rowAction`/`updateCount`)在一个假前提下跑,
 * 测试却因为凑巧算对了答案而绿——空转模式③的镜像(fixture 让两个互相决定的概念
 * 取了矛盾值)。改成从 `relation` 推导,把"不可能组合"从约定升级成代码。
 */
function sectionOfRelation(relation: InstalledSkillView["relation"]): Section {
  switch (relation) {
    case "shared":
      return "sharedTo";
    case "draft":
      return "shareable";
    default:
      return "installedFrom";
  }
}

/** 确认屏上「用户已经看过的那一份清单」(终审 C-1:确认那一跳要带着它的凭据)。 */
const SEEN_PREVIEW = {
  dirSlug: "weekly-report",
  plan: { added: [], modified: ["SKILL.md"], deleted: [] },
  overwrite: null,
  remoteRev: "sha256:seen",
  stale: false,
};

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
  section: sectionOfRelation(over.relation ?? "installed"),
  libraryUrl: null,
  canonicalReaders: null,
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
    shareableIndexes: new Map(),
    shareableIndexesLastFetchedAt: new Map(),
    updateAllBusy: false,
    updateAllError: null,
    updateAllFailures: null,
    alignAttempted: new Set(),
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

  it("beginShare 记下目标、探一次路径预告,并走一轮**预览**——一个字节都不推", async () => {
    useMySkills.setState({ list: [view({ relation: "draft" })] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share")
        return { outcome: "needsConfirm", plan: { added: ["SKILL.md"], modified: [], deleted: [] }, overwrite: null, remoteRev: "sha256:seen", stale: false };
      return "unknown";
    });

    useMySkills.getState().beginShare("weekly-report");
    await Promise.resolve();
    await Promise.resolve();

    expect(useMySkills.getState().shareTarget).toEqual({ dirSlug: "weekly-report" });
    // 🔴 v8 任务 5:确认屏一打开就问 core"这次会改动哪些文件",但那一跳
    // **不带 `confirmed`** —— core 据此走预览路,一个写请求都不发。
    // 断言的是"没带那个开关",不是"没调过这个 command":后者在新流程里
    // 恒假,留着就是一条永远不触发的空转断言。
    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
    expect(call?.[1].args.confirmRev).toBeUndefined();
    expect(useMySkills.getState().sharePreview).toEqual({
      dirSlug: "weekly-report",
      plan: { added: ["SKILL.md"], modified: [], deleted: [] },
      overwrite: null,
      remoteRev: "sha256:seen",
      stale: false,
    });
  });

  it("🔴 库里已与本地一致:如实说出来,并且不许再提交(那一笔就是空提交)", async () => {
    useMySkills.setState({
      list: [view({ relation: "shared" })],
      shareTarget: { dirSlug: "weekly-report" },
      sharePreview: SEEN_PREVIEW,
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share") return { outcome: "alreadyInSync" };
      if (cmd === "installed_list") return [view()];
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    expect(useMySkills.getState().sharePreview).toEqual({ dirSlug: "weekly-report", inSync: true });
    expect(useMySkills.getState().shareDone).toEqual({
      dirSlug: "weekly-report",
      mode: "inSync",
      flow: "share",
    });
  });

  it("确认时带账上的来源坐标——缺省会推到该源主库,追加库的技能就推错了地方", async () => {
    useMySkills.setState({
      list: [view({ relation: "shared", sourceOwner: "design", sourceRepo: "skills" })],
      shareTarget: { dirSlug: "weekly-report" },
      // 🔴 终审 C-1:确认那一跳要带上预览轮回来的凭据,所以这一屏必须先有清单
      sharePreview: SEEN_PREVIEW,
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
      confirmRev: "sha256:seen",
    });
    // flow 必须是 "share"(终审复审轮 1 #3):确认屏这条路是**首次分享**,
    // 界面据此说「已分享到公司技能库」而不是「**改动**已分享」——记错了就直接
    // 变成一句假话,而渲染那一刻已经无从反推(成功后这一行的 section 就换档了)。
    expect(useMySkills.getState().shareDone).toEqual({
      dirSlug: "weekly-report",
      mode: "pushed",
      flow: "share",
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
      // 🔴 终审 C-1:确认那一跳要带上预览轮回来的凭据,所以这一屏必须先有清单
      sharePreview: SEEN_PREVIEW,
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
      confirmRev: "sha256:seen",
    });
  });

  it("草稿没有来源坐标:落到确认屏上选中的那个库", async () => {
    useMySkills.setState({
      list: [view({ relation: "draft", sourceOwner: "", sourceRepo: "", registryId: "" })],
      shareTarget: { dirSlug: "weekly-report" },
      // 🔴 终审 C-1:确认那一跳要带上预览轮回来的凭据,所以这一屏必须先有清单
      sharePreview: SEEN_PREVIEW,
    });
    useShare.setState({ targetRepo: "skills/skills" });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_share") return { outcome: "shared", mode: "reviewRequested", url: null };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", repo: "skills/skills", confirmRev: "sha256:seen" });
  });

  it("🔴 终审 C-1:「可分享到」区哪怕带着(它自己外部来源的)坐标,也恒推公司库", async () => {
    // 典型场景:从广场/GitHub 装来、还没分享过的技能(section: "shareable")。
    // sourceOwner/sourceRepo/registryId 记的是它自己的外部来源坐标(GitHub/plaza),
    // 不是公司技能库——此前"有坐标就用账上坐标"那支会把这一行推去 vercel-labs 的
    // 公开仓,而确认屏上写的却是「分享到公司技能库」。与下面「无记账但库里有它的
    // 行」(section:"sharedTo")那条是对照组:同样带着坐标,section 不同,结论相反。
    // 🔴 显式清掉 `targetRepo`——上一条用例("草稿没有来源坐标")把它设成了
    // "skills/skills" 且没有重置,不清的话这条测试会拿到那份残留值,断言看起来
    // 是巧合地对了(repo 字段缺席这一半仍会通过?不会——`shareTargetRepo` 在
    // `chosenRepo` 非空时会把它塞进去,残留值会让 `call.args` 多出一个
    // `repo: "skills/skills"`,与这里要证明的"恒不带外部坐标"这件事对不上)。
    useShare.setState({ targetRepo: null });
    useMySkills.setState({
      list: [
        view({
          relation: "draft",
          registryId: "plaza",
          sourceOwner: "vercel-labs",
          sourceRepo: "agent-skills",
        }),
      ],
      shareTarget: { dirSlug: "weekly-report" },
      // 🔴 终审 C-1:确认那一跳要带上预览轮回来的凭据,所以这一屏必须先有清单
      sharePreview: SEEN_PREVIEW,
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_share") return { outcome: "shared", mode: "pushed", url: null };
      if (cmd === "installed_list") return [];
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
    // 不带 registryId(缺省内建源)、repo 不是 vercel-labs/agent-skills
    // (没选过额外仓,缺省该源主库,IPC 层面就是不传 repo)
    expect(call?.[1].args).toEqual({ dirSlug: "weekly-report", confirmRev: "sha256:seen" });
  });

  it("失败时确认屏留着、错误可读——关掉就等于失败被静默吞掉", async () => {
    useMySkills.setState({
      list: [view({ relation: "draft" })],
      shareTarget: { dirSlug: "weekly-report" },
      // 🔴 终审 C-1:确认那一跳要带上预览轮回来的凭据,所以这一屏必须先有清单
      sharePreview: SEEN_PREVIEW,
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_share")
        throw { code: "REPO_NAME_TAKEN", message: "库里已经有同名技能了" };
      return AGENTS;
    });

    await useMySkills.getState().confirmShare();

    expect(useMySkills.getState().shareTarget).not.toBeNull();
    // 归属必须落在这一个技能上(终审复审轮 1,C-A):详情面板的动作区按它过滤,
    // 写空/写错就会让另一个技能的面板显示这条失败。
    expect(useMySkills.getState().shareError?.dirSlug).toBe("weekly-report");
    expect(useMySkills.getState().shareError?.error.message).toContain("同名");
    expect(useMySkills.getState().shareBusy).toBeNull();
  });
});

describe("分享改动撞上「库里那一版与本地基线不符」(v8 任务 4:拦住,但给「仍然覆盖」)", () => {
  beforeEach(() => {
    reset();
    useOverwrite.setState({ pending: null, busy: false });
  });

  const modified = () => view({ localModified: true });

  it("库里那一版会被顶掉:摆覆盖确认屏,点名覆盖谁与何时,不落错误", async () => {
    useMySkills.setState({ list: [modified()] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        return {
          kind: "needsConfirm",
          plan: { added: [], modified: ["SKILL.md"], deleted: ["旧的.md"] },
          overwrite: {
            lastAuthor: "李四",
            lastAt: "2026-09-10T03:04:05Z",
            historyUrl: "http://g/skills/skills/commits/x",
          },
        };
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");

    const pending = useOverwrite.getState().pending;
    expect(pending?.dirSlug).toBe("weekly-report");
    expect(pending?.warning?.lastAuthor).toBe("李四");
    expect(pending?.warning?.lastAt).toBe("2026-09-10T03:04:05Z");
    expect(pending?.warning?.historyUrl).toBe("http://g/skills/skills/commits/x");
    // 🔴 v8 任务 5:清单也要一起带过去——覆盖警告"可能有",而"库里哪几个文件
    // 会没"是这一屏存在的主要理由,漏了它用户就是在盲签。
    expect(pending?.plan.deleted).toEqual(["旧的.md"]);
    // 这一档不是失败:它是"要你先拍板"
    const s = useMySkills.getState();
    expect(s.shareError).toBeNull();
    expect(s.shareDone).toBeNull();
    expect(s.shareBusy).toBeNull();
  });

  it("按「仍然覆盖」→ 带着**用户看过的那一版的凭据**重来一次 → 分享成功", async () => {
    useMySkills.setState({ list: [modified()] });
    const seen: unknown[] = [];
    invoke.mockImplementation(async (cmd: string, payload: Record<string, unknown>) => {
      if (cmd === "skill_share_changes") {
        const args = payload.args as { confirmRev?: string };
        seen.push(args.confirmRev);
        return args.confirmRev
          ? { kind: "submitted", mode: "pushed", commitSha: "n" }
          : {
              kind: "needsConfirm",
              plan: { added: [], modified: ["SKILL.md"], deleted: [] },
              overwrite: null,
              remoteRev: "sha256:seen",
              stale: false,
            };
      }
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");
    await useOverwrite.getState().confirmOverwrite();

    // 🔴 终审 C-1:确认那一跳带回去的必须是**预览轮那一份清单**的凭据,
    // 不是一个 true。带错了(或不带)core 会重算一份再问一次,而那正是
    // "确认屏说 A、实际做 B"唯一的拦法。
    expect(seen).toEqual([undefined, "sha256:seen"]);
    expect(useOverwrite.getState().pending).toBeNull();
    expect(useMySkills.getState().shareDone?.dirSlug).toBe("weekly-report");
  });

  it("🔴 终审 C-1:库里在两轮之间又变了 → core 退回新清单,确认屏如实说一句并换成新的", async () => {
    useMySkills.setState({ list: [modified()] });
    invoke.mockImplementation(async (cmd: string, payload: Record<string, unknown>) => {
      if (cmd === "skill_share_changes") {
        const args = payload.args as { confirmRev?: string };
        return args.confirmRev
          ? {
              kind: "needsConfirm",
              plan: { added: [], modified: ["SKILL.md"], deleted: ["同事刚加的.md"] },
              overwrite: null,
              remoteRev: "sha256:second",
              stale: true,
            }
          : {
              kind: "needsConfirm",
              plan: { added: [], modified: ["SKILL.md"], deleted: [] },
              overwrite: null,
              remoteRev: "sha256:first",
              stale: false,
            };
      }
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");
    await useOverwrite.getState().confirmOverwrite();

    // 那一屏又开着,列的是**重新算出来的**清单,并且带着"这是重算的"这句话
    const pending = useOverwrite.getState().pending;
    expect(pending?.stale).toBe(true);
    expect(pending?.plan.deleted).toEqual(["同事刚加的.md"]);
    // 没有假装成功
    expect(useMySkills.getState().shareDone).toBeNull();
  });

  it("按「先不动」:零 IPC、零副作用", async () => {
    useMySkills.setState({ list: [modified()] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        return { kind: "needsConfirm", plan: { added: [], modified: ["SKILL.md"], deleted: [] }, overwrite: null, remoteRev: "sha256:seen", stale: false };
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");
    const before = invoke.mock.calls.length;
    useOverwrite.getState().cancel();

    expect(invoke.mock.calls.length).toBe(before);
    expect(useOverwrite.getState().pending).toBeNull();
    expect(useMySkills.getState().shareDone).toBeNull();
  });

  it("v8 任务 3:这一跳不再带 forceReview(那个参数已随提交审核一起下线)", async () => {
    useMySkills.setState({ list: [modified()] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        return { kind: "submitted", mode: "pushed", commitSha: "n" };
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(Object.keys((call?.[1] as { args: Record<string, unknown> }).args)).not.toContain(
      "forceReview",
    );
    expect(useMySkills.getState().shareDone).toEqual({
      dirSlug: "weekly-report",
      mode: "pushed",
      flow: "changes",
    });
  });

  it("提交瞬间被人抢先(CONFLICT_STALE)说同一句话", async () => {
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
    expect(s.shareError?.dirSlug).toBe("weekly-report");
    expect(s.shareError?.error.code).toBe("CONFLICT_REMOTE_CHANGED");
  });

  // 终审复审轮 1,C-A:「贡献更改」这条路的失败也要带归属——详情面板的动作区
  // 按 dirSlug 过滤才敢显示,归属丢了就退化成"技能 B 的面板显示技能 A 的失败"。
  it("贡献更改失败:错误带着它属于哪个技能一起记下来", async () => {
    useMySkills.setState({ list: [modified()] });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share_changes")
        throw { code: "REPO_FORBIDDEN", message: "你对这个技能库没有写权限" };
      if (cmd === "installed_list") return [modified()];
      return AGENTS;
    });

    await useMySkills.getState().shareChanges("weekly-report");

    expect(useMySkills.getState().shareError).toEqual({
      dirSlug: "weekly-report",
      error: { code: "REPO_FORBIDDEN", message: "你对这个技能库没有写权限" },
      flow: "changes",
    });
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

  it("relation === shared 的技能被库里其他人改过时不计入角标 —— section 恒是 sharedTo,主按钮是三选一冲突框,不是「更新」", () => {
    // 🔴 v7 任务 4 修复轮 1 I2:这条测试原先断言"照常计入角标"(标题写的是
    // v6 的口径,那时 updateCount 逐条走 hasUpdate,不看 section)。但它当年的
    // fixture `view({ relation: "shared" })` 与 `view()` 的静态默认值
    // `section: "installedFrom"` 拼在一起,构造出了一个**生产上永不存在的组合**
    // ——core 侧 `section` 恒是 `ownership::section(relation)` 的 1:1 映射,
    // `relation:"shared"` 只可能对应 `section:"sharedTo"`。用真实组合重算:
    // sharedTo + remoteChanged 恒判 `conflict`(design「库被别人改过,不论本地」,
    // 见 `rowAction` 判定表),不是 `update`——「全部更新」那颗批量按钮根本不会
    // 碰这一行,摆进角标就是撒谎。`view()` 的 `section` 默认值现在从 `relation`
    // 推导(`sectionOfRelation`),这个组合已经不可能再被静默构造出来。
    const index = {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [{ dirSlug: "weekly-report", contentHash: "sha256:newer" }],
    };
    expect(updateCount([view({ relation: "shared" })], index)).toBe(0);
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

});

describe("sections(v7 三区)", () => {
  const noneAction = () => ({ kind: "none" as const });

  it("三区顺序固定,空区不出现", () => {
    const list = [
      view({ dirSlug: "a", section: "shareable" }),
      view({ dirSlug: "b", section: "installedFrom" }),
    ];
    expect(sections(list, noneAction).map((s) => s.key)).toEqual([
      "installedFrom",
      "shareable",
    ]);
  });

  it("有主按钮的行置顶,其余按名字", () => {
    const list = [
      view({ dirSlug: "zeta", section: "installedFrom" }),
      view({ dirSlug: "alpha", section: "installedFrom" }),
      view({ dirSlug: "beta", section: "installedFrom" }),
    ];
    const act = (s: InstalledSkillView) =>
      s.dirSlug === "zeta" ? ({ kind: "update" as const }) : noneAction();
    expect(sections(list, act)[0]?.items.map((s) => s.dirSlug)).toEqual([
      "zeta",
      "alpha",
      "beta",
    ]);
  });

  it("每区只收自己那一档,不串区", () => {
    const list = [
      view({ dirSlug: "a", section: "installedFrom" }),
      view({ dirSlug: "b", section: "sharedTo" }),
      view({ dirSlug: "c", section: "shareable" }),
    ];
    const secs = sections(list, noneAction);
    expect(secs.map((s) => [s.key, s.items.map((i) => i.dirSlug)])).toEqual([
      ["installedFrom", ["a"]],
      ["sharedTo", ["b"]],
      ["shareable", ["c"]],
    ]);
  });

  it("标题走 i18n,不是拼出来的英文 key", () => {
    const list = [view({ dirSlug: "a", section: "installedFrom" })];
    expect(sections(list, noneAction)[0]?.title).toBe(t("mine.sectionInstalledFrom"));
  });
});

describe("updateCount 改按 rowAction 数(v7):冲突行不计入「全部更新」", () => {
  it("库新+本地都改过(conflict 档)不计入 —— 与 hasUpdate 旧口径的区别", () => {
    const index = {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [{ dirSlug: "weekly-report", contentHash: "sha256:newer" }],
    };
    const list = [
      view({ dirSlug: "weekly-report", section: "installedFrom", localModified: true }),
    ];
    // hasUpdate 本身仍判 true(远端确实变了),但这一行的主按钮是三选一冲突框,
    // 不是「更新」——旧口径(逐条走 hasUpdate)会把它算进「全部更新」能处理的数量,
    // 而「全部更新」批量按钮压根不会碰这一行,是"角标说 1、点了只处理 0"的重演。
    expect(hasUpdate(list[0]!, index)).toBe(true);
    expect(updateCount(list, index)).toBe(0);
  });

  it("库新、本地没改(update 档)照常计入", () => {
    const index = {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [{ dirSlug: "weekly-report", contentHash: "sha256:newer" }],
    };
    const list = [view({ dirSlug: "weekly-report", section: "installedFrom" })];
    expect(updateCount(list, index)).toBe(1);
  });
});

describe("localDiffersNoBaseline(v7 任务 7 修复轮 1,C3:恢复「本地和库里不一样」这一档)", () => {
  const index = (remoteHash: string, over: Record<string, unknown> = {}) => ({
    registryId: "company",
    owner: "skills",
    repo: "skills",
    skills: [{ dirSlug: "weekly-report", contentHash: remoteHash }],
    ...over,
  });

  it("🔴 没有基线 + 两方指纹不同 → true(v6 立项的原始动机场景:作者绕过 app 直推又改了本体)", () => {
    expect(
      localDiffersNoBaseline(view({ contentHash: "", localHash: "h-local" }), index("h-remote")),
    ).toBe(true);
  });

  it("没有基线 + 两方指纹相同 → false", () => {
    expect(localDiffersNoBaseline(view({ contentHash: "", localHash: "h1" }), index("h1"))).toBe(
      false,
    );
  });

  it("有基线时恒 false —— 这一档只回答无基线时答不上来的问题,不渗进有基线的行", () => {
    expect(
      localDiffersNoBaseline(
        view({ contentHash: "sha256:baseline", localHash: "h-local" }),
        index("h-remote"),
      ),
    ).toBe(false);
  });

  it("没有索引 / 来源已移除 / 坐标不对 → false(不知道就不摆,不猜)", () => {
    expect(localDiffersNoBaseline(view({ contentHash: "", localHash: "h1" }), null)).toBe(false);
    expect(
      localDiffersNoBaseline(
        view({ contentHash: "", localHash: "h1", sourceRemoved: true }),
        index("h2"),
      ),
    ).toBe(false);
    expect(
      localDiffersNoBaseline(
        view({ contentHash: "", localHash: "h1", registryId: "custom-1" }),
        index("h2"),
      ),
    ).toBe(false);
  });

  it("任一侧指纹缺失 → false", () => {
    expect(localDiffersNoBaseline(view({ contentHash: "", localHash: "" }), index("h1"))).toBe(
      false,
    );
    expect(
      localDiffersNoBaseline(view({ contentHash: "", localHash: "h1" }), index("", {})),
    ).toBe(false);
  });
});

describe("shareableSourceKey / remoteChangedForShareable(v7 任务 7:外源有新版)", () => {
  it("非 shareable 区一律 null(哪怕坐标齐全)", () => {
    expect(shareableSourceKey(view({ section: "installedFrom", relation: "shared" }))).toBeNull();
  });

  it("来源已移除(sourceRemoved/libraryRemoved)不给键", () => {
    expect(
      shareableSourceKey(
        view({ relation: "draft", section: "shareable", sourceRemoved: true }),
      ),
    ).toBeNull();
    expect(
      shareableSourceKey(
        view({ relation: "draft", section: "shareable", libraryRemoved: true }),
      ),
    ).toBeNull();
  });

  it("坐标任一段缺失(纯本地草稿,或 lock 第 3 源来的空 registryId)不给键", () => {
    expect(
      shareableSourceKey(
        view({ relation: "draft", section: "shareable", registryId: "" }),
      ),
    ).toBeNull();
    expect(
      shareableSourceKey(
        view({ relation: "draft", section: "shareable", sourceOwner: "" }),
      ),
    ).toBeNull();
    expect(
      shareableSourceKey(
        view({ relation: "draft", section: "shareable", sourceRepo: "" }),
      ),
    ).toBeNull();
  });

  it("坐标齐全时给出 `registryId::owner/repo`", () => {
    expect(
      shareableSourceKey(
        view({
          relation: "draft",
          section: "shareable",
          registryId: "plaza",
          sourceOwner: "vercel-labs",
          sourceRepo: "agent-skills",
        }),
      ),
    ).toBe("plaza::vercel-labs/agent-skills");
  });

  it("remoteChangedForShareable:拿到对应索引且内容不同 → true", () => {
    const skill = view({
      relation: "draft",
      section: "shareable",
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "agent-skills",
      contentHash: "sha256:old",
    });
    const indexes = new Map([
      [
        "plaza::vercel-labs/agent-skills",
        {
          registryId: "plaza",
          owner: "vercel-labs",
          repo: "agent-skills",
          branch: "main",
          commitSha: "x",
          committedAt: "",
          fetchedAt: 0,
          skipped: [],
          fromCache: false,
          offline: false,
          curated: [],
          skills: [{ dirSlug: "weekly-report", contentHash: "sha256:new" } as never],
        },
      ],
    ]);
    expect(remoteChangedForShareable(skill, indexes)).toBe(true);
  });

  it("🔴 拿不到那份索引(还没抓到 / 没有外部来源)→ false,静默降级不误报", () => {
    const skill = view({
      relation: "draft",
      section: "shareable",
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "agent-skills",
    });
    expect(remoteChangedForShareable(skill, new Map())).toBe(false);
    // 纯本地草稿(没有外部来源)同样 false,不是因为查不到,而是压根没有键可查
    expect(remoteChangedForShareable(view({ relation: "draft", section: "shareable" }), new Map())).toBe(
      false,
    );
  });
});

describe("ensureShareableIndexes(v7 任务 7 修复轮 1,I3):点击立即查 + 每源每小时最多一次的被动兜底", () => {
  beforeEach(reset);

  function shareableSkill(dirSlug: string) {
    return view({
      dirSlug,
      relation: "draft",
      section: "shareable",
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "agent-skills",
    });
  }

  it("给 shareable 且有外部来源的行去探它自己的 store_index,写进 shareableIndexes", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "store_index") {
        return {
          registryId: "plaza",
          owner: "vercel-labs",
          repo: "agent-skills",
          branch: "main",
          commitSha: "x",
          committedAt: "",
          fetchedAt: 0,
          skipped: [],
          fromCache: false,
          offline: false,
          curated: [],
          skills: [],
        };
      }
      return AGENTS;
    });
    useMySkills.setState({ list: [shareableSkill("a")] });

    await useMySkills.getState().ensureShareableIndexes();

    expect(useMySkills.getState().shareableIndexes.has("plaza::vercel-labs/agent-skills")).toBe(
      true,
    );
    const call = invoke.mock.calls.find(([cmd]) => cmd === "store_index");
    expect(call?.[1].args).toMatchObject({ registryId: "plaza", repo: "vercel-labs/agent-skills" });
  });

  it("🔴 同一个来源在节流窗口内第二次调用不再发请求(1 小时内,即便上次失败)", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "store_index") {
        calls += 1;
        throw new Error("boom");
      }
      return AGENTS;
    });
    useMySkills.setState({ list: [shareableSkill("a"), shareableSkill("b")] });

    // 两个 shareable 行指向同一个来源(同 registryId/owner/repo),应当只发一次;
    // 失败也照样盖时间戳(不是只有成功才算)
    await useMySkills.getState().ensureShareableIndexes();
    expect(calls).toBe(1);
    expect(useMySkills.getState().shareableIndexes.size).toBe(0);

    // 立刻再调一次(模拟窗口重获焦点触发的被动兜底):还在 1 小时节流窗口内,
    // 不该再发请求
    await useMySkills.getState().ensureShareableIndexes();
    expect(calls).toBe(1);
  });

  it("🔴 超过节流窗口(1 小时)后,被动兜底会重新发请求", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "store_index") {
        calls += 1;
        return {
          registryId: "plaza",
          owner: "vercel-labs",
          repo: "agent-skills",
          branch: "main",
          commitSha: "x",
          committedAt: "",
          fetchedAt: 0,
          skipped: [],
          fromCache: false,
          offline: false,
          curated: [],
          skills: [],
        };
      }
      return AGENTS;
    });
    useMySkills.setState({ list: [shareableSkill("a")] });

    const realNow = Date.now;
    let now = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await useMySkills.getState().ensureShareableIndexes();
      expect(calls).toBe(1);

      // 还没到 1 小时:不重发
      now += 59 * 60 * 1000;
      await useMySkills.getState().ensureShareableIndexes();
      expect(calls).toBe(1);

      // 过了 1 小时:被动兜底重新发一次
      now += 2 * 60 * 1000;
      await useMySkills.getState().ensureShareableIndexes();
      expect(calls).toBe(2);
    } finally {
      vi.spyOn(Date, "now").mockRestore();
    }
  });

  it("🔴 点击触发(传 forceDirSlugs)无视节流,立即发请求", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "store_index") {
        calls += 1;
        return {
          registryId: "plaza",
          owner: "vercel-labs",
          repo: "agent-skills",
          branch: "main",
          commitSha: "x",
          committedAt: "",
          fetchedAt: 0,
          skipped: [],
          fromCache: false,
          offline: false,
          curated: [],
          skills: [],
        };
      }
      return AGENTS;
    });
    useMySkills.setState({ list: [shareableSkill("a")] });

    // 第一次(点击触发)
    await useMySkills.getState().ensureShareableIndexes(["a"]);
    expect(calls).toBe(1);

    // 紧接着又点了一次(比如再次打开详情):同样立即发请求,不受节流影响
    // ——这是"用户点了一下"这个动作本身的信号,不该被"1 小时内不重发"拦下。
    await useMySkills.getState().ensureShareableIndexes(["a"]);
    expect(calls).toBe(2);
  });

  it("🔴 修复轮 2:force 调用只查被点的那几个来源,不顺带扫其余(哪怕其余也从没查过)", async () => {
    // 此前 forceKeys.has(key) || stale 是一次"或"判据:首次点击时全部来源都
    // 还没有时间戳、恒 stale,于是点开一行详情会把**全部**外部来源都探一遍
    // ——与"只对这一行自己的外部来源发请求"这句话不符。修复轮 2 之后两条路径
    // 拆开:传了 forceDirSlugs 就精确只查这几个。
    const other = view({
      dirSlug: "b",
      relation: "draft",
      section: "shareable",
      registryId: "custom-1",
      sourceOwner: "acme",
      sourceRepo: "tools",
    });
    const requested: string[] = [];
    invoke.mockImplementation(async (cmd: string, args?: { args?: { repo?: string } }) => {
      if (cmd === "store_index") {
        requested.push(args?.args?.repo ?? "");
        return {
          registryId: "plaza",
          owner: "vercel-labs",
          repo: "agent-skills",
          branch: "main",
          commitSha: "x",
          committedAt: "",
          fetchedAt: 0,
          skipped: [],
          fromCache: false,
          offline: false,
          curated: [],
          skills: [],
        };
      }
      return AGENTS;
    });
    useMySkills.setState({ list: [shareableSkill("a"), other] });

    await useMySkills.getState().ensureShareableIndexes(["a"]);

    expect(requested).toEqual(["vercel-labs/agent-skills"]);
    expect(useMySkills.getState().shareableIndexesLastFetchedAt.has("custom-1::acme/tools")).toBe(
      false,
    );
  });

  it("load() 不再触发 ensureShareableIndexes——翻开页面本身不发请求(I3)", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "store_index") calls += 1;
      if (cmd === "installed_list") return [shareableSkill("a")];
      return AGENTS;
    });

    await useMySkills.getState().load();

    expect(calls).toBe(0);
  });

  it("非 shareable / 无外部来源的行不触发任何请求", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "store_index") calls += 1;
      return AGENTS;
    });
    useMySkills.setState({
      list: [
        view({ dirSlug: "a", section: "installedFrom" }),
        // 纯本地草稿:从没有过任何来源,三个坐标字段都是空串
        view({
          dirSlug: "b",
          relation: "draft",
          section: "shareable",
          registryId: "",
          sourceOwner: "",
          sourceRepo: "",
        }),
      ],
    });

    await useMySkills.getState().ensureShareableIndexes();

    expect(calls).toBe(0);
  });
});

describe("updateAll(v7 任务 7:页头「全部更新」)", () => {
  beforeEach(() => {
    reset();
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "x",
        committedAt: "",
        fetchedAt: 0,
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
        skills: [
          { dirSlug: "a", contentHash: "sha256:new-a" } as never,
          { dirSlug: "b", contentHash: "sha256:same-b" } as never,
          { dirSlug: "c", contentHash: "sha256:new-c" } as never,
        ],
      },
    });
  });

  it("只带 rowAction 判 update 的那些 dirSlug —— conflict/none 都不进批量", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install_batch") return [];
      if (cmd === "installed_list") return useMySkills.getState().list ?? [];
      return AGENTS;
    });
    useMySkills.setState({
      list: [
        // a:库有新版、本地没改 → update,进批量
        view({ dirSlug: "a", section: "installedFrom", contentHash: "sha256:old-a", agents: ["claude-code"] }),
        // b:内容指纹相同 → none,不进批量
        view({ dirSlug: "b", section: "installedFrom", contentHash: "sha256:same-b" }),
        // 🔴 c:库有新版 + 本地也改过 → conflict,不进批量(注入验证抓到过这一档
        // 单独缺失:改成裸 `hasUpdate` 过滤时,前两行的组合恰好测不出差别,
        // 只有页面级测试的 fixture 撞上了这一档才会变红——这条补在源头)
        view({
          dirSlug: "c",
          section: "installedFrom",
          contentHash: "sha256:old-c",
          localModified: true,
        }),
      ],
    });

    await useMySkills.getState().updateAll();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install_batch");
    expect(call?.[1].args.dirSlugs).toEqual(["a"]);
    expect(call?.[1].args.registryId).toBe("company");
    expect(call?.[1].args.repo).toBe("skills/skills");
  });

  it("agentIds 是这批技能各自已启用工具的并集,不是「这台机器检测到的全部工具」", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install_batch") return [];
      if (cmd === "installed_list") return useMySkills.getState().list ?? [];
      return AGENTS;
    });
    useMySkills.setState({
      list: [
        view({
          dirSlug: "a",
          section: "installedFrom",
          contentHash: "sha256:old-a",
          agents: ["claude-code", "trae"],
        }),
      ],
    });

    await useMySkills.getState().updateAll();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install_batch");
    expect(call?.[1].args.agentIds).toEqual(["claude-code", "trae"]);
  });

  it("没有任何 update 档时不发请求", async () => {
    let called = false;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install_batch") called = true;
      return AGENTS;
    });
    useMySkills.setState({ list: [view({ dirSlug: "b", section: "installedFrom", contentHash: "sha256:same-b" })] });

    await useMySkills.getState().updateAll();

    expect(called).toBe(false);
  });

  it("🔴 部分失败要收进 updateAllFailures,不能静默吞掉", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install_batch") {
        return [
          { dirSlug: "a", outcome: "installed", report: {} },
          { dirSlug: "c", outcome: "failed", error: { code: "NET_TIMEOUT", message: "网络超时" } },
        ];
      }
      if (cmd === "installed_list") return useMySkills.getState().list ?? [];
      return AGENTS;
    });
    useMySkills.setState({
      list: [
        view({ dirSlug: "a", section: "installedFrom", contentHash: "sha256:old-a" }),
        view({ dirSlug: "c", section: "installedFrom", contentHash: "sha256:old-c" }),
      ],
    });
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "x",
        committedAt: "",
        fetchedAt: 0,
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
        skills: [
          { dirSlug: "a", contentHash: "sha256:new-a" } as never,
          { dirSlug: "c", contentHash: "sha256:new-c" } as never,
        ],
      },
    });

    await useMySkills.getState().updateAll();

    expect(useMySkills.getState().updateAllFailures).toEqual([
      { dirSlug: "c", message: "网络超时" },
    ]);
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

// ---------------------------------------------------------------------------
// groupBySource(v7.2 需求 4:「可分享到技能库」页签按来源分组)
// ---------------------------------------------------------------------------

describe("groupBySource", () => {
  const s = (dirSlug: string, sourceLabel: string | null) =>
    view({ dirSlug, section: "shareable", relation: "draft", sourceLabel });

  it("无来源那一组排在最前,其余按来源名 localeCompare", () => {
    const got = groupBySource([
      s("b", "vercel-labs/agent-skills"),
      s("a", "acme/tools"),
      s("d", null),
    ]);
    expect(got.map((g) => g.label)).toEqual([null, "acme/tools", "vercel-labs/agent-skills"]);
  });

  it("同一个来源归进同一组(组数 = 不同来源数)", () => {
    const got = groupBySource([s("p", "acme/tools"), s("q", "acme/tools"), s("r", null)]);
    expect(got).toHaveLength(2);
    expect(got[1]?.items.map((x) => x.dirSlug)).toEqual(["p", "q"]);
  });

  // 🔴 组内顺序是调用方(`sections()`)排好的"有动作在前、其余按名字",
  // 这个函数**不许重排**——重排等于在分组这一步把那条排序规则悄悄推翻。
  it("组内保持传入顺序,不重排", () => {
    const got = groupBySource([s("z", "acme/tools"), s("a", "acme/tools")]);
    expect(got[0]?.items.map((x) => x.dirSlug)).toEqual(["z", "a"]);
  });

  it("空输入给空数组(不是一个空组)", () => {
    expect(groupBySource([])).toEqual([]);
  });
});

describe("基线自愈(v8 任务 2):本地与库里已经一致时把陈旧基线对齐", () => {
  beforeEach(reset);

  const index = (remoteHash: string) => ({
    registryId: "company",
    owner: "skills",
    repo: "skills",
    skills: [{ dirSlug: "weekly-report", contentHash: remoteHash }],
  });

  /** 同事真机卡住的那一行:本地与库里逐字节相同,基线却停在旧值。 */
  const stale = (over: Partial<InstalledSkillView> = {}) =>
    view({ contentHash: "sha256:old", localHash: "sha256:same", ...over });

  it("三个量满足条件 → 判定为真", () => {
    expect(baselineNeedsAlign(stale(), index("sha256:same"))).toBe(true);
  });

  it("本地与库里并不相同 → 假(那是真的「有新版」或「本地改过」,不是陈旧基线)", () => {
    expect(baselineNeedsAlign(stale({ localHash: "sha256:mine" }), index("sha256:same"))).toBe(
      false,
    );
  });

  it("基线已经等于库里 → 假(没什么可对齐的)", () => {
    expect(baselineNeedsAlign(stale({ contentHash: "sha256:same" }), index("sha256:same"))).toBe(
      false,
    );
  });

  it("🔴 三个量任一为空 → 假(宁可漏,不误)", () => {
    // 没有基线的行(core 对无记账的行恒填空串):对齐入口会拒,判定这一层就不该放行
    expect(baselineNeedsAlign(stale({ contentHash: "" }), index("sha256:same"))).toBe(false);
    expect(baselineNeedsAlign(stale({ localHash: "" }), index(""))).toBe(false);
    expect(baselineNeedsAlign(stale(), index(""))).toBe(false);
  });

  it("坐标对不上那份索引 → 假(两个技能库的同名技能是两个东西)", () => {
    expect(baselineNeedsAlign(stale({ registryId: "custom-1" }), index("sha256:same"))).toBe(false);
    expect(baselineNeedsAlign(stale({ sourceRepo: "team-skills" }), index("sha256:same"))).toBe(
      false,
    );
    expect(baselineNeedsAlign(stale(), null)).toBe(false);
  });

  it("满足条件时调一次对齐,并带上实时指纹与库坐标,然后重新读一次列表", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [stale()];
      if (cmd === "agents_detected") return AGENTS;
      return null;
    });
    useMySkills.setState({ list: [stale()] });

    await useMySkills.getState().alignStaleBaselines(index("sha256:same"));

    const calls = invoke.mock.calls.filter((c) => c[0] === "skill_align_baseline");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({
      args: {
        dirSlug: "weekly-report",
        // 🔴 发的是**实时**指纹(localHash),不是基线:core 会用它比对本体此刻
        // 的内容,发错的话那道守卫必拒
        contentHash: "sha256:same",
        registryId: "company",
        owner: "skills",
        repo: "skills",
      },
    });
    // 对齐完要重新读一次,行上那句「库里有新版」才会自己消失
    expect(invoke.mock.calls.some((c) => c[0] === "installed_list")).toBe(true);
  });

  it("🔴 同一份数据反复调用只发一次(刷新/重渲染/StrictMode 双挂载都会重跑)", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [stale()];
      if (cmd === "agents_detected") return AGENTS;
      return null;
    });
    useMySkills.setState({ list: [stale()] });

    await useMySkills.getState().alignStaleBaselines(index("sha256:same"));
    useMySkills.setState({ list: [stale()] });
    await useMySkills.getState().alignStaleBaselines(index("sha256:same"));

    expect(invoke.mock.calls.filter((c) => c[0] === "skill_align_baseline")).toHaveLength(1);
  });

  it("多行同时满足 → 每行各一次,不重复也不漏", async () => {
    const rows = [stale(), stale({ dirSlug: "ppi" })];
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return rows;
      if (cmd === "agents_detected") return AGENTS;
      return null;
    });
    useMySkills.setState({ list: rows });

    await useMySkills.getState().alignStaleBaselines({
      registryId: "company",
      owner: "skills",
      repo: "skills",
      skills: [
        { dirSlug: "weekly-report", contentHash: "sha256:same" },
        { dirSlug: "ppi", contentHash: "sha256:same" },
      ],
    });

    const slugs = invoke.mock.calls
      .filter((c) => c[0] === "skill_align_baseline")
      .map((c) => (c[1] as { args: { dirSlug: string } }).args.dirSlug);
    expect(slugs).toEqual(["weekly-report", "ppi"]);
  });

  it("一行都不满足时一个请求都不发,也不重读列表", async () => {
    invoke.mockImplementation(async () => null);
    useMySkills.setState({ list: [view()] });

    await useMySkills.getState().alignStaleBaselines(index("sha256:mine"));

    expect(invoke).not.toHaveBeenCalled();
  });

  it("🔴 对齐失败静默降级:不摆错误横幅、也不因为失败就不再刷新别的行", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_align_baseline") throw { code: "FS_BASELINE_STALE", message: "…" };
      if (cmd === "installed_list") return [stale()];
      if (cmd === "agents_detected") return AGENTS;
      return null;
    });
    useMySkills.setState({ list: [stale()] });

    await useMySkills.getState().alignStaleBaselines(index("sha256:same"));

    expect(useMySkills.getState().loadError).toBeNull();
    // 全部失败时不必重读列表(什么都没变)
    expect(invoke.mock.calls.some((c) => c[0] === "installed_list")).toBe(false);
  });
});
