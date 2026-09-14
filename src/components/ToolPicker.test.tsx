import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LIST_ROW_EXTRA, ToolPicker, orderForPicker, type ToolPickerItem } from "@/components/ToolPicker";
import type { ToolState } from "@/lib/ipc";

// M1(修复轮 1):label 与 agent 刻意不同源(不是简单大写首字母),避免这批
// 用例在 label/agent 解耦之后失去"显示的是 displayName、不是内部 agent 名"
// 这层保护——本仓为"界面泄漏内部 agent name"这条踩过两次(见 CLAUDE.md)。
const LABELS: Record<string, string> = {
  junie: "Junie",
  "claude-code": "Claude Code",
  "trae-cn": "Trae (国内版)",
  zed: "Zed 编辑器",
};

function i(agent: string, state: ToolState): ToolPickerItem {
  return { agent, label: LABELS[agent] ?? agent, path: "", state };
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

  it("Critical-2(修复轮 1):以 items=[] 挂载、随后才拿到数据 —— 排序仍然生效", () => {
    // 复现 AgentChooser 的真实场景:useInstall 的 agents 初值是 []、agentsDetected()
    // 回来之前组件就已经以空 items 渲染过一轮(见 store/install.ts 的 begin/beginFromPlaza)。
    // 用 useState(() => ...) 的惰性初始值会在这一刻把排序结果永久钉成空数组;
    // 必须用 useRef 把"钉住"这件事延后到第一次拿到非空 items 才发生。
    const { rerender } = render(<ToolPicker items={[]} onToggle={() => {}} />);
    rerender(<ToolPicker items={[i("junie", "off"), i("claude-code", "linked")]} onToggle={() => {}} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"))).toEqual([
      "claude-code",
      "junie",
    ]);
  });

  it("K5(0.6.x):同一个实例被喂了另一批 agent → 按新集合重排,不再沿用旧顺序", () => {
    // 此前 pinned 只在第一份非空 items 时算一次;之后整批 agent 换掉(同一实例
    // 换了数据),新集合里的名字全落进"钉住顺序里没有的兜底段",按 items 原序排,
    // "已勾在前"这条规则对第二批数据整个失效。指纹按 agent 集合算,集合变了重钉。
    const { rerender } = render(<ToolPicker items={[i("junie", "off"), i("claude-code", "linked")]} onToggle={() => {}} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"))).toEqual(["claude-code", "junie"]);
    rerender(<ToolPicker items={[i("trae-cn", "off"), i("zed", "linked")]} onToggle={() => {}} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"))).toEqual(["zed", "trae-cn"]);
  });

  it("🔴 集合只是增减了几项(仍有交集)→ 不重排:剩下的保持原位,新来的排末尾(2026-09-14 复验回归)", () => {
    // 项目行取消一个"已关联但未探测到"的工具,它会从列表里消失——那是操作的直接结果,
    // 不是换了一个技能。按"集合变了就重钉"会把刚点的那一项从最上面甩到最下面。
    const { rerender } = render(
      <ToolPicker items={[i("zed", "linked"), i("junie", "off"), i("claude-code", "off")]} onToggle={() => {}} />,
    );
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"))).toEqual(["zed", "junie", "claude-code"]);
    rerender(<ToolPicker items={[i("junie", "linked"), i("claude-code", "off"), i("trae-cn", "linked")]} onToggle={() => {}} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"))).toEqual(["junie", "claude-code", "trae-cn"]);
  });

  it("K5 反例:集合没变、只是 state 翻了 → 不重钉(与「操作期间不重排」同一条规则的另一面)", () => {
    const { rerender } = render(<ToolPicker items={[i("junie", "off"), i("claude-code", "linked")]} onToggle={() => {}} />);
    // 同一集合,勾选状态对调:若按集合以外的东西重钉,这里会翻成 junie 在前
    rerender(<ToolPicker items={[i("junie", "linked"), i("claude-code", "off")]} onToggle={() => {}} />);
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("name"))).toEqual(["claude-code", "junie"]);
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

  it("🔴 M8 补漏:LIST_ROW_EXTRA 的字面量内容本身要过一道正面断言,不能只靠两处一致", () => {
    // `ToolPicker.consistency.test.tsx` 只比较"两处消费者算出来的 className
    // 是否互相一致",守不住"这批 token 本身写对了没有"。这里直接断言常量内容。
    // v7.1 任务 4 起是画布上那副紧凑清单(`padding:6px 0`,无分隔线、无 hover 底),
    // 四个调用方共用——原先那套 `border-t px-3 py-2 hover:bg-surface-2` 的
    // "卡片"观感已撤,理由见 `ToolPicker.tsx` 里 LIST_ROW_EXTRA 上方的注释。
    expect(LIST_ROW_EXTRA).toBe("py-1.5");
  });
});
