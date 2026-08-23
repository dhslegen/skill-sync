import { useEffect, useRef, useState } from "react";

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
  const { phase, precheck, dirSlug, run, keepLocalAndShare, keepLocalAndShareMine, cancel } =
    useInstall();
  // 弹窗里要出现的是用户认得的名字(周报生成),不是内部目录名(weekly-report)。
  // core 里流转的一直是目录名,到界面这一层必须换回展示名。
  const displayName = useStoreIndex(
    (s) => s.index?.skills.find((k) => k.dirSlug === dirSlug)?.name,
  );
  const keepRef = useRef<HTMLButtonElement>(null);
  const open = phase === "conflict" && precheck !== null;
  // 「以库为准,丢弃本地改动」的二次确认(铁律 7:绝不静默丢用户改动)。
  // 换一个技能、或弹窗整个关掉时必须收回武装状态——不然上一个技能按出来的
  // "已确认"会跟着下一次冲突一起生效,变成没点第二下就覆盖。
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);

  useEffect(() => {
    // 焦点落在默认动作上:回车即"保留我的改动",不会误触覆盖
    if (open) keepRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setConfirmingOverwrite(false);
  }, [open, dirSlug]);

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
  // 库里记的分享者就是我(v6):它**同样**不能套"不是本应用安装的"那句假话。
  // core 只在 `local_changed` 为真时才会走到这里(`acquire::precheck` 的
  // `needs_decision` 判据),所以到这一层只需要按 `remoteChanged` 分两种说法
  // ——远端有没有变过是唯一还不确定的那件事,本地"确实改过"已经不需要再问。
  //
  // 「以本地为准」的分流(有没有 `state.installed` 记账)与 `forceReview` 的
  // 判定都在 `install.ts::keepLocalAndShareMine` 里,这里只负责触发它——
  // 分流规则见那个函数的注释(v6 任务分解裁定 #4,task-3-report 顾虑 1 记的
  // 真实缺口)。
  const mine = precheck.status === "mine" ? precheck : null;

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
              : mine
                ? // 远端没变时说"库里有新版"是假话(文案不许说假话)——
                  // `remoteChanged` 是这一档到这里时唯一还不确定的事,本地
                  // "确实改过"已经由 core 的 needs_decision 判据保证。
                  mine.remoteChanged
                  ? t("conflict.mineTitle", { name })
                  : t("conflict.mineTitleLocalOnly", { name })
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
              : mine
                ? mine.remoteChanged
                  ? t("conflict.mineBody")
                  : t("conflict.mineBodyLocalOnly")
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
          ) : mine ? (
            // 只有两个按钮(v6 任务分解裁定 #2):没有「保留并贡献」——那个是给
            // 分享别人技能的非作者用的,作者本人不需要"贡献"自己的东西。
            <>
              <Choice
                ref={keepRef}
                primary
                label={t("conflict.mineKeep")}
                onClick={() => void keepLocalAndShareMine()}
              />
              {/* 「以库为准」二次确认(铁律 7):第一下只武装,不动磁盘;
                  第二下才真的调 run("overwrite")。确认文案借这颗按钮的 hint
                  位显示,不另开第三个按钮。 */}
              <Choice
                label={t("conflict.mineOverwrite")}
                hint={confirmingOverwrite ? t("conflict.mineOverwriteConfirm") : undefined}
                danger
                onClick={() =>
                  confirmingOverwrite ? void run("overwrite") : setConfirmingOverwrite(true)
                }
              />
            </>
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
            // mine 档默认焦点在「以本地为准」上(裁定 #2),不能落到这颗取消按钮
            // ——否则它会在 keepRef 已经挂到 mine 的主按钮之后又抢一遍,
            // 回车就变成了取消而不是"以本地为准"。
            ref={modified || mine ? undefined : keepRef}
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
  /** 省略 = 不显示这一行(mine 档的两颗按钮没有独立的说明文案,标题/正文已经
   *  把两条路说全了;确认武装时借这个位置显示 `conflict.mineOverwriteConfirm`)。 */
  hint?: string;
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
      {hint && <div className="mt-0.5 text-[11.5px] leading-[1.5] text-text-3">{hint}</div>}
    </button>
  );
}
