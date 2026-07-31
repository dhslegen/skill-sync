import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

/**
 * 移除确认对话框(与 ConflictDialog 同一形态:必须打断的决策才用居中模态)。
 *
 * 双确认的落地:行内「移除」按钮是第一步,这个弹窗的确认是第二步;
 * 若 core 发现用户改过本体(force=false 时**不动磁盘**就返回),
 * 弹窗升级为第二重红色警示,那一次确认才带 force。
 *
 * 默认焦点始终在「取消」上——回车绝不等于删除。
 */
export function RemoveDialog() {
  const { removePhase, removeTarget, removeError, confirmRemove, cancelRemove } = useMySkills();
  const displayName = useStoreIndex(
    (s) => s.index?.skills.find((k) => k.dirSlug === removeTarget)?.name,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = removePhase !== "idle";
  const forceStep = removePhase === "confirmingForce";
  const busy = removePhase === "busy";

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open, forceStep]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelRemove();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cancelRemove]);

  if (!open || !removeTarget) return null;
  const name = displayName ?? removeTarget;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-title"
        className="w-[420px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="remove-title" className="text-[14px] font-semibold">
          {forceStep ? t("mine.removeForceTitle") : t("mine.removeTitle", { name })}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">
          {forceStep ? t("mine.removeForceBody", { name }) : t("mine.removeBody")}
        </p>

        {removeError && (
          <p className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
            {t("mine.removeFailed")}
            {t("punct.labelSeparator")}
            {removeError.message}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancelRemove}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirmRemove()}
            className="h-7 rounded-ctl border border-[#c0392b] px-3 text-[12px] font-medium text-[#c0392b] hover:bg-[#c0392b] hover:text-white disabled:opacity-50 dark:border-[#e0705f] dark:text-[#e0705f] dark:hover:bg-[#e0705f] dark:hover:text-[#1c1917]"
          >
            {forceStep ? t("mine.removeForceConfirm") : t("mine.removeConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
