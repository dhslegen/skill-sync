import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { relativeTimeFromIso } from "@/lib/format";
import { useMySkills } from "@/store/my-skills";

/**
 * 「有几个版本,留哪一份」拍板(v6 二期)。
 *
 * # 为什么这件事必须让用户拍板
 *
 * 同一个技能在两个工具目录里各有一份、而且内容不一样时,app **无从知道**哪份是
 * 用户想要的——它们都是用户自己的文件。旧模型在这里会按"谁是本体"的猜测直接动手,
 * 那正是这一期要消灭的。现在:摆出每一份的位置、最后修改时间、文件数,让用户看着选。
 *
 * # 可逆是这一屏敢做减法的前提
 *
 * 没被选中的那些**进系统废纸篓**,不是删除——所以这里只问一次、不做二次确认。
 * 文案要把这件事说清楚(`mine.versionHint`),用户才敢点。
 *
 * 默认焦点在「取消」上:这一屏会动磁盘,回车不该等于"随便选一个"。
 */
export function VersionChooser() {
  const versionChoice = useMySkills((s) => s.versionChoice);
  const keepVersion = useMySkills((s) => s.keepVersion);
  const keepBusy = useMySkills((s) => s.keepBusy);
  const keepError = useMySkills((s) => s.keepError);
  const cancel = useMySkills((s) => s.cancelVersionChoice);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = versionChoice !== null;

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

  if (!versionChoice) return null;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-title"
        className="w-[520px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="version-title" className="text-[14px] font-semibold">
          {t("mine.chooseVersion")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">{t("mine.versionHint")}</p>

        {keepError && (
          <p className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">{keepError.message}</p>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {versionChoice.versions.map((v) => (
            <div
              key={v.path}
              className="flex items-center gap-3 rounded-card border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                {/* 位置用等宽字体:它是路径,要能逐字符看清(UI 规范 §2) */}
                <p className="truncate font-mono text-[11.5px] text-text-2" title={v.path}>
                  {v.path}
                </p>
                <p className="mt-0.5 text-[11.5px] text-text-3">
                  {t("mine.versionModified", { when: relativeTimeFromIso(v.modifiedAt) })}
                  <span className="px-1">·</span>
                  {t("mine.versionFiles", { count: v.files })}
                </p>
              </div>
              <button
                type="button"
                disabled={keepBusy}
                onClick={() => void keepVersion(versionChoice.dirSlug, v.path)}
                className="h-7 flex-none rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {t("mine.versionKeep")}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            ref={cancelRef}
            type="button"
            disabled={keepBusy}
            onClick={cancel}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {t("conflict.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
