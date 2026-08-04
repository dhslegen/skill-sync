import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFormComplete, useCreate } from "./create";
import { useShare } from "./share";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const FORM = { dirSlug: "weekly-report", displayName: "周报生成", description: "每周汇总" };

function reset() {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "skill_create") return { dirSlug: "weekly-report", path: "/home/u/.agents/skills/weekly-report" };
    if (cmd === "share_candidates") return [];
    return null;
  });
  useCreate.setState({
    phase: "closed",
    form: { dirSlug: "", displayName: "", description: "" },
    error: null,
    createdPath: null,
  });
  useShare.setState({ candidates: null });
}

beforeEach(reset);

describe("表单完整性", () => {
  it("三项齐备才可提交", () => {
    expect(createFormComplete(FORM)).toBe(true);
    expect(createFormComplete({ ...FORM, displayName: "  " })).toBe(false);
    expect(createFormComplete({ ...FORM, description: "" })).toBe(false);
  });

  it("文件夹名走与 core 同一把尺子:会被静默改名的一律不放行", () => {
    // 这三个旧正则都放行,而 core 会把它们清洗成别的名字
    expect(createFormComplete({ ...FORM, dirSlug: "a--b" })).toBe(false);
    expect(createFormComplete({ ...FORM, dirSlug: "trail-" })).toBe(false);
    expect(createFormComplete({ ...FORM, dirSlug: "周报" })).toBe(false);
  });
});

describe("创建流程", () => {
  it("成功后进完成档,带回路径,并刷新分享候选", async () => {
    useCreate.setState({ phase: "form", form: FORM });
    await useCreate.getState().submit();

    const s = useCreate.getState();
    expect(s.phase).toBe("done");
    expect(s.createdPath).toBe("/home/u/.agents/skills/weekly-report");
    expect(s.error).toBeNull();
    // 不刷新的话用户看不到自己刚建的东西
    expect(invoke.mock.calls.map((c) => c[0])).toContain("share_candidates");
  });

  it("传给 core 的是表单原值,不做前端加工", async () => {
    useCreate.setState({ phase: "form", form: FORM });
    await useCreate.getState().submit();

    const call = invoke.mock.calls.find((c) => c[0] === "skill_create");
    expect(call?.[1]).toEqual({
      args: { dirSlug: "weekly-report", displayName: "周报生成", description: "每周汇总" },
    });
  });

  it("失败时留在表单档并保住已填内容——撞名改个名字就能重来", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_create") {
        throw { code: "CONFLICT_NAME_TAKEN", message: "本地已经有同名的技能文件夹了,换一个名字吧" };
      }
      return null;
    });
    useCreate.setState({ phase: "form", form: FORM });
    await useCreate.getState().submit();

    const s = useCreate.getState();
    expect(s.phase).toBe("form");
    expect(s.error?.code).toBe("CONFLICT_NAME_TAKEN");
    expect(s.form).toEqual(FORM);
    expect(s.createdPath).toBeNull();
  });

  it("表单不完整时压根不发请求", async () => {
    useCreate.setState({ phase: "form", form: { ...FORM, dirSlug: "a--b" } });
    await useCreate.getState().submit();

    expect(invoke.mock.calls.some((c) => c[0] === "skill_create")).toBe(false);
    expect(useCreate.getState().phase).toBe("form");
  });

  it("关闭会清空表单,下次打开不留上一次的残影", () => {
    useCreate.setState({ phase: "done", form: FORM, createdPath: "/x" });
    useCreate.getState().close();

    expect(useCreate.getState()).toMatchObject({
      phase: "closed",
      form: { dirSlug: "", displayName: "", description: "" },
      createdPath: null,
    });
  });

  it("在文件管理器中打开:用创建后拿到的路径,没有路径就不发请求", async () => {
    await useCreate.getState().reveal();
    expect(invoke.mock.calls.some((c) => c[0] === "skill_reveal")).toBe(false);

    useCreate.setState({ createdPath: "/home/u/.agents/skills/weekly-report" });
    await useCreate.getState().reveal();
    const call = invoke.mock.calls.find((c) => c[0] === "skill_reveal");
    expect(call?.[1]).toEqual({ args: { path: "/home/u/.agents/skills/weekly-report" } });
  });
});
