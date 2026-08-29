import { useState } from "react";

import { t } from "@/i18n";
import { isAppError, openLibraryUrl } from "@/lib/ipc";
import type { RowAction, RowMenuItemKind } from "@/lib/ownership";

/**
 * 「我的技能」一行主按钮的判定表 → 按钮控件,以及「…」菜单条目的判定结果
 * (`buildRowMenuItems`,见 `lib/ownership.ts`)→ 回调这两件事的**唯一实现**
 * (终审 §12)。
 *
 * # 为什么要单独抽出这个文件
 *
 * 此前只有 `MySkillsPage.tsx` 的 `Row` 用得到它;详情面板(`DetailPanel.tsx`)
 * 是一层浮出面板 + 遮罩,开着时行上的按钮不可达——用户想更新/分享/移除必须先
 * 关掉详情。design §12 要求详情面板自己也有一份"动作区",把行上主按钮与「…」
 * 各项全部再摆一遍(主填充、余描边)。两处必须共用**同一份**按钮渲染与「…」
 * 菜单的回调映射,不能各写一份——那正是本项目记录的空转测试模式 #1
 * (同一条规则查了/写了两遍,其中一份漂移不会被任何测试发现)。
 */
export function PrimaryAction({
  action,
  pulling,
  sharing,
  openVersions,
  onPull,
  onShareChanges,
  onShare,
  onChooseVersion,
}: {
  action: RowAction;
  pulling: boolean;
  sharing: boolean;
  openVersions: boolean;
  onPull: () => void;
  onShareChanges: () => void;
  onShare: () => void;
  onChooseVersion: () => void;
}) {
  switch (action.kind) {
    case "none":
      return null;
    case "chooseVersion":
      return (
        <SolidButton disabled={openVersions} onClick={onChooseVersion}>
          {t("mine.chooseVersion")}
        </SolidButton>
      );
    case "pull":
      return (
        <SolidButton disabled={pulling} onClick={onPull}>
          {pulling ? t("mine.pulling") : t("mine.pull")}
        </SolidButton>
      );
    case "update":
      return (
        <SolidButton disabled={pulling} onClick={onPull}>
          {pulling ? t("mine.updating") : t("mine.update")}
        </SolidButton>
      );
    case "conflict":
      // 浅色文字链形态:这一档不是"点了就做完",是"点了会先问你"。
      return (
        <button
          type="button"
          disabled={pulling}
          onClick={onPull}
          className="h-6 rounded-ctl px-1.5 text-[11.5px] font-medium text-text-2 underline decoration-dotted underline-offset-2 hover:text-text disabled:opacity-50"
        >
          {pulling ? t("mine.updating") : t("mine.conflictPending")}
        </button>
      );
    case "contribute":
      return (
        <OutlineButton disabled={sharing} onClick={onShareChanges}>
          {sharing ? t("mine.contributing") : t("mine.contribute")}
        </OutlineButton>
      );
    case "shareChanges":
      return (
        <OutlineButton disabled={sharing} onClick={onShareChanges}>
          {sharing ? t("mine.sharingChanges") : t("mine.shareChanges")}
        </OutlineButton>
      );
    case "share":
      return (
        <SolidButton disabled={sharing} onClick={onShare}>
          {t("mine.share")}
        </SolidButton>
      );
    case "shareBlocked": {
      // 🔴 C1:三个区都可能落进这一档,按钮文案要说对被拦下的是哪个动作
      // ——不是每次都说「分享」(那句话对 installedFrom/sharedTo 是错的)。
      const label =
        action.blockedAction === "contribute"
          ? t("mine.contribute")
          : action.blockedAction === "shareChanges"
            ? t("mine.shareChanges")
            : t("mine.share");
      const Btn = action.blockedAction === "share" ? SolidButton : OutlineButton;
      return (
        <Btn disabled onClick={() => {}}>
          {label}
        </Btn>
      );
    }
    case "underReview":
      return <ReviewPendingText url={action.url} />;
  }
}

/**
 * 「审核中」+(有链接时)「在技能库里查看」——`RowAction.underReview.url` 此前
 * 只在算出来就没有任何渲染点用过(I1 修复:v7 任务 7 修复轮 1)。
 *
 * 自己开一份局部错误状态,不复用页面级的 `revealError`——那个字段说的是
 * "打开文件夹"失败,这里是"打开外部链接"失败,是两件不同的事,合并成一个
 * 字段只会在两种失败同时发生时互相覆盖。与 `WhereBlocks.tsx` 的 `ReviewLink`
 * 是同一个模式的两处独立实现(那边服务详情面板「技能库里」那一块,这里服务
 * 主按钮 / 动作区,两处场景不同不共用状态,但都遵守"失败要有渲染点"这条硬规则)。
 */
export function ReviewPendingText({ url }: { url: string | null }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-1.5 px-1.5 text-[11.5px] text-text-3">
      {t("detail.whereReviewPending")}
      {url && (
        <button
          type="button"
          onClick={() => {
            setError(null);
            openLibraryUrl(url).catch((raw: unknown) =>
              setError(isAppError(raw) ? raw.message : t("error.generic")),
            );
          }}
          className="text-accent underline decoration-dotted underline-offset-2 hover:opacity-80"
        >
          {t("mine.reviewLink")}
        </button>
      )}
      {error && <span className="text-[#c0392b] dark:text-[#e0705f]">{error}</span>}
    </span>
  );
}

export function SolidButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function OutlineButton({
  disabled,
  title,
  onClick,
  children,
}: {
  disabled?: boolean;
  /** 原生 `title`(悬浮提示)。目前只有动作区的「改用库里的版本」用它说明后果。 */
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** {@link RowMenuItemKind} → 这一行/这个技能自己的那一套回调。`onReveal` 刻意
 *  收 `() => void`(不是 `(path) => void`)——两处调用方(行 / 详情动作区)
 *  拿到 `path` 的方式不同(行从入参 `skill.body` 现拼,详情面板直接闭包住
 *  `skill`),让这里多收一个参数只会把两处调用方都变得更绕。 */
export interface RowMenuHandlers {
  onReveal: () => void;
  onShareChanges: () => void;
  onPull: () => void;
  onShare: () => void;
  onRemove: () => void;
}

export function rowMenuHandler(kind: RowMenuItemKind, handlers: RowMenuHandlers): () => void {
  switch (kind) {
    case "reveal":
      return handlers.onReveal;
    case "contributeOrShareChanges":
      return handlers.onShareChanges;
    case "update":
      return handlers.onPull;
    case "share":
      return handlers.onShare;
    case "useLibraryVersion":
      return handlers.onPull;
    case "remove":
      return handlers.onRemove;
  }
}
