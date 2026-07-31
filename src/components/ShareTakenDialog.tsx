import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { useSession } from "@/store/session";
import { useShare } from "@/store/share";

/**
 * 「名称被占用」三选弹窗(设计方案 2.5② 预检的 Taken 分支)。
 *
 * 默认焦点在「换个名称分享」上——它是三个里唯一不碰别人东西的选项;
 * 覆盖是 danger 样式并写明后果(库启用审核时,core 会自动降级为提交审核)。
 */
export function ShareTakenDialog() {
  const { phase, form, backToForm, viewTheirs, submit, cancel } = useShare();
  const user = useSession((s) => s.user);
  const renameRef = useRef<HTMLButtonElement>(null);
  const open = phase === "taken";

  useEffect(() => {
    if (open) renameRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        backToForm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, backToForm]);

  if (!open) return null;
  const suggestion = `${form.shareName}-${user?.login ?? "me"}`;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="share-taken-title"
        className="w-[440px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="share-taken-title" className="text-[14px] font-semibold">
          {t("share.takenTitle")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">
          {t("share.takenBody", { name: form.shareName })}
        </p>

        <div className="mt-4 flex flex-col gap-2">
          <Choice
            ref={renameRef}
            primary
            label={t("share.takenRename")}
            hint={t("share.takenRenameHint", { suggestion })}
            onClick={backToForm}
          />
          <Choice
            label={t("share.takenView")}
            hint={t("share.takenViewHint")}
            onClick={viewTheirs}
          />
          <Choice
            label={t("share.takenOverwrite")}
            hint={t("share.takenOverwriteHint")}
            danger
            onClick={() => void submit(true)}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={cancel}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Choice({
  ref,
  label,
  hint,
  onClick,
  primary = false,
  danger = false,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  hint: string;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={[
        "rounded-card border px-3 py-2.5 text-left transition-colors duration-150",
        primary
          ? "border-accent bg-accent-soft"
          : "border-border hover:border-border-strong hover:bg-surface-2",
      ].join(" ")}
    >
      <div
        className={[
          "text-[12.5px] font-[550]",
          primary ? "text-accent" : danger ? "text-[#c0392b] dark:text-[#e0705f]" : "text-text",
        ].join(" ")}
      >
        {label}
      </div>
      <div className="mt-0.5 text-[11.5px] leading-[1.5] text-text-3">{hint}</div>
    </button>
  );
}