import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StorePage } from "./StorePage";
import type { StoreIndexView, StoreSkillCard } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useStoreIndex } from "@/store/store-index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const card = (over: Partial<StoreSkillCard>): StoreSkillCard => ({
  name: "周报生成",
  dirSlug: "weekly-report",
  description: "汇总本周工作,按部门模板生成周报草稿",
  path: "skills/weekly-report",
  hasScripts: false,
  fileCount: 2,
  ...over,
});

const index = (over: Partial<StoreIndexView> = {}): StoreIndexView => ({
  registryId: "company",
  owner: "skills",
  repo: "skills",
  branch: "main",
  commitSha: "a1b2c3d4e5",
  committedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  fetchedAt: Math.floor(Date.now() / 1000) - 180,
  skills: [
    card({}),
    card({ name: "合同审查助手", dirSlug: "contract-review", description: "逐条检查风险条款" }),
    card({ name: "数据看板搭建", dirSlug: "data-dashboard", description: "生成可交互看板", hasScripts: true }),
  ],
  skipped: [],
  fromCache: false,
  offline: false,
  ...over,
});

function seed(over: Partial<Parameters<typeof useStoreIndex.setState>[0]> = {}) {
  useStoreIndex.setState({
    status: "ready",
    index: index(),
    error: null,
    query: "",
    filter: "all",
    installed: new Set(),
    detailSlug: null,
    detail: null,
    detailError: null,
    ...over,
  });
}

describe("StorePage", () => {
  beforeEach(() => {
    seed();
    useInstall.setState({ installed: new Map() });
  });

  it("首屏就是搜索结果与卡片,没有 hero 区", () => {
    render(<StorePage />);
    expect(screen.getAllByRole("button", { name: /周报生成|合同审查助手|数据看板搭建/ })).toHaveLength(3);
  });

  it("卡片展示等宽 slug 与相对更新时间", () => {
    render(<StorePage />);
    expect(screen.getByText("skills/weekly-report")).toBeInTheDocument();
    // C6:非研发只看"更新于 x 天前"
    expect(screen.getAllByText("更新于 3 天前").length).toBeGreaterThan(0);
  });

  it("含可执行脚本的技能有警示角标,其余没有", () => {
    render(<StorePage />);
    const warned = screen.getAllByTitle(/含有可执行脚本|带有可执行脚本/);
    expect(warned).toHaveLength(1);
  });

  it("汇总条给出技能数、技能库名与刷新时间", () => {
    render(<StorePage />);
    expect(screen.getByText("3 个技能 · 来自 skills · 3 分钟前刷新")).toBeInTheDocument();
  });

  it("搜索只留命中的卡片", () => {
    seed({ query: "合同" });
    render(<StorePage />);
    expect(screen.getByText("skills/contract-review")).toBeInTheDocument();
    expect(screen.queryByText("skills/weekly-report")).not.toBeInTheDocument();
  });

  it("搜不到时给的是带查询词的空状态,不是错误", () => {
    seed({ query: "不存在的东西" });
    render(<StorePage />);
    expect(screen.getByText("没有匹配「不存在的东西」的技能。")).toBeInTheDocument();
  });

  it("技能库为空时给一句话空状态", () => {
    seed({ index: index({ skills: [] }) });
    render(<StorePage />);
    expect(screen.getByText("这个技能库里还没有技能。")).toBeInTheDocument();
  });

  it("切到「已安装」而一个都没装时,不能谎称技能库是空的", () => {
    // M1 的 installed 恒为空集,所以这是**用户点一下就能撞到**的路径:
    // 技能库里有 3 个技能,说"这个技能库里还没有技能"是错的。
    seed({ filter: "installed", installed: new Set() });
    render(<StorePage />);
    expect(screen.queryByText("这个技能库里还没有技能。")).not.toBeInTheDocument();
    expect(screen.getByText("这一档下暂时没有技能。")).toBeInTheDocument();
  });

  it("筛选档下的搜索无结果仍然优先报搜索词", () => {
    seed({ filter: "available", query: "不存在的东西" });
    render(<StorePage />);
    expect(screen.getByText("没有匹配「不存在的东西」的技能。")).toBeInTheDocument();
  });

  it("筛选档切换生效", async () => {
    useInstall.setState({ installed: new Map([["weekly-report", { commitSha: "a1b2c3d4e5", localModified: false }]]) });
    render(<StorePage />);
    await userEvent.click(screen.getByRole("button", { name: "已安装" }));
    expect(useStoreIndex.getState().filter).toBe("installed");
  });

  it("离线时给提示条与重试,不弹错误框", () => {
    seed({ index: index({ offline: true }) });
    render(<StorePage />);
    // 关键:内容照旧可浏览
    expect(screen.getByText("skills/weekly-report")).toBeInTheDocument();
    expect(screen.getByText(/连不上公司技能库/)).toBeInTheDocument();
    // 提示里必须有下一步动作
    expect(screen.getByText(/公司内网或 VPN/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重试" }).length).toBeGreaterThan(0);
  });

  it("离线时汇总条不谎称刚刷新过", () => {
    seed({ index: index({ offline: true }) });
    render(<StorePage />);
    expect(screen.getByText(/显示的是上次获取到的内容/)).toBeInTheDocument();
    expect(screen.queryByText(/分钟前刷新/)).not.toBeInTheDocument();
  });

  it("完全拿不到索引时给可读错误 + 重试按钮", async () => {
    seed({
      index: null,
      status: "error",
      error: { code: "NET_UNREACHABLE", message: "连不上公司技能库,请确认已接入公司内网或 VPN" },
    });
    render(<StorePage />);
    expect(screen.getByText(/请确认已接入公司内网或 VPN/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
  });

  it("有技能因信息不完整被跳过时,如实告知而不是让它凭空消失", () => {
    seed({
      index: index({ skipped: [{ path: "skills/bad-one/SKILL.md", reason: "缺少必填项:description" }] }),
    });
    render(<StorePage />);
    expect(screen.getByText("1 个技能因信息不完整未能显示")).toBeInTheDocument();
  });

  it("点卡片打开详情面板", async () => {
    const openDetail = vi.fn();
    seed();
    useStoreIndex.setState({ openDetail });
    render(<StorePage />);
    await userEvent.click(screen.getByRole("button", { name: "周报生成" }));
    expect(openDetail).toHaveBeenCalledWith("weekly-report");
  });

  it("卡片上的安装按钮把人带进详情,而不是直接开装", async () => {
    const openDetail = vi.fn();
    useStoreIndex.setState({ openDetail });
    render(<StorePage />);

    // 用 /^安装 —/ 而不是 /安装/:后者会把「未安装」这个筛选 chip 一起捞进来
    const buttons = screen.getAllByRole("button", { name: /^安装 —/ });
    expect(buttons).toHaveLength(3);
    await userEvent.click(buttons[0]);
    expect(openDetail).toHaveBeenCalledWith("weekly-report");
    // 只能开一次:按钮的点击会冒泡到卡片,两边都接 onClick 就会发两次 IPC
    expect(openDetail).toHaveBeenCalledTimes(1);
  });
});

describe("卡片安装状态", () => {
  beforeEach(() => {
    seed();
    useInstall.setState({ installed: new Map() });
  });

  it("没装过 → 安装", () => {
    render(<StorePage />);
    expect(screen.getAllByRole("button", { name: /^安装 —/ })).toHaveLength(3);
  });

  it("装了且版本一致 → 已启用(且点不动,那是终态)", () => {
    useInstall.setState({
      installed: new Map([["weekly-report", { commitSha: "a1b2c3d4e5", localModified: false }]]),
    });
    render(<StorePage />);
    const done = screen.getByRole("button", { name: /已启用/ });
    expect(done).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /^安装 —/ })).toHaveLength(2);
  });

  it("装了但版本落后 → 更新", () => {
    // 这一档在任务 8 里没有数据源、只能永远显示"安装";接上 installed_list 后才真正可达
    useInstall.setState({
      installed: new Map([["weekly-report", { commitSha: "老版本", localModified: false }]]),
    });
    render(<StorePage />);
    expect(screen.getByRole("button", { name: /^更新 —/ })).toBeInTheDocument();
  });
});
