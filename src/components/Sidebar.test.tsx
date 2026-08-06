import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Sidebar } from "./Sidebar";
import type { InstalledSkillView } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUpdatePrompt } from "@/store/update-prompt";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

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
  unclaimed: false,
  claimBindable: false,
  localOnly: false,
  claimed: false,
  links: [],
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
});
