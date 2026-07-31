import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { useInstall } from "@/store/install";

/**
 * 安装结果面板里逐条重试时的替换确认。
 *
 * 与 RepairDialog 同一条纪律:只在关联位置被**实体目录**占用时出现——
 * 那个目录可能是用户自己放的技能,替换等于删除它(铁律 7),默认焦点在取消上。
 * 其余形态(断链/丢失/被改指)在 store 里直接就修好了,不会走到这里。
 */
export function RetryLinkDialog() {
  const { retryConfirmDir, confirmRetry, cancelRetry } = useInstall();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = retryConfirmDir !== null;

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelRetry();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cancelRetry]);

  if (!open || !retryConfirmDir) return null;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="retry-link-title"
        className="w-[420px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="retry-link-title" className="text-[14px] font-semibold">
          {t("install.retryTitle")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">
          {t("install.retryBody")}
        </p>
        <p className="mt-1.5 break-all font-mono text-[11.5px] text-text-3">{retryConfirmDir}</p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancelRetry}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirmRetry()}
            className="h-7 rounded-ctl border border-[#c0392b] px-3 text-[12px] font-medium text-[#c0392b] hover:bg-[#c0392b] hover:text-white dark:border-[#e0705f] dark:text-[#e0705f] dark:hover:bg-[#e0705f] dark:hover:text-[#1c1917]"
          >
            {t("install.retryConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
