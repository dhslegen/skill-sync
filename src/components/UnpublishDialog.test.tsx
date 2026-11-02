import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnpublishDialog } from "./UnpublishDialog";
import { t } from "@/i18n";
import type { InstalledSkillView, UnpublishOutcome } from "@/lib/ipc";
import { buildRowMenuItems } from "@/lib/ownership";
import { unpublishTargetOf, useUnpublish } from "@/store/unpublish";

const invoke = vi.fn(async (cmd: string, args?: unknown): Promise<unknown> => {
  void cmd;
  void args;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const preview = (over: Partial<Extract<UnpublishOutcome, { outcome: "needsConfirm" }>> = {}): UnpublishOutcome => ({
  outcome: "needsConfirm",
  files: ["SKILL.md", "ref.md"],
  remoteRev: "rev-1",
  historyUrl: "http://g.example/skills/skills/commits/branch/main/skills/weekly-report",
  stale: false,
  ...over,
});

const TARGET = {
  dirSlug: "weekly-report",
  displayName: "周报生成",
  registryId: "company",
  repo: "skills/skills",
  localPresent: true,
};

function answer(seq: (UnpublishOutcome | Error | { code: string; message: string })[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd !== "skill_unpublish") return cmd === "installed_list" ? [] : null;
    const next = seq.shift();
    if (!next) throw new Error("多发了一次 skill_unpublish");
    if ("outcome" in next) return next;
    throw next;
  });
}

const calls = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "skill_unpublish").map(([, a]) => (a as { args: unknown }).args);

beforeEach(() => {
  invoke.mockReset();
  useUnpublish.getState().close();
});

describe("「…」里的「从技能库删除」只给作者(0.8.0 任务 6)", () => {
  const skill = (over: Partial<InstalledSkillView>) =>
    ({ body: "/b", localPresent: true, localModified: false, shareBlocked: null, section: "sharedTo", relation: "shared", ...over }) as InstalledSkillView;

  it("作者:排在最后,紧跟「移除」不再多画一条分隔线", () => {
    const items = buildRowMenuItems(skill({}), { kind: "none" }, false, false);
    expect(items.map((i) => i.kind)).toEqual(["reveal", "remove", "unpublish"]);
    expect(items[2].separatorBefore).toBe(false);
  });

  it("不是作者:没有这一项", () => {
    const items = buildRowMenuItems(skill({ relation: "installed", section: "installedFrom" }), { kind: "none" }, false, false);
    expect(items.map((i) => i.kind)).not.toContain("unpublish");
  });

  it("没有写权限:不摆(终审 M-3)", () => {
    const items = buildRowMenuItems(skill({}), { kind: "none" }, false, false, true);
    expect(items.map((i) => i.kind)).not.toContain("unpublish");
  });

  it("作者但本机没有本体:只剩这一项,没有分隔线", () => {
    const items = buildRowMenuItems(skill({ body: "", localPresent: false }), { kind: "pull" }, false, false);
    expect(items).toEqual([
      { kind: "unpublish", labelKey: "mine.unpublish", titleKey: "mine.unpublishHint", separatorBefore: false },
    ]);
  });
});

describe("删除流程与确认弹窗", () => {
  it("预览轮不带凭据;清单、同事不受影响、可找回都说出来;勾选默认不勾", async () => {
    answer([preview()]);
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    expect(screen.getByText("从技能库删除「周报生成」")).toBeInTheDocument();
    expect(screen.getByTestId("unpublish-files")).toHaveTextContent("SKILL.mdref.md");
    expect(screen.getByText(t("unpublish.othersUnaffected"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("unpublish.history") })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: new RegExp(t("unpublish.alsoTrashLocal")) })).not.toBeChecked();
    expect(calls()).toEqual([{ dirSlug: "weekly-report", registryId: "company", repo: "skills/skills" }]);
    // 默认焦点在「先不动」:回车不会删
    expect(screen.getByRole("button", { name: t("unpublish.cancel") })).toHaveFocus();
  });

  it("确认轮带回同一个 remoteRev 与勾选;成功后在弹窗里说清本机那份怎样了", async () => {
    answer([preview(), { outcome: "unpublished", commitSha: "x", local: { kind: "trashed" } }]);
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    expect(await screen.findByText("已从技能库删除「周报生成」")).toBeInTheDocument();
    expect(screen.getByText(t("unpublish.localTrashed"))).toBeInTheDocument();
    expect(calls()[1]).toEqual({
      dirSlug: "weekly-report",
      registryId: "company",
      repo: "skills/skills",
      confirmRev: "rev-1",
      alsoTrashLocal: true,
    });
    // 删完要重读,行才会换区
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("installed_list", undefined));
  });

  it("库删成功、本机那份没能移走:如实分开说,不当成整体失败", async () => {
    answer([
      preview(),
      { outcome: "unpublished", commitSha: "x", local: { kind: "failed", error: { code: "FS_NOT_INSTALLED", message: "这个技能没有安装记录" } } },
    ]);
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    expect(await screen.findByText("已从技能库删除「周报生成」")).toBeInTheDocument();
    expect(screen.getByText(/没能移到废纸篓.*没有安装记录/)).toBeInTheDocument();
  });

  it("快照过期:不删,换上新清单并说明原因", async () => {
    answer([preview(), preview({ files: ["SKILL.md", "ref.md", "new.md"], remoteRev: "rev-2", stale: true })]);
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    expect(await screen.findByText(t("unpublish.stale"))).toBeInTheDocument();
    expect(screen.getByTestId("unpublish-files")).toHaveTextContent("new.md");
    // 再点一次,带的是新凭据
    answer([{ outcome: "unpublished", commitSha: "x", local: { kind: "untouched" } }]);
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    expect(await screen.findByText(t("unpublish.localKept"))).toBeInTheDocument();
    const all = calls();
    expect(all[all.length - 1]).toMatchObject({ confirmRev: "rev-2" });
  });

  it("被拒(不是作者、无写权限……)在弹窗里说出来", async () => {
    answer([{ code: "REPO_NOT_AUTHOR", message: "这个技能是 李四 分享的,只有作者本人能从技能库里删除它" }]);
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    expect(await screen.findByText(/只有作者本人能从技能库里删除它/)).toBeInTheDocument();
  });

  it("本机没有这一份时不摆勾选,也不会把 alsoTrashLocal 发出去", async () => {
    answer([preview(), { outcome: "unpublished", commitSha: "x", local: { kind: "untouched" } }]);
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin({ ...TARGET, localPresent: false }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    useUnpublish.getState().setAlsoTrashLocal(true); // 哪怕状态里被置上
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    await screen.findByText("已从技能库删除「周报生成」");
    expect(calls()[1]).toMatchObject({ alsoTrashLocal: false });
  });

  it("打开历史页失败要说出来", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_unpublish") return preview();
      if (cmd === "open_library_url") throw { code: "REPO_UNTRUSTED_URL", message: "这个链接不属于任何已配置的技能库" };
      return null;
    });
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.history") }));
    expect(await screen.findByText(/不属于任何已配置的技能库/)).toBeInTheDocument();
  });

  it("unpublishTargetOf 取这一行的记账来源", () => {
    expect(
      unpublishTargetOf({ dirSlug: "a", registryId: "company", sourceOwner: "skills", sourceRepo: "skills", localPresent: false }, "甲"),
    ).toEqual({ dirSlug: "a", displayName: "甲", registryId: "company", repo: "skills/skills", localPresent: false });
  });
});

describe("删除之后的重读顺序与收尾(终审 I-1 / M-5 / M-6)", () => {
  it("先刷**被删的那个库**的索引,等它回来再重读「我的技能」", async () => {
    let releaseIndex: (v: unknown) => void = () => {};
    let refreshArgs: unknown = null;
    const seq: (UnpublishOutcome)[] = [preview(), { outcome: "unpublished", commitSha: "x", local: { kind: "untouched" } }];
    invoke.mockImplementation(async (cmd: string, a?: unknown) => {
      if (cmd === "skill_unpublish") return seq.shift();
      if (cmd === "store_index" && JSON.stringify(a).includes('"force":true')) {
        refreshArgs = a;
        return new Promise((r) => (releaseIndex = r));
      }
      return cmd === "installed_list" ? [] : null;
    });
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin({ ...TARGET, registryId: "custom-1", repo: "team/lib" }));
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    await waitFor(() => expect(refreshArgs).not.toBeNull());
    expect(JSON.stringify(refreshArgs)).toContain("custom-1");
    expect(JSON.stringify(refreshArgs)).toContain("team/lib");
    await new Promise((r) => setTimeout(r, 20));
    expect(invoke).not.toHaveBeenCalledWith("installed_list", undefined);
    await act(async () => releaseIndex({}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("installed_list", undefined));
  });

  it("删完也给「在技能库里查看历史」", async () => {
    answer([preview(), { outcome: "unpublished", commitSha: "x", local: { kind: "untouched" } }]);
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    await screen.findByText("已从技能库删除「周报生成」");
    expect(screen.getByRole("button", { name: t("unpublish.history") })).toBeInTheDocument();
  });

  it("删除进行中按 Esc:不关弹窗,也不漏到下层", async () => {
    let release: (v: unknown) => void = () => {};
    invoke.mockImplementation(async (cmd: string, a?: unknown) => {
      if (cmd !== "skill_unpublish") return null;
      if ((a as { args: { confirmRev?: string } }).args.confirmRev) return new Promise((r) => (release = r));
      return preview();
    });
    render(<UnpublishDialog />);
    await act(() => useUnpublish.getState().begin(TARGET));
    await userEvent.click(screen.getByRole("button", { name: t("unpublish.confirm") }));
    const below = vi.fn();
    document.addEventListener("keydown", below);
    await userEvent.keyboard("{Escape}");
    document.removeEventListener("keydown", below);
    expect(below).not.toHaveBeenCalled();
    expect(screen.getByText("从技能库删除「周报生成」")).toBeInTheDocument();
    await act(async () => release({ outcome: "unpublished", commitSha: "x", local: { kind: "untouched" } }));
  });
});

