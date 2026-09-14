import { useRef } from "react";

import { t } from "@/i18n";
import type { ToolState } from "@/lib/ipc";

/**
 * 「各个工具里」通用勾选项——最初有两处独立实现在描述同一件事(`ToolChecks` 的
 * 「我的技能」行内勾组、`InstallPanel` 私有的 `AgentChooser`),排序不同、
 * 形态也不同。这个组件是共用的唯一真相,`ToolChecks`/`AgentChooser` 都是薄壳
 * 调它。⚠️ **调用方现在是四处,不是两处**(终审 M-5 订正,见下方
 * `ToolPicker` 函数文档的完整清单):`ProjectSections.tsx` 的项目行"事后改选"
 * (v7 任务 8)与 `InstallPanel.tsx` 的项目确认条(终审 §15)后来居上,各自
 * 新增一处调用。
 *
 * `path` 留空("")时不渲染路径那一段——「我的技能」页与项目确认条目前都没有把
 * 落点路径穿到这一层,留空是诚实的"没有这个信息",不是伪造一个空字符串路径。
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
 * 四处工具多选统一成这一个组件(终审 M-5 订正计数):「我的技能」勾组
 * (`ToolChecks`)、获取面板的 agent 选择(`AgentChooser`)、项目行事后改选
 * (`ProjectSections.tsx`,v7 任务 8)、项目确认条上可选工具
 * (`InstallPanel.tsx` 的 `ConfirmBar`,终审 §15)。
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
 * # 钉住的是"这一批 agent 集合"的顺序(0.6.x 清 K5 之后)
 *
 * `pinned` 里连同 agent 集合的指纹(排序后 join)一起记:**集合一变就重钉**
 * ——不看 state、不看数组顺序、不看引用。这解决的是 v7 任务 8 登记的 K5
 * (R18):此前只要第一份非空 items 钉过一次,之后哪怕整批 agent 都换掉了
 * (同一个组件实例被喂了另一个技能的数据)也照旧按老顺序排,而新集合里没有的
 * 名字只是被"兜底"排到末尾、看起来像是排序坏了。
 *
 * 🔴 **它只防"集合变了",防不了"同一集合、换了一个技能"**:两个技能恰好链到
 * 同一批工具时,指纹相同、不会重钉,顺序会从 A 漏到 B。所以下面这条前提
 * **仍然成立**(补于 v7 任务 7 修复轮 1,I2):调用方要在换技能时换掉组件实例。
 * `pinned` 这个 `useRef` 挂在组件**实例**上,只有 React 判定"这是新的一份"(不同的
 * `key`,或元素类型本身变了)才会重新拿到一个干净的 `useRef`。⚠️ **现在四处
 * 调用方各自天然满足这个前提**(终审 M-5 订正:此前这里只记了两处,漏了后来
 * 加的另外两处),集合指纹只是给这条前提兜一半的底,另一半仍是**调用方**的责任:
 * - `ToolChecks`(「我的技能」勾组)：外层详情面板按 `target`/`dirSlug` 整体
 *   换挂载(见 `store/local-detail.ts` 的 `open`),换技能等于换了一整棵子树;
 * - `AgentChooser`(获取面板):`useInstall` 的 `phase` 从 `choosing` 退回
 *   `idle` 再进 `choosing`(比如取消一次安装重选另一个技能)时,`InstallPanel`
 *   按 `phase` 分支渲染,同样会把这棵子树连根卸载重建;
 * - `ProjectSections.tsx` 的项目行事后改选(v7 任务 8):每一行的
 *   `ToolPicker` 挂在 `ProjectSkillRow` 里,`key={skill.key}` 保证换技能/换行
 *   就是换组件实例;
 * - `InstallPanel.tsx` 的 `ConfirmBar`(项目确认条,终审 §15):同一个技能上
 *   点「换个文件夹」时 `ConfirmBar` 实例本身**不会**卸载(只有换技能才会,
 *   见 `InstallPanel` 顶层按 `dirSlug` 收尾的那个 effect),所以这里的
 *   `ToolPicker` 元素显式带了 `key={confirm.projectPath}`,靠这把 key 补上
 *   "换项目 = 换实例"这条前提。
 * 如果将来有调用方在**同一个挂载的组件实例上**换技能(比如给一个列表里的每一
 * 行都用同一个 `ToolPicker` 却不给它按 `dirSlug` 单独的 `key`),集合不同时会
 * 重钉、集合恰好相同时钉住的顺序会从上一个技能"漏"到下一个技能,且没有任何
 * 报错——后一半不是这个组件能防的,新增调用方时要自己保证"换技能 = 换实例"。
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
 *
 * # v7.1 任务 4:`list` 档压成画布上那副紧凑形态
 *
 * 🔴 `LIST_ROW_EXTRA` 原先是 `border-t border-border px-3 py-2 first:border-t-0
 * hover:bg-surface-2`——那是 v7 给获取面板配的一套"清单卡片"观感。v7.1 的设计
 * 画布(`ToolPicker.dc.html`,四个语境画在同一张板上)把四处统一成了同一副
 * **无分隔线、无 hover 底、`padding:6px 0`** 的紧凑清单:这一组勾是"位置信息"
 * 的一部分,不是一张卡片。所以这里改成 `py-1.5`,四个调用方一起变
 * ——"统一"这件事只有在同一个常量上才成立,给详情面板单开一档密度就等于又分叉。
 * 点击命中区仍然由 `<label>` 自己承担(block 级 flex,占满整行宽),v7 任务 7
 * 修的那个"边缘点不动"不会因为去掉 `px-3` 回来:横向留白本来就不属于这一行。
 *
 * ⚠️ **上面这句"四个调用方一起变"是 v7.1 任务 4 那一刻的实况,不是现在的**:
 * v7.6 任务 3(B3)把 `InstallPanel.tsx` 的 `ConfirmBar`(项目确认条)从
 * `list` 换成了 `inline`——它的 `item.path` 恒为 `""`(0.6.x K3 起项目内相对
 * 路径已经可穿、`ProjectSections.tsx` 那一处已填,确认条仍留空是刻意的,见
 * `InstallPanel.tsx` 的 `ConfirmBar` 文档),`list`
 * 唯一的优势(带路径)在这个语境下买不到任何东西。现在用 `LIST_ROW_EXTRA`
 * 的是 `ToolChecks`(「我的技能」)、`AgentChooser`(获取面板,`item.path` 是
 * 真实的 `agent.globalSkillsDir`,R17 的理由在那里仍然成立)、
 * `ProjectSections.tsx`(项目行事后改选)**三处**,`ConfirmBar` 退出。
 */
export const LIST_ROW_EXTRA = "py-1.5";

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
  // 钉住的是"这一批 agent 集合"的顺序:集合(不看 state、不看顺序)一变就重钉。
  // 集合没变时,不管 state 怎么翻、items 数组怎么换引用,都沿用钉住的那份。
  const setKey = items
    .map((item) => item.agent)
    .sort()
    .join("\u0000");
  const pinned = useRef<{ setKey: string; order: string[] } | null>(null);
  if (items.length > 0 && (pinned.current === null || pinned.current.setKey !== setKey)) {
    pinned.current = { setKey, order: orderForPicker(items).map((item) => item.agent) };
  }
  const order = pinned.current?.order ?? [];

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
          // 字号/间距照画布(12px / gap 8px),两档共用。
          "flex items-center gap-2 text-[12px]",
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
              // 形态全在 `.tool-check` 里(`styles/global.css`):未勾空心描边、
              // 已勾实心强调色 + 白勾,本体那一档走中性灰。理由见那段 CSS 的注释。
              className="tool-check"
            />
            {/* 工具名照画布用正文色(未勾也一样——"没启用"是勾自己说的事,
                不该顺带把名字也压暗成读不清);本体/禁用那一档整行退成灰。 */}
            <span className={itemDisabled ? undefined : "text-text"}>{item.label}</span>
            {/* 🔴 两句状态标记排在**路径之前**:路径带 `ml-auto` 靠右,摆在它后面的
                东西会被挤到最右边、与路径连成一串读不出主次(画布 `ToolPicker.dc.html`
                的次序是 工具名 → 状态标记 → 路径靠右)。 */}
            {isBody && <span className="text-[11px] text-text-3">{t("mine.toolBodyHint")}</span>}
            {/* 降级复制的形态如实说出来:那个位置上是一份实体副本,不是同一份文件
                ——改了本体它不会跟着变,用户有权知道 */}
            {item.state === "copy" && (
              <span className="text-[11px] text-text-3">{t("mine.toolCopy")}</span>
            )}
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
          </label>
        );
      })}
    </div>
  );
}
