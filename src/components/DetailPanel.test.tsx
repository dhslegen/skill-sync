import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { contributorsText, DetailPanel, revealLabel, stripFrontmatter } from "./DetailPanel";
import type { LocalSkillDetail, SkillDetail } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useStoreIndex } from "@/store/store-index";

// agent 探测走 IPC:mock 掉才能让"点安装 → 展开勾选"这条路走通。
// spy 形式暴露出来,本地详情的 reveal 测试要断言调用参数。
const invokeMock = vi.fn(async (cmd: string, args?: unknown) => {
  void args; // 只为让 spy 把参数记进 calls;实现本身按 cmd 分发
  if (cmd === "agents_detected") {
    return {
      agents: [
        { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
      ],
      canonicalDir: "~/.agents/skills",
    };
  }
  if (cmd === "installed_list") return [];
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

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

  it("渲染技能名、等宽坐标与短版本标识", () => {
    open();
    render(<DetailPanel />);
    expect(screen.getByRole("heading", { name: "周报生成" })).toBeInTheDocument();
    // 版本标识只以 7 位短码露出(terminology.md:不解释)
    expect(screen.getByText("skills/weekly-report @ a1b2c3d")).toBeInTheDocument();
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
      detailError: { code: "REPO_NOT_FOUND", message: "这个技能已不在公司技能库中,请返回列表刷新后再试" },
    });
    render(<DetailPanel />);
    expect(screen.getByText(/请返回列表刷新后再试/)).toBeInTheDocument();
  });
});

describe("详情面板底部的获取区", () => {
  beforeEach(() => {
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    useInstall.setState({ phase: "idle", dirSlug: null, installed: new Map() });
  });

  it("装了且内容一致 → 已启用(终态,点不动)", () => {
    const d = open();
    useStoreIndex.setState({
      index: { ...useStoreIndex.getState().index!, skills: [
        { name: d.name, dirSlug: d.dirSlug, description: "", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:same", tags: [], author: null },
      ] },
    });
    useInstall.setState({
      installed: new Map([[d.dirSlug, { commitSha: "x", contentHash: "sha256:same", localModified: false, registryId: "company", sourceOwner: "skills", sourceRepo: "skills" }]]),
    });
    render(<DetailPanel />);
    expect(screen.getByRole("button", { name: /已启用/ })).toBeDisabled();
  });

  it("装了但内容落后 → 「更新」且可点(曾经这里只有两档,点了毫无反应)", async () => {
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
    render(<DetailPanel />);

    const button = screen.getByRole("button", { name: /^更新/ });
    expect(button).toBeEnabled();
    await userEvent.click(button);
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
  useLocalDetail.setState({ target: { dirSlug: d.dirSlug }, detail: d, error: null, revealError: null });
  return d;
}

describe("DetailPanel(本地详情模式)", () => {
  beforeEach(() => {
    useStoreIndex.setState({ detailSlug: null, detail: null, detailError: null });
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
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

  it("「在访达中打开」按当前 target 调 skill_reveal", async () => {
    openLocal();
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("button", { name: revealLabel(navigator.userAgent) }));
    expect(invokeMock).toHaveBeenCalledWith("skill_reveal", {
      args: { dirSlug: "weekly-report" },
    });
  });

  it("读取失败时显示可读原因", () => {
    useLocalDetail.setState({
      target: { path: "/tmp/nope" },
      detail: null,
      error: { code: "FS_NOT_A_SKILL", message: "这个文件夹不是技能,或技能描述文件缺失" },
      revealError: null,
    });
    render(<DetailPanel />);
    expect(screen.getByText(/不是技能/)).toBeInTheDocument();
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
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
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
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
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
