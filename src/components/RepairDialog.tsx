import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

/**
 * 修复确认对话框——只在关联位置被**实体目录**占用时出现。
 *
 * 断链/丢失/被改指的链接直接重建,不会走到这里:链接不是用户数据本体。
 * 实体目录可能是用户自己放的技能,替换等于删除它,所以必须先问,默认焦点在取消上。
 */
export function RepairDialog() {
  const { repairConfirmTarget, confirmRepair, cancelRepair } = useMySkills();
  const displayName = useStoreIndex(
    (s) => s.index?.skills.find((k) => k.dirSlug === repairConfirmTarget)?.name,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = repairConfirmTarget !== null;

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelRepair();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cancelRepair]);

  if (!open || !repairConfirmTarget) return null;
  const name = displayName ?? repairConfirmTarget;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="repair-title"
        className="w-[420px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="repair-title" className="text-[14px] font-semibold">
          {t("mine.repairTitle")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">
          {t("mine.repairBody", { name })}
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancelRepair}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirmRepair()}
            className="h-7 rounded-ctl border border-[#c0392b] px-3 text-[12px] font-medium text-[#c0392b] hover:bg-[#c0392b] hover:text-white dark:border-[#e0705f] dark:text-[#e0705f] dark:hover:bg-[#e0705f] dark:hover:text-[#1c1917]"
          >
            {t("mine.repairConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
