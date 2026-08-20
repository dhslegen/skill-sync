import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Toolbar } from "./Toolbar";
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

    fireEvent.click(screen.getByRole("button", { name: "重新获取" }));
    expect(submitSearch).toHaveBeenCalledTimes(1);
  });

  it("搜索中的加载指示挂在既有的刷新按钮上(不为它新造控件)", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, status: "ready" });
    usePlaza.setState({ status: "loading" });
    render(<Toolbar />);
    const refresh = screen.getByRole("button", { name: "重新获取" });
    expect(refresh.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });
});
