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
        commitSha: "a", committedAt: "", fetchedAt: 0, skipped: [], fromCache: false, offline: false, curated: [],
        skills: [{ name: "周报生成", dirSlug: "weekly-report", description: "", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:a", tags: [], author: null }],
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

  it("同名异库:说清它现在从哪来,只给替换与取消,默认焦点在取消", () => {
    // 它**是**本应用装的,所以既不能套"改过本体"的三选(没有改动可保留),
    // 也不能套外来目录那句"不是本应用安装的"——那是假话。
    conflict({
      status: "otherLibrary",
      installedSha: "zzz9999",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    });
    render(<ConflictDialog />);

    expect(screen.getByText(/design\/design-skills/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /保留我的改动/ })).not.toBeInTheDocument();
    // 不能落进外来目录那一档的文案
    expect(screen.queryByText(/不是本应用安装的|不是这个应用安装的/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /替换/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  describe("这是我分享的技能(v6 任务 5 的完整变体)", () => {
    it("远端变过:只有两个按钮,没有「保留并贡献」;默认焦点在「以本地为准」上", () => {
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      render(<ConflictDialog />);

      expect(screen.getByText(/库里有新版/)).toBeInTheDocument();
      expect(screen.queryByText(/不是本应用安装的|不是这个应用安装的/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /保留并贡献/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以本地为准,分享更新/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以库为准,丢弃本地改动/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以本地为准,分享更新/ })).toHaveFocus();
    });

    it("远端没变过:标题/正文不说「库里有新版」这句假话", () => {
      // core 只在 local_changed 为真时才会走到这个弹窗,remoteChanged 才是
      // 到这里唯一还不确定的事——为假时不能沿用"库里有新版"这句话。
      conflict({ status: "mine", localChanged: true, remoteChanged: false });
      render(<ConflictDialog />);

      expect(screen.queryByText(/库里有新版/)).not.toBeInTheDocument();
      expect(screen.queryByText(/同事通过审核改的/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以本地为准,分享更新/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以库为准,丢弃本地改动/ })).toBeInTheDocument();
    });

    it("点「以本地为准」→ 走 keepLocalAndShareMine,不是 keepLocalAndShare", async () => {
      const keepLocalAndShareMine = vi.fn();
      const keepLocalAndShare = vi.fn();
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      useInstall.setState({ keepLocalAndShareMine, keepLocalAndShare });
      render(<ConflictDialog />);

      await userEvent.click(screen.getByRole("button", { name: /以本地为准,分享更新/ }));
      expect(keepLocalAndShareMine).toHaveBeenCalled();
      expect(keepLocalAndShare).not.toHaveBeenCalled();
    });

    it("点「以库为准」先出二次确认、不立即调 run;确认后才调 run(\"overwrite\")", async () => {
      const run = vi.fn();
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      useInstall.setState({ run });
      render(<ConflictDialog />);

      const overwriteButton = screen.getByRole("button", { name: /以库为准,丢弃本地改动/ });
      await userEvent.click(overwriteButton);
      expect(run).not.toHaveBeenCalled();
      expect(screen.getByText("本地改动将无法找回,确定?")).toBeInTheDocument();

      await userEvent.click(overwriteButton);
      expect(run).toHaveBeenCalledWith("overwrite");
    });

    it("换一个技能会收回二次确认的武装状态", async () => {
      const run = vi.fn();
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      useInstall.setState({ run });
      const { rerender } = render(<ConflictDialog />);

      await userEvent.click(screen.getByRole("button", { name: /以库为准,丢弃本地改动/ }));
      expect(screen.getByText("本地改动将无法找回,确定?")).toBeInTheDocument();

      // 换一个技能(dirSlug 变了),同样是 mine 冲突
      useInstall.setState({ dirSlug: "another-skill" });
      rerender(<ConflictDialog />);

      expect(screen.queryByText("本地改动将无法找回,确定?")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /以库为准,丢弃本地改动/ }));
      // 这一下是新技能的第一次点击,只该武装,不该直接调 run
      expect(run).not.toHaveBeenCalled();
    });
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
