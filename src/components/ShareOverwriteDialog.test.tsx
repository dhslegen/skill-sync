import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareOverwriteDialog } from "./ShareOverwriteDialog";
import { useOverwrite } from "@/store/overwrite";
import { useMySkills } from "@/store/my-skills";
import type { InstalledSkillView } from "@/lib/ipc";
import { t } from "@/i18n";
import { planOf } from "@/test/share-plan";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  invoke.mockReset();
  useOverwrite.setState({ pending: null, busy: false, round: 0 });
}

const ask = (over: Partial<{ lastAuthor: string | null; lastAt: string | null; historyUrl: string | null }> = {}, confirm = vi.fn(async () => {})) => {
  useOverwrite.getState().ask({
    dirSlug: "weekly-report",
    name: "weekly-report",
    localTarget: { dirSlug: "weekly-report" },
    plan: planOf({ modified: ["SKILL.md"] }),
    warning: {
      lastAuthor: "李四",
      lastAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      historyUrl: "http://g/skills/skills/commits/branch/main/skills/weekly-report",
      ...over,
    },
    stale: false,
    staleReason: null,
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
      localTarget: { dirSlug: "weekly-report" },
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
      localTarget: { dirSlug: "weekly-report" },
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
      localTarget: { dirSlug: "weekly-report" },
      plan: planOf({ deleted: ["旧的.md"] }),
      warning: null,
      stale: false,
      staleReason: null,
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

describe("🔴 v8 任务 10 / Q16:这一屏的清单同样能就地展开", () => {
  beforeEach(reset);

  // 🔴 定向复审 I-1:这条原先断言的是"按 `{ dirSlug }` 读",把一个已经不成立的前提
  // ("这一屏的发起方都走 `skill_share_changes`")钉成了正确答案。判据改成
  // **读盘目标就是发起方给的那一个**——fixture 刻意给 `path`,与 `dirSlug` 不同值,
  // 退回写死 `{ dirSlug }` 的实现会红在下面的 `toHaveBeenCalledWith`。
  it("新增文件按需读本地盘,读哪个目录由发起方给的 localTarget 决定;修改的文件展开是差异", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "skill_local_file_read" ? { kind: "text", text: "新写的正文" } : null,
    );
    useOverwrite.getState().ask({
      dirSlug: "weekly-report",
      name: "周报生成",
      localTarget: { path: "/h/.claude/skills/weekly-report" },
      plan: {
        added: [{ path: "新写的.txt", body: { kind: "text" } }],
        modified: [
          {
            path: "SKILL.md",
            diff: {
              kind: "hunks",
              hiddenHunks: 0,
              hunks: [
                {
                  oldStart: 3,
                  oldLines: 1,
                  newStart: 3,
                  newLines: 1,
                  lines: [
                    { op: "delete", text: "同事写的那句" },
                    { op: "insert", text: "我改的那句" },
                  ],
                },
              ],
            },
          },
        ],
        deleted: [],
      },
      warning: null,
      stale: false,
      staleReason: null,
      confirm: vi.fn(async () => {}),
    });
    render(<ShareOverwriteDialog />);

    await userEvent.click(screen.getByRole("button", { name: /SKILL\.md/ }));
    expect(screen.getByText("我改的那句")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /新写的\.txt/ }));
    expect(await screen.findByText("新写的正文")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("skill_local_file_read", {
      args: { path: "/h/.claude/skills/weekly-report", file: "新写的.txt" },
    });
  });
});

describe("🔴 定向复审 I-1:无安装基线的「分享改动」,确认屏读的是 core 算清单时的那个本体", () => {
  beforeEach(reset);

  // 旗舰场景:作者在 `~/.claude/skills/my-notes` 开发,没有记账,canonical 下也没有
  // 指向它的链接。core 这一支走 `share()`(`converge::locate` 扫描定位),而按
  // `dirSlug` 解析(`converge::home_of`)只会给出 canonical 下一个不存在的路径。
  // 桩如实模拟这一点:按 `path` 读得到,按 `dirSlug` 读报「不是技能」。
  const BODY = "/h/.claude/skills/my-notes";
  const row = (over: Partial<InstalledSkillView> = {}): InstalledSkillView => ({
    dirSlug: "my-notes",
    commitSha: "",
    contentHash: "",
    agents: ["claude-code"],
    installedAt: "",
    updatedAt: "",
    localModified: false,
    sourceOwner: "skills",
    sourceRepo: "skills",
    registryId: "company",
    sourceRemoved: false,
    libraryRemoved: false,
    relation: "shared",
    localPresent: true,
    sourceLabel: "skills/skills",
    body: BODY,
    localHash: "sha256:local",
    tools: [],
    versions: [],
    shareBlocked: null,
    section: "sharedTo",
    libraryUrl: null,
    canonicalReaders: null,
    ...over,
  });

  const needsConfirm = {
    plan: planOf({ added: ["新写的.md"] }),
    overwrite: null,
    remoteRev: "sha256:seen",
    planRev: "sha256:plan",
    stale: false,
    staleReason: null,
  };

  function mockCore() {
    invoke.mockImplementation(async (cmd: string, payload: { args: Record<string, unknown> }) => {
      if (cmd === "skill_share") return { outcome: "needsConfirm", ...needsConfirm };
      if (cmd === "skill_share_changes") return { kind: "needsConfirm", ...needsConfirm };
      if (cmd === "skill_local_file_read") {
        if (payload.args.path === BODY) return { kind: "text", text: "本体里新写的正文" };
        throw { code: "FS_NOT_A_SKILL", message: "这个文件夹不是技能" };
      }
      return null;
    });
  }

  it("点开新增文件读得到内容(读的是那一行的本体,不是按文件夹名去 canonical 找)", async () => {
    mockCore();
    useMySkills.setState({ list: [row()] });

    await useMySkills.getState().shareChanges("my-notes");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share")).toBe(true);
    render(<ShareOverwriteDialog />);

    await userEvent.click(screen.getByRole("button", { name: /新写的\.md/ }));
    expect(await screen.findByText("本体里新写的正文")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("skill_local_file_read", {
      args: { path: BODY, file: "新写的.md" },
    });
  });

  it("对照:有安装基线的一支走 `share_installed`,读盘仍按文件夹名(与 core 的 `home_of` 同一个解析)", async () => {
    mockCore();
    useMySkills.setState({ list: [row({ contentHash: "sha256:base" })] });

    await useMySkills.getState().shareChanges("my-notes");

    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share_changes")).toBe(true);
    expect(useOverwrite.getState().pending?.localTarget).toEqual({ dirSlug: "my-notes" });
  });
});
