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
import type { InstalledSkillView } from "@/lib/ipc";

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
