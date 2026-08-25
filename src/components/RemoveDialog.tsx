import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

/**
 * 移除确认对话框(与 ConflictDialog 同一形态:必须打断的决策才用居中模态)。
 *
 * # 只剩一步(v6 二期)
 *
 * 上一版是双确认:core 发现用户改过本体就**不动磁盘**退回来,界面升级成第二重
 * 红色警示,那一次才带 `force`。现在铁律 7「绝不静默删除用户文件」靠**可逆**落实
 * ——本体进系统废纸篓,用户随时能捞回来。
 *
 * **确认框本身不是可逆性**:用户手滑点了"确定"东西照样没了;而进了废纸篓,
 * 连"程序判断错了"这一档都兜得住。所以那道追问撤掉,这一屏只负责把
 * "东西会去哪、怎么找回来"说清楚(`mine.removeBody`)。
 *
 * 默认焦点仍在「取消」上——回车绝不等于移除。
 */
export function RemoveDialog() {
  const { removePhase, removeTarget, removeError, confirmRemove, cancelRemove } = useMySkills();
  const displayName = useStoreIndex(
    (s) => s.index?.skills.find((k) => k.dirSlug === removeTarget)?.name,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = removePhase !== "idle";
  const busy = removePhase === "busy";

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

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
          {t("mine.removeTitle", { name })}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">
          {t("mine.removeBody")}
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
            {t("mine.removeConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
