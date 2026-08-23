// 「我分享的」区块的六状态机(v6 任务 4)。
//
// core 的 `InstalledSkillView.relation` 只回答"这是不是我的技能",不回答
// "库里那一版有没有变"——那件事**只有一处判定实现**(`store/my-skills.ts` 的
// `hasUpdate`,与商店卡片、详情面板底部共用),core 再算一份就是第二本账
// (`CLAUDE.md` 记的既有教训:2026-08-03 那次"卡片说有更新、按钮却是禁用的"
// 就是三处各写一份判定造成的)。
//
// 所以本模块**不接触索引、不算指纹**,只吃调用方已经算好的 `remoteChanged`
// 布尔值,自己只管把 `relation`/`localPresent`/`localModified`/`contentHash`
// 四个已知量折成七个人话状态。
import type { InstalledSkillView } from "@/lib/ipc";

export type SharedState =
  | "synced"
  | "localAhead"
  | "remoteAhead"
  | "both"
  | "draft"
  | "notHere"
  | "noBaseline";

/**
 * 七状态判定表(六状态机 + `noBaseline`,按优先级从上到下短路):
 *
 * | 条件 | 状态 |
 * |---|---|
 * | `relation === "draft"` | `draft` |
 * | `!localPresent` | `notHere` |
 * | `!contentHash` | `noBaseline` |
 * | `localModified && remoteChanged` | `both` |
 * | `localModified` | `localAhead` |
 * | `remoteChanged` | `remoteAhead` |
 * | 其余 | `synced` |
 *
 * `draft` 优先于 `notHere`:草稿从没在库里出现过,"不在这台电脑"这句话
 * 对它没有意义(它本来就只活在这台电脑上)。
 * `notHere` 优先于改动判定:本体都不在了,"本地有没有改过"无从谈起。
 *
 * 🔴 `noBaseline` 必须压过 `both`/`localAhead`/`remoteAhead`(而不是排在它们
 * 之后)——这三档全部依赖 `localModified`/`remoteChanged` 背后那份"安装那一刻
 * 的内容基线",而这一档**根本没有基线**:`relation === "shared"` 且本地有本体,
 * 但没有 `state.installed` 记账(典型场景:确实是作者,但直接经 git 推进库,
 * 没经过本 app 装过)。core 侧对这种行恒填 `localModified: false` 且
 * `contentHash: ""`(`core/my_skills.rs` 的候选合并那一档),没有基线却断言
 * "已同步"或"有改动未分享"都是在编——先判 `noBaseline` 才不会拿假数据得结论。
 *
 * `!contentHash` 是可靠判据:写 `state.installed.contentHash` 的两处
 * (`core/acquire.rs::record` 与 `core/share.rs::adopt_into_management`/
 * `share_installed`)都经 `fsops::dir_content_hash` 算出真实哈希,该函数对
 * 任意目录(含空目录)返回的都是一个非空的十六进制摘要,不会产出空串;
 * 唯一会让这个字段留空的,是**从没走过这两条写入路径**——旧的 claim 链路会
 * 留空 `commitSha` 但 `contentHash` 有值,而 claim 已经被 v6 任务 2 整条删掉,
 * 因此走到这里时 `!contentHash` 只对应"没有 `state.installed` 记账"这一种情况。
 */
export function sharedState(
  skill: Pick<InstalledSkillView, "relation" | "localPresent" | "localModified" | "contentHash">,
  remoteChanged: boolean,
): SharedState {
  if (skill.relation === "draft") return "draft";
  if (!skill.localPresent) return "notHere";
  if (!skill.contentHash) return "noBaseline";
  if (skill.localModified && remoteChanged) return "both";
  if (skill.localModified) return "localAhead";
  if (remoteChanged) return "remoteAhead";
  return "synced";
}
