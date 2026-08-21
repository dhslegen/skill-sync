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
