import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SkillActionsBlock } from "./SkillActionsBlock";
import type { InstalledSkillView, Section } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

const invoke = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  void cmd;
  void args;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/** core::ownership::section(relation) 的镜像:section 不能是与 relation 无关的
 *  独立常量,否则 fixture 会静默构造出生产上不可能的组合(空转模式③)。 */
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
  commitSha: "a1b2c3d",
  contentHash: "sha256:base",
  agents: ["claude-code"],
  installedAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  localModified: true,
  sourceOwner: "skills",
  sourceRepo: "skills",
  registryId: "company",
  sourceRemoved: false,
  libraryRemoved: false,
  relation: "installed",
  localPresent: true,
  sourceLabel: "skills/skills",
  body: "/h/.claude/skills/weekly-report",
  localHash: "sha256:local",
  tools: [],
  versions: [],
  shareBlocked: null,
  section: sectionOfRelation(over.relation ?? "installed"),
  review: null,
  canonicalReaders: null,
  ...over,
});

beforeEach(() => {
  useStoreIndex.setState({ index: null });
  useMySkills.setState({
    list: null,
    shareBusy: null,
    shareDone: null,
    shareError: null,
    versionChoice: null,
    shareableIndexes: new Map(),
  });
});

const ERR = { code: "REPO_FORBIDDEN", message: "你对这个技能库没有写权限" };

/**
 * 终审复审轮 1,C-A:§12 把「贡献更改」「分享」「移除」搬进了详情面板的动作区,
 * 而这些动作的**结果**此前只写进 `useMySkills` 的全局字段,唯一渲染点在
 * `MySkillsPage`——从商店/广场详情打开时那一页根本没挂载(零反馈),从「我的技能」
 * 打开时它被详情面板的全屏遮罩盖住(点不到)。这一组用例钉的就是"那条失败/成功
 * 真的到达了展示层",以及"到达的是**这一个**技能的面板"。
 */
describe("SkillActionsBlock:分享的结果必须在动作区里看得见", () => {
  it("分享失败:错误摆在动作区里(不依赖 MySkillsPage 挂载)", () => {
    const skill = view();
    render(<SkillActionsBlock skill={skill} />);
    act(() => useMySkills.setState({ shareError: { dirSlug: skill.dirSlug, error: ERR, flow: "changes" as const } }));

    expect(screen.getByText(/分享改动没能完成/)).toBeTruthy();
    expect(screen.getByText(/没有写权限/)).toBeTruthy();
  });

  it("直推成功:说「已分享到公司技能库」", () => {
    const skill = view();
    render(<SkillActionsBlock skill={skill} />);
    act(() => useMySkills.setState({ shareDone: { dirSlug: skill.dirSlug, mode: "pushed", flow: "changes" as const } }));

    expect(screen.getByText(/改动已分享到公司技能库/)).toBeTruthy();
  });

  // 🔴 这一条是「贡献更改」最要命的那一档:core 刻意不动记账,刷新后按钮原样
  // 还是「贡献更改」,没有这句反馈用户会以为没点着,再点一次就会开出第二个
  // 内容相同的合并请求(`share.rs::review_branch` 的分支名带时间戳)。
  it("走评审成功:说「已提交审核」,不是静默无事发生", () => {
    const skill = view();
    render(<SkillActionsBlock skill={skill} />);
    act(() => useMySkills.setState({ shareDone: { dirSlug: skill.dirSlug, mode: "reviewRequested", flow: "changes" as const } }));

    expect(screen.getByText(/改动已提交审核/)).toBeTruthy();
  });

  // 🔴 终审复审轮 1 #3:两条路的说法必须不一样。首次分享(`flow:"share"`)时
  // 用户并没有"改动"过什么,沿用「改动已分享」就是一句假话——而这一波正是把
  // 这些键搬到了首次分享也走得到的落点上,所以这个假话是本波引入的。
  it("首次分享成功:说「已分享到公司技能库」,不冒出「改动」两个字", () => {
    const skill = view({ relation: "draft" });
    render(<SkillActionsBlock skill={skill} />);
    act(() =>
      useMySkills.setState({
        shareDone: { dirSlug: skill.dirSlug, mode: "pushed", flow: "share" },
      }),
    );

    expect(screen.getByText("已分享到公司技能库。")).toBeTruthy();
    expect(screen.queryByText(/改动已分享/)).toBeNull();
  });

  it("首次分享走评审:说「已提交审核」,同样不带「改动」", () => {
    const skill = view({ relation: "draft" });
    render(<SkillActionsBlock skill={skill} />);
    act(() =>
      useMySkills.setState({
        shareDone: { dirSlug: skill.dirSlug, mode: "reviewRequested", flow: "share" },
      }),
    );

    expect(screen.getByText("已提交审核,审核通过后生效。")).toBeTruthy();
    expect(screen.queryByText(/改动已提交审核/)).toBeNull();
  });

  it("首次分享失败:说「分享没能完成」,不说「分享改动没能完成」", () => {
    const skill = view({ relation: "draft" });
    render(<SkillActionsBlock skill={skill} />);
    act(() =>
      useMySkills.setState({
        shareError: { dirSlug: skill.dirSlug, error: ERR, flow: "share" },
      }),
    );

    expect(screen.getByText(/分享没能完成/)).toBeTruthy();
    expect(screen.queryByText(/分享改动没能完成/)).toBeNull();
  });

  // 🔴 跨技能归属(负向):本期已经抓到过"从零反馈变成错误的反馈"这个变体
  // ——补了渲染点却不校验归属,技能 B 的面板会显示技能 A 的失败,撒的谎是
  // "哪个技能出了问题"。
  it("技能 A 分享失败时,技能 B 的动作区一个字都不显示", () => {
    render(<SkillActionsBlock skill={view({ dirSlug: "other-skill" })} />);
    act(() => useMySkills.setState({ shareError: { dirSlug: "weekly-report", error: ERR, flow: "changes" as const } }));

    expect(screen.queryByText(/分享改动没能完成/)).toBeNull();
    expect(screen.queryByText(/没有写权限/)).toBeNull();
  });

  it("技能 A 分享成功时,技能 B 的动作区不冒充「已分享」", () => {
    render(<SkillActionsBlock skill={view({ dirSlug: "other-skill" })} />);
    act(() => useMySkills.setState({ shareDone: { dirSlug: "weekly-report", mode: "pushed", flow: "changes" as const } }));

    expect(screen.queryByText(/改动已分享到公司技能库/)).toBeNull();
  });
});
