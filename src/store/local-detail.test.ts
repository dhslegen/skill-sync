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
  useLocalDetail.setState({ target: null, detail: null, error: null });
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

  it("🔴 换电脑后本地没有本体的行:从技能库索引取内容,不去读一个不存在的本地文件夹(2026-09-14 真机)", async () => {
    // 「已分享到技能库」里本地没有本体的行,body 为空。此前按 dirSlug 去读 canonical/<slug>,
    // 那个文件夹根本不存在,面板只剩一句「这个文件夹不是技能」——整个面板空白、连「取回」都没有。
    invoke.mockResolvedValue({
      ...detail,
      path: "skills/weekly-report",
      commitSha: "c",
      committedAt: "2026-09-01T00:00:00Z",
      tags: [],
      attribution: null,
    });
    await useLocalDetail.getState().openFromLibrary({ dirSlug: "weekly-report", registryId: "company", repo: "skills/skills" });
    expect(invoke).toHaveBeenCalledWith("store_skill_detail", {
      args: { dirSlug: "weekly-report", registryId: "company", repo: "skills/skills" },
    });
    expect(invoke).not.toHaveBeenCalledWith("skill_local_detail", expect.anything());
    const got = useLocalDetail.getState().detail;
    expect(got?.skillMd).toBe(detail.skillMd);
    expect(got?.dirSlug).toBe("weekly-report");
    expect(useLocalDetail.getState().target).not.toBeNull(); // 面板是开着的
  });

  it("从库里取失败时错误同样留在面板上;迟到的结果不顶回已关掉的面板", async () => {
    invoke.mockRejectedValue({ code: "REPO_NOT_FOUND", message: "技能库里找不到这个技能" });
    await useLocalDetail.getState().openFromLibrary({ dirSlug: "x", registryId: "company", repo: "skills/skills" });
    expect(useLocalDetail.getState().error?.code).toBe("REPO_NOT_FOUND");

    let resolve!: (v: unknown) => void;
    invoke.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useLocalDetail.getState().openFromLibrary({ dirSlug: "x", registryId: "company", repo: "skills/skills" });
    useLocalDetail.getState().close();
    resolve({ ...detail, commitSha: "c", committedAt: "", tags: [], attribution: null });
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
    });
  });

});
