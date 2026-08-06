import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareConflictDialog } from "./ShareConflictDialog";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useMySkills.setState({ shareConflict: null, shareBusy: null });
  useStoreIndex.setState({ index: null });
}

describe("分享改动的冲突弹窗", () => {
  beforeEach(reset);

  it("没有冲突时不渲染", () => {
    render(<ShareConflictDialog />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("说明对方更新过、改动不会丢;默认焦点在「先不动」上", () => {
    useMySkills.setState({ shareConflict: { dirSlug: "weekly-report", historyUrl: null } });
    render(<ShareConflictDialog />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /其他人更新/ })).toBeInTheDocument();
    expect(screen.getByText(/不会丢/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "先不动" })).toHaveFocus();
    // 没有任何「覆盖」入口——覆盖别人的改动不该是一个按钮
    expect(screen.queryByText(/覆盖/)).not.toBeInTheDocument();
  });

  it("确认走 confirmShareReview,Esc 走 cancelShareConflict", async () => {
    const confirmShareReview = vi.fn();
    const cancelShareConflict = vi.fn();
    useMySkills.setState({
      shareConflict: { dirSlug: "weekly-report", historyUrl: null },
      confirmShareReview,
      cancelShareConflict,
    });
    render(<ShareConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: "提交审核" }));
    expect(confirmShareReview).toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(cancelShareConflict).toHaveBeenCalled();
  });

  it("有历史链接时给「看看对方改了什么」,点开走系统浏览器白名单通道", async () => {
    useMySkills.setState({
      shareConflict: {
        dirSlug: "weekly-report",
        historyUrl: "http://gitea.internal:3000/skills/skills/commits/branch/main/skills/weekly-report",
      },
    });
    render(<ShareConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: "看看对方改了什么" }));

    expect(invoke).toHaveBeenCalledWith("open_library_url", {
      args: {
        url: "http://gitea.internal:3000/skills/skills/commits/branch/main/skills/weekly-report",
      },
    });
  });

  it("没有历史链接时不摆「看看对方改了什么」——点了没反应的按钮不摆", () => {
    useMySkills.setState({ shareConflict: { dirSlug: "weekly-report", historyUrl: null } });
    render(<ShareConflictDialog />);
    expect(screen.queryByRole("button", { name: "看看对方改了什么" })).not.toBeInTheDocument();
  });

  it("显示名从商店索引取,不露目录名", () => {
    useStoreIndex.setState({
      index: {
        registryId: "company",
        owner: "skills",
        repo: "skills",
        branch: "main",
        commitSha: "x",
        committedAt: "",
        fetchedAt: 0,
        skipped: [],
        fromCache: false,
        offline: false,
        curated: [],
        skills: [
          {
            name: "周报生成",
            dirSlug: "weekly-report",
            description: "",
            path: "",
            hasScripts: false,
            fileCount: 1,
            contentHash: "h",
            tags: [],
            author: null,
          },
        ],
      },
    });
    useMySkills.setState({ shareConflict: { dirSlug: "weekly-report", historyUrl: null } });
    render(<ShareConflictDialog />);

    expect(screen.getByText(/周报生成/)).toBeInTheDocument();
  });
});
