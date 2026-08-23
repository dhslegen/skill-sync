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
  /** 本地是否改过安装那一刻的内容(v6:「我分享的」四档要用它分流)。 */
  localModified?: boolean;
  registryId?: string;
  sourceOwner?: string;
  sourceRepo?: string;
}

/** 判「这是不是我」要用的最小身份——与 `SessionUser` 字段重叠,刻意只取比对要用的两个。 */
export interface MeRef {
  login: string;
  displayName: string;
}

/**
 * 名字是否与登录身份的任一写法相同(展示名优先、登录名兜底)。
 *
 * 与 core `ownership::is_same_person` 同一个比对口径(`authors.json` 写入时就是
 * 按这两种写法二选一存的,见 `core/share.rs::claim_attribution`),前端这里不重新
 * 发明一套。**唯一一处实现**——商店卡片的「我分享的」徽标与 `cardState` 都调它,
 * 不各自比一遍(CLAUDE.md 记的教训:同一条规则查两遍,其中一遍迟早会漂)。
 */
export function isMine(author: string | null | undefined, me: MeRef | null | undefined): boolean {
  return !!author && !!me && (author === me.displayName || author === me.login);
}

export type CardState =
  | "install"
  | "installed"
  | "update"
  | "otherLibrary"
  /** 技能库里记的分享者是我(v6),四档按「本地/远端各自有没有变」折出来。 */
  | "mineSynced"
  | "minePull"
  | "mineShareUpdate"
  | "mineBoth";

/**
 * 卡片/详情按钮的状态机。
 *
 * 比的是**这个技能自己**的内容指纹,不是整库 HEAD sha:后者会让别人分享任意一个
 * 技能就把全部已装技能标成"有更新"。任一侧指纹缺失(旧记账、认领来的)时按
 * "已启用"处理——宁可漏报,也不能凭空催所有人去更新。
 *
 * `otherLibrary` 这一档是 M4 一源多仓加的:同名技能装自另一个技能库时,内容当然
 * 不一样,但那**不是更新**——点下去是"用另一个库的同名技能替换掉现有的",两者可能
 * 毫无关系。标成"更新"既是假话,也会把用户引向一次没预期的替换(core 的 precheck
 * 会拦下来要求拍板,但界面不能先撒谎再让 core 兜底)。
 *
 * **`author === me` 时永不返回 `install`/`installed`/`update`**(v6):库里记的
 * 分享者就是当前登录的这个人,"获取/更新"这两个词对自己的技能不成立——按
 * `localModified`/远端指纹折成 `mineSynced`(都没变)/`minePull`(只有远端变,
 * 典型场景:同事经审核改过)/`mineShareUpdate`(只有本地变,还没分享上去)/
 * `mineBoth`(两边都变,需要拍板)。
 *
 * **`otherLibrary` 判定要排在 mine 折叠之前**,与 core `acquire::precheck`
 * 的判定顺序一致(`ownership` 一节记的裁定):两个库的同名技能是两个东西,
 * 哪怕两边的作者都是我,"用另一个库的版本替换掉现有的"仍然必须由用户拍板——
 * 这一档不受 mine 影响。
 */
export function cardState(
  record: InstalledRecord | undefined,
  remoteHash: string,
  /** 当前浏览的库;省略 = 调用方不区分库(判定退回 M3 口径)。 */
  library?: LibraryRef,
  /** 这个技能库里记的分享者(authors.json,`null` = 库里没写)。 */
  author?: string | null,
  /** 当前登录身份;省略/`null` = 不判定"是不是我"(行为退回 mine 加入前的口径)。 */
  me?: MeRef | null,
): CardState {
  const mine = isMine(author, me);
  if (!record) return mine ? "minePull" : "install";
  if (library && record.registryId && record.sourceOwner && record.sourceRepo) {
    const sameLibrary =
      record.registryId === library.registryId &&
      record.sourceOwner === library.owner &&
      record.sourceRepo === library.repo;
    if (!sameLibrary) return "otherLibrary";
  }
  if (!mine) {
    if (!remoteHash || !record.contentHash) return "installed";
    return record.contentHash === remoteHash ? "installed" : "update";
  }
  const remoteChanged = !!remoteHash && !!record.contentHash && record.contentHash !== remoteHash;
  const localChanged = !!record.localModified;
  if (localChanged && remoteChanged) return "mineBoth";
  if (localChanged) return "mineShareUpdate";
  if (remoteChanged) return "minePull";
  return "mineSynced";
}
