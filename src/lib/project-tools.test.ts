import { describe, expect, it } from "vitest";

import { applyGroupToggle, groupProjectTools, type ProjectToolMember } from "@/lib/project-tools";

const m = (agent: string, skillsDir: string | undefined, on = false): ProjectToolMember => ({
  agent,
  label: agent.toUpperCase(),
  skillsDir,
  on,
});

describe("groupProjectTools", () => {
  it("共用同一个项目目录的工具合并成一个开关(Trae 与 Trae CN 都是 .trae/skills)", () => {
    const groups = groupProjectTools([
      m("claude-code", ".claude/skills"),
      m("trae-cn", ".trae/skills", true),
      m("trae", ".trae/skills"),
    ]);
    expect(groups.map((g) => g.agents)).toEqual([["claude-code"], ["trae-cn", "trae"]]);
  });

  it("组内任一成员已关联即整组开着——它们读的是同一条链接", () => {
    const [trae] = groupProjectTools([m("trae", ".trae/skills", false), m("trae-cn", ".trae/skills", true)]);
    expect(trae.on).toBe(true);
  });

  it("skillsDir 未知的成员各自成组,不拿「不知道」去和别人合并", () => {
    const groups = groupProjectTools([m("a", undefined), m("b", undefined)]);
    expect(groups.map((g) => g.agents)).toEqual([["a"], ["b"]]);
  });

  it("同一个 agent 重复出现(候选与已关联两路都给了它)只算一次", () => {
    const [g] = groupProjectTools([m("trae", ".trae/skills"), m("trae", ".trae/skills", true)]);
    expect(g.agents).toEqual(["trae"]);
    expect(g.on).toBe(true);
  });

  it("组 id 在成员集合相同时稳定,可作 ToolPickerItem 的键", () => {
    const [g] = groupProjectTools([m("trae-cn", ".trae/skills"), m("trae", ".trae/skills")]);
    expect(g.id).toBe("trae-cn+trae");
  });
});

describe("applyGroupToggle", () => {
  it("关闭整组:两个成员一起从目标集合里去掉,其余保留", () => {
    expect(applyGroupToggle(["claude-code", "trae-cn", "trae"], ["trae-cn", "trae"], false)).toEqual(["claude-code"]);
  });

  it("关闭时即便当前只含组内一个成员,也一并去掉(不留半组)", () => {
    expect(applyGroupToggle(["trae-cn"], ["trae-cn", "trae"], false)).toEqual([]);
  });

  it("打开整组:并上全部成员,不重复", () => {
    expect(applyGroupToggle(["claude-code", "trae"], ["trae-cn", "trae"], true)).toEqual([
      "claude-code",
      "trae-cn",
      "trae",
    ]);
  });
});
