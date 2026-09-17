import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { relativeTimeFromIso } from "@/lib/format";
import { openLibraryUrl } from "@/lib/ipc";
import { useOverwrite } from "@/store/overwrite";

/**
 * 覆盖确认屏(v8 任务 4 / 决策 D2)。
 *
 * 用户明确推翻了旧拍板「不提供强行覆盖」:现在允许覆盖,但**必须是一次明示的
 * 选择**,而且那句话要**点名覆盖谁、什么时候推的、去哪找回**。
 *
 * # 三件事都可能取不到
 *
 * 「谁」「什么时候」来自技能库那个目录的最后一次改动,是 best-effort——
 * 取不到时**如实说"看不出"**,不拿空串冒充一个人名(core 侧那三个字段因此都是
 * `null` 而不是空串)。历史链接给不出时整行不摆:摆一个点不开的链接比不摆更糟。
 *
 * # 默认焦点在「先不动」
 *
 * 与 `RemoveDialog` 同一条规矩:回车绝不等于覆盖同事的版本。
 */
export function ShareOverwriteDialog() {
  const { pending, busy, confirmOverwrite, cancel } = useOverwrite();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = pending !== null;

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cancel]);

  if (!pending) return null;
  const { name, warning } = pending;
  // ISO 解析不了时 `relativeTimeFromIso` 返回空串——那等于"没有时间",
  // 与字段本身为 null 归同一档,不让界面出现「改于 」这种半句话。
  const at = warning.lastAt ? relativeTimeFromIso(warning.lastAt) : "";
  const who = warning.lastAuthor?.trim() ?? "";
  const provenance =
    who && at
      ? t("overwrite.byWhoAt", { author: who, at })
      : who
        ? t("overwrite.byWho", { author: who })
        : at
          ? t("overwrite.atOnly", { at })
          : t("overwrite.unknownWho");

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="overwrite-title"
        className="w-[440px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="overwrite-title" className="text-[14px] font-semibold">
          {t("overwrite.title", { name })}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">{provenance}</p>
        <p className="mt-1 text-[12.5px] leading-[1.6] text-text-2">{t("overwrite.body")}</p>
        <p className="mt-1 text-[12.5px] leading-[1.6] text-text-3">
          {t("overwrite.recoverable")}
        </p>

        {warning.historyUrl && (
          <button
            type="button"
            onClick={() => void openLibraryUrl(warning.historyUrl as string)}
            className="mt-2 text-[12px] text-accent underline-offset-2 hover:underline"
          >
            {t("overwrite.history")}
          </button>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancel}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("overwrite.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirmOverwrite()}
            className="h-7 rounded-ctl border border-[#c0392b] px-3 text-[12px] font-medium text-[#c0392b] hover:bg-[#c0392b] hover:text-white disabled:opacity-50 dark:border-[#e0705f] dark:text-[#e0705f] dark:hover:bg-[#e0705f] dark:hover:text-[#1c1917]"
          >
            {t("overwrite.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
