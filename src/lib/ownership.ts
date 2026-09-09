// 「我的技能」每一行的状态判定(v6 二期任务 7 重写;v7 任务 7 删旧留新)。
//
// core 的 `InstalledSkillView.relation` 只回答"这是不是我的技能",不回答
// "库里那一版有没有变"——那件事**只有一处判定实现**(`store/my-skills.ts` 的
// `hasUpdate`,与商店卡片、详情面板底部共用),core 再算一份就是第二本账
// (`CLAUDE.md` 记的既有教训:2026-08-03 那次"卡片说有更新、按钮却是禁用的"
// 就是三处各写一份判定造成的)。
//
// 所以本模块**不接触索引、不算指纹**,只吃调用方已经算好的布尔量
// (`remoteChanged`),自己只管把它与 core 给的
// `section`/`versions`/`shareBlocked`/`review`/`localModified`/`localPresent`
// 折成"这一行现在该摆哪颗按钮"。
//
// 🔴 **v6 二期的 `sharedState`/`SharedState`(八态机,回答"这一行现在是什么状态")
// 已随旧的两分区页一起删除**:`rowAction`(下面)在任务 4 就接管了它的全部职责
// ——"摆哪颗按钮"本就是"是什么状态"的下一步,两问一答揉进一个函数不算重复。
// 它当年的判定顺序(versions 最优先 / 无基线档压过改动判定三档)现在活在
// `rowAction` 的短路顺序里,道理没丢,只是不再单独占一个函数。
import type { MessageKey } from "@/i18n";
import type { InstalledSkillView, ShareBlock } from "@/lib/ipc";

// ---------------------------------------------------------------------------
// v7:「我的技能」重设计 —— 三区(installedFrom/sharedTo/shareable)+ 每行至多
// 一颗主按钮。
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
  /**
   * 分享前的标准校验没过(A-2 拍板不复议的硬规则:分享前按 Agent Skills 标准
   * 全量校验,不合格不让分享)。🔴 **v7 任务 7 修复轮 1(C1)**:这一档以前
   * 只在 `shareable` 区判——`installedFrom`(贡献更改)与 `sharedTo`(分享改动)
   * 同样会把本地内容推去评审(`skill_share_changes`),同一道闸必须在三个区
   * 都生效,否则用户在 Claude Code 里把 name 改成不合规的值,点一下就直推
   * 进公司技能库,是终审 C-3 明确点名要堵住的旗舰场景。`blockedAction` 记着
   * 这一档本来该是哪个动作,界面据此选对按钮文案(「分享」/「贡献更改」/
   * 「分享改动」),不是每次都说「分享」。
   */
  | { kind: "shareBlocked"; reason: ShareBlock; blockedAction: "share" | "contribute" | "shareChanges" }
  | { kind: "underReview"; url: string | null }
  | { kind: "chooseVersion" }; // 压过一切

/**
 * 「我的技能」v7 每行主按钮的判定表(十档,brief 九档 + R3 追加的 `pull`)。
 *
 * # 短路顺序(从上到下,排错位置就会误判)
 *
 * 1. **`versions.length > 1` 压过一切。** 磁盘上有几份内容不同的实体时,
 *    "改没改过""库里新不新"这些问题都没有一个确定的主语(拿哪一份去比?)。
 *    与已删除的 `sharedState`(v6 二期八态机)的第 1 档同一个理由,原样搬过来。
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
 *   `rowAction` 自己不碰索引(本模块头的既有教训:判定只能有一处实现,
 *   这里不重新发明第二套"有没有更新")。
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
    if (skill.shareBlocked) {
      return { kind: "shareBlocked", reason: skill.shareBlocked, blockedAction: "share" };
    }
    if (remoteChanged) return { kind: "update" };
    return { kind: "share" };
  }

  if (skill.section === "installedFrom") {
    if (skill.localModified && remoteChanged) return { kind: "conflict" };
    if (remoteChanged) return { kind: "update" };
    if (skill.localModified) {
      // 🔴 C1:贡献更改一样要过标准校验这道闸,不是 shareable 区的专利。
      if (skill.shareBlocked) {
        return { kind: "shareBlocked", reason: skill.shareBlocked, blockedAction: "contribute" };
      }
      return { kind: "contribute" };
    }
    return { kind: "none" };
  }

  // sharedTo
  if (remoteChanged) return { kind: "conflict" };
  if (skill.localModified) {
    // 🔴 C1:分享改动同样要过标准校验这道闸。
    if (skill.shareBlocked) {
      return { kind: "shareBlocked", reason: skill.shareBlocked, blockedAction: "shareChanges" };
    }
    return { kind: "shareChanges" };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// 「更多」菜单的条目判定表(终审 §12 修复:从 `MySkillsPage.tsx` 的 `Row` 抠出来,
// 供「我的技能」列表行与详情面板动作区共用同一份判定——分开各写一遍正是本项目
// 记录的空转测试模式 #1,详情面板此前压根没有动作区(终审 C-3)。
// ---------------------------------------------------------------------------

export type RowMenuItemKind =
  | "reveal"
  | "contributeOrShareChanges"
  | "update"
  | "share"
  | "useLibraryVersion"
  | "remove";

/** 一条「…」菜单项的**判定结果**,不含 `onClick`——两处调用方(行 / 详情动作区)
 *  各自把 `kind` 翻成自己那份回调,标签与出现条件只有这一处判定。 */
export interface RowMenuItemSpec {
  kind: RowMenuItemKind;
  labelKey: MessageKey;
  titleKey?: MessageKey;
  /** 在这一项**上方**画一条分隔线(只用在「移除」这类破坏性动作前面)。 */
  separatorBefore?: boolean;
}

/**
 * 「更多」菜单该摆哪几项、摆什么文案——逐字对应 `MySkillsPage.tsx` 的 `Row`
 * 修复轮 1/2 定下的规则(design §8「不可用项不显示」),原样搬出来:
 *
 * 1. 有本体就有「打开文件夹」;
 * 2. `conflict` 压过主按钮之后,「贡献更改」/「分享改动」不会消失——用户可能就是
 *    想直接推去评审,不想先经过冲突框的三选一。**必须再叠一道 `!shareBlocked`**
 *    ——C1 刚在主按钮堵上"不合规内容也能推去评审"这个洞,这里若不重复同一道闸,
 *    用户仍能从「更多」菜单绕过去点一个必然报 `FS_SKILL_INVALID` 的按钮;
 * 3. `shareable` 区内,被压过一头、暂时不是主按钮的动作退进这里(不会丢失);
 * 4. 没有安装基线但本体与库不一样时,「改用库里的版本」是这一档唯一的出口;
 * 5. 破坏性动作(移除)放最后,并加分隔线——防止手滑。
 */
export function buildRowMenuItems(
  skill: Pick<InstalledSkillView, "body" | "localPresent" | "localModified" | "shareBlocked" | "section">,
  action: RowAction,
  remoteChanged: boolean,
  noBaselineDiffers: boolean,
): RowMenuItemSpec[] {
  const items: RowMenuItemSpec[] = [];
  if (skill.body) {
    items.push({ kind: "reveal", labelKey: "mine.openFolder" });
  }
  if (action.kind === "conflict" && skill.localModified && !skill.shareBlocked) {
    items.push({
      kind: "contributeOrShareChanges",
      labelKey: skill.section === "installedFrom" ? "mine.contribute" : "mine.shareChanges",
    });
  }
  if (skill.section === "shareable") {
    if (action.kind === "shareBlocked" && remoteChanged) {
      items.push({ kind: "update", labelKey: "mine.update" });
    } else if (action.kind === "update") {
      items.push({ kind: "share", labelKey: "mine.share" });
    }
  }
  if (noBaselineDiffers) {
    items.push({
      kind: "useLibraryVersion",
      labelKey: "mine.useLibraryVersion",
      titleKey: "mine.useLibraryVersionHint",
    });
  }
  if (skill.localPresent && action.kind !== "chooseVersion") {
    items.push({ kind: "remove", labelKey: "mine.remove", separatorBefore: items.length > 0 });
  }
  return items;
}

// ---------------------------------------------------------------------------
// v7 追加(分区折叠):折叠头上的「N 个要处理」判定。
// ---------------------------------------------------------------------------

/**
 * 这一行有没有「需要用户看一眼或动手」的事——分区折叠头上那个计数的唯一判据。
 *
 * # 为什么必须有它,而不是复用页头那几个数
 *
 * 页头能给的只有 `updatesCount`(可一键更新的行,v7.3 起写在「全部更新 · N」
 * 那颗按钮上)与曾经的 `unsyncedCount`(有改动未分享,v7.3 Q28-C 已撤),
 * 而 `rowAction` 还有 `conflict` / `chooseVersion` / `shareBlocked` / `underReview`
 * 这些既不算"有更新"也不算"有改动未分享"的档。分区折叠一旦把这些行藏起来,
 * 而头上又没把它们数出来,v7「只写例外」这条承诺就被折叠打穿了——用户折起来
 * 就再也看不见那件事。所以这里按**每行真实算出的 `rowAction`** 判,不抄那些数。
 * (v7.3 起页签角标用的也是本函数——逐栏报"有几件事等你",比整页汇总更精确,
 * 这正是那两段整页汇总文字被撤掉的理由。)
 *
 * # 🔴 与 `sections()` 的 `hasAction` 是**两把刻意不同的尺子**,别"统一"掉
 *
 * `sections()` 里的 `hasAction`(`kind !== "none"`)问的是"这一行有没有主按钮"
 * ——用来把有按钮的行排到区内前面,所以它**包含** `share`。
 * 本函数问的是"折起来会不会藏掉一件事"——所以它**排除** `share`。
 * 最根本的理由是 v7 的产品原则「**只写例外**」:「可分享到」区里一个健康草稿
 * **能**被分享,是那个区的**常态**,不是例外——把常态计成"要处理",等于把这条
 * 原则反过来用。附带的后果也确实难看:该区的计数会恒等于总数
 * (「可分享到技能库 · 12 · 12 个要处理」),纯噪音,还会把「安装自」区里真正的
 * 两条冲突淹掉。
 *
 * 反过来 `underReview` **要计入**:它虽然没有按钮可点(审核结果不由用户这一步
 * 决定),但"有一条正在审"是用户折起来之后会丢失的感知,正是「只写例外」要保住的。
 *
 * # 穷尽 switch,不留 `default`
 *
 * 将来往 {@link RowAction} 加新档时,这里会当场 `tsc` 报错要求表态——本项目的既有
 * 教训:"约定会被下一个人无声打破,类型不会"。
 */
export function needsAttention(action: RowAction): boolean {
  switch (action.kind) {
    // `share` =「可分享到」区的默认态,不是例外(见上面的文档)。
    case "none":
    case "share":
      return false;
    case "pull":
    case "update":
    case "conflict":
    case "contribute":
    case "shareChanges":
    case "shareBlocked":
    case "underReview":
    case "chooseVersion":
      return true;
  }
}
