import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSections } from "@/components/ProjectSections";
import type { ProjectGroupView, ProjectSkillView } from "@/lib/ipc";
import { useProjects } from "@/store/project";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

function skill(over: Partial<ProjectSkillView> = {}): ProjectSkillView {
  return {
    key: "vercel-react-best-practices",
    displayName: "React 最佳实践",
    description: "写 React 的规范",
    source: "vercel-labs/agent-skills",
    sourceType: "github",
    dirSlug: "react-best-practices",
    registryId: "plaza",
    repo: "vercel-labs/agent-skills",
    updatable: true,
    ...over,
  };
}

function group(over: Partial<ProjectGroupView> = {}): ProjectGroupView {
  return {
    path: "/w/我的项目",
    folderName: "我的项目",
    missing: false,
    readOnly: false,
    skills: [skill()],
    ...over,
  };
}

function seed(groups: ProjectGroupView[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "project_list") return groups;
    if (cmd === "agents_detected") {
      return { agents: [{ name: "claude-code", installed: true, disabled: false, needsLink: true }] };
    }
    return null;
  });
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

describe("项目分区", () => {
  it("列出项目与里面的技能,展示名不是内部键", async () => {
    seed([group()]);
    render(<ProjectSections />);

    await screen.findByText("我的项目");
    expect(screen.getByText("React 最佳实践")).toBeTruthy();
    // 内部键(frontmatter name 的 sanitize 结果)绝不能出现在界面上
    expect(screen.queryByText("vercel-react-best-practices")).toBeNull();
  });

  it("更新按 dirSlug 取数,不是按 key —— 两者常不同,拿 key 取会找不到技能", async () => {
    seed([group()]);
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    await userEvent.click(screen.getByRole("button", { name: "更新" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "project_skill_update");
      expect(call).toBeTruthy();
      const args = (call![1] as { args: Record<string, unknown> }).args;
      expect(args.dirSlug).toBe("react-best-practices");
      expect(args.key).toBe("vercel-react-best-practices");
    });
  });

  it("更新带上账上的源与库坐标 —— 缺省会打到内建源主仓,装错技能", async () => {
    seed([group()]);
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    await userEvent.click(screen.getByRole("button", { name: "更新" }));

    await waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "project_skill_update");
      expect(call).toBeTruthy();
      const args = (call![1] as { args: Record<string, unknown> }).args;
      // 项目 lock 里只有 source/sourceUrl,core 已把它还原成"源 + 库坐标";
      // 这一层不传下去等于白还原(M4「更新必须带账上的仓库坐标」同一类缺陷)
      expect(args.registryId).toBe("plaza");
      expect(args.repo).toBe("vercel-labs/agent-skills");
    });
  });

  it("来源还原不了的技能不摆更新按钮 —— 不摆比摆一个必然报错的按钮好", async () => {
    seed([group({ skills: [skill({ sourceType: "local", updatable: false })] })]);
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("移除要两步:先点移除,再点确认才真的调 IPC", async () => {
    seed([group()]);
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    await userEvent.click(screen.getByRole("button", { name: "移除" }));
    // 第一步只是展开确认,不能有任何 IPC
    expect(invoke.mock.calls.find(([cmd]) => cmd === "project_skill_remove")).toBeUndefined();

    const confirmButtons = screen.getAllByRole("button", { name: "移除" });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "project_skill_remove");
      expect(call).toBeTruthy();
      // confirmed 必须为 true(铁律 7:破坏性操作带前端确认结果)
      expect((call![1] as { confirmed: boolean }).confirmed).toBe(true);
    });
  });

  it("目录不在了:说明情况,且不摆任何会动到它的按钮", async () => {
    seed([group({ missing: true, skills: [] })]);
    render(<ProjectSections />);

    await screen.findByText("这个文件夹不在了");
    expect(screen.getByRole("button", { name: "从列表移除" })).toBeTruthy();
    // 目录都不在了,「在文件夹中显示」摆出来就是引诱用户点一个必然失败的按钮
    expect(screen.queryByRole("button", { name: "在文件夹中显示" })).toBeNull();
  });

  it("记账文件看不懂:只读提示,不列技能", async () => {
    seed([group({ readOnly: true, skills: [] })]);
    render(<ProjectSections />);

    await screen.findByText("这个文件夹的记账文件本应用看不懂,只能查看");
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("一个项目都没有时摆引导语,而不是空白", async () => {
    seed([]);
    render(<ProjectSections />);

    await screen.findByText("还没有把技能装到任何项目里。");
  });

  it("移除后有位置没清理干净时,如实告诉用户", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "project_list") return [group()];
      if (cmd === "project_skill_remove") {
        return { bodyRemoved: true, unlinked: [], kept: [{ kind: "keptForeignDir", dir: "/w/x" }] };
      }
      return null;
    });
    render(<ProjectSections />);
    await screen.findByText("React 最佳实践");

    await userEvent.click(screen.getByRole("button", { name: "移除" }));
    const confirmButtons = screen.getAllByRole("button", { name: "移除" });
    await userEvent.click(confirmButtons[confirmButtons.length - 1]);

    // core 刻意不删内容不一样的实体目录,界面必须说出来,不能装作全清干净了
    await screen.findByText(/有 1 个位置没有清理/);
  });
});
