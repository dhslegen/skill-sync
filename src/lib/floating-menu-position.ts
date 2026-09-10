/**
 * 浮层(`SkillRowMenu`/`InstallScopeMenu`)翻转判据的纯函数实现(v7.7)。
 *
 * # 起因
 *
 * 两个下拉菜单此前都是 `position: absolute` 挂在触发器的 `relative` 容器下,
 * 往哪个方向开是**调用方写死的 CSS 类**(`SkillRowMenu` 的 `placement` 参数、
 * `InstallScopeMenu` 硬编码的 `bottom-full`)。这在「我的技能」列表卡片上会被
 * `RowCard` 的 `overflow-hidden` 裁掉一半,在项目行的底部行更糟——菜单直接画到
 * 视口外,而且 `absolute` 定位随文档流一起滚,用户永远追不到(v7.7 brief)。
 *
 * 改法是 portal 到 `document.body` + `position: fixed`,并在**打开那一刻**按
 * 触发器的真实 `getBoundingClientRect()` 决定实际往哪边开。这个决定过程本身
 * 就是这个文件——一个不碰 DOM、只算数字的纯函数,唯一能在 jsdom 里稳定测到的
 * 那一半(jsdom 不排版,`getBoundingClientRect()`/`offsetHeight` 在那里恒为 0,
 * 真实的"够不够放"这件事测不出来;渲染层测试因此只能断言代理量,见
 * `SkillRowMenu.test.tsx` 文件头)。
 *
 * # 🔴 一条被撤回的说法
 *
 * 上一轮(v7.6 任务 3,提交 `447e40a`)曾把这里要解决的问题记成"第四次『约定 →
 * 类型』"——把 `placement` 从"没有类型的约定"升级成"必填的闭合联合类型"。
 * **这个归类是错的,本次改动一并订正**:前三次(`variant`/`LocalProbe`/`capsOf`)
 * 编码进类型的都是**随代码结构静态确定**的事实,编译期就能判定对不对;
 * `placement` 说的是"这个触发器下面有没有空间",那是**运行时才知道、还会随
 * 滚动位置动态变化**的事实——把动态量塞进静态类型,类型系统本身没有错,
 * 错的是拿它去回答一个它答不了的问题。真正对应"约定 → 类型"这条纪律的修法
 * 不是加更细的类型,是让代码在**运行时**读这件事的权威来源(视口 + 触发器的
 * 实时 rect),这正是这个文件在做的事。旧的 `MenuPlacement` 类型因此降级:
 * 调用方传的不再是"菜单会往哪开"的断言,只是"没有更好信息时的首选方向"
 * (`preferred`),真正的开合方向由这里现算。
 */

/** 触发器矩形,只取这个函数用得到的两个维度——不要求真实 `DOMRect`。 */
export interface FloatingAnchorRect {
  top: number;
  bottom: number;
}

/** 计算结果:要么定 `top`(向下开),要么定 `bottom`(向上开),二选一。
 *  两个字段都是相对**视口**的像素值,配 `position: fixed` 直接用。 */
export type FloatingVerticalPosition = { top: number } | { bottom: number };

/** 菜单与触发器之间的间距(px)。与旧版 `mt-1`/`mb-1`(Tailwind `1` = 4px)
 *  取值一致,只是从 CSS 类挪成了 JS 常量——挪地方不改视觉结果。 */
export const FLOATING_MENU_GAP = 4;

/**
 * 纯函数:给定触发器 rect、菜单高度、视口高度与"没有更好信息时的首选方向",
 * 算出菜单实际应该往哪边开、开到哪个像素坐标。
 *
 * 判据(brief 要求的三元签名 `(triggerRect, menuHeight, viewportHeight) →
 * { top } | { bottom }`,这里另加了 `preferred`——它是纯函数,答不出"没被
 * 告知的首选方向"这件事,只能作为显式参数传入):
 *
 * - **两侧都够放**:听首选方向的,不折腾用户熟悉的默认展开方向;
 * - **只有一侧够放**:不管首选是什么,用够放的那一侧——这正是"翻转"的意义,
 *   翻转的判据不是"首选不行就随便挑一个",是"哪边真的放得下";
 * - **两侧都放不下**(极端窄视口):没有更好的答案,退回首选方向——
 *   与其抛错或返回一个"两者都不是"的第三态,不如给一个确定的答案,
 *   用户顶多是要滚动才能看到菜单底部,好过菜单整个不渲染。
 */
export function computeMenuVerticalPosition(
  triggerRect: FloatingAnchorRect,
  menuHeight: number,
  viewportHeight: number,
  preferred: "down" | "up",
  gap: number = FLOATING_MENU_GAP,
): FloatingVerticalPosition {
  const spaceBelow = viewportHeight - triggerRect.bottom - gap;
  const spaceAbove = triggerRect.top - gap;
  const fitsBelow = spaceBelow >= menuHeight;
  const fitsAbove = spaceAbove >= menuHeight;

  const openDown = shouldOpenDown(preferred, fitsBelow, fitsAbove);

  return openDown ? { top: triggerRect.bottom + gap } : { bottom: viewportHeight - triggerRect.top + gap };
}

function shouldOpenDown(preferred: "down" | "up", fitsBelow: boolean, fitsAbove: boolean): boolean {
  if (fitsBelow && fitsAbove) return preferred === "down"; // 两侧都够,听首选的
  if (fitsBelow) return true; // 只有下面放得下,翻不翻都得选它
  if (fitsAbove) return false; // 只有上面放得下,同上
  return preferred === "down"; // 两侧都放不下,没有更好答案,退回首选
}
