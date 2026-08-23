import { describe, expect, it } from "vitest";

import { cardState, isMine, remoteHashOf, type LibraryRef, type MeRef } from "./update";

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

  // ---- 「我分享的」四档(v6 任务 5):author === me 时永不返回
  //      install/installed/update,改按 localModified/远端指纹折出 mine* 四档。

  const me: MeRef = { login: "zhaowenhao", displayName: "赵文昊" };

  it("me 为 null/未传时,行为与 mine 加入前逐字相同(对照组)", () => {
    // 不传 author/me:与本文件顶部一路测试完全同款调用,证明新增的两个参数
    // 是纯粹的可选加法,没有悄悄改变旧行为。
    expect(cardState(undefined, "sha:remote")).toBe("install");
    expect(cardState({ contentHash: "sha:same" }, "sha:same")).toBe("installed");
    expect(cardState({ contentHash: "sha:old" }, "sha:new")).toBe("update");
    // author 有值但没传 me:isMine 因 `!me` 短路为假,同样退回旧口径
    expect(cardState({ contentHash: "sha:old" }, "sha:new", undefined, "赵文昊")).toBe("update");
    // me 有值但 author 是别人:同样不落进 mine 分支
    expect(cardState({ contentHash: "sha:old" }, "sha:new", undefined, "张三", me)).toBe("update");
  });

  it("author === me.displayName 或 me.login 都算是我", () => {
    expect(isMine("赵文昊", me)).toBe(true);
    expect(isMine("zhaowenhao", me)).toBe(true);
    expect(isMine("张三", me)).toBe(false);
    expect(isMine(null, me)).toBe(false);
    expect(isMine("赵文昊", null)).toBe(false);
  });

  it("author === me 且从没获取过 → minePull,不是 install", () => {
    expect(cardState(undefined, "sha:remote", undefined, "赵文昊", me)).toBe("minePull");
  });

  it("author === me:本地/远端都没变 → mineSynced", () => {
    const record = { contentHash: "sha:same", localModified: false };
    expect(cardState(record, "sha:same", undefined, "赵文昊", me)).toBe("mineSynced");
  });

  it("author === me:只有本地改过 → mineShareUpdate", () => {
    const record = { contentHash: "sha:same", localModified: true };
    expect(cardState(record, "sha:same", undefined, "赵文昊", me)).toBe("mineShareUpdate");
  });

  it("author === me:只有远端变过 → minePull", () => {
    const record = { contentHash: "sha:old", localModified: false };
    expect(cardState(record, "sha:new", undefined, "赵文昊", me)).toBe("minePull");
  });

  it("author === me:两边都变了 → mineBoth", () => {
    const record = { contentHash: "sha:old", localModified: true };
    expect(cardState(record, "sha:new", undefined, "赵文昊", me)).toBe("mineBoth");
  });

  it("author === me 但任一侧指纹缺失时按未变处理(宁可漏报)", () => {
    const record1 = { contentHash: "sha:old", localModified: false };
    expect(cardState(record1, "", undefined, "赵文昊", me)).toBe("mineSynced");
    const record2 = { contentHash: "", localModified: false };
    expect(cardState(record2, "sha:new", undefined, "赵文昊", me)).toBe("mineSynced");
  });

  it("otherLibrary 判定排在 mine 折叠之前(与 core acquire::precheck 判定顺序一致)", () => {
    // 两个库的同名技能是两个东西,哪怕两边的作者都是我,"用另一个库的版本替换掉
    // 现有的"仍然必须由用户拍板——这一档不受 mine 影响。
    const record = {
      contentHash: "sha:design",
      localModified: true,
      registryId: "company",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    };
    const library: LibraryRef = { registryId: "company", owner: "skills", repo: "skills" };
    expect(cardState(record, "sha:whatever", library, "赵文昊", me)).toBe("otherLibrary");
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
