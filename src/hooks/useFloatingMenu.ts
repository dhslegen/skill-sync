// 两个下拉菜单(`SkillRowMenu`/`InstallScopeMenu`)共用的浮层实现(v7.7)。
//
// 起因见 `src/lib/floating-menu-position.ts` 文件头:两个菜单原先都是
// `position: absolute` 挂在触发器的 `relative` 容器下,会被祖先的
// `overflow-hidden` 裁掉(「我的技能」列表卡片),或者画到视口外且不跟着
// 滚动(项目行的底部行)。改法是 portal 到 `document.body` + `fixed` 定位,
// 按触发器的真实 rect 现算方向。
//
// 🔴 **这个 hook 是"定位逻辑抽成一处共享实现"这条要求的落点**——两个菜单
// 都调它,不许各写一份(同一条规则查两遍的空间版:如果各写一份,今天两边
// 判据一致,明天有人改其中一份就会漂)。除了定位,它还顺手把 portal 之后
// 才会出现的另外两个坑一起接住:
//
// 1. **外点关闭**:portal 之后菜单的 DOM 不再是触发器容器的子树,只查
//    `anchorRef.contains(target)` 会把"点在菜单项上"误判成"点在外面"
//    ——菜单会在 `mousedown` 那一刻先关掉,随后的 `click`(触发 `item.onClick`)
//    因为按钮已经从 DOM 上摘掉而打不到。判据必须两边都查:
//    `anchorRef.contains(target) || menuRef.contains(target)`。
// 2. **滚动/resize 不追随**:`fixed` 定位取的是打开那一刻的 rect,容器一滚
//    菜单原地悬空。这里选**滚动即关闭**(遇到坑 2 时立刻能感知),不做"跟随
//    滚动重新定位"——跟随是 Popper 级的持续测量工程量,而关闭只需要监听一个
//    事件,性价比完全不同,而且用户的心智模型本就是"点开一个菜单,滚一下页面
//    它应该消失",不是"菜单飘在半空跟着走"。
//
// 关于测量时机:第一次 `open` 变 `true` 时,菜单先以隐藏样式挂进
// `document.body`(此时 `menuRef.current` 才存在,量得到 `offsetHeight`),
// `useLayoutEffect` 在浏览器绘制前完成"挂载 → 量尺寸 → 算坐标 → 应用坐标"
// 这一整套,不会有一帧"菜单先出现在错误位置再跳一下"的闪烁。
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { computeMenuVerticalPosition } from "@/lib/floating-menu-position";

/**
 * 浮层的层叠档位。**两个菜单共用这一个常量,不各写一份字面量**
 * ——同一条规则查两遍的空间版(v7.7 复审抽出来的;实现时两个组件各写了
 * 一份 `z-90` 与一段等价的推理注释)。
 *
 * 项目里现役的层叠台阶(截至 v7.7,散落在各组件的 className 里,**这里是
 * 唯一一份完整清单**,加新层时先读它):
 *
 * | 档 | 谁 |
 * |---|---|
 * | 10 / 20 / 40 | 页面内的局部浮层与遮挡(卡片角标、吸顶头等) |
 * | 50 | 详情面板的遮罩 |
 * | 51 | 详情面板本体(`DetailPanel`,`fixed inset-y-0`) |
 * | 60 / 70 | 各类模态对话框(冲突/移除/版本选择/分享确认…) |
 * | 80 | 向导(`Wizard`,全屏接管) |
 * | **90** | **portal 出去的浮层菜单(本常量)** |
 *
 * 🔴 为什么必须是最高档:portal 之后菜单是 `document.body` 的**直接子元素**,
 * 与 `DetailPanel` 的 `fixed z-51` 成了同级兄弟,z-index 直接在根层叠上下文里
 * 比大小。改造前的 `z-20` 只在"菜单是面板的子孙"时才够用。这个缺陷是
 * **harness 截图**发现的(位置算对了、截图里却看不见),jsdom 一点感觉都没有。
 *
 * ⚠️ 其余那些档位仍散落在各组件里、没有常量化——**这是既有状态,本次没动**,
 * 因为逐个替换要动十几处而每改错一处就是一个 jsdom 测不出的遮挡缺陷。
 * 新增层叠时请回来更新上面这张表。
 */
export const FLOATING_MENU_Z = "z-90";

export interface FloatingMenuStyle {
  position: "fixed";
  top?: number;
  bottom?: number;
  right: number;
  visibility: "visible" | "hidden";
}

const HIDDEN_STYLE: FloatingMenuStyle = {
  position: "fixed",
  top: -9999,
  right: -9999,
  visibility: "hidden",
};

export function useFloatingMenu({
  open,
  onClose,
  anchorRef,
  preferred,
}: {
  open: boolean;
  onClose: () => void;
  /** 触发器所在的锚点元素(rect 的来源)。菜单**右对齐**这个元素的右边——
   *  与两个组件改造前 `absolute right-0` 的视觉结果一致,只是挪成 JS 算。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 没有更好信息时的首选方向。真正的开合方向由这里现算(见文件头)。 */
  preferred: "down" | "up";
}): { menuRef: RefObject<HTMLDivElement | null>; style: FloatingMenuStyle } {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<FloatingMenuStyle>(HIDDEN_STYLE);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(HIDDEN_STYLE);
      return;
    }
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const anchorRect = anchor.getBoundingClientRect();
    const vertical = computeMenuVerticalPosition(anchorRect, menu.offsetHeight, window.innerHeight, preferred);
    setStyle({
      position: "fixed",
      right: window.innerWidth - anchorRect.right,
      visibility: "visible",
      ...vertical,
    });
    // 依赖只到 `open`/`preferred`/`anchorRef`:刻意不追随后续滚动/resize
    // (见文件头点 2)——那两个改由下面的 effect 直接关闭菜单来处理,不是
    // 靠这里重新测量跟随。
  }, [open, preferred, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, anchorRef, onClose]);

  useEffect(() => {
    if (!open) return;
    // capture 阶段:列表本身可能在一个内部可滚动容器里,不只是 window 会滚。
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);

  return { menuRef, style };
}
