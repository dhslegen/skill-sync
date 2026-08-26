import type { MessageKey } from "@/i18n";
import type { ShareBlock } from "@/lib/ipc";

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
