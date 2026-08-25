import { t } from "@/i18n";
import type { ToolView } from "@/lib/ipc";
import { useMySkills, visibleTools } from "@/store/my-skills";

/**
 * 「各个工具里」——一个技能一组 checkbox,每个工具一个勾。
 *
 * # 它取代了「修复关联」这个按钮
 *
 * 旧模型里,一处链接断了/被改指/被顶掉,界面会摆一个「修复关联」。那个按钮缺的
 * 不是实现,是**概念错了**:用户从来不想"修复"什么,他想要的就是"这个技能在
 * Claude Code 里能用"——那正是这个勾本身。所以断链的自愈也走同一条路:
 * 那个勾会显示成"没启用"(core 给的 `missing`),再点一次就重新收敛那个位置。
 *
 * # 三条不变量
 *
 * 1. 🔴 **`body` 档的勾恒亮且不可取消**——本体就住在那个工具的目录里,
 *    取消它等于删用户的文件。这是「本体永不搬动」在界面上的直接体现:
 *    那个勾旁边写着「本体在这里」,告诉用户这个技能到底在哪。
 * 2. **发出去的是完整期望名单,不是增量**:`skill_set_agents` 的契约就是
 *    "这个技能应该在哪些工具里可用",core 会把不在名单里的位置停用掉。
 *    所以点一个勾要带上**当前所有已启用的**再加/减这一个。
 * 3. **`body` 档必须留在提交的名单里**:它不可取消,漏掉它就等于请求
 *    "把本体所在的那个位置停用掉"。
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
  const shown = visibleTools(tools, installedAgents);

  if (shown.length === 0) return null;

  const enabled = (tool: ToolView) => tool.state !== "off" && tool.state !== "missing";

  const toggle = (tool: ToolView) => {
    // 不变量 2、3 与 4:带上当前所有已启用的(含恒亮的 body),再翻转这一个。
    //
    // 🔴 **从 `tools`(全量)派生,不是从 `shown`(收窄后)**:R21 的收窄只该管
    // **显示**,渗进**提交**就是数据损失。某个工具已启用(有活链接或副本)却没被
    // `agents_detected` 认出来时(用户后来卸了它、或探测只认出一部分),它不在
    // `shown` 里 —— 用户点任何**别的**勾,完整期望名单里就漏了它,而按契约
    // 「不在名单里的位置会被停用」,core 会去解掉一个用户从没碰过的位置。
    const next = new Set(tools.filter(enabled).map((x) => x.agent));
    if (next.has(tool.agent)) next.delete(tool.agent);
    else next.add(tool.agent);
    void setAgents(dirSlug, [...next]);
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      {shown.map((tool) => {
        const isBody = tool.state === "body";
        const label = agentNames.get(tool.agent) ?? tool.agent;
        return (
          <label
            key={tool.agent}
            title={isBody ? t("mine.toolBodyHint") : undefined}
            className={[
              "flex items-center gap-1.5 text-[11.5px]",
              isBody || disabled ? "text-text-3" : "text-text-2",
            ].join(" ")}
          >
            <input
              type="checkbox"
              checked={enabled(tool)}
              // 本体所在的那个勾永远点不动:取消它等于删本体
              disabled={isBody || disabled}
              onChange={() => toggle(tool)}
              className="size-3 accent-[var(--accent)]"
            />
            <span>{label}</span>
            {isBody && <span className="text-text-3">{t("mine.toolBodyHint")}</span>}
            {/* 降级复制的形态如实说出来:那个位置上是一份实体副本,不是同一份文件
                ——改了本体它不会跟着变,用户有权知道 */}
            {tool.state === "copy" && <span className="text-text-3">{t("mine.toolCopy")}</span>}
          </label>
        );
      })}
    </div>
  );
}
