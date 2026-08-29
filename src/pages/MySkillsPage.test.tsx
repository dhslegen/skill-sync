import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MySkillsPage } from "./MySkillsPage";
import type { InstalledSkillView, Section, StoreIndexView } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMineSearch } from "@/store/mine-search";
import { useMySkills } from "@/store/my-skills";
import { useSession } from "@/store/session";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";

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
    shareableIndexesAttempted: new Set(),
    updateAllBusy: false,
    updateAllError: null,
    updateAllFailures: null,
  });
}

beforeEach(resetStores);

// ---------------------------------------------------------------------------
// brief Step 1 的六条测试,逐字照用(仅把伪代码换成本文件的真实 mk/seed 实现)。
// ---------------------------------------------------------------------------

describe("v7 任务 7:DoD 六条", () => {
  it("一切正常时:没有按钮、没有状态字", async () => {
    seed([mk("a", "installedFrom"), mk("b", "sharedTo")]);
    render(<MySkillsPage />);
    expect(await screen.findByText("a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /更新|分享|贡献/ })).toBeNull();
    expect(screen.queryByText(/已同步/)).toBeNull();
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
    seedSignedOut([mk("a", "installedFrom")]);
    render(<MySkillsPage />);
    await screen.findByText("a");
    expect(screen.queryByText("已分享到技能库")).toBeNull();
    expect(screen.getByText(/登录后能区分哪些是你分享的/)).toBeInTheDocument();
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
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["安装自技能库", "可分享到技能库"]);
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

  it("shareable:审核中 → 没有按钮,只有「审核中」文字", async () => {
    seed([mk("a", "shareable", { review: { url: null } })]);
    render(<MySkillsPage />);
    await screen.findByText("审核中");
    expect(screen.queryByRole("button", { name: "分享" })).toBeNull();
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

    expect(await screen.findByRole("button", { name: "更新" })).toBeInTheDocument();
    expect(screen.getByText("React 最佳实践")).toBeInTheDocument();
    expect(screen.getByText("Vercel 出品的性能与写法指南。")).toBeInTheDocument();

    const row = screen.getByTestId("row-a");
    await userEvent.click(within(row).getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menuitem", { name: "分享" })).toBeInTheDocument();
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
