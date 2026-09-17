import { useEffect, useRef, useState } from "react";

import { t, type MessageKey } from "@/i18n";
import { skillLocalDetail, skillReveal, type OverwriteWarning, type SharePath } from "@/lib/ipc";
import { SHARE_BLOCK_LABEL } from "@/lib/share-block";
import { SharePlanList } from "@/components/SharePlanList";
import { relativeTimeFromIso } from "@/lib/format";
import { openLibraryUrl } from "@/lib/ipc";
import { shareTargetRepo, useMySkills } from "@/store/my-skills";
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
  noAccess: "mine.shareNoAccess",
};

export function ShareConfirm() {
  const shareTarget = useMySkills((s) => s.shareTarget);
  const list = useMySkills((s) => s.list);
  const shareBusy = useMySkills((s) => s.shareBusy);
  // 归属过滤(终审复审轮 1,C-A):`shareError` 现在带 dirSlug。这个确认屏只该
  // 说自己这一个技能的事——`beginShare` 已经把它清空,过滤更多是防"另一条路
  // (行上的「分享改动」)在确认屏开着时失败"这种交叠。
  const rawShareError = useMySkills((s) => s.shareError);
  const confirmShare = useMySkills((s) => s.confirmShare);
  const rawPreview = useMySkills((s) => s.sharePreview);
  const cancelShare = useMySkills((s) => s.cancelShare);
  const preview = useShare((s) => s.preview);
  // 选择器只取原始值,不造新对象(否则 Object.is 永远判"变了" → 无限重渲染)
  const targetRepo = useShare((s) => s.targetRepo);

  const [meta, setMeta] = useState<{ name: string; description: string } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const open = shareTarget !== null;
  const skill = list?.find((s) => s.dirSlug === shareTarget?.dirSlug);
  const shareError = rawShareError?.dirSlug === shareTarget?.dirSlug ? rawShareError : null;
  // 归属过滤,与 `shareError` 同一条纪律:绝不把上一个技能的删除清单摆在这一屏上。
  const changes = rawPreview?.dirSlug === shareTarget?.dirSlug ? rawPreview : null;

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
  // 🔴 终审 C-1:必须与 `confirmShare` 实际提交时用的**同一个判定**
  // (`shareTargetRepo`)——分开各写一份的话,这一行显示的目标库很容易与
  // 实际提交的目标库对不上(与 C-1 本身同一种缺陷,只是换了个地方)。
  const library = shareTargetRepo(skill, targetRepo) ?? t("mine.shareTargetDefault");
  const pathHint = preview === "unknown" ? null : PATH_LABEL[preview];
  // 🔴 v8 任务 3 / D8:探明没有写权限时提交按钮禁用。行上与详情动作区已经把
  // 主按钮禁掉了,这里是第三个渲染点——漏一处就是"行上禁了、确认屏里能点"。
  // `unknown`(探不到)**不禁**:预检永远是 fail-open 的。
  const noWriteAccess = preview === "noAccess";

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

        {/* 路径预告只是提示,探不到就整条不显示——不假装知道(M4 任务 2)。
            没有写权限那一档是**说明为什么下面那颗按钮点不动**,不是提示,
            所以画成与 `shareBlocked` 同款的警示框(D8)。 */}
        {pathHint && preview !== "noAccess" && (
          <p className="mt-2.5 text-[12px] leading-[1.6] text-text-2">{t(pathHint)}</p>
        )}
        {noWriteAccess && (
          <p className="mt-2.5 rounded-card border border-[#b8860b]/40 px-2.5 py-2 text-[12px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
            {t("mine.shareNoAccess")}
          </p>
        )}

        {blocked && (
          <p className="mt-2.5 rounded-card border border-[#b8860b]/40 px-2.5 py-2 text-[12px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
            {t(SHARE_BLOCK_LABEL[blocked])}
          </p>
        )}

        {/* 🔴 统一确认屏(v8 任务 5 / D9):覆盖警告在**顶部**,改动清单在下面,
            **同一屏**。分两屏问的话,用户要连点两次"确定"才能完成一个动作,
            而第二次点的时候他已经忘了第一屏说过什么。 */}
        {changes && "plan" in changes && changes.overwrite && (
          <OverwriteNotice warning={changes.overwrite} />
        )}
        {changes === null && !blocked && !shareError && (
          <p className="mt-2.5 text-[12px] text-text-3">{t("share.planLoading")}</p>
        )}
        {changes && "inSync" in changes && (
          <p className="mt-2.5 text-[12px] leading-[1.6] text-text-2">{t("mine.shareInSync")}</p>
        )}
        {changes && "plan" in changes && <SharePlanList plan={changes.plan} />}

        {shareError && (
          <p className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
            {t("mine.shareFailed")}
            {t("punct.labelSeparator")}
            {shareError.error.message}
          </p>
        )}
        {revealError && (
          <p className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">{revealError}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {/* 出口:不合格时用户自己改好文件夹名或 SKILL.md 就能分享;没有写权限
              时也留着它(D8 明确要求保留「打开文件夹」,别让这一屏成为死路) */}
          {(blocked || noWriteAccess) && skill.body && (
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
            // 🔴 清单还没到之前不许提交:那一刻界面还答不出"会删掉哪些文件",
            // 而这一屏存在的理由就是先把那件事摆出来(D6)。
            // 「已一致」也不许提交——按下去会造一笔零改动的提交,正是本期的病灶。
            disabled={
              blocked !== null ||
              noWriteAccess ||
              shareBusy !== null ||
              changes === null ||
              "inSync" in changes
            }
            onClick={() => void confirmShare()}
            className="h-7 rounded-ctl bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {/* 🔴 预览轮也占着 `shareBusy`(它走的是同一个函数),但那一刻**什么都
                还没推**——按钮写「正在分享…」就是一句假话。清单到手(`changes`
                非空)之后的忙碌才是真的在提交,上面那句「正在看技能库里现在是
                什么样…」负责交代预览轮。 */}
            {shareBusy && changes ? t("mine.sharing") : t("mine.share")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 顶部的覆盖警告(v8 任务 4 的 `ShareOverwriteDialog` 同一份说法,搬到这一屏上)。
 * 三件事都可能取不到——取不到时**如实说"看不出"**,不拿空串冒充一个人名。
 */
function OverwriteNotice({ warning }: { warning: OverwriteWarning }) {
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
    <div className="mt-2.5 rounded-card border border-[#c0392b]/40 px-2.5 py-2 dark:border-[#e0705f]/40">
      <p className="text-[12px] leading-[1.6] text-[#c0392b] dark:text-[#e0705f]">{provenance}</p>
      <p className="mt-1 text-[12px] leading-[1.6] text-text-2">{t("overwrite.body")}</p>
      <p className="mt-1 text-[12px] leading-[1.6] text-text-3">{t("overwrite.recoverable")}</p>
      {warning.historyUrl && (
        <button
          type="button"
          onClick={() => void openLibraryUrl(warning.historyUrl as string)}
          className="mt-1.5 text-[12px] text-accent underline-offset-2 hover:underline"
        >
          {t("overwrite.history")}
        </button>
      )}
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
