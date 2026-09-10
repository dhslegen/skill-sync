import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SkillRowMenu } from "@/components/SkillRowMenu";

/**
 * 🔴 这个文件的存在本身有个原委,值得记住(v7.6 任务 3 复审)。
 *
 * `placement` 这个必填参数是为了修一个**真机才可达**的缺陷加的:v7.6 任务 3 把
 * 「移除」收进这个菜单、又把菜单摆在详情面板**最底部**,而它一直硬编码
 * `top-full`(向下展开)——那里向下展开必然画到视口外,用户点了「…」什么都看不到。
 *
 * ⚠️ **jsdom 没有视口,测不出"画到视口外"这件事**。所以这里断言的是
 * **方向类名**这个代理量,而不是真实的可见性——如实写明,免得下一个人以为
 * 有了这几条就不用在真机上看了。真正的护栏是走查清单里那一条。
 */
describe("SkillRowMenu 的展开方向", () => {
  const items = [{ key: "remove", label: "移除", onClick: vi.fn() }];

  const openMenu = (placement: "down" | "up") => {
    render(<SkillRowMenu items={items} placement={placement} />);
    fireEvent.click(screen.getByRole("button", { name: /更多/ }));
    // 菜单容器是那颗触发按钮的兄弟节点(见组件里 wrapRef 的说明)
    return screen.getByRole("menuitem", { name: "移除" }).parentElement!;
  };

  it("placement=\"down\" 向下展开(列表行里的用法:行在中间,向下有空间)", () => {
    const menu = openMenu("down");
    expect(menu.className.split(/\s+/)).toContain("top-full");
    expect(menu.className.split(/\s+/)).not.toContain("bottom-full");
  });

  it("🔴 placement=\"up\" 向上展开(贴底容器的用法:详情面板页脚)", () => {
    const menu = openMenu("up");
    expect(menu.className.split(/\s+/)).toContain("bottom-full");
    expect(menu.className.split(/\s+/)).not.toContain("top-full");
  });
});
