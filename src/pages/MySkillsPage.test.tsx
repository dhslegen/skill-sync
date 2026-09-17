import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySkillsPage } from "./MySkillsPage";
import type { InstalledSkillView, Section, StoreIndexView } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMineSearch } from "@/store/mine-search";
import { useCreate } from "@/store/create";
import { useMySkills } from "@/store/my-skills";
import { useSession } from "@/store/session";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const AGENT_LIST = {
  agents: [
    {
      name: "claude-code",
      displayName: "Claude Code",
      installed: true,
      globalSkillsDir: "~/.claude/skills",
      skillsDir: ".claude/skills",
      isUniversal: false,
      needsLink: true,
      disabled: false,
    },
  ],
  canonicalDir: "~/.agents/skills",
};

/** 与真实 `core::ownership::section(relation)` 同一个映射(v7 任务 4 起本文件
 *  历次重写都沿用的既有处置)——`section` 不能是与 `relation` 无关的独立字段,
 *  否则 fixture 会拼出生产上不可能出现的组合(空转测试模式③)。 */
function sectionOfRelation(section: Section): InstalledSkillView["relation"] {
  switch (section) {
    case "sharedTo":
      return "shared";
    case "shareable":
      return "draft";
    default:
      return "installed";
  }
}

/** 一行 fixture。`remote: "NEW"` 是这个文件自己的记号(不进真实 DTO,`seed()` 用它
 *  决定 mock 出的 `store_index` 该给这一行哪份远端指纹),不是 `InstalledSkillView`
 *  的字段——渲染前用 `stripFixtureOnly` 剥掉,不让它悄悄混进 `installed_list`。 */
type Fixture = InstalledSkillView & { remote?: "NEW" };

function mk(dirSlug: string, section: Section, over: Partial<Fixture> = {}): Fixture {
  const { remote, ...rest } = over;
  return {
    dirSlug,
    commitSha: "sha",
    contentHash: `sha256:base-${dirSlug}`,
    agents: ["claude-code"],
    installedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    localModified: false,
    sourceOwner: "skills",
    sourceRepo: "skills",
    registryId: "company",
    sourceRemoved: false,
    libraryRemoved: false,
    relation: sectionOfRelation(section),
    localPresent: true,
    sourceLabel: section === "shareable" ? null : "skills/skills",
    body: `/h/.agents/skills/${dirSlug}`,
    localHash: `sha256:base-${dirSlug}`,
    tools: [{ agent: "claude-code", state: "linked" }],
    versions: [],
    shareBlocked: null,
    section,
    libraryUrl: null,
    canonicalReaders: null,
    remote,
    ...rest,
  };
}

function stripFixtureOnly(list: Fixture[]): InstalledSkillView[] {
  return list.map((s) => {
    const { remote, ...rest } = s;
    void remote; // 只是为了从 rest 里剥掉这个字段,不是真的要用它
    return rest;
  });
}

function companyIndex(list: Fixture[]): StoreIndexView {
  return {
    registryId: "company",
    owner: "skills",
    repo: "skills",
    branch: "main",
    commitSha: "headsha",
    committedAt: "2026-08-01T00:00:00.000Z",
    fetchedAt: 0,
    skipped: [],
    fromCache: false,
    offline: false,
    curated: [],
    skills: list
      .filter((s) => s.section !== "shareable")
      .map((s) => ({
        name: s.dirSlug,
        dirSlug: s.dirSlug,
        description: "",
        path: "",
        hasScripts: false,
        fileCount: 1,
        contentHash: s.remote === "NEW" ? `sha256:remote-new-${s.dirSlug}` : s.contentHash,
        tags: [],
        author: null,
        updatedAt: { kind: "unknown" } as const,
      })),
  };
}

/** 页面挂载即 `load()`(`useMySkills`),数据必须从 mock 的 IPC 里来——绕过它去
 *  `setState` 会被 `load()` 的结果冲掉(本项目记着的既有教训:测试靠 `setState`
 *  手喂,而挂载的 `load()` 会整体替换数据,绿的那次什么都没证明)。
 *
 * 🔴 **公司库索引(`useStoreIndex().index`)是例外**——这一页从不自己触发
 * `store_index` 那条 IPC(那是商店页浏览时才会做的事),`hasUpdate` 吃的
 * `index` 完全来自"用户之前逛过商店页、索引已经在内存里"这件事。所以这里直接
 * `useStoreIndex.setState`,不经 `invoke` mock——与本文件此前(v6 二期)的
 * `seedIndex()` 同一个既有处置,不是新发明。 */
function seed(list: Fixture[]) {
  useSession.setState({ status: "signedIn" });
  useStoreIndex.setState({ index: companyIndex(list) });
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "installed_list") return stripFixtureOnly(list);
    if (cmd === "agents_detected") return AGENT_LIST;
    if (cmd === "store_index") return companyIndex(list);
    if (cmd === "skill_install_batch") return [];
    if (cmd === "share_preview") return "unknown";
    return null;
  });
}

function seedSignedOut(list: Fixture[]) {
  seed(list);
  useSession.setState({ status: "signedOut" });
}

/**
 * 渲染并切到某个库页签。
 *
 * v7.2 起「我的技能」是四个并列页签,**一次只渲染一个区**——默认落在
 * 「安装自技能库」,所以断言其余两区的行必须先真点一下那个页签(不是放宽断言,
 * 是补上用户真实要做的那一步)。
 */
async function renderAtTab(name: RegExp) {
  const r = render(<MySkillsPage />);
  await userEvent.click(await screen.findByRole("tab", { name }));
  return r;
}

/**
 * 最近一次调用某个 command 的参数——`skill_install_batch` 那条断言专用。
 *
 * 🔴 不用 `.at(-1)`——项目 tsconfig 锁在 ES2020 lib,`.at()` 是 ES2022 才有的
 * 数组方法。`vitest` 不做类型检查,这一步只有 `pnpm build:web`(tsc)拦得住,
 * CLAUDE.md 记着 M2 任务 6 真的因为这个漏网过一次。
 */
function lastInvoke(cmd: string): { args: Record<string, unknown> } | undefined {
  const matches = invoke.mock.calls.filter(([c]) => c === cmd) as [
    string,
    { args: Record<string, unknown> },
  ][];
  return matches[matches.length - 1]?.[1];
}

function resetStores() {
  invoke.mockReset();
  useSession.setState({ status: "unknown", user: null, error: null });
  useMineSearch.setState({ query: "" });
  useStoreIndex.setState({ index: null, activeRegistry: "company", activeRepo: "skills/skills" });
  useShare.setState({ targetRepo: null, preview: "unknown" });
  useLocalDetail.setState({ target: null, detail: null, error: null });
  useInstall.setState({
    phase: "idle",
    dirSlug: null,
    registryId: null,
    repo: null,
    agents: [],
    selected: new Set(),
    shareResult: null,
    error: null,
  });
  useMySkills.setState({
    list: null,
    loadError: null,
    loading: false,
    agentNames: new Map(),
    installedAgents: null,
    canonicalDir: "",
    toolDirs: new Map(),
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
    shareableIndexes: new Map(),
    shareableIndexesLastFetchedAt: new Map(),
    updateAllBusy: false,
    updateAllError: null,
    updateAllFailures: null,
    alignAttempted: new Set(),
  });
  useCreate.setState({ phase: "closed" });
  try {
    localStorage.clear();
  } catch {
    // 隐私模式等场景,清不掉也不该拖垮测试
  }
}

beforeEach(resetStores);

// ---------------------------------------------------------------------------
// brief Step 1 的六条测试,逐字照用(仅把伪代码换成本文件的真实 mk/seed 实现)。
// ---------------------------------------------------------------------------

describe("v7 任务 7:DoD 六条", () => {
  it("一切正常时:没有按钮、没有状态字", async () => {
    seed([mk("a", "installedFrom"), mk("b", "sharedTo")]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    // 🔴 范围收在**行内**:页签("已分享到技能库"/"可分享到技能库")本身就带
    // 「分享」二字,而它们是页签不是动作按钮——不收窄的话这条断言会被页签名误伤,
    // 测的就不再是"行上没有动作按钮"这件事了。
    // (v7.2 之前这个误伤源是区标题/折叠头,区标题已删,但页签接管了同一批文字,
    //  所以收窄这件事本身照旧需要,只是理由的指向变了。)
    expect(within(row).queryByRole("button", { name: /更新|分享|贡献/ })).toBeNull();
    expect(screen.queryByText(/已同步/)).toBeNull();
  });

  /** ⚠️ 这一条被改判过两次,每次都是前提被推翻、不是断言被放宽:
   *  Q19-C 推翻了"总数挂在页签上所以页头别摆第二份"这个前提;Q24-B 把落点定在
   *  页签行右侧;**Q27-A 又把它挪回列表上方**——总数是**本栏**口径,而页签行是
   *  跨栏区域。三次改判之后仍然成立、也仍然值得钉的是"**不另起一行**":它并进
   *  了列表上方那一行(与筛选态同行),没有为它单开一行。 */
  it("🔴 M2:总数在列表上方那一行里、不另起一行,「新建技能」在页签行", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    const tabs = screen.getByRole("tablist");
    // Q27-A:总数在列表上方那一行(`mine-section-bar`),不在页签行
    expect(screen.getByTestId("mine-total")).toHaveTextContent("共 1 个技能");
    expect(screen.getByTestId("mine-section-bar")).toContainElement(
      screen.getByTestId("mine-total"),
    );
    expect(screen.getByTestId("mine-tabs-row")).not.toContainElement(
      screen.getByTestId("mine-total"),
    );
    const createButton = screen.getByRole("button", { name: "新建技能" });
    // 「新建技能」与 tablist 是同一个父容器下的兄弟节点(design #16:紧跟在
    // 「项目里」之后),不是散落在页面别处。
    expect(tabs.parentElement).toBe(createButton.parentElement);
  });

  /** ⚠️ v7.3 Q28-C 撤掉了「N 个有更新」那段文字,数字改挂在按钮上(「全部更新 · 1」)
   *  ——所以这一条改成按按钮名断言。**行为一个字没动**:仍只覆盖"库有新版且本地
   *  没改"的行,由 `skill_install_batch` 收到的 dirSlugs 正面钉住。 */
  it("有事要做时:页签行给「全部更新 · N」,只覆盖库有新版且本地没改的", async () => {
    seed([
      mk("a", "installedFrom", { remote: "NEW" }),
      mk("b", "installedFrom", { remote: "NEW", localModified: true }),
    ]);
    render(<MySkillsPage />);
    // 数字在按钮上:b 本地改过,不算——所以是 1 不是 2
    await userEvent.click(await screen.findByRole("button", { name: "全部更新 · 1" }));
    expect(lastInvoke("skill_install_batch")?.args.dirSlugs).toEqual(["a"]);
  });

  /** 🔴 Q28-C:整页汇总那两段文字**撤掉了**。它们是页签角标(逐栏、更精确)的
   *  冗余表达。负向断言按语义写、不抄某一个字面量。 */
  it("🔴 整页汇总文字已撤掉:全屏没有「N 个有更新 / N 个有改动未分享」", async () => {
    seed([
      mk("a", "installedFrom", { remote: "NEW" }),
      mk("b", "installedFrom", { localModified: true }),
    ]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    expect(document.body.textContent ?? "").not.toMatch(/个有更新|有改动未分享/);
  });

  // 🔴 v7.1 任务 5(用户 2026-09-02 真机走查):列表上方那一行是**一行轻字**,
  // 不是一张卡片。断言必须落在**形态**这一层——只查文字的话,卡片形态与轻字
  // 形态都能通过(视觉类断言最典型的空转)。
  // (v7.3 Q29-B:这一行的内容换成了「共 N 个技能」+ 筛选态,形态约束不变。)
  it("🔴 列表上方那一行是一行轻字,不是卡片:容器不带边框/底色/卡片圆角", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    const bar = await screen.findByTestId("mine-section-bar");
    expect(bar.className).not.toContain("rounded-card");
    expect(bar.className).not.toContain("border-border");
    expect(bar.className).not.toContain("bg-surface-1");
  });

  // 「全部更新」是可点动作,按画布是浅橙 chip(不是实心、也不是裸文字)。
  it("🔴 「全部更新 · N」是浅橙 chip:带 bg-accent-soft,不是实心 bg-accent", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    const btn = await screen.findByRole("button", { name: "全部更新 · 1" });
    expect(btn.className.split(/\s+/)).toContain("bg-accent-soft");
    expect(btn.className.split(/\s+/)).not.toContain("bg-accent");
  });

  it("每行至多一颗主按钮,其余在「…」里", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    expect(
      within(row)
        .getAllByRole("button")
        .filter((b) => !b.getAttribute("aria-label")),
    ).toHaveLength(1);
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.getByRole("menuitem", { name: "打开文件夹" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "移除" })).toBeInTheDocument();
  });

  it("点行空白处打开详情,点主按钮不打开", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: "更新" }));
    expect(useLocalDetail.getState().target).toBeNull();
    await userEvent.click(screen.getByTestId("row-a-body"));
    expect(useLocalDetail.getState().target).not.toBeNull();
  });

  it("未登录:没有「已分享到」区,区标题旁写明原因", async () => {
    // 🔴 I5 订正:原用例的 fixture 只有 installedFrom 行,"已分享到技能库"
    // 这个断言本来就不会出现(区标题走空区自动过滤,与登录态无关)——把页面
    // 改坏(比如删掉隐藏 sharedTo 区的逻辑,如果真有这种逻辑的话)这条用例也不会
    // 变红,是一次空转。这里补一条 sharedTo 行,**如实说明**:这一档的隐藏是
    // core 的 `ownership::relation` 决定的(未登录时 `relation` 恒不是
    // `Shared`,数据里天然不会有 sharedTo 行)——页面自己不做任何按登录态过滤
    // 分区的逻辑,`sections()` 只按 `section` 字段分组。所以这条测试真正要盯的
    // 是下一条:提示文案本身是不是真的由登录态控制。
    seedSignedOut([mk("a", "installedFrom"), mk("b", "sharedTo")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    // sharedTo 区照样渲染——页面不隐藏它,fixture 里硬塞一条 sharedTo 行
    // 只是不符合真实场景(未登录时 core 不会产出这种行),不代表页面在拦它。
    expect(screen.getByText("已分享到技能库")).toBeInTheDocument();
    expect(screen.getByText(/登录后能区分哪些是你分享的/)).toBeInTheDocument();
  });

  it("🔴 I5:提示文案本身由登录态控制——同一份数据切换 session 状态,提示跟着出现/消失", async () => {
    // 这才是页面代码真正管的那个量(`sessionStatus !== "signedIn"`),
    // 数据全程不变,只翻 useSession 的状态,注入验证时把这一行判据删掉,
    // 这条测试必须变红。
    seed([mk("a", "installedFrom")]);
    const { rerender } = render(<MySkillsPage />);
    await screen.findByText("a");
    expect(screen.queryByText(/登录后能区分哪些是你分享的/)).toBeNull();

    act(() => {
      useSession.setState({ status: "signedOut" });
    });
    rerender(<MySkillsPage />);
    expect(await screen.findByText(/登录后能区分哪些是你分享的/)).toBeInTheDocument();

    act(() => {
      useSession.setState({ status: "signedIn" });
    });
    rerender(<MySkillsPage />);
    await vi.waitFor(() => {
      expect(screen.queryByText(/登录后能区分哪些是你分享的/)).toBeNull();
    });
  });

  it("🔴 终审 M-8:只有草稿(没有「安装自」的行)时,未登录提示不该贴在「可分享到」标题下", async () => {
    // 提示说的是"登录后能区分哪些是你分享的"——那对的是"安装自 vs 已分享到"
    // 这一对区分,与草稿(还没进公司库的技能)毫无关系。v7.2 页签化之后判据
    // 变成了"用户正在看哪个页签",这条命题原样成立:切到「可分享到」不摆它。
    seedSignedOut([mk("draft-a", "shareable")]);
    render(<MySkillsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /可分享到技能库/ }));
    expect(screen.getByTestId("row-draft-a")).toBeInTheDocument();
    expect(screen.queryByText(/登录后能区分哪些是你分享的/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 补充覆盖:三区排列、可分享到区的外源更新、注入前信号分离用的对照组。
// ---------------------------------------------------------------------------

describe("三区排列与判定表接线", () => {
  // v7.2:三区变成页签之后,"固定顺序"这条命题的落点从区标题挪到了页签行,
  // 而"空区不出现"**不再成立也不该成立**——页签是常驻的,空的那个页签要留着
  // 让用户点进去看到它自己的空态文案(否则用户找不到那一类在哪)。
  it("页签按 installedFrom → sharedTo → shareable 固定顺序,空区的页签也常驻", async () => {
    seed([mk("a", "shareable"), mk("b", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("b");
    const titles = screen.getAllByRole("tab").map((h) => (h.textContent ?? "").replace(/\s+/g, ""));
    // 🔴 v7.3 需求 1+2 + Q19-C:「项目里」已挪进侧边栏(只剩三个页签);`·` 分隔符、
    // 「个要处理」四个字**以及总数**全部撤掉——页签上只剩名字。要处理的那个数在
    // **另一颗按钮**(角标)上,所以不出现在 `role="tab"` 的 textContent 里;
    // 总数搬去了列表上方的总览行(见「Q19-C」那一组用例)。
    expect(titles).toEqual(["安装自技能库", "已分享到技能库", "可分享到技能库"]);
  });

  it("installedFrom:本地改过但库没变 → 「贡献更改」", async () => {
    seed([mk("a", "installedFrom", { localModified: true })]);
    render(<MySkillsPage />);
    expect(await screen.findByRole("button", { name: "贡献更改" })).toBeInTheDocument();
  });

  it("installedFrom:库新 + 本地也改过 → 冲突态的浅色按钮,点击走 pull(既有 beginUpdate 编排)", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW", localModified: true })]);
    render(<MySkillsPage />);
    const btn = await screen.findByRole("button", { name: "库里有新版…" });
    await userEvent.click(btn);
    // 复用既有 beginUpdate:core 的预检会把这一行判成需要拍板,交给全局挂载的
    // ConflictDialog——这里只断言 install store 确实进入了"跑起来"的轨道
    // (dirSlug 落定),不重复造一条新的冲突通道。
    expect(useInstall.getState().dirSlug).toBe("a");
  });

  // 🔴 v7.1 任务 5(用户 2026-09-02 真机走查):conflict 是这一行**唯一**的主
  // 按钮,此前画成虚线下划线文字链,弱到看不出可点。断言要落在形态上:chip
  // 类名在场 **且** 旧的 `decoration-dotted` 不在场——只查文字的话两种形态都过。
  it("🔴 conflict 档是浅橙 chip 按钮,不是虚线下划线文字链", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW", localModified: true })]);
    render(<MySkillsPage />);
    const btn = await screen.findByRole("button", { name: "库里有新版…" });
    expect(btn.className).toContain("bg-accent-soft");
    expect(btn.className).toContain("text-accent");
    expect(btn.className).not.toContain("decoration-dotted");
    expect(btn.className).not.toContain("underline");
  });

  // 省略号是语义的一部分(点了会先问你留哪一份),不是文本被截断。
  it("🔴 conflict 档的文案保留末尾省略号", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW", localModified: true })]);
    render(<MySkillsPage />);
    expect((await screen.findByRole("button", { name: "库里有新版…" })).textContent).toMatch(/…$/);
  });

  it("🔴 修复轮 2(①):conflict 档的「更多」菜单里,贡献更改/分享改动同样要过 shareBlocked 这道闸(正反对照)", async () => {
    // 正例:conflict + 本地改过 + 合格 → 菜单里有「贡献更改」,点击真的调
    // skill_share_changes(与主按钮那条 conflict 链路互不冲突,是"更多"里的
    // 另一条路)。
    const list = [mk("a", "installedFrom", { remote: "NEW", localModified: true })];
    seed(list);
    // 🔴 覆写 invoke 时不能读 `useMySkills.getState().list` 回填
    // `installed_list`——首次 `load()` 落地之前那份状态还是初值 `null`,会喂出
    // 一个空列表(本项目记着的既有教训:注入过一次几乎一样的时序 bug)。
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return stripFixtureOnly(list);
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "store_index") return companyIndex(list);
      if (cmd === "skill_share_changes")
        return { kind: "submitted", mode: "pushed", commitSha: "new" };
      return null;
    });
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "贡献更改" }));
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share_changes")).toBe(true),
    );
  });

  it("🔴 修复轮 2(①反例):conflict + 本地改过 + 标准校验不过 → 「更多」菜单里没有贡献更改/分享改动", async () => {
    // C1 在主按钮那一侧堵上了"不合规内容也能推去评审"这个洞;这里补上
    // 「更多」菜单那一侧的同款反例——不合规时这条动作不该从另一个入口冒出来。
    seed([
      mk("a", "installedFrom", { remote: "NEW", localModified: true, shareBlocked: "nameFormat" }),
    ]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.queryByRole("menuitem", { name: "贡献更改" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "分享改动" })).toBeNull();
  });

  it("🔴 修复轮 2(③):「更多」菜单里「移除」永远排最后,且与前面的动作有一条分隔线", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW", localModified: true })]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));

    const items = screen.getAllByRole("menuitem");
    expect(items[items.length - 1]).toHaveTextContent("移除");
    // 分隔线只在"移除"前面有别的动作时才画——它的 className 里带 border-t
    expect(items[items.length - 1].className).toContain("border-t");
  });

  it("sharedTo:本地改过、库没变 → 「分享改动」", async () => {
    seed([mk("a", "sharedTo", { localModified: true })]);
    await renderAtTab(/已分享到技能库/);
    expect(await screen.findByRole("button", { name: "分享改动" })).toBeInTheDocument();
  });

  it("shareable:标准校验没过 → 禁用的「分享」+ 一句人话说清哪不合格", async () => {
    seed([mk("a", "shareable", { shareBlocked: "nameMismatch" })]);
    await renderAtTab(/可分享到技能库/);
    const btn = await screen.findByRole("button", { name: "分享" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/团队标准要求两者相同/)).toBeInTheDocument();
  });

  it("🔴 C1:安装自区本地改了但标准校验不过 → 禁用的「贡献更改」+ 说明,不能直推不合规内容", async () => {
    seed([mk("a", "installedFrom", { localModified: true, shareBlocked: "nameFormat" })]);
    render(<MySkillsPage />);
    const btn = await screen.findByRole("button", { name: "贡献更改" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/只能用英文小写字母、数字和短横线/)).toBeInTheDocument();
  });

  it("🔴 C1:已分享到区本地改了但标准校验不过 → 禁用的「分享改动」+ 说明", async () => {
    seed([mk("a", "sharedTo", { localModified: true, shareBlocked: "descriptionMissing" })]);
    await renderAtTab(/已分享到技能库/);
    const btn = await screen.findByRole("button", { name: "分享改动" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/分享前请在 SKILL\.md 里补上 description/)).toBeInTheDocument();
  });

  // 🔴 v8 任务 3 / D8:没有写权限 → 主按钮禁用 + 一句说明,「打开文件夹」仍在。
  // 三处渲染点之一(另两处:详情面板动作区、分享确认屏)。
  it("🔴 D8:只读用户的「分享」是禁用的,并说清为什么,「打开文件夹」仍在", async () => {
    seed([mk("a", "shareable")]);
    // 🔴 走真实路径:页面挂载会自己 `refreshPreview()`,直接 setState 会被那一跳
    // 盖掉(第一版就是这么假红的)。禁用态的数据来源必须是 core 真的回了 noAccess。
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args?: unknown) =>
      cmd === "share_preview" ? "noAccess" : base(cmd, args),
    );
    await renderAtTab(/可分享到技能库/);
    const btn = await screen.findByRole("button", { name: "分享" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/没有写入权限/)).toBeInTheDocument();
    const row = screen.getByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.getByRole("menuitem", { name: "打开文件夹" })).toBeInTheDocument();
  });

  // 对照组同样走真实路径:`seed` 的默认 mock 就让 share_preview 回 unknown。
  it("对照组:探不到(unknown)时「分享」照常可点——预检永远 fail-open", async () => {
    seed([mk("a", "shareable")]);
    await renderAtTab(/可分享到技能库/);
    expect(await screen.findByRole("button", { name: "分享" })).toBeEnabled();
    expect(screen.queryByText(/没有写入权限/)).not.toBeInTheDocument();
  });

  it("🔴 修复轮 2(④/M3):shareable 区外源行的来源标签是等宽字体(design §6)", async () => {
    seed([
      mk("a", "shareable", { sourceLabel: "vercel-labs/agent-skills" }),
    ]);
    await renderAtTab(/可分享到技能库/);
    const label = await screen.findByText("来源 vercel-labs/agent-skills");
    expect(label.className).toContain("font-mono");
  });

  it("🔴 shareable:有外部来源且外源有新版 → 「更新」是主按钮,「分享」退进「更多」", async () => {
    const skill = mk("a", "shareable", {
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "agent-skills",
      sourceLabel: "vercel-labs/agent-skills",
      contentHash: "sha256:old",
    });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
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
          skills: [
            {
              name: "React 最佳实践",
              dirSlug: "a",
              description: "Vercel 出品的性能与写法指南。",
              path: "",
              hasScripts: false,
              fileCount: 1,
              contentHash: "sha256:new",
              tags: [],
              author: null,
            },
          ],
        };
      }
      return null;
    });
    await renderAtTab(/可分享到技能库/);

    // 🔴 I3(用户拍板):翻开页面本身不发请求——这一行的外源指纹还没探过,
    // 主按钮此刻只能是「分享」,展示名也只能退回 dirSlug。
    expect(await screen.findByRole("button", { name: "分享" })).toBeInTheDocument();
    expect(screen.queryByText("React 最佳实践")).toBeNull();

    // 点开详情是"点击立即查"那一半的触发点,查完这一行的主按钮才会变成「更新」。
    await userEvent.click(screen.getByTestId("row-a-body"));

    expect(await screen.findByRole("button", { name: "更新" })).toBeInTheDocument();
    expect(screen.getByText("React 最佳实践")).toBeInTheDocument();
    expect(screen.getByText("Vercel 出品的性能与写法指南。")).toBeInTheDocument();
    // 🔴 I4:展示名与 dirSlug 刻意不同值,查完之后内部目录名不该再上屏
    // ——本项目已经踩过两次"internal id 漏给用户"(安装结果文案、冲突弹窗标题)。
    expect(screen.queryByText("a")).toBeNull();

    const row = screen.getByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.getByRole("menuitem", { name: "分享" })).toBeInTheDocument();
  });
});

describe("I4:展示名与 dirSlug 刻意取不同值,内部目录名不许漏到界面上", () => {
  it("installedFrom/sharedTo 区同样按公司库索引的展示名渲染,不是 dirSlug 本身", async () => {
    // 🔴 复审指出的真实缺口:此前 companyIndex() 的 fixture 让 `name` 恒等于
    // `dirSlug`("a" 展示出来也是"a"),这条守卫因此测不出"万一哪天不小心把
    // dirSlug 当展示名渲染"这类回归——两个概念取同值,它们的差别就测没了。
    const skill = mk("weekly-report", "installedFrom");
    const index = {
      ...companyIndex([skill]),
      skills: [{ ...companyIndex([skill]).skills[0]!, name: "周报生成" }],
    };
    useStoreIndex.setState({ index });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "store_index") return index;
      return null;
    });
    render(<MySkillsPage />);

    await screen.findByText("周报生成");
    expect(screen.queryByText("weekly-report")).toBeNull();
    // data-testid 走 dirSlug 是内部寻址,不是给用户看的,不受这条约束
    expect(screen.getByTestId("row-weekly-report")).toBeInTheDocument();
  });
});

describe("页头「全部更新」的失败要有渲染点", () => {
  it("部分失败:摆出来 + 知道了能关掉", async () => {
    const list = [mk("a", "installedFrom", { remote: "NEW" }), mk("c", "installedFrom", { remote: "NEW" })];
    seed(list);
    // seed() 已经把 installed_list/agents_detected/store_index 接好了,这里只
    // 追加 skill_install_batch 的响应——覆写整个 mockImplementation 而不是
    // 读回 useMySkills.getState().list:那份状态在第一次 load() 跑到之前还是
    // 初值 null,读回来会在挂载最初那一刻喂出一个空列表。
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return stripFixtureOnly(list);
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "store_index") return companyIndex(list);
      if (cmd === "skill_install_batch") {
        return [
          { dirSlug: "a", outcome: "installed", report: {} },
          { dirSlug: "c", outcome: "failed", error: { code: "NET_TIMEOUT", message: "网络超时" } },
        ];
      }
      return null;
    });
    render(<MySkillsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "全部更新 · 2" }));

    expect(await screen.findByText(/有 1 个技能没能更新/)).toBeInTheDocument();
    expect(screen.getByText(/网络超时/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.queryByText(/网络超时/)).toBeNull();
  });
});

describe("搜索(v7 任务 7:搜展示名/dirSlug/来源都要搜得到)", () => {
  it("🔴 搜展示名——页面显示的就是这个字,搜它必须搜得到", async () => {
    const skill = mk("weekly-report", "installedFrom");
    const index = {
      ...companyIndex([skill]),
      skills: [{ ...companyIndex([skill]).skills[0]!, name: "周报生成" }],
    };
    useStoreIndex.setState({ index });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "store_index") return index;
      return null;
    });
    render(<MySkillsPage />);
    await screen.findByText("周报生成");

    // 🔴 `act` 是必须的:v7.3 起进入搜索态会把整棵列表子树换成"按栏分组"的
    // 另一种结构,React 会**重建**那些 DOM 节点。不裹 act 的话 `findByText`
    // 可能在旧树被替换掉之前就匹配上,拿回一个随即脱离文档的节点
    // ——断言失败的原因与被测命题无关,是测试自己的时序问题。
    act(() => useMineSearch.getState().setQuery("周报"));
    expect(await screen.findByText("周报生成")).toBeInTheDocument();

    act(() => useMineSearch.getState().setQuery("不存在的技能"));
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
    expect(screen.queryByText("周报生成")).toBeNull();
  });
});

describe("移除只在本体在这台电脑上时才摆", () => {
  it("localPresent 为 false 的行:主按钮是「取回」,没有本体也没有「更多」可摆", async () => {
    // 本体不在(取回之前)+ 没有可打开的文件夹路径 = 「更多」菜单空空如也,
    // 按「不摆比摆一个没有意义的东西好」这条既定取舍,SkillRowMenu 索性不渲染。
    seed([mk("a", "sharedTo", { localPresent: false, body: "" })]);
    await renderAtTab(/已分享到技能库/);
    const row = await screen.findByTestId("row-a");
    expect(within(row).getByRole("button", { name: "取回" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /更多/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
  });

  it("🔴 localPresent 为 false 的行点开详情:从技能库取内容,不读本地(换电脑场景,2026-09-14 真机)", async () => {
    seed([mk("a", "sharedTo", { localPresent: false, body: "", sourceOwner: "skills", sourceRepo: "skills" })]);
    await renderAtTab(/已分享到技能库/);
    await userEvent.click(await screen.findByTestId("row-a-body"));
    await waitFor(() => expect(lastInvoke("store_skill_detail")?.args).toMatchObject({ dirSlug: "a", registryId: "company", repo: "skills/skills" }));
    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_local_detail")).toBe(false);
  });

  it("正反对照:本地有本体的行点开详情照旧读本地", async () => {
    seed([mk("a", "sharedTo")]);
    await renderAtTab(/已分享到技能库/);
    await userEvent.click(await screen.findByTestId("row-a-body"));
    await waitFor(() => expect(lastInvoke("skill_local_detail")?.args).toMatchObject({ path: "/h/.agents/skills/a" }));
    expect(invoke.mock.calls.some(([cmd]) => cmd === "store_skill_detail")).toBe(false);
  });

  it("localPresent 为 true:「移除」在「更多」里,`localPresent` 为 false 时消失(正反对照)", async () => {
    seed([mk("a", "sharedTo")]);
    await renderAtTab(/已分享到技能库/);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.getByRole("menuitem", { name: "移除" })).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// C2(复审打回):错误 / 结果的渲染点。这批测试在整页重写那一笔提交里连同旧的
// ToolFailuresBanner 内联代码一起被删掉了,复审指出"重写一段代码同时删掉它
// 全部行为测试"本身就是危险信号——R30(`skill_reveal` 被守卫拒掉的沉默缺陷)
// 是这个项目已经吃过一次亏、明确记名要守住的场景,新抽出的 `ToolFailuresBanner`
// 组件此前是**零测试**地上线的。
// ---------------------------------------------------------------------------

describe("勾选工具的失败必须看得见(C2 补充覆盖)", () => {
  it("core 报的部分失败逐条摆出来,agent 名换成展示名,不漏内部标识", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        agentNames: new Map([["claude-code", "Claude Code"], ["trae", "Trae"]]),
        toolFailures: [
          { kind: "failed", agent: "claude-code", message: "那个位置已有同名文件夹" },
          { kind: "failed", agent: null, message: "统一目录没能收敛" },
        ],
      });
    });

    await screen.findByText(/有 2 处没能完成/);
    expect(screen.getByText(/Claude Code：那个位置已有同名文件夹/)).toBeInTheDocument();
    expect(screen.getByText("统一目录没能收敛")).toBeInTheDocument();
    expect(screen.queryByText(/claude-code：/)).toBeNull();
  });

  it("🔴 differs 说的是另一句话(占位不是失败),并给出「打开文件夹」这条出口", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        agentNames: new Map([["trae", "Trae"]]),
        toolFailures: [{ kind: "differs", agent: "trae", existing: "/h/.trae/skills/a" }],
      });
    });

    await screen.findByText(/Trae 那个位置上已经有一份内容不同的技能,没有覆盖它。/);
    await userEvent.click(screen.getByRole("button", { name: "打开 Trae 那个位置的文件夹" }));
    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_reveal");
    expect(call?.[1].args).toEqual({ path: "/h/.trae/skills/a" });
  });

  it("🔴 R30:打开文件夹被守卫拒掉时必须说出来,绝不静默", async () => {
    // `skill_reveal` 的守卫是「必须是目录、且目录下有 SKILL.md」,而 differs 给的
    // `existing` 两条都不保证——吞掉失败的话用户点了什么反应都没有,是这个项目
    // 记过名的「前端全对却没反应」那一类,零痕迹、最难排查。
    const skill = mk("a", "installedFrom");
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_reveal")
        throw { code: "FS_NOT_A_SKILL", message: "这个文件夹不是技能,或技能描述文件缺失" };
      return null;
    });
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        agentNames: new Map([["trae", "Trae"]]),
        toolFailures: [{ kind: "differs", agent: "trae", existing: "/h/.trae/skills/a" }],
      });
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "打开 Trae 那个位置的文件夹" }),
    );

    await screen.findByText(/打不开那个文件夹/);
    expect(screen.getByText(/这个文件夹不是技能,或技能描述文件缺失/)).toBeInTheDocument();
  });

  it("失败框里的「打开文件夹」带工具名,与行内那个区分得开(不同的可访问名)", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        agentNames: new Map([["trae", "Trae"]]),
        toolFailures: [{ kind: "differs", agent: "trae", existing: "/h/.trae/skills/a" }],
      });
    });

    await screen.findByRole("button", { name: "打开 Trae 那个位置的文件夹" });
    // 行内那个走「更多」菜单,menuitem 是朴素的「打开文件夹」,两者不同名
    const row = screen.getByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.getByRole("menuitem", { name: "打开文件夹" })).toBeInTheDocument();
  });

  it("🔴 标题分流:全是 differs 说「需要你看一下」,含真失败说「没能完成」", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");

    act(() => {
      useMySkills.setState({
        agentNames: new Map([["trae", "Trae"]]),
        toolFailures: [{ kind: "differs", agent: "trae", existing: "/x" }],
      });
    });
    await screen.findByText(/有 1 处需要你看一下/);

    act(() => {
      useMySkills.setState({
        toolFailures: [
          { kind: "differs", agent: "trae", existing: "/x" },
          { kind: "failed", agent: "cursor", message: "cursor 没配上" },
        ],
      });
    });
    await screen.findByText(/有 2 处没能完成/);
  });

  it("按位置报的失败:路径与原因都摆出来,标题算「没能完成」(location 档)", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        toolFailures: [
          { kind: "location", path: "/h/.trae/skills/a", message: "移到废纸篓失败" },
        ],
      });
    });

    await screen.findByText(/有 1 处没能完成/);
    expect(screen.getByText("/h/.trae/skills/a")).toBeInTheDocument();
    expect(screen.getByText(/移到废纸篓失败/)).toBeInTheDocument();
  });

  it("统一目录那一档没有 agent 名,用一句人话顶上,不留空", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        toolFailures: [{ kind: "differs", agent: null, existing: "/h/.agents/skills/a" }],
      });
    });
    await screen.findByText(/统一技能目录 那个位置上已经有一份内容不同的技能/);
  });

  it("有归属(setAgents 来源)时,横幅点名是哪个技能", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        agentNames: new Map([["trae", "Trae"]]),
        toolFailures: [{ kind: "differs", agent: "trae", existing: "/x" }],
        toolFailuresFor: "a",
      });
    });
    await screen.findByText(/「a」有 1 处需要你看一下/);
  });

  it("setAgentsError 同样点名归属技能", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        setAgentsError: { code: "FS_LINK_FAILED", message: "统一目录那一处没配上" },
        toolFailuresFor: "a",
      });
    });
    await screen.findByText(/没能改动「a」的 AI 工具启用状态/);
  });

  it("没有归属(remove/keepVersion 来源,toolFailuresFor 为 null)时不点名,零回归", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        toolFailures: [
          { kind: "location", path: "/h/.trae/skills/a", message: "移到废纸篓失败" },
        ],
        toolFailuresFor: null,
      });
    });
    await screen.findByText(/有 1 处没能完成/);
    expect(screen.queryByText(/「a」/)).not.toBeInTheDocument();
  });
});

describe("「取回」与「以本地为准分享」失败必须在这一页看得见(C2 补充覆盖)", () => {
  it("🔴 pullFailed:取回失败不能转一下就没了下文", async () => {
    const skill = mk("a", "sharedTo", { localPresent: false, body: "", agents: [] });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_install")
        throw { code: "NET_TIMEOUT", message: "连不上公司技能库,请确认已接入内网" };
      return null;
    });
    await renderAtTab(/已分享到技能库/);

    await userEvent.click(await screen.findByRole("button", { name: "取回" }));

    expect(await screen.findByText(/连不上公司技能库/)).toBeInTheDocument();
  });

  it("installShareResult:失败要看得见——那条路的结果只写进 useInstall.shareResult", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useInstall.setState({
        shareResult: { error: { code: "NET_TIMEOUT", message: "连不上公司技能库" } },
      });
    });
    await screen.findByText(/连不上公司技能库/);
  });

  it("installShareResult:成功时同样有回执", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useInstall.setState({ shareResult: { mode: "pushed" } });
    });
    await screen.findByText("改动已分享到公司技能库。");
  });

  it("拍板框已经关掉之后再失败,keepError 也要有落点(M-2)", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    act(() => {
      useMySkills.setState({
        versionChoice: null,
        keepError: { code: "FS_TASK", message: "保留所选版本失败,请重试" },
      });
    });
    expect(await screen.findByText(/保留所选版本失败/)).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// 补充覆盖(复审列出的 22 条覆盖丢失里价值较高的几条):空列表 CTA、读取失败
// 重试、「打开文件夹」的参数形状、chooseVersion 档、两个徽标、CreateSkill 的
// 真实 UI 通道。
// ---------------------------------------------------------------------------

describe("空列表与读取失败(补充覆盖)", () => {
  it("空列表:「去技能商店」真的切页,不是摆设", async () => {
    useUi.setState({ page: "mine" });
    seed([]);
    render(<MySkillsPage />);
    await screen.findByText("这台电脑上还没有技能");

    await userEvent.click(screen.getByRole("button", { name: "去技能商店" }));

    expect(useUi.getState().page).toBe("store");
  });

  it("🔴 读取失败要正面说,不能画成空状态;重试按钮真的重新发请求", async () => {
    let calls = 0;
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") {
        calls += 1;
        if (calls === 1) throw { code: "IO_FAILED", message: "磁盘读取失败" };
        return [];
      }
      if (cmd === "agents_detected") return AGENT_LIST;
      return null;
    });
    render(<MySkillsPage />);

    expect(await screen.findByText(/读取已获取的技能失败/)).toBeInTheDocument();
    expect(screen.getByText(/磁盘读取失败/)).toBeInTheDocument();
    // 失败不能被画成"你还没装任何技能"那句空状态文案
    expect(screen.queryByText("这台电脑上还没有技能")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "重试" }));

    await screen.findByText("这台电脑上还没有技能");
    expect(calls).toBe(2);
  });
});

describe("「打开文件夹」传 body 绝对路径,不传 dirSlug(补充覆盖)", () => {
  it("行内「更多」菜单的打开文件夹带的是 skill.body,不是 dirSlug", async () => {
    const skill = mk("a", "installedFrom", { body: "/h/.claude/skills/a" });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_reveal") return null;
      return null;
    });
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "打开文件夹" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_reveal");
    expect(call?.[1].args).toEqual({ path: "/h/.claude/skills/a" });
    expect(call?.[1].args).not.toHaveProperty("dirSlug");
  });
});

describe("C3(v7 任务 7 修复轮 1):「改用库里的版本」——没有安装基线时的唯一出口", () => {
  it("🔴 没有基线 + 本体与库里内容不同 → 「更多」菜单里有「改用库里的版本」,点击复用既有 pull", async () => {
    // 典型场景:作者绕过 app 直接 git 推库,又在本地(比如 Claude Code 里)改了
    // 本体——core 对这种行恒填 contentHash: ""(没有安装基线),rowAction 因此
    // 判成 none,页面此前一个字都不说。
    const skill = mk("weekly-report", "sharedTo", {
      contentHash: "",
      localHash: "sha256:local-now",
    });
    const index = {
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
        {
          name: "weekly-report",
          dirSlug: "weekly-report",
          description: "",
          path: "",
          hasScripts: false,
          fileCount: 1,
          contentHash: "sha256:library-now",
          tags: [],
          author: null,
          updatedAt: { kind: "unknown" } as const,
        },
      ],
    };
    useStoreIndex.setState({ index });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_install")
        return { outcome: "installed", report: { dirName: "weekly-report", canonicalDir: "/c", links: [] }, localKept: false, lock: "written" };
      return null;
    });
    await renderAtTab(/已分享到技能库/);
    const row = await screen.findByTestId("row-weekly-report");

    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "改用库里的版本" }));

    // 复用既有 pull(beginUpdate):不新造一层确认,core 的预检自己会拦下来问用户
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_install")).toBe(true),
    );
  });

  it("没有基线但两方内容其实一样 → 不摆这一项", async () => {
    const skill = mk("weekly-report", "sharedTo", {
      contentHash: "",
      localHash: "sha256:same",
    });
    const index = {
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
        {
          name: "weekly-report",
          dirSlug: "weekly-report",
          description: "",
          path: "",
          hasScripts: false,
          fileCount: 1,
          contentHash: "sha256:same",
          tags: [],
          author: null,
          updatedAt: { kind: "unknown" } as const,
        },
      ],
    };
    useStoreIndex.setState({ index });
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      return null;
    });
    await renderAtTab(/已分享到技能库/);
    const row = await screen.findByTestId("row-weekly-report");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.queryByRole("menuitem", { name: "改用库里的版本" })).toBeNull();
  });
});

describe("chooseVersion 档(补充覆盖:此前整页零测试覆盖)", () => {
  it("有几份版本时,主按钮是「选择保留哪一份」,点击开出版本拍板框、不摆其余动作", async () => {
    const V = (path: string) => ({
      path,
      modifiedAt: "2026-08-01T00:00:00.000Z",
      files: 1,
      contentHash: `h-${path}`,
    });
    seed([
      mk("a", "installedFrom", {
        versions: [V("/p1"), V("/p2")],
        localModified: true, // 即便同时满足别的判据,versions 也压过一切
      }),
    ]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");

    const button = within(row).getByRole("button", { name: "选择保留哪一份" });
    expect(button).toBeInTheDocument();
    // 其余按 localModified 本该出现的「贡献更改」不该同时出现
    expect(within(row).queryByRole("button", { name: "贡献更改" })).toBeNull();

    await userEvent.click(button);

    expect(useMySkills.getState().versionChoice).toEqual({
      dirSlug: "a",
      versions: [V("/p1"), V("/p2")],
    });
  });

  it("有几份版本时,「更多」菜单里不摆「移除」——拿哪一份去移无从谈起", async () => {
    const V = (path: string) => ({
      path,
      modifiedAt: "2026-08-01T00:00:00.000Z",
      files: 1,
      contentHash: `h-${path}`,
    });
    seed([mk("a", "installedFrom", { versions: [V("/p1"), V("/p2")] })]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: /更多/ }));
    expect(screen.queryByRole("menuitem", { name: "移除" })).toBeNull();
  });
});

describe("两个徽标(补充覆盖)", () => {
  it("来源已移除:徽标 + 悬浮说明", async () => {
    seed([mk("a", "installedFrom", { sourceRemoved: true })]);
    render(<MySkillsPage />);
    const badge = await screen.findByText("来源已移除");
    expect(badge).toHaveAttribute("title", expect.stringContaining("这个技能的来源已不在来源列表中"));
  });

  it("技能库不在列表中:徽标 + 悬浮说明", async () => {
    seed([mk("a", "installedFrom", { libraryRemoved: true })]);
    render(<MySkillsPage />);
    const badge = await screen.findByText("技能库不在列表中");
    expect(badge).toHaveAttribute("title", expect.stringContaining("来源服务器还在"));
  });

  it("正常行没有任何徽标", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    expect(screen.queryByText("来源已移除")).toBeNull();
    expect(screen.queryByText("技能库不在列表中")).toBeNull();
  });
});

describe("新建技能(补充覆盖:CreateSkill 的 UI 通道,不是只断言渲染了)", () => {
  it("🔴 真的点得开、填得完、提交得出去", async () => {
    const skill = mk("a", "installedFrom");
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return [skill];
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "skill_create") return { dirSlug: "my-notes", path: "/h/.agents/skills/my-notes" };
      return null;
    });
    render(<MySkillsPage />);
    await screen.findByText("a");

    await userEvent.click(screen.getByRole("button", { name: "新建技能" }));
    await screen.findByText("新建一个技能");
    expect(screen.queryByRole("button", { name: "新建技能" })).toBeNull();

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
    await screen.findByText("/h/.agents/skills/my-notes");
  });

  it("空态也有「新建技能」,同样点得开", async () => {
    seed([]);
    render(<MySkillsPage />);
    await screen.findByText("这台电脑上还没有技能");
    await userEvent.click(screen.getByRole("button", { name: "新建技能" }));
    await screen.findByText("新建一个技能");
  });
});

// ---------------------------------------------------------------------------
// v7 任务 8:「项目里」页签(页签壳本身在任务 7 就已经建好——TabsRow + 默认
// general + projects 档渲染 ProjectSections,这里只补 brief Step 1 那条
// 之前没有测试覆盖过的集成用例)。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v7.3 Q19-C(总数挪出页签)+ Q20-A(纯间距分块)
// ---------------------------------------------------------------------------

describe("v7.3 Q19-C + Q27-A:两块区域两种口径(页签行=跨栏,列表上方=本栏)", () => {
  /** 类名断言一律**按空白切成 token 逐个比**,不用 `toContain` 子串——
   *  `gap-1` 是 `gap-1.5` 的子串,`bg-accent` 是 `bg-accent-soft` 的子串,
   *  子串匹配在这两处都会给出恒真的假绿(本项目记的形态断言空转)。 */
  const tokens = (el: Element) => (el.className ?? "").split(/\s+/).filter(Boolean);

  it("🔴 页签的可见文字里一个数字都没有(总数已挪走,要处理数在角标那颗按钮上)", async () => {
    seed([
      mk("a", "installedFrom"),
      mk("b", "installedFrom"),
      mk("c", "installedFrom", { remote: "NEW" }),
    ]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    for (const el of screen.getAllByRole("tab")) {
      expect(el.textContent ?? "").not.toMatch(/\d/);
    }
    // 而那个"要处理"的数仍然在角标上(它没被一起删掉)
    expect(screen.getByTestId("tab-badge-installedFrom")).toHaveTextContent("1");
  });

  it("🔴 总数落在列表上方那一行,不在页签行", async () => {
    seed([mk("a", "installedFrom"), mk("b", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    const total = await screen.findByTestId("mine-total");
    expect(total).toHaveTextContent("共 2 个技能");
    // 结构断言:它在本栏那一行里,而**不在**页签行里
    expect(screen.getByTestId("mine-section-bar")).toContainElement(total);
    expect(screen.getByTestId("mine-tabs-row")).not.toContainElement(total);
  });

  /** 🔴 Q27-A 的核心约束,**结构**断言不是文字断言。判据一句话:页签行是跨栏
   *  区域、列表上方是本栏区域。所以:
   *  - 整页口径的「全部更新 · N」必须在页签行里、**不在**本栏那一行里
   *    (在后者就等于在「可分享到」栏下说一句关于另外两栏的话——这正是第 6/7 轮
   *    留下的那个缺陷);
   *  - 本栏口径的总数反过来。
   *  两个方向都钉住,任一侧被挪回去都必红。 */
  it("🔴 整页口径的「全部更新」在页签行里,不在本栏那一行里", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW" }), mk("b", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    const updateAll = screen.getByRole("button", { name: "全部更新 · 1" });
    expect(screen.getByTestId("mine-tabs-row")).toContainElement(updateAll);
    expect(screen.getByTestId("mine-section-bar")).not.toContainElement(updateAll);
    // 反向:本栏口径的总数在本栏那一行里、不在页签行里
    const total = screen.getByTestId("mine-total");
    expect(screen.getByTestId("mine-section-bar")).toContainElement(total);
    expect(screen.getByTestId("mine-tabs-row")).not.toContainElement(total);
  });

  /** 🔴 总数是**恒有**的信息,不能依赖"有没有事要做"。fixture 刻意零更新
   *  ——「全部更新」那颗按钮整个不渲染,而总数照样得在。 */
  it("🔴 没有任何可一键更新的行时(按钮不渲染),总数照样在", async () => {
    seed([mk("a", "installedFrom"), mk("b", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    expect(screen.queryByRole("button", { name: /全部更新/ })).toBeNull();
    expect(screen.getByTestId("mine-total")).toHaveTextContent("共 2 个技能");
  });

  it("总数跟着页签走:切到另一个页签,报的是那一栏的条数", async () => {
    seed([mk("a", "installedFrom"), mk("b", "installedFrom"), mk("c", "sharedTo")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    expect(screen.getByTestId("mine-total")).toHaveTextContent("共 2 个技能");
    await userEvent.click(screen.getByRole("tab", { name: /已分享到技能库/ }));
    expect(screen.getByTestId("mine-total")).toHaveTextContent("共 1 个技能");
  });

  /** 空页签那一档不摆总数:下面已经是空态文案,「共 0 个技能」纯属噪音。 */
  it("空页签不摆总数", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    await userEvent.click(screen.getByRole("tab", { name: /已分享到技能库/ }));
    expect(screen.queryByTestId("mine-total")).toBeNull();
  });

  /** 搜索态列表是**跨栏**命中、页签行也整行让位了,"共 N 个技能"指谁都不对,
   *  所以整行不摆(「全部更新」也随页签行一并让位,与「新建技能」同款)。 */
  it("搜索态不摆总数,「全部更新」也随页签行一并让位", async () => {
    seed([mk("alpha", "installedFrom"), mk("beta", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-alpha");
    act(() => useMineSearch.getState().setQuery("alpha"));
    expect(screen.queryByTestId("mine-total")).toBeNull();
    expect(screen.queryByTestId("mine-section-bar")).toBeNull();
    expect(screen.queryByRole("button", { name: /全部更新/ })).toBeNull();
  });

  /** 🔴 Q29-B:筛选态提示与总数**同一行**——那一行的语义是"关于当前这一栏的话",
   *  筛选态正是其中一句。此前它悬在列表上方、没有归属。 */
  it("🔴 筛选态提示与总数并在同一行(都是本栏口径)", async () => {
    seed([mk("quiet", "installedFrom"), mk("hot", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-quiet");
    await userEvent.click(screen.getByTestId("tab-badge-installedFrom"));
    const bar = screen.getByTestId("mine-section-bar");
    expect(bar).toContainElement(screen.getByTestId("mine-total"));
    expect(bar).toHaveTextContent("只看要处理的");
    expect(bar).toContainElement(screen.getByRole("button", { name: "显示全部" }));
    // 筛选态开着,总数照样报全量(它写的是事实,不是展示条数)
    expect(screen.getByTestId("mine-total")).toHaveTextContent("共 2 个技能");
  });

  it("🔴 Q20-A:页签内部(名字↔角标)的间距必须明显紧于页签之间", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW" }), mk("c", "sharedTo")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    const list = screen.getByRole("tablist");
    // 页签**之间** = 20px
    expect(tokens(list)).toContain("gap-5");
    // 页签**内部** = 4px。容器是那颗 role="tab" 的父节点(role="presentation")。
    const inner = screen.getByRole("tab", { name: /安装自技能库/ }).parentElement;
    expect(inner).not.toBeNull();
    expect(tokens(inner!)).toContain("gap-1");
    // 🔴 判据是"内外不同",不是"各自等于某个值":两边一样大时眼睛就把六个元素
    // 等距切成六块,这正是用户报的现象。所以正面断言它们不相等。
    expect(tokens(inner!)).not.toContain("gap-5");
    expect(tokens(list)).not.toContain("gap-1");
  });

  it("🔴 Q20-A 不引入新视觉元素:页签之间没有分隔线,未激活页签没有底色", async () => {
    seed([mk("a", "installedFrom"), mk("c", "sharedTo")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");
    const inactive = screen.getByRole("tab", { name: /已分享到技能库/ }).parentElement!;
    const cls = tokens(inactive);
    expect(cls).not.toContain("bg-accent-soft");
    expect(cls.filter((c) => c.startsWith("border-l") || c.startsWith("divide-"))).toEqual([]);
  });
});

describe("v7.3 需求 1:「项目里」已经不在这一行", () => {
  // 它挪进了左侧边栏(「项目里的技能」,入口与切页由 `Sidebar.test.tsx` 钉住)。
  // 这里只钉**这一页不再有那个页签**——留着就是同一个东西两个入口。
  it("页签里没有「项目里」,只剩三个与公司技能库有关的页签", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: /项目里/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 三个并列页签(v7.2 需求 1:三区改页签;v7.3 需求 1:「项目里」挪进侧边栏)
// ---------------------------------------------------------------------------

describe("页签", () => {
  /** 页签是 `<button role="tab">`,可访问名 = 可见文字(v7.3 Q19-C 起**只有区名**),
   *  所以按区名的子串去找。 */
  const tab = (name: RegExp) => screen.getByRole("tab", { name });

  it("三个页签并列;默认落在「安装自技能库」,只渲染这一区的行", async () => {
    seed([mk("a", "installedFrom"), mk("c", "sharedTo"), mk("d", "shareable")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((e) => e.textContent?.replace(/\s+/g, ""))).toEqual([
      "安装自技能库",
      "已分享到技能库",
      "可分享到技能库",
    ]);
    expect(tab(/安装自技能库/)).toHaveAttribute("aria-selected", "true");
    // 🔴 一次只看一个区:另外两个区的行**不在 DOM 里**(不是 hidden)
    expect(screen.queryByTestId("row-c")).toBeNull();
    expect(screen.queryByTestId("row-d")).toBeNull();
  });

  it("点另一个页签就切过去", async () => {
    seed([mk("a", "installedFrom"), mk("c", "sharedTo")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    await userEvent.click(tab(/已分享到技能库/));
    expect(screen.getByTestId("row-c")).toBeInTheDocument();
    expect(screen.queryByTestId("row-a")).toBeNull();
    expect(tab(/已分享到技能库/)).toHaveAttribute("aria-selected", "true");
  });

  // 🔴 这条是从 v7.1 分区折叠继承下来的那条原则的落点:一次只看一个区,
  // 另外两个区里等着你的事必须在页签上写出来,否则它们整个看不见。
  it("🔴 **未选中**的页签也写「N 个要处理」,含页头总览数不到的档(冲突 / 留哪一份)", async () => {
    seed([
      mk("y", "installedFrom", { remote: "NEW" }), // update(页头总览数得到的唯一一档)
      mk("b", "sharedTo", { remote: "NEW" }), // conflict
      mk("c", "sharedTo", { remote: "NEW", localModified: true }), // conflict
      mk("d", "sharedTo", {
        versions: [
          { path: "/h/.claude/skills/d", modifiedAt: "2026-08-01T00:00:00Z", files: 1, contentHash: "sha256:x" },
          { path: "/h/.agents/skills/d", modifiedAt: "2026-08-01T00:00:00Z", files: 1, contentHash: "sha256:y" },
        ],
      }), // chooseVersion
    ]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-y")).toBeInTheDocument();
    // 当前页签是「安装自」,「已分享到」一行都没渲染出来——但它的计数照样在
    const shared = tab(/已分享到技能库/);
    expect(shared).toHaveAttribute("aria-selected", "false");
    // 🔴 v7.3 需求 2:要处理的数字搬到**角标**那颗独立按钮上(页签自己只写
    // 名字 + 弱色总数),角标靠 `aria-label` 说清它是什么、点了会怎样。
    expect(screen.getByTestId("tab-badge-sharedTo")).toHaveTextContent("3");
    expect(screen.getByTestId("tab-badge-sharedTo")).toHaveAccessibleName(
      "只看「已分享到技能库」里要处理的 3 个",
    );
    // 「全部更新 · 1」只认得出 1 个能一键更新的行(那一档在当前页签里),而
    // 「已分享到」区另有 3 行需要用户动手、一行都没渲染出来——页签角标是它们
    // 唯一的出口(这正是 Q28-C 撤掉整页汇总文字、保留逐栏角标的理由)
    expect(screen.getByRole("button", { name: "全部更新 · 1" })).toBeInTheDocument();
    expect(screen.getByTestId("tab-badge-installedFrom")).toHaveTextContent("1");
  });

  it("「可分享到」区的草稿不算「要处理」(那是该区的常态)", async () => {
    seed([mk("draft", "shareable"), mk("other", "shareable")]);
    render(<MySkillsPage />);
    await screen.findByRole("tab", { name: /可分享到技能库/ });
    // 总数在列表上方那一行(v7.3 Q27-A),看那一栏的数要先切过去
    await userEvent.click(tab(/可分享到技能库/));
    expect(screen.getByTestId("mine-total")).toHaveTextContent("共 2 个技能");
    // 常态不是"要处理",所以这一档根本没有角标那颗按钮
    expect(screen.queryByTestId("tab-badge-shareable")).toBeNull();
  });

  // 🔴 这两个数走**全量** list,不走展示层筛过的那一份:它们写的是
  // "这个区一共有多少 / 其中几个要处理"这件**事实**。筛选态开着时列表只剩
  // 1 行,总数照样得是 2——按展示条数报数就成了假话。
  // (v7.3 Q27-A 起总数的渲染点是列表上方那一行,角标仍在页签上;口径没变,
  //  只是位置变了。)
  it("计数走全量 list,筛选态开着时也不缩水", async () => {
    seed([mk("alpha", "installedFrom"), mk("beta", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-alpha")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("tab-badge-installedFrom"));
    expect(screen.queryByTestId("row-alpha")).toBeNull();
    expect(screen.getByTestId("mine-total")).toHaveTextContent("共 2 个技能");
    expect(screen.getByTestId("tab-badge-installedFrom")).toHaveTextContent("1");
  });

  it("空页签有自己的空态文案,不是一句笼统的「没有技能」", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    await userEvent.click(tab(/已分享到技能库/));
    expect(
      screen.getByText("你还没有分享过技能。写好一个技能后,在「可分享到技能库」里分享它。"),
    ).toBeInTheDocument();
  });

  // 🔴 共识 §7 的两条既有原则:**每条空态都给一个出路**(不是只说"空的");
  // **不解释状态、只说下一步**。
  it("空态给出路:「安装自」有「去技能商店看看」,「可分享到」有「新建技能」", async () => {
    seed([mk("a", "sharedTo")]);
    render(<MySkillsPage />);
    await screen.findByRole("tab", { name: /安装自技能库/ });
    expect(screen.getByText("还没有从公司技能库获取过技能。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "去技能商店看看" }));
    expect(useUi.getState().page).toBe("store");

    useUi.setState({ page: "mine" });
    await userEvent.click(tab(/可分享到技能库/));
    expect(
      screen.getByText("这里会列出还没进公司技能库的技能——你自己写的,或从别处获取的。"),
    ).toBeInTheDocument();
    // 🔴 「新建技能」全屏只有一颗:页签行那一份在列表非空时就已经摆着了,
    // 空态不再重复摆第二颗(同屏两颗一模一样的按钮是噪音)。
    expect(screen.getAllByRole("button", { name: /新建技能/ })).toHaveLength(1);
  });

  // 🔴 v7.3 需求 3:搜索**穿透页签**。v7.2 是"在 A 页签搜 B 页签里的技能会得到
  // 一句『没有匹配』,只好再补一句『其他分类里有 N 个』"——那句补丁本身就是
  // 症状。同一条原则在 v7.1 分区折叠时就定过:搜索必须穿透折叠,否则"搜到了
  // 但那区折着",用户看到的就是搜索坏了。
  it("搜索穿透页签:当前在 A 页签,搜 B 页签里的技能照样搜得到", async () => {
    seed([mk("alpha", "installedFrom"), mk("beta", "sharedTo")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-alpha")).toBeInTheDocument();
    act(() => useMineSearch.getState().setQuery("beta"));
    expect(screen.getByTestId("row-beta")).toBeInTheDocument();
    expect(screen.queryByTestId("row-alpha")).toBeNull();
  });

  it("搜索期间页签整行让位,换成「「xxx」的搜索结果」,命中按栏分组", async () => {
    seed([mk("alpha", "installedFrom"), mk("alphabet", "sharedTo")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-alpha")).toBeInTheDocument();
    act(() => useMineSearch.getState().setQuery("alpha"));
    // 页签整行不在了(不是"还在但没高亮")
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText("「alpha」的搜索结果")).toBeInTheDocument();
    // 两条命中分别落在自己那一栏的组头下面
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "安装自技能库",
      "已分享到技能库",
    ]);
    expect(screen.getByTestId("row-alpha")).toBeInTheDocument();
    expect(screen.getByTestId("row-alphabet")).toBeInTheDocument();
  });

  it("清空搜索词就恢复页签", async () => {
    seed([mk("alpha", "installedFrom")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-alpha")).toBeInTheDocument();
    act(() => useMineSearch.getState().setQuery("alpha"));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    act(() => useMineSearch.getState().setQuery(""));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("三栏都没命中才说「没有匹配」", async () => {
    seed([mk("alpha", "installedFrom"), mk("beta", "sharedTo")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-alpha")).toBeInTheDocument();
    act(() => useMineSearch.getState().setQuery("zzz"));
    expect(screen.getByText(/没有匹配「zzz」的技能/)).toBeInTheDocument();
  });

  // 🔴 分区折叠(mine-collapse)整套删除:留着就是与页签并行的第二套"一次只看
  // 一个区"机制。这条按**痕迹**钉:不再有可展开/折叠的区标题,也不再写那个键。
  it("分区折叠已删除:没有 aria-expanded 的区标题,也不写 localStorage", async () => {
    seed([mk("a", "installedFrom"), mk("b", "installedFrom")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    // 区标题不再是可折叠的按钮,行容器也不再有 `mine-section-*` 这个 id
    // (⚠️ 别写成"页面上没有任何 aria-expanded"——行尾的「更多」菜单也带它,
    // 那样断言红了也不是因为折叠还在)
    expect(screen.queryByRole("button", { name: /安装自技能库/ })).toBeNull();
    expect(document.querySelector('[id^="mine-section-"]')).toBeNull();
    expect(localStorage.getItem("skillsync.mineCollapsed")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 「可分享到技能库」页签按来源分组(v7.2 需求 4)
// ---------------------------------------------------------------------------

describe("可分享到 · 按来源分组", () => {
  const openShareable = async () => {
    render(<MySkillsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /可分享到技能库/ }));
  };

  // 🔴 v7.3 需求 4:无来源那一组**不摆标题**,顶格排最前。它是**默认档**
  // ——给"正常情况"起名字反而暗示它异常(与「只写例外」同一条原则)。
  // 所以组头只剩两个,而那一组的行仍然排在最前面。
  it("按来源分组:无来源那一组不摆标题、顶格排最前;其余组头按来源名排", async () => {
    seed([
      mk("z-draft", "shareable", { sourceLabel: null }),
      mk("b-skill", "shareable", { sourceLabel: "vercel-labs/agent-skills" }),
      mk("a-skill", "shareable", { sourceLabel: "acme/tools" }),
    ]);
    await openShareable();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "来源 acme/tools",
      "来源 vercel-labs/agent-skills",
    ]);
    // 「没有来源」这句话整个不该再出现
    expect(screen.queryByText("没有来源")).toBeNull();
    // 顶格排最前:无来源那一行在 DOM 顺序上排在两个组头之前
    const rows = screen.getAllByTestId(/^row-/);
    expect(rows[0]).toHaveAttribute("data-testid", "row-z-draft");
    expect(
      screen.getByTestId("row-z-draft").compareDocumentPosition(
        screen.getAllByRole("heading", { level: 3 })[0],
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("同一个来源的多行归进同一组(组数 = 不同来源数,不是行数)", async () => {
    seed([
      mk("p", "shareable", { sourceLabel: "acme/tools" }),
      mk("q", "shareable", { sourceLabel: "acme/tools" }),
    ]);
    await openShareable();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
    expect(screen.getByTestId("row-p")).toBeInTheDocument();
    expect(screen.getByTestId("row-q")).toBeInTheDocument();
  });

  it("🔴 来源只写在组头上,行内不再重复(同屏两遍同样的字符串)", async () => {
    seed([mk("p", "shareable", { sourceLabel: "acme/tools" })]);
    await openShareable();
    expect(screen.getAllByText("来源 acme/tools")).toHaveLength(1);
    expect(within(screen.getByTestId("row-p")).queryByText(/来源/)).toBeNull();
  });

  it("其余两个页签不分组(它们本来就都来自公司技能库)", async () => {
    seed([mk("a", "installedFrom"), mk("b", "installedFrom")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// v7.3 需求 6:角标可点筛选
// ---------------------------------------------------------------------------

describe("v7.3 需求 6:点角标 = 切到该页签 + 只看要处理的", () => {
  /** 「已分享到」区:2 行要处理(update 走不到这个区,用 conflict/chooseVersion)
   *  + 1 行什么都不用做。 */
  const seedSharedTo = () =>
    seed([
      mk("keep-a", "sharedTo", { remote: "NEW" }), // conflict → 要处理
      mk("keep-b", "sharedTo", { localModified: true }), // shareChanges → 要处理
      mk("quiet", "sharedTo"), // none → 常态
      mk("home", "installedFrom"),
    ]);

  it("在别的页签上点角标:切过去 + 列表只剩要处理的那几行", async () => {
    seedSharedTo();
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-home")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("tab-badge-sharedTo"));

    expect(screen.getByRole("tab", { name: /已分享到技能库/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("row-keep-a")).toBeInTheDocument();
    expect(screen.getByTestId("row-keep-b")).toBeInTheDocument();
    // 🔴 这一条才是"真的筛了"的判据:常态那一行必须消失
    expect(screen.queryByTestId("row-quiet")).toBeNull();
  });

  // 只靠角标太隐蔽:列表突然只剩两行,用户未必知道自己在筛选态、更未必知道怎么退。
  // 两处互为印证——角标进入按下态说明"是谁在起作用",列表上方那行字给出口。
  it("筛选态:角标是按下态,列表上方有「只看要处理的 · 显示全部」", async () => {
    seedSharedTo();
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-home")).toBeInTheDocument();

    expect(screen.getByTestId("tab-badge-sharedTo")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("tab-badge-sharedTo"));
    expect(screen.getByTestId("tab-badge-sharedTo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("只看要处理的")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "显示全部" }));
    expect(screen.getByTestId("row-quiet")).toBeInTheDocument();
    expect(screen.getByTestId("tab-badge-sharedTo")).toHaveAttribute("aria-pressed", "false");
  });

  it("已经在这个页签上时,再点角标就地开关(不是恒开)", async () => {
    seedSharedTo();
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-home")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("tab-badge-sharedTo"));
    expect(screen.queryByTestId("row-quiet")).toBeNull();
    await userEvent.click(screen.getByTestId("tab-badge-sharedTo"));
    expect(screen.getByTestId("row-quiet")).toBeInTheDocument();
  });

  // 🔴 切页签即清筛选:否则切到一个没有待办的页签会看到空列表,而它明明有
  // 好几个技能,用户第一反应是"东西呢"。
  it("切页签即清筛选(切回来也是全量)", async () => {
    seedSharedTo();
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-home")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("tab-badge-sharedTo"));
    expect(screen.queryByTestId("row-quiet")).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: /安装自技能库/ }));
    expect(screen.getByTestId("row-home")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /已分享到技能库/ }));
    expect(screen.getByTestId("row-quiet")).toBeInTheDocument();
    expect(screen.getByTestId("tab-badge-sharedTo")).toHaveAttribute("aria-pressed", "false");
  });

  // 筛选与搜索互斥:两个都开着的话,用户看到的是"搜索结果里还少了一半",
  // 而少的那一半没有任何提示。
  it("进搜索即清筛选(退出搜索也不恢复)", async () => {
    seedSharedTo();
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-home")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("tab-badge-sharedTo"));
    expect(screen.queryByTestId("row-quiet")).toBeNull();

    act(() => useMineSearch.getState().setQuery("keep"));
    expect(screen.queryByText("只看要处理的")).toBeNull();

    act(() => useMineSearch.getState().setQuery(""));
    expect(screen.getByTestId("row-quiet")).toBeInTheDocument();
    expect(screen.getByTestId("tab-badge-sharedTo")).toHaveAttribute("aria-pressed", "false");
  });

  // 🔴 这一档是**可达死角的唯一出口**,不是防御性分支:筛选开着 → 用户把最后
  // 一条待办处理掉 → 列表重载后这一栏的 attention 归 0 → **角标本身消失**
  // (`stats.attention > 0` 才渲染它)。此时「显示全部」是退出筛选态的仅存入口,
  // 它要是没渲染,用户就被困在一个空列表里,连进来的那颗角标都找不到了。
  it("筛选态下待办被处理光:不说「这个分类是空的」(那是假话),给出口", async () => {
    seedSharedTo();
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-home")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("tab-badge-sharedTo"));
    expect(screen.queryByTestId("row-quiet")).toBeNull();

    // 那两条待办被处理掉了(core 重新给了一份没有待办的列表)
    act(() =>
      useMySkills.setState({
        list: stripFixtureOnly([mk("quiet", "sharedTo"), mk("home", "installedFrom")]),
      }),
    );

    expect(screen.getByText("这个分类里已经没有要处理的了。")).toBeInTheDocument();
    // 角标已经消失,上面那行「只看要处理的 · 显示全部」是仅存的出口
    expect(screen.queryByTestId("tab-badge-sharedTo")).toBeNull();
    expect(screen.getAllByRole("button", { name: "显示全部" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "显示全部" }));
    expect(screen.getByTestId("row-quiet")).toBeInTheDocument();
  });

  // 🔴 不做 `button` 套 `button`(HTML 不允许),两颗都要能用键盘分别到达。
  it("页签与角标是两颗兄弟按钮,不是嵌套", async () => {
    seedSharedTo();
    render(<MySkillsPage />);
    await screen.findByTestId("row-home");
    const badge = screen.getByTestId("tab-badge-sharedTo");
    const tabBtn = screen.getByRole("tab", { name: /已分享到技能库/ });
    expect(tabBtn.contains(badge)).toBe(false);
    expect(badge.contains(tabBtn)).toBe(false);
    expect(badge.closest("button")).toBe(badge);
  });
});

// ---------------------------------------------------------------------------
// v7.3 需求 5:常态动作降级(全站规则)
// ---------------------------------------------------------------------------

describe("v7.3 需求 5:常态动作用轻形态,例外才用实心", () => {
  /** 🔴 形态断言必须**按空白切分类名逐个比**:`toContain("bg-accent")` 分不出
   *  实心与 chip(`"bg-accent-soft"` 这个**字符串**含有 `"bg-accent"`),
   *  `/\bbg-accent\b/` 同样不行(`-` 是非词字符)。 */
  const classes = (el: HTMLElement) => el.className.split(/\s+/);

  it("「分享」是浅橙 chip,不是实心(那一栏 41 行 41 个都有它)", async () => {
    seed([mk("d", "shareable")]);
    render(<MySkillsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /可分享到技能库/ }));
    const btn = screen.getByRole("button", { name: "分享" });
    expect(classes(btn)).toContain("bg-accent-soft");
    expect(classes(btn)).not.toContain("bg-accent");
  });

  it("例外动作仍是实心:「更新」", async () => {
    seed([mk("u", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    expect(classes(await screen.findByRole("button", { name: "更新" }))).toContain("bg-accent");
  });

  it("例外动作仍是实心:「分享改动」", async () => {
    seed([mk("s", "sharedTo", { localModified: true })]);
    render(<MySkillsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /已分享到技能库/ }));
    expect(classes(screen.getByRole("button", { name: "分享改动" }))).toContain("bg-accent");
  });
});


describe("基线自愈接线(v8 任务 2):挂载即对齐一次", () => {
  /** 本地与库里逐字节相同、账上的基线却停在旧值——同事真机卡住的那个形状。 */
  const staleRow = () =>
    mk("weekly-report", "installedFrom", {
      remote: "NEW",
      localHash: "sha256:remote-new-weekly-report",
    });

  it("🔴 页面挂载后自己发一次对齐,参数是实时指纹 + 账上的库坐标", async () => {
    seed([staleRow()]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-weekly-report");

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([c]) => c === "skill_align_baseline")).toHaveLength(1);
    });
    expect(lastInvoke("skill_align_baseline")?.args).toEqual({
      dirSlug: "weekly-report",
      contentHash: "sha256:remote-new-weekly-report",
      registryId: "company",
      owner: "skills",
      repo: "skills",
    });
  });

  it("本地与库里本来就一致的行不触发(否则每次翻开这一页都在白发请求)", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByTestId("row-a");

    expect(invoke.mock.calls.filter(([c]) => c === "skill_align_baseline")).toHaveLength(0);
  });
});
