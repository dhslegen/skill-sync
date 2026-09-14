import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SkillRowMenu } from "@/components/SkillRowMenu";

/**
 * v7.7:菜单改成 portal 到 `document.body` 之后重写的用例。
 *
 * 🔴 **这个文件证明不了"菜单真的往哪个方向开"**——那是 `useFloatingMenu` 按
 * `getBoundingClientRect()`/`offsetHeight` 现算的,而 jsdom 不排版,这两个值
 * 在这里恒为 0,任何依赖真实空间大小的判断在这里都测不出区别
 * (`computeMenuVerticalPosition` 那个纯函数才是唯一测得动方向判据的地方,
 * 见 `src/lib/floating-menu-position.test.ts`)。真正的护栏是走查清单里
 * "详情页脚点「…」仍向上开" 那一条。
 *
 * 这里测的是 portal 之后**结构层面**能确定的东西——不依赖真实布局:
 * 菜单是否真的挂到了 `document.body` 下(代理量)、外点关闭的判据是否正确
 * 区分了"点在菜单里"与"点在外面"(这条是纯 DOM 结构问题,不依赖布局,
 * jsdom 测得准)、滚动是否关闭菜单。
 */
describe("SkillRowMenu · portal 结构", () => {
  const openMenu = async (extraItems: { key: string; label: string; onClick: () => void }[] = []) => {
    const onClick = vi.fn();
    const items = [{ key: "remove", label: "移除", onClick }, ...extraItems];
    render(<SkillRowMenu items={items} preferredPlacement={"down"} subject="周报生成" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /更多/ }));
    return { onClick, user };
  };

  it("菜单挂在 document.body 下(代理量:portal 生效,不再是触发器容器的子孙)", async () => {
    await openMenu();
    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
  });

  it("🔴 坑 1:点菜单项要能点中——不能被外点关闭逻辑先一步误判成'点在外面'", async () => {
    // 这是 portal 之后最容易复现的那个缺陷:旧判据只查
    // `wrapRef.contains(target)`,portal 之后菜单不在 wrapRef 的子树里,
    // 于是点在菜单项上的 mousedown 会被判成"点在外面"先把菜单关掉,
    // 紧随其后的 click 打不到已经从 DOM 上摘掉的按钮。
    const { onClick, user } = await openMenu();
    await user.click(screen.getByRole("menuitem", { name: "移除" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("点在触发器与菜单都之外时关闭菜单", async () => {
    await openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.mouseDown(outside);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    outside.remove();
  });

  it("🔴 坑 2:滚动即关闭(不追随)", async () => {
    await openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("resize 同样关闭", async () => {
    await openMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Escape 关闭菜单,焦点回到触发按钮", async () => {
    await openMenu();
    const trigger = screen.getByRole("button", { name: /更多/ });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("可访问名点名这是谁的菜单,同一页两颗「更多」分得开(0.6.x K4)", () => {
    // 此前全站每颗都叫「更多」:屏幕阅读器用户在「我的技能」里听到十几个同名按钮,
    // 分不出哪颗属于哪一行。值来自 i18n,断言按语义(带主语 + 仍含「更多」),
    // 不抄字面量——哪天措辞再改,这条测的东西不变。
    render(
      <>
        <SkillRowMenu items={[{ key: "a", label: "A", onClick: vi.fn() }]} preferredPlacement={"down"} subject="周报生成" />
        <SkillRowMenu items={[{ key: "b", label: "B", onClick: vi.fn() }]} preferredPlacement={"down"} subject="接口测试专家" />
      </>,
    );
    const names = screen.getAllByRole("button", { name: /更多/ }).map((b) => b.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("周报生成");
    expect(names[1]).toContain("接口测试专家");
    expect(names[0]).not.toBe(names[1]);
  });

  it("没有条目时不渲染触发按钮", () => {
    render(<SkillRowMenu items={[]} preferredPlacement={"down"} subject="周报生成" />);
    expect(screen.queryByRole("button", { name: /更多/ })).not.toBeInTheDocument();
  });

  it("菜单容器带 `position: fixed`(不再是 `absolute` 挂在祖先容器下)", async () => {
    await openMenu();
    expect(screen.getByRole("menu")).toHaveStyle({ position: "fixed" });
  });
});

/**
 * 这里手动 mock `getBoundingClientRect`/`offsetHeight`/`innerHeight`,验证
 * `placement` 这个 prop 真的**接上了** `computeMenuVerticalPosition`
 * ——只测纯函数(`floating-menu-position.test.ts`)证明不了这件事:如果有人
 * 不小心把 `preferred` 参数漏传或传反,纯函数测试全绿,只有这种接线测试才抓得到。
 *
 * ⚠️ **这些数字是手填的,不代表真实浏览器排版**——WKWebView 的实际测量值
 * 会不一样,这条测试只证明"数据从 prop 流到最终 style 的链路没有断",
 * 不证明真机上视口够不够放。
 */
describe("SkillRowMenu · 方向接线(mock rect)", () => {
  it("首选 down,但下方空间不够、上方够 → 最终 style 翻到 bottom(不是 top)", async () => {
    const innerHeightSpy = vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const rectSpy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 780, bottom: 796, left: 0, right: 0, width: 24, height: 16, x: 0, y: 0, toJSON() {} });
    const offsetHeightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);

    render(<SkillRowMenu items={[{ key: "remove", label: "移除", onClick: vi.fn() }]} preferredPlacement={"down"} subject="周报生成" />);
    await userEvent.setup().click(screen.getByRole("button", { name: /更多/ }));

    const menu = screen.getByRole("menu");
    expect(menu.style.bottom).not.toBe("");
    expect(menu.style.top).toBe("");

    innerHeightSpy.mockRestore();
    rectSpy.mockRestore();
    offsetHeightSpy.mockRestore();
  });
});
