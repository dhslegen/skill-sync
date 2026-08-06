import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "./SettingsPage";
import { initAppearance, useAppearance } from "@/store/appearance";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const AGENTS = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "trae", displayName: "Trae", installed: false, globalSkillsDir: "~/.trae/skills", isUniversal: false, needsLink: true, disabled: true },
    { name: "cursor", displayName: "Cursor", installed: false, globalSkillsDir: "~/.agents/skills", isUniversal: true, needsLink: false, disabled: false },
  ],
  canonicalDir: "~/.agents/skills",
};

function reset() {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "agents_detected") return AGENTS;
    if (cmd === "auto_update_get") return { skills: { enabled: true, intervalMinutes: 240 }, app: true };
    return undefined;
  });
  localStorage.clear();
  useAppearance.setState({ mode: "light", accent: "clay", prefersDark: false });
  useSession.setState({ status: "signedOut", user: null, error: null });
  useSettings.setState({
    agents: null,
    autoUpdate: null,
    error: null,
    lastReport: null,
    checking: false,
    appUpdate: { phase: "idle" },
  });
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

describe("设置页 · AI 工具区", () => {
  beforeEach(reset);

  it("列出已检测到的与被关掉的;未检测且未关的不摆开关", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    // trae 未检测到但被关掉过:必须显示,否则用户永远找不回开关
    expect(screen.getByText("Trae")).toBeInTheDocument();
    expect(screen.getByText("未检测到,安装后自动启用")).toBeInTheDocument();
    // cursor 未检测到且未被关:不显示
    expect(screen.queryByText("Cursor")).not.toBeInTheDocument();
  });

  it("关掉一个工具:开关状态翻转并推送禁用名单", async () => {
    render(<SettingsPage />);
    const toggle = await screen.findByRole("switch", { name: "Claude Code" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await userEvent.click(toggle);

    expect(screen.getByRole("switch", { name: "Claude Code" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(invoke).toHaveBeenCalledWith("agents_set_disabled", {
      args: { disabled: ["claude-code", "trae"] },
    });
  });
});

describe("设置页 · 更新区", () => {
  beforeEach(reset);

  it("当前档位「每 4 小时」有按下态", async () => {
    render(<SettingsPage />);

    expect(await screen.findByRole("button", { name: "每 4 小时" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "手动" })).toHaveAttribute("aria-pressed", "false");
  });

  it("点「每天」写入 24 小时档", async () => {
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "每天" }));

    expect(invoke).toHaveBeenCalledWith("auto_update_set", {
      args: { autoUpdate: { skills: { enabled: true, intervalMinutes: 1440 }, app: true } },
    });
  });

  it("点「每 5 分钟」写入 5 分钟档 —— 急着验新版时用的那一档", async () => {
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "每 5 分钟" }));

    expect(invoke).toHaveBeenCalledWith("auto_update_set", {
      args: { autoUpdate: { skills: { enabled: true, intervalMinutes: 5 }, app: true } },
    });
  });

  it("应用自更新开关可关", async () => {
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("switch", { name: "自动更新应用" }));

    expect(invoke).toHaveBeenCalledWith("auto_update_set", {
      args: { autoUpdate: { skills: { enabled: true, intervalMinutes: 240 }, app: false } },
    });
  });

  it("「立即检查」触发一轮检查", async () => {
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "立即检查" }));

    expect(invoke).toHaveBeenCalledWith("update_check_now", undefined);
  });

  it("App 自更新:点检查 → 亮出新版本号 → 按钮变成下载并安装", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "auto_update_get") return { skills: { enabled: true, intervalMinutes: 240 }, app: true };
      if (cmd === "app_update_check") return { status: "available", version: "0.3.0" };
      return undefined;
    });
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "检查应用更新" }));

    expect(await screen.findByText("新版本 0.3.0 可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载并安装" })).toBeInTheDocument();
  });

  it("App 自更新:装完提示重启,按钮变成立即重启", async () => {
    useSettings.setState({ appUpdate: { phase: "installed" } });
    render(<SettingsPage />);

    expect(await screen.findByText("安装完成,重启后使用新版本")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "立即重启" }));

    expect(invoke).toHaveBeenCalledWith("app_restart", undefined);
  });

  it("最近一轮结果用人话摘要显示,不露目录名", async () => {
    useSettings.setState({
      lastReport: {
        status: "checked",
        headSha: "sha-9",
        updated: ["alpha", "beta"],
        skipped: [{ dirSlug: "gamma", reason: "已安装且有你的本地改动,未覆盖" }],
        failed: [],
      },
    });
    render(<SettingsPage />);

    expect(await screen.findByText("2 个已更新 · 1 个跳过 · 0 个失败")).toBeInTheDocument();
    expect(screen.queryByText(/alpha|gamma/)).not.toBeInTheDocument();
  });
});
