// 「我的技能」每一行的状态判定(v6 二期任务 7 重写)。
//
// core 的 `InstalledSkillView.relation` 只回答"这是不是我的技能",不回答
// "库里那一版有没有变"——那件事**只有一处判定实现**(`store/my-skills.ts` 的
// `hasUpdate`,与商店卡片、详情面板底部共用),core 再算一份就是第二本账
// (`CLAUDE.md` 记的既有教训:2026-08-03 那次"卡片说有更新、按钮却是禁用的"
// 就是三处各写一份判定造成的)。
//
// 所以本模块**不接触索引、不算指纹**,只吃调用方已经算好的两个布尔量
// (`remoteChanged` 与 `localEqualsRemote`),自己只管把它们与 core 给的
// `relation`/`localPresent`/`localModified`/`contentHash`/`versions` 折成
// 一个能说人话的状态。
import type { InstalledSkillView, ShareBlock } from "@/lib/ipc";

export type SharedState =
  | "versions"
  | "draft"
  | "notHere"
  | "both"
  | "localAhead"
  | "remoteAhead"
  | "differs"
  | "synced";

/**
 * 判定表(按优先级从上到下短路):
 *
 * | 顺序 | 条件 | 状态 |
 * |---|---|---|
 * | 1 | `versions.length > 1` | `versions` |
 * | 2 | `relation === "draft"` | `draft` |
 * | 3 | `!localPresent` | `notHere` |
 * | 4 | `!contentHash`(无安装基线) | `localEqualsRemote === true ? synced : differs` |
 * | 5 | `localModified && remoteChanged` | `both` |
 * | 6 | `localModified` | `localAhead` |
 * | 7 | `remoteChanged` | `remoteAhead` |
 * | 8 | 其余 | `synced` |
 *
 * # 每一档为什么排在这个位置
 *
 * **1. `versions` 必须最优先。** 它说的是"磁盘上有几份内容不同的实体"——在用户
 * 拍板留哪一份之前,"改没改过""库里新不新"这些问题都没有一个确定的主语
 * (要拿哪一份去比?)。排在 `draft` 之后的话,本地新建、还没分享、又恰好在
 * 两个工具目录里各写了一份的技能会显示「尚未分享」并摆出「分享」按钮,
 * 而用户此刻真正该做的是先决定留哪份。
 *
 * 判据是 `> 1` 而不是 `> 0`:core 对"只有本体一份"的行给的就是长度 1 或空,
 * 按 `> 0` 判会让整页每一行都变成「有几个版本」。
 *
 * **2. `draft` 压过 `notHere`。** 草稿从没在库里出现过,"不在这台电脑"这句话
 * 对它没有意义(它本来就只活在这台电脑上)。
 *
 * **3. `notHere` 压过全部改动判定。** 本体都不在了,"本地有没有改过"无从谈起。
 *
 * **4. 🔴 无基线那一档必须压过 `both`/`localAhead`/`remoteAhead`。** 那三档
 * 全部依赖 `localModified`/`remoteChanged` 背后那份"安装那一刻的内容基线",
 * 而这一档**根本没有基线**:`relation === "shared"` 且本地有本体,但没有
 * `state.installed` 记录(典型场景:确实是作者,但直接经 git 推进库,没经过
 * 本 app 装过)。core 侧对这种行恒填 `localModified: false` 且 `contentHash: ""`。
 * 排到后面去的话,`remoteChanged` 为真就会误判成 `remoteAhead`——拿一个不存在的
 * 基线断言"库里比我新",而真相只是"两边不一样,谁新不知道"。
 *
 * `!contentHash` 是可靠判据:写 `state.installed.contentHash` 的两处
 * (`core/acquire.rs::record` 与 `core/share.rs`)都经 `fsops::dir_content_hash`
 * 算出真实哈希,该函数对任意目录(含空目录)都返回非空的十六进制摘要。
 *
 * # `differs` 取代了 v6 一期的 `noBaseline`
 *
 * 上一版这一档叫 `noBaseline`,文案是「没有获取记录,无法判断是否一致」——
 * 那是**给一个不必存在的状态起了名字**。"和库里一不一样"这个问题不需要安装基线
 * 就能回答:把本体此刻的指纹(`localHash`)与库里那一版的指纹直接比就行了。
 * 所以这一档现在有两个真正的出口:
 *
 * - `localEqualsRemote === true` → `synced`,和其余"一致"的行说同一句话;
 * - 其余(不同,或任一侧指纹缺失导致的 `null`)→ `differs`「本地和库里不一样」。
 *
 * `null` 走 `differs` 是**刻意的诚实降级**:指纹缺失时我们确实不知道两边一不一样,
 * 而 `differs` 那一档的界面**两个动作都摆、不默认谁**(改用库里的 / 分享我的),
 * 说"不一样"顶多是多问用户一次;说"已同步"却是在编,而且会让他错过真正的差异。
 *
 * # `localEqualsRemote` 只在第 4 档参与判定
 *
 * 有基线时该信 `localModified`/`remoteChanged`——它们分得清"哪边动了",
 * 而内容比对只分得清"一不一样",是前者的下位替代。把它渗进后四档,
 * 会让"本地改过、恰好改回了库里那一版"这种情况显示成「已同步」而丢掉
 * "有未分享改动"这条真实信息。
 *
 * @param remoteChanged 库里那一版与账上基线不符(唯一判定实现是 `hasUpdate`)。
 * @param localEqualsRemote 本体此刻的内容与库里那一版一不一样;
 *   任一侧指纹缺失时传 `null`(**不要用空串相等冒充 `true`**)。
 */
export function sharedState(
  skill: Pick<
    InstalledSkillView,
    "relation" | "localPresent" | "localModified" | "contentHash" | "versions"
  >,
  remoteChanged: boolean,
  localEqualsRemote: boolean | null,
): SharedState {
  if (skill.versions.length > 1) return "versions";
  if (skill.relation === "draft") return "draft";
  if (!skill.localPresent) return "notHere";
  if (!skill.contentHash) return localEqualsRemote === true ? "synced" : "differs";
  if (skill.localModified && remoteChanged) return "both";
  if (skill.localModified) return "localAhead";
  if (remoteChanged) return "remoteAhead";
  return "synced";
}

// ---------------------------------------------------------------------------
// v7:「我的技能」重设计 —— 三区(installedFrom/sharedTo/shareable)+ 每行至多
// 一颗主按钮。`rowAction` 与上面的 `sharedState` 是**同一份数据的两种问法**,
// 不是它的替代:`sharedState` 回答"这一行现在是什么状态"(v6 二期两分区页在用),
// `rowAction` 回答"这一行现在该摆哪颗按钮"(v7 三区页在用)。
//
// 🔴 **按 R1 裁定,本任务不删 `sharedState`**——它现在仍是 `MySkillsPage.tsx`
// 的唯一消费者(v6 二期两分区页),删掉会让 `pnpm build:web` 当场报错。
// 删除与迁移留给任务 7(它本来就要整页重写,是唯一消费者)。
// ---------------------------------------------------------------------------

export type RowAction =
  | { kind: "none" }
  /**
   * 本地没有本体(第 4 源:库里记着是我分享的,但这台电脑上没有文件)。
   *
   * 🔴 **R3 追加,brief 原表没有这一档**:core 侧 `my_skills::build` 的第 4 源
   * 仍会产出"我分享过但本地没有"的行(`localPresent === false`),v7 设计文档
   * 根决策 #1 说页面"不含"这类行,但那是**任务 7 的展示取舍**——`rowAction`
   * 本身要对任何合法输入给出确定答案,不能因为"理论上不该出现"就留一个空档。
   * 不接的话这类行会落进各区的具体判定分支,拿一个不存在的本体去比"改没改过"
   * 是在编;真接住了,行为也正确——主动作就是「取回」。
   */
  | { kind: "pull" }
  | { kind: "update" } // 安装自 · 库有新版;或 可分享到 · 外源有新版(分享退进「…」)
  | { kind: "conflict" } // 库新 + 本地改 → 既有三选弹窗
  | { kind: "contribute" } // 安装自 · 本地改(浅底,恒走评审)
  | { kind: "shareChanges" } // 已分享到 · 本地改
  | { kind: "share" } // 可分享到 · 合格、未提交过
  | { kind: "shareBlocked"; reason: ShareBlock }
  | { kind: "underReview"; url: string | null }
  | { kind: "chooseVersion" }; // 压过一切

/**
 * 「我的技能」v7 每行主按钮的判定表(十一档,brief 十档 + R3 追加的 `pull`)。
 *
 * # 短路顺序(从上到下,排错位置就会误判)
 *
 * 1. **`versions.length > 1` 压过一切。** 磁盘上有几份内容不同的实体时,
 *    "改没改过""库里新不新"这些问题都没有一个确定的主语(拿哪一份去比?)。
 *    与 {@link sharedState} 的第 1 档同一个理由,原样搬过来。
 * 2. **`!localPresent` 次之。** 本体都不在这台电脑上,后面任何"本地怎样"的
 *    判定都无从谈起(见上面 `RowAction["pull"]` 的文档)。
 * 3. **`shareable` 区内,`review != null` 压过 `shareBlocked` 与 `share`/`update`。**
 *    已经提交评审是一个正在进行的动作,即便这一版此刻标准校验不过、或它自己的
 *    外部来源又有了新内容,当务之急仍是等评审结果——不能让用户在"审核中"与
 *    "重新分享"之间反复横跳。
 * 4. **`shareable` 区内,`shareBlocked != null` 压过 `update`。** 分享不合格是一个
 *    更根本的阻塞状态("这份内容不符合团队标准"),应该先被看到并处理;
 *    "外源有新版"届时仍在「…」里等着(见 {@link RowAction} 的 `update` 注释),
 *    不会丢失,只是不作为这一刻的主按钮。
 * 5. **`installedFrom` 区内,`localModified && remoteChanged` 才是 `conflict`,
 *    单独的 `remoteChanged` 是 `update`,单独的 `localModified` 是 `contribute`。**
 *    三者互斥覆盖("都没变"落到 `none`),与 brief 给的四条测试逐字对应。
 * 6. **`sharedTo` 区内,`remoteChanged` 压过 `localModified`("不论本地")。**
 *    库被别人改过时,不管本地是否也改了,都要先弹既有的三选一冲突框——
 *    直接分享等于覆盖同事经审核改过的版本(与 `CLAUDE.md` 记的
 *    「回推前必须过远端变更检测」同一个理由)。
 *
 * @param remoteChanged 与这一行"该比的那个库"相比,内容是否已经不同——
 *   `installedFrom`/`sharedTo` 比的是公司技能库,`shareable`(有外部来源时)
 *   比的是它自己的来源;调用方按 section 选对索引后算出这一个布尔量喂进来,
 *   `rowAction` 自己不碰索引(同 `sharedState` 模块头的既有教训:判定只能有
 *   一处实现,这里不重新发明第二套"有没有更新")。
 */
export function rowAction(
  skill: Pick<
    InstalledSkillView,
    "section" | "versions" | "shareBlocked" | "review" | "localModified" | "localPresent"
  >,
  remoteChanged: boolean,
): RowAction {
  if (skill.versions.length > 1) return { kind: "chooseVersion" };
  if (!skill.localPresent) return { kind: "pull" };

  if (skill.section === "shareable") {
    if (skill.review) return { kind: "underReview", url: skill.review.url };
    if (skill.shareBlocked) return { kind: "shareBlocked", reason: skill.shareBlocked };
    if (remoteChanged) return { kind: "update" };
    return { kind: "share" };
  }

  if (skill.section === "installedFrom") {
    if (skill.localModified && remoteChanged) return { kind: "conflict" };
    if (remoteChanged) return { kind: "update" };
    if (skill.localModified) return { kind: "contribute" };
    return { kind: "none" };
  }

  // sharedTo
  if (remoteChanged) return { kind: "conflict" };
  if (skill.localModified) return { kind: "shareChanges" };
  return { kind: "none" };
}
