import { describe, expect, it } from "vitest";

import type { StoreSkillCard } from "./ipc";
import { filterSkills, matchesQuery } from "./search";

const card = (over: Partial<StoreSkillCard>): StoreSkillCard => ({
  name: "周报生成",
  dirSlug: "weekly-report",
  description: "汇总本周工作,按部门模板生成周报草稿",
  path: "skills/weekly-report",
  hasScripts: false,
  fileCount: 2,
  ...over,
});

const skills = [
  card({}),
  card({ name: "合同审查助手", dirSlug: "contract-review", description: "逐条检查风险条款" }),
  card({ name: "Word 转 Markdown", dirSlug: "docx-to-markdown", description: "高保真转换文档" }),
];

describe("matchesQuery", () => {
  it("空查询命中全部", () => {
    expect(matchesQuery(card({}), "")).toBe(true);
    expect(matchesQuery(card({}), "   ")).toBe(true);
  });

  it("匹配中文名、描述与目录名三处", () => {
    expect(matchesQuery(card({}), "周报")).toBe(true);
    expect(matchesQuery(card({}), "部门模板")).toBe(true);
    expect(matchesQuery(card({}), "weekly")).toBe(true);
  });

  it("英文不区分大小写", () => {
    expect(matchesQuery(card({ name: "Word 转 Markdown" }), "markdown")).toBe(true);
    expect(matchesQuery(card({ name: "Word 转 Markdown" }), "WORD")).toBe(true);
  });

  it("不相关的词不命中", () => {
    expect(matchesQuery(card({}), "合同")).toBe(false);
  });
});

describe("filterSkills", () => {
  const installed = new Set(["weekly-report"]);

  it("全部档不看安装状态", () => {
    expect(filterSkills(skills, "", "all", installed)).toHaveLength(3);
  });

  it("已安装/未安装两档互补", () => {
    const yes = filterSkills(skills, "", "installed", installed);
    const no = filterSkills(skills, "", "available", installed);
    expect(yes.map((s) => s.dirSlug)).toEqual(["weekly-report"]);
    expect(no.map((s) => s.dirSlug)).toEqual(["contract-review", "docx-to-markdown"]);
    expect(yes.length + no.length).toBe(skills.length);
  });

  it("搜索与筛选叠加生效", () => {
    // 「周报」只命中已安装那条,所以在"未安装"档下结果为空
    expect(filterSkills(skills, "周报", "available", installed)).toHaveLength(0);
    expect(filterSkills(skills, "周报", "installed", installed)).toHaveLength(1);
  });

  it("没有已安装记录时,已安装档为空而不是全量", () => {
    // M1 的 installed 恒为空集(获取流程还没接),这一档必须显示空而不是漏成全部
    expect(filterSkills(skills, "", "installed", new Set())).toHaveLength(0);
    expect(filterSkills(skills, "", "available", new Set())).toHaveLength(3);
  });
});
