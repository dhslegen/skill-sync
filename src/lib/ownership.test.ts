import { describe, expect, it } from "vitest";

import type { InstalledSkillView, Section, SkillVersion } from "@/lib/ipc";
import { rowAction, sharedState, type RowAction, type SharedState } from "./ownership";

const V = { path: "/p", modifiedAt: "2026-08-24T00:00:00Z", files: 1, contentHash: "h" };

/** 默认形状:有基线、本体在、没改过、没有分歧版本。各用例只翻自己那一位。 */
const base = {
  // 类型写成完整联合而不是 `as const`:判定表里有一条要覆盖成 "draft",
  // 收窄成字面量 "shared" 的话那一条过不了 tsc(vitest 不做类型检查,只有
  // `build:web` 拦得住——本项目记的既有教训)。
  relation: "shared" as InstalledSkillView["relation"],
  localPresent: true,
  localModified: false,
  contentHash: "sha256:baseline",
  versions: [] as typeof V[],
};

/** 判定表:[覆盖的字段, remoteChanged, localEqualsRemote, 期望状态]。 */
const TABLE: [Partial<typeof base>, boolean, boolean | null, SharedState][] = [
    // 1. versions 最优先:磁盘上有几份内容不同的实体,先拍板留哪份,
    //    其余问题(改没改过、库里新不新)在拍板之前都没有意义。
    [{ versions: [V, V] }, false, null, "versions"],
    // 2. draft:库里压根没有它,"和库里比"无从谈起。
    [{ relation: "draft" }, false, null, "draft"],
    // 3. notHere:本体不在这台电脑上。
    [{ localPresent: false }, false, null, "notHere"],
    // 4. 无基线:不问"改没改过",直接两方比内容。
    [{ contentHash: "" }, false, true, "synced"],
    [{ contentHash: "" }, false, false, "differs"],
    //    任一侧指纹缺失 → null → 诚实降级成 differs,不假装"已同步"。
    [{ contentHash: "" }, false, null, "differs"],
    //    🔴 这两行钉住"无基线压过后三档"这条**顺序**:上面三行的 localModified
    //    与 remoteChanged 都是 false,顺序排错了也照样落进无基线那一档,分辨不出来。
    //    必须让两边同时成立,判定表本身才具备鉴别力(否则这条不变量只由下面那条
    //    专门的优先级用例独自扛着)。
    [{ contentHash: "", localModified: true }, true, false, "differs"],
    [{ contentHash: "", localModified: true }, false, true, "synced"],
    // 5-8. 有基线时的四档。
    [{ localModified: true }, true, null, "both"],
    [{ localModified: true }, false, null, "localAhead"],
    [{}, true, null, "remoteAhead"],
    [{}, false, null, "synced"],
];

describe("sharedState(判定表)", () => {
  it.each(TABLE)("%j / remote=%s / eq=%s → %s", (over, remote, eq, want) => {
    expect(sharedState({ ...base, ...over }, remote, eq)).toBe(want);
  });

  // ---- 优先级:每一条都是"排错位置就会误判"的正面用例 ----

  it("versions 压过其余全部:同时满足 draft/notHere/改动三档也仍是 versions", () => {
    // 排在 draft 之后的话,本地新建、还没分享、又恰好在两个工具里各写了一份
    // 的技能会显示「尚未分享」——而用户此刻真正要做的是先拍板留哪一份。
    expect(
      sharedState(
        { ...base, versions: [V, V], relation: "draft", localModified: true },
        true,
        null,
      ),
    ).toBe("versions");
    expect(
      sharedState({ ...base, versions: [V, V], localPresent: false }, true, null),
    ).toBe("versions");
  });

  it("versions 只在真的多于一份时触发:一份实体不是分歧", () => {
    // core 对"只有本体一份"的行给的就是长度 1(或空)。按 `length > 0` 判的话
    // 每一行都会变成「有几个版本」,整页只剩一个动作。
    expect(sharedState({ ...base, versions: [V] }, false, null)).toBe("synced");
    expect(sharedState({ ...base, versions: [] }, false, null)).toBe("synced");
  });

  it("draft 压过 notHere:草稿本来就只活在这台电脑上", () => {
    expect(
      sharedState({ ...base, relation: "draft", localPresent: false }, true, null),
    ).toBe("draft");
  });

  it("notHere 压过改动判定:本体不在,改没改过无从谈起", () => {
    expect(
      sharedState({ ...base, localPresent: false, localModified: true }, true, null),
    ).toBe("notHere");
  });

  it("无基线那一档压过 both/localAhead/remoteAhead —— 那三档依赖一个不存在的基线", () => {
    // 🔴 这是本表最容易排错位置的一条:`contentHash` 为空时 core 恒填
    // `localModified: false`,若把这一档排到 both/localAhead 之后,
    // remoteChanged 为真就会误判成 remoteAhead——拿一个不存在的基线断言
    // "库里比我新",而真相是"两边不一样,谁新不知道"。
    expect(sharedState({ ...base, contentHash: "" }, true, false), "远端变了 + 内容不同").toBe(
      "differs",
    );
    // 内容其实一样时也不能被 remoteChanged 带跑:两方比内容才是这一档的判据。
    expect(sharedState({ ...base, contentHash: "" }, true, true), "远端变了 + 内容相同").toBe(
      "synced",
    );
    // localModified 即便被填成 true(不该发生,但不能靠"上游恰好不这么填"活着)
    expect(
      sharedState({ ...base, contentHash: "", localModified: true }, false, true),
    ).toBe("synced");
  });

  it("有基线时 localEqualsRemote 一概不参与判定", () => {
    // 反向守卫:第 4 档的两个新出口不能渗到有基线的四档里去。
    // 有基线时该信 localModified/remoteChanged,内容比对是它们的下位替代。
    expect(sharedState({ ...base, localModified: true }, false, true)).toBe("localAhead");
    expect(sharedState({ ...base }, true, true)).toBe("remoteAhead");
  });

  it("noBaseline 不再是一个状态名(v6 二期删除)", () => {
    // 它当年是「没有获取记录,无法判断是否一致」——给一个不必存在的状态起了名字。
    // 现在没有基线就直接两方比内容,得到 synced 或 differs,都是能说人话的结论。
    // @ts-expect-error 类型层面就不存在
    const s: SharedState = "noBaseline";
    void s;
  });
});

// ---------------------------------------------------------------------------
// v7:rowAction 判定表(十一档,brief 十档 + R3 追加的 pull)
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
    expect(rowAction(s, false)).toEqual({ kind: "shareBlocked", reason: "nameMismatch" });
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
    expect(rowAction(s, true)).toEqual({ kind: "shareBlocked", reason: "descriptionMissing" });
  });
});
