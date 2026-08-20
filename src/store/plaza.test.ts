import { beforeEach, describe, expect, it, vi } from "vitest";

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
    submittedQuery: "",
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

// 搜索改成**显式触发**(M10 追加,推翻 M9 的"输入即搜 + 250ms 防抖"):
// 输入框的值(`query`)与已提交的查询词(`submittedQuery`)是两个字段,
// 只有 `submitSearch` 会发请求。
describe("usePlaza 搜索(显式触发 + 边界)", () => {
  beforeEach(reset);

  it("🔴 打字不触发搜索:setQuery 连敲五下,一个请求都不发", async () => {
    for (const q of ["r", "re", "rea", "reac", "react"]) usePlaza.getState().setQuery(q);
    await vi.waitFor(() => expect(usePlaza.getState().query).toBe("react"));

    expect(invoke).not.toHaveBeenCalled();
    // 还没提交过:界面据此继续展示热门榜
    expect(usePlaza.getState().submittedQuery).toBe("");
    expect(usePlaza.getState().status).toBe("idle");
  });

  it("submitSearch 才发请求,并把查询词记进 submittedQuery", async () => {
    invoke.mockResolvedValueOnce([card()]);
    usePlaza.getState().setQuery("react");
    usePlaza.getState().submitSearch();

    await vi.waitFor(() => expect(usePlaza.getState().status).toBe("ready"));
    expect(invoke).toHaveBeenCalledWith("plaza_search", { query: "react" });
    expect(usePlaza.getState().results).toEqual([card()]);
    expect(usePlaza.getState().submittedQuery).toBe("react");
  });

  it("submitSearch 带参数(回车那条路)时同时更新输入框的值", async () => {
    invoke.mockResolvedValueOnce([card()]);
    usePlaza.getState().submitSearch("  react  ");

    await vi.waitFor(() => expect(usePlaza.getState().status).toBe("ready"));
    // 请求与记账都用 trim 后的值,输入框保留用户敲的原样
    expect(invoke).toHaveBeenCalledWith("plaza_search", { query: "react" });
    expect(usePlaza.getState().submittedQuery).toBe("react");
    expect(usePlaza.getState().query).toBe("  react  ");
  });

  it("2 字符起才发请求(中文按字符数,不是字节数)", async () => {
    invoke.mockResolvedValueOnce([card()]);
    usePlaza.getState().submitSearch("技能");
    await vi.waitFor(() => expect(usePlaza.getState().status).toBe("ready"));
    expect(invoke).toHaveBeenCalledWith("plaza_search", { query: "技能" });
  });

  it("提交不足 2 字符:不发请求,回到热门榜那一档", async () => {
    usePlaza.getState().submitSearch("a");
    await vi.waitFor(() => expect(usePlaza.getState().query).toBe("a"));
    expect(invoke).not.toHaveBeenCalled();
    expect(usePlaza.getState().submittedQuery).toBe("");
    expect(usePlaza.getState().status).toBe("idle");
  });

  it("提交只有空白的查询词同样不发请求", async () => {
    usePlaza.getState().submitSearch("  ");
    await vi.waitFor(() => expect(usePlaza.getState().query).toBe("  "));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("清空输入框 = 立即回热门榜,不需要再点搜索、也不发请求", async () => {
    invoke.mockResolvedValueOnce([card()]);
    usePlaza.getState().submitSearch("react");
    await vi.waitFor(() => expect(usePlaza.getState().results).toHaveLength(1));

    invoke.mockClear();
    usePlaza.getState().setQuery("");

    expect(usePlaza.getState().submittedQuery).toBe("");
    expect(usePlaza.getState().results).toEqual([]);
    expect(usePlaza.getState().status).toBe("idle");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("假设:删到不足 2 字符但没删空时,上一次的结果留着不闪", async () => {
    invoke.mockResolvedValueOnce([card()]);
    usePlaza.getState().submitSearch("react");
    await vi.waitFor(() => expect(usePlaza.getState().results).toHaveLength(1));

    usePlaza.getState().setQuery("r");

    expect(usePlaza.getState().submittedQuery).toBe("react");
    expect(usePlaza.getState().results).toEqual([card()]);
  });

  it("错误进 error 态,不抛到调用方", async () => {
    invoke.mockRejectedValueOnce({ code: "NET_PLAZA_SEARCH", message: "技能广场搜索失败,请稍后重试" });
    expect(() => usePlaza.getState().submitSearch("react")).not.toThrow();

    await vi.waitFor(() => expect(usePlaza.getState().status).toBe("error"));
    const s = usePlaza.getState();
    expect(s.error?.code).toBe("NET_PLAZA_SEARCH");
    expect(s.results).toEqual([]);
  });

  it("非 AppError 异常也被规整,不裸抛出去", async () => {
    invoke.mockRejectedValueOnce(new Error("network down"));
    usePlaza.getState().submitSearch("react");
    await vi.waitFor(() => expect(usePlaza.getState().status).toBe("error"));
    expect(usePlaza.getState().error?.code).toBe("IPC_FAILED");
  });

  it("🔴 搜索中再搜一次:以新的那次为准,先发的慢响应后到也不采纳", async () => {
    let resolveSlow!: (v: unknown) => void;
    invoke.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSlow = resolve; }),
    );
    usePlaza.getState().submitSearch("react");
    await vi.waitFor(() => expect(usePlaza.getState().status).toBe("loading"));

    // 不等上一次回来,直接再搜一次(界面上就是"搜索按钮没禁用,又点了一下")
    invoke.mockResolvedValueOnce([card({ name: "新的那次" })]);
    usePlaza.getState().submitSearch("vue");
    await vi.waitFor(() => expect(usePlaza.getState().results).toHaveLength(1));
    expect(usePlaza.getState().results[0].name).toBe("新的那次");

    resolveSlow([card({ name: "迟到的旧结果" })]);
    // 只能靠冲刷微任务队列等它落地:这里等的是"**不该**发生的那次写入",
    // 没有任何状态可供 waitFor 轮询(而 waitFor 一个已经成立的条件会立刻返回,
    // 等于什么都没等——那样这条测试就是空转的)。
    await Promise.resolve();
    await Promise.resolve();
    // 旧响应落地也不能把新结果盖掉
    expect(usePlaza.getState().results[0].name).toBe("新的那次");
    expect(usePlaza.getState().submittedQuery).toBe("vue");
  });

  it("请求还在飞时清空输入框:迟到的响应不能把已清空的结果救回来", async () => {
    let resolveSlow!: (v: unknown) => void;
    invoke.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSlow = resolve; }),
    );
    usePlaza.getState().submitSearch("react");
    await vi.waitFor(() => expect(usePlaza.getState().status).toBe("loading"));

    usePlaza.getState().setQuery(""); // 清空:立即回热门榜
    expect(usePlaza.getState().results).toEqual([]);
    expect(usePlaza.getState().status).toBe("idle");

    resolveSlow([card()]); // 迟到的响应落地
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlaza.getState().results).toEqual([]);
    expect(usePlaza.getState().status).toBe("idle");
    expect(usePlaza.getState().submittedQuery).toBe("");
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
