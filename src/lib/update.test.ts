import { describe, expect, it } from "vitest";

import { cardState, isMine, localHashOf, remoteHashOf, type LibraryRef, type MeRef } from "./update";

describe("cardState", () => {
  // ---- v7.6(`docs/v7.6-共识.md` Q44–Q49):状态词只讲磁盘,记账只回答"从哪来"。
  //      判定入口从"问账本"(`!record`)改成"问磁盘"(`localHash === undefined`)
  //      ——这意味着**几乎每一条既有用例都要显式给出 `localHash`**,否则默认
  //      `undefined` 会被新入口当成"磁盘上没有本体"直接判成 install,这不是
  //      测试写错了,是这次拍板本身的核心推论(装了又被删掉目录 → 获取)。

  it("没装过、磁盘上也没有 → install", () => {
    expect(cardState(undefined, "sha:remote")).toBe("install");
    expect(cardState(undefined, "sha:remote", undefined, undefined)).toBe("install");
  });

  it("🔴 有记账,但磁盘上没有本体(localHash undefined)→ 仍是 install,不是 onDisk", () => {
    // 这是本次拍板的核心推论:入口从"问账本"改成"问磁盘"。装了又被手动删掉
    // 目录的技能,从「已启用」变成「获取」——正确,不是回归(Q47-A)。
    expect(cardState({ contentHash: "sha:same" }, "sha:same")).toBe("install");
  });

  it("装了且指纹一致 → onDisk(v7.6 起 installed 并入 onDisk,不再是独立档)", () => {
    expect(cardState({ contentHash: "sha:same" }, "sha:same", undefined, "sha:same")).toBe("onDisk");
  });

  it("装了但远端指纹不同、本地没改(localHash 与记账基线一致)→ update", () => {
    expect(cardState({ contentHash: "sha:old" }, "sha:new", undefined, "sha:old")).toBe("update");
  });

  it("🔴 v7.6:「更新」比以前更准——不同 + 有账 + localHash 与记账基线不同(用户改过)→ differs,不是 update", () => {
    // 这是让「更新」变准的那一条:旧判据不看 localHash,用户改过的技能只要库里
    // 也动了照样写「更新」,点下去才被 precheck 拦成拍板框。新判据下「更新」
    // 只在点下去真的安全(本地未改、只是库里前进了)时出现。
    expect(cardState({ contentHash: "sha:old" }, "sha:new", undefined, "sha:local-edit")).toBe(
      "differs",
    );
  });

  it("有账时 remoteHash 缺失(索引没有这个技能的指纹)→ onDisk 处理(宁可漏报)", () => {
    expect(cardState({ contentHash: "sha:old" }, "", undefined, "sha:old")).toBe("onDisk");
  });

  it("同名技能来自另一个库 → otherLibrary,不是 update", () => {
    const record = {
      contentHash: "sha:design",
      registryId: "company",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    };
    const library: LibraryRef = { registryId: "company", owner: "skills", repo: "skills" };
    expect(cardState(record, "sha:whatever", library, "sha:design")).toBe("otherLibrary");
  });

  // ---- 技能广场坐标(M9 任务 5):cardState 本身零改动,这里只换成 plaza 坐标
  //      复核判定对广场同样成立——既有测试形状,只换库坐标。

  it("广场坐标:已装且指纹一致 → onDisk", () => {
    const record = {
      contentHash: "sha:same",
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "skills",
    };
    const library: LibraryRef = { registryId: "plaza", owner: "vercel-labs", repo: "skills" };
    expect(cardState(record, "sha:same", library, "sha:same")).toBe("onDisk");
  });

  it("广场坐标:索引指纹不等、本地未改 → update", () => {
    const record = {
      contentHash: "sha:old",
      registryId: "plaza",
      sourceOwner: "vercel-labs",
      sourceRepo: "skills",
    };
    const library: LibraryRef = { registryId: "plaza", owner: "vercel-labs", repo: "skills" };
    expect(cardState(record, "sha:new", library, "sha:old")).toBe("update");
  });

  it("广场坐标:同名技能装自另一个技能库(不同 owner/repo) → otherLibrary", () => {
    const record = {
      contentHash: "sha:whatever",
      registryId: "plaza",
      sourceOwner: "someone-else",
      sourceRepo: "other-skills",
    };
    const library: LibraryRef = { registryId: "plaza", owner: "vercel-labs", repo: "skills" };
    expect(cardState(record, "sha:whatever", library, "sha:whatever")).toBe("otherLibrary");
  });

  // ---- v7.4:撤掉商店卡片的作者四档(用户第 9 轮拷问拍板,推翻 v6 任务 5 加的
  //      mineSynced/minePull/mineShareUpdate/mineBoth)。`cardState` 不再收
  //      author/me 两个形参,也不再判"这是不是我分享的"——`localModified` 因此
  //      从不参与这里的判定,这一点 v7.6 也没有变。下面几条正面钉住这条拍板
  //      唯一可验证的落点:即便是自己分享的技能,商店卡片仍然只按"磁盘与库里
  //      是否一致"这一件事出结果,不再对"是不是我的"另开分支。

  it("🔴 v7.6 行为翻转:装了、只有本地改过(远端没变)→ differs,不再是「已启用」", () => {
    // v7.4 曾钉住这一档是 installed(那时"本地改没改"完全不参与判定,只看
    // record.contentHash 与 remoteHash 是否相等)。v7.6 拍板后状态词只讲磁盘的
    // 事实:localHash 与记账基线 record.contentHash 不同,就是「与库里不同」,
    // 哪怕这正是这个技能的作者本人、哪怕远端一个字节都没变。这是拍板的直接
    // 推论,不是回归——见 `docs/v7.6-共识.md`「三个行为翻转」第 1 条。
    const record = { contentHash: "sha:same", localModified: true };
    expect(cardState(record, "sha:same", undefined, "sha:local-edit")).toBe("differs");
  });

  it("远端有新版、本地没改(localHash 与记账基线一致)→ update", () => {
    const record = { contentHash: "sha:old", localModified: false };
    expect(cardState(record, "sha:new", undefined, "sha:old")).toBe("update");
  });

  it("🔴 v7.6:localModified 字段本身依旧不参与判定——真正决定结果的是 localHash 与记账基线的比对,不是这个布尔字段", () => {
    // 即便 localModified 显式写着 true,只要 localHash 与记账基线一致(用户
    // 实际上没有再碰过磁盘上的文件),仍然是安全的「更新」——证明这个字段
    // 不驱动任何分支,判定完全靠实时指纹。
    const record = { contentHash: "sha:old", localModified: true };
    expect(cardState(record, "sha:new", undefined, "sha:old")).toBe("update");
  });

  it("远端有新版、本地也确实改了(localHash 与记账基线不同)→ differs,不是 update", () => {
    // 这正是撤掉之前 mine* 四档要单独区分的场景(会折成 mineBoth)。v7.4 时
    // cardState 完全不看"本地改没改",于是这一档仍然写「更新」,点下去才被
    // precheck 拦成拍板框。v7.6 拍板后「更新」只在点下去真的安全时出现
    // ——本地确实改过时,不能再说是安全的「更新」,必须是「与库里不同」。
    const record = { contentHash: "sha:old", localModified: true };
    expect(cardState(record, "sha:new", undefined, "sha:local-edit")).toBe("differs");
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
    expect(cardState(record, "sha:design", library, "sha:design")).toBe("otherLibrary");
  });

  it("🔴 otherLibrary 判定仍在最前,不受新入口(localHash)任何一档影响——即便 localHash 是 undefined(磁盘上没有本体),otherLibrary 依旧优先命中", () => {
    const record = {
      contentHash: "sha:design",
      registryId: "company",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    };
    const library: LibraryRef = { registryId: "company", owner: "skills", repo: "skills" };
    // localHash 缺省(undefined):按"入口"逻辑单独看会判成 install,
    // 但 otherLibrary 判在最前,必须依旧优先命中。
    expect(cardState(record, "sha:whatever", library)).toBe("otherLibrary");
    // localHash 与记账内容一致(貌似"安全的更新")同样不能绕过 otherLibrary。
    expect(cardState(record, "sha:design", library, "sha:design")).toBe("otherLibrary");
  });

  // ---- v7.5/v7.6(`docs/v7.5-共识.md` Q33–Q43,`docs/v7.6-共识.md` Q44–Q49):
  //      商店认得出"这台电脑上已经有了"。无记账但本机有本体的技能(在 Claude
  //      Code 里原创、走评审分享的技能;npx 装的;换电脑后 git 拉的)不该再被
  //      商店卡片写成「获取」。v7.6 起这一支与"有记账、指纹一致"合并成同一个
  //      `onDisk`——下面覆盖 brief 要求的全部正面断言,第 6 条(筛选器)在
  //      StorePage.test.tsx。

  it("无记账 + 本机有本体 + 指纹相同 → onDisk", () => {
    expect(cardState(undefined, "sha:same", undefined, "sha:same")).toBe("onDisk");
  });

  it("无记账 + 本机有本体 + 指纹不同 → differs(v7.6 前叫 onDiskDiffers)", () => {
    expect(cardState(undefined, "sha:remote", undefined, "sha:local")).toBe("differs");
  });

  it("无记账 + 本机有本体 + remoteHash 为空(广场)→ onDisk(漏报是刻意的,Q43-A)", () => {
    // 广场卡片没有内容指纹,`remoteHash` 恒传空串——哪怕本地内容其实不同,
    // 也不该说「与库里不同」(那需要一个不存在的比对基准)。
    expect(cardState(undefined, "", undefined, "sha:local")).toBe("onDisk");
  });

  it("localHash 本身是空串(有本体但指纹读不到)时同样按'相同'处理", () => {
    expect(cardState(undefined, "sha:remote", undefined, "")).toBe("onDisk");
  });

  it("无记账 + 本机没有本体(localHash undefined)→ 仍是 install,不能被新逻辑吃掉", () => {
    expect(cardState(undefined, "sha:remote", undefined, undefined)).toBe("install");
    // 不传第四个实参(调用方没喂 localHash)必须与显式传 undefined 完全等价
    // ——这是这次改动对"没打算处理 localHash 的调用方"唯一的兼容承诺。
    expect(cardState(undefined, "sha:remote")).toBe("install");
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
