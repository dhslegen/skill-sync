import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareOverwriteDialog } from "./ShareOverwriteDialog";
import { useOverwrite } from "@/store/overwrite";
import { t } from "@/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

function reset() {
  invoke.mockReset();
  useOverwrite.setState({ pending: null, busy: false });
}

const ask = (over: Partial<{ lastAuthor: string | null; lastAt: string | null; historyUrl: string | null }> = {}, confirm = vi.fn(async () => {})) => {
  useOverwrite.getState().ask({
    dirSlug: "weekly-report",
    name: "weekly-report",
    plan: { added: [], modified: ["SKILL.md"], deleted: [] },
    warning: {
      lastAuthor: "李四",
      lastAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      historyUrl: "http://g/skills/skills/commits/branch/main/skills/weekly-report",
      ...over,
    },
    confirm,
  });
  return confirm;
};

describe("覆盖确认屏(v8 任务 4)", () => {
  beforeEach(reset);

  it("没有待拍板的覆盖时不渲染", () => {
    render(<ShareOverwriteDialog />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("🔴 点名覆盖谁、什么时候改的,以及去哪找回", () => {
    ask();
    render(<ShareOverwriteDialog />);

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    // 覆盖谁:技能名与最后改动的人都要出现在屏上
    expect(screen.getByText(/weekly-report/)).toBeTruthy();
    const who = screen.getByText(/李四/);
    expect(who.textContent).toContain("2 天前");
    // 去哪找回
    expect(screen.getByText(t("overwrite.recoverable"))).toBeTruthy();
    expect(screen.getByText(t("overwrite.history"))).toBeTruthy();
  });

  it("取不到谁/什么时候时如实说「看不出」,不摆半句话", () => {
    ask({ lastAuthor: null, lastAt: null, historyUrl: null });
    render(<ShareOverwriteDialog />);

    expect(screen.getByText(t("overwrite.unknownWho"))).toBeTruthy();
    // 链接给不出时整行不摆:一个点不开的链接比不摆更糟
    expect(screen.queryByText(t("overwrite.history"))).toBeNull();
  });

  it("时间解析不了时退回「只有人名」那一句,不出现「改于 」这种半句话", () => {
    ask({ lastAt: "不是时间" });
    render(<ShareOverwriteDialog />);

    expect(screen.getByText(t("overwrite.byWho", { author: "李四" }))).toBeTruthy();
  });

  it("「仍然覆盖」跑发起方给的那一跳", async () => {
    const confirm = ask();
    render(<ShareOverwriteDialog />);

    await userEvent.click(screen.getByText(t("overwrite.confirm")));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useOverwrite.getState().pending).toBeNull();
  });

  it("🔴 「先不动」零副作用:不跑那一跳,也不发任何 IPC", async () => {
    const confirm = ask();
    render(<ShareOverwriteDialog />);

    await userEvent.click(screen.getByText(t("overwrite.cancel")));

    expect(confirm).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(useOverwrite.getState().pending).toBeNull();
  });

  it("默认焦点在「先不动」上——回车绝不等于覆盖同事的版本", () => {
    ask();
    render(<ShareOverwriteDialog />);

    expect(document.activeElement?.textContent).toBe(t("overwrite.cancel"));
  });
});
