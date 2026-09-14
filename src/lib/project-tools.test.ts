import { describe, expect, it } from "vitest";

import type { ProjectGroupView, ProjectSkillView } from "@/lib/ipc";
import { applyGroupToggle, groupProjectTools, projectHasSkill, type ProjectToolMember } from "@/lib/project-tools";

const m = (agent: string, skillsDir: string | undefined, on = false, detected = true): ProjectToolMember => ({
  agent,
  label: agent.toUpperCase(),
  skillsDir,
  on,
  detected,
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

  it("🔴 组 id 按目录定,成员进出不改变它(2026-09-14 复验:id 随成员变 → ToolPicker 重排)", () => {
    // 勾上时 Trae(本机未装,只因已关联才进来)在组里,取消后它就不在了。
    // id 若由成员拼成,两次渲染是两个不同的键,picker 判定"集合变了"并重排,刚点的那一项跳走。
    const [linked] = groupProjectTools([m("trae-cn", ".trae/skills", true), m("trae", ".trae/skills", true, false)]);
    const [unlinked] = groupProjectTools([m("trae-cn", ".trae/skills")]);
    expect(linked.id).toBe(unlinked.id);
  });

  it("skillsDir 未知的组 id 仍取 agent 名(不会与目录组撞键)", () => {
    const [g] = groupProjectTools([m("a", undefined)]);
    expect(g.id).toBe("a");
  });

  it("🔴 名字只取这台机器探测到的成员:未安装、只因已关联才进来的不进标签(复验:勾上与取消两种名字)", () => {
    const [g] = groupProjectTools([m("trae-cn", ".trae/skills", true), m("trae", ".trae/skills", true, false)]);
    expect(g.labels).toEqual(["TRAE-CN"]);
    expect(g.agents).toEqual(["trae-cn", "trae"]); // 仍在组里:取消时要一起摘
  });

  it("组里一个探测到的成员都没有时,退回全部成员的名字(不能摆一个没名字的勾)", () => {
    const [g] = groupProjectTools([m("zed", ".zed/skills", true, false)]);
    expect(g.labels).toEqual(["ZED"]);
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

describe("projectHasSkill", () => {
  const sk = (over: Partial<ProjectSkillView>): ProjectSkillView => ({
    key: "vercel-react-best-practices", displayName: "x", description: "", source: "o/r", sourceType: "github",
    dirSlug: "react-best-practices", registryId: "plaza", repo: "o/r", updatable: true, agents: [], bodyPresent: true,
    ...over,
  });
  const g = (skills: ProjectSkillView[]): ProjectGroupView => ({ path: "/p", folderName: "p", missing: false, readOnly: false, skills });

  it("按仓库目录名匹配,不按 lock 的 key", () => {
    expect(projectHasSkill(g([sk({})]), "react-best-practices")).toBe(true);
    expect(projectHasSkill(g([sk({})]), "vercel-react-best-practices")).toBe(false);
  });

  it("🔴 lock 里有记录但本体被删掉了,不算装着", () => {
    expect(projectHasSkill(g([sk({ bodyPresent: false })]), "react-best-practices")).toBe(false);
  });
});
