import { describe, expect, it } from "vitest";

import type { InstalledSkillView, Section, SkillVersion } from "@/lib/ipc";
import { rowAction, type RowAction } from "./ownership";

// ---------------------------------------------------------------------------
// v7 任务 7:`sharedState`/`SharedState`(v6 二期两分区页用的八态机)已随旧页面
// 一起删除——`rowAction` 早在任务 4 就接管了"这一行该摆哪颗按钮"这个问题,
// `sharedState` 只是"这一行现在是什么状态"的另一种问法,唯一消费者
// `MySkillsPage.tsx` 的 `Row` 已经不再读它。判定表本身没有丢:它的优先级顺序
// (versions 最优先 / draft 压 notHere / 无基线档压 both-localAhead-remoteAhead)
// 已经是 `rowAction` 判定表(下面)的一部分,同一套道理换了个问法。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v7:rowAction 判定表(十档,brief 九档 + R3 追加的 pull——档数订正:`RowAction`
// 字面量联合类型逐个数下来是十种,不是十一种,与 `lib/ownership.ts` 里
// `rowAction` 自己的文档说法一致)
// ---------------------------------------------------------------------------

function v(path: string): SkillVersion {
  return { path, modifiedAt: "2026-08-24T00:00:00Z", files: 1, contentHash: `h-${path}` };
}

type RowSkill = Pick<
  InstalledSkillView,
  "section" | "versions" | "shareBlocked" | "review" | "localModified" | "localPresent"
>;

/** 默认形状:本体在,没改过,没有分歧版本,没有审核记录,校验合格。 */
const rowBase: RowSkill = {
  section: "installedFrom" as Section,
  versions: [],
  shareBlocked: null,
  review: null,
  localModified: false,
  localPresent: true,
};

describe("rowAction(判定表)", () => {
  it.each<[string, Partial<RowSkill>, boolean, RowAction["kind"]]>([
    ["安装自 · 库有新版", { section: "installedFrom" }, true, "update"],
    ["安装自 · 库新+本地改", { section: "installedFrom", localModified: true }, true, "conflict"],
    ["安装自 · 只本地改", { section: "installedFrom", localModified: true }, false, "contribute"],
    ["安装自 · 都没变", { section: "installedFrom" }, false, "none"],
    ["已分享到 · 本地改", { section: "sharedTo", localModified: true }, false, "shareChanges"],
    ["已分享到 · 都没变", { section: "sharedTo" }, false, "none"],
    ["可分享到 · 合格", { section: "shareable" }, false, "share"],
  ])("%s", (_name, over, remoteChanged, expected) => {
    expect(rowAction({ ...rowBase, ...over }, remoteChanged).kind).toBe(expected);
  });

  it("已分享到 · 库被别人改(不论本地)→ conflict,不看本地改没改", () => {
    // 🔴 "不论本地":remoteChanged 为真时,localModified 是 true 还是 false
    // 结论都必须是 conflict——直接分享等于覆盖同事经审核改过的版本。
    expect(
      rowAction({ ...rowBase, section: "sharedTo", localModified: false }, true).kind,
    ).toBe("conflict");
    expect(
      rowAction({ ...rowBase, section: "sharedTo", localModified: true }, true).kind,
    ).toBe("conflict");
  });

  it("同名多份压过一切", () => {
    const s: RowSkill = {
      ...rowBase,
      section: "installedFrom",
      versions: [v("a"), v("b")],
      shareBlocked: "nameMismatch",
    };
    expect(rowAction(s, true).kind).toBe("chooseVersion");
  });

  it("本地没有本体(第 4 源)→ pull,压过区内其余判定(R3)", () => {
    expect(rowAction({ ...rowBase, section: "sharedTo", localPresent: false }, true).kind).toBe(
      "pull",
    );
    // 与 chooseVersion 同台竞争时,chooseVersion 仍然优先(它排在更前面)。
    expect(
      rowAction(
        { ...rowBase, section: "sharedTo", localPresent: false, versions: [v("a"), v("b")] },
        true,
      ).kind,
    ).toBe("chooseVersion");
  });

  it("不合格的可分享到:动作是 shareBlocked 且带上原因", () => {
    const s: RowSkill = { ...rowBase, section: "shareable", shareBlocked: "nameMismatch" };
    expect(rowAction(s, false)).toEqual({
      kind: "shareBlocked",
      reason: "nameMismatch",
      blockedAction: "share",
    });
  });

  it("审核中压过 share 与 shareBlocked", () => {
    const s: RowSkill = {
      ...rowBase,
      section: "shareable",
      review: { url: "http://x/pulls/7" },
      shareBlocked: "nameMismatch",
    };
    expect(rowAction(s, false)).toEqual({ kind: "underReview", url: "http://x/pulls/7" });
  });

  it("审核中但没有 PR 链接(直推留下的记录 / v7 之前的存量记录):url 如实带 null", () => {
    const s: RowSkill = { ...rowBase, section: "shareable", review: { url: null } };
    expect(rowAction(s, false)).toEqual({ kind: "underReview", url: null });
  });

  it("可分享到 · 外源有新版 → update,分享退进「…」", () => {
    expect(rowAction({ ...rowBase, section: "shareable" }, true).kind).toBe("update");
  });

  it("可分享到 · 不合格 + 外源有新版:shareBlocked 优先——先说清为什么不能分享", () => {
    const s: RowSkill = { ...rowBase, section: "shareable", shareBlocked: "descriptionMissing" };
    expect(rowAction(s, true)).toEqual({
      kind: "shareBlocked",
      reason: "descriptionMissing",
      blockedAction: "share",
    });
  });

  // ---------------------------------------------------------------------
  // 🔴 C1(v7 任务 7 修复轮 1):shareBlocked 此前只在 shareable 区判——
  // installedFrom(贡献更改)/sharedTo(分享改动)同样会把本地内容推去评审
  // (skill_share_changes),同一道闸必须在三个区都生效。
  // ---------------------------------------------------------------------

  it("安装自 · 本地改了但标准校验不过 → shareBlocked,blockedAction 是 contribute", () => {
    const s: RowSkill = {
      ...rowBase,
      section: "installedFrom",
      localModified: true,
      shareBlocked: "nameFormat",
    };
    expect(rowAction(s, false)).toEqual({
      kind: "shareBlocked",
      reason: "nameFormat",
      blockedAction: "contribute",
    });
  });

  it("已分享到 · 本地改了但标准校验不过 → shareBlocked,blockedAction 是 shareChanges", () => {
    const s: RowSkill = {
      ...rowBase,
      section: "sharedTo",
      localModified: true,
      shareBlocked: "descriptionTooLong",
    };
    expect(rowAction(s, false)).toEqual({
      kind: "shareBlocked",
      reason: "descriptionTooLong",
      blockedAction: "shareChanges",
    });
  });

  it("对照组:安装自区标准校验通过时照常是 contribute,不受 shareBlocked 字段存在与否影响", () => {
    const s: RowSkill = { ...rowBase, section: "installedFrom", localModified: true, shareBlocked: null };
    expect(rowAction(s, false).kind).toBe("contribute");
  });

  it("对照组:已分享到区标准校验通过时照常是 shareChanges", () => {
    const s: RowSkill = { ...rowBase, section: "sharedTo", localModified: true, shareBlocked: null };
    expect(rowAction(s, false).kind).toBe("shareChanges");
  });

  it("无分享入口时 shareBlocked 不摆:安装自区没改过本地,哪怕 shareBlocked 有值也是 none(不是要拦的动作)", () => {
    const s: RowSkill = { ...rowBase, section: "installedFrom", localModified: false, shareBlocked: "nameFormat" };
    expect(rowAction(s, false).kind).toBe("none");
  });

  it("无分享入口时 shareBlocked 不摆:已分享到区没改过本地,同理是 none", () => {
    const s: RowSkill = { ...rowBase, section: "sharedTo", localModified: false, shareBlocked: "nameFormat" };
    expect(rowAction(s, false).kind).toBe("none");
  });

  it("conflict 压过 shareBlocked:库新 + 本地改 + 不合格,仍先弹冲突框(拍板之后才轮到分享合格性)", () => {
    const s: RowSkill = {
      ...rowBase,
      section: "installedFrom",
      localModified: true,
      shareBlocked: "nameFormat",
    };
    // remoteChanged=true 时 installedFrom 分支第一条判据(localModified&&remoteChanged)
    // 直接短路成 conflict,shareBlocked 那一层代码根本没机会跑到。
    expect(rowAction(s, true).kind).toBe("conflict");
  });
});
