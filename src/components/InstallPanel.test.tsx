import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstallPanel } from "@/components/InstallPanel";
import { useInstall } from "@/store/install";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const AGENTS = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, disabled: false, isUniversal: false, needsLink: true },
  ],
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "agents_detected") return AGENTS;
    if (cmd === "project_pick") return "/w/我的项目";
    if (cmd === "project_list") return [];
    return null;
  });
  useProjects.setState({
    groups: [], loading: false, error: null, installing: null,
    notice: null, decision: null, busyKey: null, confirm: null,
  });
  useInstall.setState({ phase: "idle", dirSlug: null });
  useStoreIndex.setState({ activeRegistry: "company", activeRepo: "skills/skills" });
});

async function openScopeMenu() {
  await userEvent.click(screen.getByRole("button", { name: "选择安装位置" }));
}

describe("装到项目的确认条", () => {
  it("选完文件夹先出确认条,这时磁盘零写入", async () => {
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: "装到项目…" }));

    // 确认条要说清装到哪、路径是什么、会关联哪些工具
    await screen.findByText("我的项目");
    expect(screen.getByText("/w/我的项目")).toBeTruthy();
    expect(screen.getByText(/Claude Code/)).toBeTruthy();
    expect(invoke.mock.calls.filter(([c]) => c === "project_skill_install")).toHaveLength(0);
  });

  it("点「装到这里」才真装", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_pick") return "/w/我的项目";
      if (cmd === "project_skill_install") return { status: "installed", key: "x", linkedAgents: [] };
      if (cmd === "project_list") return [];
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "装到项目…" }));
    await screen.findByText("我的项目");

    await userEvent.click(screen.getByRole("button", { name: "装到这里" }));

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([c]) => c === "project_skill_install")).toHaveLength(1);
    });
  });

  it("取消就什么都没发生", async () => {
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "装到项目…" }));
    await screen.findByText("我的项目");

    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByText("/w/我的项目")).toBeNull());
    expect(invoke.mock.calls.filter(([c]) => c === "project_skill_install")).toHaveLength(0);
  });

  it("已经装过就直说,不摆「装到这里」引诱用户重复装一遍", async () => {
    // ⚠️ 必须让 project_list 也返回它:菜单打开时会 load() 一次,
    // 只 setState 的话会被那次 load 冲掉(测试自己的坑,不是实现的)
    const installed = [
      {
          path: "/w/我的项目",
          folderName: "我的项目",
          missing: false,
          readOnly: false,
          skills: [
            {
              key: "weekly-report", displayName: "周报生成", description: "",
              source: "skills/skills", sourceType: "git", dirSlug: "weekly-report",
              registryId: "company", repo: "skills/skills", updatable: true,
            },
          ],
        },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_pick") return "/w/我的项目";
      if (cmd === "project_list") return installed;
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "装到项目…" }));

    await screen.findByText("这个文件夹里已经有这个技能了");
    expect(screen.queryByRole("button", { name: "装到这里" })).toBeNull();
  });
});

describe("最近的项目", () => {
  it("已经装过的项目在菜单里标出来且点不动", async () => {
    // 让用户点一下、等一整轮网络请求(下压缩包、建索引)才被告知"已经有了",
    // 是 2026-08-22 真机反馈里最实的一条。
    const groups = [
      {
        path: "/w/装过的",
        folderName: "装过的",
        missing: false,
        readOnly: false,
        skills: [
          {
            key: "weekly-report", displayName: "周报生成", description: "",
            source: "skills/skills", sourceType: "git", dirSlug: "weekly-report",
            registryId: "company", repo: "skills/skills", updatable: true,
          },
        ],
      },
      { path: "/w/没装过的", folderName: "没装过的", missing: false, readOnly: false, skills: [] },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_list") return groups;
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();

    const done = await screen.findByRole("menuitem", { name: /^装过的/ });
    const notDone = screen.getByRole("menuitem", { name: /没装过的/ });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect((notDone as HTMLButtonElement).disabled).toBe(false);
  });
});
