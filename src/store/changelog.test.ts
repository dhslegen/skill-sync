import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChangelog } from "@/store/changelog";
import type { ReleaseNote } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

function note(version: string, theme: string): ReleaseNote {
  return { versions: [version], theme, body: `${version} 的正文` };
}

beforeEach(() => {
  invoke.mockReset();
  useChangelog.setState({ current: "", pending: [], all: [], dismissed: false });
});

describe("更新日志", () => {
  it("core 说有要看的,就摆出来", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "release_notes_state") {
        return { current: "0.5.0", pending: [note("0.5.0", "项目级安装")], all: [note("0.5.0", "项目级安装")] };
      }
      return null;
    });

    await useChangelog.getState().load();

    expect(useChangelog.getState().pending).toHaveLength(1);
    expect(useChangelog.getState().current).toBe("0.5.0");
  });

  it("关掉卡片才写「已看过」—— 显示就写的话,升级后立刻退出的人永远看不到", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "release_notes_state") {
        return { current: "0.5.0", pending: [note("0.5.0", "x")], all: [note("0.5.0", "x")] };
      }
      return null;
    });

    await useChangelog.getState().load();
    // 只是读了一次状态,不能有任何 ack
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "release_notes_ack")).toHaveLength(0);

    await useChangelog.getState().dismiss();

    expect(invoke.mock.calls.filter(([cmd]) => cmd === "release_notes_ack")).toHaveLength(1);
    expect(useChangelog.getState().dismissed).toBe(true);
  });

  it("记账写失败也要把卡片收起来 —— 用户点了关闭,界面就得听话", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "release_notes_ack") throw { code: "STATE_WRITE_FAILED", message: "写不进去" };
      return { current: "0.5.0", pending: [note("0.5.0", "x")], all: [] };
    });

    await useChangelog.getState().load();
    await useChangelog.getState().dismiss();

    // 下次启动会再弹一次(记账没写成),但这一次必须关掉:
    // 点了关闭却纹丝不动,用户只会以为应用卡死了
    expect(useChangelog.getState().dismissed).toBe(true);
  });

  it("IPC 整个失败时安静地当作没有日志,不弹错误框", async () => {
    invoke.mockImplementation(async () => {
      throw { code: "IPC_FAILED", message: "坏了" };
    });

    await useChangelog.getState().load();

    expect(useChangelog.getState().pending).toEqual([]);
    expect(useChangelog.getState().all).toEqual([]);
  });

  it("IPC 给回非数组时不让渲染层在 .length 上崩掉", async () => {
    invoke.mockImplementation(async () => ({ current: "0.5.0", pending: null, all: undefined }));

    await useChangelog.getState().load();

    expect(useChangelog.getState().pending).toEqual([]);
    expect(useChangelog.getState().all).toEqual([]);
  });
});
