import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InstallButton } from "./InstallButton";

describe("InstallButton 状态机", () => {
  it("三档各有自己的文案", () => {
    const { rerender } = render(<InstallButton state="install" />);
    expect(screen.getByRole("button")).toHaveTextContent("安装");
    rerender(<InstallButton state="installed" />);
    expect(screen.getByRole("button")).toHaveTextContent("已启用");
    rerender(<InstallButton state="update" />);
    expect(screen.getByRole("button")).toHaveTextContent("更新");
  });

  it("已启用是终态,不接受点击", async () => {
    const onClick = vi.fn();
    render(<InstallButton state="installed" onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("置灰时点不动,且说明进了可访问名", async () => {
    // 任务 8 里安装流程还没接:按钮必须点不动,而不是点了没反应
    const onClick = vi.fn();
    render(<InstallButton state="install" disabled hint="获取功能将在下个版本开放" onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveAccessibleName(/获取功能将在下个版本开放/);
  });

  it("可用时点得动", async () => {
    const onClick = vi.fn();
    render(<InstallButton state="update" onClick={onClick} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("三档都保持同一个宽度下限,切换时不让整行跳动", () => {
    for (const state of ["install", "installed", "update"] as const) {
      const { unmount } = render(<InstallButton state={state} />);
      expect(screen.getByRole("button").className).toContain("min-w-[52px]");
      unmount();
    }
  });
});

// v6 任务 5 加过的 mine* 四档(mineSynced/minePull/mineShareUpdate/mineBoth)
// 已随 v7.4 撤销(用户第 9 轮拷问拍板:商店只回答"我有没有 / 我要不要",不再
// 回答"这是不是我的")。四档专属的文案/可点性用例随之整段删除——`InstallState`
// 类型已经不含这四个成员,继续断言它们连编译都过不去,不是"删测试图省事"。

describe("v7.3 需求 5:常态动作降级(全站规则),商店卡片是被点名复查的第一处", () => {
  /** 🔴 形态断言必须**按空白切分类名逐个比**:`toContain("bg-accent")` 分不出
   *  实心与 chip(字符串 `"bg-accent-soft"` 含有 `"bg-accent"`),
   *  `/\bbg-accent\b/` 同样不行(`-` 是非词字符)。 */
  const classes = () => screen.getByRole("button").className.split(/\s+/);

  it("🔴 「获取」是常态动作(满屏卡片人人都有)→ 浅橙 chip,不是实心", () => {
    render(<InstallButton state="install" onClick={() => {}} />);
    expect(classes()).toContain("bg-accent-soft");
    expect(classes()).not.toContain("bg-accent");
  });

  it("🔴 「有更新」是例外(少数几张卡片才有)→ 实心,比常态重一档", () => {
    render(<InstallButton state="update" onClick={() => {}} />);
    expect(classes()).toContain("bg-accent");
    expect(classes()).not.toContain("bg-accent-soft");
  });
});
