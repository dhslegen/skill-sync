import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RemoveDialog } from "./RemoveDialog";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  useMySkills.setState({
    removePhase: "idle",
    removeTarget: null,
    removeError: null,
  });
  useStoreIndex.setState({ index: null });
}

describe("移除确认对话框", () => {
  beforeEach(reset);

  it("没在移除时不渲染", () => {
    render(<RemoveDialog />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("弹出来时是 alertdialog,默认焦点在取消上", () => {
    useMySkills.setState({ removePhase: "confirming", removeTarget: "weekly-report" });
    render(<RemoveDialog />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // 回车绝不等于移除
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("标题用展示名,查不到退回目录名", () => {
    useStoreIndex.setState({
      index: {
        registryId: "company", owner: "skills", repo: "skills", branch: "main",
        commitSha: "a", committedAt: "", fetchedAt: 0, skipped: [], fromCache: false, offline: false, curated: [],
        skills: [{ name: "周报生成", dirSlug: "weekly-report", description: "", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:a", tags: [], author: null, updatedAt: { kind: "unknown" } }],
      },
    });
    useMySkills.setState({ removePhase: "confirming", removeTarget: "weekly-report" });
    render(<RemoveDialog />);
    expect(screen.getByText(/「周报生成」/)).toBeInTheDocument();
    expect(screen.queryByText(/weekly-report/)).not.toBeInTheDocument();
  });

  it("确认按钮走 confirmRemove", async () => {
    const confirmRemove = vi.fn();
    useMySkills.setState({ removePhase: "confirming", removeTarget: "weekly-report", confirmRemove });
    render(<RemoveDialog />);

    await userEvent.click(screen.getByRole("button", { name: "移到废纸篓" }));
    expect(confirmRemove).toHaveBeenCalled();
  });

  it("只有一步,文案说清东西去了废纸篓、能找回", () => {
    // v6 二期:core 的 `RemoveOutcome` 只剩「已移除」一档,双确认整个撤销。
    // 铁律 7 现在靠**可逆**落实,所以这一屏的责任是把"去哪了、怎么捞回来"说清楚
    // ——写成「无法找回」在今天是**假话**。
    useMySkills.setState({ removePhase: "confirming", removeTarget: "weekly-report" });
    render(<RemoveDialog />);

    // 正文与按钮上都有「废纸篓」,所以这里按正文那一段断言,不用会撞多个的 getByText
    const body = screen.getByRole("alertdialog").querySelector("p");
    expect(body?.textContent).toMatch(/废纸篓/);
    expect(body?.textContent).toMatch(/找回/);
    expect(body?.textContent).not.toMatch(/无法找回/);
    expect(screen.getByRole("button", { name: "移到废纸篓" })).toBeInTheDocument();
    // 已撤销的第二重按钮不该以任何形式还在
    expect(screen.queryByRole("button", { name: "连同改动一起移除" })).toBeNull();
    // 破坏性动作的默认焦点仍在取消上——回车绝不等于移除
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("失败信息显示在弹窗里,弹窗不关", () => {
    useMySkills.setState({
      removePhase: "confirming",
      removeTarget: "weekly-report",
      removeError: { code: "FS_TASK", message: "移除操作未能完成,请重试" },
    });
    render(<RemoveDialog />);
    expect(screen.getByText(/未能完成/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("Esc 取消", async () => {
    const cancelRemove = vi.fn();
    useMySkills.setState({ removePhase: "confirming", removeTarget: "weekly-report", cancelRemove });
    render(<RemoveDialog />);

    await userEvent.keyboard("{Escape}");
    expect(cancelRemove).toHaveBeenCalled();
  });
});
