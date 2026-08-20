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

  it("广场搜索态:点「搜索」按钮提交", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const submitSearch = vi.fn();
    usePlaza.setState({ submitSearch, query: "react" });
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(submitSearch).toHaveBeenCalledTimes(1);
  });

  it("「搜索」按钮只在广场那一档出现,公司技能库不摆", () => {
    render(<Toolbar />);
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();
  });

  it("🔴 搜索中按钮不禁用,还能再点一次(要的就是以最新一次为准)", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const submitSearch = vi.fn();
    usePlaza.setState({ submitSearch, query: "react", status: "loading" });
    render(<Toolbar />);

    const button = screen.getByRole("button", { name: "搜索" });
    expect(button).not.toBeDisabled();
    // 搜索中图标转圈,给"正在搜"的明确指示
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");

    fireEvent.click(button);
    expect(submitSearch).toHaveBeenCalledTimes(1);
  });

  it("刷新按钮在广场搜索态走同一个提交入口(不再靠输入即触发)", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null });
    const submitSearch = vi.fn();
    usePlaza.setState({ submitSearch, query: "react" });
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "重新获取" }));
    expect(submitSearch).toHaveBeenCalledTimes(1);
  });

  it("刷新按钮的转圈状态:广场搜索态跟广场的 status,不跟商店的", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, status: "ready" });
    usePlaza.setState({ status: "loading" });
    render(<Toolbar />);
    const refresh = screen.getByRole("button", { name: "重新获取" });
    expect(refresh.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });
});
