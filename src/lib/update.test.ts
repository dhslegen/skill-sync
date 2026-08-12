import { describe, expect, it } from "vitest";

import { cardState, remoteHashOf, type LibraryRef } from "./update";

describe("cardState", () => {
  it("没装过 → install", () => {
    expect(cardState(undefined, "sha:remote")).toBe("install");
  });

  it("装了且指纹一致 → installed", () => {
    expect(cardState({ contentHash: "sha:same" }, "sha:same")).toBe("installed");
  });

  it("装了但远端指纹不同 → update", () => {
    expect(cardState({ contentHash: "sha:old" }, "sha:new")).toBe("update");
  });

  it("任一侧指纹缺失时按 installed 处理(宁可漏报)", () => {
    expect(cardState({ contentHash: "sha:old" }, "")).toBe("installed");
    expect(cardState({ contentHash: "" }, "sha:new")).toBe("installed");
  });

  it("同名技能来自另一个库 → otherLibrary,不是 update", () => {
    const record = {
      contentHash: "sha:design",
      registryId: "company",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    };
    const library: LibraryRef = { registryId: "company", owner: "skills", repo: "skills" };
    expect(cardState(record, "sha:whatever", library)).toBe("otherLibrary");
  });

  // ---- 技能广场坐标(M9 任务 5):cardState 本身零改动,这里只换成 plaza 坐标
  //      复核判定对广场同样成立——既有测试形状,只换库坐标。

  it("广场坐标:已装且指纹一致 → installed", () => {
    const record = {
      contentHash: "sha:same",
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "skills",
    };
    const library: LibraryRef = { registryId: "plaza", owner: "vercel-labs", repo: "skills" };
    expect(cardState(record, "sha:same", library)).toBe("installed");
  });

  it("广场坐标:索引指纹不等 → update", () => {
    const record = {
      contentHash: "sha:old",
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "skills",
    };
    const library: LibraryRef = { registryId: "plaza", owner: "vercel-labs", repo: "skills" };
    expect(cardState(record, "sha:new", library)).toBe("update");
  });

  it("广场坐标:同名技能装自另一个技能库(不同 owner/repo) → otherLibrary", () => {
    const record = {
      contentHash: "sha:whatever",
      registryId: "plaza",
      sourceOwner: "someone-else",
      sourceRepo: "other-skills",
    };
    const library: LibraryRef = { registryId: "plaza", owner: "vercel-labs", repo: "skills" };
    expect(cardState(record, "sha:whatever", library)).toBe("otherLibrary");
  });
});

describe("remoteHashOf", () => {
  it("在索引里找不到时给空串,不是 undefined 或抛错", () => {
    expect(remoteHashOf({ skills: [] }, "weekly-report")).toBe("");
    expect(remoteHashOf(null, "weekly-report")).toBe("");
    expect(remoteHashOf(undefined, "weekly-report")).toBe("");
  });

  it("按 dirSlug 取对应技能的指纹", () => {
    const index = { skills: [{ dirSlug: "weekly-report", contentHash: "sha:x" }] };
    expect(remoteHashOf(index, "weekly-report")).toBe("sha:x");
  });
});
