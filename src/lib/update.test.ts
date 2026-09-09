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

  // ---- v7.4:撤掉商店卡片的作者四档(用户第 9 轮拷问拍板,推翻 v6 任务 5 加的
  //      mineSynced/minePull/mineShareUpdate/mineBoth)。`cardState` 不再收
  //      author/me 两个形参,也不再判"这是不是我分享的"——`localModified` 因此
  //      从不参与这里的判定。下面三条正面钉住这条拍板唯一可验证的落点:
  //      即便是自己分享的技能、即便本地也改过,商店卡片仍然只按"库里有没有
  //      新版"这一件事出结果,不再对"是不是我的"另开分支。

  it("本地改过、远端没变 → installed(哪怕这是我分享的技能,商店也保持沉默)", () => {
    const record = { contentHash: "sha:same", localModified: true };
    expect(cardState(record, "sha:same")).toBe("installed");
  });

  it("远端有新版、本地没改 → update", () => {
    const record = { contentHash: "sha:old", localModified: false };
    expect(cardState(record, "sha:new")).toBe("update");
  });

  it("远端有新版、本地也改了 → 仍是 update,不因为本地也改过而分流出别的档", () => {
    // 这正是撤掉之前 mine* 四档要单独区分的场景(会折成 mineBoth);现在
    // localModified 完全不参与判定,"库里有新版"单独就决定了返回值——
    // "本地改没改"这件事交给「我的技能」页,以及点下去之后 core 的
    // acquire::precheck 触发的冲突框去回答,不再由商店卡片抢答。
    const record = { contentHash: "sha:old", localModified: true };
    expect(cardState(record, "sha:new")).toBe("update");
  });

  it("otherLibrary 判定排在按内容指纹比对之前(与 core acquire::precheck 判定顺序一致)", () => {
    // 两个库的同名技能是两个东西,即便内容恰好相同,"用另一个库的版本替换掉
    // 现有的"仍然必须由用户拍板——不能被"指纹相等"当成"已是最新"悄悄放过。
    const record = {
      contentHash: "sha:design",
      registryId: "company",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    };
    const library: LibraryRef = { registryId: "company", owner: "skills", repo: "skills" };
    expect(cardState(record, "sha:design", library)).toBe("otherLibrary");
  });
});

describe("isMine", () => {
  // isMine 本身未被撤销(store.mineBadge「我分享的」徽标唯一消费者,见 update.ts
  // 文档注释),`cardState` 自 v7.4 起不再调用它——这里独立于 cardState 测试。
  const me: MeRef = { login: "zhaowenhao", displayName: "赵文昊" };

  it("author === me.displayName 或 me.login 都算是我", () => {
    expect(isMine("赵文昊", me)).toBe(true);
    expect(isMine("zhaowenhao", me)).toBe(true);
    expect(isMine("张三", me)).toBe(false);
    expect(isMine(null, me)).toBe(false);
    expect(isMine("赵文昊", null)).toBe(false);
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
