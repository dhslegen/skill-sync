import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ToolPicker, orderForPicker, type ToolPickerItem } from "@/components/ToolPicker";
import type { ToolState } from "@/lib/ipc";

function i(agent: string, state: ToolState): ToolPickerItem {
  return { agent, label: agent.charAt(0).toUpperCase() + agent.slice(1), path: "", state };
}

/** 测试用的受控外壳:模拟真实调用方——点一下只翻转那一项的 state,不重新排序。 */
function Harness({ items, disabled }: { items: ToolPickerItem[]; disabled?: boolean }) {
  const [state, setState] = useState(items);
  return (
    <ToolPicker
      items={state}
      disabled={disabled}
      onToggle={(agent, next) =>
        setState((prev) =>
          prev.map((item) => (item.agent === agent ? { ...item, state: next ? "linked" : "off" } : item)),
        )
      }
    />
  );
}

describe("orderForPicker", () => {
  it("打开时已勾的排在前面", () => {
    const items = [i("junie", "off"), i("claude-code", "linked"), i("trae-cn", "off"), i("zed", "body")];
    expect(orderForPicker(items).map((x) => x.agent)).toEqual(["claude-code", "zed", "junie", "trae-cn"]);
  });

  it("missing 算未勾,不进前段", () => {
    const items = [i("a", "missing"), i("b", "copy")];
    expect(orderForPicker(items).map((x) => x.agent)).toEqual(["b", "a"]);
  });
});

describe("ToolPicker", () => {
  it("操作期间不重排 —— 刚点的那一项不会从手指底下跳走", async () => {
    render(<Harness items={[i("junie", "off"), i("claude-code", "linked")]} />);
    const before = screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"));
    await userEvent.click(screen.getByRole("checkbox", { name: /Junie/ }));
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"))).toEqual(before);
  });

  it("本体所在那一项恒勾且点不动", async () => {
    render(<Harness items={[i("zed", "body")]} />);
    const box = screen.getByRole("checkbox");
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
  });

  it("group 级 disabled 会禁用非 body 的项,但不改变它的 checked 值", () => {
    render(
      <ToolPicker
        items={[i("junie", "linked")]}
        onToggle={() => {}}
        disabled
      />,
    );
    const box = screen.getByRole("checkbox");
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
  });

  it("items 为空整组不渲染", () => {
    const { container } = render(<ToolPicker items={[]} onToggle={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("path 留空时不渲染路径那一段,给出路径时渲染", () => {
    render(
      <ToolPicker
        items={[
          { agent: "a", label: "A", path: "", state: "linked" },
          { agent: "b", label: "B", path: "/home/.b/skills", state: "off" },
        ]}
        onToggle={() => {}}
      />,
    );
    expect(screen.queryByText("/home/.b/skills")).toBeInTheDocument();
    // "A" 那一档 path 是空字符串,不该把它渲染成一个空壳 span——
    // 整个 label 里应该只有一个 span(标签文字本身),没有路径/本体/副本那几段。
    const labelA = screen.getByText("A").closest("label")!;
    expect(within(labelA).getAllByText(/.+/, { selector: "span" })).toHaveLength(1);
  });

  it("点击会带上 next(取反后的值)一起回调", async () => {
    const onToggle = vi.fn();
    render(<ToolPicker items={[i("junie", "off")]} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith("junie", true);
  });
});
