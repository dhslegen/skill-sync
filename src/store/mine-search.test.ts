import { beforeEach, describe, expect, it } from "vitest";

import { matchesMineQuery, useMineSearch } from "./mine-search";

describe("matchesMineQuery", () => {
  const skill = { dirSlug: "weekly-report", sourceLabel: "skills/skills" };

  it("空查询匹配一切", () => {
    expect(matchesMineQuery(skill, "")).toBe(true);
    expect(matchesMineQuery(skill, "   ")).toBe(true);
  });

  it("子串匹配 dirSlug,大小写不敏感", () => {
    expect(matchesMineQuery(skill, "week")).toBe(true);
    expect(matchesMineQuery(skill, "WEEK")).toBe(true);
    expect(matchesMineQuery(skill, "report")).toBe(true);
  });

  it("子串匹配 sourceLabel", () => {
    expect(matchesMineQuery(skill, "skills/skills")).toBe(true);
    expect(matchesMineQuery({ ...skill, sourceLabel: "acme/tools" }, "acme")).toBe(true);
  });

  it("sourceLabel 为 null 时不报错,只按 dirSlug 判", () => {
    expect(matchesMineQuery({ dirSlug: "weekly-report", sourceLabel: null }, "acme")).toBe(false);
    expect(matchesMineQuery({ dirSlug: "weekly-report", sourceLabel: null }, "week")).toBe(true);
  });

  it("两边都不含才判不匹配", () => {
    expect(matchesMineQuery(skill, "code-review")).toBe(false);
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
