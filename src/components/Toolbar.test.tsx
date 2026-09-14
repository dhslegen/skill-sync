import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Toolbar } from "./Toolbar";
import { useInstall } from "@/store/install";
import { useMineSearch } from "@/store/mine-search";
import { useMySkills } from "@/store/my-skills";
import { useProjects } from "@/store/project";
import { usePlaza } from "@/store/plaza";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// 真身留一份:下面有用例会把它替换成 spy,不还原的话会污染后面的用例。
const realSubmitSearch = usePlaza.getState().submitSearch;

function reset() {
  vi.mocked(invoke).mockClear();
  useUi.setState({ page: "store" });
  useStoreIndex.setState({ activeRegistry: "company", activeRepo: null, query: "", status: "ready" });
  usePlaza.setState({ query: "", submittedQuery: "", status: "idle", results: [], error: null });
  usePlaza.setState({ submitSearch: realSubmitSearch });
  useMineSearch.setState({ query: "" });
}

describe("Toolbar 搜索框在技能广场搜索态的接线(M9 任务 5)", () => {
  beforeEach(reset);

  it("普通浏览态:输入进商店的 query,不碰广场状态", () => {
    render(<Toolbar />);
    fireEvent.change(screen.getByTestId("store-search"), { target: { value: "周报" } });
    expect(useStoreIndex.getState().query).toBe("周报");
    expect(usePlaza.getState().query).toBe("");
  });

  it("广场搜索态:同一个搜索框改喂广场的查询状态", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    render(<Toolbar />);
    fireEvent.change(screen.getByTestId("store-search"), { target: { value: "react" } });
    expect(usePlaza.getState().query).toBe("react");
    // 商店的 query 没被顺手改掉——回到普通浏览时不该带着广场搜过的词
    expect(useStoreIndex.getState().query).toBe("");
  });

  it("广场搜索态:搜索框显示的是广场的查询词,不是商店的", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, query: "普通浏览的残留" });
    usePlaza.setState({ query: "react" });
    render(<Toolbar />);
    expect(screen.getByTestId("store-search")).toHaveValue("react");
  });

  it("广场搜索态:输入框改的是 query,一个请求都不发(显式触发之后)", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const submitSearch = vi.fn();
    usePlaza.setState({ submitSearch });
    render(<Toolbar />);

    fireEvent.change(screen.getByTestId("store-search"), { target: { value: "react" } });

    expect(usePlaza.getState().query).toBe("react");
    expect(submitSearch).not.toHaveBeenCalled();
    // 连 IPC 通道也要断言:store 里若绕开 submitSearch 直接发请求(比如"顺手"
    // 恢复输入即搜),上面那句 spy 断言看不见,只有这句拦得住。
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("plaza_search", expect.anything());
  });

  it("广场搜索态:回车提交搜索", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const submitSearch = vi.fn();
    usePlaza.setState({ submitSearch });
    render(<Toolbar />);

    const input = screen.getByTestId("store-search");
    fireEvent.change(input, { target: { value: "react" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(submitSearch).toHaveBeenCalledWith("react");
  });

  // 2026-08-19 用户看过真机后拍板:**不摆「搜索」按钮**(Demo 里没有这个控件,
  // 多摆一个就与整体割裂)。回车是唯一的新增触发口,转圈挂在既有的刷新按钮上。
  it("顶栏控件集合:广场档与公司技能库档完全一致,没有为搜索新造按钮", () => {
    // 不写死"叫某某名字的按钮不存在"(改个文案那条守卫就失效),而是钉住两档的
    // 控件集合相等——广场档多出任何一个控件都会红。
    const labelsOf = (c: HTMLElement) =>
      Array.from(c.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));

    useStoreIndex.setState({ activeRegistry: "company", activeRepo: null });
    const company = render(<Toolbar />);
    const companyLabels = labelsOf(company.container);
    company.unmount();

    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const plaza = render(<Toolbar />);
    expect(labelsOf(plaza.container)).toEqual(companyLabels);
  });

  it("🔴 搜索中回车照样能提交(防连击在 store 里按词判定,界面不禁用任何东西)", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const submitSearch = vi.fn();
    usePlaza.setState({ submitSearch, query: "react", status: "loading" });
    render(<Toolbar />);

    const input = screen.getByTestId("store-search");
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "vue" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(submitSearch).toHaveBeenCalledWith("vue");
  });

  it("刷新按钮在广场搜索态走同一个提交入口(不再靠输入即触发)", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const submitSearch = vi.fn();
    usePlaza.setState({ submitSearch, query: "react" });
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "重新获取技能列表" }));
    expect(submitSearch).toHaveBeenCalledTimes(1);
  });

  it("搜索中的加载指示挂在既有的刷新按钮上(不为它新造控件)", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, status: "ready" });
    usePlaza.setState({ status: "loading" });
    render(<Toolbar />);
    const refresh = screen.getByRole("button", { name: "重新获取技能列表" });
    expect(refresh.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });
});

describe("Toolbar 的「我的技能」页搜索框(v7 任务 7)", () => {
  beforeEach(reset);

  it("「我的技能」页也渲染搜索框(brief DoD)", () => {
    useUi.setState({ page: "mine" });
    render(<Toolbar />);
    expect(screen.getByPlaceholderText(/搜索/)).toBeInTheDocument();
  });

  it("输入进 useMineSearch,不碰商店/广场的 query", () => {
    useUi.setState({ page: "mine" });
    render(<Toolbar />);
    fireEvent.change(screen.getByTestId("store-search"), { target: { value: "周报" } });
    expect(useMineSearch.getState().query).toBe("周报");
    expect(useStoreIndex.getState().query).toBe("");
    expect(usePlaza.getState().query).toBe("");
  });

  it("回车没有额外副作用(纯本地过滤,不传 onSubmit)", () => {
    useUi.setState({ page: "mine" });
    render(<Toolbar />);
    const input = screen.getByTestId("store-search");
    fireEvent.change(input, { target: { value: "周报" } });
    // 不抛错、不改变任何其他 store 的状态即为通过
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useMineSearch.getState().query).toBe("周报");
  });
});

// 0.6.x(2026-09-14 用户拍板「每页各自的语义」):同一个图标在三页做同一件事是不诚实的。
// 每页刷新自己展示的东西,名字说清刷的是什么;设置页不展示可刷新的内容,不摆按钮。
describe("Toolbar 刷新按钮按页各自的语义", () => {
  beforeEach(reset);

  const REAL = {
    storeLoad: useStoreIndex.getState().load,
    refreshInstalled: useInstall.getState().refreshInstalled,
    mineLoad: useMySkills.getState().load,
    ensure: useMySkills.getState().ensureShareableIndexes,
    projectsLoad: useProjects.getState().load,
  };
  function spies() {
    const s = {
      storeLoad: vi.fn(async () => {}),
      refreshInstalled: vi.fn(async () => {}),
      mineLoad: vi.fn(async () => {}),
      ensure: vi.fn(async () => {}),
      projectsLoad: vi.fn(async () => {}),
    };
    useStoreIndex.setState({ load: s.storeLoad });
    useInstall.setState({ refreshInstalled: s.refreshInstalled });
    useMySkills.setState({ load: s.mineLoad, ensureShareableIndexes: s.ensure, loading: false });
    useProjects.setState({ load: s.projectsLoad, loading: false });
    return s;
  }
  afterEach(() => {
    useStoreIndex.setState({ load: REAL.storeLoad });
    useInstall.setState({ refreshInstalled: REAL.refreshInstalled });
    useMySkills.setState({ load: REAL.mineLoad, ensureShareableIndexes: REAL.ensure });
    useProjects.setState({ load: REAL.projectsLoad });
  });

  it("商店页:强制重建当前技能库索引,并重读已装状态", () => {
    const s = spies();
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "重新获取技能列表" }));
    expect(s.storeLoad).toHaveBeenCalledWith(true);
    expect(s.refreshInstalled).toHaveBeenCalledTimes(1);
    expect(s.mineLoad).not.toHaveBeenCalled();
    expect(s.projectsLoad).not.toHaveBeenCalled();
  });

  it("我的技能页:重新扫描本地,再检查库里有没有新版(不强制重建,不碰项目)", async () => {
    const s = spies();
    useMySkills.setState({
      list: [
        { dirSlug: "a", section: "shareable" },
        { dirSlug: "b", section: "installedFrom" },
      ] as never,
    });
    useUi.setState({ page: "mine" });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "重新扫描并检查更新" }));
    await waitFor(() => expect(s.ensure).toHaveBeenCalledWith(["a"]));
    expect(s.mineLoad).toHaveBeenCalledTimes(1);
    expect(s.storeLoad).toHaveBeenCalledWith(false);
    expect(s.projectsLoad).not.toHaveBeenCalled();
  });

  it("我的技能页:转圈跟着本地扫描走,不跟商店索引", () => {
    spies();
    useStoreIndex.setState({ status: "ready" });
    useMySkills.setState({ loading: true });
    useUi.setState({ page: "mine" });
    render(<Toolbar />);
    const btn = screen.getByRole("button", { name: "重新扫描并检查更新" });
    expect(btn.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });

  it("项目页:只重读项目文件夹,转圈跟着它", () => {
    const s = spies();
    useProjects.setState({ loading: true });
    useUi.setState({ page: "projects" });
    render(<Toolbar />);
    const btn = screen.getByRole("button", { name: "重新读取项目文件夹" });
    expect(btn.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    fireEvent.click(btn);
    expect(s.projectsLoad).toHaveBeenCalledTimes(1);
    expect(s.storeLoad).not.toHaveBeenCalled();
    expect(s.mineLoad).not.toHaveBeenCalled();
  });

  it("设置页:不摆刷新按钮(那一页没有可刷新的内容)", () => {
    useUi.setState({ page: "settings" });
    const { container } = render(<Toolbar />);
    // 按图标查,不按名字:名字查不到既可能是"没摆",也可能是"摆了但没名字"
    // (注入验证实测:设置页照摆时 label 取不到键,按 /重新/ 查照样绿)。
    expect(container.querySelector(".lucide-refresh-cw")).toBeNull();
    // 对照:主题按钮仍在,证明不是整个顶栏没渲染
    expect(screen.getByRole("button", { name: "切换主题" })).toBeInTheDocument();
    // 对照:同一个查询在商店页找得到它,证明选择器本身不是空转
    useUi.setState({ page: "store" });
    const store = render(<Toolbar />);
    expect(store.container.querySelector(".lucide-refresh-cw")).not.toBeNull();
  });
});
