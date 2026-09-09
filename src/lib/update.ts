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
 * 这台电脑上某个 dirSlug 本体此刻的实时指纹(v7.5,`cardState` 新形参
 * `localHash` 的数据来源)。数据来自 `useMySkills` 的 `list`,只取
 * `localPresent === true` 的行——`list` 为 `null`(还没加载过)或找不到这一行
 * 都返回 `undefined`,与 `cardState` 里"本机没有本体"是同一个信号。
 *
 * 与 `remoteHashOf` 同一种"单一实现供多处复用"的姿势,但语义相反:那个答的是
 * "库里这一版长什么样",这个答的是"这台电脑上现在长什么样"。
 */
export function localHashOf(
  list: { dirSlug: string; localPresent: boolean; localHash: string }[] | null | undefined,
  dirSlug: string,
): string | undefined {
  return list?.find((s) => s.dirSlug === dirSlug && s.localPresent)?.localHash;
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
  /**
   * 本地是否改过安装那一刻的内容。**`cardState` 自身自 v7.4 起不读这个字段**
   * ——v6 加的「我分享的」四档已撤销,商店的按钮状态不再区分"本地改没改"。
   * 字段留在这里是给调用方(如 `InstallPanel` 的本地改动徽标)传值用的,
   * 与 `cardState` 的判定逻辑无关。
   */
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
 * 发明一套。**唯一一处实现**——商店卡片的「我分享的」徽标(`store.mineBadge`)调它。
 * `cardState` 自 v7.4 起不再调用它(用户第 9 轮拷问拍板撤掉商店卡片的作者四档,
 * 见 `cardState` 文档注释):商店只回答"我有没有 / 我要不要",不再回答"这是不是我的"。
 */
export function isMine(author: string | null | undefined, me: MeRef | null | undefined): boolean {
  return !!author && !!me && (author === me.displayName || author === me.login);
}

export type CardState =
  | "install"
  | "installed"
  | "update"
  | "otherLibrary"
  // v7.5 新增,见下面文档注释「本机本体」一节。**只在 `!record` 时可达**——
  // 有记账时走既有四档,一个字没变。
  | "onDisk"
  | "onDiskDiffers";

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
 * **v7.4 起不再判"这是不是我分享的"**(撤掉了 v6 加的 `mineSynced`/`minePull`/
 * `mineShareUpdate`/`mineBoth` 四档,用户第 9 轮拷问拍板:「取回」一词背三种意思、
 * 「已同步」回答的是没人问的问题,商店只该回答"我有没有 / 我要不要"这一件事)。
 * `record.localModified` 因此**从不参与这里的判定**——本地改没改是"我的技能"页
 * 该回答的问题,不是商店。这不代表作者的安全机制消失了:库里有新版时(不论本地改
 * 没改)`otherLibrary`/内容指纹比对仍会照常判成 `update`,点下去 core 的
 * `acquire::precheck` 依然会返回 `Precheck::Mine` 触发冲突框——那条折叠机制原样
 * 保留在 `core/acquire.rs`,这里删掉的只是展示层的四个分支,不是背后的判定。
 *
 * **`otherLibrary` 判定必须排在「按内容指纹比对」之前**,与 core
 * `acquire::precheck` 的判定顺序一致(`ownership` 一节记的裁定):两个库的同名
 * 技能是两个东西,即便内容恰好相同,"用另一个库的版本替换掉现有的"仍然必须由
 * 用户拍板,不能被内容指纹比对当成"已是最新"悄悄放过。
 *
 * ## 本机本体(v7.5,`docs/v7.5-共识.md` Q33–Q43)
 *
 * 起因:商店卡片此前只问「我**装**过吗」(读 `record`,即 `state.installed` 记账),
 * 而在 Claude Code 里原创、走「开分支+提交审核」分享的技能——本体明明在磁盘上,
 * 只是没有记账(`adopt_into_management` 只认直推)——卡片对着用户自己的原稿写
 * 「获取」。同样的假话适用于任何本机有本体但无记账的技能:npx 装的、自己写的
 * 草稿、换电脑后 git 拉的。
 *
 * `!record` 分支因此改成会先看 `localHash`(这台电脑上这个 `dirSlug` 的本体
 * 指纹,来自 `useMySkills` 的 `list`,`localPresent === true` 的行才有值):
 * `localHash === undefined` = 本机确实没有本体,才是真的 `install`;
 * 否则按内容分两档 —— 与库里逐字节相同(或任一侧指纹读不到,**宁可漏报**,
 * 与既有"任一侧指纹为空按没有更新处理"同源)算 `onDisk`,不同算 `onDiskDiffers`。
 *
 * 🔴 **判据只认 `dirSlug`,不判"是不是同一个技能"**(用户 Q37-B 明确拍板,
 * 是**接受代价的显式选择**,不是遗漏)。本机 `weekly-report` 草稿撞上库里一个
 * 完全无关的 `weekly-report` 时,会显示「与库里不同」——"与"字暗示是同一个技能
 * 的两份,而其实两者可能毫无关系。**别顺手加 description/authors 这类"是不是
 * 同一个技能"的判据去"修"这条**:那是拿更多的猜去补一个猜,而且 authors 只对
 * 公司库有,广场技能永远补不上。出路是详情底部的「换成库里的版本」——点下去走
 * 既有的 `acquire`,`precheck` 会用真实内容比对把误判拦成 `LocalDiffers`/`Mine`
 * 拍板框,磁盘在用户拍板前一个字节都不会动。
 *
 * 这一档也**永远不会说「有更新」**:没有安装基线,方向判不出来(同
 * `my-skills.ts` 的 `localDiffersNoBaseline`)。出路同样是「换成库里的版本」
 * ——点一次走完 acquire,记账就建起来了,之后才回到 `update`/`installed` 那两档。
 *
 * 广场卡片(`PlazaSkillCard`)没有内容指纹,`remoteHash` 恒传空串,因此永远落进
 * "指纹缺失按相同处理"那一支,只会显示 `onDisk`——**这是刻意的漏报**(Q43-A):
 * 内容其实不同也说"已在电脑上",与既有"任一侧指纹为空按没有更新处理"同源。
 */
export function cardState(
  record: InstalledRecord | undefined,
  remoteHash: string,
  /** 当前浏览的库;省略 = 调用方不区分库(判定退回 M3 口径)。 */
  library?: LibraryRef,
  /**
   * 这台电脑上这个 dirSlug 的本体指纹(来自 `useMySkills` 的 `list`,
   * `localPresent === true` 的行);`undefined` = 本机没有本体。
   * 空串 = 有本体但指纹读不到,按"无从比较"处理。**只在 `!record` 时读取**。
   */
  localHash?: string,
): CardState {
  if (!record) {
    if (localHash === undefined) return "install";
    // 任一侧指纹缺失 → 按"相同"处理。这是**刻意的漏报**:说「已在电脑上」在
    // "本机确实有个同名技能"时是真的、只是没说全;说「获取」在东西已经躺在
    // 磁盘上时是纯粹的假。与既有"任一侧指纹为空按没有更新处理"同源。
    // 广场那一侧永远走这一支(PlazaSkillCard 没有内容指纹)。
    if (!localHash || !remoteHash) return "onDisk";
    return localHash === remoteHash ? "onDisk" : "onDiskDiffers";
  }
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
