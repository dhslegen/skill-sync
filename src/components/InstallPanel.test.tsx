import { act, render, screen, waitFor } from "@testing-library/react";
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

describe("装完之后的出口", () => {
  // 2026-08-22 用户反馈:"详情页直接点安装后,文案提示已启用到…,这时候也没有
  // 更多操作空间"。与上一条(终态只有小三角)是**同一个病根的另一个入口**:
  // 装完那一屏只有结果文案,零操作入口 —— 想再装到项目得关掉详情面板重开。
  function seedDone() {
    useInstall.setState({
      phase: "done",
      dirSlug: "weekly-report",
      agents: [
        { name: "claude-code", displayName: "Claude Code", installed: true, disabled: false, isUniversal: false, needsLink: true },
      ],
      report: {
        dirSlug: "weekly-report",
        links: [{ dir: "/x", result: { status: "linked", mode: "symlink" } }],
      } as never,
      localKept: false,
      shareResult: null,
    });
  }

  it("装完仍能看到「装到项目…」,不必关掉详情面板重开", async () => {
    seedDone();
    render(<InstallPanel dirSlug="weekly-report" />);

    // 结果文案照常
    expect(screen.getByText(/已启用/)).toBeTruthy();
    // 但出口必须在
    expect(screen.getByRole("button", { name: "装到项目…" })).toBeTruthy();
  });

  it("装完点最近项目,确认条照样出得来 —— 它不该只活在「未安装」那一屏", async () => {
    // 结构问题:确认条此前挂在 IdleFooter 内部,done 档整个渲染不出来。
    const groups = [
      { path: "/w/我的项目", folderName: "我的项目", missing: false, readOnly: false, skills: [] },
    ];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "project_list") return groups;
      return null;
    });
    seedDone();
    render(<InstallPanel dirSlug="weekly-report" />);

    await userEvent.click(screen.getByRole("button", { name: "装到项目…" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^我的项目/ }));

    await screen.findByRole("button", { name: "装到这里" });
  });
});

describe("本次安装结果是临时态", () => {
  // 2026-08-22 用户反馈:"已启用的详细消息应该是本次安装结果的临时态,详情关闭
  // 就该丢失,再次打开显示简单的已启用,和所有其他没有在 app 激活期间安装的保持
  // 一致,不然很割裂,目前只有重启才能回到已启用简易状态"。
  //
  // 「已启用到 Claude Code、Trae」说的是**这一次安装做了什么**,不是这个技能的属性。
  // 上个月装的技能打开就是简简单单一句「已启用」,刚装的却永远带着一段结果报告
  // ——同一个东西两种面孔。
  function seedDone(dirSlug = "weekly-report") {
    useInstall.setState({
      phase: "done",
      dirSlug,
      agents: [
        { name: "claude-code", displayName: "Claude Code", installed: true, disabled: false, isUniversal: false, needsLink: true },
      ],
      report: {
        dirSlug,
        links: [{ dir: "/x", result: { status: "linked", mode: "symlink" } }],
      } as never,
      installed: new Map([[dirSlug, { dirSlug, contentHash: "" } as never]]),
      localKept: false,
      shareResult: null,
    });
    useStoreIndex.setState({ index: null, activeRegistry: "company", activeRepo: "skills/skills" });
  }

  it("关掉详情面板再打开:回到简易的「已启用」,不再挂着上次的结果报告", async () => {
    // ⚠️ 顺序必须真实:面板先以「未安装」挂载,用户点了安装才变成 done。
    // 直接"挂载时就是 done"是构造不出来的状态,那样测的是另一回事。
    const first = render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedDone());
    expect(screen.getByText(/已启用到/)).toBeTruthy();

    first.unmount(); // 关掉详情面板
    render(<InstallPanel dirSlug="weekly-report" />); // 再打开

    expect(screen.queryByText(/已启用到/)).toBeNull();
    expect(screen.getByRole("button", { name: /已启用/ })).toBeTruthy();
  });

  it("切到别的技能再切回来也一样", async () => {
    const { rerender } = render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedDone());
    expect(screen.getByText(/已启用到/)).toBeTruthy();

    rerender(<InstallPanel dirSlug="other-skill" />);
    rerender(<InstallPanel dirSlug="weekly-report" />);

    expect(screen.queryByText(/已启用到/)).toBeNull();
  });

  it("刚装完那一刻结果报告要留住 —— 别被自己的收尾逻辑一帧就清掉", async () => {
    // 这条挡的是"把 phase 写进 effect 依赖"这个具体写法:那样 phase 一变成 done
    // 就会立刻触发收尾、把结果清掉,用户什么都看不到。
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedDone());

    expect(screen.getByText(/已启用到/)).toBeTruthy();
    expect(useInstall.getState().phase).toBe("done");
  });

  it("🔴 安装**还在进行**时绝不能清 —— 那会把进行中的流程整个丢掉", async () => {
    useInstall.setState({ phase: "running", dirSlug: "weekly-report", stage: "writing" });
    const first = render(<InstallPanel dirSlug="weekly-report" />);
    first.unmount();
    render(<InstallPanel dirSlug="weekly-report" />);

    expect(useInstall.getState().phase).toBe("running");
  });
});
