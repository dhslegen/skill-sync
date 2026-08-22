import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstalledScopes } from "@/components/InstalledScopes";
import { useInstall } from "@/store/install";
import { useProjects } from "@/store/project";
import { useUi } from "@/store/ui";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

function projectWith(dirSlug: string | null, path = "/w/我的项目", folderName = "我的项目") {
  return {
    path,
    folderName,
    missing: false,
    readOnly: false,
    skills: dirSlug
      ? [
          {
            key: "k", displayName: "周报生成", description: "",
            source: "skills/skills", sourceType: "git", dirSlug,
            registryId: "company", repo: "skills/skills", updatable: true,
          },
        ]
      : [],
  };
}

beforeEach(() => {
  invoke.mockReset();
  // ⚠️ project_list 要把当前 store 里的 groups 原样读回去:组件挂载时会 load() 一次,
  // 返回 null 的话会把测试刚 setState 的数据冲成空 —— 表现是"按钮渲染出来又消失",
  // 异步断言(await click)就会落空,看着像实现坏了(测试自己的坑)。
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "project_list" ? useProjects.getState().groups : null,
  );
  useProjects.setState({
    groups: [], loading: false, error: null, installing: null,
    notice: null, decision: null, busyKey: null, confirm: null,
  });
  useInstall.setState({ installed: new Map() });
  useUi.setState({ page: "store" });
});

describe("详情面板的「已装到」", () => {
  it("哪儿都没装时整块不摆 —— 平时不占地方", () => {
    const { container } = render(<InstalledScopes dirSlug="weekly-report" />);
    expect(container.textContent).toBe("");
  });

  it("装在全局时说「这台电脑」,不露内部路径", () => {
    useInstall.setState({
      installed: new Map([["weekly-report", { dirSlug: "weekly-report" } as never]]),
    });
    render(<InstalledScopes dirSlug="weekly-report" />);

    expect(screen.getByText("这台电脑")).toBeTruthy();
  });

  it("列出装过的项目名,完整路径挂 title", () => {
    useProjects.setState({ groups: [projectWith("weekly-report")] });
    render(<InstalledScopes dirSlug="weekly-report" />);

    const row = screen.getByRole("button", { name: /我的项目/ });
    expect(row.getAttribute("title")).toBe("/w/我的项目");
  });

  it("按仓库目录名匹配,不按安装键 —— 广场技能两者经常不同", () => {
    // key 是 frontmatter name(vercel-react-best-practices),
    // 商店与详情面板用的是仓库目录名(react-best-practices)。按 key 匹配会全都对不上。
    useProjects.setState({
      groups: [
        {
          ...projectWith(null),
          skills: [
            {
              key: "vercel-react-best-practices", displayName: "React 最佳实践", description: "",
              source: "vercel-labs/agent-skills", sourceType: "github",
              dirSlug: "react-best-practices", registryId: "plaza",
              repo: "vercel-labs/agent-skills", updatable: true,
            },
          ],
        },
      ],
    });
    render(<InstalledScopes dirSlug="react-best-practices" />);

    expect(screen.getByRole("button", { name: /我的项目/ })).toBeTruthy();
  });

  it("点项目一行跳到「我的技能」", async () => {
    useProjects.setState({ groups: [projectWith("weekly-report")] });
    render(<InstalledScopes dirSlug="weekly-report" />);

    await userEvent.click(screen.getByRole("button", { name: /我的项目/ }));

    expect(useUi.getState().page).toBe("mine");
  });

  it("目录不在了的项目不列 —— 它已经不是一个能去的地方", () => {
    useProjects.setState({
      groups: [{ ...projectWith("weekly-report", "/w/没了", "没了"), missing: true }],
    });
    const { container } = render(<InstalledScopes dirSlug="weekly-report" />);

    expect(container.textContent).toBe("");
  });
});
