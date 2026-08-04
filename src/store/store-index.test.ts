import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStoreIndex } from "./store-index";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function indexOf(registryId: string, repo = "skills") {
  return {
    registryId,
    owner: "skills",
    repo,
    branch: "main",
    commitSha: "aaa1111",
    committedAt: "2026-07-30T00:00:00Z",
    fetchedAt: 1753900000,
    skills: [],
    skipped: [],
    fromCache: false,
    offline: false,
    curated: [],
  };
}

function reset() {
  invoke.mockReset();
  useStoreIndex.setState({
    status: "idle",
    index: null,
    error: null,
    query: "q",
    filter: "installed",
    activeRegistry: "company",
    activeRepo: null,
    detailSlug: null,
    detail: null,
    detailError: null,
  });
}

describe("商店索引的多源切换", () => {
  beforeEach(reset);

  it("load 带上当前源的 id", async () => {
    invoke.mockResolvedValueOnce(indexOf("company"));
    await useStoreIndex.getState().load();
    expect(invoke).toHaveBeenCalledWith("store_index", {
      args: { force: false, registryId: "company" },
    });
    expect(useStoreIndex.getState().index?.registryId).toBe("company");
  });

  it("setRegistry 切源:立即重新加载并整份替换索引", async () => {
    useStoreIndex.setState({ index: indexOf("company"), status: "ready" });
    invoke.mockResolvedValueOnce(indexOf("custom-1"));

    await useStoreIndex.getState().setRegistry("custom-1");

    expect(invoke).toHaveBeenCalledWith("store_index", {
      args: { force: false, registryId: "custom-1" },
    });
    const s = useStoreIndex.getState();
    expect(s.activeRegistry).toBe("custom-1");
    expect(s.index?.registryId).toBe("custom-1");
  });

  it("切源失败:亮错误,不把上一个源的索引冒充当前源", async () => {
    useStoreIndex.setState({ index: indexOf("company"), status: "ready" });
    invoke.mockRejectedValueOnce({ code: "NET_UNREACHABLE", message: "连不上" });

    await useStoreIndex.getState().setRegistry("custom-1");

    const s = useStoreIndex.getState();
    expect(s.status).toBe("error");
    expect(s.index).toBeNull();
    expect(s.error?.code).toBe("NET_UNREACHABLE");
  });

  it("openDetail 带上当前源的 id", async () => {
    useStoreIndex.setState({ activeRegistry: "custom-1" });
    invoke.mockResolvedValueOnce({ name: "x", dirSlug: "x" });
    await useStoreIndex.getState().openDetail("x");
    expect(invoke).toHaveBeenCalledWith("store_skill_detail", {
      args: { dirSlug: "x", registryId: "custom-1", repo: undefined },
    });
  });

  // ---- 一源多仓(M4 任务 1)----

  it("切到同源的另一个技能库:带上仓库键并整份替换索引", async () => {
    useStoreIndex.setState({ index: indexOf("company"), status: "ready" });
    invoke.mockResolvedValueOnce(indexOf("company", "design-skills"));

    await useStoreIndex.getState().setRegistry("company", "design/design-skills");

    expect(invoke).toHaveBeenCalledWith("store_index", {
      args: { force: false, registryId: "company", repo: "design/design-skills" },
    });
    const s = useStoreIndex.getState();
    expect(s.activeRegistry).toBe("company");
    expect(s.activeRepo).toBe("design/design-skills");
    expect(s.index?.repo).toBe("design-skills");
  });

  it("切回主库:repo 归 null,请求不带仓库键(缺省即主库)", async () => {
    useStoreIndex.setState({
      index: indexOf("company", "design-skills"),
      activeRepo: "design/design-skills",
      status: "ready",
    });
    invoke.mockResolvedValueOnce(indexOf("company"));

    await useStoreIndex.getState().setRegistry("company", null);

    expect(invoke).toHaveBeenCalledWith("store_index", {
      args: { force: false, registryId: "company", repo: undefined },
    });
    expect(useStoreIndex.getState().activeRepo).toBeNull();
  });

  it("同源同仓再点一次不重复请求;同源换仓要请求", async () => {
    useStoreIndex.setState({ index: indexOf("company"), status: "ready" });
    await useStoreIndex.getState().setRegistry("company", null);
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce(indexOf("company", "design-skills"));
    await useStoreIndex.getState().setRegistry("company", "design/design-skills");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("等待期间换了仓:迟到的结果不写进来冒充当前仓", async () => {
    let resolveSlow!: (v: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );
    const slow = useStoreIndex.getState().load();

    // 主库还在飞,用户切到了追加库
    invoke.mockResolvedValueOnce(indexOf("company", "design-skills"));
    await useStoreIndex.getState().setRegistry("company", "design/design-skills");

    resolveSlow(indexOf("company"));
    await slow;

    // 主库的结果必须被丢弃,否则界面上标着"设计部技能库"却列着主库的技能
    expect(useStoreIndex.getState().index?.repo).toBe("design-skills");
  });

  it("openDetail 带上当前仓库键", async () => {
    useStoreIndex.setState({ activeRegistry: "company", activeRepo: "design/design-skills" });
    invoke.mockResolvedValueOnce({ name: "x", dirSlug: "x" });
    await useStoreIndex.getState().openDetail("x");
    expect(invoke).toHaveBeenCalledWith("store_skill_detail", {
      args: { dirSlug: "x", registryId: "company", repo: "design/design-skills" },
    });
  });
});
