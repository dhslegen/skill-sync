import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySkillsPage } from "./MySkillsPage";
import type { InstalledSkillView, Section, SkillVersion } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useCreate } from "@/store/create";
import { useMySkills } from "@/store/my-skills";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const BODY = "/h/.claude/skills/weekly-report";

/** core::ownership::section(relation) 的镜像(v7 任务 4 修复轮 1 I2 同款处置):
 *  section 不能是与 relation 无关的独立常量,否则本文件里大量 view({relation:"shared"})
 *  /view({relation:"draft"}) 的既有用例会静默构造出生产上不可能出现的组合。 */
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
  body: BODY,
  localHash: "sha256:mine",
  tools: [{ agent: "claude-code", state: "linked" }],
  versions: [],
  shareBlocked: null,
  section: sectionOfRelation(over.relation ?? "installed"),
  review: null,
  ...over,
});

const V = (path: string, hash: string): SkillVersion => ({
  path,
  modifiedAt: "2026-08-01T00:00:00.000Z",
  files: 2,
  contentHash: hash,
});

const AGENT_LIST = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "cursor", displayName: "Cursor", installed: true, globalSkillsDir: "~/.agents/skills", isUniversal: true, needsLink: false, disabled: false },
    { name: "trae", displayName: "Trae", installed: true, globalSkillsDir: "~/.trae/skills", isUniversal: false, needsLink: true, disabled: false },
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

/** 远端这一版的内容指纹。与 view() 的 contentHash 一致 = 已是最新。 */
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

function reset() {
  invoke.mockReset();
  seedIpc([]);
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
    toolFailuresFor: null,
    versionChoice: null,
    keepBusy: false,
    keepError: null,
    shareTarget: null,
    shareBusy: null,
    shareDone: null,
    shareError: null,
    shareConflict: null,
  });
  useInstall.setState({ phase: "idle", dirSlug: null, precheck: null, shareResult: null });
  useStoreIndex.setState({ index: null });
  useUi.setState({ page: "mine" });
  useShare.setState({ targetRepo: null, preview: "unknown" });
  // 「新建技能」的 store 是模块级的,不重置的话上一条用例留下的 done/form 档
  // 会让下一条找不到入口按钮(两个组件互斥)。
  useCreate.setState({
    phase: "closed",
    form: { dirSlug: "", displayName: "", description: "" },
    error: null,
    createdPath: null,
  });
}

/** 只取技能行区域,避开「装在项目里的」那一区与页头。 */
const rows = () => screen.getAllByRole("button", { name: /周报生成|weekly-report|my-draft/ });

describe("我的技能页 · 基础", () => {
  beforeEach(reset);

  it("空列表引导去商店;点按钮切页", async () => {
    render(<MySkillsPage />);
    await screen.findByText("还没有获取任何技能。");
    await userEvent.click(screen.getByRole("button", { name: "去技能商店看看" }));
    expect(useUi.getState().page).toBe("store");
  });

  it("读取失败显示错误与重试,绝不显示空状态文案", async () => {
    invoke.mockRejectedValue({ code: "FS_TASK", message: "读取已安装列表失败,请重试" });
    render(<MySkillsPage />);
    await screen.findByText(/读取已安装列表失败/);
    expect(screen.queryByText("还没有获取任何技能。")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("行里是展示名,不是内部目录名", async () => {
    seedIpc([view()]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("周报生成");
    expect(screen.queryByText("weekly-report")).toBeNull();
  });

  it("索引查不到时退回目录名,而不是留空", async () => {
    seedIpc([view()]);
    render(<MySkillsPage />);
    await screen.findByText("weekly-report");
  });

  it("两分区固定顺序:我分享的 → 我安装的", async () => {
    seedIpc([view({ relation: "installed" }), view({ dirSlug: "my-draft", relation: "draft" })]);
    render(<MySkillsPage />);
    await screen.findByText("我分享的");
    const heads = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(heads.slice(0, 2)).toEqual(["我分享的", "我安装的"]);
  });

  it("空分区不显示标题", async () => {
    seedIpc([view({ relation: "installed" })]);
    render(<MySkillsPage />);
    await screen.findByText("我安装的");
    expect(screen.queryByText("我分享的")).toBeNull();
  });
});

describe("已撤销的说法不得再出现在界面上", () => {
  beforeEach(reset);

  it("「修复」按钮整个撤销 —— 它缺的不是实现,是概念错了", async () => {
    // 那件事本身就是"在某某工具里启用它"这个勾。断链的位置现在显示成没启用,
    // 再点一次即自愈,不需要第二个入口。
    seedIpc([view({ tools: [{ agent: "claude-code", state: "missing" }] })]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("周报生成");

    expect(screen.queryByText("修复")).toBeNull();
    expect(screen.queryByRole("button", { name: /修复/ })).toBeNull();
  });

  it("「关联」「纳入管理」「移出管理」「其他工具装的」都不出现在 DOM", async () => {
    seedIpc([
      view({ relation: "installed" }),
      view({ dirSlug: "my-draft", relation: "draft", contentHash: "" }),
    ]);
    seedIndex();
    const { container } = render(<MySkillsPage />);
    await screen.findByText("我分享的");

    for (const word of ["关联", "纳入管理", "移出管理", "其他工具装的", "记账", "占位"]) {
      expect(container.textContent, `界面上出现了「${word}」`).not.toContain(word);
    }
  });
});

describe("八个状态各自的主动作", () => {
  beforeEach(reset);

  const shared = (over: Partial<InstalledSkillView> = {}) =>
    view({ relation: "shared", ...over });

  it("synced:不摆任何主动作", async () => {
    seedIpc([shared()]);
    seedIndex("sha256:mine");
    render(<MySkillsPage />);
    await screen.findByText("已同步");
    for (const name of ["取回", "分享更新", "分享", "选择保留哪一份", "改用库里的版本"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("draft:主动作是「分享」,点了打开分享确认屏(而不是跳一个已撤销的页)", async () => {
    seedIpc([shared({ dirSlug: "my-draft", relation: "draft" })], { share_preview: "unknown" });
    render(<MySkillsPage />);
    await screen.findByText("尚未分享");

    await userEvent.click(screen.getByRole("button", { name: "分享" }));

    expect(useMySkills.getState().shareTarget).toEqual({ dirSlug: "my-draft" });
    // 一个字节都不该推出去——这一步只是打开确认屏
    expect(invoke).not.toHaveBeenCalledWith("skill_share", expect.anything());
  });

  it("notHere:主动作是「取回」,真实点击后发出 skill_install", async () => {
    seedIpc([shared({ localPresent: false, body: "", agents: [] })], {
      skill_install: { outcome: "installed", report: { dirName: "weekly-report", canonicalDir: "/c", links: [] }, localKept: false, lock: "written" },
    });
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("不在这台电脑");

    await userEvent.click(screen.getByRole("button", { name: "取回" }));
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_install")).toBe(true),
    );
  });

  it("🔴 「取回」失败必须在这一页看得见 —— 不能转一下就没了下文", async () => {
    // 这两个按钮走的都是 `useInstall.beginUpdate`,失败只写进 `useInstall.error`,
    // 而它唯一的渲染点是 `InstallPanel` 的错误档——从这一页点进去时那个面板
    // 根本不在场。修之前用户看到的是:转了一下、不转了、什么都没变、没有一个字。
    const list = [shared({ localPresent: false, body: "", agents: [] })];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return list;
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_install")
        throw { code: "NET_TIMEOUT", message: "连不上公司技能库,请确认已接入内网" };
      return null;
    });
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("不在这台电脑");

    await userEvent.click(screen.getByRole("button", { name: "取回" }));

    expect(await screen.findByText(/连不上公司技能库/)).toBeInTheDocument();
  });

  it("拍板框已经关掉之后再失败,错误也要有落点(M-2)", async () => {
    // `keepError` 的唯一渲染点本来是 `VersionChooser`,而 `keepVersion` 在
    // `set({ versionChoice: null })`(框就此关掉)**之后**还要走 load()/setAgents()/run()。
    // 那三步今天都自己捕获,所以这是**把一条潜在的静默提前堵上**,不是修缺陷。
    seedIpc([shared()]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByRole("button", { name: "移除" });

    // 框已关(versionChoice = null),错误还在
    act(() => {
      useMySkills.setState({
        versionChoice: null,
        keepError: { code: "FS_TASK", message: "保留所选版本失败,请重试" },
      });
    });

    expect(await screen.findByText(/保留所选版本失败/)).toBeInTheDocument();
  });

  it("拍板框还开着时不在页面上重复摆一遍(框自己会显示)", async () => {
    seedIpc([shared()]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByRole("button", { name: "移除" });

    act(() => {
      useMySkills.setState({
        versionChoice: { dirSlug: "weekly-report", versions: [] },
        keepError: { code: "FS_TASK", message: "保留所选版本失败,请重试" },
      });
    });

    expect(screen.queryByText(/保留所选版本失败/)).toBeNull();
  });

  it("remoteAhead(我分享的):主动作是「取回」", async () => {
    seedIpc([shared()]);
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);
    await screen.findByText("库里有新版");
    expect(screen.getByRole("button", { name: "取回" })).toBeInTheDocument();
  });

  it("localAhead:主动作是「分享更新」,点击调用 skill_share_changes", async () => {
    seedIpc([shared({ localModified: true })], {
      skill_share_changes: { kind: "shared", mode: "pushed", url: null },
    });
    seedIndex("sha256:mine");
    render(<MySkillsPage />);
    await screen.findByText("有改动未分享");

    await userEvent.click(screen.getByRole("button", { name: "分享更新" }));
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share_changes")).toBe(true),
    );
  });

  it("both:主动作是「取回」(冲突由 core 的预检交给弹窗拍板)", async () => {
    seedIpc([shared({ localModified: true })]);
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);
    await screen.findByText("库里有新版,本地也有改动");
    expect(screen.getByRole("button", { name: "取回" })).toBeInTheDocument();
  });

  it("differs:两个方向都摆,不替用户默认谁", async () => {
    // 🔴 这一档没有安装基线,app **确实不知道**是本地改了还是库里更新了。
    // 挑一个当主动作就是在猜,而两个方向猜错的代价都是覆盖掉一边的成果。
    seedIpc([shared({ contentHash: "", localHash: "sha256:local-different" })]);
    seedIndex("sha256:remote");
    render(<MySkillsPage />);
    await screen.findByText("本地和库里不一样");

    expect(screen.getByRole("button", { name: "改用库里的版本" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分享更新" })).toBeInTheDocument();
  });

  it("无基线但内容其实一样:说「已同步」,不摆那两个动作", async () => {
    // differs 的对照组:两方指纹相同就是同步了,不该因为"没有安装记录"
    // 就对用户说一句含糊的话、再摆两个他不需要的按钮。
    seedIpc([shared({ contentHash: "", localHash: "sha256:same" })]);
    seedIndex("sha256:same");
    render(<MySkillsPage />);
    await screen.findByText("已同步");
    expect(screen.queryByRole("button", { name: "改用库里的版本" })).toBeNull();
  });

  it("versions:只摆「选择保留哪一份」与「打开文件夹」,其余动作一概不渲染", async () => {
    // 🔴 磁盘上有几份内容不同的实体时,「取回」「分享更新」的主语是不确定的
    // (拿哪一份去比?去推?)。摆出来就是让用户在没有确定答案的问题上做决定。
    seedIpc([
      shared({
        localModified: true,
        versions: [V("/h/.claude/skills/w", "a"), V("/h/.trae/skills/w", "b")],
      }),
    ]);
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);
    await screen.findByText("有几个版本");

    expect(screen.getByRole("button", { name: "选择保留哪一份" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeInTheDocument();
    for (const name of ["取回", "分享更新", "分享", "移除", "改用库里的版本", "更新"]) {
      expect(screen.queryByRole("button", { name }), `versions 那一档不该摆「${name}」`).toBeNull();
    }
    // 勾组也不摆:还没决定留哪份,"启用哪一份"无从谈起
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("点「选择保留哪一份」把拍板交给 VersionChooser,磁盘未被碰过", async () => {
    const versions = [V("/h/.claude/skills/w", "a"), V("/h/.trae/skills/w", "b")];
    seedIpc([shared({ versions })]);
    render(<MySkillsPage />);
    await screen.findByText("有几个版本");

    await userEvent.click(screen.getByRole("button", { name: "选择保留哪一份" }));

    expect(useMySkills.getState().versionChoice?.versions).toEqual(versions);
    expect(invoke).not.toHaveBeenCalledWith("skill_keep_version", expect.anything());
  });
});

describe("「我安装的」区块", () => {
  beforeEach(reset);

  it("库里有新版时出现「更新」按钮;点击沿用账上的工具与来源坐标", async () => {
    seedIpc([view({ agents: ["claude-code", "cursor"] })], {
      skill_install: { outcome: "installed", report: { dirName: "weekly-report", canonicalDir: "/c", links: [] }, localKept: false, lock: "written" },
    });
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "更新" }));

    await vi.waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
      expect(call?.[1].args).toMatchObject({
        dirSlug: "weekly-report",
        agentIds: ["claude-code", "cursor"],
        registryId: "company",
        repo: "skills/skills",
      });
    });
  });

  it("🔴 both(本地改过 + 库里也有新版)必须有更新入口 —— 角标在算它,页面就得点得到", async () => {
    // 这是修复轮 2 修的**真回归**:`showUpdate` 原先只判 `remoteAhead`,
    // 而取回按钮又有 `!isInstalled` 闸 —— 「我安装的」技能落到 `both` 时
    // 一个更新入口都没有,状态文案却写着「库里有新版」、侧边栏角标照样计数。
    // 正是 CLAUDE.md 记着的「角标说 3、点进去只有 1」。
    //
    // ⚠️ **fixture 必须让 localModified 与"远端更新"同时为真** —— 我上一轮的
    // fixture 让这两个变量从未同时成立(空转模式 ③:两个概念取同值),
    // 所以这一整档从没被构造过。
    seedIpc([view({ relation: "installed", localModified: true })], {
      skill_install: { outcome: "installed", report: { dirName: "weekly-report", canonicalDir: "/c", links: [] }, localKept: false, lock: "written" },
    });
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);

    // 先确认这一行确实落在 both 档(否则下面断言的是另一档,等于空转)
    await screen.findByText("库里有新版,本地也有改动");
    const update = screen.getByRole("button", { name: "更新" });

    await userEvent.click(update);
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_install")).toBe(true),
    );
  });

  it("both 档同时保留「分享改动」 —— 两条路各自成立,不互相排斥", async () => {
    seedIpc([view({ relation: "installed", localModified: true })]);
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);
    await screen.findByText("库里有新版,本地也有改动");
    expect(screen.getByRole("button", { name: "更新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分享改动" })).toBeInTheDocument();
  });

  it("版本一致时没有更新按钮 —— 不能引诱用户做无意义的重装", async () => {
    seedIpc([view()]);
    seedIndex("sha256:mine");
    render(<MySkillsPage />);
    await screen.findByText("周报生成");
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("来源已移除:亮出徽标,更新与分享改动都不再提供", async () => {
    seedIpc([view({ sourceRemoved: true, localModified: true })]);
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);
    await screen.findByText("来源已移除");
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分享改动" })).toBeNull();
  });

  it("技能库不在列表里:说的是这句话,不是「来源已移除」(M4 任务 2)", async () => {
    seedIpc([view({ libraryRemoved: true })]);
    seedIndex("sha256:remote-newer");
    render(<MySkillsPage />);
    await screen.findByText("技能库不在列表中");
    expect(screen.queryByText("来源已移除")).toBeNull();
  });

  it("改过的技能给「分享改动」;点击把改动推回来源", async () => {
    seedIpc([view({ localModified: true })], {
      skill_share_changes: { kind: "shared", mode: "pushed", url: null },
    });
    seedIndex("sha256:mine");
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享改动" }));
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share_changes")).toBe(true),
    );
  });

  it("没改过的技能没有「分享改动」按钮", async () => {
    seedIpc([view({ localModified: false })]);
    seedIndex("sha256:mine");
    render(<MySkillsPage />);
    await screen.findByText("周报生成");
    expect(screen.queryByRole("button", { name: "分享改动" })).toBeNull();
  });
});

// ── 终审 C-3:不合格的技能一颗分享按钮都点不动 ──────────────────────────
//
// A-2 是拍板不复议的硬规则。此前只有 `ShareConfirm` 读过 `shareBlocked`,而
// 「分享更新」在有安装基线时**根本不经过那一屏**、「分享改动」直接走
// `share_installed` —— 本期旗舰场景整个漏了:在 Claude Code 里把 frontmatter
// 的 `name` 改成中文,点一下就直推进公司技能库。
describe("分享前的标准校验(A-2/A-5:显示 + 说明 + 出口)", () => {
  beforeEach(reset);

  it("「分享改动」在不合格时禁用,并说清哪不合格", async () => {
    seedIpc([view({ localModified: true, shareBlocked: "nameMismatch" })]);
    seedIndex("sha256:mine");
    render(<MySkillsPage />);

    expect(await screen.findByRole("button", { name: "分享改动" })).toBeDisabled();
    expect(screen.getByText(/name 与文件夹名不一致/)).toBeInTheDocument();
    // 出路是行上本来就有的「打开文件夹」——改好就能分享,不给出路才是死路
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeEnabled();
  });

  it("「分享更新」在不合格时禁用 —— 它此前完全绕开确认屏", async () => {
    seedIpc([
      view({ relation: "shared", localModified: true, localHash: "sha256:local", shareBlocked: "nameFormat" }),
    ]);
    seedIndex("sha256:mine");
    render(<MySkillsPage />);

    expect(await screen.findByRole("button", { name: "分享更新" })).toBeDisabled();
  });

  it("「分享」(草稿)在不合格时禁用", async () => {
    seedIpc([view({ relation: "draft", contentHash: "", shareBlocked: "descriptionMissing" })]);
    render(<MySkillsPage />);

    expect(await screen.findByRole("button", { name: "分享" })).toBeDisabled();
    expect(screen.getByText(/补上 description/)).toBeInTheDocument();
  });

  it("合格时三颗按钮照常可点 —— 对照组", async () => {
    // 没有它,"永远禁用"这个坏实现同样能过上面三条
    seedIpc([view({ localModified: true, shareBlocked: null })]);
    seedIndex("sha256:mine");
    render(<MySkillsPage />);

    expect(await screen.findByRole("button", { name: "分享改动" })).toBeEnabled();
  });

  it("这一行没有分享入口时不摆那句说明 —— 不制造噪音", async () => {
    // 已同步的已装技能上一颗分享按钮都没有,配一句「分享前请补上 name」纯属噪音
    seedIpc([view({ localModified: false, shareBlocked: "nameMissing" })]);
    seedIndex("sha256:mine");
    render(<MySkillsPage />);

    await screen.findByText("周报生成");
    expect(screen.queryByText(/分享前请在 SKILL.md 里补上 name/)).toBeNull();
  });
});

describe("打开文件夹:目标必须是本体所在,不是目录名", () => {
  beforeEach(reset);

  it("🔴 传 path(本体绝对路径),不传 dirSlug", async () => {
    // 本体很可能根本不住在统一目录里(那正是 v6 二期的起因)。按 dirSlug 请求
    // 会被 core 解析成统一目录下的同名目录——打开的是另一个地方,或者什么都打不开。
    seedIpc([view({ body: "/h/.claude/skills/weekly-report", contentHash: "" })]);
    render(<MySkillsPage />);
    await screen.findByText("weekly-report");

    await userEvent.click(screen.getByRole("button", { name: "打开文件夹" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_reveal");
    expect(call?.[1].args).toEqual({ path: "/h/.claude/skills/weekly-report" });
    expect(call?.[1].args).not.toHaveProperty("dirSlug");
  });

  it("本体不在这台电脑时不摆这个按钮 —— 没有可打开的目标", async () => {
    seedIpc([view({ relation: "shared", localPresent: false, body: "" })]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("不在这台电脑");
    expect(screen.queryByRole("button", { name: "打开文件夹" })).toBeNull();
  });
});

describe("移除", () => {
  beforeEach(reset);

  it("点移除只是进确认流程,磁盘未被碰过", async () => {
    seedIpc([view()]);
    seedIndex();
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "移除" }));

    expect(useMySkills.getState().removePhase).toBe("confirming");
    expect(invoke).not.toHaveBeenCalledWith("skill_remove", expect.anything());
  });

  it("本体不在这台电脑时不摆「移除」—— 没有可移的东西", async () => {
    seedIpc([view({ relation: "shared", localPresent: false, body: "" })]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("不在这台电脑");
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
  });

  it("没有安装记录但本体在:照常摆「移除」(v6 二期起本体自己就是可移的东西)", async () => {
    seedIpc([view({ relation: "shared", contentHash: "", localPresent: true })]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("周报生成");
    expect(screen.getByRole("button", { name: "移除" })).toBeInTheDocument();
  });
});

describe("勾选工具的失败必须看得见", () => {
  beforeEach(reset);

  it("core 报的部分失败逐条摆出来,不静默当成功", async () => {
    // 🔴 收集了不摆出来 = 把"报错中断"换成"静默撒谎"。
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "failed", agent: "claude-code", message: "那个位置已有同名文件夹" },
        { kind: "failed", agent: null, message: "统一目录没能收敛" },
      ],
    });
    render(<MySkillsPage />);

    await screen.findByText(/有 2 处没能完成/);
    // agent 名要换成展示名,不许把内部标识漏给用户
    expect(screen.getByText(/Claude Code：那个位置已有同名文件夹/)).toBeInTheDocument();
    expect(screen.getByText("统一目录没能收敛")).toBeInTheDocument();
    expect(screen.queryByText(/claude-code：/)).toBeNull();
  });

  it("🔴 位置被占(differs)说的是另一句话,并给「打开文件夹」这条出口", async () => {
    // core 对 Differs 不写记录 → tools_of 算出 Off → 勾自己弹回去、零提示。
    // 不摆这条说明的话,用户点几次都只会看到勾弹回,那是永久死路。
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "differs", agent: "trae", existing: "/h/.trae/skills/weekly-report" },
      ],
    });
    render(<MySkillsPage />);

    await screen.findByText(/Trae 那个位置上已经有一份内容不同的技能,没有覆盖它。/);
    // 出口必须真的能点,且带的是那个位置的路径
    await userEvent.click(screen.getByRole("button", { name: "打开 Trae 那个位置的文件夹" }));
    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_reveal");
    expect(call?.[1].args).toEqual({ path: "/h/.trae/skills/weekly-report" });
  });

  it("🔴 打开文件夹被守卫拒掉时必须说出来,绝不静默(R30)", async () => {
    // `skill_reveal` 的守卫是「必须是目录、且目录下有 SKILL.md」,而 differs 给的
    // `existing` **两条都不保证**——`converge` 对 `!target.is_dir()` 同样返回 Differs,
    // 占位物完全可能是一个普通文件。守卫返 FS_NOT_A_SKILL,吞掉它的话用户点了
    // **什么都不会发生、也没有任何提示**,正是这个项目专门记过的那一类
    // 「前端全对却没反应」——零痕迹、最难排查。
    seedIpc([view()], {
      skill_reveal: null,
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view()];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_reveal")
        throw { code: "FS_NOT_A_SKILL", message: "这个文件夹不是技能,或技能描述文件缺失" };
      return null;
    });
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "differs", agent: "trae", existing: "/h/.trae/skills/weekly-report" },
      ],
    });
    render(<MySkillsPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: "打开 Trae 那个位置的文件夹" }),
    );

    // 错误必须看得见,而且带上 core 给的原因
    await screen.findByText(/打不开那个文件夹/);
    expect(screen.getByText(/这个文件夹不是技能,或技能描述文件缺失/)).toBeInTheDocument();
  });

  it("行内的「打开文件夹」失败同样说得出来 —— 那两处按钮走同一条路", async () => {
    // versions 档与普通行的按钮也走 `revealOrExplain`,所以错误的渲染点必须在
    // 页面级、不能挂在勾选失败框里(挂进去的话这两处失败就又没有落点了)。
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [view()];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_reveal") throw { code: "FS_NOT_A_SKILL", message: "打不开" };
      return null;
    });
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("周报生成");

    await userEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    await screen.findByText(/打不开那个文件夹/);
  });

  it("失败框里的「打开文件夹」带工具名,与行内那个区分得开", async () => {
    // 同名可访问标签会让屏幕阅读器与真机扫视都分不出指向哪个位置。
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "differs", agent: "trae", existing: "/h/.trae/skills/weekly-report" },
      ],
    });
    render(<MySkillsPage />);

    await screen.findByRole("button", { name: "打开 Trae 那个位置的文件夹" });
    // 行内那个仍然是朴素的「打开文件夹」,两者不同名
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeInTheDocument();
  });

  it("全是 differs 时标题说「需要你看一下」,含真失败时说「没能完成」", async () => {
    // 只读标题的人不该把一屏真失败当成温和的提示。
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [{ kind: "differs", agent: "trae", existing: "/x" }],
    });
    const { unmount } = render(<MySkillsPage />);
    await screen.findByText(/有 1 处需要你看一下/);
    unmount();

    useMySkills.setState({
      toolFailures: [
        { kind: "differs", agent: "trae", existing: "/x" },
        { kind: "failed", agent: "cursor", message: "cursor 没配上" },
      ],
    });
    render(<MySkillsPage />);
    await screen.findByText(/有 2 处没能完成/);
  });

  it("按位置报的失败:路径与原因都摆出来,标题算「没能完成」", async () => {
    // 终审 C-1/I-1 的渲染面。**标题那一档单独钉住**:判据若写成列举失败档
    // (`kind === "failed"`),这一档会被默认算成温和的「需要你看一下」——
    // 而它恰恰是"落选版本没能进废纸篓"「某个位置没能解除」这类真失败。
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "location", path: "/h/.trae/skills/weekly-report", message: "移到废纸篓失败" },
      ],
    });
    render(<MySkillsPage />);

    await screen.findByText(/有 1 处没能完成/);
    expect(screen.getByText("/h/.trae/skills/weekly-report")).toBeInTheDocument();
    expect(screen.getByText(/移到废纸篓失败/)).toBeInTheDocument();
  });

  it("differs 与真正的失败在界面上说的不是同一句话", async () => {
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "failed", agent: "trae", message: "trae 没配上" },
      ],
    });
    render(<MySkillsPage />);

    await screen.findByText(/Trae：trae 没配上/);
    expect(screen.queryByText(/已经有一份内容不同的技能/)).toBeNull();
  });

  it("统一目录那一档没有 agent 名,用一句人话顶上,不留空", async () => {
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "differs", agent: null, existing: "/h/.agents/skills/w" },
      ],
    });
    render(<MySkillsPage />);
    await screen.findByText(/统一技能目录 那个位置上已经有一份内容不同的技能/);
  });

  // v7 任务 6 修复轮 2(R19):toolFailures/setAgentsError 是全局字段,横幅此前
  // 不点名归属技能——用户对 A 打勾失败后滚到别的技能那一行,横幅仍挂在页顶,
  // 读者会以为说的是眼前这一行。**不能靠"没有归属就不显示"来解决**(见下面
  // 那条"没有归属"的对照):remove 清账后那一行本身就从这一页消失了,
  // `toolFailuresFor` 对 remove/keepVersion 恒为 null,硬要求"有归属才显示"
  // 会让那两类失败又变回零渲染点,重演终审 C-1/I-1。所以只加名字,不加隐藏条件。
  it("有归属(setAgents 来源)时,横幅点名是哪个技能,不再语焉不详", async () => {
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [{ kind: "differs", agent: "trae", existing: "/x" }],
      toolFailuresFor: "weekly-report",
    });
    render(<MySkillsPage />);
    await screen.findByText(/「周报生成」有 1 处需要你看一下/);
  });

  it("setAgentsError 同样点名归属技能", async () => {
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      setAgentsError: { code: "FS_LINK_FAILED", message: "统一目录那一处没配上" },
      toolFailuresFor: "weekly-report",
    });
    render(<MySkillsPage />);
    await screen.findByText(/没能改动「周报生成」的 AI 工具启用状态/);
  });

  it("没有归属(remove/keepVersion 来源,toolFailuresFor 为 null)时不点名,零回归", async () => {
    seedIpc([view()]);
    seedIndex();
    useMySkills.setState({
      toolFailures: [
        { kind: "location", path: "/h/.trae/skills/weekly-report", message: "移到废纸篓失败" },
      ],
      toolFailuresFor: null,
    });
    render(<MySkillsPage />);
    await screen.findByText(/有 1 处没能完成/);
    // 缩窄到"没有把这个技能的展示名点进横幅"这件事本身,不用宽泛的「」扫描
    // ——页面别处(比如项目分区的空态提示)也含中文书名号,泛扫描会把无关内容
    // 算成假阳性。
    expect(screen.queryByText(/「周报生成」/)).not.toBeInTheDocument();
  });

  it("没有失败时不摆那个框", async () => {
    seedIpc([view()]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("周报生成");
    expect(screen.queryByText(/需要你看一下/)).toBeNull();
  });
});

describe("其余既有承诺", () => {
  beforeEach(reset);

  it("点行内名称区打开本地详情,按本体路径请求", async () => {
    const open = vi.fn();
    useLocalDetail.setState({ open });
    seedIpc([view()]);
    seedIndex();
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /周报生成/ }));
    expect(open).toHaveBeenCalledWith({ path: BODY });
  });

  it("右侧动作按钮不会顺带打开详情", async () => {
    const open = vi.fn();
    useLocalDetail.setState({ open });
    seedIpc([view()]);
    seedIndex();
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "移除" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("「以本地为准,分享更新」的失败要在这一页看得见 —— 绝不静默", async () => {
    // 那条路的结果只写进 useInstall.shareResult,而它唯一的渲染点在
    // InstallPanel 的装完那一屏——从这一页点进去时那个面板根本不在场。
    seedIpc([view()]);
    seedIndex();
    useInstall.setState({
      shareResult: { error: { code: "NET_TIMEOUT", message: "连不上公司技能库" } },
    });
    render(<MySkillsPage />);
    await screen.findByText(/连不上公司技能库/);
  });

  it("「以本地为准,分享更新」成功时同样有回执", async () => {
    seedIpc([view()]);
    seedIndex();
    useInstall.setState({ shareResult: { mode: "reviewRequested" } });
    render(<MySkillsPage />);
    await screen.findByText("改动已提交审核,审核通过后生效。");
  });

  it("有来源标签时展示「来源 owner/repo」", async () => {
    seedIpc([view({ sourceLabel: "acme/skills" })]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("来源 acme/skills");
  });

  it("内部字段的空值不许漏到界面上:没有「获取于 」这种半截话", async () => {
    seedIpc([view({ sourceLabel: null, updatedAt: "", contentHash: "" })]);
    const { container } = render(<MySkillsPage />);
    await screen.findByText("weekly-report");
    expect(container.textContent).not.toContain("获取于 ");
    expect(container.textContent).not.toContain("来源 ");
  });

  it("🔴 「新建技能」真的点得开、填得完、提交得出去 —— 不是只断言它渲染了", async () => {
    // R23:搬家之前 `skill_create` 这条 IPC 没有任何界面到得了,等于功能还在、门没了。
    // ⚠️ 只断言 `toBeInTheDocument` 正是本项目吃过亏的写法(「加了按钮就要有测试
    // 真的点过它」)——所以这条从点开一路走到 invoke。
    seedIpc([view()], {
      skill_create: { dirSlug: "my-notes", path: "/h/.agents/skills/my-notes" },
    });
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("周报生成");

    await userEvent.click(screen.getByRole("button", { name: "新建技能" }));

    // 展开态出来了,而且入口按钮让位(两个组件互斥,不会同时在场)
    await screen.findByText("新建一个技能");
    expect(screen.queryByRole("button", { name: "新建技能" })).toBeNull();

    // 三项齐备之前提交按钮是禁用的 —— 不让用户点一个必然失败的按钮
    const create = screen.getByRole("button", { name: "创建" });
    expect(create).toBeDisabled();

    const boxes = screen.getAllByRole("textbox");
    await userEvent.type(boxes[0], "我的笔记");
    await userEvent.type(boxes[1], "记点东西");
    await userEvent.type(boxes[2], "my-notes");
    expect(create).toBeEnabled();

    await userEvent.click(create);

    await vi.waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_create");
      expect(call?.[1].args).toEqual({
        dirSlug: "my-notes",
        displayName: "我的笔记",
        description: "记点东西",
      });
    });
    // 完成页给出真实落点,并且刷新了这一页(新技能要立刻看得见)
    await screen.findByText("/h/.agents/skills/my-notes");
  });

  it("文件夹名不合规时不放行 —— 与 core 同一把尺子", async () => {
    seedIpc([view()]);
    seedIndex();
    render(<MySkillsPage />);
    await screen.findByText("周报生成");
    await userEvent.click(screen.getByRole("button", { name: "新建技能" }));
    await screen.findByText("新建一个技能");

    const boxes = screen.getAllByRole("textbox");
    await userEvent.type(boxes[0], "我的笔记");
    await userEvent.type(boxes[1], "记点东西");
    // core 会把 `a--b` 静默清洗成 `a-b`:填的和落盘的不是一个东西,所以不放行
    await userEvent.type(boxes[2], "a--b");

    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalledWith("skill_create", expect.anything());
  });

  it("空态也有「新建技能」,同样点得开", async () => {
    render(<MySkillsPage />);
    await screen.findByText("还没有获取任何技能。");
    await userEvent.click(screen.getByRole("button", { name: "新建技能" }));
    await screen.findByText("新建一个技能");
  });

  it("勾组挂在每一行上,按 agents_detected 的显示名渲染", async () => {
    seedIpc([view({ tools: [{ agent: "claude-code", state: "linked" }] })]);
    seedIndex();
    render(<MySkillsPage />);

    const box = await screen.findByRole("checkbox");
    expect(box).toBeChecked();
    expect(within(box.closest("label")!).getByText("Claude Code")).toBeInTheDocument();
    expect(rows().length).toBeGreaterThan(0);
  });
});
