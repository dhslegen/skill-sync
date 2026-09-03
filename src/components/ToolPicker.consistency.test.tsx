import { render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InstallPanel } from "@/components/InstallPanel";
import { ToolChecks } from "@/components/ToolChecks";
import { LIST_ROW_EXTRA } from "@/components/ToolPicker";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "skill_set_agents") {
      return {
        outcome: "done",
        homeBody: "/b",
        canonical: { Ok: { kind: "unchanged" } },
        results: [],
        unlinked: [],
        unlinkFailed: [],
      };
    }
    return null;
  });
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
  useStoreIndex.setState({ activeRegistry: "company", activeRepo: "skills/skills" });
});

/**
 * v7 任务 5 的 DoD:「我的技能」的 `ToolChecks` 与获取面板私有的 `AgentChooser`
 * 现在都是 `ToolPicker` 的薄壳,两处渲染出来的 checkbox 与 label 必须是
 * **同一副 DOM 骨架**(同一批 className),不是各自维护一套标记再凑巧长得像。
 *
 * 🔴 R17 裁定(修复轮 1,**v7.1 任务 4 已部分作废**:设计画布把四个语境画成了
 * 同一副紧凑竖排清单,`ToolChecks` 因此也改成 `layout="list"`,两处的 label
 * 重新逐字相同;下面这段保留是因为"容器不同不代表没统一"这条判断仍然成立,
 * 只是眼下四处恰好都用同一档容器):**容器排布刻意不要求一致**——`ToolChecks` 用
 * `layout="inline"`(chip 流),`AgentChooser` 用 `layout="list"`(竖排清单,
 * 带分隔线/hover/路径靠右对齐)。「三处统一」统一的是同一个组件与同一套
 * checkbox/label token,不是同一种排布方向;安装面板天然要展示"工具名 + 落点
 * 路径"这份竖排清单,硬拉平成 chip 流会把长 mono 路径和工具名混排,是真实的
 * 可读性回归。所以这里**只断言 checkbox 与 label 的 className**,不再断言
 * 外层容器——容器不同不代表没统一。
 *
 * 🔴 **v7 任务 7 修复了 list 档的点击命中区**(padding/border/hover 原先挂在
 * label 外面包的一层 `<div>` 上,那圈区域点了不生效)之后,`label` 的
 * className 在两档之间不再逐字相同——list 档现在自带 `LIST_ROW_EXTRA` 那一批
 * class,`<div>` 包装层整个删除。所以 label 的断言改成"list 档 = inline 档 +
 * `LIST_ROW_EXTRA`"的精确串比较;checkbox 不受这次改动影响,仍然严格相等。
 * 这条测试守的意图没变(两处不许各自悄悄漂回一套手搓标记),只是把"完全相同"
 * 换成了"共享同一份基础 + 一份已知的、有文档的差异"。
 *
 * 🔴 **M8(复审):这条测试挡不住的东西**——它只比较"两处消费者算出来的
 * className 是否互相一致",不检查 `LIST_ROW_EXTRA` 这个常量本身的**内容**
 * 对不对。如果有人把 `LIST_ROW_EXTRA` 改成一个错误但自洽的字符串(比如手滑删掉
 * `border-t`),`ToolChecks`/`AgentChooser` 两处仍然会算出相同的 className,
 * 这条测试照样绿——它守的是"两处不漂",不是"这批 token 本身是对的"。
 * `ToolPicker.test.tsx` 补了一条正面断言直接锁定 `LIST_ROW_EXTRA` 的字面量
 * 内容,两条测试合起来才是完整的护栏:那条管"内容对不对",这条管"两处
 * 用不用的是同一份"。
 *
 * 🔴 修复轮 1 之前这条测试是**全量空转**:两次 `render` 都往 `document.body`
 * 追加内容(RTL 的 `cleanup` 只在 `afterEach`),用全局 `screen.getAllByRole
 * ("checkbox")[0]` 取到的其实是文档序上第一次 render(`ToolChecks`)自己的
 * checkbox——三条断言全部退化成"自己等于自己",哪怕 `AgentChooser` 整个不渲染
 * checkbox 也照样绿。改成 `within(container)` 把两次 render 的查询各自限定在
 * 自己的容器里,并显式断言两个 box **不是同一个 DOM 节点**,防止再次退化。
 */
describe("ToolChecks 与 AgentChooser 共用同一副 checkbox/label 骨架", () => {
  it("checkbox 与 label 的 className 逐字相同,且确实取自两个不同的 render", () => {
    useMySkills.setState({ installedAgents: new Set(["claude-code"]), setAgentsBusy: null });
    const { container: mineContainer } = render(
      <ToolChecks
        dirSlug="weekly-report"
        tools={[{ agent: "claude-code", state: "linked" }]}
        agentNames={new Map([["claude-code", "Claude Code"]])}
      />,
    );
    const mineBox = within(mineContainer).getByRole("checkbox");
    const mineLabel = mineBox.closest("label")!;

    useInstall.setState({
      phase: "choosing",
      dirSlug: "weekly-report",
      agents: [
        {
          name: "claude-code",
          displayName: "Claude Code",
          installed: true,
          disabled: false,
          isUniversal: false,
          needsLink: true,
          globalSkillsDir: "/h/.claude/skills",
        },
      ],
      selected: new Set(["claude-code"]),
      registryId: "company",
      repo: null,
    });
    const { container: installContainer } = render(<InstallPanel dirSlug="weekly-report" />);
    const installBox = within(installContainer).getByRole("checkbox");
    const installLabel = installBox.closest("label")!;

    // 防呆:两个查询必须真的取自两个不同的 render,否则上面的等式检查毫无意义
    // ——这正是修复轮 1 之前被静默退化成的样子。
    expect(installBox).not.toBe(mineBox);
    expect(installBox.className).toBe(mineBox.className);
    // v7.1 任务 4:`ToolChecks` 也改用 `list` 之后,两处的 label 又回到逐字相同
    // ——但等式本身证明不了"用的是 list 那一档"(两处一起漂回 inline 也能让它
    // 成立),所以再正面断言两边都带着 `LIST_ROW_EXTRA`。
    expect(installLabel.className).toBe(mineLabel.className);
    expect(mineLabel.className).toContain(LIST_ROW_EXTRA);
  });
});
