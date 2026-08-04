import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { useInstall } from "@/store/install";
import { useStoreIndex } from "@/store/store-index";

/**
 * 冲突对话框。
 *
 * 这一档用**居中模态**而不是行内展开(agent 多选用的是后者):它是一个必须打断的决策,
 * 选错就会丢掉用户改不回来的内容。行内展开容易被当成提示条略过,而这里需要的是"停下来读"。
 *
 * 默认落在「保留我的改动」——用户已拍板:不丢本地内容、以之后分享出去为归宿。
 * 按钮文案只承诺当下真会发生的事(保留),不写"分享上去":分享流程属后续任务,
 * 摆一个点了什么都不发生的按钮,和空状态撒谎是同一类问题。
 */
export function ConflictDialog() {
  const { phase, precheck, dirSlug, run, keepLocalAndShare, cancel } = useInstall();
  // 弹窗里要出现的是用户认得的名字(周报生成),不是内部目录名(weekly-report)。
  // core 里流转的一直是目录名,到界面这一层必须换回展示名。
  const displayName = useStoreIndex(
    (s) => s.index?.skills.find((k) => k.dirSlug === dirSlug)?.name,
  );
  const keepRef = useRef<HTMLButtonElement>(null);
  const open = phase === "conflict" && precheck !== null;

  useEffect(() => {
    // 焦点落在默认动作上:回车即"保留我的改动",不会误触覆盖
    if (open) keepRef.current?.focus();
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

  if (!open || !precheck) return null;
  const name = displayName ?? dirSlug ?? "";
  const modified = precheck.status === "locallyModified";
  // 装自另一个技能库:它**是**本应用装的,所以既不能套"改过本体"的三选
  // (没有改动可保留),也不能套外来目录那句"不是本应用安装的"(那是假话)。
  const otherLibrary = precheck.status === "otherLibrary" ? precheck : null;

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        className="w-[440px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="conflict-title" className="text-[14px] font-semibold">
          {modified
            ? t("conflict.modifiedTitle")
            : otherLibrary
              ? t("conflict.otherLibraryTitle")
              : t("conflict.foreignTitle")}
        </h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.6] text-text-2">
          {modified
            ? t("conflict.modifiedBody", { name })
            : otherLibrary
              ? t("conflict.otherLibraryBody", {
                  name,
                  library: `${otherLibrary.sourceOwner}/${otherLibrary.sourceRepo}`,
                })
              : precheck.status === "foreign" && precheck.origin.kind === "npxSkills"
                ? t("conflict.foreignBodyNpx", { name, source: precheck.origin.source })
                : t("conflict.foreignBodyUnknown", { name })}
        </p>

        <div className="mt-4 flex flex-col gap-2">
          {modified ? (
            <>
              {/* 默认项(用户拍板):保留本地并把改动分享上去——任务 11 起通道真实存在 */}
              <Choice
                ref={keepRef}
                primary
                label={t("conflict.keepShare")}
                hint={t("conflict.keepShareHint")}
                onClick={() => void keepLocalAndShare()}
              />
              <Choice
                label={t("conflict.keepLocal")}
                hint={t("conflict.keepLocalHint")}
                onClick={() => void run("keepLocal")}
              />
              <Choice
                label={t("conflict.overwrite")}
                hint={t("conflict.overwriteHint")}
                danger
                onClick={() => void run("overwrite")}
              />
            </>
          ) : otherLibrary ? (
            // 同名异库:同样只有替换与取消,默认落在取消。
            <Choice
              label={t("conflict.otherLibraryReplace")}
              hint={t("conflict.otherLibraryHint")}
              danger
              onClick={() => void run("overwrite")}
            />
          ) : (
            // 外来目录没有"你的改动"可保留,所以只有替换与取消两条路,
            // 且默认落在取消——绝不静默替换用户从别处装的东西。
            <Choice
              label={t("conflict.foreignReplace")}
              hint={t("conflict.foreignHint")}
              danger
              onClick={() => void run("overwrite")}
            />
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            ref={modified ? undefined : keepRef}
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
