import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareOverwriteDialog } from "./ShareOverwriteDialog";
import { useOverwrite } from "@/store/overwrite";
import { t } from "@/i18n";
import { planOf } from "@/test/share-plan";

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
    plan: planOf({ modified: ["SKILL.md"] }),
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

  it("🔴 终审 C-1:重算过的清单要如实说一句,不静默替换", () => {
    useOverwrite.getState().ask({
      dirSlug: "weekly-report",
      name: "weekly-report",
      plan: planOf({ deleted: ["同事刚加的.md"] }),
      warning: null,
      stale: true,
      staleReason: "remoteChanged",
      confirm: vi.fn(async () => {}),
    });
    render(<ShareOverwriteDialog />);
    expect(screen.getByText(t("share.planChanged"))).toBeInTheDocument();
    expect(screen.getByText("同事刚加的.md")).toBeInTheDocument();
  });

  it("🔴 v8 任务 8:变的是**本地**那一头时说另一句话,不冤枉同事", () => {
    useOverwrite.getState().ask({
      dirSlug: "weekly-report",
      name: "weekly-report",
      plan: planOf({ added: ["刚写的.md"] }),
      warning: null,
      stale: true,
      staleReason: "localChanged",
      confirm: vi.fn(async () => {}),
    });
    render(<ShareOverwriteDialog />);
    expect(screen.getByText(t("share.planChangedLocally"))).toBeInTheDocument();
    expect(screen.queryByText(t("share.planChanged"))).toBeNull();
  });

  it("🔴 只有删除、没有覆盖警告那一档(生产上更常见)照样摆得出清单,且措辞不说覆盖", () => {
    useOverwrite.getState().ask({
      dirSlug: "weekly-report",
      name: "周报生成",
      plan: planOf({ deleted: ["旧的.md"] }),
      warning: null,
      confirm: vi.fn(async () => {}),
    });
    render(<ShareOverwriteDialog />);
    // 标题与主按钮跟着语义走:没人被顶掉,就不许出现"覆盖"
    expect(screen.getByText(t("share.confirmTitle", { name: "周报生成" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("share.confirmGo") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("overwrite.confirm") })).toBeNull();
    // 覆盖警告那一段整条不摆
    expect(screen.queryByText(t("overwrite.body"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("overwrite.history") })).toBeNull();
    // 但清单必须在——这一屏存在的主要理由就是"库里哪几个文件会没"
    expect(screen.getByText("旧的.md")).toBeInTheDocument();
    expect(screen.queryByText(t("share.planChanged"))).toBeNull();
  });
});
