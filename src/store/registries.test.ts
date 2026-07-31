import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRegistries } from "./registries";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const BUILTIN = {
  id: "company",
  name: "公司技能库",
  kind: "gitea",
  baseUrl: "http://gitea.internal:3000",
  builtin: true,
  repo: { owner: "skills", repo: "skills", branch: "main" },
};

const CUSTOM = {
  id: "custom-1",
  name: "部门工具库",
  kind: "gitea",
  baseUrl: "http://tools.example:8080",
  builtin: false,
  repo: { owner: "ai-skills", repo: "dept-skills", branch: "main" },
};

function reset() {
  invoke.mockReset();
  useRegistries.setState({ list: null, error: null, busy: false, loggedIn: {} });
}

describe("技能库来源 store", () => {
  beforeEach(reset);

  it("load 填充列表,内建源在首位", async () => {
    invoke.mockResolvedValueOnce([BUILTIN, CUSTOM]);
    await useRegistries.getState().load();

    const s = useRegistries.getState();
    expect(s.list).toHaveLength(2);
    expect(s.list?.[0].builtin).toBe(true);
    expect(s.error).toBeNull();
  });

  it("add 成功用后端返回的列表整份替换并返回 true", async () => {
    useRegistries.setState({ list: [BUILTIN] });
    invoke.mockResolvedValueOnce([BUILTIN, CUSTOM]);

    const ok = await useRegistries.getState().add({
      name: "部门工具库",
      kind: "gitea",
      baseUrl: "http://tools.example:8080",
      repoPath: "ai-skills/dept-skills",
    });

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("registry_add", {
      args: {
        name: "部门工具库",
        kind: "gitea",
        baseUrl: "http://tools.example:8080",
        owner: "ai-skills",
        repo: "dept-skills",
      },
    });
    expect(useRegistries.getState().list).toHaveLength(2);
  });

  it("add 把选择的 kind 原样传给后端(GitHub 源,M3 任务 4)", async () => {
    useRegistries.setState({ list: [BUILTIN] });
    invoke.mockResolvedValueOnce([BUILTIN]);

    await useRegistries.getState().add({
      name: "开源技能集",
      kind: "github",
      baseUrl: "https://github.com",
      repoPath: "vercel-labs/skills",
    });

    expect(invoke).toHaveBeenCalledWith("registry_add", {
      args: {
        name: "开源技能集",
        kind: "github",
        baseUrl: "https://github.com",
        owner: "vercel-labs",
        repo: "skills",
      },
    });
  });

  it("add 在本地就拦下没有斜杠的技能库路径,不发 IPC", async () => {
    useRegistries.setState({ list: [BUILTIN] });

    const ok = await useRegistries.getState().add({
      name: "部门工具库",
      kind: "gitea",
      baseUrl: "http://tools.example:8080",
      repoPath: "只有一段",
    });

    expect(ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(useRegistries.getState().error?.message).toBeTruthy();
    expect(useRegistries.getState().list).toHaveLength(1);
  });

  it("add 失败保留原列表并亮出后端错误", async () => {
    useRegistries.setState({ list: [BUILTIN] });
    invoke.mockRejectedValueOnce({
      code: "REPO_INVALID_REGISTRY",
      message: "技能库来源的信息不完整或不合法,请检查后重试",
    });

    const ok = await useRegistries.getState().add({
      name: "x",
      kind: "gitea",
      baseUrl: "not-a-url",
      repoPath: "a/b",
    });

    expect(ok).toBe(false);
    expect(useRegistries.getState().list).toHaveLength(1);
    expect(useRegistries.getState().error?.code).toBe("REPO_INVALID_REGISTRY");
  });

  it("remove 成功替换列表;失败保留并报错", async () => {
    useRegistries.setState({ list: [BUILTIN, CUSTOM] });
    invoke.mockResolvedValueOnce([BUILTIN]);
    await useRegistries.getState().remove("custom-1");
    expect(invoke).toHaveBeenCalledWith("registry_remove", {
      args: { registryId: "custom-1" },
    });
    expect(useRegistries.getState().list).toHaveLength(1);

    invoke.mockRejectedValueOnce({ code: "REPO_BUILTIN_LOCKED", message: "不能移除" });
    await useRegistries.getState().remove("company");
    expect(useRegistries.getState().list).toHaveLength(1);
    expect(useRegistries.getState().error?.code).toBe("REPO_BUILTIN_LOCKED");
  });

  it("tokenLogin 成功记下用户显示名;失败报错且不记", async () => {
    invoke.mockResolvedValueOnce({ login: "wang", displayName: "王工", avatarUrl: "" });
    const ok = await useRegistries.getState().tokenLogin("custom-1", "tok-abc");
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("auth_login_token", {
      args: { registryId: "custom-1", token: "tok-abc" },
    });
    expect(useRegistries.getState().loggedIn["custom-1"]).toBe("王工");

    invoke.mockRejectedValueOnce({ code: "AUTH_INVALID_TOKEN", message: "凭证无效" });
    const bad = await useRegistries.getState().tokenLogin("custom-2", "bad");
    expect(bad).toBe(false);
    expect(useRegistries.getState().loggedIn["custom-2"]).toBeUndefined();
    expect(useRegistries.getState().error?.code).toBe("AUTH_INVALID_TOKEN");
  });
});
