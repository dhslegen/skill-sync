import { beforeEach, describe, expect, it, vi } from "vitest";

import { recentProjects, useProjects, RECENT_PROJECT_LIMIT } from "@/store/project";
import type { ProjectGroupView } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

function group(over: Partial<ProjectGroupView> = {}): ProjectGroupView {
  return {
    path: "/w/a",
    folderName: "a",
    missing: false,
    readOnly: false,
    skills: [],
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset();
  useProjects.setState({
    groups: [],
    loading: false,
    error: null,
    installing: null,
    notice: null,
    decision: null,
    busyKey: null,
    confirm: null,
  });
});

describe("最近项目", () => {
  it("不在了的项目不进「最近」—— 点了必然失败的入口不该摆出来", () => {
    const got = recentProjects([
      group({ path: "/w/a" }),
      group({ path: "/w/gone", missing: true }),
      group({ path: "/w/b" }),
    ]);
    expect(got.map((g) => g.path)).toEqual(["/w/a", "/w/b"]);
  });

  it("最多 RECENT_PROJECT_LIMIT 条", () => {
    const many = Array.from({ length: RECENT_PROJECT_LIMIT + 3 }, (_, i) =>
      group({ path: `/w/${i}` }),
    );
    expect(recentProjects(many)).toHaveLength(RECENT_PROJECT_LIMIT);
  });
});

describe("装到项目", () => {
  it("core 说要拍板时:弹决策、**不刷新列表** —— 什么都还没发生", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_skill_install") return { status: "needsDecision", key: "x" };
      if (cmd === "project_list") return [group()];
      return null;
    });

    await useProjects.getState().install({
      projectPath: "/w/a",
      dirSlug: "x",
      agentIds: [],
    });

    expect(useProjects.getState().decision).toMatchObject({ kind: "replace" });
    // 拍板前 core 侧磁盘零写入,前端也不该去重新读列表:
    // 读了就等于把"什么都没发生"渲染成"好像发生过一次"
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "project_list")).toHaveLength(0);
  });

  it("装成功后刷新列表并给一句提示", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_skill_install") {
        return { status: "installed", key: "x", linkedAgents: [] };
      }
      if (cmd === "project_list") return [group()];
      return null;
    });

    await useProjects.getState().install({
      projectPath: "/w/我的项目",
      dirSlug: "x",
      agentIds: [],
    });

    expect(useProjects.getState().notice).toContain("我的项目");
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "project_list")).toHaveLength(1);
  });

  it("已经装过时说清它本来就在,不谎报刚装好", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_skill_install") return { status: "alreadyInstalled", key: "x" };
      if (cmd === "project_list") return [group()];
      return null;
    });

    await useProjects.getState().install({ projectPath: "/w/a", dirSlug: "x", agentIds: [] });

    expect(useProjects.getState().notice).toBe("a 里已经有这个技能了");
  });
});

describe("更新", () => {
  it("本体被改过时弹决策,不静默覆盖", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_skill_update") return { status: "hasLocalEdits", key: "x" };
      if (cmd === "project_list") return [group()];
      return null;
    });

    await useProjects.getState().update({
      projectPath: "/w/a",
      key: "x",
      dirSlug: "x",
      agentIds: [],
    });

    expect(useProjects.getState().decision).toMatchObject({ kind: "localEdits" });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "project_list")).toHaveLength(0);
  });
});

describe("读列表", () => {
  it("IPC 给回非数组时落成空列表,而不是让渲染层在 .length 上崩掉", async () => {
    invoke.mockImplementation(async () => null);

    await useProjects.getState().load();

    expect(useProjects.getState().groups).toEqual([]);
  });
});

describe("装到项目前的确认", () => {
  // 用户 2026-08-22 真机反馈:"我以为是选完路径后点击安装,结果直接安装了"。
  // 选择位置 ≠ 确认写入 —— 系统选择框的按钮写着「打开」,那是"选中"语义;
  // 而这一步要往用户的项目目录里写文件、建关联、写 skills-lock.json。
  it("选完文件夹只是进入待确认,磁盘零写入", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_pick") return "/w/我的项目";
      if (cmd === "agents_detected") {
        return { agents: [{ name: "claude-code", displayName: "Claude Code", installed: true, disabled: false, isUniversal: false, needsLink: true }] };
      }
      return null;
    });

    await useProjects.getState().requestInstall({ dirSlug: "x" });

    expect(useProjects.getState().confirm).toMatchObject({
      projectPath: "/w/我的项目",
      dirSlug: "x",
    });
    // 这一步绝不能安装
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "project_skill_install")).toHaveLength(0);
  });

  it("确认条要说清会关联到哪些工具,用展示名不是内部键", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_pick") return "/w/a";
      if (cmd === "agents_detected") {
        return {
          agents: [
            { name: "claude-code", displayName: "Claude Code", installed: true, disabled: false, isUniversal: false, needsLink: true },
            { name: "trae", displayName: "Trae", installed: false, disabled: false, isUniversal: false, needsLink: true },
          ],
        };
      }
      return null;
    });

    await useProjects.getState().requestInstall({ dirSlug: "x" });

    const confirm = useProjects.getState().confirm!;
    expect(confirm.agentIds).toEqual(["claude-code"]);
    // 界面绝不露 agent name(CLAUDE.md 撞过两次的教训)
    expect(confirm.agentLabels).toEqual(["Claude Code"]);
  });

  it("用户取消选择框时什么都不发生", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "project_pick" ? null : null));

    await useProjects.getState().requestInstall({ dirSlug: "x" });

    expect(useProjects.getState().confirm).toBeNull();
  });

  it("点「装到这里」才真装,装完确认条收起", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_pick") return "/w/我的项目";
      if (cmd === "agents_detected") return { agents: [] };
      if (cmd === "project_skill_install") return { status: "installed", key: "x", linkedAgents: [] };
      if (cmd === "project_list") return [group()];
      return null;
    });

    await useProjects.getState().requestInstall({ dirSlug: "x" });
    await useProjects.getState().confirmInstall();

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "project_skill_install")).toHaveLength(1);
    expect(useProjects.getState().confirm).toBeNull();
    expect(useProjects.getState().notice).toContain("我的项目");
  });

  it("取消确认:磁盘零写入,状态清干净", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_pick") return "/w/a";
      if (cmd === "agents_detected") return { agents: [] };
      return null;
    });

    await useProjects.getState().requestInstall({ dirSlug: "x" });
    useProjects.getState().cancelConfirm();

    expect(useProjects.getState().confirm).toBeNull();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "project_skill_install")).toHaveLength(0);
  });

  it("已经装过这个技能的项目,确认条直接说明,不当成一次新安装", async () => {
    // 不这么做的话,用户要等一整轮网络请求(下压缩包、建索引)才被告知"已经有了"
    useProjects.setState({
      groups: [
        group({
          path: "/w/我的项目",
          skills: [
            {
              key: "vercel-react-best-practices",
              displayName: "React 最佳实践",
              description: "",
              source: "o/r",
              sourceType: "github",
              dirSlug: "react-best-practices",
              registryId: "plaza",
              repo: "o/r",
              updatable: true,
            },
          ],
        }),
      ],
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_pick") return "/w/我的项目";
      if (cmd === "agents_detected") return { agents: [] };
      return null;
    });

    await useProjects.getState().requestInstall({ dirSlug: "react-best-practices" });

    expect(useProjects.getState().confirm?.alreadyInstalled).toBe(true);
  });
});

describe("提示的生命周期", () => {
  it("换一个技能看详情时,上一次的安装提示不该还挂着", async () => {
    // 真实缺陷:dismissNotice 定义了但全项目一处都没调用,提示一旦出现就永久留着
    // ——切到别的技能详情还显示上一条的文字,说的是另一个技能的事。
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_skill_install") return { status: "installed", key: "x", linkedAgents: [] };
      if (cmd === "project_list") return [group()];
      return null;
    });
    await useProjects.getState().install({ projectPath: "/w/a", dirSlug: "x", agentIds: [] });
    expect(useProjects.getState().notice).toBeTruthy();

    useProjects.getState().dismissNotice();

    expect(useProjects.getState().notice).toBeNull();
  });
});
