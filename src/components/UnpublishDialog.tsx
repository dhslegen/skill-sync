import { useEffect, useRef, useState } from "react";

import { t } from "@/i18n";
import { isAppError, openLibraryUrl } from "@/lib/ipc";
import { useUnpublish } from "@/store/unpublish";

/**
 * 「从技能库删除」的确认弹窗(0.8.0 任务 6),全局挂在 `App.tsx`。
 *
 * 只确认一次(设计 §3 / 访谈 Q14):删掉的内容仍在技能库的提交历史里,可以找回——
 * 与「可逆就只确认一次」的既有惯例一致(移除、换成库里的版本都是这样)。但要说清三件事:
 * 删哪些文件、同事电脑上那份不受影响、去哪找回(历史链接)。
 *
 * 默认焦点在「先不动」:回车不会删。删除按钮用危险色,不是主色。
 *
 * **成功与失败都在这里说**:触发它的那一行在删除成功后会换区或消失,不是可靠的渲染点。
 * 库删成功、本机那份没能移到废纸篓时,如实说"库里已删除,本机这份没能移走",
 * 不当成整体失败(库里那件事已经发生了)。
 */
export function UnpublishDialog() {
  const { target, phase, alsoTrashLocal, setAlsoTrashLocal, confirm, close } = useUnpublish();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const open = target !== null;

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open, phase.kind]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 弹窗开着时 Esc 一律在这里截住,不漏到下层(终审 M-5:running 时漏下去会关掉底下的详情面板);
      // 删除进行中只截不关——关掉了结果就没有地方说了
      e.stopPropagation();
      if (phase.kind !== "running") close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, phase.kind, close]);

  if (!target) return null;
  const name = target.displayName;
  const listing = phase.kind === "confirm" || phase.kind === "running" ? phase : null;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unpublish-title"
        className="max-h-[88vh] w-[480px] overflow-y-auto rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="unpublish-title" className="text-[14px] font-semibold">
          {phase.kind === "done" ? t("unpublish.doneTitle", { name }) : t("unpublish.title", { name })}
        </h2>

        {phase.kind === "loading" && <p className="mt-2 text-[12.5px] text-text-3">{t("unpublish.loading")}</p>}

        {listing && (
          <>
            {phase.kind === "confirm" && phase.stale && (
              <p className="mt-2 text-[12px] leading-[1.6] text-[#9a6c00] dark:text-[#d4a017]">{t("unpublish.stale")}</p>
            )}
            <p className="mt-2 text-[12.5px] leading-[1.6] text-text-2">
              {t("unpublish.body", { count: String(listing.files.length) })}
            </p>
            <ul
              data-testid="unpublish-files"
              className="mt-2 max-h-[160px] overflow-y-auto rounded-card border border-border bg-surface-2 px-2.5 py-1.5"
            >
              {listing.files.map((f) => (
                <li key={f} className="break-all font-mono text-[11.5px] text-text-2">
                  {f}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] leading-[1.6] text-text-3">{t("unpublish.othersUnaffected")}</p>
            <p className="mt-1 text-[12px] leading-[1.6] text-text-3">
              {t("unpublish.recoverable")}
              <button
                type="button"
                onClick={() => {
                  setLinkError(null);
                  openLibraryUrl(listing.historyUrl).catch((raw: unknown) =>
                    setLinkError(isAppError(raw) ? raw.message : t("error.generic")),
                  );
                }}
                className="ml-1 font-medium text-accent underline-offset-2 hover:underline"
              >
                {t("unpublish.history")}
              </button>
            </p>
            {linkError && <p className="mt-1 text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">{linkError}</p>}
            {target.localPresent && (
              <label className="mt-3 flex items-start gap-2 text-[12.5px] text-text-2">
                <input
                  type="checkbox"
                  checked={alsoTrashLocal}
                  disabled={phase.kind === "running"}
                  onChange={(e) => setAlsoTrashLocal(e.target.checked)}
                  className="mt-[3px]"
                />
                <span>
                  {t("unpublish.alsoTrashLocal")}
                  <span className="block text-[11.5px] text-text-3">{t("unpublish.alsoTrashLocalHint")}</span>
                </span>
              </label>
            )}
          </>
        )}

        {phase.kind === "error" && (
          <p className="mt-2 text-[12.5px] leading-[1.6] text-[#c0392b] dark:text-[#e0705f]">
            {t("unpublish.failed")}
            {t("punct.labelSeparator")}
            {phase.error.message}
          </p>
        )}

        {phase.kind === "done" && (
          <>
            <p className="mt-2 text-[12.5px] leading-[1.6] text-text-2">{t("unpublish.doneBody")}</p>
            <p className="mt-1 text-[12px] leading-[1.6] text-text-3">
              {t("unpublish.recoverable")}
              <button
                type="button"
                onClick={() => {
                  setLinkError(null);
                  openLibraryUrl(phase.historyUrl).catch((raw: unknown) =>
                    setLinkError(isAppError(raw) ? raw.message : t("error.generic")),
                  );
                }}
                className="ml-1 font-medium text-accent underline-offset-2 hover:underline"
              >
                {t("unpublish.history")}
              </button>
            </p>
            {linkError && <p className="mt-1 text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">{linkError}</p>}
            {phase.local.kind === "trashed" && (
              <p className="mt-1 text-[12.5px] leading-[1.6] text-text-2">{t("unpublish.localTrashed")}</p>
            )}
            {phase.local.kind === "untouched" && (
              <p className="mt-1 text-[12.5px] leading-[1.6] text-text-2">{t("unpublish.localKept")}</p>
            )}
            {phase.local.kind === "failed" && (
              <p className="mt-1 text-[12.5px] leading-[1.6] text-[#c0392b] dark:text-[#e0705f]">
                {t("unpublish.localFailed")}
                {t("punct.labelSeparator")}
                {isAppError(phase.local.error) ? phase.local.error.message : t("error.generic")}
              </p>
            )}
          </>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {phase.kind === "done" || phase.kind === "error" ? (
            <button
              ref={cancelRef}
              type="button"
              onClick={close}
              className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("unpublish.close")}
            </button>
          ) : (
            <>
              <button
                ref={cancelRef}
                type="button"
                disabled={phase.kind === "running"}
                onClick={close}
                className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
              >
                {t("unpublish.cancel")}
              </button>
              <button
                type="button"
                disabled={phase.kind !== "confirm"}
                onClick={() => void confirm()}
                className="h-7 rounded-ctl border border-[#c0392b] px-3 text-[12px] font-medium text-[#c0392b] hover:bg-[#c0392b]/10 disabled:opacity-50 dark:border-[#e0705f] dark:text-[#e0705f]"
              >
                {phase.kind === "running" ? t("unpublish.running") : t("unpublish.confirm")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
