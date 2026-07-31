import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepairDialog } from "./RepairDialog";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  useMySkills.setState({ repairConfirmTarget: null, repairBusy: null, repairError: null });
  useStoreIndex.setState({ index: null });
}

describe("修复确认对话框", () => {
  beforeEach(reset);

  it("没有待确认的替换时不渲染", () => {
    render(<RepairDialog />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("写明「无法找回」,默认焦点在取消上 —— 回车绝不等于替换", () => {
    useMySkills.setState({ repairConfirmTarget: "weekly-report" });
    render(<RepairDialog />);

    expect(screen.getByText(/无法找回/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("确认走 confirmRepair,Esc 走 cancelRepair", async () => {
    const confirmRepair = vi.fn();
    const cancelRepair = vi.fn();
    useMySkills.setState({ repairConfirmTarget: "weekly-report", confirmRepair, cancelRepair });
    render(<RepairDialog />);

    await userEvent.click(screen.getByRole("button", { name: "替换并修复" }));
    expect(confirmRepair).toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(cancelRepair).toHaveBeenCalled();
  });
});
