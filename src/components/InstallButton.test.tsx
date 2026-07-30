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
