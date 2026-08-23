import { describe, expect, it } from "vitest";

import { sharedState } from "./ownership";

function skill(over: {
  relation?: "shared" | "installed" | "draft";
  localPresent?: boolean;
  localModified?: boolean;
}) {
  return {
    relation: "shared" as const,
    localPresent: true,
    localModified: false,
    ...over,
  };
}

describe("sharedState(六状态机)", () => {
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
