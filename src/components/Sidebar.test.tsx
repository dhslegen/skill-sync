import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "./Sidebar";
import type { InstalledSkillView, Section } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";
import { useUpdatePrompt } from "@/store/update-prompt";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/** core::ownership::section(relation) 的镜像(v7 任务 4 修复轮 1 I2 同款处置):
 *  section 不能是与 relation 无关的独立常量,否则 view({relation:"x"}) 会静默
 *  构造出生产上不可能出现的组合。 */
function sectionOfRelation(relation: InstalledSkillView["relation"]): Section {
  switch (relation) {
    case "shared":
      return "sharedTo";
    case "draft":
      return "shareable";
    default:
      return "installedFrom";
  }
}

const view = (over: Partial<InstalledSkillView> = {}): InstalledSkillView => ({
  dirSlug: "weekly-report",
  commitSha: "aaa1111",
  contentHash: "sha256:mine",
  agents: ["claude-code"],
  installedAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
  localModified: false,
  sourceOwner: "skills",
  sourceRepo: "skills",
  registryId: "company",
  sourceRemoved: false,
  libraryRemoved: false,
  relation: "installed",
  localPresent: true,
  sourceLabel: "skills/skills",
  body: "/h/.agents/skills/weekly-report",
  localHash: "sha256:mine",
  tools: [],
  versions: [],
  shareBlocked: null,
  section: sectionOfRelation(over.relation ?? "installed"),
  libraryUrl: null,
  canonicalReaders: null,
  ...over,
});

const index = (...slugs: string[]) => ({
  registryId: "company",
  owner: "skills",
  repo: "skills",
  commitSha: "bbb2222",
  fetchedAt: "2026-07-30T12:00:00.000Z",
  tags: [],
  skills: slugs.map((dirSlug) => ({ dirSlug, contentHash: "sha256:newer" })),
});

function reset() {
  useSession.setState({ status: "signedOut", user: null });
  useUpdatePrompt.setState({ readyVersion: null, dismissed: false });
  useMySkills.setState({ list: null });
  useStoreIndex.setState({ index: null });
  useUi.setState({ page: "store" });
}

/** 导航项上的角标:取「我的技能」那颗按钮里的数字。 */
function mineBadge(): string | null {
  const btn = screen.getByRole("button", { name: /我的技能/ });
  return btn.querySelector("[data-testid='nav-badge']")?.textContent ?? null;
}

describe("侧边栏 · 技能更新角标", () => {
  beforeEach(reset);

  it("没有可用更新时不摆角标", () => {
    useMySkills.setState({ list: [view()] });
    useStoreIndex.setState({
      index: { ...index("weekly-report"), skills: [{ dirSlug: "weekly-report", contentHash: "sha256:mine" }] } as never,
    });
    render(<Sidebar version="0.3.0" />);

    expect(mineBadge()).toBeNull();
  });

  it("有更新时在「我的技能」上标出数量", () => {
    useMySkills.setState({ list: [view(), view({ dirSlug: "code-review" })] });
    useStoreIndex.setState({ index: index("weekly-report", "code-review") as never });
    render(<Sidebar version="0.3.0" />);

    expect(mineBadge()).toBe("2");
  });

  it("列表还没加载出来时不摆角标(不拿空数据当\"没有更新\"之外的任何结论)", () => {
    useStoreIndex.setState({ index: index("weekly-report") as never });
    render(<Sidebar version="0.3.0" />);

    expect(mineBadge()).toBeNull();
  });

  // 🔴 v7.3:「项目里的技能」从「我的技能」的第四个页签升成侧边栏一条独立的页。
  // 两条命题都要钉:①它在侧边栏上、点了会切页(否则整页无入口,ProjectSections
  // 变成挂在 App 里谁也到不了的死组件);②**它没有角标**(项目级链路算不出
  // "有几个要处理"这个数,摆一个没有含义的点比不摆更糟)。
  it("侧边栏有「项目里的技能」,点它切到 projects 页,且不摆角标", async () => {
    useMySkills.setState({ list: [view(), view({ dirSlug: "code-review" })] });
    useStoreIndex.setState({ index: index("weekly-report", "code-review") as never });
    render(<Sidebar version="0.3.0" />);

    const btn = screen.getByRole("button", { name: /项目里的技能/ });
    // 「我的技能」此刻角标是 2,而它旁边这一条一个数都不该有
    expect(mineBadge()).toBe("2");
    expect(btn.querySelector("[data-testid='nav-badge']")).toBeNull();

    await userEvent.click(btn);
    expect(useUi.getState().page).toBe("projects");
  });

  // 2026-08-07 用户报"窗口拖不动":顶部这条 52px 空白(给 macOS 红绿灯让位的地方)
  // 正是想挪窗口时最自然会按下去的位置,原先却没有拖拽区,而 App.tsx 里那个横跨
  // 全宽的候选又被 pointer-events-none 废掉了。没有它,无边框窗口就真的挪不动。
  it("顶部留出的空白必须是窗口拖拽区,否则窗口挪不动", () => {
    const { container } = render(<Sidebar version="0.3.0" />);
    const region = container.querySelector("[data-tauri-drag-region]");

    expect(region).not.toBeNull();
    // 拖拽区不能自己把鼠标事件屏蔽掉——那正是它此前失效的原因
    expect(region?.className ?? "").not.toContain("pointer-events-none");
  });
});
