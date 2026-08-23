// 「我分享的」区块的六状态机(v6 任务 4)。
//
// core 的 `InstalledSkillView.relation` 只回答"这是不是我的技能",不回答
// "库里那一版有没有变"——那件事**只有一处判定实现**(`store/my-skills.ts` 的
// `hasUpdate`,与商店卡片、详情面板底部共用),core 再算一份就是第二本账
// (`CLAUDE.md` 记的既有教训:2026-08-03 那次"卡片说有更新、按钮却是禁用的"
// 就是三处各写一份判定造成的)。
//
// 所以本模块**不接触索引、不算指纹**,只吃调用方已经算好的 `remoteChanged`
// 布尔值,自己只管把 `relation`/`localPresent`/`localModified` 三个已知量
// 折成六个人话状态。
import type { InstalledSkillView } from "@/lib/ipc";

export type SharedState = "synced" | "localAhead" | "remoteAhead" | "both" | "draft" | "notHere";

/**
 * 六状态判定表(与 brief 逐字一致,按优先级从上到下短路):
 *
 * | 条件 | 状态 |
 * |---|---|
 * | `relation === "draft"` | `draft` |
 * | `!localPresent` | `notHere` |
 * | `localModified && remoteChanged` | `both` |
 * | `localModified` | `localAhead` |
 * | `remoteChanged` | `remoteAhead` |
 * | 其余 | `synced` |
 *
 * `draft` 优先于 `notHere`:草稿从没在库里出现过,"不在这台电脑"这句话
 * 对它没有意义(它本来就只活在这台电脑上)。
 * `notHere` 优先于改动判定:本体都不在了,"本地有没有改过"无从谈起。
 */
export function sharedState(
  skill: Pick<InstalledSkillView, "relation" | "localPresent" | "localModified">,
  remoteChanged: boolean,
): SharedState {
  if (skill.relation === "draft") return "draft";
  if (!skill.localPresent) return "notHere";
  if (skill.localModified && remoteChanged) return "both";
  if (skill.localModified) return "localAhead";
  if (remoteChanged) return "remoteAhead";
  return "synced";
}
