import { useEffect, useRef, useState } from "react";

import { t, type MessageKey } from "@/i18n";
import { skillLocalDetail, skillReveal, type SharePath } from "@/lib/ipc";
import { SHARE_BLOCK_LABEL } from "@/lib/share-block";
import { useMySkills } from "@/store/my-skills";
import { useShare } from "@/store/share";

/**
 * 分享确认屏(v6 二期 A-1「分享环节零编辑」)。
 *
 * # 🔴 这一屏没有任何输入框,那是它的全部意义
 *
 * 上一版是一张表单:名称、描述、文件夹名都能改,还会替用户"补齐" frontmatter。
 * 三个问题:①改了名字之后本地那份和库里那份就是两个东西了;②补齐也是改——
 * 分享就该是分享,不该顺手动用户的文件;③**改出来的东西很可能不合标准**
 * (Agent Skills 开放标准要求 `name` 必须等于文件夹名,而表单允许两者各填各的)。
 *
 * 所以现在:全部只读,合不合格由 core 按标准判(`shareBlocked`),不合格的
 * **不让分享,但照常显示技能、说清哪不合格、给一个「打开文件夹」的出口**
 * ——用户自己能修好,不给出路才是死路。
 *
 * # 名称与描述为什么现读
 *
 * `InstalledSkillView` 里没有这两个字段(它是"这台电脑上我有哪些技能"的清单,
 * 不是技能内容)。这里按 `body`(本体绝对路径)现读一次 SKILL.md
 * ——**用 `path` 不用 `dirSlug`**:本体很可能不住在统一目录里(那正是这一期的
 * 起因),按 `dirSlug` 解析会读到另一个地方,或者什么都读不到。
 */
/** `unknown` 不在表里:探不到就整条不显示,不假装知道(M4 任务 2 的既定取舍)。 */
const PATH_LABEL: Record<Exclude<SharePath, "unknown">, MessageKey> = {
  directPush: "mine.sharePathDirect",
  reviewInRepo: "mine.sharePathReview",
  reviewViaCopy: "mine.sharePathReviewViaCopy",
  maybeDirect: "mine.sharePathMaybeDirect",
};

export function ShareConfirm() {
  const shareTarget = useMySkills((s) => s.shareTarget);
  const list = useMySkills((s) => s.list);
  const shareBusy = useMySkills((s) => s.shareBusy);
  const shareError = useMySkills((s) => s.shareError);
  const confirmShare = useMySkills((s) => s.confirmShare);
  const cancelShare = useMySkills((s) => s.cancelShare);
  const preview = useShare((s) => s.preview);
  // 选择器只取原始值,不造新对象(否则 Object.is 永远判"变了" → 无限重渲染)
  const targetRepo = useShare((s) => s.targetRepo);

  const [meta, setMeta] = useState<{ name: string; description: string } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = shareTarget !== null;
  const skill = list?.find((s) => s.dirSlug === shareTarget?.dirSlug);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelShare();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cancelShare]);

  // 换技能时把上一个的内容清掉:留着就是把另一个技能的名称描述摆在这一屏上
  useEffect(() => {
    setMeta(null);
    setRevealError(null);
    const body = skill?.body;
    if (!open || !body) return;
    let stale = false;
    void skillLocalDetail({ path: body })
      .then((d) => {
        if (!stale) setMeta({ name: d.name, description: d.description });
      })
      .catch(() => {
        // 读不出来就不摆名称/描述那两行。**不拦分享**:能不能分享由 core 的
        // shareBlocked 判定,它读不出 SKILL.md 时给的是 skillMdUnreadable。
      });
    return () => {
      stale = true;
    };
  }, [open, skill?.body]);

  if (!shareTarget || !skill) return null;

  const blocked = skill.shareBlocked;
  const library =
    skill.sourceOwner && skill.sourceRepo
      ? `${skill.sourceOwner}/${skill.sourceRepo}`
      : (targetRepo ?? t("mine.shareTargetDefault"));
  const pathHint = preview === "unknown" ? null : PATH_LABEL[preview];

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="w-[460px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="share-title" className="text-[14px] font-semibold">
          {t("mine.shareTitle")}
        </h2>

        <dl className="mt-3 flex flex-col gap-2">
          {meta && (
            <>
              <Line label={t("mine.shareFieldName")} value={meta.name} />
              <Line label={t("mine.shareFieldDesc")} value={meta.description} />
            </>
          )}
          <Line label={t("mine.shareFieldDir")} value={skill.dirSlug} mono />
          <Line label={t("mine.shareFieldTarget")} value={library} />
        </dl>

        {/* 路径预告只是提示,探不到就整条不显示——不假装知道(M4 任务 2) */}
        {pathHint && (
          <p className="mt-2.5 text-[12px] leading-[1.6] text-text-2">{t(pathHint)}</p>
        )}

        {blocked && (
          <p className="mt-2.5 rounded-card border border-[#b8860b]/40 px-2.5 py-2 text-[12px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
            {t(SHARE_BLOCK_LABEL[blocked])}
          </p>
        )}

        {shareError && (
          <p className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
            {t("mine.shareFailed")}
            {t("punct.labelSeparator")}
            {shareError.message}
          </p>
        )}
        {revealError && (
          <p className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">{revealError}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {/* 不合格时的出口:用户自己改好文件夹名或 SKILL.md 就能分享了 */}
          {blocked && skill.body && (
            <button
              type="button"
              onClick={() => {
                setRevealError(null);
                void skillReveal({ path: skill.body }).catch((e: unknown) =>
                  setRevealError(
                    typeof e === "object" && e && "message" in e
                      ? String((e as { message: unknown }).message)
                      : t("error.generic"),
                  ),
                );
              }}
              className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("mine.openFolder")}
            </button>
          )}
          <button
            ref={cancelRef}
            type="button"
            onClick={cancelShare}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
          <button
            type="button"
            disabled={blocked !== null || shareBusy !== null}
            onClick={() => void confirmShare()}
            className="h-7 rounded-ctl bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {shareBusy ? t("mine.sharing") : t("mine.share")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 只读的一行。**刻意不是 `<input readOnly>`**:那还是个输入框,看起来能改。 */
function Line({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[64px] flex-none text-[11.5px] text-text-3">{label}</dt>
      <dd
        className={[
          "min-w-0 flex-1 break-words text-[12.5px] text-text",
          mono ? "font-mono text-[12px]" : "",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
