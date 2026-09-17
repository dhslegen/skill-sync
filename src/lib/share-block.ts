import type { MessageKey } from "@/i18n";
import type { ShareBlock, ShareMode } from "@/lib/ipc";

/**
 * 「为什么这个技能现在不能分享」的人话文案表(A-2 / A-5)。
 *
 * # 为什么单独一个模块
 *
 * 消费者有两处:分享确认屏(`components/ShareConfirm.tsx`)与「我的技能」的行内
 * 提示(`pages/MySkillsPage.tsx` 的 `Row`)。**抄成两份必然漂移**——这个项目已经
 * 为"同一条规则两份实现"付过好几次代价(slug 口径、更新判定)。判据在 core
 * (`skills::validate_skill_dir`),文案在这里,两处只查表。
 *
 * `ShareBlock` 是**穷尽的**联合,所以这张表用 `Record` 而不是可选查表:
 * core 那侧新增一档时,tsc 会当场要求这里补一句人话,而不是让界面静默地
 * 什么都不说。
 */
export const SHARE_BLOCK_LABEL: Record<ShareBlock, MessageKey> = {
  nameMissing: "mine.shareBlocked.nameMissing",
  nameMismatch: "mine.shareBlocked.nameMismatch",
  nameFormat: "mine.shareBlocked.nameFormat",
  dirFormat: "mine.shareBlocked.dirFormat",
  descriptionMissing: "mine.shareBlocked.descriptionMissing",
  descriptionTooLong: "mine.shareBlocked.descriptionTooLong",
  skillMdUnreadable: "mine.shareBlocked.skillMdUnreadable",
};

/**
 * 这一次分享**走的是哪条路**——`shareDone`/`shareError` 随结果一起记下来
 * (终审复审轮 1,#3 裁定)。
 *
 * - `"share"`:首次把一个技能分享到公司技能库(`skill_share`,确认屏那条路);
 * - `"changes"`:把一个**已有**技能的改动推回去(`skill_share_changes`,
 *   「贡献更改」/「分享改动」)。
 *
 * 🔴 **为什么记在 store 里,而不是在渲染时看 `rowAction` 分流**:反馈是在动作
 * **完成之后**显示的,而 `confirmShare` 成功后会 `load()` 重刷整张列表——首次
 * 分享成功的那一行,`relation` 会从 `draft` 变成 `shared`、`section` 从
 * `shareable` 变成 `sharedTo`、`rowAction` 也跟着换档。拿渲染那一刻的 `action`
 * 反推"刚才做的是哪件事",答案恰恰在成功路径上是错的。
 */
export type ShareFlow = "share" | "changes";

/**
 * 分享结果的人话文案表。**两条路的说法必须不一样**:
 * 「分享改动」这三个键长在只可能是"推回改动"的落点上,而终审 §12 把分享动作搬进
 * 详情面板动作区之后,**首次分享**也会走到同一个渲染点——再沿用它们,用户第一次
 * 分享一个新技能时会被告知「**改动**已分享」,而他并没有改动过什么。
 * 「措辞跟着语义走」在本期已经打回过四次,这里不再犯。
 *
 * 用 `Record` 而不是若干个 `if`:两条路 × 落地方式穷尽,少写一格 tsc 当场报错,
 * 不会静默漏掉某一档。`ShareMode` 自 v8 任务 3 起只剩 `pushed` 一档
 * (提交审核整条下线),**结构刻意不压平**——core 仍如实回报这次做成了什么,
 * 将来再多一档时这里会当场要求补一句人话。
 */
export const SHARE_DONE_LABEL: Record<ShareFlow, Record<ShareMode, MessageKey>> = {
  share: { pushed: "mine.shareDone" },
  changes: { pushed: "mine.shareChangesDone" },
};

/** 同上,失败侧。`mine.shareFailed`(「分享没能完成」)是既有键,确认屏一直在用。 */
export const SHARE_FAILED_LABEL: Record<ShareFlow, MessageKey> = {
  share: "mine.shareFailed",
  changes: "mine.shareChangesFailed",
};
