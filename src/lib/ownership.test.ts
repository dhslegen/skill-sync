import { describe, expect, it } from "vitest";

import { sharedState } from "./ownership";

function skill(over: {
  relation?: "shared" | "installed" | "draft";
  localPresent?: boolean;
  localModified?: boolean;
  contentHash?: string;
}) {
  return {
    relation: "shared" as const,
    localPresent: true,
    localModified: false,
    // 默认给一个非空基线:大多数用例测的是"有基线时"的判定,noBaseline
    // 自己的用例会显式把它清空。
    contentHash: "sha256:baseline",
    ...over,
  };
}

describe("sharedState(七状态机)", () => {
  it("draft:只在本地、库里没有——不管本体在不在、改没改过", () => {
    expect(sharedState(skill({ relation: "draft" }), false)).toBe("draft");
    // draft 优先级最高:即便传入的 localPresent/remoteChanged 暗示别的状态,也不受影响
    expect(sharedState(skill({ relation: "draft", localPresent: false }), true)).toBe("draft");
  });

  it("notHere:库里有、这台电脑没有本体", () => {
    expect(sharedState(skill({ localPresent: false }), false)).toBe("notHere");
  });

  it("notHere 优先于改动判定:本体不在,本地改没改过无从谈起", () => {
    expect(
      sharedState(skill({ localPresent: false, localModified: true }), true),
    ).toBe("notHere");
  });

  it("noBaseline:本地有本体、库里记我是作者,但没有 contentHash 基线", () => {
    // 典型场景:确实是作者,但直接经 git 推进库,没经过本 app 装过
    // ——没有安装记账,也就没有"改没改过"的基线可比。
    expect(sharedState(skill({ contentHash: "" }), false)).toBe("noBaseline");
  });

  it("noBaseline 必须压过 both/localAhead/remoteAhead —— 三档全部依赖一个不存在的基线", () => {
    // 关键的优先级用例:contentHash 为空 **且** localModified 为 true 时,
    // 如果 noBaseline 分支被错放在 localAhead 之后,这条会误判成 localAhead
    // ——用一个不存在的基线断言"本地改过",拿假数据得结论。
    expect(
      sharedState(skill({ contentHash: "", localModified: true }), true),
    ).toBe("noBaseline");
    expect(
      sharedState(skill({ contentHash: "", localModified: true }), false),
    ).toBe("noBaseline");
  });

  it("both:本地改过 + 库里也有新版", () => {
    expect(sharedState(skill({ localModified: true }), true)).toBe("both");
  });

  it("localAhead:只有本地改过,库里没变", () => {
    expect(sharedState(skill({ localModified: true }), false)).toBe("localAhead");
  });

  it("remoteAhead:只有库里有新版,本地没改过", () => {
    expect(sharedState(skill({ localModified: false }), true)).toBe("remoteAhead");
  });

  it("synced:本地没改、库里也没变", () => {
    expect(sharedState(skill({}), false)).toBe("synced");
  });
});
