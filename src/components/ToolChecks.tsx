import { ToolPicker, type ToolPickerItem } from "@/components/ToolPicker";
import type { ToolView } from "@/lib/ipc";
import { useMySkills, visibleTools } from "@/store/my-skills";

/**
 * 「各个工具里」——一个技能一组 checkbox,每个工具一个勾。
 *
 * 薄壳:视觉与勾选行为全部委托给 {@link ToolPicker}(v7 任务 5 统一)。
 * 这一层只管两件"我的技能"页特有的事:按 `agents_detected` 收窄显示
 * (R21,见 {@link visibleTools})、以及把提交名单从**全量** `tools` 派生。
 *
 * # 它取代了「修复关联」这个按钮
 *
 * 旧模型里,一处链接断了/被改指/被顶掉,界面会摆一个「修复关联」。那个按钮缺的
 * 不是实现,是**概念错了**:用户从来不想"修复"什么,他想要的就是"这个技能在
 * Claude Code 里能用"——那正是这个勾本身。所以断链的自愈也走同一条路:
 * 那个勾会显示成"没启用"(core 给的 `missing`),再点一次就重新收敛那个位置。
 *
 * # 两条不变量
 *
 * 1. **发出去的是完整期望名单,不是增量**:`skill_set_agents` 的契约就是
 *    "这个技能应该在哪些工具里可用",core 会把不在名单里的位置停用掉。
 *    所以点一个勾要带上**当前所有已启用的**再加/减这一个。
 * 2. 🔴 **从 `tools`(全量)派生,不是从 `shown`(收窄后)**:R21 的收窄只该管
 *    **显示**,渗进**提交**就是数据损失(见 {@link visibleTools} 的文档)。
 */
export function ToolChecks({
  dirSlug,
  tools,
  agentNames,
  disabled = false,
}: {
  dirSlug: string;
  tools: ToolView[];
  agentNames: Map<string, string>;
  disabled?: boolean;
}) {
  const installedAgents = useMySkills((s) => s.installedAgents);
  const setAgents = useMySkills((s) => s.setAgents);
  // agent 内部名 → 该工具的全局技能目录。`agents_detected` 早就把它带回来了
  // (`store/my-skills.ts` 的 `toolDirs`),v7.1 任务 4 之前只是没人把它穿到
  // 这一层——**零新 IPC**。
  const toolDirs = useMySkills((s) => s.toolDirs);
  const shown = visibleTools(tools, installedAgents);

  if (shown.length === 0) return null;

  const enabled = (tool: ToolView) => tool.state !== "off" && tool.state !== "missing";

  const items: ToolPickerItem[] = shown.map((tool) => ({
    agent: tool.agent,
    label: agentNames.get(tool.agent) ?? tool.agent,
    // 探测不到那个工具的目录时留空,由 ToolPicker 诚实地不渲染那一段
    // ——不伪造一个空字符串路径。
    path: toolDirs.get(tool.agent) ?? "",
    state: tool.state,
  }));

  const handleToggle = (agent: string) => {
    // 带上当前所有已启用的(含恒亮的 body),再翻转这一个。
    const next = new Set(tools.filter(enabled).map((x) => x.agent));
    if (next.has(agent)) next.delete(agent);
    else next.add(agent);
    void setAgents(dirSlug, [...next]);
  };

  // `list`(v7.1 任务 4):竖排一行一个工具、右侧等宽字体显示它的技能目录
  // ——照设计画布 `DetailWhere.dc.html`。原先是 chip 流(横排、没有路径),
  // 用户在真机走查时看到的就是一串没有落点的工具名。
  return <ToolPicker items={items} onToggle={handleToggle} disabled={disabled} layout="list" />;
}
