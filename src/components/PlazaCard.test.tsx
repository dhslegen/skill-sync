import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PlazaCard } from "./PlazaCard";
import type { PlazaSkillCard } from "@/lib/ipc";

const card = (over: Partial<PlazaSkillCard> = {}): PlazaSkillCard => ({
  name: "React 最佳实践",
  slug: "vercel-labs/skills/react-best-practices",
  ownerRepo: "vercel-labs/skills",
  installs: 625414,
  ...over,
});

describe("PlazaCard", () => {
  it("展示名称与等宽的来源仓", () => {
    render(<PlazaCard card={card()} onOpen={() => {}} />);
    expect(screen.getByText("React 最佳实践")).toBeInTheDocument();
    const repo = screen.getByText("vercel-labs/skills");
    expect(repo.className).toMatch(/font-mono/);
  });

  it("展示安装量徽标(中文紧凑格式)", () => {
    render(<PlazaCard card={card({ installs: 625414 })} onOpen={() => {}} />);
    expect(screen.getByText("62.5万 次安装")).toBeInTheDocument();
  });

  it("安装量为 0 时不显示徽标", () => {
    render(<PlazaCard card={card({ installs: 0 })} onOpen={() => {}} />);
    expect(screen.queryByText(/次安装/)).not.toBeInTheDocument();
  });

  it("没有 description 字段,不渲染空的描述行", () => {
    const { container } = render(<PlazaCard card={card()} onOpen={() => {}} />);
    // 卡片除了图标/名称/来源仓/徽标外不该多出一段空文本容器
    expect(container.querySelectorAll("p").length).toBe(0);
  });

  it("点击(含键盘 Enter/Space)触发 onOpen,且只触发一次", async () => {
    const onOpen = vi.fn();
    render(<PlazaCard card={card()} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "React 最佳实践" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
