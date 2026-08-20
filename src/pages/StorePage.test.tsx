import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StorePage } from "./StorePage";
import type { PlazaSkillCard, StoreIndexView, StoreSkillCard } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { usePlaza } from "@/store/plaza";
import { useRegistries } from "@/store/registries";
import { useStoreIndex } from "@/store/store-index";
import { triggerIntersection } from "@/test/intersection-observer";

// 顶层广场"空查询"分支现在会挂载 PlazaLeaderboard(M10 任务 4),它的 useEffect
// 会真的调一次 `invoke("plaza_leaderboard")`——绝大多数用例不关心这次调用,把
// `invoke` 提到模块作用域并在每个用例前重置成"什么命令都回 undefined",效果与
// 改动前的匿名 `vi.fn()` 完全一致;只有下面「全网热门排行榜」那个 describe 需要
// 针对性配置返回值,在自己的 beforeEach 里另外 `mockImplementation`。
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));

beforeEach(() => {
  invoke.mockReset();
});

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
    // 广场搜索态测试(M9 任务 5)会把这两个字段改成 ("plaza", null);不显式带回
    // 默认值的话,那个状态会漏到后面按 seed() 建立"普通浏览"前提的用例里,
    // 让它们全部错误地渲染成广场搜索页——2026-08-12 真被这条抓到过。
    activeRegistry: "company",
    activeRepo: null,
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

describe("库切换器 · 技能广场固定档(M9 任务 5)", () => {
  const onlyCompany = [
    {
      id: "company",
      name: "公司技能库",
      kind: "gitea",
      baseUrl: "http://gitea.internal:3000",
      builtin: true,
      repo: { owner: "skills", repo: "skills", branch: "main" },
      repos: [
        { key: "skills/skills", owner: "skills", repo: "skills", branch: "main", name: null, primary: true, locked: true },
      ],
    },
  ];
  const plazaRow = (repos: { key: string; owner: string; repo: string }[] = []) => ({
    id: "plaza",
    name: "技能广场",
    kind: "github",
    baseUrl: "https://github.com",
    builtin: false,
    repo: null,
    repos: repos.map((r) => ({ ...r, branch: "main", name: null, primary: false, locked: false })),
  });

  beforeEach(() => {
    useInstall.setState({ installed: new Map() });
  });

  it("即便只有一个真实技能库,广场固定档也让切换器出现", () => {
    useRegistries.setState({ list: [...onlyCompany, plazaRow()] });
    render(<StorePage />);
    expect(screen.getByRole("group", { name: "技能库来源" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "技能广场" })).toBeInTheDocument();
  });

  it("内建源没注入配置时,广场固定档必须仍然可点", () => {
    // 2026-08-17 真机验收撞到的死路:`SourcePicker` 有一条既有早退
    // `entries.length <= 1 → null`(本意是"只有一个技能库时切换器是噪音")。
    // 内建源未注入编译期配置时 `registry::list` 给的 `repos` 是**空数组**,
    // 于是它一个条目都不产出,广场固定入口成了唯一条目 → 早退命中 →
    // **整个切换器不渲染,广场入口彻底不可达**。
    // 上面那条用例没抓到,是因为它的 `onlyCompany` fixture 带着一条 repo,
    // 把阈值"自然垫高"了——M9 任务 5 审查时的原话正是这句,而那个"自然"
    // 只在内建源已配置时成立。
    // **广场固定入口不是"一个技能库",是功能入口**:唯一条目时也必须能点。
    const unconfiguredBuiltin = [{ ...onlyCompany[0], repo: null, repos: [] }];
    useRegistries.setState({ list: [...unconfiguredBuiltin, plazaRow()] });
    render(<StorePage />);
    expect(screen.getByRole("group", { name: "技能库来源" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "技能广场" })).toBeInTheDocument();
  });

  it("加载中/出错两档,广场固定档同样在(既有教训的同款守卫)", () => {
    useRegistries.setState({ list: [...onlyCompany, plazaRow()] });
    seed({ status: "error", index: null, error: { code: "REPO_NOT_FOUND", message: "找不到对应的技能库或文件" } });
    render(<StorePage />);
    expect(screen.getByRole("button", { name: "技能广场" })).toBeInTheDocument();

    seed({ status: "loading", index: null });
    render(<StorePage />);
    expect(screen.getAllByRole("button", { name: "技能广场" }).length).toBeGreaterThan(0);
  });

  it("已挂仓子条目出现且可切换:点击后按普通库浏览(setRegistry 带广场坐标)", async () => {
    useRegistries.setState({
      list: [...onlyCompany, plazaRow([{ key: "vercel-labs/skills", owner: "vercel-labs", repo: "skills" }])],
    });
    useStoreIndex.setState({ activeRegistry: "company", activeRepo: null });
    seed();
    render(<StorePage />);

    // 展示名回退到寻址键 `owner/repo`(vercel-labs/skills 没起名),不是裸 repo slug
    // ——裸 slug 会让两个不同 owner 的同名仓完全同形(M9 终审修复,见下一条测试)
    await userEvent.click(screen.getByRole("button", { name: "vercel-labs/skills" }));
    const s = useStoreIndex.getState();
    expect(s.activeRegistry).toBe("plaza");
    expect(s.activeRepo).toBe("vercel-labs/skills");
  });

  it("两个不同 owner 的同名广场仓,子条目标签不再同形(M9 终审修复)", () => {
    useRegistries.setState({
      list: [
        ...onlyCompany,
        plazaRow([
          { key: "vercel-labs/skills", owner: "vercel-labs", repo: "skills" },
          { key: "octocat/skills", owner: "octocat", repo: "skills" },
        ]),
      ],
    });
    seed();
    render(<StorePage />);

    // 此前两者都会退到裸 repo.repo("skills"),在切换器上完全同形,只有
    // title 悬浮才分得出来;现在各自的标签就能区分。
    const a = screen.getByRole("button", { name: "vercel-labs/skills" });
    const b = screen.getByRole("button", { name: "octocat/skills" });
    expect(a).toBeInTheDocument();
    expect(b).toBeInTheDocument();
    expect(a.textContent).not.toBe(b.textContent);
    // 等宽字体展示(UI 规范:owner/repo 是 slug 形态)
    expect(a.className).toMatch(/font-mono/);
  });

  it("点击广场固定档进入搜索态:不渲染技能网格,渲染空态提示", async () => {
    useRegistries.setState({ list: [...onlyCompany, plazaRow()] });
    seed();
    render(<StorePage />);

    await userEvent.click(screen.getByRole("button", { name: "技能广场" }));
    expect(useStoreIndex.getState().activeRegistry).toBe("plaza");
    expect(useStoreIndex.getState().activeRepo).toBeNull();
    expect(screen.getByText("输入关键词搜索全网技能(至少 2 个字符)")).toBeInTheDocument();
    // 普通商店的卡片不该还在
    expect(screen.queryByText("周报生成")).not.toBeInTheDocument();
  });
});

describe("广场搜索态渲染(M9 任务 5)", () => {
  beforeEach(() => {
    useInstall.setState({ installed: new Map() });
    useRegistries.setState({ list: null });
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, index: null, status: "idle", error: null });
    usePlaza.setState({
      query: "",
      submittedQuery: "",
      results: [],
      status: "idle",
      error: null,
      // M10 任务 4:空查询分支挂载 PlazaLeaderboard,不重置这两个字段会让本
      // describe 的用例带着上一个用例(或本文件后面「全网热门排行榜」那个 describe)
      // 残留的排行榜数据渲染,读不出这里到底测的是什么状态。
      leaderboard: [],
      leaderboardStatus: "idle",
    });
  });

  it("还没提交过搜索且没有热门数据:退回原来的空态提示,不渲染网格", async () => {
    // 挂载瞬间(effect 还没跑完)先走 loading 分支;core 侧 invoke 默认回
    // undefined,`?? []` 兜底成空数组,最终稳定态才是这句空态提示——用 findByText
    // 等它落定,不断言"挂载那一刻"的过渡态(有热门数据的分支见下面
    // 「全网热门排行榜(M10 任务 4)」describe)。
    render(<StorePage />);
    expect(await screen.findByText("输入关键词搜索全网技能(至少 2 个字符)")).toBeInTheDocument();
  });

  it("搜索失败:失败态文案,不是错误弹窗", () => {
    usePlaza.setState({ submittedQuery: "react", status: "error", results: [] });
    render(<StorePage />);
    expect(screen.getByText("技能广场暂时连不上,不影响公司技能库")).toBeInTheDocument();
  });

  it("有结果:渲染卡片网格,点击调 usePlaza.openDetail", async () => {
    const card = {
      name: "React 最佳实践",
      slug: "vercel-labs/skills/react-best-practices",
      ownerRepo: "vercel-labs/skills",
      installs: 625414,
      isOfficial: false,
    };
    usePlaza.setState({ submittedQuery: "react", status: "ready", results: [card] });
    const openDetail = vi.fn();
    usePlaza.setState({ openDetail });
    render(<StorePage />);

    await userEvent.click(screen.getByRole("button", { name: "React 最佳实践" }));
    expect(openDetail).toHaveBeenCalledWith(
      "vercel-labs/skills",
      "React 最佳实践",
      "vercel-labs/skills/react-best-practices",
    );
  });

  it("首次搜索(手上还没结果)给明确的加载提示", () => {
    usePlaza.setState({ submittedQuery: "react", status: "loading", results: [] });
    render(<StorePage />);
    expect(screen.getByText("正在搜索…")).toBeInTheDocument();
  });

  it("🔴 已有结果时再搜:旧结果留着不闪空(转圈在顶栏的搜索按钮上)", () => {
    const card = {
      name: "React 最佳实践",
      slug: "vercel-labs/skills/react-best-practices",
      ownerRepo: "vercel-labs/skills",
      installs: 625414,
      isOfficial: false,
    };
    usePlaza.setState({ submittedQuery: "react", status: "loading", results: [card] });
    render(<StorePage />);

    expect(screen.getByRole("button", { name: "React 最佳实践" })).toBeInTheDocument();
    expect(screen.queryByText("正在搜索…")).not.toBeInTheDocument();
  });

  it("搜过了但零结果:复用「没有匹配」空态,不新造一份措辞", () => {
    usePlaza.setState({ submittedQuery: "找不到的东西", status: "ready", results: [] });
    render(<StorePage />);
    expect(screen.getByText("没有匹配「找不到的东西」的技能。")).toBeInTheDocument();
  });
});

describe("全网热门排行榜(M10 任务 4)", () => {
  const trending: PlazaSkillCard[] = [
    {
      name: "find-skills",
      slug: "vercel-labs/skills/find-skills",
      ownerRepo: "vercel-labs/skills",
      installs: 2_981_876,
      isOfficial: true,
    },
    {
      name: "grill-me",
      slug: "mattpocock/skills/grill-me",
      ownerRepo: "mattpocock/skills",
      installs: 877_815,
      isOfficial: false,
    },
  ];

  beforeEach(() => {
    useInstall.setState({ installed: new Map() });
    useRegistries.setState({ list: null });
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, index: null, status: "idle", error: null });
    usePlaza.setState({
      query: "",
      submittedQuery: "",
      results: [],
      status: "idle",
      error: null,
      leaderboard: [],
      leaderboardStatus: "idle",
    });
  });

  it("有热门数据:渲染「全网热门」标题、卡片网格与官方徽标,点击调 usePlaza.openDetail", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "plaza_leaderboard" ? trending : undefined));
    const openDetail = vi.fn();
    usePlaza.setState({ openDetail });
    render(<StorePage />);

    expect(await screen.findByText("全网热门")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "find-skills" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "grill-me" })).toBeInTheDocument();
    // 只有第一条(isOfficial: true)带徽标——第二条没有这个字段,不该也长出一个。
    expect(screen.getAllByText("官方")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "find-skills" }));
    expect(openDetail).toHaveBeenCalledWith(
      "vercel-labs/skills",
      "find-skills",
      "vercel-labs/skills/find-skills",
    );
  });

  it("core 侧降级为空列表:退回原来的「输入关键词搜索」提示,不是错误弹窗", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "plaza_leaderboard" ? [] : undefined));
    render(<StorePage />);

    expect(await screen.findByText("输入关键词搜索全网技能(至少 2 个字符)")).toBeInTheDocument();
    expect(screen.queryByText("全网热门")).not.toBeInTheDocument();
  });

  it("提交一次搜索就切到搜索结果,排行榜网格不再渲染", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "plaza_leaderboard" ? trending : undefined));
    const { rerender } = render(<StorePage />);
    expect(await screen.findByText("全网热门")).toBeInTheDocument();

    // 用 rerender(而不是再调一次 render)替换同一棵树:后者会在文档里叠加第二份,
    // 读不出"排行榜有没有真的让位",这条测试的关键就是它不再存在,不是"还有别的"。
    // 判据是 `submittedQuery`(已提交的查询词)而不是输入框里的 `query`
    // ——搜索改成显式触发之后,光打字不该让排行榜消失。
    usePlaza.setState({ submittedQuery: "react", status: "ready", results: [] });
    rerender(<StorePage />);
    expect(screen.queryByText("全网热门")).not.toBeInTheDocument();
    expect(screen.getByText("没有匹配「react」的技能。")).toBeInTheDocument();
  });

  // 反向路径(与上一条互补,2026-08-17 审查补测):清空搜索框应该回到排行榜,
  // 不是停留在搜索结果那一档、也不是卡在空白——之前只测了"输入切走",没测过
  // "清空切回来"。
  it("清空搜索框重新渲染排行榜", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "plaza_leaderboard" ? trending : undefined));
    usePlaza.setState({ submittedQuery: "react", status: "ready", results: [] });
    const { rerender } = render(<StorePage />);
    expect(screen.getByText("没有匹配「react」的技能。")).toBeInTheDocument();
    expect(screen.queryByText("全网热门")).not.toBeInTheDocument();

    usePlaza.setState({ submittedQuery: "", status: "idle", results: [] });
    rerender(<StorePage />);

    expect(await screen.findByText("全网热门")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "find-skills" })).toBeInTheDocument();
    expect(screen.queryByText("没有匹配「react」的技能。")).not.toBeInTheDocument();
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

// ============================================================ 滚动加载(2026-08-19 追加)
//
// 广场列表"滚到底自动加载更多"(对齐 skills.sh 官网观感)。它是**纯前端切片**:
// 数据整批在手里,滚动只决定渲染多少张卡片,不发任何请求——所以这里全部用
// `usePlaza.setState` 直接喂数据,没有 invoke 的戏份。
//
// jsdom 没有 IntersectionObserver,全局 setup 装了一个不会自己触发的替身
// (`src/test/intersection-observer.ts`),这里显式 `triggerIntersection()` 模拟滚到底。
describe("广场列表滚动加载", () => {
  const PAGE = 24; // 与 StorePage.tsx 的 PLAZA_PAGE_SIZE 对齐

  const many = (count: number, prefix = "技能"): PlazaSkillCard[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `${prefix}${i + 1}`,
      slug: `owner/repo/${prefix}-${i + 1}`,
      ownerRepo: "owner/repo",
      installs: count - i,
      isOfficial: false,
    }));

  // 这一档里能出现的 role="button" 只有广场卡片本身:registries 为 null 时
  // SourcePicker 整个不渲染(见它自己的早退),所以按钮数就是卡片数。
  const cardCount = () => screen.queryAllByRole("button").length;

  const scrollToBottom = async (isIntersecting = true) => {
    await act(async () => {
      triggerIntersection(isIntersecting);
    });
  };

  beforeEach(() => {
    useInstall.setState({ installed: new Map() });
    useRegistries.setState({ list: null });
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, index: null, status: "idle", error: null });
    usePlaza.setState({
      submittedQuery: "react",
      results: [],
      status: "ready",
      error: null,
      leaderboard: [],
      leaderboardStatus: "ready",
    });
  });

  it("初始只渲染第一批,不是把全部结果一次铺上去", () => {
    usePlaza.setState({ results: many(50) });
    render(<StorePage />);

    expect(cardCount()).toBe(PAGE);
    expect(screen.getByRole("button", { name: "技能24" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "技能25" })).not.toBeInTheDocument();
    // 还有没渲染的,哨兵就得在——它是"还能再加载"的唯一出口
    expect(screen.getByTestId("plaza-scroll-sentinel")).toBeInTheDocument();
  });

  it("滚到底(哨兵进入视口)追加下一批", async () => {
    usePlaza.setState({ results: many(50) });
    render(<StorePage />);

    await scrollToBottom();

    expect(cardCount()).toBe(PAGE * 2);
    expect(screen.getByRole("button", { name: "技能48" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "技能49" })).not.toBeInTheDocument();
  });

  it("哨兵回调说「没进视口」时一条都不追加", async () => {
    // 真实 IntersectionObserver 在 observe() 那一刻就会用当前状态回调一次
    // (哨兵在首屏之下时是 false)。不查 isIntersecting 的话,一挂载就白多渲染一批。
    usePlaza.setState({ results: many(50) });
    render(<StorePage />);

    await scrollToBottom(false);

    expect(cardCount()).toBe(PAGE);
  });

  it("🔴 换一批卡片(改搜索词)后计数重置回第一批", async () => {
    usePlaza.setState({ results: many(50) });
    const { rerender } = render(<StorePage />);
    await scrollToBottom();
    expect(cardCount()).toBe(PAGE * 2);

    // 换搜索词并重新提交 = 换一份结果数组;不重置的话用户会看到"上一次滚到的条数"
    usePlaza.setState({ submittedQuery: "vue", results: many(50, "别的技能") });
    rerender(<StorePage />);

    expect(cardCount()).toBe(PAGE);
    expect(screen.getByRole("button", { name: "别的技能1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "别的技能25" })).not.toBeInTheDocument();
  });

  it("清空搜索框切回热门榜也从第一批开始", async () => {
    usePlaza.setState({ results: many(50) });
    const { rerender } = render(<StorePage />);
    await scrollToBottom();
    expect(cardCount()).toBe(PAGE * 2);

    usePlaza.setState({ submittedQuery: "", results: [], status: "idle", leaderboard: many(50, "热门") });
    rerender(<StorePage />);

    expect(cardCount()).toBe(PAGE);
    expect(screen.getByRole("button", { name: "热门1" })).toBeInTheDocument();
  });

  it("全部渲染完之后哨兵撤掉,再触发也不会多出东西", async () => {
    usePlaza.setState({ results: many(30) });
    render(<StorePage />);

    await scrollToBottom();
    expect(cardCount()).toBe(30);
    // 加载完就不摆哨兵,也不摆"没有更多了"这类噪音文案
    expect(screen.queryByTestId("plaza-scroll-sentinel")).not.toBeInTheDocument();

    await scrollToBottom();
    expect(cardCount()).toBe(30);
  });

  it("结果本来就不足一批时,哨兵一开始就不摆", () => {
    usePlaza.setState({ results: many(5) });
    render(<StorePage />);

    expect(cardCount()).toBe(5);
    expect(screen.queryByTestId("plaza-scroll-sentinel")).not.toBeInTheDocument();
  });

  it("环境没有 IntersectionObserver 时一次全渲染,不把剩下的条目永久藏起来", () => {
    // 老 webview 的兜底:界面上没有「加载更多」按钮可点,滚动是唯一出口,
    // 出口没了就只能全铺出来——列表长一点无所谓,藏起来才是死路。
    const saved = globalThis.IntersectionObserver;
    // @ts-expect-error 故意删掉全局能力,模拟不支持的环境
    delete globalThis.IntersectionObserver;
    try {
      usePlaza.setState({ results: many(50) });
      render(<StorePage />);
      expect(cardCount()).toBe(50);
    } finally {
      Object.defineProperty(globalThis, "IntersectionObserver", { value: saved, configurable: true, writable: true });
    }
  });
});
