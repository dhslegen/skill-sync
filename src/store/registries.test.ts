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
  repos: [
    {
      key: "skills/skills",
      owner: "skills",
      repo: "skills",
      branch: "main",
      name: null,
      primary: true,
      locked: true,
    },
  ],
};

const CUSTOM = {
  id: "custom-1",
  name: "部门工具库",
  kind: "gitea",
  baseUrl: "http://tools.example:8080",
  builtin: false,
  repo: { owner: "ai-skills", repo: "dept-skills", branch: "main" },
  repos: [
    {
      key: "ai-skills/dept-skills",
      owner: "ai-skills",
      repo: "dept-skills",
      branch: "main",
      name: null,
      primary: true,
      locked: false,
    },
  ],
};

function reset() {
  invoke.mockReset();
  useRegistries.setState({
    list: null,
    error: null,
    busy: false,
    loggedIn: {},
    devicePrompt: null,
  });
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

  // ---- 一源多仓(M4 任务 1)----

  it("addRepo 拆开「所属者/名称」并整份替换列表", async () => {
    useRegistries.setState({ list: [BUILTIN] });
    invoke.mockResolvedValueOnce([BUILTIN, CUSTOM]);

    const ok = await useRegistries
      .getState()
      .addRepo("company", { repoPath: "design/design-skills", name: "  设计部技能库  " });

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("registry_add_repo", {
      args: {
        registryId: "company",
        owner: "design",
        repo: "design-skills",
        // 展示名去空白后传;这里正面断言值,不只断言"字段在"
        name: "设计部技能库",
      },
    });
    expect(useRegistries.getState().list).toHaveLength(2);
  });

  it("addRepo 的展示名留空时整个字段不发,由后端落 None", async () => {
    useRegistries.setState({ list: [BUILTIN] });
    invoke.mockResolvedValueOnce([BUILTIN]);

    await useRegistries.getState().addRepo("company", { repoPath: "qa/qa-skills", name: "   " });

    expect(invoke).toHaveBeenCalledWith("registry_add_repo", {
      args: { registryId: "company", owner: "qa", repo: "qa-skills" },
    });
  });

  it("addRepo 在本地拦下没有斜杠的路径,不发 IPC", async () => {
    useRegistries.setState({ list: [BUILTIN] });

    const ok = await useRegistries.getState().addRepo("company", { repoPath: "只有一段", name: "" });

    expect(ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(useRegistries.getState().error?.message).toBeTruthy();
  });

  it("removeRepo 成功替换列表;失败(锁定的主库)保留并报错", async () => {
    useRegistries.setState({ list: [BUILTIN, CUSTOM] });
    invoke.mockResolvedValueOnce([BUILTIN]);
    await useRegistries.getState().removeRepo("company", "design/design-skills");
    expect(invoke).toHaveBeenCalledWith("registry_remove_repo", {
      args: { registryId: "company", repo: "design/design-skills" },
    });
    expect(useRegistries.getState().list).toHaveLength(1);

    invoke.mockRejectedValueOnce({
      code: "REPO_BUILTIN_LOCKED",
      message: "公司主技能库是内建的,不能移除",
    });
    await useRegistries.getState().removeRepo("company", "skills/skills");
    expect(useRegistries.getState().list).toHaveLength(1);
    expect(useRegistries.getState().error?.code).toBe("REPO_BUILTIN_LOCKED");
  });

  it("deviceLogin:先亮用户码,授权完成后记录用户并收起提示", async () => {
    let resolveWait!: (v: unknown) => void;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "auth_device_start")
        return {
          deviceCode: "dev-123",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresIn: 900,
          interval: 5,
        };
      if (cmd === "auth_device_wait")
        return new Promise((resolve) => {
          resolveWait = resolve;
        });
      throw new Error(`unexpected ${cmd}`);
    });

    const done = useRegistries.getState().deviceLogin("custom-2");
    await vi.waitFor(() => {
      expect(useRegistries.getState().devicePrompt?.userCode).toBe("ABCD-1234");
    });
    // 等待期间把设备码原样带给 wait,轮询参数一个不丢
    expect(invoke).toHaveBeenCalledWith("auth_device_wait", {
      args: { registryId: "custom-2", deviceCode: "dev-123", expiresIn: 900, interval: 5 },
    });

    resolveWait({ login: "wang", displayName: "王工", avatarUrl: "" });
    await done;
    const s = useRegistries.getState();
    expect(s.loggedIn["custom-2"]).toBe("王工");
    expect(s.devicePrompt).toBeNull();
  });

  it("deviceLogin 失败(拒绝/过期)清掉提示并亮错误", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "auth_device_start")
        return {
          deviceCode: "dev-123",
          userCode: "ABCD-1234",
          verificationUri: "u",
          expiresIn: 900,
          interval: 5,
        };
      throw { code: "AUTH_DEVICE_DENIED", message: "你在授权页取消了这次登录" };
    });

    await useRegistries.getState().deviceLogin("custom-2");
    const s = useRegistries.getState();
    expect(s.devicePrompt).toBeNull();
    expect(s.error?.code).toBe("AUTH_DEVICE_DENIED");
    expect(s.loggedIn["custom-2"]).toBeUndefined();
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
