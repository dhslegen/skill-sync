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

export type CardState = "install" | "onDisk" | "update" | "differs" | "otherLibrary";

/**
 * 卡片/详情按钮的状态机。
 *
 * ## v7.6:状态词只讲磁盘,记账只回答"从哪来"(`docs/v7.6-共识.md`,用户第
 * 14–15 轮拷问 Q44–Q49 拍板,原话:「还是以技能 slug 为真相,平台记账只是加速
 * 判断而不是世界本身,去掉已安装,统一为已在电脑上」)
 *
 * 起因:真机截图里同屏出现两句打架的话——顶部「安装自技能库」(`section`,问
 * "这是不是公司库里的东西",与装没装无关)、底部「已在电脑上」(v7.5 的
 * `onDisk`,真实语义其实是"本机有本体 **且** 我们没有记账")。根子是把两类
 * 东西混在一起判:**事实**(磁盘的字节 vs 库里的字节,磁盘能回答全部)与
 * **能力**(从哪装的、装时什么样,记账是**唯一载体**,磁盘上根本不存在)。
 * 两条对称推论(Q47-A/Q48-B):状态词只该讲事实 → 合并终态词;不能伪造历史去
 * 铸造能力 → 不自动补账(`docs/v7.6-共识.md` 记了完整的"为什么不自动补账"——
 * 会让 `acquire_batch` 静默覆盖一份与库不同的本地内容,是 R14 挡过一次的同一
 * 件事:「勾」这类无害动作不该让用户的草稿更容易被覆盖)。
 *
 * 判据(顺序不能变):
 * 1. `otherLibrary`——有账且来源库不同。判在最前,逻辑一个字不改(见下方既有
 *    说明),**不受 `localHash` 有没有值影响**。
 * 2. **磁盘上没有本体 → `install`**。这是本次拍板的核心:判定入口从"问账本"
 *    (`!record`)改成"问磁盘"(`!localPresent`,即 `localHash === undefined`)。
 *    副作用是对的:装了又被手动删掉目录的技能,从「已启用」变成「获取」——
 *    正确,不是回归。
 * 3. `localHash === remoteHash`(或任一为空,无从比较)→ `onDisk`
 *    ("已在电脑上")。这一档合并了 v7.5 之前的 `installed`(有账且指纹一致)
 *    与 v7.5 加的 `onDisk`(无账但本机有本体)——两者现在是**同一句话**:磁盘
 *    上这份内容和库里一样,与有没有记账无关。"任一为空按相同处理"是刻意的
 *    漏报(沿用 v7.5-Q43-A):广场那一侧永远走这一支
 *    (`PlazaSkillCard` 没有内容指纹)。
 * 4. 不一样,且有账,且 `localHash === record.contentHash` → `update`。这一条
 *    让「更新」比以前更准:旧判据不看 `localHash`,用户改过的技能只要库里也
 *    动了照样写「更新」,点下去才被 `precheck` 拦成拍板框。新判据下「更新」
 *    只在**点下去真的安全**(本地未改、只是库里前进了)时出现。
 * 5. 其余 → `differs`("与库里不同")。吸收了 v7.5 的 `onDiskDiffers`(无账、
 *    内容不同)**以及**旧的"有账但 `localHash` 与记账基线不同"(用户确实改过)
 *    ——这两种此前用不同的词描述("已启用"或"onDiskDiffers"),现在是同一件
 *    可见事实,不再有两个词。
 *
 * ⚠️ **三个行为翻转**(是拍板的直接推论,不是回归,`docs/v7.6-共识.md`):
 * 1. v7.4 曾钉住「装了、只有本地改 → 已启用」,现在翻成「与库里不同」——
 *    本地是否改过,现在完全靠**实时**指纹 `localHash` 与记账基线
 *    `record.contentHash` 的比对得出,`record.localModified` 依旧**不参与**
 *    这里的判定(那是"我的技能"页与详情徽标该回答的问题)。
 * 2. **「启用」这个词在别处(「已启用到 X、Y」、工具勾组)仍然正确**——它描述
 *    的是**工具关联**,与本次无关,禁止全局替换。
 * 3. 筛选器 chip 维持「已安装」(Q49-C),刻意与按钮用词不同——筛选与状态
 *    陈述服务于不同动作。
 *
 * 比的是**这个技能自己**的内容指纹,不是整库 HEAD sha:后者会让别人分享任意一个
 * 技能就把全部已装技能标成"有更新"。
 *
 * `otherLibrary` 这一档是 M4 一源多仓加的:同名技能装自另一个技能库时,内容当然
 * 不一样,但那**不是更新**——点下去是"用另一个库的同名技能替换掉现有的",两者可能
 * 毫无关系。标成"更新"既是假话,也会把用户引向一次没预期的替换(core 的 precheck
 * 会拦下来要求拍板,但界面不能先撒谎再让 core 兜底)。
 *
 * **v7.4 起不再判"这是不是我分享的"**(撤掉了 v6 加的 `mineSynced`/`minePull`/
 * `mineShareUpdate`/`mineBoth` 四档,用户第 9 轮拷问拍板:「取回」一词背三种意思、
 * 「已同步」回答的是没人问的问题,商店只该回答"我有没有 / 我要不要"这一件事)。
 * 这不代表作者的安全机制消失了:库里有新版时(不论本地改没改)`otherLibrary`/内容
 * 指纹比对仍会照常判成 `update`,点下去 core 的 `acquire::precheck` 依然会返回
 * `Precheck::Mine` 触发冲突框——那条折叠机制原样保留在 `core/acquire.rs`,这里
 * 删掉的只是展示层的分支,不是背后的判定。
 *
 * **`otherLibrary` 判定必须排在「按内容指纹比对」之前**,与 core
 * `acquire::precheck` 的判定顺序一致(`ownership` 一节记的裁定):两个库的同名
 * 技能是两个东西,即便内容恰好相同,"用另一个库的版本替换掉现有的"仍然必须由
 * 用户拍板,不能被内容指纹比对当成"已是最新"悄悄放过。
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
 * ——点一次走完 acquire,记账就建起来了,之后才回到 `update`/`onDisk` 那两档。
 *
 * 广场卡片(`PlazaSkillCard`)没有内容指纹,`remoteHash` 恒传空串,因此永远落进
 * "指纹缺失按相同处理"那一支,只会显示 `onDisk`——**这是刻意的漏报**(Q43-A):
 * 内容其实不同也说"已在电脑上",与既有"任一侧指纹为空按没有更新处理"同源。
 *
 * ## 如实留下的残留(`docs/v7.6-共识.md`,别说"全解决了")
 *
 * 无账技能**不进定时更新**(`scheduler.rs` 只遍历 `state.installed`)、
 * **移除摘不掉关联**(`remove.rs` 靠 `record.links`)——这是"记账是历史唯一
 * 载体"的诚实代价,不在本次改动范围内解决。
 */
export function cardState(
  record: InstalledRecord | undefined,
  remoteHash: string,
  /** 当前浏览的库;省略 = 调用方不区分库(判定退回 M3 口径)。 */
  library?: LibraryRef,
  /**
   * 这台电脑上这个 dirSlug 的本体指纹(来自 `useMySkills` 的 `list`,
   * `localPresent === true` 的行);`undefined` = 本机没有本体。
   * 空串 = 有本体但指纹读不到,按"无从比较"处理。
   *
   * 🔴 v7.6 起**无论有没有 `record` 都要读取**——它是新入口(第 2 条判据)的
   * 唯一依据,不再只在 `!record` 时才有意义。
   */
  localHash?: string,
): CardState {
  // 1. otherLibrary 判在最前,与 localHash 无关(见上方文档注释)。
  if (record && library && record.registryId && record.sourceOwner && record.sourceRepo) {
    const sameLibrary =
      record.registryId === library.registryId &&
      record.sourceOwner === library.owner &&
      record.sourceRepo === library.repo;
    if (!sameLibrary) return "otherLibrary";
  }
  // 2. 入口从"问账本"改成"问磁盘":不论有没有记账,磁盘上真的没有本体就是
  //    「获取」。装了又被手动删掉目录的技能,从「已启用」变成「获取」——这是
  //    拍板的核心推论,不是回归(`docs/v7.6-共识.md` Q47-A)。
  if (localHash === undefined) return "install";
  // 3. 任一侧指纹缺失 → 按"相同"处理,刻意的漏报(沿用 v7.5-Q43-A)。广场那
  //    一侧永远走这一支(`PlazaSkillCard` 没有内容指纹)。
  if (!localHash || !remoteHash || localHash === remoteHash) return "onDisk";
  // 4. 到这里磁盘内容与库里不同。只有"有账 且 磁盘与记账基线一致"才是安全的
  //    「更新」——本地没改、只是库里前进了,点下去 precheck 一定放行。
  if (record && localHash === record.contentHash) return "update";
  // 5. 其余情形(无账,或有账但本地确实改过)一律「与库里不同」。
  return "differs";
}
