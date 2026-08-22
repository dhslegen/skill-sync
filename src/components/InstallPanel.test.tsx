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
    // 用户 2026-08-22:"装过的也能装,保留足够权利"。
    // 撤掉按钮把"已经装过"做成了死路 —— 而重装是完全合法的操作
    // (内容一样时它仍会重建 agent 关联,那正是想重装的理由)。
    expect(screen.queryByRole("button", { name: "装到这里" })).toBeNull();
    expect(screen.getByRole("button", { name: "覆盖重装" })).toBeTruthy();
  });

  it("点「覆盖重装」带 force,但**不带** confirmedReplace —— 那是两件事", async () => {
    const installed = [
      {
        path: "/w/我的项目", folderName: "我的项目", missing: false, readOnly: false,
        skills: [{
          key: "weekly-report", displayName: "周报生成", description: "",
          source: "skills/skills", sourceType: "git", dirSlug: "weekly-report",
          registryId: "company", repo: "skills/skills", updatable: true,
        }],
      },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_pick") return "/w/我的项目";
      if (cmd === "project_list") return installed;
      if (cmd === "project_skill_install") return { status: "installed", key: "x", linkedAgents: [] };
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "装到项目…" }));
    await screen.findByRole("button", { name: "覆盖重装" });

    await userEvent.click(screen.getByRole("button", { name: "覆盖重装" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([c]) => c === "project_skill_install");
      expect(call).toBeTruthy();
      const args = (call![1] as { args: Record<string, unknown> }).args;
      expect(args.force).toBe(true);
      // 🔴 本体被改过时仍要走决策对话框:合并成一个开关就是静默抹掉用户的改动
      expect(args.confirmedReplace).toBeFalsy();
    });
  });

  it("确认条上能就地换一个文件夹 —— 不该只有「取消」这一条路", async () => {
    // 用户 2026-08-22:"装到一个目录不应该没有任何可装到别的目录操作空间"
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "装到项目…" }));
    await screen.findByText("我的项目");

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_pick") return "/w/另一个项目";
      if (cmd === "project_list") return [];
      return null;
    });
    await userEvent.click(screen.getByRole("button", { name: "换个文件夹" }));

    await screen.findByText("另一个项目");
  });
});

describe("最近的项目", () => {
  it("已经装过的项目在菜单里标出来,但照样点得动 —— 标注是知情,不是禁止", async () => {
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
    // 标出来是为了让用户**知情**,不是为了剥夺他重装的权利(2026-08-22 拍板):
    // 点它照样进确认条,在那里给「覆盖重装」。
    expect(done.textContent).toContain("已装");
    expect((done as HTMLButtonElement).disabled).toBe(false);
  });

  it("点已装过的最近项目 → 进确认条给「覆盖重装」,不是直接装一遍白等", async () => {
    // 「最近的项目」平时豁免确认(点的是具体项目,意图已明确),但**已装那一档不能豁免**
    // ——豁免了就直接调安装、拿回一句"已经有了",用户依旧没有覆盖的机会。
    const groups = [
      {
        path: "/w/装过的", folderName: "装过的", missing: false, readOnly: false,
        skills: [{
          key: "weekly-report", displayName: "周报生成", description: "",
          source: "skills/skills", sourceType: "git", dirSlug: "weekly-report",
          registryId: "company", repo: "skills/skills", updatable: true,
        }],
      },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_list") return groups;
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: /^装过的/ }));

    await screen.findByRole("button", { name: "覆盖重装" });
    // 这一步绝不能已经装过一遍
    expect(invoke.mock.calls.filter(([c]) => c === "project_skill_install")).toHaveLength(0);
    // 也不该再弹一次系统选择框 —— 项目已经指定了
    expect(invoke.mock.calls.filter(([c]) => c === "project_pick")).toHaveLength(0);
  });

  it("点最近项目也走确认条 —— 它省掉的只是选文件夹那一步,后续完全一样", async () => {
    // 2026-08-22 用户拍板,推翻了此前的"最近项目豁免确认":
    // 两条路的差别**只应该是要不要弹系统选择框**,后续必须一致,否则同一个动作
    // 在两个入口有两种行为,心流是断的。一致性比省一次点击值钱。
    const groups = [
      { path: "/w/新的", folderName: "新的", missing: false, readOnly: false, skills: [] },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_list") return groups;
      if (cmd === "project_skill_install") return { status: "installed", key: "x", linkedAgents: [] };
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: /^新的/ }));

    // 先出确认条,磁盘零写入
    await screen.findByRole("button", { name: "装到这里" });
    expect(invoke.mock.calls.filter(([c]) => c === "project_skill_install")).toHaveLength(0);
    // 但**不再弹一次系统选择框** —— 项目已经指定了,那一步正是它省掉的
    expect(invoke.mock.calls.filter(([c]) => c === "project_pick")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "装到这里" }));

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([c]) => c === "project_skill_install")).toHaveLength(1);
    });
  });
});

describe("已经装过之后的入口可见性", () => {
  // 2026-08-22 用户反馈:"离系统安装和项目安装都满足的情况下,详情页只有已启用和
  // 一个小三角,很难让人认为是可以继续安装到别的项目的"。
  //
  // 症结:「已启用」是 disabled 的透明终态,旁边只有一个 24px 纯图标 chevron。
  // 整块看起来就是"做完了"。**状态归状态,动作归动作**——终态时把作用域入口
  // 从图标提升成带文字的按钮。
  function seedInstalledGlobally() {
    useInstall.setState({
      installed: new Map([
        ["weekly-report", { dirSlug: "weekly-report", contentHash: "" } as never],
      ]),
    });
    useStoreIndex.setState({ index: null, activeRegistry: "company", activeRepo: "skills/skills" });
  }

  it("全局已装时,作用域入口是**看得懂的文字按钮**,不是一个小三角", async () => {
    seedInstalledGlobally();
    render(<InstallPanel dirSlug="weekly-report" />);

    // 主按钮仍如实显示终态
    expect(screen.getByRole("button", { name: /已启用/ })).toBeTruthy();
    // 但"还能装到项目"必须一眼看得出来
    const entry = screen.getByRole("button", { name: "装到项目…" });
    expect(entry.getAttribute("aria-haspopup")).toBe("menu");
    expect(entry.textContent).toContain("装到项目");
  });

  it("还没装时不喧宾夺主 —— 主动作是「获取」,作用域入口保持小图标", async () => {
    useInstall.setState({ installed: new Map() });
    render(<InstallPanel dirSlug="weekly-report" />);

    expect(screen.getByRole("button", { name: "选择安装位置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "装到项目…" })).toBeNull();
  });

  it("文字按钮点开的还是同一个菜单", async () => {
    seedInstalledGlobally();
    render(<InstallPanel dirSlug="weekly-report" />);

    await userEvent.click(screen.getByRole("button", { name: "装到项目…" }));

    expect(screen.getByRole("menuitem", { name: "装到项目…" })).toBeTruthy();
  });
});
