import { describe, expect, it } from "vitest";

import { computeMenuVerticalPosition, FLOATING_MENU_GAP } from "@/lib/floating-menu-position";

/**
 * 纯函数单测——这是 v7.7 brief 点名的"jsdom 唯一测得动的那一半"。真实的
 * "够不够放"要靠浏览器排版才知道,jsdom 里 `getBoundingClientRect()`/
 * `offsetHeight` 恒为 0,所以这些用例全部手填数字模拟不同的空间场景,
 * 不依赖任何 DOM 渲染。渲染层(`SkillRowMenu.test.tsx`)只能断言这个函数
 * 被正确调用与接线,不能替代这里。
 */
describe("computeMenuVerticalPosition(浮层翻转判据,纯函数)", () => {
  const VIEWPORT = 800;
  const GAP = FLOATING_MENU_GAP;

  it("两侧都够放:遵从首选方向 down", () => {
    // 触发器在视口中段,上下都有大把空间
    const pos = computeMenuVerticalPosition({ top: 300, bottom: 320 }, 100, VIEWPORT, "down");
    expect(pos).toEqual({ top: 320 + GAP });
  });

  it("两侧都够放:遵从首选方向 up", () => {
    const pos = computeMenuVerticalPosition({ top: 300, bottom: 320 }, 100, VIEWPORT, "up");
    expect(pos).toEqual({ bottom: VIEWPORT - 300 + GAP });
  });

  it("首选 down,但下面摆不下、上面摆得下 → 翻到 up(列表贴近视口底边的场景)", () => {
    // 下方只剩 20px 可用(800-780=20),菜单要 100px,放不下
    const pos = computeMenuVerticalPosition({ top: 300, bottom: 780 }, 100, VIEWPORT, "down");
    expect(pos).toEqual({ bottom: VIEWPORT - 300 + GAP });
  });

  it("首选 up,但上面摆不下、下面摆得下 → 翻到 down(贴近视口顶边的场景)", () => {
    const pos = computeMenuVerticalPosition({ top: 20, bottom: 40 }, 100, VIEWPORT, "up");
    expect(pos).toEqual({ top: 40 + GAP });
  });

  it("两侧都摆不下(极端窄视口):退回首选 down,不抛错、不返回第三态", () => {
    const pos = computeMenuVerticalPosition({ top: 300, bottom: 320 }, 10_000, VIEWPORT, "down");
    expect(pos).toEqual({ top: 320 + GAP });
  });

  it("两侧都摆不下:退回首选 up", () => {
    const pos = computeMenuVerticalPosition({ top: 300, bottom: 320 }, 10_000, VIEWPORT, "up");
    expect(pos).toEqual({ bottom: VIEWPORT - 300 + GAP });
  });

  it("边界:刚好等于可用空间时算作'够放'(闭区间,不多不少)", () => {
    // 下方可用空间恰好 = 100(800 - 700 - gap = 100 - gap... 用具体数字更清楚):
    // bottom=696,viewportHeight-bottom-gap = 800-696-4 = 100,menuHeight=100 → 刚好相等
    const pos = computeMenuVerticalPosition({ top: 300, bottom: 696 }, 100, VIEWPORT, "down");
    expect(pos).toEqual({ top: 696 + GAP });
  });
});
