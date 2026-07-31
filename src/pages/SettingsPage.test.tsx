import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "./SettingsPage";
import { initAppearance, useAppearance } from "@/store/appearance";
import { useSession } from "@/store/session";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  localStorage.clear();
  useAppearance.setState({ mode: "light", accent: "clay", prefersDark: false });
  useSession.setState({ status: "signedOut", user: null, error: null });
}

describe("设置页 · 账号区", () => {
  beforeEach(reset);

  it("已登录:显示用户名,点「退出登录」调 auth_logout 并回到登录入口", async () => {
    useSession.setState({
      status: "signedIn",
      user: { login: "zhang-san", displayName: "张三", avatarUrl: "" },
      error: null,
    });
    render(<SettingsPage />);

    expect(screen.getByText("张三")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(invoke).toHaveBeenCalledWith("auth_logout", expect.anything());
    expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByText("张三")).not.toBeInTheDocument();
  });

  it("未登录:显示登录入口与说明", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByText("未登录")).toBeInTheDocument();
  });
});

describe("设置页 · 外观区", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    reset();
    cleanup?.();
    // 挂上 store → <html> 的同步,方能断言 data-theme / data-accent 真的变了
    cleanup = initAppearance();
  });

  it("主题三档:当前档有按下态,点「深色」立即换肤", async () => {
    render(<SettingsPage />);

    expect(screen.getByRole("button", { name: "浅色" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "深色" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(useAppearance.getState().mode).toBe("dark");
    expect(screen.getByRole("button", { name: "深色" })).toHaveAttribute("aria-pressed", "true");
  });

  it("跟随系统档存在且可选", async () => {
    render(<SettingsPage />);
    await userEvent.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(useAppearance.getState().mode).toBe("system");
  });

  it("强调色:点「深青绿」立即换肤,内部标识不露给用户", async () => {
    render(<SettingsPage />);

    await userEvent.click(screen.getByRole("button", { name: "深青绿" }));

    expect(document.documentElement.dataset.accent).toBe("teal");
    // 界面上任何地方不该出现内部标识
    expect(screen.queryByText(/\b(clay|teal|ink)\b/)).not.toBeInTheDocument();
  });
});
