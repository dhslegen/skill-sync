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
 * 「我的技能」v7 每行主按钮的判定表(十一档,brief 十档 + R3 追加的 `pull`)。
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
