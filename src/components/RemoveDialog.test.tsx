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

  it("第一重:说清会解除关联并删除文件;默认焦点在取消上", () => {
    useMySkills.setState({ removePhase: "confirming", removeTarget: "weekly-report" });
    render(<RemoveDialog />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/解除关联/)).toBeInTheDocument();
    expect(screen.getByText(/删除本地技能文件/)).toBeInTheDocument();
    // 回车绝不等于删除
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("标题用展示名,查不到退回目录名", () => {
    useStoreIndex.setState({
      index: {
        registryId: "company", owner: "skills", repo: "skills", branch: "main",
        commitSha: "a", committedAt: "", fetchedAt: 0, skipped: [], fromCache: false, offline: false, curated: [],
        skills: [{ name: "周报生成", dirSlug: "weekly-report", description: "", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:a", tags: [], author: null }],
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

    await userEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(confirmRemove).toHaveBeenCalled();
  });

  it("第二重警示写明「无法找回」,且不再是普通文案", () => {
    useMySkills.setState({ removePhase: "confirmingForce", removeTarget: "weekly-report" });
    render(<RemoveDialog />);

    expect(screen.getByText("你修改过这个技能")).toBeInTheDocument();
    expect(screen.getByText(/无法找回/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "连同改动一起移除" })).toBeInTheDocument();
    // 第二重的默认焦点也必须在取消上
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
