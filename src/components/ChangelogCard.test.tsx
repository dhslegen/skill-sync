import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangelogCard } from "@/components/ChangelogCard";
import type { ReleaseNote } from "@/lib/ipc";
import { useChangelog } from "@/store/changelog";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

function note(version: string, theme: string, date: string | null = null): ReleaseNote {
  return { versions: [version], date, theme, body: `- ${version} 的要点` };
}

function seed(pending: ReleaseNote[], current = "0.5.0") {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "release_notes_state") return { current, pending, all: pending };
    return null;
  });
}

beforeEach(() => {
  invoke.mockReset();
  useChangelog.setState({ current: "", pending: [], all: [], dismissed: false });
});

describe("升级后的更新日志卡片", () => {
  it("没有要看的就整个不渲染 —— 平时零打扰", async () => {
    seed([]);
    const { container } = render(<ChangelogCard />);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("摆出版本号、主题句与正文", async () => {
    seed([note("0.5.0", "项目级安装")]);
    render(<ChangelogCard />);

    await screen.findByText("已更新到 0.5.0");
    expect(screen.getByText("项目级安装")).toBeTruthy();
    expect(screen.getByText(/0.5.0 的要点/)).toBeTruthy();
  });

  it("有发布日期就摆出来", async () => {
    seed([note("0.5.0", "项目级安装", "2026-08-22")]);
    render(<ChangelogCard />);

    await screen.findByText("已更新到 0.5.0");
    expect(screen.getByText("2026-08-22")).toBeTruthy();
  });

  it("正文限高可滚 —— 一段说明本身就可能很长,卡片不能吃掉首屏", async () => {
    // 真机自查抓到的:0.4.0 那一段有六条要点,不限高的话技能卡片被挤到看不见。
    // 而"打扰最低"正是选卡片而不是弹窗的理由。
    seed([note("0.5.0", "项目级安装")]);
    render(<ChangelogCard />);

    const body = await screen.findByTestId("changelog-body");
    expect(body.className).toContain("max-h-");
    expect(body.className).toContain("overflow-y-auto");
  });

  it("跨版本时当前版本展开、漏看的收成一行,点开才展", async () => {
    // 内网发版很密,一口气跨好几版是常态。全展开会把首屏吃掉。
    seed([note("0.5.0", "项目级安装"), note("0.4.0", "技能广场")]);
    render(<ChangelogCard />);

    await screen.findByText("已更新到 0.5.0");
    expect(screen.getByText(/0.5.0 的要点/)).toBeTruthy();
    expect(screen.queryByText(/0.4.0 的要点/)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /还漏看了 0.4.0/ }));

    expect(screen.getByText(/0.4.0 的要点/)).toBeTruthy();
  });

  it("关掉才记「已看过」,而且立刻从界面消失", async () => {
    seed([note("0.5.0", "项目级安装")]);
    const { container } = render(<ChangelogCard />);
    await screen.findByText("已更新到 0.5.0");

    // 只是显示,不能有任何记账写入
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "release_notes_ack")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "知道了" }));

    await waitFor(() => {
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "release_notes_ack")).toHaveLength(1);
      expect(container.textContent).toBe("");
    });
  });
});
