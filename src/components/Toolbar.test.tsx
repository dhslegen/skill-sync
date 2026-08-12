import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Toolbar } from "./Toolbar";
import { usePlaza } from "@/store/plaza";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function reset() {
  useUi.setState({ page: "store" });
  useStoreIndex.setState({ activeRegistry: "company", activeRepo: null, query: "", status: "ready" });
  usePlaza.setState({ query: "", status: "idle", results: [], error: null });
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

  it("刷新按钮的转圈状态:广场搜索态跟广场的 status,不跟商店的", () => {
    useStoreIndex.setState({ activeRegistry: "plaza", activeRepo: null, status: "ready" });
    usePlaza.setState({ status: "loading" });
    render(<Toolbar />);
    const refresh = screen.getByRole("button", { name: "重新获取" });
    expect(refresh.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
  });
});
