import { useRef } from "react";

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
 * 只是一次性排序,不是"重排引擎"——调用方(`ToolPicker` 自己)只在拿到第一份
 * 非空 items 那一刻调它一次并把结果的 agent 顺序钉住,之后不管 `items` 的
 * `state` 怎么变都不再重算,见 `ToolPicker` 内部注释。
 *
 * 用两次 `filter` 拼接而不是 `sort`:组内保序是**语言保证**的(`Array.prototype
 * .filter` 保留原有相对顺序),不依赖某个排序算法"恰好"是稳定的。
 */
export function orderForPicker(items: ToolPickerItem[]): ToolPickerItem[] {
  return [...items.filter((item) => isChecked(item.state)), ...items.filter((item) => !isChecked(item.state))];
}

/**
 * 三处工具多选统一成这一个组件:「我的技能」勾组、获取面板的 agent 选择。
 *
 * # 排序:拿到第一份非空数据时排一次,操作期间绝不重排
 *
 * 已勾的排在前面,方便一眼看清"现在生效的是哪些";但排序只算**一次**,用
 * `useRef` 惰性钉住(不是 `useState` 的惰性初始值)。
 *
 * 🔴 **`useState(() => ...)` 的惰性初始值会在组件以 `items=[]` 挂载时把结果
 * 永久钉成空数组**——`AgentChooser` 在 agent 探测结果回来之前恰好就是这个
 * 场景(`useInstall` 的 `agents` 初值是 `[]`,`beginFromPlaza`/`begin` 都先进
 * `phase:"choosing"` 再异步取数据),这个组件实例不会因为 `items` 从空变
 * 非空而重新挂载,`useState` 的初始值只求值那一次,之后排序就永久失效了。
 * `useRef` 允许"钉住"这件事延后到**第一次拿到非空 items**才发生:
 * ```ts
 * const pinned = useRef<string[] | null>(null);
 * if (pinned.current === null && items.length > 0) {
 *   pinned.current = orderForPicker(items).map((item) => item.agent);
 * }
 * ```
 * 之后无论 `items` 里的 `state` 怎么变(用户点了某一项、外部刷新了数据),
 * 渲染顺序都按钉住的那份 `agent` 顺序走。不这样做的话,点一下勾会让那一项从
 * "已勾"移到"未勾"分组、整个视觉顺序跟着跳——用户的手指底下那一项直接消失了。
 *
 * # `body` 档恒勾且不可取消
 *
 * 本体就住在这个位置,取消它等于删本体(`ToolState` 的既有约定,见 `lib/ipc.ts`)。
 *
 * # `layout`:两种容器,同一副 checkbox/label 骨架
 *
 * 「三处统一」统一的是**同一个组件、同一种 checkbox 结构、同一批 token**
 * (checkbox 尺寸/描边色、label 字号/颜色),**不是同一种排布方向**——行内
 * 勾组(「我的技能」)天然是一组紧凑的 chip,获取面板天然是一份"工具名 + 落点
 * 路径"的竖排清单,把后者也拉平成 chip 流会把长 mono 路径和工具名混排在一起,
 * 制造真实的可读性回归(R17 裁定)。`inline`(默认)是 `flex flex-wrap` 的
 * chip 流,`<label>` 直接是容器的子元素;`list` 每项单独一行、`<label>` 外面
 * 多包一层带分隔线与 hover 的 `<div>`,路径靠右对齐。checkbox 与 `<label>`
 * 自身的 className **两种布局逐字相同**,只有外层容器与路径那一段的对齐方式
 * 随 `layout` 变化——这才是"一副骨架"的实质,
 * `ToolPicker.consistency.test.tsx` 断言的正是这一点,不是整棵 DOM 逐字相同。
 *
 * # `list` 档的点击命中区(v7 任务 7 修复)
 *
 * 🔴 修复前 `list` 档在 `<label>` 外面包了一层带 `border-t`/`px-3 py-2`/
 * `hover:bg-surface-2` 的 `<div>`——`<label>` 关联 checkbox 的可点区域只是
 * **它自己的盒子**,不含外层 `<div>` 的 padding,于是那圈视觉上明明在这一行里的
 * 8–12px 边缘点不动。现在把这批 class 直接挪到 `<label>` 自己身上
 * (`LIST_ROW_EXTRA`),外层 `<div>` 整个删掉——`<label>` 现在就是这一行唯一的
 * 元素,点它的边框、padding、内容,哪里都能触发。**只在 `list` 档追加**,
 * `inline` 档(chip 流)不需要这圈点击区扩展,`labelClassName` 因此按 `layout`
 * 分叉——一致性测试相应改成"list 档 = inline 档 + `LIST_ROW_EXTRA`"的精确串
 * 断言,不再要求两档完全相同(那从来不是这段代码想守住的东西,checkbox 与
 * label 的基础结构仍然逐字共用,只是 list 档多了一圈自己的点击区)。
 */
export const LIST_ROW_EXTRA = "border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-2";

export function ToolPicker({
  items,
  onToggle,
  disabled = false,
  layout = "inline",
}: {
  items: ToolPickerItem[];
  onToggle: (agent: string, next: boolean) => void;
  disabled?: boolean;
  layout?: "inline" | "list";
}) {
  const pinned = useRef<string[] | null>(null);
  if (pinned.current === null && items.length > 0) {
    pinned.current = orderForPicker(items).map((item) => item.agent);
  }
  const order = pinned.current ?? [];

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

  const containerClassName =
    layout === "list" ? "" : "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1";

  return (
    <div className={containerClassName}>
      {ordered.map((item) => {
        const isBody = item.state === "body";
        const checked = isChecked(item.state);
        const itemDisabled = isBody || disabled;
        const labelClassName = [
          "flex items-center gap-1.5 text-[11.5px]",
          isBody || disabled ? "text-text-3" : "text-text-2",
          layout === "list" ? LIST_ROW_EXTRA : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <label
            key={item.agent}
            title={isBody ? t("mine.toolBodyHint") : undefined}
            className={labelClassName}
          >
            <input
              type="checkbox"
              // 供测试断言"点了哪一个、顺序有没有变"用的钩子,不是产品需要。
              name={item.agent}
              checked={checked}
              // 本体所在的那个勾永远点不动:取消它等于删本体
              disabled={itemDisabled}
              onChange={() => onToggle(item.agent, !checked)}
              className="size-3 accent-[var(--accent)]"
            />
            <span>{item.label}</span>
            {item.path && (
              <span
                className={
                  layout === "list"
                    ? "ml-auto min-w-0 truncate font-mono text-[11px] text-text-3"
                    : "truncate font-mono text-[11px] text-text-3"
                }
              >
                {item.path}
              </span>
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
