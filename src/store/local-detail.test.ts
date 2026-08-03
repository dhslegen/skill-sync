import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocalDetail } from "./local-detail";
import type { LocalSkillDetail } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));

const detail: LocalSkillDetail = {
  name: "周报生成",
  dirSlug: "weekly-report",
  description: "汇总本周工作",
  path: "/home/u/.agents/skills/weekly-report",
  skillMd: "---\nname: 周报生成\ndescription: 汇总本周工作\n---\n\n正文\n",
  files: [{ path: "SKILL.md", size: 64 }],
  hasScripts: false,
};

function reset() {
  invoke.mockReset();
  useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
}

describe("local-detail store", () => {
  beforeEach(reset);

  it("open 成功:按 dirSlug 请求并存下详情", async () => {
    invoke.mockResolvedValue(detail);
    await useLocalDetail.getState().open({ dirSlug: "weekly-report" });
    expect(invoke).toHaveBeenCalledWith("skill_local_detail", {
      args: { dirSlug: "weekly-report" },
    });
    expect(useLocalDetail.getState().detail).toEqual(detail);
    expect(useLocalDetail.getState().error).toBeNull();
  });

  it("open 失败:错误可读地留在面板上,不吞", async () => {
    invoke.mockRejectedValue({
      code: "FS_NOT_A_SKILL",
      message: "这个文件夹不是技能,或技能描述文件缺失",
    });
    await useLocalDetail.getState().open({ path: "/tmp/nope" });
    expect(useLocalDetail.getState().detail).toBeNull();
    expect(useLocalDetail.getState().error?.code).toBe("FS_NOT_A_SKILL");
  });

  it("等待期间面板被关掉,迟到的结果不能把面板顶回打开态", async () => {
    let resolve!: (v: LocalSkillDetail) => void;
    invoke.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useLocalDetail.getState().open({ dirSlug: "weekly-report" });
    useLocalDetail.getState().close();
    resolve(detail);
    await pending;
    expect(useLocalDetail.getState().target).toBeNull();
    expect(useLocalDetail.getState().detail).toBeNull();
  });

  it("close 清空全部状态", async () => {
    invoke.mockResolvedValue(detail);
    await useLocalDetail.getState().open({ dirSlug: "weekly-report" });
    useLocalDetail.getState().close();
    expect(useLocalDetail.getState()).toMatchObject({
      target: null,
      detail: null,
      error: null,
      revealError: null,
    });
  });

  it("reveal 用当前 target 调 skill_reveal;失败原样留错", async () => {
    invoke.mockResolvedValue(detail);
    await useLocalDetail.getState().open({ path: "/tmp/skill" });
    invoke.mockRejectedValue({
      code: "FS_REVEAL_FAILED",
      message: "没能在文件管理器中显示这个技能",
    });
    await useLocalDetail.getState().reveal();
    expect(invoke).toHaveBeenLastCalledWith("skill_reveal", { args: { path: "/tmp/skill" } });
    expect(useLocalDetail.getState().revealError?.code).toBe("FS_REVEAL_FAILED");
  });

  it("面板关着时 reveal 是空操作", async () => {
    await useLocalDetail.getState().reveal();
    expect(invoke).not.toHaveBeenCalled();
  });
});
