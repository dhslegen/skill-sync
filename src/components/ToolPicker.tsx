import { useState } from "react";

import { t } from "@/i18n";
import type { ToolState } from "@/lib/ipc";

/**
 * 「各个工具里」通用勾选项——今天有两处独立实现在描述同一件事(`ToolChecks` 的
 * 「我的技能」行内勾组、`InstallPanel` 私有的 `AgentChooser`),排序不同、
 * 形态也不同。这个组件是两处共用的唯一真相,`ToolChecks`/`AgentChooser`
 * 都改成薄壳调它。
 *
 * `path` 留空("")时不渲染路径那一段——「我的技能」页目前没有把落点路径穿到这一层,
 * 留空是诚实的"没有这个信息",不是伪造一个空字符串路径。
 */
export interface ToolPickerItem {
  agent: string;
  label: string;
  path: string;
  state: ToolState;
}

function isChecked(state: ToolState): boolean {
  return state !== "off" && state !== "missing";
}

/**
 * 已勾的排在前面,其余保持原有相对顺序(注册表顺序)。
 *
 * 只是一次性排序,不是"重排引擎"——调用方(`ToolPicker` 自己)只在挂载那一刻调它
 * 一次并把结果的 agent 顺序钉住,之后不管 `items` 的 `state` 怎么变都不再重算,
 * 见 `ToolPicker` 内部注释。
 */
export function orderForPicker(items: ToolPickerItem[]): ToolPickerItem[] {
  return [...items.filter((item) => isChecked(item.state)), ...items.filter((item) => !isChecked(item.state))];
}

/**
 * 三处工具多选统一成这一个组件:「我的技能」勾组、获取面板的 agent 选择。
 *
 * # 排序:打开时排一次,操作期间绝不重排
 *
 * 已勾的排在前面,方便一眼看清"现在生效的是哪些";但排序只在**这个组件实例
 * 挂载那一刻**算一次(`useState` 的惰性初始值只跑一次),此后无论 `items` 里的
 * `state` 怎么变(用户点了某一项、外部刷新了数据),渲染顺序都按挂载时钉住的那份
 * `agent` 顺序走。不这样做的话,点一下勾会让那一项从"已勾"移到"未勾"分组、
 * 整个视觉顺序跟着跳——用户的手指底下那一项直接消失了。
 *
 * # `body` 档恒勾且不可取消
 *
 * 本体就住在这个位置,取消它等于删本体(`ToolState` 的既有约定,见 `lib/ipc.ts`)。
 */
export function ToolPicker({
  items,
  onToggle,
  disabled = false,
}: {
  items: ToolPickerItem[];
  onToggle: (agent: string, next: boolean) => void;
  disabled?: boolean;
}) {
  // 惰性初始值只在挂载时求值一次——这就是"打开时排序一次,操作期间不重排"的
  // 全部实现:不是不排序,是排完就钉住,不随后续渲染重算。
  const [order] = useState(() => orderForPicker(items).map((item) => item.agent));

  if (items.length === 0) return null;

  const byAgent = new Map(items.map((item) => [item.agent, item] as const));
  // 钉住的顺序里没有的(理论上不该发生,给个兜底)排在末尾,不丢掉。
  const known = new Set(order);
  const ordered = [
    ...order.flatMap((agent) => {
      const item = byAgent.get(agent);
      return item ? [item] : [];
    }),
    ...items.filter((item) => !known.has(item.agent)),
  ];

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      {ordered.map((item) => {
        const isBody = item.state === "body";
        const checked = isChecked(item.state);
        const itemDisabled = isBody || disabled;
        return (
          <label
            key={item.agent}
            title={isBody ? t("mine.toolBodyHint") : undefined}
            className={[
              "flex items-center gap-1.5 text-[11.5px]",
              isBody || disabled ? "text-text-3" : "text-text-2",
            ].join(" ")}
          >
            <input
              type="checkbox"
              name={item.agent}
              checked={checked}
              // 本体所在的那个勾永远点不动:取消它等于删本体
              disabled={itemDisabled}
              onChange={() => onToggle(item.agent, !checked)}
              className="size-3 accent-[var(--accent)]"
            />
            <span>{item.label}</span>
            {item.path && (
              <span className="truncate font-mono text-[11px] text-text-3">{item.path}</span>
            )}
            {isBody && <span className="text-text-3">{t("mine.toolBodyHint")}</span>}
            {/* 降级复制的形态如实说出来:那个位置上是一份实体副本,不是同一份文件
                ——改了本体它不会跟着变,用户有权知道 */}
            {item.state === "copy" && <span className="text-text-3">{t("mine.toolCopy")}</span>}
          </label>
        );
      })}
    </div>
  );
}
