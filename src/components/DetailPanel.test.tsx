import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { contributorsText, DetailPanel, revealLabel, stripFrontmatter } from "./DetailPanel";
import type { InstalledSkillView, LocalSkillDetail, Section, SkillDetail } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMySkills } from "@/store/my-skills";
import { usePlaza } from "@/store/plaza";
import { useProjects } from "@/store/project";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";

// agent 探测走 IPC:mock 掉才能让"点安装 → 展开勾选"这条路走通。
// spy 形式暴露出来,本地详情的 reveal 测试要断言调用参数。
const invokeMock = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  void args; // 只为让 spy 把参数记进 calls;实现本身按 cmd 分发
  if (cmd === "agents_detected") {
    return {
      agents: [
        { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", skillsDir: ".claude-code/skills", isUniversal: false, needsLink: true, disabled: false },
      ],
      canonicalDir: "~/.agents/skills",
    };
  }
  if (cmd === "installed_list") return [];
  // 「在哪」块 4「项目里」(`WhereBlocks.tsx` 的 `ProjectsBlock`,v7.6 任务 2
  // 并自原 `InstalledScopes`)在挂载时无条件拉一次项目清单(零新 IPC,复用既有
  // 的 project_list)——不给默认值的话,任何渲染 DetailPanel 的用例都会多打出
  // 一个不相关的 invoke 调用,把用 mockImplementationOnce 按"下一次调用"排队的
  // 用例带偏(v6 任务 5 真实撞过这个坑)。
  // 🔴 v7.6 任务 2 起**必须回读** `useProjects.getState().groups`,不能固定
  // 返回 `[]`——固定值会把用例刚 `setState` 喂的 groups 整体冲掉,变成
  // CLAUDE.md 记的那种"时绿时红"(`InstalledScopes.test.tsx` 当年就是这么
  // 写的,并入本文件时原样带走)。
  if (cmd === "project_list") return useProjects.getState().groups;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

// 🔴 v7.6 任务 2:「项目里」块(`ProjectsBlock`)读的是全局单例 `useProjects`,
// 这个文件此前从不碰它。不在文件级重置的话,任意一条 `describe` 里 `setState`
// 过 `groups` 的用例会把状态漏给声明顺序在它之后的其他 `describe`——那些
// describe 各自的 `beforeEach` 并不知道要清这份状态。挂在最外层,对每一条用例
// 都先重置一次,与各 `describe` 自己的 `beforeEach` 不冲突(vitest 按注册顺序
// outer-to-inner 执行)。
beforeEach(() => {
  useProjects.setState({ groups: [] });
});

const detail = (over: Partial<SkillDetail> = {}): SkillDetail => ({
  name: "周报生成",
  dirSlug: "weekly-report",
  description: "汇总本周工作",
  path: "skills/weekly-report",
  skillMd: [
    "---",
    "name: 周报生成",
    "description: 汇总本周工作",
    "---",
    "",
    "## 这个技能做什么",
    "",
    "把提交记录整理成周报草稿,保留你的写作风格。",
    "",
    "- 用 `周报生成` 整理本周记录",
    "",
  ].join("\n"),
  files: [
    { path: "SKILL.md", size: 4300 },
    { path: "scripts/collect.py", size: 3100 },
    { path: "logo.png" },
  ],
  hasScripts: true,
  commitSha: "a1b2c3d4e5f6",
  committedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  tags: [],
  attribution: null,
  ...over,
});

function open(over: Partial<SkillDetail> = {}) {
  const d = detail(over);
  useStoreIndex.setState({
    detailSlug: d.dirSlug,
    detail: d,
    detailError: null,
    index: {
      registryId: "company",
      owner: "skills",
      repo: "skills",
      branch: "main",
      commitSha: d.commitSha,
      committedAt: d.committedAt,
      fetchedAt: Math.floor(Date.now() / 1000),
      skills: [],
      skipped: [],
      fromCache: false,
      offline: false,
      curated: [],
    },
  });
  return d;
}

describe("stripFrontmatter", () => {
  it("去掉 frontmatter 只留正文", () => {
    expect(stripFrontmatter("---\nname: a\n---\n\n正文\n")).toBe("\n正文\n");
  });

  it("没有 frontmatter 时原样返回", () => {
    expect(stripFrontmatter("# 直接是正文")).toBe("# 直接是正文");
  });

  it("正文里的 --- 分隔线不会被当成 frontmatter 结尾误切", () => {
    const raw = "---\nname: a\n---\n\n前言\n\n---\n\n后记\n";
    expect(stripFrontmatter(raw)).toBe("\n前言\n\n---\n\n后记\n");
  });

  it("CRLF 换行也能正确剥离(Windows 上编辑过的 SKILL.md)", () => {
    expect(stripFrontmatter("---\r\nname: a\r\n---\r\n正文")).toBe("正文");
  });
});

describe("DetailPanel", () => {
  beforeEach(() => {
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
  });

  it("关闭时不暴露内容,也不吃点击", () => {
    render(<DetailPanel />);
    expect(screen.queryByText("周报生成")).not.toBeInTheDocument();
  });

  // 🔴 Q9A(v7.1):副标题里**不再**跟一个 `@ <短 sha>`。那个 sha 是**整库 HEAD**
  // ——别人改任何一个技能它都会变,拿它当"这个技能的版本"是撒谎。原用例断言的是
  // "坐标 + 短版本标识",现在断言"坐标在、版本标识不在":命题被拍板改掉了,
  // 不是把断言放宽。
  it("渲染技能名与等宽坐标,且不跟版本标识(Q9A:那是整库 HEAD)", () => {
    open();
    render(<DetailPanel />);
    expect(screen.getByRole("heading", { name: "周报生成" })).toBeInTheDocument();
    expect(screen.getByText("skills/weekly-report")).toBeInTheDocument();
    expect(screen.queryByText(/a1b2c3d/)).not.toBeInTheDocument();
  });

  it("元数据给相对时间,而不是原始时间戳", () => {
    open();
    render(<DetailPanel />);
    expect(screen.getByText("3 天前")).toBeInTheDocument();
  });

  it("正文渲染 markdown,且 frontmatter 不出现在正文里", () => {
    open();
    render(<DetailPanel />);
    expect(screen.getByRole("heading", { name: "这个技能做什么" })).toBeInTheDocument();
    // frontmatter 是给机器看的,不该露在界面上
    expect(screen.queryByText(/description: 汇总本周工作/)).not.toBeInTheDocument();
  });

  it("不渲染 SKILL.md 里的裸 HTML —— 技能内容是不可信输入", () => {
    open({
      skillMd: '---\nname: x\ndescription: y\n---\n\n<img src="x" onerror="alert(1)">\n\n<b>粗体</b>正文\n',
    });
    const { container } = render(<DetailPanel />);
    // 标记必须以纯文本出现,而不是被解析成元素
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".md b")).toBeNull();
    expect(screen.getByText(/<b>粗体<\/b>正文/)).toBeInTheDocument();
  });

  it("文件页列出全部文件;拿不到大小的不编造数字", async () => {
    open();
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("tab", { name: "文件 (3)" }));

    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
    expect(screen.getByText("4.2 KB")).toBeInTheDocument();
    expect(screen.getByText("scripts/collect.py")).toBeInTheDocument();
    // 二进制文件不进内存树,没有大小
    expect(screen.getByText("logo.png")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("含可执行脚本时,文件页目录行给出警示角标(知情权)", async () => {
    open();
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("tab", { name: /文件/ }));
    expect(screen.getByText("含可执行脚本")).toBeInTheDocument();
  });

  it("不含脚本的技能不该被标警示", async () => {
    open({ hasScripts: false, files: [{ path: "SKILL.md", size: 100 }] });
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("tab", { name: /文件/ }));
    expect(screen.queryByText("含可执行脚本")).not.toBeInTheDocument();
  });

  it("底部安装按钮点开 agent 勾选,而不是直接开装", async () => {
    open();
    render(<DetailPanel />);
    const install = screen.getByRole("button", { name: "安装" });
    expect(install).toBeEnabled();

    await userEvent.click(install);
    // 先让用户看清会装到哪儿去,再确认 —— 不做"点一下就动磁盘"
    expect(await screen.findByText("选择要启用的 AI 工具")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认安装" })).toBeInTheDocument();
  });

  it("关闭按钮收起面板", async () => {
    open();
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(useStoreIndex.getState().detailSlug).toBeNull();
  });

  it("打开时焦点进面板,关闭后还给点开它的元素", async () => {
    // 声明了 aria-modal 就得真的管焦点:否则 Tab 会走到遮罩背后的列表里
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    open();
    const { rerender } = render(<DetailPanel />);
    expect(screen.getByRole("dialog")).toHaveFocus();

    useStoreIndex.setState({ detailSlug: null, detail: null });
    rerender(<DetailPanel />);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("Tab 在面板内循环,不会跑到遮罩背后", async () => {
    open();
    render(<DetailPanel />);
    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll<HTMLElement>("button:not([disabled])");
    const last = focusable[focusable.length - 1];

    last.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("正文区放开选中(全站禁选中的唯一例外)", () => {
    open();
    const { container } = render(<DetailPanel />);
    expect(container.querySelector(".selectable")).not.toBeNull();
  });

  it("读取失败时显示可读原因,而不是空白面板", () => {
    useStoreIndex.setState({
      detailSlug: "weekly-report",
      detail: null,
      detailError: { code: "REPO_NOT_FOUND", message: "这个技能已不在该技能库中,请返回列表刷新后再试" },
    });
    render(<DetailPanel />);
    expect(screen.getByText(/请返回列表刷新后再试/)).toBeInTheDocument();
  });
});

describe("详情面板底部的获取区", () => {
  beforeEach(() => {
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
    useLocalDetail.setState({ target: null, detail: null, error: null });
    useInstall.setState({ phase: "idle", dirSlug: null, installed: new Map() });
  });

  it("装了且内容一致 → 已在电脑上(终态,点不动;v7.6 起 installed 并入 onDisk,不再叫「已启用」)", () => {
    const d = open();
    useStoreIndex.setState({
      index: { ...useStoreIndex.getState().index!, skills: [
        { name: d.name, dirSlug: d.dirSlug, description: "", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:same", tags: [], author: null },
      ] },
    });
    useInstall.setState({
      installed: new Map([[d.dirSlug, { commitSha: "x", contentHash: "sha256:same", localModified: false, registryId: "company", sourceOwner: "skills", sourceRepo: "skills" }]]),
    });
    // v7.6:判定入口从"问账本"改成"问磁盘",要显式给出本机本体的实时指纹
    // (`useMySkills` 的 list),否则 localHash 缺省为 undefined 会被判成「获取」。
    useMySkills.setState({
      list: [{ ...installedView({ dirSlug: d.dirSlug }), localPresent: true, localHash: "sha256:same" }],
    });
    render(<DetailPanel />);
    expect(screen.getByRole("button", { name: /已在电脑上/ })).toBeDisabled();
  });

  it("装了但内容落后、本地未改 → 「更新」且可点(曾经这里只有两档,点了毫无反应)", async () => {
    // 2026-08-03 用户实测:商店卡片显示"更新",点进详情按钮却是禁用的「已启用」
    const d = open();
    useStoreIndex.setState({
      index: { ...useStoreIndex.getState().index!, skills: [
        { name: d.name, dirSlug: d.dirSlug, description: "", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:newer", tags: [], author: null },
      ] },
    });
    useInstall.setState({
      installed: new Map([[d.dirSlug, { commitSha: "x", contentHash: "sha256:old", localModified: false, registryId: "company", sourceOwner: "skills", sourceRepo: "skills" }]]),
    });
    // localHash 与记账基线一致(用户没碰过本地文件)→ 「更新」这个词才是准的
    // ——点下去真的安全,不会被 precheck 拦成拍板框(v7.6 共识)。
    useMySkills.setState({
      list: [{ ...installedView({ dirSlug: d.dirSlug }), localPresent: true, localHash: "sha256:old" }],
    });
    // ⚠️ 这份 useMySkills 数据同时会命中 DetailPanel 自己的 `list.find(dirSlug)`
    // 查找(供 WhereBlocks/SkillActionsBlock 用,任务 2 的地盘,本任务不碰),
    // 而那个区块在"installedFrom + remoteChanged"这个组合下**也会**渲染一颗
    // 文案同为「更新」的按钮——两颗按钮的可访问名相同,只能靠 `aria-label`
    // 属性精确定位这颗(`InstallButton` 的 panel 变体总会显式写 aria-label,
    // `SkillActionsBlock` 的主按钮不写),不能用 `getByRole` 按名字查。
    const { container } = render(<DetailPanel />);

    const button = container.querySelector('button[aria-label="更新"]');
    expect(button).toBeTruthy();
    expect(button).toBeEnabled();
    await userEvent.click(button!);
    // 点了要真的进入流程(展开 agent 勾选),不是死按钮
    await vi.waitFor(() => {
      expect(useInstall.getState().dirSlug).toBe(d.dirSlug);
    });
  });
});

// ---- 本地详情(我的技能/分享页共用的另一个数据源) ----

const localDetail = (over: Partial<LocalSkillDetail> = {}): LocalSkillDetail => ({
  name: "周报生成",
  dirSlug: "weekly-report",
  description: "汇总本周工作",
  path: "/home/u/.agents/skills/weekly-report",
  skillMd: "---\nname: 周报生成\ndescription: 汇总本周工作\n---\n\n本地正文内容\n",
  files: [
    { path: "SKILL.md", size: 64 },
    { path: "scripts/collect.py", size: 128 },
  ],
  hasScripts: true,
  ...over,
});

function openLocal(over: Partial<LocalSkillDetail> = {}) {
  const d = localDetail(over);
  useLocalDetail.setState({ target: { dirSlug: d.dirSlug }, detail: d, error: null });
  return d;
}

/**
 * `section` 与 `relation` 在 core 侧是 1:1 映射(`ownership::section`)。fixture 里
 * 各写各的,就能静默构造出**生产上不可能的组合**(比如 `relation:"shared"` 配
 * `section:"installedFrom"`),让吃 `section` 的判定在假前提下跑
 * ——`my-skills.test.ts` / `ShareConfirm.test.tsx` / `Sidebar.test.tsx` 已统一改成
 * 从 `relation` 推导,这里跟上(终审复审轮 1,M-1)。
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

const installedView = (over: Partial<InstalledSkillView> = {}): InstalledSkillView => ({
  dirSlug: "weekly-report",
  commitSha: "a1b2c3d",
  contentHash: "sha256:base",
  agents: ["claude-code"],
  installedAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  localModified: false,
  sourceOwner: "skills",
  sourceRepo: "skills",
  registryId: "company",
  sourceRemoved: false,
  libraryRemoved: false,
  relation: "installed",
  localPresent: true,
  sourceLabel: "skills/skills",
  body: "/home/u/.agents/skills/weekly-report",
  localHash: "sha256:base",
  tools: [{ agent: "claude-code", state: "linked" }],
  versions: [],
  shareBlocked: null,
  section: sectionOfRelation(over.relation ?? "installed"),
  review: null,
  libraryUrl: null,
  canonicalReaders: null,
  ...over,
});

describe("DetailPanel(本地详情模式)", () => {
  beforeEach(() => {
    // 取回失败那两条会把 useInstall 置成 error 档;不复位就会泄漏进后面的用例
    // ——今天靠归属过滤恰好看不出来,而"绿的那次什么都没证明"正是这么来的。
    useInstall.setState({ phase: "idle", dirSlug: null, error: null });
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
    useLocalDetail.setState({ target: null, detail: null, error: null });
    // 每条用例都显式给出这一份数据,不依赖上一条用例残留的 useMySkills 全局状态。
    useMySkills.setState({
      list: null,
      agentNames: new Map(),
      installedAgents: null,
      canonicalDir: "",
      toolDirs: new Map(),
    });
  });

  it("能打开一个不在商店索引里的技能,且详情面板显示「在哪」三块(v7 任务 6 DoD)", () => {
    // 🔴 这个技能只在 useMySkills().list 里,商店索引(useStoreIndex)对它一无所知
    // ——真实场景就是「我的技能」页的行:点开走的是 useLocalDetail,不是商店详情。
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null, index: null });
    useMySkills.setState({
      list: [installedView()],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      installedAgents: null,
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map([["claude-code", "/home/u/.claude/skills"]]),
    });
    openLocal();
    render(<DetailPanel />);
    // 折叠头默认收起(v7.1 Q2),要看三块得先展开——补一步交互,不放宽断言。
    fireEvent.click(screen.getByTestId("where-toggle"));
    const titles = screen.getAllByTestId("where-title").map((e) => e.textContent);
    expect(titles).toEqual(["这台电脑上", "各个工具里", "技能库里"]);
    // 本体在统一目录:界面必须说「统一技能目录」,不点名任何工具
    // ——修的就是"Zed 本体在这里"那个真实缺陷。
    expect(screen.getByText(/统一技能目录/)).toBeInTheDocument();
  });

  // 🔴 Q46-A(v7.6 任务 2):「项目里」并进「在哪」之后,「我的技能」详情
  // (本地详情模式)也会多出这第四块——`WhereBlocks` 在两条渲染路径下都渲染,
  // 不分 host。**这是并入的直接后果,不是回归**:原 `InstalledScopes` 组件
  // 此前只挂在 `PanelBody`(商店/广场详情)一侧,「我的技能」详情看不到"装到了
  // 哪些项目";现在两侧共用同一份「在哪」,信息终于对称了。
  it("「我的技能」详情(本地模式)里,装过项目时也能看到第四块「项目里」(Q46-A 的直接后果)", () => {
    useMySkills.setState({
      list: [installedView()],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      installedAgents: null,
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map([["claude-code", "/home/u/.claude/skills"]]),
    });
    useProjects.setState({
      groups: [
        {
          path: "/w/我的项目",
          folderName: "我的项目",
          missing: false,
          readOnly: false,
          skills: [
            {
              key: "weekly-report", displayName: "周报生成", description: "",
              source: "skills/skills", sourceType: "git", dirSlug: "weekly-report",
              registryId: "company", repo: "skills/skills", updatable: true, agents: [],
            },
          ],
        },
      ],
    });
    openLocal();
    render(<DetailPanel />);
    fireEvent.click(screen.getByTestId("where-toggle"));
    const titles = screen.getAllByTestId("where-title").map((e) => e.textContent);
    expect(titles).toEqual(["这台电脑上", "各个工具里", "技能库里", "项目里"]);
    expect(screen.getByRole("button", { name: /我的项目/ })).toBeInTheDocument();
  });

  // v7.1 Q2:折叠头默认收起,md 正文才是首屏主角。
  it("默认收起「在哪」,首屏直接是正文;结论行仍然说清区名与工具数", () => {
    useMySkills.setState({
      list: [installedView()],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map([["claude-code", "/home/u/.claude/skills"]]),
    });
    openLocal();
    render(<DetailPanel />);
    expect(screen.queryAllByTestId("where-title")).toHaveLength(0);
    expect(screen.getByTestId("where-toggle").textContent).toMatch(/安装自技能库/);
    expect(screen.getByText("本地正文内容")).toBeInTheDocument();
  });

  // 🔴 v7.2 需求 3(用户拍板,推翻 v7.1 任务 3 的落 localStorage):折叠是打开
  // 详情**期间**的临时操作,关掉面板再打开必须回到默认收起。按**行为**写
  // (展开 → 关 → 重开 → 断言收起),不按"有没有那个 store"写——store 删没删
  // 只是实现细节,用户看得见的是这一串动作的结果。
  it("🔴「在哪」的展开不跨面板保留:关掉再打开回到默认收起,也不落 localStorage", () => {
    useMySkills.setState({
      list: [installedView()],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map([["claude-code", "/home/u/.claude/skills"]]),
    });
    openLocal();
    const view = render(<DetailPanel />);
    fireEvent.click(screen.getByTestId("where-toggle"));
    expect(screen.getByTestId("where-toggle")).toHaveAttribute("aria-expanded", "true");
    // 展开这件事一个字节都不该落盘——落了就会跨面板、跨会话保留下来
    expect(localStorage.getItem("skillsync.detailWhereExpanded")).toBeNull();

    // 关掉面板(`local.detail` 置空,PanelBody 整个卸载),再打开同一个技能
    act(() => useLocalDetail.setState({ target: null, detail: null, error: null }));
    view.rerender(<DetailPanel />);
    openLocal();
    view.rerender(<DetailPanel />);
    expect(screen.getByTestId("where-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("where-title")).toHaveLength(0);
  });

  // 🔴 结论行的「库里有新版」必须真的从索引比对来(不是靠某个常量)。这一条
  // 走的是真实链路:useStoreIndex 的索引里那一版指纹与安装基线不同 → `hasUpdate`
  // → 结论行。折叠把细节收起来了,这件"要处理"的事不能跟着被收掉。
  it("库里有新版时,收起状态下的结论行照样说出来", () => {
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "zzz",
        committedAt: "2026-08-20T00:00:00.000Z",
        fetchedAt: 1,
        skills: [{ dirSlug: "weekly-report", contentHash: "sha256:newer" } as never],
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
      },
    });
    useMySkills.setState({
      list: [installedView()],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map(),
    });
    openLocal();
    render(<DetailPanel />);
    expect(screen.getByTestId("where-toggle").textContent).toMatch(/库里有新版/);
  });

  // 副标题不与折叠头上的等宽路径重复(照画布:副标题是库里的坐标)。
  it("副标题优先显示技能库坐标;库里查不到时才退回本体路径", () => {
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "zzz",
        committedAt: "2026-08-20T00:00:00.000Z",
        fetchedAt: 1,
        skills: [
          { dirSlug: "weekly-report", contentHash: "sha256:base", path: "skills/weekly-report", tags: [] } as never,
        ],
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
      },
    });
    useMySkills.setState({ list: [installedView()], agentNames: new Map(), toolDirs: new Map() });
    openLocal();
    render(<DetailPanel />);
    expect(screen.getByText("skills/weekly-report")).toBeInTheDocument();
    // 本体路径只出现一次(折叠头上那一处)
    expect(screen.getAllByText("/home/u/.agents/skills/weekly-report")).toHaveLength(1);
  });

  it("库里查不到这个技能时,副标题退回本体路径(不留空)", () => {
    useStoreIndex.setState({ index: null });
    useMySkills.setState({ list: [installedView()], agentNames: new Map(), toolDirs: new Map() });
    openLocal({ path: "/home/u/.claude/skills/weekly-report" });
    render(<DetailPanel />);
    expect(screen.getByText("/home/u/.claude/skills/weekly-report")).toBeInTheDocument();
  });

  // Q1A:md 是主角——正文区拿 flex-1,页脚固定在它**之后**。
  // 🔴 v7.2 需求 2:页脚固定这件事必须由**结构**保证,不能靠内容恰好不够高。
  // 用户真机反馈:点一下「这台电脑上」那句话后面的「…」,页脚就被顶下去了。
  // 根因是 v7.1 里正文是唯一的滚动区(`flex-1` = basis 0),被压到 0 之后整列
  // 再没有可压缩的余量,「在哪」一长高就把 `flex-none` 的页脚挤出列外。
  // jsdom 量不了布局,所以按不变量钉:**会长高的东西(在哪 / 页签 / 正文)
  // 全部住在同一个可收缩滚动区里,页脚是它之后的兄弟**。
  it("🔴「在哪」与正文同住一个可收缩滚动区,页脚是它之后的兄弟(展开不会顶走页脚)", () => {
    useMySkills.setState({ list: [installedView()], agentNames: new Map(), toolDirs: new Map() });
    openLocal();
    const { container } = render(<DetailPanel />);
    const body = container.querySelector(".selectable");
    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    // 可收缩:flex-1 + min-h-0(少了 min-h-0,`min-height:auto` 会按内容撑开)
    expect(scroller?.className).toContain("flex-1");
    expect(scroller?.className).toContain("min-h-0");
    // 「在哪」折叠头与正文都在它里面——不在的话,展开就还是在挤别人
    expect(scroller).toContainElement(screen.getByTestId("where-toggle"));
    expect(scroller).toContainElement(body as HTMLElement);
    // 「…」展开出来的那张小卡同样落在滚动区里(它是用户点的那一下)
    fireEvent.click(screen.getByTestId("where-toggle"));

    // 页脚(含「打开文件夹」)是滚动区**之后**的兄弟,且不参与收缩
    const footer = screen.getByRole("button", { name: "打开文件夹" }).closest("div.border-t");
    expect(footer?.parentElement).toBe(scroller?.parentElement);
    expect(footer?.className).toContain("flex-none");
    expect(scroller && footer && scroller.compareDocumentPosition(footer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  // 概览行(Q4A):有什么摆什么、缺的整列不摆、三列全缺整行不摆。
  describe("概览行", () => {
    const withIndex = (over: { author?: string | null; tags?: string[] }) => {
      useStoreIndex.setState({
        index: {
          registryId: "company",
          owner: "skills",
          repo: "skills",
          branch: "main",
          commitSha: "zzz",
          committedAt: "2026-08-20T00:00:00.000Z",
          fetchedAt: 1,
          skills: [
            {
              dirSlug: "weekly-report",
              contentHash: "sha256:base",
              author: over.author ?? null,
              tags: over.tags ?? [],
            } as never,
          ],
          skipped: [],
          fromCache: false,
          offline: false,
          curated: [],
        },
      });
      useMySkills.setState({ list: [installedView()], agentNames: new Map(), toolDirs: new Map() });
      openLocal();
      render(<DetailPanel />);
    };

    it("作者与标签都有:两列都摆", () => {
      withIndex({ author: "李雯", tags: ["测试", "文档"] });
      expect(screen.getByText("作者")).toBeInTheDocument();
      expect(screen.getByText("李雯")).toBeInTheDocument();
      expect(screen.getByText("标签")).toBeInTheDocument();
      expect(screen.getByText("测试、文档")).toBeInTheDocument();
    });

    it("🔴 库里查不到作者时整列不摆,不写「作者未知」这类占位", () => {
      withIndex({ author: null, tags: ["测试"] });
      expect(screen.queryByText("作者")).not.toBeInTheDocument();
      expect(screen.getByText("标签")).toBeInTheDocument();
    });

    it("🔴 没有标签时整列不摆", () => {
      withIndex({ author: "李雯", tags: [] });
      expect(screen.queryByText("标签")).not.toBeInTheDocument();
      expect(screen.getByText("作者")).toBeInTheDocument();
    });

    it("🔴 「版本标识」与「文件 N 个」两列已删除(Q9A + 与页签重复)", () => {
      withIndex({ author: "李雯", tags: ["测试"] });
      expect(screen.queryByText("版本标识")).not.toBeInTheDocument();
      // 「文件」只作为页签出现一次(「文件 (2)」),不再有一列独立的「文件 / 2 个」
      expect(screen.queryByText("2 个")).not.toBeInTheDocument();
    });

    it("🔴 三列全缺时整行不摆(留一个空的 border-y 会画出一道莫名其妙的粗线)", () => {
      // 商店索引里没有这个技能 → 没有作者也没有标签;`list` 也没有这一行 →
      // 没有「更新」时间。三样都缺。
      useStoreIndex.setState({ index: null });
      useMySkills.setState({ list: [], agentNames: new Map(), toolDirs: new Map() });
      openLocal();
      const { container } = render(<DetailPanel />);
      expect(container.querySelector(".border-y")).toBeNull();
      expect(screen.queryByText("更新")).not.toBeInTheDocument();
    });
  });

  // 终审复审轮 1,C-A:动作区的「更新」/「取回」走 `useMySkills.pull` →
  // `useInstall.beginUpdate`,失败只写进 `useInstall.error`。商店那条路
  // (`PanelBody`)下方挂着 `InstallPanel`,它的 `ErrorFooter` 会说出来;
  // **本地详情这条路没有 `InstallPanel`**,不自己接一处就是零反馈。
  it("取回失败时,本地详情面板自己摆出原因(这条路没有 InstallPanel 兜着)", () => {
    useMySkills.setState({ list: [installedView()], agentNames: new Map() });
    openLocal();
    render(<DetailPanel />);
    act(() =>
      useInstall.setState({
        dirSlug: "weekly-report",
        phase: "error",
        error: { code: "NET_TIMEOUT", message: "连不上公司技能库" },
      }),
    );
    expect(screen.getByText(/连不上公司技能库/)).toBeInTheDocument();
  });

  it("取回失败属于另一个技能时,这一屏一个字都不显示(跨技能归属)", () => {
    useMySkills.setState({ list: [installedView()], agentNames: new Map() });
    openLocal();
    render(<DetailPanel />);
    act(() =>
      useInstall.setState({
        dirSlug: "other-skill",
        phase: "error",
        error: { code: "NET_TIMEOUT", message: "连不上公司技能库" },
      }),
    );
    expect(screen.queryByText(/连不上公司技能库/)).not.toBeInTheDocument();
  });

  it("这个技能不在 useMySkills().list 里时,「在哪」三块整体不出现,面板其余部分照常打开", () => {
    openLocal();
    render(<DetailPanel />);
    expect(screen.queryByTestId("where-title")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "周报生成" })).toBeInTheDocument();
  });

  it("渲染名称、本地路径与正文;没有安装面板", () => {
    openLocal();
    render(<DetailPanel />);
    expect(screen.getByRole("heading", { name: "周报生成" })).toBeInTheDocument();
    expect(screen.getByText("/home/u/.agents/skills/weekly-report")).toBeInTheDocument();
    expect(screen.getByText(/本地正文内容/)).toBeInTheDocument();
    // 本地详情不是商店:不能出现"获取/安装"入口
    expect(screen.queryByText("获取")).not.toBeInTheDocument();
  });

  it("文件标签页展示文件树与脚本警示", async () => {
    openLocal();
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("tab", { name: /文件/ }));
    expect(screen.getByText("scripts/collect.py")).toBeInTheDocument();
    expect(screen.getByText(/含可执行脚本/)).toBeInTheDocument();
  });

  // 🔴 v7.1 Q3:底部那颗「在访达中打开」删掉了(它与「这台电脑上」块里的
  // 「打开文件夹」是同一个动作的两个入口两种叫法,而"访达"在 Windows 上是错的)。
  // 动作收进页脚,**并且传的是本体绝对路径而不是 dirSlug**——后者会被 core 解析
  // 成统一目录下的同名目录,而本体不一定在那里。原用例断言的 `{dirSlug}` 正是
  // 那条旧口径,这里跟着改成 `{path: body}`。
  it("页脚「打开文件夹」按本体绝对路径调 skill_reveal,且不再有「在访达中打开」", async () => {
    useMySkills.setState({ list: [installedView()], agentNames: new Map(), toolDirs: new Map() });
    openLocal();
    render(<DetailPanel />);
    expect(
      screen.queryByRole("button", { name: revealLabel(navigator.userAgent) }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(invokeMock).toHaveBeenCalledWith("skill_reveal", {
      args: { path: "/home/u/.agents/skills/weekly-report" },
    });
  });

  // 🔴 终审 M-3:`skill` 为 null 时页脚整个不渲染,连「打开文件夹」都没有
  //(v7.1 之前那颗是无条件渲染的)。可达路径:`useMySkills.load()` 失败,
  // 或刚装完跳过来而 list 还没刷新。降级页脚只摆这一颗——其余动作要靠
  // `InstalledSkillView` 判档,没有那一行就无从判起。
  it("这个技能不在 list 里时,页脚降级成只有一颗「打开文件夹」,而不是什么都没有", async () => {
    useMySkills.setState({ list: [], agentNames: new Map(), toolDirs: new Map() });
    openLocal();
    render(<DetailPanel />);
    // 判档才有的动作一个都不摆(没有那一行,摆出来的档位是猜的)
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(invokeMock).toHaveBeenCalledWith("skill_reveal", {
      args: { path: "/home/u/.agents/skills/weekly-report" },
    });
  });

  it("读取失败时显示可读原因", () => {
    useLocalDetail.setState({
      target: { path: "/tmp/nope" },
      detail: null,
      error: { code: "FS_NOT_A_SKILL", message: "这个文件夹不是技能,或技能描述文件缺失" },
    });
    render(<DetailPanel />);
    expect(screen.getByText(/不是技能/)).toBeInTheDocument();
  });

  it("🔴 设计 §12:动作区把行上主按钮与「…」各项全部摆出来,不必先关面板", async () => {
    // 详情面板是 modal + 遮罩,此前行上的按钮(更新/贡献更改/移除…)一个都够
    // 不到——用户必须先关掉详情才能点。这条钉住:同一份判定(installedFrom
    // 区、本地改过、远端没变 → 贡献更改)在详情面板里也要给出同一颗主按钮,
    // 「…」的各项(移除等)全部平铺,不再收进一个「更多」下拉。
    // ⚠️ 不断言「打开文件夹」——那颗按钮属于紧邻的 `WhereBlocks`「这台电脑上」
    // 块,动作区自己把这一项过滤掉了(两处摆同一颗按钮是噪音,见
    // `SkillActionsBlock` 模块头),这里只钉动作区独有的项。
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null, index: null });
    useMySkills.setState({
      list: [installedView({ localModified: true })],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      installedAgents: null,
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map(),
    });
    openLocal();
    render(<DetailPanel />);

    expect(screen.getByRole("button", { name: "贡献更改" })).toBeInTheDocument();

    // 「移除」触发的是全局状态(`useMySkills.askRemove`),不依赖 MySkillsPage
    // 在场——`RemoveDialog` 同样全局挂在 App.tsx,这正是 §12 要解决的问题本身。
    await userEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(useMySkills.getState().removePhase).toBe("confirming");
    expect(useMySkills.getState().removeTarget).toBe("weekly-report");
  });

  it("没有主按钮(未改动、库里也没有新版)时,动作区仍摆着「移除」这类恒在项", () => {
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null, index: null });
    useMySkills.setState({
      list: [installedView()],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      installedAgents: null,
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map(),
    });
    openLocal();
    render(<DetailPanel />);

    // 没有主按钮(action.kind === "none"),但「移除」这条「…」项仍在
    // ——它不依赖有没有主按钮,只要本体存在。
    expect(screen.queryByRole("button", { name: "贡献更改" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除" })).toBeInTheDocument();
  });
});

/**
 * 商店详情的动作区(设计 §12,`PanelBody` 一侧)——**v7.6 任务 2(Q44-A)整段
 * 重写**,不是照旧润色。此前这里断言"贡献更改"这颗主按钮会出现在商店详情面板,
 * 那正是 Q44-A 要消灭的现象本身:`SkillActionsBlock`(`rowAction` 驱动)与
 * `InstallPanel`(`cardState` 驱动)各摆一份自己的边框 + 主按钮,同屏出现两个
 * 看着都像主按钮的东西,是用户真机截图里那个 bug。改法见 `SkillActionsBlock.tsx`
 * / `InstallPanel.tsx` 的组件文档「两种宿主」/「actions」两节:商店宿主下
 * `SkillActionsBlock` 只贡献次要动作(打开文件夹/在技能库里查看/移除),嵌进
 * `InstallPanel` 唯一的一层页脚容器,主按钮那一格让给 `cardState`。
 */
describe("商店详情的动作区(设计 §12 + Q44-A,`PanelBody` 一侧)", () => {
  beforeEach(() => {
    useLocalDetail.setState({ target: null, detail: null, error: null });
    useMySkills.setState({
      list: null,
      agentNames: new Map(),
      installedAgents: null,
      canonicalDir: "",
      toolDirs: new Map(),
    });
  });

  it("这台电脑上装着这个技能时,商店详情面板有次要动作(移除)——此前 PanelBody 完全没有", async () => {
    const d = open();
    useMySkills.setState({
      list: [installedView({ dirSlug: d.dirSlug, localModified: true })],
      agentNames: new Map(),
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map(),
    });
    render(<DetailPanel />);

    // 「移除」是次要动作,但 v7.6 任务 3(Q44-A 原文「「…」收危险动作」)起
    // 它不再是商店宿主下的常驻可见按钮,收进「…」(`SkillRowMenu`)。
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /更多/ })).toBeInTheDocument();
  });

  it("🔴 Q44-A:商店宿主下不摆 rowAction 的主按钮(「贡献更改」)——那一格让给 InstallPanel", async () => {
    const d = open();
    useMySkills.setState({
      // localModified:true 且 section 落 installedFrom 时,rowAction 会给出
      // {kind:"contribute"}(mine 宿主下渲染成「贡献更改」)——正面构造这个
      // 档,确认它在商店宿主下确实不出现,不是靠数据本身没有主按钮蒙混过关。
      list: [installedView({ dirSlug: d.dirSlug, localModified: true })],
      agentNames: new Map(),
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map(),
    });
    render(<DetailPanel />);

    expect(screen.queryByRole("button", { name: "贡献更改" })).not.toBeInTheDocument();
  });

  it("对照组:同一份数据,「我的技能」详情(本地模式)里「贡献更改」照常渲染", async () => {
    // 与上一条断言的是同一个 rowAction 判定,只是宿主换成 mine——证明"商店
    // 宿主下不摆"确实是 host 分流的结果,不是这份数据本身判不出主按钮。
    useMySkills.setState({
      list: [installedView({ localModified: true })],
      agentNames: new Map([["claude-code", "Claude Code"]]),
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map(),
    });
    openLocal();
    render(<DetailPanel />);

    expect(screen.getByRole("button", { name: "贡献更改" })).toBeInTheDocument();
  });

  it("这台电脑上没有这个技能(纯浏览)时,「移除」不出现——没有可回答的「在哪」", () => {
    open();
    // useMySkills.list 保持 null(beforeEach 已重置):这个技能从没在这台电脑上出现过。
    render(<DetailPanel />);
    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
  });

  it("🔴 Q44-A:页脚只有一个——SkillActionsBlock 不再是独立的一层,只有 InstallPanel 那唯一一层 border-t 容器", () => {
    const d = open();
    useMySkills.setState({
      list: [installedView({ dirSlug: d.dirSlug, localModified: true })],
      agentNames: new Map(),
      canonicalDir: "/home/u/.agents/skills",
      toolDirs: new Map(),
    });
    render(<DetailPanel />);
    expect(screen.getAllByTestId("detail-footer")).toHaveLength(1);
  });

  it("Q46-A 的另一半:「已装到」不再是夹在正文与页脚之间的独立第三块(并进了「在哪」第四块)", () => {
    open();
    render(<DetailPanel />);
    // 旧组件 `InstalledScopes` 的标题「已装到」已删键(孤儿键守卫会拦这一点,
    // 这里正面断言它不出现在 DOM 里)。
    expect(screen.queryByText("已装到")).not.toBeInTheDocument();
  });
});

describe("本地没有本体的行:详情内容来自技能库(换电脑场景,2026-09-14 真机)", () => {
  beforeEach(() => {
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
    useInstall.setState({ phase: "idle", dirSlug: null, installed: new Map() });
  });

  it("面板有正文、页脚主按钮是「取回」——此前只剩一句「这个文件夹不是技能」", () => {
    // 内容由 openFromLibrary 从库索引取来,形状与本地详情一致;path 是库内相对路径
    openLocal({ path: "skills/weekly-report", skillMd: "---\nname: 周报生成\ndescription: 汇总本周工作\n---\n\n库里的正文\n" });
    useMySkills.setState({
      list: [{ ...installedView({ dirSlug: "weekly-report" }), section: "sharedTo", relation: "shared", localPresent: false, body: "", contentHash: "", localHash: "", tools: [] }],
    });
    render(<DetailPanel />);
    expect(screen.getByText("库里的正文")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取回" })).toBeInTheDocument();
    expect(screen.queryByText(/不是技能/)).toBeNull();
  });
});

describe("revealLabel", () => {
  it("按平台挑选文案", () => {
    expect(revealLabel("Mozilla (Macintosh; Mac OS X)")).toBe("在访达中打开");
    expect(revealLabel("Mozilla (Windows NT 10.0)")).toBe("在资源管理器中打开");
    expect(revealLabel("Mozilla (X11; Linux x86_64)")).toBe("在文件管理器中打开");
  });
});

describe("标签展示(M5 任务 3)", () => {
  beforeEach(() => {
    // 上一个 describe 留下的本地详情 target 会让面板走本地分支,商店详情渲染不出来
    useLocalDetail.setState({ target: null, detail: null, error: null });
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
  });

  it("有标签时在元信息区展示", () => {
    open({ tags: ["办公", "汇报"] });
    render(<DetailPanel />);
    expect(screen.getByText("办公、汇报")).toBeInTheDocument();
  });

  it("没有标签时整栏不出现", () => {
    open();
    render(<DetailPanel />);
    expect(screen.queryByText("标签")).not.toBeInTheDocument();
  });
});

describe("作者/贡献者展示(M7 任务 2)", () => {
  beforeEach(() => {
    useLocalDetail.setState({ target: null, detail: null, error: null });
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
  });

  it("有归因时元信息区展示作者与贡献者", () => {
    open({ attribution: { author: "张三", contributors: ["李四", "王五"] } });
    render(<DetailPanel />);
    expect(screen.getByText("作者")).toBeInTheDocument();
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.getByText("李四、王五")).toBeInTheDocument();
  });

  it("没有归因时作者与贡献者整栏都不出现——不摆比编造好", () => {
    open();
    render(<DetailPanel />);
    expect(screen.queryByText("作者")).not.toBeInTheDocument();
    expect(screen.queryByText("贡献者")).not.toBeInTheDocument();
  });

  it("贡献者为空时只摆作者栏", () => {
    open({ attribution: { author: "张三", contributors: [] } });
    render(<DetailPanel />);
    expect(screen.getByText("张三")).toBeInTheDocument();
    expect(screen.queryByText("贡献者")).not.toBeInTheDocument();
  });

  it("contributorsText:3 人以内全列,超出截断为前 3 + 等 N 人(N 为总数)", () => {
    expect(contributorsText(["李四"])).toBe("李四");
    expect(contributorsText(["李四", "王五", "赵六"])).toBe("李四、王五、赵六");
    expect(contributorsText(["李四", "王五", "赵六", "孙七", "周八"])).toBe(
      "李四、王五、赵六 等 5 人",
    );
  });
});

describe("「这是我分享的」入口(v6 任务 5:作者未登记时的写回)", () => {
  beforeEach(() => {
    useStoreIndex.setState({
      detailSlug: null,
      detail: null,
      detailError: null,
      activeRepo: null,
      activeRegistry: "company",
    });
    useSession.setState({ status: "signedOut", user: null });
    // 别的用例(比如"底部安装按钮点开 agent 勾选")点过获取按钮后不会自己收尾,
    // 全局单例的 useInstall 会带着 phase:"choosing" 一路漏到后面的测试文件——
    // 这里的按钮独立于 InstallPanel,但不清空的话 InstallPanel 会一直显示
    // agent 勾选面板而不是「获取」按钮,干扰 DOM 快照与排查。
    useInstall.setState({ phase: "idle", dirSlug: null, installed: new Map() });
    invokeMock.mockClear();
  });

  const signIn = () =>
    useSession.setState({
      status: "signedIn",
      user: { login: "zhang-san", displayName: "张三", avatarUrl: "" },
    });

  it("attribution == null 且已登录 → 出现「作者未登记 · 这是我分享的」", () => {
    signIn();
    open();
    render(<DetailPanel />);
    expect(screen.getByText("作者未登记")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "这是我分享的" })).toBeInTheDocument();
  });

  it("未登录不出这个入口", () => {
    open();
    render(<DetailPanel />);
    expect(screen.queryByText("作者未登记")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "这是我分享的" })).not.toBeInTheDocument();
  });

  it("已有作者时不出这个入口,哪怕已登录", () => {
    signIn();
    open({ attribution: { author: "李四", contributors: [] } });
    render(<DetailPanel />);
    expect(screen.queryByRole("button", { name: "这是我分享的" })).not.toBeInTheDocument();
    expect(screen.getByText("作者")).toBeInTheDocument();
  });

  it("非内建源不出这个入口(哪怕已登录):claim_attribution 只有 Gitea 型的内建库支持", () => {
    signIn();
    const d = detail();
    useStoreIndex.setState({
      detailSlug: d.dirSlug,
      detail: d,
      detailError: null,
      index: {
        registryId: "custom-1",
        owner: "acme",
        repo: "skills",
        branch: "main",
        commitSha: d.commitSha,
        committedAt: d.committedAt,
        fetchedAt: Math.floor(Date.now() / 1000),
        skills: [],
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
      },
    });
    render(<DetailPanel />);
    expect(screen.queryByRole("button", { name: "这是我分享的" })).not.toBeInTheDocument();
  });

  it("点击调用 skill_claim_attribution 并带上 dirSlug", async () => {
    // 🔴 必须按命令名分发(`mockImplementation`),不能用 `mockImplementationOnce`
    // 排队"下一次调用"——`InstalledScopes` 挂载时会先打一个不相关的
    // `project_list`(v6 任务 5 真机撞过:排队的响应被那次调用吃掉,真正的
    // `skill_claim_attribution` 落进默认实现拿到 null,claim() 里读
    // `outcome.outcome` 直接抛 TypeError)。
    signIn();
    open();
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "skill_claim_attribution"
        ? {
            outcome: "shared",
            mode: "reviewRequested",
            commitSha: "new",
            reviewUrl: "http://gitea.local/skills/skills/pulls/9",
            adopted: false,
            shareName: "weekly-report",
          }
        : null,
    );
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("button", { name: "这是我分享的" }));
    await screen.findByText("已提交审核,通过后生效");
    expect(invokeMock).toHaveBeenCalledWith("skill_claim_attribution", {
      args: { dirSlug: "weekly-report", repo: undefined },
    });
  });

  it("直推成功后显示「已登记为分享者」,不顺手重载索引或详情", async () => {
    // 🔴 claim() 成功后**不**调 `useStoreIndex` 的 `openDetail`/`load` 中任何
    // 一个——两者都会换掉 `index`/`detail`,而这个组件的门槛与外层 `PanelBody`
    // 的渲染分支读的是同一份状态,一换就可能把这个组件连同刚设的 "done" 状态
    // 一起卸载(2026-08-24 本地复现两次,详见 `ClaimAttribution` 模块头)。
    // 这条用例故意不 mock `store_index`/`store_skill_detail`:如果实现回归到
    // 调用它们,对应的 invoke 断言会失败,能当场抓到回归。
    signIn();
    open();
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "skill_claim_attribution"
        ? {
            outcome: "shared",
            mode: "pushed",
            commitSha: "new",
            reviewUrl: null,
            adopted: false,
            shareName: "weekly-report",
          }
        : null,
    );
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("button", { name: "这是我分享的" }));
    await screen.findByText("已登记为分享者");
    expect(invokeMock).not.toHaveBeenCalledWith("store_index", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("store_skill_detail", expect.anything());
  });

  it("走审核后显示「已提交审核,通过后生效」,不会重新摆出按钮", async () => {
    // 走审核的那一支还没合并进默认分支,即便重载 attribution 也仍是 null——
    // 如果按钮态只看 attribution,会重新摆出来引诱用户再交一次审核。
    signIn();
    open();
    invokeMock.mockImplementation(async (cmd) =>
      cmd === "skill_claim_attribution"
        ? {
            outcome: "shared",
            mode: "reviewRequested",
            commitSha: "new",
            reviewUrl: "http://gitea.local/skills/skills/pulls/9",
            adopted: false,
            shareName: "weekly-report",
          }
        : null,
    );
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("button", { name: "这是我分享的" }));
    await screen.findByText("已提交审核,通过后生效");
    expect(screen.queryByRole("button", { name: "这是我分享的" })).not.toBeInTheDocument();
  });

  it("失败时显示错误信息,按钮恢复可点(比如已被别人抢先登记)", async () => {
    signIn();
    open();
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "skill_claim_attribution") {
        throw { code: "CONFLICT_ALREADY_ATTRIBUTED", message: "这个技能已经登记过分享者了" };
      }
      if (cmd === "project_list") return [];
      return null;
    });
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("button", { name: "这是我分享的" }));
    await screen.findByText("这个技能已经登记过分享者了");
    expect(screen.getByRole("button", { name: "这是我分享的" })).toBeInTheDocument();
  });
});

// ---- 技能广场详情态(M9 任务 5)——"详情面板不联网"的唯一破例,范围钉死在广场 ----

describe("DetailPanel(技能广场详情态)", () => {
  const plazaSkill = (over: Partial<SkillDetail> = {}): SkillDetail => ({
    name: "React 最佳实践",
    dirSlug: "react-best-practices",
    description: "覆盖 React 常见反模式",
    path: "react-best-practices",
    skillMd: "---\nname: React 最佳实践\n---\n\n## 说明\n\n正文内容\n",
    files: [{ path: "SKILL.md", size: 100 }],
    hasScripts: false,
    commitSha: "def4567890",
    committedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    tags: [],
    attribution: null,
    ...over,
  });

  function resetAll() {
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
    useLocalDetail.setState({ target: null, detail: null, error: null });
    usePlaza.setState({
      detailOwnerRepo: null,
      detailWantedName: null,
      detailSlug: null,
      detailSkills: null,
      detailStatus: "idle",
      detailError: null,
      selectedDirSlug: null,
    });
    useInstall.setState({ phase: "idle", dirSlug: null, installed: new Map() });
  }

  beforeEach(resetAll);

  it("加载中显示骨架文案", () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailStatus: "loading",
    });
    render(<DetailPanel />);
    expect(screen.getByText("正在读取技能内容…")).toBeInTheDocument();
  });

  it("失败态显示可读原因;点重试真的重新发起请求", async () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailStatus: "error",
      detailError: { code: "NET_PLAZA_DETAIL", message: "无法获取该技能库信息,请稍后重试" },
    });
    render(<DetailPanel />);
    expect(screen.getByText("无法获取该技能库信息,请稍后重试")).toBeInTheDocument();

    invokeMock.mockImplementationOnce(async (cmd) =>
      cmd === "plaza_detail" ? [plazaSkill()] : null,
    );
    await userEvent.click(screen.getByRole("button", { name: "重试" }));

    await screen.findByRole("heading", { name: "React 最佳实践" });
    expect(invokeMock).toHaveBeenCalledWith("plaza_detail", {
      args: {
        ownerRepo: "vercel-labs/skills",
        skillId: "vercel-labs/skills/react-best-practices",
        wantedName: "React 最佳实践",
      },
    });
  });

  it("成功且能定位到点击的那个技能:渲染 owner/repo 坐标与浏览器查看入口", () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    render(<DetailPanel />);

    expect(screen.getByRole("heading", { name: "React 最佳实践" })).toBeInTheDocument();
    // owner/repo 是外部真名,例外允许等宽展示;坐标行沿用既有的 repo/dirSlug@sha 格式
    expect(
      screen.getByText("vercel-labs/skills/react-best-practices"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在浏览器中查看" })).toBeInTheDocument();
  });

  it("广场详情态不出「这是我分享的」入口,哪怕已登录且 registryId 恰好等于内建源", () => {
    // `canClaimAttribution = !plaza && registryId === BUILTIN_REGISTRY_ID && signedIn`
    // ——这条用例专门孤立 `!plaza` 这一道闸:把另外两个条件都摆成"本该放行"
    // (已登录 + registryId 故意设成 BUILTIN_REGISTRY_ID),只有 `!plaza` 还拦着。
    // 广场技能是 GitHub 源,`claim_attribution` 只有 Gitea 型的内建库支持,
    // 摆出来就是一个必然报错的按钮。
    useSession.setState({
      status: "signedIn",
      user: { login: "zhang-san", displayName: "张三", avatarUrl: "" },
    });
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "x",
        committedAt: "2026-01-01T00:00:00Z",
        fetchedAt: 0,
        skills: [],
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
      } as never,
    });
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill({ attribution: null })],
      detailStatus: "ready",
    });
    render(<DetailPanel />);

    expect(screen.getByRole("heading", { name: "React 最佳实践" })).toBeInTheDocument();
    expect(screen.queryByText("作者未登记")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "这是我分享的" })).not.toBeInTheDocument();
  });

  it("点「在浏览器中查看」拼 skills.sh 的 slug 传给 open_library_url", async () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    render(<DetailPanel />);

    await userEvent.click(screen.getByRole("button", { name: "在浏览器中查看" }));
    expect(invokeMock).toHaveBeenCalledWith("open_library_url", {
      args: { url: "https://skills.sh/vercel-labs/skills/react-best-practices" },
    });
  });

  it("多技能仓且名字对不上:落到该仓技能列表,不是空白也不是随便挑一个", () => {
    const a = plazaSkill({ name: "React 最佳实践", dirSlug: "react-best-practices" });
    const b = plazaSkill({ name: "Vue 最佳实践", dirSlug: "vue-best-practices", description: "Vue 反模式" });
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "不存在的名字",
      detailSlug: "vercel-labs/skills/unknown",
      detailSkills: [a, b],
      detailStatus: "ready",
    });
    render(<DetailPanel />);

    expect(screen.getByText("这个技能库里有多个技能,请选择要查看的一个")).toBeInTheDocument();
    expect(screen.getByText("React 最佳实践")).toBeInTheDocument();
    expect(screen.getByText("Vue 最佳实践")).toBeInTheDocument();
    // 还没进详情态,不该出现安装按钮
    expect(screen.queryByRole("button", { name: "安装" })).not.toBeInTheDocument();
  });

  it("从列表里选一个之后,切到那一个的详情", async () => {
    const a = plazaSkill({ name: "React 最佳实践", dirSlug: "react-best-practices" });
    const b = plazaSkill({ name: "Vue 最佳实践", dirSlug: "vue-best-practices" });
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "不存在的名字",
      detailSlug: "vercel-labs/skills/unknown",
      detailSkills: [a, b],
      detailStatus: "ready",
    });
    render(<DetailPanel />);

    await userEvent.click(screen.getByText("Vue 最佳实践"));
    expect(screen.getByRole("heading", { name: "Vue 最佳实践" })).toBeInTheDocument();
  });

  it("名字命中且该仓只有一个技能时,直接进详情,不经过挑选列表", () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    render(<DetailPanel />);
    expect(screen.queryByText("这个技能库里有多个技能,请选择要查看的一个")).not.toBeInTheDocument();
  });

  it("底部获取区:没装过 → 安装,点了触发广场专属编排(先挂仓)", async () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") {
        return {
          agents: [
            { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", skillsDir: ".claude-code/skills", isUniversal: false, needsLink: true, disabled: false },
          ],
          canonicalDir: "~/.agents/skills",
        };
      }
      if (cmd === "plaza_ensure_repo") {
        return { key: "vercel-labs/skills", owner: "vercel-labs", repo: "skills", branch: "main", name: null, primary: false, locked: false };
      }
      if (cmd === "registry_list") return [];
      return null;
    });
    render(<DetailPanel />);

    await userEvent.click(screen.getByRole("button", { name: "安装" }));
    expect(await screen.findByText("选择要启用的 AI 工具")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("plaza_ensure_repo", { ownerRepo: "vercel-labs/skills" });
  });

  it("挂仓探测未回来前「确认安装」禁用,回来之后自动可点(M9 终审修复)", async () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    let resolveEnsureRepo: (v: unknown) => void = () => {};
    const ensureRepoPending = new Promise((resolve) => {
      resolveEnsureRepo = resolve;
    });
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") {
        return {
          agents: [
            { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", skillsDir: ".claude-code/skills", isUniversal: false, needsLink: true, disabled: false },
          ],
          canonicalDir: "~/.agents/skills",
        };
      }
      // 故意不 resolve:模拟"勾选面板已经展开,挂仓探测还在飞"这段窗口期
      if (cmd === "plaza_ensure_repo") return ensureRepoPending;
      if (cmd === "registry_list") return [];
      return null;
    });
    render(<DetailPanel />);

    await userEvent.click(screen.getByRole("button", { name: "安装" }));
    const confirm = await screen.findByRole("button", { name: "确认安装" });
    // 此时 useInstall.repo 仍是 null(挂仓探测没回来):点下去此前会带着
    // repo: null 去调 skill_install,报一句与这次点击毫无关系的"技能广场没有
    // 默认技能库"。禁用比放行后报错更诚实。
    expect(confirm).toBeDisabled();

    resolveEnsureRepo({
      key: "vercel-labs/skills",
      owner: "vercel-labs",
      repo: "skills",
      branch: "main",
      name: null,
      primary: false,
      locked: false,
    });
    await waitFor(() => expect(confirm).not.toBeDisabled());
  });

  it("已装(广场坐标) → 已在电脑上,终态点不动(v7.6 起 installed 并入 onDisk)", () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    useInstall.setState({
      installed: new Map([
        [
          "react-best-practices",
          {
            commitSha: "x",
            contentHash: "sha256:whatever",
            localModified: false,
            registryId: "plaza",
            sourceOwner: "vercel-labs",
            sourceRepo: "skills",
          },
        ],
      ]),
    });
    // 广场详情态 remoteHash 恒为空串,判定完全靠 localHash 是不是"有值"——v7.6
    // 起要显式给出本机本体的实时指纹,否则默认 undefined 会被判成「获取」。
    useMySkills.setState({
      list: [
        {
          ...installedView({ dirSlug: "react-best-practices" }),
          localPresent: true,
          localHash: "sha256:whatever",
        },
      ],
    });
    render(<DetailPanel />);
    expect(screen.getByRole("button", { name: /已在电脑上/ })).toBeDisabled();
  });

  it("同名技能装自另一个技能库(广场坐标) → 替换,不是安装/更新", () => {
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSlug: "vercel-labs/skills/react-best-practices",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    useInstall.setState({
      installed: new Map([
        [
          "react-best-practices",
          {
            commitSha: "x",
            contentHash: "sha256:whatever",
            localModified: false,
            registryId: "plaza",
            sourceOwner: "someone-else",
            sourceRepo: "other-skills",
          },
        ],
      ]),
    });
    render(<DetailPanel />);
    expect(screen.getByRole("button", { name: /^替换/ })).toBeInTheDocument();
  });

  it("Esc 优先关广场详情面板,不影响其他描述块(离线详情路径隔离)", () => {
    // 离线路径(store-index/local-detail)在这个 describe 里也维持关闭,
    // 说明广场详情态的引入没有牵动它们既有的判定顺序
    usePlaza.setState({
      detailOwnerRepo: "vercel-labs/skills",
      detailWantedName: "React 最佳实践",
      detailSkills: [plazaSkill()],
      detailStatus: "ready",
    });
    render(<DetailPanel />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useStoreIndex.getState().detailSlug).toBeNull();
    expect(useLocalDetail.getState().target).toBeNull();
  });
});
