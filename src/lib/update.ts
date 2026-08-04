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

/** 当前浏览的技能库坐标。判定要比到库,不只是源(M4 一源多仓)。 */
export interface LibraryRef {
  registryId: string;
  owner: string;
  repo: string;
}

/** 已装记账里与判定有关的部分。来源坐标缺失(旧状态)时按"同库"处理,行为退回 M3。 */
export interface InstalledRecord {
  contentHash: string;
  registryId?: string;
  sourceOwner?: string;
  sourceRepo?: string;
}

/**
 * 卡片/详情按钮的四档状态。
 *
 * 比的是**这个技能自己**的内容指纹,不是整库 HEAD sha:后者会让别人分享任意一个
 * 技能就把全部已装技能标成"有更新"。任一侧指纹缺失(旧记账、认领来的)时按
 * "已启用"处理——宁可漏报,也不能凭空催所有人去更新。
 *
 * `otherLibrary` 这一档是 M4 一源多仓加的:同名技能装自另一个技能库时,内容当然
 * 不一样,但那**不是更新**——点下去是"用另一个库的同名技能替换掉现有的",两者可能
 * 毫无关系。标成"更新"既是假话,也会把用户引向一次没预期的替换(core 的 precheck
 * 会拦下来要求拍板,但界面不能先撒谎再让 core 兜底)。
 */
export function cardState(
  record: InstalledRecord | undefined,
  remoteHash: string,
  /** 当前浏览的库;省略 = 调用方不区分库(判定退回 M3 口径)。 */
  library?: LibraryRef,
): "install" | "installed" | "update" | "otherLibrary" {
  if (!record) return "install";
  if (library && record.registryId && record.sourceOwner && record.sourceRepo) {
    const sameLibrary =
      record.registryId === library.registryId &&
      record.sourceOwner === library.owner &&
      record.sourceRepo === library.repo;
    if (!sameLibrary) return "otherLibrary";
  }
  if (!remoteHash || !record.contentHash) return "installed";
  return record.contentHash === remoteHash ? "installed" : "update";
}
