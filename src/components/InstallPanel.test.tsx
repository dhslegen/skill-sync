import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstallPanel } from "@/components/InstallPanel";
import type { InstalledSkillView } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMySkills } from "@/store/my-skills";
import { useProjects } from "@/store/project";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

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
    // 🔴 终审 §15:必须显式重置,否则某条用例调 `useProjects.setState({
    // pickableAgents: ... })` 之后会**残留到后面的用例**(这个 `beforeEach`
    // 之前没有把它列进去,是因为确认条的 `ToolPicker` 是这次才加的)。
    pickableAgents: null,
  });
  useInstall.setState({ phase: "idle", dirSlug: null, mineKept: null });
  useStoreIndex.setState({ activeRegistry: "company", activeRepo: "skills/skills" });
  // v7.5:「我的技能」的 list 是新形参 localHash 的数据来源,默认重置成"还没
  // 加载过",避免上一条用例 setState 的本机本体数据残留到下一条。
  useMySkills.setState({ list: null });
});

/** 最小可用的 `InstalledSkillView`,只有 v7.5 关心的 dirSlug/localPresent/localHash
 *  是变量,其余字段填不影响判定的占位值(与 `MySkillsPage.test.tsx` 的 `mk` 同一姿势,
 *  这里不复用它是因为这个字段清单是当时 v7 任务 7 的产物,拆分成公共 fixture
 *  超出本任务范围)。 */
function localSkill(over: Partial<InstalledSkillView> & { dirSlug: string }): InstalledSkillView {
  return {
    commitSha: "",
    contentHash: "",
    agents: [],
    installedAt: "",
    updatedAt: "",
    localModified: false,
    sourceOwner: "",
    sourceRepo: "",
    registryId: "",
    sourceRemoved: false,
    libraryRemoved: false,
    relation: "draft",
    localPresent: true,
    sourceLabel: null,
    body: `/h/.claude/skills/${over.dirSlug}`,
    localHash: "",
    tools: [],
    versions: [],
    shareBlocked: null,
    section: "shareable",
    review: null,
    libraryUrl: null,
    canonicalReaders: null,
    ...over,
  };
}

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
    // 🔴 v7.6 任务 3(B2):picker 摆上确认条之后,「会启用到 Claude Code」这句话
    // 成了死重复,只在 picker 不在场时才渲染——这里 `pickableAgents` 探测成功
    // 且非空(默认 beforeEach 的 `agents_detected` mock),picker 会渲染,
    // 这句话因此不该再出现,取而代之的是可勾选的 checkbox。
    expect(screen.queryByText("会启用到 Claude Code")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Claude Code" })).toBeTruthy();
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

  it("🔴 design §15 前半:确认条上能勾/去勾要关联的工具,IPC 早就收 agentIds 只是此前没摆控件", async () => {
    useProjects.setState({ pickableAgents: AGENTS.agents });
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

    // 默认沿用全局默认规则(已探测且未禁用)——与 requestInstall 算好的初值一致
    const checkbox = await screen.findByRole("checkbox", { name: "Claude Code" });
    expect(checkbox).toBeChecked();

    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "装到这里" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([c]) => c === "project_skill_install");
      expect(call?.[1].args.agentIds).toEqual([]);
    });
  });

  it("探测失败(pickableAgents 为 null)时不摆一个空的 picker —— 摆了会误导成'这台机器没有可选的工具'", async () => {
    // 🔴 光在这里 setState(null) 不够:`InstallScopeMenu` 打开时会自己
    // `useProjects.load()`,那一步的 `agents_detected` 若照常成功,`pickableAgents`
    // 会被重新填成非空——必须让探测本身失败,才是"探测失败"这个场景的真实姿势
    // (与 `store/project.ts::load` 的 catch 分支同一条路径)。
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") throw { code: "IPC_FAILED", message: "探测失败" };
      if (cmd === "project_pick") return "/w/我的项目";
      if (cmd === "project_list") return [];
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    await openScopeMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: "装到项目…" }));
    await screen.findByText("我的项目");

    await waitFor(() => {
      expect(useProjects.getState().pickableAgents).toBeNull();
    });
    expect(screen.queryByRole("checkbox")).toBeNull();
    // 🔴 v7.6 任务 3(B2):这个场景里 `requestInstall` 自己那次独立探测
    // (`agentsDetected().catch(() => ({agents: []}))`)也失败了,`confirm.agentLabels`
    // 因此同样是空——两次探测都没拿到结果时,文字要说"暂时读不到",不能说成
    // `confirmNoAgents`("不必单独启用")那句假话(CLAUDE.md 记过这条:探测失败
    // 时不能编造"没有可选的工具")。
    expect(
      screen.getByText("暂时读不到这台机器上的工具列表,不代表没有可选的工具"),
    ).toBeTruthy();
    expect(screen.queryByText("不必单独启用(这些工具直接读技能文件夹)")).toBeNull();
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
    // v7.6:判定入口从"问账本"改成"问磁盘",要显式给出本机本体的实时指纹,
    // 否则 localHash 缺省为 undefined 会被判成「获取」而不是这里要的终态。
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: true, localHash: "sha:whatever" })],
    });
  }

  it("全局已装时,作用域入口是**看得懂的文字按钮**,不是一个小三角", async () => {
    seedInstalledGlobally();
    render(<InstallPanel dirSlug="weekly-report" />);

    // 主按钮仍如实显示终态(v7.6 起 installed 并入 onDisk,文案是「已在电脑上」)
    expect(screen.getByRole("button", { name: /已在电脑上/ })).toBeTruthy();
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
    // ⚠️ **先 render 再 seed**(2026-08-26 修:这两条原先反着写,于是挂载时的
    // 收尾 effect 把 done 整个清掉,测的其实是 `IdleFooter`——把 `DoneFooter`
    // 里的 `InstallScopeMenu` 整个删掉,两条照样全绿。注入实测复现过)。
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedDone());

    // 结果文案照常
    expect(screen.getByText(/已启用/)).toBeTruthy();
    // 但出口必须在
    expect(screen.getByRole("button", { name: "装到项目…" })).toBeTruthy();
  });

  it("🔴 design §18:装完那一屏能「在我的技能里查看」,切页并打开这一行的详情", async () => {
    useUi.setState({ page: "store" });
    useLocalDetail.setState({ target: null, detail: null, error: null });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "skill_local_detail")
        return {
          name: "周报生成",
          dirSlug: "weekly-report",
          description: "",
          path: "/h/.agents/skills/weekly-report",
          skillMd: "",
          files: [],
          hasScripts: false,
        };
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedDone());

    await userEvent.click(screen.getByRole("button", { name: "在我的技能里查看" }));

    expect(useUi.getState().page).toBe("mine");
    await waitFor(() => {
      expect(useLocalDetail.getState().target).toEqual({ dirSlug: "weekly-report" });
    });
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
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedDone());

    await userEvent.click(screen.getByRole("button", { name: "装到项目…" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^我的项目/ }));

    await screen.findByRole("button", { name: "装到这里" });
  });
});

describe("「保留本地的」装完那一屏不能是死路", () => {
  // core 对 `LocalDiffers + KeepLocal` 早退,一处工具启用都不改;`mine` 那一档
  // 后面还有分享结果接着说,而这一档说完「已保留」就没有下文了 —— 不把出路
  // 一起说了,用户在这一屏就无路可走(与 v5「装完那一屏零操作入口」同一形状)。
  function seedKept(kind: "mine" | "localDiffers") {
    useInstall.setState({
      phase: "done",
      dirSlug: "weekly-report",
      agents: [],
      report: null,
      mineKept: { remoteChanged: true, kind },
      localKept: false,
      shareResult: null,
    });
  }

  it("localDiffers 档:说清没改文件、没改启用状态,并指路到「我的技能」", () => {
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedKept("localDiffers"));

    const text = document.body.textContent ?? "";
    expect(text).toMatch(/没有改动任何文件/);
    expect(text).toMatch(/没有改动工具的启用状态/);
    expect(text).toMatch(/我的技能/);
    // 绝不能说成一次安装
    expect(text).not.toMatch(/已启用到|已安装到通用目录/);
  });

  it("mine 档仍是原来那句(它后面还有分享结果接着说),两档不混", () => {
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedKept("mine"));

    const text = document.body.textContent ?? "";
    expect(text).toMatch(/已保留你的本地内容,未做其他改动/);
    // 🔴 不能断言"整段文字里没有「我的技能」四个字"——设计 §18 加的
    // 「在我的技能里查看」按钮在 `mine` 这一档照常渲染(它有记账,
    // `converge::home_of` 解析得到本体)。这里真正要钉的是"两档不混":
    // `mine` 档不该说出 `localDiffers` 专属的那句"到「我的技能」里勾一下"。
    expect(text).not.toMatch(/到「我的技能」里勾一下/);
  });

  // 终审复审轮 1,I-C:「在我的技能里查看」按 dirSlug 打开本地详情,而
  // `skill_local_detail` 的 dirSlug 分支走 `converge::home_of` 从**账上**解析本体。
  // `LocalDiffers + KeepLocal` 那一档 `acquire` 早退返回 `Kept`,**一条账都没写**
  // ——`home_of` 回落 canonical,而这一档的本体多半住在某个工具目录里,canonical
  // 上什么都没有,点下去打开的是一个报错面板。按「不摆比摆一个必然报错的按钮好」
  // 处理。
  it("localDiffers 档不摆「在我的技能里查看」——那一档没有记账,点了必然报错", () => {
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedKept("localDiffers"));

    expect(screen.queryByRole("button", { name: "在我的技能里查看" })).toBeNull();
    // 出路没有消失:这一档自己那句话里就带着「到「我的技能」里勾一下」
    expect(document.body.textContent ?? "").toMatch(/到「我的技能」里勾一下/);
  });

  it("mine 档照常摆「在我的技能里查看」——它有记账,解析得到本体", () => {
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedKept("mine"));

    expect(screen.getByRole("button", { name: "在我的技能里查看" })).toBeTruthy();
  });
});

describe("没能启用的那些位置:就地「在工具里启用」", () => {
  // ⚠️ 这一块以前**一条测试都没有**:那颗按钮从 M1 起就没被任何测试点过。
  // v6 二期任务 8 把它从「重试」(可能弹出一个承诺"替换那个位置"的确认框)
  // 换成「在工具里启用」→ `skill_set_agents`,顺手把这个空档补上。
  // ⚠️ 与本文件既有的 `seedDone` 同一条纪律:**先 render 再 seed**。
  // 面板挂载时的收尾 effect 会把终态(done/error)整个清掉,"挂载时就是 done"
  // 是构造不出来的状态——那样测的是 `IdleFooter`,不是结果面板。
  function seedPartlyFailed() {
    useInstall.setState({
      phase: "done",
      dirSlug: "weekly-report",
      selected: new Set(["claude-code", "trae"]),
      agents: [
        { name: "claude-code", displayName: "Claude Code", installed: true, disabled: false, isUniversal: false, needsLink: true },
        { name: "trae", displayName: "Trae", installed: true, disabled: false, isUniversal: false, needsLink: true },
      ],
      report: {
        dirName: "weekly-report",
        canonicalDir: "/h/.agents/skills/weekly-report",
        links: [
          { dir: "/h/.claude/skills", agents: ["claude-code"], result: { status: "linked", mode: "symlink" } },
          { dir: "/h/.trae/skills", agents: ["trae"], result: { status: "failed", error: { code: "FS_TASK", message: "这个位置没能启用" } } },
        ],
      } as never,
      enablingDir: null,
      enableError: null,
      localKept: false,
      shareResult: null,
    });
  }

  it("按钮说的是「在工具里启用」,没有承诺替换的那颗「重试」", () => {
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedPartlyFailed());

    expect(screen.getByRole("button", { name: "在工具里启用" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "替换" })).toBeNull();
  });

  it("点它真的发 skill_set_agents,而且带的是完整的期望名单", async () => {
    // 🔴 `skill_set_agents` 收的是**完整期望态**:只传这一处那几个,core 会把
    // 其余位置停用掉——补一处等于关掉别处,那是数据损失。
    const setAgentsDone = {
      outcome: "done",
      homeBody: "/h/.agents/skills/weekly-report",
      canonical: { Ok: { kind: "unchanged" } },
      results: [["trae", { Ok: { kind: "linked", mode: "symlink" } }]],
      unlinked: [],
      unlinkFailed: [],
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "skill_set_agents") return setAgentsDone;
      if (cmd === "installed_list") return [];
      if (cmd === "project_list") return [];
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedPartlyFailed());

    await userEvent.click(screen.getByRole("button", { name: "在工具里启用" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([c]) => c === "skill_set_agents");
      expect(call?.[1].args).toEqual({
        dirSlug: "weekly-report",
        agents: ["claude-code", "trae"],
      });
    });
    // 成功之后这一行整个消失(它是"没能启用"清单里的一条)
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "在工具里启用" })).toBeNull();
    });
  });

  it("没成就把原因摆出来,不装作已经成了", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "skill_set_agents") return { outcome: "needsVersionChoice", versions: [] };
      if (cmd === "project_list") return [];
      return null;
    });
    render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedPartlyFailed());

    await userEvent.click(screen.getByRole("button", { name: "在工具里启用" }));

    expect(await screen.findByText(/几份内容不同的文件夹/)).toBeTruthy();
    // 那一行仍然算"没能启用",按钮还在
    expect(screen.getByRole("button", { name: "在工具里启用" })).toBeTruthy();
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
    // v7.6:判定入口从"问账本"改成"问磁盘",再打开这一屏走的是 IdleFooter/
    // cardState,要显式给出本机本体的实时指纹,否则 localHash 缺省为
    // undefined 会被判成「获取」。
    useMySkills.setState({
      list: [localSkill({ dirSlug, localPresent: true, localHash: "sha:whatever" })],
    });
  }

  it("关掉详情面板再打开:回到简易的「已在电脑上」,不再挂着上次的结果报告", async () => {
    // ⚠️ 顺序必须真实:面板先以「未安装」挂载,用户点了安装才变成 done。
    // 直接"挂载时就是 done"是构造不出来的状态,那样测的是另一回事。
    const first = render(<InstallPanel dirSlug="weekly-report" />);
    act(() => seedDone());
    expect(screen.getByText(/已启用到/)).toBeTruthy();

    first.unmount(); // 关掉详情面板
    render(<InstallPanel dirSlug="weekly-report" />); // 再打开

    expect(screen.queryByText(/已启用到/)).toBeNull();
    // v7.6 起 installed 并入 onDisk,简易终态的文案是「已在电脑上」——
    // 「已启用」这个词没有消失,只是不再是这颗按钮的文案。
    expect(screen.getByRole("button", { name: /已在电脑上/ })).toBeTruthy();
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

describe("v7.4:商店不再按「是不是我的」分流(v7.6 起按钮文案随「行为翻转 1」更新)", () => {
  // v6 任务 5 加的 mine* 四档已随 v7.4 撤销(用户第 9 轮拷问拍板:「取回」一词
  // 背三种意思、「已同步」回答的是没人问的问题,商店只该回答"我有没有 / 我要不要")。
  // 这一对用例是这条拍板在组件层面的钉子:同样的本地改动 + 相同的内容指纹,
  // 唯一变量是"作者是不是我",结果必须一致——本地改没改不再改变按钮状态,
  // 也不再改变徽标的显隐(徽标本身与"是不是我的"无关,任何已装技能只要本体
  // 内容变了就提示,`IdleFooter` 已删掉 `!state.startsWith("mine")` 那道
  // 现在恒真的死判据)。
  //
  // 🔴 v7.6 行为翻转(`docs/v7.6-共识.md`):v7.4/v7.5 时按钮文案钉的是「已启用」
  // ——那时"本地改没改"完全不参与 cardState 判定,只看 record.contentHash 与
  // remoteHash 是否相等。v7.6 拍板后状态词只讲磁盘的事实:这里的"本地也改过"
  // 现在要靠 `useMySkills` 的实时指纹(localHash)与记账基线不同来表达,而这
  // 恰好命中新判据的第 5 条——正确结果因此从「已启用」翻成「与库里不同」。
  // 这不是回归,是拍板的直接推论(见「三个行为翻转」第 1 条)。

  const baseIndex = {
    registryId: "company",
    owner: "skills",
    repo: "skills",
    branch: "main",
    commitSha: "x",
    committedAt: "2026-01-01T00:00:00Z",
    fetchedAt: 0,
    skipped: [],
    fromCache: false,
    offline: false,
    curated: [],
  };

  it("🔴 是我分享的技能、本地也改过 → 按钮是「与库里不同」(v7.6 前是「已启用」),徽标照常出现", () => {
    useSession.setState({
      status: "signedIn",
      user: { login: "wenhao", displayName: "赵文昊", avatarUrl: "" },
    });
    useStoreIndex.setState({
      index: {
        ...baseIndex,
        skills: [
          {
            name: "周报生成",
            dirSlug: "weekly-report",
            description: "",
            path: "weekly-report",
            hasScripts: false,
            fileCount: 1,
            contentHash: "sha:same",
            tags: [],
            author: "赵文昊",
          },
        ],
      } as never,
      activeRegistry: "company",
      activeRepo: "skills/skills",
    });
    useInstall.setState({
      installed: new Map([
        ["weekly-report", { dirSlug: "weekly-report", contentHash: "sha:same", localModified: true } as never],
      ]),
    });
    // localHash 与记账基线("sha:same")不同 → 磁盘上这份内容确实被改过。
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: true, localHash: "sha:local-edit" })],
    });

    render(<InstallPanel dirSlug="weekly-report" />);

    // 按钮不再借"是不是我的"另开分支:曾经的「分享更新」「取回」「已同步」
    // 三个词不该出现,「已启用」也不该出现(v7.6 起那不是准确的状态词)。
    // 详情面板底部走 panel 变体,differs 档的文案是动作词「换成库里的版本」,
    // 不是卡片上那句状态陈述「与库里不同」(两处不同词是有意的,见
    // InstallButton.tsx::labelOf)。
    expect(screen.getByRole("button", { name: "换成库里的版本" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /分享更新|取回|已同步|已启用/ })).toBeNull();
    // 徽标不再按"是不是我的"过滤——本地改没改是与作者身份无关的信息。
    expect(screen.getByText("你修改过这个技能")).toBeTruthy();
  });

  it("对照组:作者不是我、本地也改过时,按钮与徽标的表现与上一条逐字相同", () => {
    useSession.setState({ status: "signedOut", user: null });
    useStoreIndex.setState({
      index: {
        ...baseIndex,
        skills: [
          {
            name: "周报生成",
            dirSlug: "weekly-report",
            description: "",
            path: "weekly-report",
            hasScripts: false,
            fileCount: 1,
            contentHash: "sha:same",
            tags: [],
            author: null,
          },
        ],
      } as never,
      activeRegistry: "company",
      activeRepo: "skills/skills",
    });
    useInstall.setState({
      installed: new Map([
        ["weekly-report", { dirSlug: "weekly-report", contentHash: "sha:same", localModified: true } as never],
      ]),
    });
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: true, localHash: "sha:local-edit" })],
    });

    render(<InstallPanel dirSlug="weekly-report" />);

    expect(screen.getByRole("button", { name: "换成库里的版本" })).toBeTruthy();
    expect(screen.getByText("你修改过这个技能")).toBeTruthy();
  });
});

describe("v7.5:详情面板认得出'这台电脑上已经有了'(docs/v7.5-共识.md)", () => {
  const baseIndex = {
    registryId: "company",
    owner: "skills",
    repo: "skills",
    branch: "main",
    commitSha: "x",
    committedAt: "2026-01-01T00:00:00Z",
    fetchedAt: 0,
    skipped: [],
    fromCache: false,
    offline: false,
    curated: [],
  };

  function seedIndex(contentHash: string) {
    useStoreIndex.setState({
      index: {
        ...baseIndex,
        skills: [
          {
            name: "周报生成",
            dirSlug: "weekly-report",
            description: "",
            path: "weekly-report",
            hasScripts: false,
            fileCount: 1,
            contentHash,
            tags: [],
            author: null,
          },
        ],
      } as never,
      activeRegistry: "company",
      activeRepo: "skills/skills",
    });
  }

  it("无记账 + 本机有本体 + 与库里指纹相同 → 「已在电脑上」,终态不可点", async () => {
    seedIndex("sha:same");
    useInstall.setState({ installed: new Map() });
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: true, localHash: "sha:same" })],
    });

    render(<InstallPanel dirSlug="weekly-report" />);

    const button = screen.getByRole("button", { name: "已在电脑上" });
    expect(button).toBeDisabled();
  });

  it("无记账 + 本机有本体 + 与库里指纹不同 → 「换成库里的版本」(详情底部用动作词,不是卡片的陈述词)", async () => {
    seedIndex("sha:library");
    useInstall.setState({ installed: new Map() });
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: true, localHash: "sha:local" })],
    });

    render(<InstallPanel dirSlug="weekly-report" />);

    // 卡片上的陈述词「与库里不同」不该出现在这里
    expect(screen.queryByText("与库里不同")).toBeNull();
    const button = screen.getByRole("button", { name: "换成库里的版本" });
    expect(button).not.toBeDisabled();
  });

  it("🔴 「换成库里的版本」可点,走既有的 onBegin(acquire),不新写确认逻辑", async () => {
    seedIndex("sha:library");
    useInstall.setState({ installed: new Map(), phase: "idle", dirSlug: null });
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: true, localHash: "sha:local" })],
    });

    render(<InstallPanel dirSlug="weekly-report" />);
    await userEvent.click(screen.getByRole("button", { name: "换成库里的版本" }));

    // `begin()` 把 phase 推进到 choosing(渲染 AgentChooser)——precheck 真正的
    // 拍板发生在 core 那一侧,这里只验证点击确实触达了既有的获取入口。
    await waitFor(() => expect(useInstall.getState().phase).toBe("choosing"));
    expect(useInstall.getState().dirSlug).toBe("weekly-report");
  });

  it("本机没有本体(localPresent: false)→ 仍是「获取」,不会被新逻辑吃掉", () => {
    useStoreIndex.setState({ index: null, activeRegistry: "company", activeRepo: "skills/skills" });
    useInstall.setState({ installed: new Map() });
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: false, localHash: "" })],
    });

    render(<InstallPanel dirSlug="weekly-report" />);

    expect(screen.getByRole("button", { name: "安装" })).toBeTruthy();
    expect(screen.queryByText("已在电脑上")).toBeNull();
  });

  it("已在电脑上(onDisk)是终态时,「装到项目…」文字按钮同样显性化(Q39-A 沿用 installed 的既有判据)", () => {
    seedIndex("sha:same");
    useInstall.setState({ installed: new Map() });
    useMySkills.setState({
      list: [localSkill({ dirSlug: "weekly-report", localPresent: true, localHash: "sha:same" })],
    });

    render(<InstallPanel dirSlug="weekly-report" />);

    const entry = screen.getByRole("button", { name: "装到项目…" });
    expect(entry.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("技能广场详情态:remoteHash 恒为空串,localHash 存在时永远落 onDisk,不比内容(Q43-A)", () => {
    // 广场卡片没有内容指纹——即便本机内容其实与库里不同,也只能说「已在电脑上」,
    // 不能说「与库里不同」,那需要一个不存在的比对基准。
    useInstall.setState({ installed: new Map() });
    useMySkills.setState({
      list: [localSkill({ dirSlug: "react-best-practices", localPresent: true, localHash: "sha:whatever" })],
    });

    render(<InstallPanel dirSlug="react-best-practices" plaza={{ ownerRepo: "vercel-labs/skills" }} />);

    expect(screen.getByRole("button", { name: "已在电脑上" })).toBeTruthy();
    expect(screen.queryByText("与库里不同")).toBeNull();
  });
});

describe("v7.6 任务 3(Q44-A):actions 并进主行,只在 idle/done 渲染", () => {
  // 用一个可辨认的按钮代替真实的 `SkillActionsBlock`(host="store")产物——
  // 这里只钉「摆在哪一行、哪个 phase 摆不摆」这两件版式问题,不重复
  // `SkillActionsBlock.test.tsx` 已经钉过的"店铺宿主下具体哪些项"。
  const actions = (
    <button type="button" aria-label="测试次要动作">
      次要动作
    </button>
  );

  it("idle 档:actions 与主按钮、装到项目在同一行里", () => {
    render(<InstallPanel dirSlug="weekly-report" actions={actions} />);

    const primary = screen.getByRole("button", { name: "安装" });
    const secondary = screen.getByRole("button", { name: "测试次要动作" });
    // 是同一行的直接子元素(不是另起一行、也不是嵌在别的容器里)——
    // `parentElement` 而不是 `closest`,防止"隔着好几层都算通过"这种宽松断言。
    expect(secondary.parentElement).toBe(primary.parentElement);
  });

  it("🔴 running 档:actions 不渲染——不该挨着进度条(检查点 1)", () => {
    useInstall.setState({ phase: "running", dirSlug: "weekly-report", stage: "writing" });
    render(<InstallPanel dirSlug="weekly-report" actions={actions} />);

    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "测试次要动作" })).toBeNull();
  });

  it("choosing 档:actions 同样不渲染——没有一条'主按钮所在的行'可以合并", () => {
    useInstall.setState({ phase: "choosing", dirSlug: "weekly-report", agents: [] });
    render(<InstallPanel dirSlug="weekly-report" actions={actions} />);

    expect(screen.queryByRole("button", { name: "测试次要动作" })).toBeNull();
  });

  it("done 档:actions 与「装到项目…」在同一行里", () => {
    // ⚠️ 与本文件既有的 `seedDone` 同一条纪律:**先 render 再 seed**——挂载时的
    // 收尾 effect 会把 done/error 整个清掉,挂载时就是 done 是构造不出来的状态。
    render(<InstallPanel dirSlug="weekly-report" actions={actions} />);
    act(() => {
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
    });

    const scope = screen.getByRole("button", { name: "装到项目…" });
    const secondary = screen.getByRole("button", { name: "测试次要动作" });
    // `InstallScopeMenu` 自己的触发按钮外面包了一层 div(v7.7 起是
    // `useFloatingMenu` 的 rect 来源,不再靠 `position:relative` 当定位上下文
    // ——菜单已经 portal 到 `document.body`),所以不能直接比 `parentElement`
    // ——用 "actions 的父级(那一整行)包含 scope 按钮" 来断言两者同排。
    expect(secondary.parentElement?.contains(scope)).toBe(true);
  });
});
