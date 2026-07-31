import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStoreIndex } from "./store-index";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function indexOf(registryId: string) {
  return {
    registryId,
    owner: "skills",
    repo: "skills",
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
      args: { dirSlug: "x", registryId: "custom-1" },
    });
  });
});
