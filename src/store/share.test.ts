import { beforeEach, describe, expect, it, vi } from "vitest";

import { useShare } from "./share";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/**
 * 这个 store 在 v6 二期任务 7 收缩到只剩「目标库 + 路径预告」两件事
 * (候选扫描、名称/描述表单、提交编排全部搬走或撤销,见模块头)。
 * 所以这份测试也只剩这两件事的用例。
 */
function reset() {
  invoke.mockReset();
  useShare.setState({ targetRepo: null, preview: "unknown", previews: {} });
}

beforeEach(reset);

describe("路径预告", () => {
  it("探到什么就显示什么", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "share_preview" ? "reviewInRepo" : undefined,
    );
    await useShare.getState().refreshPreview();
    expect(useShare.getState().preview).toBe("reviewInRepo");
  });

  it("探不到不抛错、降级为 unknown —— 预检失败绝不拦分享", async () => {
    // 预告只是提示;提交时刻的权限判定才是权威(M4 任务 2 的既定取舍)。
    // 这里若把错误抛出去,确认屏就会因为一个"提示"而打不开。
    useShare.setState({ preview: "directPush" });
    invoke.mockImplementation(async () => {
      throw { code: "NET_TIMEOUT", message: "连不上" };
    });
    await expect(useShare.getState().refreshPreview()).resolves.toBeUndefined();
    expect(useShare.getState().preview).toBe("unknown");
  });

  it("带上当前目标库;主库(null)时不传 repo", async () => {
    invoke.mockImplementation(async () => "directPush");
    await useShare.getState().refreshPreview();
    expect(invoke).toHaveBeenLastCalledWith("share_preview", { args: {} });

    useShare.setState({ targetRepo: "design/skills" });
    await useShare.getState().refreshPreview();
    expect(invoke).toHaveBeenLastCalledWith("share_preview", {
      args: { repo: "design/skills" },
    });
  });
});

describe("切换目标库", () => {
  it("切库立刻清掉上一个库的预告,再重探", async () => {
    // 挂着旧库的路径却标着新库,等于对用户撒谎——所以是"先清后探",不是"探到再换"。
    useShare.setState({ preview: "directPush" });
    let resolvePreview: (v: string) => void = () => {};
    invoke.mockImplementation(
      () => new Promise<string>((res) => (resolvePreview = res)),
    );

    const pending = useShare.getState().setTargetRepo("design/skills");
    // 还没拿到新结果的这一瞬间,预告必须已经是 unknown 而不是旧库的 directPush
    expect(useShare.getState().preview).toBe("unknown");
    expect(useShare.getState().targetRepo).toBe("design/skills");
    resolvePreview("reviewInRepo");
    await pending;
    expect(useShare.getState().preview).toBe("reviewInRepo");
  });

  it("切到同一个库不重探", async () => {
    useShare.setState({ targetRepo: "design/skills", preview: "directPush" });
    invoke.mockImplementation(async () => "reviewInRepo");
    await useShare.getState().setTargetRepo("design/skills");
    expect(invoke).not.toHaveBeenCalled();
    expect(useShare.getState().preview).toBe("directPush");
  });

  it("迟到的结果不能冒充当前库", async () => {
    // 用户切库比网络快时的真实竞态:第一个库的响应后到,不能盖掉第二个库的状态。
    const resolvers: ((v: string) => void)[] = [];
    invoke.mockImplementation(
      () => new Promise<string>((res) => resolvers.push(res)),
    );

    const first = useShare.getState().setTargetRepo("a/one");
    const second = useShare.getState().setTargetRepo("b/two");
    // 先让"a/one"那一发迟到地成功
    resolvers[0]("directPush");
    resolvers[1]("reviewViaCopy");
    await Promise.all([first, second]);

    expect(useShare.getState().targetRepo).toBe("b/two");
    expect(useShare.getState().preview).toBe("reviewViaCopy");
  });
});

describe("按行探权限(终审 I-4)", () => {

  it("🔴 两行推去两个不同的库 → 各探各的,不共用一份结果", async () => {
    invoke.mockImplementation(async (_cmd: string, payload: Record<string, unknown>) => {
      const args = payload.args as { repo?: string };
      return args.repo === "design/skills" ? "noAccess" : "directPush";
    });

    useShare.getState().ensurePreviewFor(undefined, undefined);
    useShare.getState().ensurePreviewFor("company", "design/skills");
    await vi.waitFor(() => {
      expect(useShare.getState().previewFor("company", "design/skills")).toBe("noAccess");
    });

    // 公司主库那一行仍然能推——拿 design/skills 的结论去禁它就是撒谎
    expect(useShare.getState().previewFor(undefined, undefined)).toBe("directPush");
  });

  it("同一个坐标只探一次(一页十几行不该发十几个一样的请求)", async () => {
    invoke.mockResolvedValue("directPush");
    useShare.getState().ensurePreviewFor("company", "skills/skills");
    useShare.getState().ensurePreviewFor("company", "skills/skills");
    await vi.waitFor(() => {
      expect(useShare.getState().previewFor("company", "skills/skills")).toBe("directPush");
    });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "share_preview")).toHaveLength(1);
  });

  it("探不到就一直是 unknown —— 预检永远 fail-open,不禁任何按钮", async () => {
    invoke.mockRejectedValue({ code: "NET_TIMEOUT", message: "超时" });
    useShare.getState().ensurePreviewFor("company", "skills/skills");
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalled();
    });
    expect(useShare.getState().previewFor("company", "skills/skills")).toBe("unknown");
  });
});
