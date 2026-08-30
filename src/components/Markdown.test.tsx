import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Markdown } from "@/components/Markdown";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

const TABLE_SOURCE = ["| 列 A | 列 B |", "| --- | --- |", "| 一 | 二 |"].join("\n");

describe("Markdown", () => {
  it("渲染 GFM 管道表格,而不是把它当成一段普通文字原样吐出来", () => {
    const { container } = render(<Markdown source={TABLE_SOURCE} />);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain("列 A");
    expect(table?.textContent).toContain("一");
    // 没有 remark-gfm 时,react-markdown 只认 CommonMark,表格语法会被当成一段
    // 普通段落原样吐出来 —— 这里正面断言"不是一整段裸文字"。
    expect(container.querySelector("p")?.textContent ?? "").not.toContain("|");
  });

  it("宽表格有自己的横向滚动容器,不会撑破定宽的详情面板", () => {
    const { container } = render(<Markdown source={TABLE_SOURCE} />);

    const table = container.querySelector("table");
    const wrap = table?.parentElement;
    expect(wrap?.className).toContain("md-table-wrap");
  });

  it("非表格内容照常渲染,不受 remark-gfm 影响", () => {
    const { container } = render(<Markdown source={"# 标题\n\n正文一段。"} />);

    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(container.textContent).toContain("正文一段。");
  });
});
