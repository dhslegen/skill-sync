import { describe, expect, it } from "vitest";

import { cardState, isMine, localHashOf, remoteHashOf, type LibraryRef, type MeRef } from "./update";

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

  // ---- v7.5(`docs/v7.5-共识.md` Q33–Q43):商店认得出"这台电脑上已经有了"。
  //      无记账但本机有本体的技能(在 Claude Code 里原创、走评审分享的技能;
  //      npx 装的;换电脑后 git 拉的)不该再被商店卡片写成「获取」。
  //      六条正面钉住的判据里,这里覆盖 1、2、3、4、5;第 6 条(筛选器)在
  //      StorePage.test.tsx。

  it("🔴 v7.5:无记账 + 本机有本体 + 指纹相同 → onDisk", () => {
    expect(cardState(undefined, "sha:same", undefined, "sha:same")).toBe("onDisk");
  });

  it("🔴 v7.5:无记账 + 本机有本体 + 指纹不同 → onDiskDiffers", () => {
    expect(cardState(undefined, "sha:remote", undefined, "sha:local")).toBe("onDiskDiffers");
  });

  it("🔴 v7.5:无记账 + 本机有本体 + remoteHash 为空(广场)→ onDisk(漏报是刻意的,Q43-A)", () => {
    // 广场卡片没有内容指纹,`remoteHash` 恒传空串——哪怕本地内容其实不同,
    // 也不该说「与库里不同」(那需要一个不存在的比对基准)。
    expect(cardState(undefined, "", undefined, "sha:local")).toBe("onDisk");
  });

  it("🔴 v7.5:localHash 本身是空串(有本体但指纹读不到)时同样按'相同'处理", () => {
    expect(cardState(undefined, "sha:remote", undefined, "")).toBe("onDisk");
  });

  it("🔴 v7.5:无记账 + 本机没有本体(localHash undefined)→ 仍是 install,不能被新逻辑吃掉", () => {
    expect(cardState(undefined, "sha:remote", undefined, undefined)).toBe("install");
    // 不传第四个实参(调用方没喂 localHash)必须与显式传 undefined 完全等价
    // ——这是这次改动对"没打算处理 localHash 的调用方"唯一的兼容承诺。
    expect(cardState(undefined, "sha:remote")).toBe("install");
  });

  it("🔴 v7.5:有记账时,新形参 localHash 不改变任何既有结论(逐条对照)", () => {
    // 装了且指纹一致 → installed
    expect(cardState({ contentHash: "sha:same" }, "sha:same", undefined, "随便什么值")).toBe(
      "installed",
    );
    // 装了但远端指纹不同 → update
    expect(cardState({ contentHash: "sha:old" }, "sha:new", undefined, "随便什么值")).toBe("update");
    // 任一侧指纹缺失时按 installed 处理
    expect(cardState({ contentHash: "sha:old" }, "", undefined, "随便什么值")).toBe("installed");
    // otherLibrary:同名技能来自另一个库,localHash 同样不参与
    const record = {
      contentHash: "sha:design",
      registryId: "company",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    };
    const library: LibraryRef = { registryId: "company", owner: "skills", repo: "skills" };
    expect(cardState(record, "sha:whatever", library, "随便什么值")).toBe("otherLibrary");
  });
});

describe("localHashOf", () => {
  it("list 为 null/undefined,或找不到这一行 → undefined", () => {
    expect(localHashOf(null, "weekly-report")).toBeUndefined();
    expect(localHashOf(undefined, "weekly-report")).toBeUndefined();
    expect(localHashOf([], "weekly-report")).toBeUndefined();
  });

  it("只取 localPresent 的行,不是随便一条匹配 dirSlug 的记录", () => {
    const list = [{ dirSlug: "weekly-report", localPresent: false, localHash: "sha:x" }];
    expect(localHashOf(list, "weekly-report")).toBeUndefined();
  });

  it("localPresent 为真时给出它的 localHash(哪怕是空串)", () => {
    const list = [{ dirSlug: "weekly-report", localPresent: true, localHash: "" }];
    expect(localHashOf(list, "weekly-report")).toBe("");
    const list2 = [{ dirSlug: "weekly-report", localPresent: true, localHash: "sha:x" }];
    expect(localHashOf(list2, "weekly-report")).toBe("sha:x");
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
