// 「有没有可用更新」的唯一判定。商店卡片、详情面板底部、我的技能三处共用
// ——三处各写一份正是缺陷的温床:2026-08-03 用户实测时,卡片算出"更新"、
// 详情面板却只认 install/installed 两档,点进去按钮是禁用的,点了没反应。

/** 某个技能在当前索引里的远端内容指纹;索引里没有它就是空串。 */
export function remoteHashOf(
  index: { skills: { dirSlug: string; contentHash: string }[] } | null | undefined,
  dirSlug: string,
): string {
  return index?.skills.find((s) => s.dirSlug === dirSlug)?.contentHash ?? "";
}

/**
 * 卡片/详情按钮的三档状态。
 *
 * 比的是**这个技能自己**的内容指纹,不是整库 HEAD sha:后者会让别人分享任意一个
 * 技能就把全部已装技能标成"有更新"。任一侧指纹缺失(旧记账、认领来的)时按
 * "已启用"处理——宁可漏报,也不能凭空催所有人去更新。
 */
export function cardState(
  record: { contentHash: string } | undefined,
  remoteHash: string,
): "install" | "installed" | "update" {
  if (!record) return "install";
  if (!remoteHash || !record.contentHash) return "installed";
  return record.contentHash === remoteHash ? "installed" : "update";
}
