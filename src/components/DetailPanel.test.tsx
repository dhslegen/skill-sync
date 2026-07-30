import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DetailPanel, stripFrontmatter } from "./DetailPanel";
import type { SkillDetail } from "@/lib/ipc";
import { useStoreIndex } from "@/store/store-index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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

  it("底部安装按钮置灰并说明原因", () => {
    open();
    render(<DetailPanel />);
    const install = screen.getByRole("button", { name: /^安装 —/ });
    expect(install).toBeDisabled();
    expect(screen.getByText(/获取功能将在下个版本开放/)).toBeInTheDocument();
  });

  it("关闭按钮收起面板", async () => {
    open();
    render(<DetailPanel />);
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(useStoreIndex.getState().detailSlug).toBeNull();
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
