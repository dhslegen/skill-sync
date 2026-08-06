import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StorePage } from "./StorePage";
import type { StoreIndexView, StoreSkillCard } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useRegistries } from "@/store/registries";
import { useStoreIndex } from "@/store/store-index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const card = (over: Partial<StoreSkillCard>): StoreSkillCard => ({
  name: "周报生成",
  dirSlug: "weekly-report",
  description: "汇总本周工作,按部门模板生成周报草稿",
  path: "skills/weekly-report",
  hasScripts: false,
  fileCount: 2,
  contentHash: "sha256:weekly",
  tags: [],
  author: null,
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
  curated: [],
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
    useRegistries.setState({ list: null });
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
    useInstall.setState({ installed: new Map([["weekly-report", { commitSha: "a1b2c3d4e5", contentHash: "sha256:weekly", localModified: false, registryId: "company", sourceOwner: "skills", sourceRepo: "skills" }]]) });
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
      installed: new Map([["weekly-report", { commitSha: "a1b2c3d4e5", contentHash: "sha256:weekly", localModified: false, registryId: "company", sourceOwner: "skills", sourceRepo: "skills" }]]),
    });
    render(<StorePage />);
    const done = screen.getByRole("button", { name: /已启用/ });
    expect(done).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /^安装 —/ })).toHaveLength(2);
  });

  it("装了但版本落后 → 更新", () => {
    // 这一档在任务 8 里没有数据源、只能永远显示"安装";接上 installed_list 后才真正可达
    useInstall.setState({
      installed: new Map([["weekly-report", { commitSha: "a1b2c3d4e5", contentHash: "sha256:老版本", localModified: false, registryId: "company", sourceOwner: "skills", sourceRepo: "skills" }]]),
    });
    render(<StorePage />);
    expect(screen.getByRole("button", { name: /^更新 —/ })).toBeInTheDocument();
  });

  it("装自另一个技能库的同名技能 → 替换,不是更新(M4 一源多仓)", () => {
    // 内容当然不一样,但那不是"更新"——点下去是用另一个库的同名技能替换掉现有的。
    // 标成「更新」既是假话,也会把用户引向一次没预期的替换(core 的 precheck 会拦下来
    // 要求拍板,但界面不能先撒谎再让 core 兜底)。
    useInstall.setState({
      installed: new Map([
        [
          "weekly-report",
          {
            commitSha: "zzz9999",
            contentHash: "sha256:设计库那版",
            localModified: false,
            registryId: "company",
            // 同一个源,另一个技能库
            sourceOwner: "design",
            sourceRepo: "design-skills",
          },
        ],
      ]),
    });
    render(<StorePage />);
    expect(screen.getByRole("button", { name: /^替换/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^更新 —/ })).not.toBeInTheDocument();
  });
});

describe("库切换器(M4 一源多仓)", () => {
  const twoLibraries = [
    {
      id: "company",
      name: "公司技能库",
      kind: "gitea",
      baseUrl: "http://gitea.internal:3000",
      builtin: true,
      repo: { owner: "skills", repo: "skills", branch: "main" },
      repos: [
        { key: "skills/skills", owner: "skills", repo: "skills", branch: "main", name: null, primary: true, locked: true },
        {
          key: "design/design-skills",
          owner: "design",
          repo: "design-skills",
          branch: "main",
          name: "设计部技能库",
          primary: false,
          locked: false,
        },
      ],
    },
  ];

  it("加载失败时切换器仍在:否则切到连不上的库就再也回不来", () => {
    // 2026-08-04 真机视觉自查抓到的死路——错误分支早退,把切换器一起挡掉了,
    // 界面上只剩一个「重试」,而重试的还是那个连不上的库。
    useRegistries.setState({ list: twoLibraries });
    seed({ status: "error", index: null, error: { code: "REPO_NOT_FOUND", message: "找不到对应的技能库或文件" } });
    render(<StorePage />);

    expect(screen.getByText("找不到对应的技能库或文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "公司技能库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设计部技能库" })).toBeInTheDocument();
  });

  it("首屏加载中切换器也在(同一条死路的另一半)", () => {
    useRegistries.setState({ list: twoLibraries });
    seed({ status: "loading", index: null });
    render(<StorePage />);

    expect(screen.getByRole("button", { name: "公司技能库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设计部技能库" })).toBeInTheDocument();
  });

  it("只有一个技能库时不渲染切换器:没得选的选择器是噪音", () => {
    useRegistries.setState({ list: [{ ...twoLibraries[0], repos: [twoLibraries[0].repos[0]] }] });
    render(<StorePage />);
    expect(screen.queryByRole("group", { name: "技能库来源" })).not.toBeInTheDocument();
  });

  it("追加库回退展示名,没起名时用技能库名而不是内部标识", () => {
    const unnamed = {
      ...twoLibraries[0],
      repos: [
        twoLibraries[0].repos[0],
        { ...twoLibraries[0].repos[1], name: null },
      ],
    };
    useRegistries.setState({ list: [unnamed] });
    render(<StorePage />);
    // 回退到 repo slug(design-skills),不是寻址键 design/design-skills
    expect(screen.getByRole("button", { name: "design-skills" })).toBeInTheDocument();
  });
});

describe("标签筛选(M5 任务 3)", () => {
  beforeEach(() => {
    useInstall.setState({ installed: new Map() });
    useRegistries.setState({ list: null });
  });

  const tagged = () =>
    index({
      skills: [
        card({ tags: ["办公", "汇报"] }),
        card({ name: "合同审查助手", dirSlug: "contract-review", tags: ["办公"] }),
        card({ name: "数据看板搭建", dirSlug: "data-dashboard", tags: [] }),
      ],
    });

  it("有标签时渲染标签 chip;点击过滤,再点取消", async () => {
    seed({ index: tagged(), tagFilter: null });
    render(<StorePage />);

    // 去重后的标签各一枚 chip
    const office = screen.getByRole("button", { name: "办公" });
    expect(screen.getByRole("button", { name: "汇报" })).toBeInTheDocument();

    await userEvent.click(office);
    // 只剩带「办公」的两张卡
    expect(screen.queryByText("数据看板搭建")).not.toBeInTheDocument();
    expect(screen.getByText("周报生成")).toBeInTheDocument();
    expect(screen.getByText("合同审查助手")).toBeInTheDocument();

    // 再点同一枚取消筛选
    await userEvent.click(screen.getByRole("button", { name: "办公" }));
    expect(screen.getByText("数据看板搭建")).toBeInTheDocument();
  });

  it("单选:点另一枚直接切换,不做多选并集", async () => {
    seed({ index: tagged(), tagFilter: "办公" });
    render(<StorePage />);

    await userEvent.click(screen.getByRole("button", { name: "汇报" }));

    expect(useStoreIndex.getState().tagFilter).toBe("汇报");
    expect(screen.queryByText("合同审查助手")).not.toBeInTheDocument();
    expect(screen.getByText("周报生成")).toBeInTheDocument();
  });

  it("库里一个标签都没有时,不渲染标签行", () => {
    seed(); // 默认 index 的技能全部无标签
    render(<StorePage />);
    expect(screen.queryByRole("button", { name: "办公" })).not.toBeInTheDocument();
  });

  it("切库清掉标签筛选——别的库没有这个标签,残留会把列表锁死成空", async () => {
    seed({ index: tagged(), tagFilter: "办公" });

    await useStoreIndex.getState().setRegistry("custom-1");

    expect(useStoreIndex.getState().tagFilter).toBeNull();
  });
});

describe("卡片作者展示(M7 任务 2)", () => {
  beforeEach(() => {
    useInstall.setState({ installed: new Map() });
    useRegistries.setState({ list: null });
  });

  it("有作者时卡片底部显示作者名;没有则不摆", () => {
    seed({
      index: index({
        skills: [
          card({ author: "张三" }),
          card({ name: "合同审查助手", dirSlug: "contract-review", author: null }),
        ],
      }),
    });
    render(<StorePage />);
    expect(screen.getByText("张三")).toBeInTheDocument();
    // 无作者的卡片不摆占位(界面上不会出现空短横或"未知")
    expect(screen.queryByText("未知")).not.toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });
});
