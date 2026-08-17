import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { locatePlazaSkill, usePlaza } from "./plaza";
import type { SkillDetail } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  invoke.mockReset();
  usePlaza.setState({
    query: "",
    results: [],
    status: "idle",
    error: null,
    detailOwnerRepo: null,
    detailWantedName: null,
    detailSlug: null,
    detailSkills: null,
    detailStatus: "idle",
    detailError: null,
    selectedDirSlug: null,
  });
}

const card = (over: Partial<{ name: string; slug: string; ownerRepo: string; installs: number }> = {}) => ({
  name: "React 最佳实践",
  slug: "vercel-labs/skills/react-best-practices",
  ownerRepo: "vercel-labs/skills",
  installs: 625414,
  ...over,
});

describe("usePlaza 搜索(防抖 + 边界)", () => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("去空白后不足 2 字符不发请求", async () => {
    usePlaza.getState().setQuery("a");
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).not.toHaveBeenCalled();
    expect(usePlaza.getState().status).toBe("idle");
    expect(usePlaza.getState().results).toEqual([]);
  });

  it("只有空白字符也不发请求", async () => {
    usePlaza.getState().setQuery("  ");
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("2 字符起会发请求(中文按字符数,不是字节数)", async () => {
    invoke.mockResolvedValueOnce([card()]);
    usePlaza.getState().setQuery("技能");
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).toHaveBeenCalledWith("plaza_search", { query: "技能" });
    expect(usePlaza.getState().results).toEqual([card()]);
    expect(usePlaza.getState().status).toBe("ready");
  });

  it("防抖:250ms 内连续输入只发最后一次请求", async () => {
    invoke.mockResolvedValueOnce([card({ name: "最终结果" })]);
    usePlaza.getState().setQuery("re");
    await vi.advanceTimersByTimeAsync(100);
    usePlaza.getState().setQuery("rea");
    await vi.advanceTimersByTimeAsync(100);
    usePlaza.getState().setQuery("react");
    await vi.advanceTimersByTimeAsync(250);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("plaza_search", { query: "react" });
    expect(usePlaza.getState().results[0].name).toBe("最终结果");
  });

  it("错误进 error 态,不抛到调用方", async () => {
    invoke.mockRejectedValueOnce({ code: "NET_PLAZA_SEARCH", message: "技能广场搜索失败,请稍后重试" });
    expect(() => usePlaza.getState().setQuery("react")).not.toThrow();
    await vi.advanceTimersByTimeAsync(300);

    const s = usePlaza.getState();
    expect(s.status).toBe("error");
    expect(s.error?.code).toBe("NET_PLAZA_SEARCH");
    expect(s.results).toEqual([]);
  });

  it("非 AppError 异常也被规整,不裸抛出去", async () => {
    invoke.mockRejectedValueOnce(new Error("network down"));
    usePlaza.getState().setQuery("react");
    await vi.advanceTimersByTimeAsync(300);
    expect(usePlaza.getState().status).toBe("error");
    expect(usePlaza.getState().error?.code).toBe("IPC_FAILED");
  });

  it("请求还在飞时把查询删回短查询:迟到的响应不能把已清空的结果救回来", async () => {
    let resolveSlow!: (v: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );
    usePlaza.getState().setQuery("re");
    await vi.advanceTimersByTimeAsync(250); // 触发那次搜索,请求"挂起"

    usePlaza.getState().setQuery("r"); // 删回 1 个字符:不足 2,立即清空
    expect(usePlaza.getState().results).toEqual([]);
    expect(usePlaza.getState().status).toBe("idle");

    resolveSlow([card()]); // 迟到的响应落地
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    // 不能被旧响应覆盖回去
    expect(usePlaza.getState().results).toEqual([]);
    expect(usePlaza.getState().status).toBe("idle");
  });
});

describe("usePlaza 详情", () => {
  const skillOf = (over: Partial<SkillDetail> = {}): SkillDetail => ({
    name: "React 最佳实践",
    dirSlug: "react-best-practices",
    description: "",
    path: "react-best-practices",
    skillMd: "---\nname: React 最佳实践\n---\n\n正文\n",
    files: [],
    hasScripts: false,
    commitSha: "abc1234",
    committedAt: "2026-08-01T00:00:00Z",
    tags: [],
    attribution: null,
    ...over,
  });

  beforeEach(reset);

  it("openDetail 拉该仓全部技能,且把 slug/name 原样带给 core(M10 任务 2 的 blob 快路径参数)", async () => {
    invoke.mockResolvedValueOnce([skillOf()]);
    await usePlaza.getState().openDetail("vercel-labs/skills", "React 最佳实践", "vercel-labs/skills/react-best-practices");

    expect(invoke).toHaveBeenCalledWith("plaza_detail", {
      args: {
        ownerRepo: "vercel-labs/skills",
        skillId: "vercel-labs/skills/react-best-practices",
        wantedName: "React 最佳实践",
      },
    });
    const s = usePlaza.getState();
    expect(s.detailStatus).toBe("ready");
    expect(s.detailSkills).toEqual([skillOf()]);
  });

  it("失败进入错误态,并保留可重试的坐标", async () => {
    invoke.mockRejectedValueOnce({ code: "NET_PLAZA_DETAIL", message: "无法获取详情" });
    await usePlaza.getState().openDetail("vercel-labs/skills", "React 最佳实践", "slug");

    const s = usePlaza.getState();
    expect(s.detailStatus).toBe("error");
    expect(s.detailError?.code).toBe("NET_PLAZA_DETAIL");
  });

  it("retryDetail 真的重新发起请求,而不是复用失败的结果", async () => {
    invoke.mockRejectedValueOnce({ code: "NET_PLAZA_DETAIL", message: "无法获取详情" });
    await usePlaza.getState().openDetail("vercel-labs/skills", "React 最佳实践", "slug");
    expect(usePlaza.getState().detailStatus).toBe("error");

    invoke.mockResolvedValueOnce([skillOf()]);
    await usePlaza.getState().retryDetail();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(usePlaza.getState().detailStatus).toBe("ready");
    expect(usePlaza.getState().detailSkills).toEqual([skillOf()]);
  });

  it("closeDetail 清空全部详情状态", async () => {
    invoke.mockResolvedValueOnce([skillOf()]);
    await usePlaza.getState().openDetail("vercel-labs/skills", "React 最佳实践", "slug");
    usePlaza.getState().closeDetail();

    const s = usePlaza.getState();
    expect(s.detailOwnerRepo).toBeNull();
    expect(s.detailSkills).toBeNull();
    expect(s.detailStatus).toBe("idle");
  });

  it("等待期间关闭面板:迟到的结果不再写回去", async () => {
    let resolveSlow!: (v: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    );
    const pending = usePlaza.getState().openDetail("vercel-labs/skills", "x", "slug");
    usePlaza.getState().closeDetail();
    resolveSlow([skillOf()]);
    await pending;

    expect(usePlaza.getState().detailOwnerRepo).toBeNull();
    expect(usePlaza.getState().detailSkills).toBeNull();
  });
});

describe("locatePlazaSkill", () => {
  const a: SkillDetail = {
    name: "周报生成",
    dirSlug: "weekly-report",
    description: "",
    path: "",
    skillMd: "",
    files: [],
    hasScripts: false,
    commitSha: "",
    committedAt: "",
    tags: [],
    attribution: null,
  };
  const b: SkillDetail = { ...a, name: "合同审查", dirSlug: "contract-review" };

  it("按搜索结果的 name 对 frontmatter name 定位", () => {
    expect(locatePlazaSkill([a, b], "合同审查", null)).toBe(b);
  });

  it("名字对不上时返回 null,交给调用方落到列表", () => {
    expect(locatePlazaSkill([a, b], "不存在的名字", null)).toBeNull();
  });

  it("用户已经手选过时,选择优先于名字匹配", () => {
    expect(locatePlazaSkill([a, b], "周报生成", "contract-review")).toBe(b);
  });

  it("手选的 dirSlug 在列表里找不到时,退回按名字匹配", () => {
    expect(locatePlazaSkill([a, b], "周报生成", "not-in-list")).toBe(a);
  });
});
