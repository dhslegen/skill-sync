import { beforeEach, describe, expect, it } from "vitest";

import { matchesMineQuery, useMineSearch } from "./mine-search";

describe("matchesMineQuery", () => {
  const skill = { dirSlug: "weekly-report", sourceLabel: "skills/skills" };
  const name = "周报生成";

  it("空查询匹配一切", () => {
    expect(matchesMineQuery(skill, name, "")).toBe(true);
    expect(matchesMineQuery(skill, name, "   ")).toBe(true);
  });

  it("🔴 子串匹配展示名 —— 页面显示的就是这个字,搜它必须搜得到(v7 任务 7 订正)", () => {
    expect(matchesMineQuery(skill, name, "周报")).toBe(true);
    expect(matchesMineQuery(skill, name, "生成")).toBe(true);
  });

  it("子串匹配 dirSlug,大小写不敏感", () => {
    expect(matchesMineQuery(skill, name, "week")).toBe(true);
    expect(matchesMineQuery(skill, name, "WEEK")).toBe(true);
    expect(matchesMineQuery(skill, name, "report")).toBe(true);
  });

  it("子串匹配 sourceLabel", () => {
    expect(matchesMineQuery(skill, name, "skills/skills")).toBe(true);
    expect(matchesMineQuery({ ...skill, sourceLabel: "acme/tools" }, name, "acme")).toBe(true);
  });

  it("sourceLabel 为 null 时不报错,只按展示名/dirSlug 判", () => {
    expect(
      matchesMineQuery({ dirSlug: "weekly-report", sourceLabel: null }, name, "acme"),
    ).toBe(false);
    expect(
      matchesMineQuery({ dirSlug: "weekly-report", sourceLabel: null }, name, "week"),
    ).toBe(true);
  });

  it("三处都不含才判不匹配", () => {
    expect(matchesMineQuery(skill, name, "code-review")).toBe(false);
  });
});

describe("useMineSearch", () => {
  beforeEach(() => useMineSearch.setState({ query: "" }));

  it("默认空查询,setQuery 更新状态", () => {
    expect(useMineSearch.getState().query).toBe("");
    useMineSearch.getState().setQuery("week");
    expect(useMineSearch.getState().query).toBe("week");
  });
});
