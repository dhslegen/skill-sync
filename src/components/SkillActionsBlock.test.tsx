import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SkillActionsBlock } from "./SkillActionsBlock";
import type { InstalledSkillView, Section } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { shareTargetKey, useShare } from "@/store/share";
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
  libraryUrl: null,
  canonicalReaders: null,
  ...over,
});

beforeEach(() => {
  // 有用例用 mockImplementation 整个换掉实现(测 skill_reveal 抛错),
  // mockClear 只清调用记录不清实现——不 reset 的话下一条会带着假实现跑。
  invoke.mockReset();
  invoke.mockImplementation(async () => null);
  useStoreIndex.setState({ index: null });
  useShare.setState({ targetRepo: null, preview: "unknown", previews: {} });
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
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="mine" />);
    act(() => useMySkills.setState({ shareError: { dirSlug: skill.dirSlug, error: ERR, flow: "changes" as const } }));

    expect(screen.getByText(/分享改动没能完成/)).toBeTruthy();
    expect(screen.getByText(/没有写权限/)).toBeTruthy();
  });

  it("直推成功:说「已分享到公司技能库」", () => {
    const skill = view();
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="mine" />);
    act(() => useMySkills.setState({ shareDone: { dirSlug: skill.dirSlug, mode: "pushed", flow: "changes" as const } }));

    expect(screen.getByText(/改动已分享到公司技能库/)).toBeTruthy();
  });

  // 🔴 终审复审轮 1 #3:两条路的说法必须不一样。首次分享(`flow:"share"`)时
  // 用户并没有"改动"过什么,沿用「改动已分享」就是一句假话——而这一波正是把
  // 这些键搬到了首次分享也走得到的落点上,所以这个假话是本波引入的。
  it("首次分享成功:说「已分享到公司技能库」,不冒出「改动」两个字", () => {
    const skill = view({ relation: "draft" });
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="mine" />);
    act(() =>
      useMySkills.setState({
        shareDone: { dirSlug: skill.dirSlug, mode: "pushed", flow: "share" },
      }),
    );

    expect(screen.getByText("已分享到公司技能库。")).toBeTruthy();
    expect(screen.queryByText(/改动已分享/)).toBeNull();
  });

  it("首次分享失败:说「分享没能完成」,不说「分享改动没能完成」", () => {
    const skill = view({ relation: "draft" });
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="mine" />);
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
    render(<SkillActionsBlock skill={view({ dirSlug: "other-skill" })} remoteChanged={false} subject="示例技能" host="mine" />);
    act(() => useMySkills.setState({ shareError: { dirSlug: "weekly-report", error: ERR, flow: "changes" as const } }));

    expect(screen.queryByText(/分享改动没能完成/)).toBeNull();
    expect(screen.queryByText(/没有写权限/)).toBeNull();
  });

  it("技能 A 分享成功时,技能 B 的动作区不冒充「已分享」", () => {
    render(<SkillActionsBlock skill={view({ dirSlug: "other-skill" })} remoteChanged={false} subject="示例技能" host="mine" />);
    act(() => useMySkills.setState({ shareDone: { dirSlug: "weekly-report", mode: "pushed", flow: "changes" as const } }));

    expect(screen.queryByText(/改动已分享到公司技能库/)).toBeNull();
  });
});

/**
 * v7.1 任务 3(Q3):详情面板里「打开文件夹」只此一处——它从
 * `WhereBlocks`「这台电脑上」那一块搬到了这个页脚。下面两条命题是从
 * `WhereBlocks.test.tsx` **原样搬过来的**(不是新写、也不是放宽),
 * 搬家的理由见 `SkillActionsBlock.tsx` 的组件文档。
 */
describe("打开文件夹(Q3:详情面板里只此一处)", () => {
  it("传 body(本体绝对路径),绝不传 dirSlug", async () => {
    const user = userEvent.setup();
    render(<SkillActionsBlock skill={view()} remoteChanged={false} subject="示例技能" host="mine" />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("skill_reveal", expect.anything()));
    const call = invoke.mock.calls.find((c) => c[0] === "skill_reveal");
    expect(call?.[1]).toEqual({ args: { path: "/h/.claude/skills/weekly-report" } });
  });

  it("失败要有渲染点,不能静默吞掉", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_reveal") throw { code: "FS_NOT_A_SKILL", message: "那不是一个技能目录" };
      return null;
    });
    const user = userEvent.setup();
    render(<SkillActionsBlock skill={view()} remoteChanged={false} subject="示例技能" host="mine" />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(await screen.findByText(/那不是一个技能目录/)).toBeInTheDocument();
  });

  it("页脚里「打开文件夹」只有一个,不是两个入口", () => {
    render(<SkillActionsBlock skill={view()} remoteChanged={false} subject="示例技能" host="mine" />);
    expect(screen.getAllByRole("button", { name: "打开文件夹" })).toHaveLength(1);
  });

  it("本体不在这台电脑上(body 为空)时不摆这个按钮", () => {
    render(
      <SkillActionsBlock
        skill={view({ relation: "shared", localPresent: false, body: "" })}
        remoteChanged={false} subject="示例技能" host="mine"
      />,
    );
    expect(screen.queryByRole("button", { name: "打开文件夹" })).not.toBeInTheDocument();
  });
});

describe("页脚的「在技能库里查看」:core 拼得出地址才摆", () => {
  const URL = "http://gitea.internal.example/skills/skills/src/branch/main/skills/weekly-report";

  it("core 给了地址就摆出来,点了原样交给 open_library_url", async () => {
    const user = userEvent.setup();
    render(<SkillActionsBlock skill={view({ libraryUrl: URL })} remoteChanged={false} subject="示例技能" host="mine" />);
    expect(screen.getAllByRole("button", { name: "在技能库里查看" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "在技能库里查看" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "open_library_url",
        expect.objectContaining({ args: { url: URL } }),
      ),
    );
  });

  // 🔴 「拼不出来就不摆」——不摆比摆一个必然报错(404)的按钮好。
  it("core 拼不出来(libraryUrl 为 null)时整颗不摆", () => {
    render(<SkillActionsBlock skill={view()} remoteChanged={false} subject="示例技能" host="mine" />);
    expect(screen.queryByRole("button", { name: "在技能库里查看" })).not.toBeInTheDocument();
  });

  it("打开失败要有渲染点,不能静默吞掉", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "open_library_url") throw { code: "REPO_UNTRUSTED_URL", message: "这个链接不属于任何已配置的技能库" };
      return null;
    });
    const user = userEvent.setup();
    render(<SkillActionsBlock skill={view({ libraryUrl: URL })} remoteChanged={false} subject="示例技能" host="mine" />);
    await user.click(screen.getByRole("button", { name: "在技能库里查看" }));
    expect(await screen.findByText(/不属于任何已配置的技能库/)).toBeInTheDocument();
  });

  // 🔴 v8 任务 3 / D8:没有写权限时,详情面板动作区这一处也要禁用 + 说明。
  // 三处渲染点(行 / 详情动作区 / 分享确认屏)漏一处就是"行上禁了、详情里能点"。
  it("没有写权限:分享族主按钮禁用,并说清为什么,「打开文件夹」仍在", () => {
    useShare.setState({ previews: { [shareTargetKey(undefined, undefined)]: "noAccess" } });
    render(
      <SkillActionsBlock
        skill={view({ relation: "draft", localModified: false })}
        remoteChanged={false} subject="示例技能" host="mine"
      />,
    );
    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
    expect(screen.getByText(/没有写入权限/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeInTheDocument();
  });

  it("对照组:探不到(unknown)时照常可点——预检永远 fail-open", () => {
    useShare.setState({ previews: {} });
    render(
      <SkillActionsBlock
        skill={view({ relation: "draft", localModified: false })}
        remoteChanged={false} subject="示例技能" host="mine"
      />,
    );
    expect(screen.getByRole("button", { name: "分享" })).toBeEnabled();
    expect(screen.queryByText(/没有写入权限/)).not.toBeInTheDocument();
  });
});

/**
 * Q44-A(v7.6 任务 2 + 任务 3):商店/广场详情面板下这个组件不再摆自己的主按钮
 * ——那一格让给 `InstallPanel` 的 `cardState`(见 `InstallPanel.tsx` 的组件
 * 文档)。"推"的动作(分享/贡献更改/更新……都是 `rowAction`「我的技能」语境
 * 下的按钮)一律不在这个宿主下出现,打开文件夹/在技能库里查看这两个
 * "不推不拉"的动作照常摆出来;「移除」是**危险动作**,Q44-A 用户批的原文
 * 「「…」收危险动作(移除)」(任务 3 改正 task-2 把这半句转写丢的偏差)
 * ——在这个宿主下不再是常驻可见按钮,收进「…」(`SkillRowMenu`)。每一条都配
 * 一个 `host="mine"` 的对照组——只测"store 下没有"证明不了这是 host 分流的
 * 结果,还可能是数据本身就不该出这颗按钮。
 */
describe('host="store":只贡献次要动作(Q44-A,v7.6 任务 2 + 任务 3)', () => {
  it("不渲染自己的主按钮 —— 主按钮那一格让给 InstallPanel 的 cardState", () => {
    // rowAction(section="shareable", review=null, shareBlocked=null,
    // remoteChanged=true) → {kind:"update"},mine 宿主下是一颗「更新」的
    // SolidButton。
    const skill = view({ relation: "draft", localModified: false });
    render(<SkillActionsBlock skill={skill} remoteChanged={true} subject="示例技能" host="store" />);
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument();
  });

  it('对照组:同一份数据,host="mine" 时主按钮照常渲染', () => {
    const skill = view({ relation: "draft", localModified: false });
    render(<SkillActionsBlock skill={skill} remoteChanged={true} subject="示例技能" host="mine" />);
    expect(screen.getByRole("button", { name: "更新" })).toBeInTheDocument();
  });

  it("「其余次要动作」(被压过一头、退进 items 的按钮)在 store 宿主下也不摆", () => {
    // buildRowMenuItems 对 shareable 区 + action.kind==="update" 会把「分享」
    // 退进 items——它也是一个"推"的动作,不因为退进了「更多」就豁免。
    const skill = view({ relation: "draft", localModified: false });
    render(<SkillActionsBlock skill={skill} remoteChanged={true} subject="示例技能" host="store" />);
    expect(screen.queryByRole("button", { name: "分享" })).not.toBeInTheDocument();
  });

  it('对照组:同一份数据,host="mine" 时「分享」出现在次要动作里', () => {
    const skill = view({ relation: "draft", localModified: false });
    render(<SkillActionsBlock skill={skill} remoteChanged={true} subject="示例技能" host="mine" />);
    expect(screen.getByRole("button", { name: "分享" })).toBeInTheDocument();
  });

  it("打开文件夹仍然摆出来 —— 它不是「推」的动作", () => {
    render(<SkillActionsBlock skill={view()} remoteChanged={false} subject="示例技能" host="store" />);
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeInTheDocument();
  });

  it("🔴 v7.6 任务 3:「移除」不再是常驻可见按钮,收进「…」(Q44-A 原文「「…」收危险动作」)", async () => {
    const skill = view();
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="store" />);

    expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
    const menuTrigger = screen.getByRole("button", { name: /更多/ });
    expect(menuTrigger).toBeInTheDocument();

    await userEvent.click(menuTrigger);
    const item = screen.getByRole("menuitem", { name: "移除" });
    await userEvent.click(item);

    expect(useMySkills.getState().removeTarget).toBe(skill.dirSlug);
  });

  it('对照组:同一份数据,host="mine" 时「移除」仍是常驻可见按钮(§12 裁定不变)', () => {
    render(<SkillActionsBlock skill={view()} remoteChanged={false} subject="示例技能" host="mine" />);
    expect(screen.getByRole("button", { name: "移除" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /更多/ })).not.toBeInTheDocument();
  });

  it("🔴 在技能库里查看收进「…」,不占行上的位置(2026-09-10 用户真机拍板)", async () => {
    // 它仍然到得了 —— 只是从行上挪进了菜单。改的是位置不是可达性。
    // 起因是硬约束:面板固定宽 480px、页脚可用 440px,而主按钮是「已在电脑上」
    // (5 字 + 绿勾)那一档,五个元素合计约 472px,`flex-wrap` 把「…」挤到第二行
    // ——省了「移除」的位置却赔上整行给一个 24px 的图标(用户原话"白折叠了")。
    render(
      <SkillActionsBlock
        skill={view({ libraryUrl: "http://g.local/x" })}
        remoteChanged={false} subject="示例技能" host="store"
      />,
    );
    // 行上没有
    expect(screen.queryByRole("button", { name: "在技能库里查看" })).toBeNull();
    // 菜单里有 —— 改的是位置,不是可达性
    await userEvent.setup().click(screen.getByRole("button", { name: /更多/ }));
    expect(screen.getByRole("menuitem", { name: "在技能库里查看" })).toBeInTheDocument();
  });

  it("host=\"mine\" 不受影响:在技能库里查看仍在行上(§12「全部摆开」)", () => {
    render(
      <SkillActionsBlock
        skill={view({ libraryUrl: "http://g.local/x" })}
        remoteChanged={false} subject="示例技能" host="mine"
      />,
    );
    expect(screen.getByRole("button", { name: "在技能库里查看" })).toBeInTheDocument();
  });

  it("分享结果(成功)不渲染 —— 触发它的按钮这个宿主下根本不存在", () => {
    const skill = view();
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="store" />);
    act(() =>
      useMySkills.setState({
        shareDone: { dirSlug: skill.dirSlug, mode: "pushed", flow: "changes" as const },
      }),
    );
    expect(screen.queryByText(/改动已分享到公司技能库/)).not.toBeInTheDocument();
  });

  it('对照组:同一份数据,host="mine" 时分享结果照常渲染', () => {
    const skill = view();
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="mine" />);
    act(() =>
      useMySkills.setState({
        shareDone: { dirSlug: skill.dirSlug, mode: "pushed", flow: "changes" as const },
      }),
    );
    expect(screen.getByText(/改动已分享到公司技能库/)).toBeInTheDocument();
  });

  it("分享被标准校验拦下的原因不渲染(store 宿主下没有「分享」按钮,原因说明也没有意义)", () => {
    const skill = view({ relation: "draft", localModified: false, shareBlocked: "nameMissing" });
    render(<SkillActionsBlock skill={skill} remoteChanged={false} subject="示例技能" host="store" />);
    expect(screen.queryByText(/请在 SKILL\.md 里补上 name/)).not.toBeInTheDocument();
  });
});
