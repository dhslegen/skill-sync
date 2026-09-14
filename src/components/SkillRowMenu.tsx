import { MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/Icon";
import { useFloatingMenu , FLOATING_MENU_Z } from "@/hooks/useFloatingMenu";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

/**
 * 「更多」下拉菜单——「我的技能」每一行「至多一颗主按钮,其余在「…」里」这条
 * 设计约束的落点(v7 任务 7)。
 *
 * # 为什么要有这个组件
 *
 * 一行同时能做的事其实不止一件:「打开文件夹」「移除」这两个几乎每行都在,
 * 外加判定表里被压过一头、暂时不是主按钮但仍然可点的动作(比如
 * `shareable` 区某一版分享合格但外源又有新版时,「分享」退进这里;
 * `shareBlocked` 压过 `update` 时,「更新」退进这里——见
 * `src/lib/ownership.ts` 的 `RowAction` 判定表文档)。这些动作**没有消失**,
 * 只是不该在同一行里跟主按钮抢注意力,`InstallScopeMenu.tsx` 已经是这个项目
 * 里同款"主按钮 + 下拉里的次要动作"的先例,这里复用同一套无障碍骨架
 * (`aria-haspopup`/`aria-expanded`/`role="menu"`/`role="menuitem"`、
 * Esc 关闭、点外面关闭、关闭后焦点回到触发按钮)。
 *
 * # 🔴 触发按钮永远走 `aria-label`,不靠可见文字
 *
 * 它是一个纯图标按钮(`MoreHorizontal`),可访问名只能来自 `aria-label`,
 * 值是「{subject} 的更多操作」——每颗都点名自己属于哪一行,不再是满页同名的
 * 「更多」(0.6.x 清的 K4)。这不是随手一致——「我的技能」整页有一条测试断言"每行只有一颗**不带
 * `aria-label` 属性**的按钮"(主按钮那颗,靠自己的可见文字当可访问名),
 * 图标按钮反过来必须带 `aria-label` 才能被这条测试正确地排除在外。
 *
 * # 没有条目时不渲染
 *
 * 不摆一个打开了空空如也的菜单——那不比不摆更有用(项目里"不摆比摆一个
 * 没有意义的东西好"这条既定取舍的又一处应用)。
 *
 * # 🔴 v7.7:菜单 portal 到 `document.body`,不再是触发器容器下的 `absolute`
 *
 * 起因是用户真机报告:「我的技能」列表倒数第二行点「…」,菜单被
 * `MySkillsPage.tsx::RowCard` 的 `overflow-hidden` 裁掉一半——那个
 * `overflow-hidden` 的本职是裁圆角,`SkillRowMenu` 当年设计成 `absolute`
 * 就注定会被任何"裁圆角/裁溢出"的祖先容器连带裁掉。全面排查还发现项目行的
 * 底部行更糟:菜单画到视口外,而且 `absolute` 随文档流一起滚,用户永远追不到。
 *
 * 定位逻辑(往哪边开、开到哪个坐标)抽进了 `useFloatingMenu`(`src/hooks/`)
 * ——`InstallScopeMenu` 共用同一份实现,不许各写一份(同一条规则查两遍的
 * 空间版,查一遍的迟早会漂)。这里只负责渲染 portal 内容 + 把
 * `useFloatingMenu` 算出的 `style` 接上去。
 *
 * ⚠️ **这段曾经讲"`wrapRef` 同时包着触发按钮和菜单本身"的长注释已作废**:
 * portal 之后菜单不再是 `wrapRef` 的 DOM 子树,`useFloatingMenu` 内部的
 * 外点判据已经改成 `anchorRef.contains(target) || menuRef.contains(target)`
 * 两边都查——这是本会话第 N 次"前提被推翻的注释",这次直接删掉旧说法,
 * 不留一句会说谎的话在这里。
 */
export interface SkillRowMenuItem {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 原生 `title`(悬浮提示)。目前只有「改用库里的版本」用它说明后果
   *  (本地改动会去哪),不是每一项都需要。 */
  title?: string;
  /** 在这一项**上方**画一条分隔线。只用在「移除」这类破坏性动作前面,
   *  与其余"能做的事"分开,防止手滑。 */
  separatorBefore?: boolean;
}

/**
 * 没有更好信息时的**首选**展开方向。**必填、闭合联合、无默认值**——加这个
 * 参数的起因是 v7.6 任务 3 把「移除」收进这个菜单、又把菜单摆在了详情面板的
 * **最底部**:那里向下展开必然画到视口外,用户点了「…」什么都看不到。
 *
 * 🔴 **刻意不给默认值**:给了 `"down"` 默认,下一个把这个菜单摆在贴底容器里的人
 * 会原样复现同一个缺陷。必填就逼着每个调用方回答一句"我这一处通常离底边有多远"。
 *
 * 🔴 **v7.7 订正:这不再是"菜单会往哪开"的断言,只是没被裁剪信号时的起点**。
 * 上一轮(提交 `447e40a`)把这个参数记成了"第四次『约定 → 类型』"(与
 * `variant`/`LocalProbe`/`capsOf` 并列)——那个归类是错的:前三次编码进类型的
 * 都是**随代码结构静态确定**的事实,这个参数说的却是"这个触发器下面有没有
 * 空间",是**随滚动位置动态变化**的运行时事实,静态类型答不了这个问题。
 * v7.7 起真正的开合方向由 `useFloatingMenu` 在打开那一刻按触发器的真实
 * `getBoundingClientRect()` 现算(见 `src/lib/floating-menu-position.ts`),
 * 这个参数降级成"没被告知更好信息时,两侧都放得下就用哪一侧"。
 */
export type MenuPlacement = "down" | "up";

export function SkillRowMenu({
  items,
  preferredPlacement,
  subject,
}: {
  items: SkillRowMenuItem[];
  /** 见 `MenuPlacement` 的文档——现在只是首选方向,不是最终结果。 */
  preferredPlacement: MenuPlacement;
  /**
   * 这个菜单是"谁的":技能展示名 / 项目文件夹名,进可访问名「{name} 的更多操作」。
   * **必填且必须是展示名**——一页里有十几颗「更多」,全叫「更多」时屏幕阅读器
   * 用户分不出哪颗是哪行的(v7 任务 8 登记的 K4);而 `dirSlug` 这类内部标识
   * 同样会被读出来,本项目「内部标识不能露给用户」那条覆盖可访问名。
   */
  subject: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus(); // 焦点回到触发处,键盘用户不会掉到页面开头
  };

  const { menuRef, style } = useFloatingMenu({
    open,
    onClose: close,
    anchorRef: wrapRef,
    preferred: preferredPlacement,
  });

  if (items.length === 0) return null;

  return (
    <div ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("mine.rowMenu", { name: subject })}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            close();
          }
        }}
        // 🔴 v7.1 任务 5:照画布 `Main.dc.html` —— 「更多」是**无边框 ghost**
        // (`border:1px solid transparent; background:transparent; color:#9a968e`)。
        // 描边会让它与旁边那颗主按钮抢分量:一行里只该有一个"看起来最该点"的东西。
        // 悬浮时才提色,可点性靠 hover 与 24px 命中区表达,不靠常驻边框。
        className="flex h-6 w-6 flex-none items-center justify-center rounded-ctl border border-transparent text-text-3 hover:bg-surface-2 hover:text-text"
      >
        <Icon icon={MoreHorizontal} size={13} />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={style}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            // 🔴 `z-90`,不是改造前的 `z-20`——这是 harness 真机截图(不是 jsdom)
            // 才抓出来的:portal 到 `document.body` 之后,这个 div 与
            // `DetailPanel` 的 `fixed z-51` 面板成了**同级兄弟**,两者的
            // z-index 直接在根层叠上下文里比大小。旧的 `z-20` 只在"菜单是面板的
            // 子孙"时才管用(那时它只需要压过面板内部的正文,z-20 绰绰有余);
            // portal 之后它要压过**整个面板**,而项目里已有的最高层叠是 Wizard
            // 的 `z-80`(全屏接管)。90 留出一档余量,不与既有的
            // 50/51/60/70/80 台阶相撞。
            className={cn(FLOATING_MENU_Z, "min-w-[160px] rounded-card border border-border bg-surface-1 py-1 shadow-[var(--shadow-panel)]")}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className={
                  "block w-full px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2 disabled:pointer-events-none disabled:text-text-3" +
                  (item.separatorBefore ? " mt-1 border-t border-border pt-1.5" : "")
                }
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
