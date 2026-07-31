import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictDialog } from "./ConflictDialog";
import { useInstall } from "@/store/install";
import { useStoreIndex } from "@/store/store-index";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function conflict(precheck: Parameters<typeof useInstall.setState>[0] extends never ? never : unknown) {
  useInstall.setState({
    phase: "conflict",
    dirSlug: "weekly-report",
    precheck: precheck as never,
  });
}

describe("冲突对话框", () => {
  beforeEach(() => {
    useInstall.setState({ phase: "idle", dirSlug: null, precheck: null });
  });

  it("没有冲突时不渲染", () => {
    render(<ConflictDialog />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("用户改过本体:三个选项都在,且说清各自后果", () => {
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("你修改过这个技能")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保留并分享我的改动/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /只保留,暂不分享/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /用团队库的版本覆盖/ })).toBeInTheDocument();
    // 破坏性那一项必须写明"找不回来"
    expect(screen.getByText(/无法找回/)).toBeInTheDocument();
  });

  it("默认焦点落在「保留并分享」上 —— 用户拍板的默认项,且回车不会误覆盖", () => {
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByRole("button", { name: /保留并分享我的改动/ })).toHaveFocus();
  });

  it("「只保留」选项指路到之后可以分享的入口", () => {
    // 任务 11 之前这里写的是"分享功能开放后"——通道落地了,文案也要跟着指路,
    // 不能让用户保留了改动却不知道下一步去哪。
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByText(/「我的技能」/)).toBeInTheDocument();
  });

  it("选「只保留」→ 带 keepLocal 重试,不发分享", async () => {
    const run = vi.fn();
    const keepLocalAndShare = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ run, keepLocalAndShare });
    render(<ConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: /只保留,暂不分享/ }));
    expect(run).toHaveBeenCalledWith("keepLocal");
    expect(keepLocalAndShare).not.toHaveBeenCalled();
  });

  it("选「保留并分享」→ 走 keepLocalAndShare", async () => {
    const keepLocalAndShare = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ keepLocalAndShare });
    render(<ConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: /保留并分享我的改动/ }));
    expect(keepLocalAndShare).toHaveBeenCalled();
  });

  it("选覆盖 → 带 overwrite 重试", async () => {
    const run = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ run });
    render(<ConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: /用团队库的版本覆盖/ }));
    expect(run).toHaveBeenCalledWith("overwrite");
  });

  it("外来目录:没有「保留改动」这一档,默认焦点在取消上", () => {
    // 别人装的目录里没有"你的改动"可留,只有替换与取消两条路,
    // 且绝不能默认落在替换上 —— 那是在替用户决定删掉他从别处装的东西。
    conflict({ status: "foreign", origin: { kind: "unknown" } });
    render(<ConflictDialog />);

    expect(screen.queryByRole("button", { name: /保留我的改动/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /替换它/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("说的是技能的展示名,不是内部目录名", () => {
    // 用户认得的是"周报生成";弹给他一个 weekly-report,就是把机器用的标识摆到脸上
    useStoreIndex.setState({
      index: {
        registryId: "company", owner: "skills", repo: "skills", branch: "main",
        commitSha: "a", committedAt: "", fetchedAt: 0, skipped: [], fromCache: false, offline: false,
        skills: [{ name: "周报生成", dirSlug: "weekly-report", description: "", path: "", hasScripts: false, fileCount: 1 }],
      },
    });
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByText(/「周报生成」/)).toBeInTheDocument();
    expect(screen.queryByText(/weekly-report/)).not.toBeInTheDocument();
  });

  it("查不到展示名时退回目录名,而不是留空", () => {
    useStoreIndex.setState({ index: null });
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByText(/「weekly-report」/)).toBeInTheDocument();
  });

  it("认得出来源的外来目录会把来源说出来", () => {
    conflict({ status: "foreign", origin: { kind: "npxSkills", source: "acme/skills" } });
    render(<ConflictDialog />);
    expect(screen.getByText(/acme\/skills/)).toBeInTheDocument();
  });

  it("Esc 取消,不留在半路", async () => {
    const cancel = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ cancel });
    render(<ConflictDialog />);

    await userEvent.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalled();
  });
});
