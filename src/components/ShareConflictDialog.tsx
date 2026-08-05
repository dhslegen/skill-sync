import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { openLibraryUrl } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

/**
 * 「分享改动」的冲突弹窗(M5 任务 1)——远端在获取之后被其他人改过时出现。
 *
 * 只有两条路:提交审核(合并交给技能库的评审流程)/ 先不动。
 * **没有「强行覆盖」**:覆盖别人的改动不该是一个按钮。默认焦点在「先不动」上,
 * 回车绝不等于替出对方的成果。
 */
export function ShareConflictDialog() {
  const { shareConflict, confirmShareReview, cancelShareConflict } = useMySkills();
  const displayName = useStoreIndex(
    (s) => s.index?.skills.find((k) => k.dirSlug === shareConflict?.dirSlug)?.name,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = shareConflict !== null;

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelShareConflict();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cancelShareConflict]);

  if (!open || !shareConflict) return null;
  const name = displayName ?? shareConflict.dirSlug;
  const historyUrl = shareConflict.historyUrl;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="share-conflict-title"
        className="w-[440px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="share-conflict-title" className="text-[14px] font-semibold">
          {t("mine.conflictTitle")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">
          {t("mine.conflictBody", { name })}
        </p>
        {historyUrl && (
          <button
            type="button"
            onClick={() => void openLibraryUrl(historyUrl)}
            className="mt-2 text-[12px] font-medium text-accent hover:underline"
          >
            {t("mine.conflictView")}
          </button>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancelShareConflict}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("mine.conflictCancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirmShareReview()}
            className="h-7 rounded-ctl border border-accent px-3 text-[12px] font-medium text-accent hover:bg-accent hover:text-white"
          >
            {t("mine.conflictReview")}
          </button>
        </div>
      </div>
    </div>
  );
}
