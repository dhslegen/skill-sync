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

describe("mine* 四档(v6 任务 5:技能库里记的分享者是我)", () => {
  // 四档各一条:文案对、可点性(disabled/terminal)对。`mineSynced` 是这四档里
  // 唯一的终态(与 `installed` 同款,不接受点击);其余三档都要能点。

  it("mineSynced:文案「已同步」,终态不接受点击", async () => {
    const onClick = vi.fn();
    render(<InstallButton state="mineSynced" onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("已同步");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("minePull:文案「取回」,可点", async () => {
    const onClick = vi.fn();
    render(<InstallButton state="minePull" onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("取回");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("mineShareUpdate:文案「分享更新」,可点", async () => {
    const onClick = vi.fn();
    render(<InstallButton state="mineShareUpdate" onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("分享更新");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("mineBoth:与 minePull 共用「取回」文案(两边都变了,同样先走「以本地为准」的冲突弹窗),可点", async () => {
    const onClick = vi.fn();
    render(<InstallButton state="mineBoth" onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("取回");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
