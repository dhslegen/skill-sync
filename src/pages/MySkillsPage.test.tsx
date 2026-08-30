import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySkillsPage } from "./MySkillsPage";
import type { InstalledSkillView, Section, StoreIndexView } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMineCollapse } from "@/store/mine-collapse";
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
    review: null,
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
  useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
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
    shareConflict: null,
    shareableIndexes: new Map(),
    shareableIndexesLastFetchedAt: new Map(),
    updateAllBusy: false,
    updateAllError: null,
    updateAllFailures: null,
  });
  useCreate.setState({ phase: "closed" });
  useMineCollapse.setState({ collapsed: [] });
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
    // 🔴 范围收在**行内**:区标题("已分享到技能库"/"可分享到技能库")本身就带
    // 「分享」二字,而它是折叠头不是动作按钮——不收窄的话这条断言会被区名误伤,
    // 测的就不再是"行上没有动作按钮"这件事了。
    expect(within(row).queryByRole("button", { name: /更新|分享|贡献/ })).toBeNull();
    expect(screen.queryByText(/已同步/)).toBeNull();
  });

  it("🔴 M2:页头不摆「N 个技能」计数,「新建技能」在 tabs 那一行,不是单独一行", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    expect(screen.queryByText(/个技能$/)).toBeNull();
    const tabs = screen.getByRole("tablist");
    const createButton = screen.getByRole("button", { name: "新建技能" });
    // 「新建技能」与 tablist 是同一个父容器下的兄弟节点(design #16:紧跟在
    // 「项目里」之后),不是散落在页面别处。
    expect(tabs.parentElement).toBe(createButton.parentElement);
  });

  it("有事要做时:页头给总览与「全部更新」,只覆盖库有新版且本地没改的", async () => {
    seed([
      mk("a", "installedFrom", { remote: "NEW" }),
      mk("b", "installedFrom", { remote: "NEW", localModified: true }),
    ]);
    render(<MySkillsPage />);
    expect(await screen.findByText(/1 个有更新/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部更新" }));
    expect(lastInvoke("skill_install_batch")?.args.dirSlugs).toEqual(["a"]);
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
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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
    // 这一对区分,与草稿(还没进公司库的技能)毫无关系。此前的判据只看
    // secIndex===0,而没有「安装自」行时「可分享到」会顶到第一位,提示就会
    // 贴错地方。
    seedSignedOut([mk("draft-a", "shareable")]);
    render(<MySkillsPage />);
    await screen.findByText("可分享到技能库");
    expect(screen.queryByText(/登录后能区分哪些是你分享的/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 补充覆盖:三区排列、可分享到区的外源更新、注入前信号分离用的对照组。
// ---------------------------------------------------------------------------

describe("三区排列与判定表接线", () => {
  it("三区按 installedFrom → sharedTo → shareable 固定顺序,空区不出现", async () => {
    seed([mk("a", "shareable"), mk("b", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    // 区标题现在是折叠头(区名 + 计数),所以比"以区名开头",不比全等
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(titles.map((x) => x.replace(/\s+/g, ""))).toEqual([
      "安装自技能库·1",
      "可分享到技能库·1",
    ]);
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
        return { kind: "submitted", mode: "pushed", commitSha: "new", reviewUrl: null };
      return null;
    });
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
    expect(screen.queryByRole("menuitem", { name: "贡献更改" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "分享改动" })).toBeNull();
  });

  it("🔴 修复轮 2(③):ReviewPendingText 的「在技能库里查看」失败要有渲染点", async () => {
    const list = [mk("a", "shareable", { review: { url: "http://gitea/x/y/pulls/7" } })];
    seed(list);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return stripFixtureOnly(list);
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "open_library_url") throw { code: "NET_BLOCKED", message: "这个地址不允许打开" };
      return null;
    });
    render(<MySkillsPage />);
    await screen.findByText("审核中");

    await userEvent.click(screen.getByRole("button", { name: "在技能库里查看" }));

    expect(await screen.findByText(/这个地址不允许打开/)).toBeInTheDocument();
  });

  it("🔴 修复轮 2(③):审核中没有链接时,不摆「在技能库里查看」——url 为 null 时如实不摆", async () => {
    seed([mk("a", "shareable", { review: { url: null } })]);
    render(<MySkillsPage />);
    await screen.findByText("审核中");
    expect(screen.queryByRole("button", { name: "在技能库里查看" })).toBeNull();
  });

  it("🔴 修复轮 2(③):「更多」菜单里「移除」永远排最后,且与前面的动作有一条分隔线", async () => {
    seed([mk("a", "installedFrom", { remote: "NEW", localModified: true })]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));

    const items = screen.getAllByRole("menuitem");
    expect(items[items.length - 1]).toHaveTextContent("移除");
    // 分隔线只在"移除"前面有别的动作时才画——它的 className 里带 border-t
    expect(items[items.length - 1].className).toContain("border-t");
  });

  it("sharedTo:本地改过、库没变 → 「分享改动」", async () => {
    seed([mk("a", "sharedTo", { localModified: true })]);
    render(<MySkillsPage />);
    expect(await screen.findByRole("button", { name: "分享改动" })).toBeInTheDocument();
  });

  it("shareable:标准校验没过 → 禁用的「分享」+ 一句人话说清哪不合格", async () => {
    seed([mk("a", "shareable", { shareBlocked: "nameMismatch" })]);
    render(<MySkillsPage />);
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
    render(<MySkillsPage />);
    const btn = await screen.findByRole("button", { name: "分享改动" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/分享前请在 SKILL\.md 里补上 description/)).toBeInTheDocument();
  });

  it("shareable:审核中 → 没有按钮,只有「审核中」文字", async () => {
    seed([mk("a", "shareable", { review: { url: null } })]);
    render(<MySkillsPage />);
    await screen.findByText("审核中");
    expect(screen.queryByRole("button", { name: "分享" })).toBeNull();
  });

  it("🔴 修复轮 2(④/M3):shareable 区外源行的来源标签是等宽字体(design §6)", async () => {
    seed([
      mk("a", "shareable", { sourceLabel: "vercel-labs/agent-skills" }),
    ]);
    render(<MySkillsPage />);
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
    render(<MySkillsPage />);

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
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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

    await userEvent.click(await screen.findByRole("button", { name: "全部更新" }));

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

    useMineSearch.getState().setQuery("周报");
    expect(await screen.findByText("周报生成")).toBeInTheDocument();

    useMineSearch.getState().setQuery("不存在的技能");
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
    expect(screen.queryByText("周报生成")).toBeNull();
  });
});

describe("移除只在本体在这台电脑上时才摆", () => {
  it("localPresent 为 false 的行:主按钮是「取回」,没有本体也没有「更多」可摆", async () => {
    // 本体不在(取回之前)+ 没有可打开的文件夹路径 = 「更多」菜单空空如也,
    // 按「不摆比摆一个没有意义的东西好」这条既定取舍,SkillRowMenu 索性不渲染。
    seed([mk("a", "sharedTo", { localPresent: false, body: "" })]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    expect(within(row).getByRole("button", { name: "取回" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "更多" })).toBeNull();
    expect(screen.queryByRole("button", { name: "移除" })).toBeNull();
  });

  it("localPresent 为 true:「移除」在「更多」里,`localPresent` 为 false 时消失(正反对照)", async () => {
    seed([mk("a", "sharedTo")]);
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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
    render(<MySkillsPage />);

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
      useInstall.setState({ shareResult: { mode: "reviewRequested" } });
    });
    await screen.findByText("改动已提交审核,审核通过后生效。");
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
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-weekly-report");

    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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
    render(<MySkillsPage />);
    const row = await screen.findByTestId("row-weekly-report");
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
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

describe("v7 任务 8:项目里页签", () => {
  it("两个页签:通用 / 项目里,默认通用;切到项目里能看到项目", async () => {
    seed([mk("a", "installedFrom")]);
    // 🔴 `ProjectSections` 挂载即 `useProjects().load()`,那会整体覆盖 groups
    // ——数据必须从 mock 的 IPC 里来,不能事后 `setState` 手喂(本项目记着的
    // 既有教训:挂载的 load() 会把手喂的数据冲掉,绿的那次什么都没证明)。
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "installed_list") return stripFixtureOnly([mk("a", "installedFrom")]);
      if (cmd === "agents_detected") return AGENT_LIST;
      if (cmd === "store_index") return companyIndex([mk("a", "installedFrom")]);
      if (cmd === "project_list") {
        return [
          { path: "/w/erp-backend", folderName: "erp-backend", missing: false, readOnly: false, skills: [] },
        ];
      }
      return null;
    });

    render(<MySkillsPage />);
    expect(await screen.findByRole("tab", { name: "通用" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "项目里" })).toHaveAttribute("aria-selected", "false");

    await userEvent.click(screen.getByRole("tab", { name: "项目里" }));
    expect(await screen.findByText("erp-backend")).toBeInTheDocument();
    // 切到项目里之后,「通用」区的行不该还摆在页面上
    expect(screen.queryByText("a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 分区折叠 + 区标题吸顶(用户真机反馈:条目一多就得一路滚)
// ---------------------------------------------------------------------------

describe("分区折叠", () => {
  /** 折叠头是 `<button>`,可访问名 = 它的可见文字(区名 + 计数),所以按区名
   *  的子串去找。 */
  const header = (name: RegExp) => screen.getByRole("button", { name });

  it("默认全部展开,头上写着这个区一共几条", async () => {
    seed([mk("a", "installedFrom"), mk("b", "installedFrom"), mk("c", "sharedTo")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    const h = header(/安装自技能库/);
    expect(h).toHaveAttribute("aria-expanded", "true");
    expect(h).toHaveTextContent("2");
  });

  it("点区标题折起来,行不再显示;再点一次回来", async () => {
    seed([mk("a", "installedFrom"), mk("c", "sharedTo")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();

    await userEvent.click(header(/安装自技能库/));
    expect(header(/安装自技能库/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("row-a")).not.toBeVisible();
    // 只折这一个区,别的区不受影响
    expect(screen.getByTestId("row-c")).toBeVisible();

    await userEvent.click(header(/安装自技能库/));
    expect(screen.getByTestId("row-a")).toBeVisible();
  });

  it("折叠状态跨重新挂载还在(落 localStorage,不落 config.ui)", async () => {
    seed([mk("a", "installedFrom")]);
    const first = render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    await userEvent.click(header(/安装自技能库/));
    expect(screen.getByTestId("row-a")).not.toBeVisible();
    // 🔴 落点必须是 localStorage:config.ui 的 None 有独立语义,往里写第一个值
    // 会把用户存在 localStorage 里的主题物化掉(CLAUDE.md 记的 M11 教训)。
    expect(JSON.parse(localStorage.getItem("skillsync.mineCollapsed") ?? "null")).toEqual([
      "installedFrom",
    ]);
    expect(lastInvoke("ui_prefs_set")).toBeUndefined();

    first.unmount();
    render(<MySkillsPage />);
    expect(await screen.findByRole("button", { name: /安装自技能库/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByTestId("row-a")).not.toBeVisible();
  });

  it("🔴 搜索穿透折叠:区折着时搜到的行照样显示出来", async () => {
    seed([mk("alpha", "installedFrom"), mk("beta", "installedFrom")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-alpha")).toBeInTheDocument();
    await userEvent.click(header(/安装自技能库/));
    expect(screen.getByTestId("row-alpha")).not.toBeVisible();

    act(() => useMineSearch.getState().setQuery("alpha"));
    // 折着也要显示——否则"搜到了但那个区折着"在用户看来就是搜索坏了
    expect(screen.getByTestId("row-alpha")).toBeVisible();
    expect(screen.queryByTestId("row-beta")).toBeNull();
    // 展示态恒为展开,aria-expanded 跟展示态走
    expect(header(/安装自技能库/)).toHaveAttribute("aria-expanded", "true");

    // 清空搜索后,原来折着的状态回来(存储态没被搜索改掉)
    act(() => useMineSearch.getState().setQuery(""));
    expect(screen.getByTestId("row-alpha")).not.toBeVisible();
    expect(header(/安装自技能库/)).toHaveAttribute("aria-expanded", "false");
  });

  it("🔴 折叠头数出「几个要处理」,含页头总览数不到的档(冲突 / 留哪一份)", async () => {
    seed([
      mk("a", "installedFrom"), // none
      mk("b", "installedFrom", { remote: "NEW" }), // update
      mk("c", "installedFrom", { remote: "NEW", localModified: true }), // conflict
      mk("d", "installedFrom", {
        versions: [
          { path: "/h/.claude/skills/d", modifiedAt: "2026-08-01T00:00:00Z", files: 1, contentHash: "sha256:x" },
          { path: "/h/.agents/skills/d", modifiedAt: "2026-08-01T00:00:00Z", files: 1, contentHash: "sha256:y" },
        ],
      }), // chooseVersion
    ]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-a")).toBeInTheDocument();
    // 页头总览只认得出 1 个「有更新」,而这个区实际有 3 行需要用户动手
    expect(screen.getByText(/1 个有更新/)).toBeInTheDocument();
    expect(header(/安装自技能库/)).toHaveTextContent("3 个要处理");
  });

  it("「可分享到」区的草稿不算「要处理」(那是该区的常态,不是折叠会藏掉的例外)", async () => {
    seed([mk("draft", "shareable"), mk("other", "shareable")]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-draft")).toBeInTheDocument();
    const h = header(/可分享到技能库/);
    expect(h).toHaveTextContent("2");
    expect(h).not.toHaveTextContent(/个要处理/);
  });

  it("计数走全量 list,不受搜索影响(搜索时头上的数不能说谎)", async () => {
    seed([mk("alpha", "installedFrom"), mk("beta", "installedFrom", { remote: "NEW" })]);
    render(<MySkillsPage />);
    expect(await screen.findByTestId("row-alpha")).toBeInTheDocument();
    act(() => useMineSearch.getState().setQuery("alpha"));
    expect(screen.queryByTestId("row-beta")).toBeNull();
    const h = header(/安装自技能库/);
    expect(h).toHaveTextContent("2");
    expect(h).toHaveTextContent("1 个要处理");
  });

  it("区标题吸顶(sticky),且不带 aria-label(可访问名就是可见文字)", async () => {
    seed([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    const h = await screen.findByRole("button", { name: /安装自技能库/ });
    // 吸顶挂在外层 `<h3>` 上(区标题的语义保留),按钮是它里面的整条可点区
    const heading = h.closest("h3");
    expect(heading?.className).toContain("sticky");
    expect(heading?.className).toContain("top-0");
    expect(h).not.toHaveAttribute("aria-label");
    // aria-controls 指向下面那个行容器
    const bodyId = h.getAttribute("aria-controls");
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId!)).toContainElement(screen.getByTestId("row-a"));
  });
});
