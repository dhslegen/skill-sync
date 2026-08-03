import { useEffect, useState } from "react";

import { SkillIcon } from "@/components/SkillIcon";
import { t } from "@/i18n";
import { isAppError, openLibraryUrl, type ShareCandidate } from "@/lib/ipc";
import { useLocalDetail } from "@/store/local-detail";
import { useSession } from "@/store/session";
import { useShare, validShareName } from "@/store/share";

/**
 * 分享页:排除法候选列表(UI-Demo share 视图形态)。
 *
 * 假设(文档未覆盖):Demo 里的「新建技能」向导不在任务 11 范围(交接包只列了
 * 扫描/标签/收编/表单/预检/推送),不摆一个点了没反应的按钮——向导随任务 12 再来。
 *
 * 表单做行内展开(与获取流程的 agent 多选同理):它不是必须打断的决策;
 * 「名称被占用」那一档才是,由 ShareTakenDialog 弹窗接管。
 */
export function SharePage() {
  const { candidates, scanning, scanError, load } = useShare();
  const signedIn = useSession((s) => s.status === "signedIn");

  useEffect(() => {
    void load();
  }, [load]);

  if (!candidates && scanning) {
    return <p className="py-6 text-[12.5px] text-text-3">{t("share.loading")}</p>;
  }
  if (!candidates && scanError) {
    return (
      <div className="py-6">
        <p className="text-[12.5px] text-text-2">
          {t("share.scanFailed")}
          {t("punct.labelSeparator")}
          {scanError.message}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2.5 h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("share.retry")}
        </button>
      </div>
    );
  }
  if (!candidates) return null;

  return (
    <div>
      <p className="py-2.5 text-[12.5px] leading-[1.6] text-text-3">{t("share.intro")}</p>
      {!signedIn && (
        <p className="pb-2 text-[12px] text-text-2">{t("share.signInFirst")}</p>
      )}
      {candidates.length === 0 ? (
        <p className="py-4 text-[12.5px] text-text-3">{t("share.empty")}</p>
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface-1">
          {candidates.map((c) => (
            <Row key={c.path} candidate={c} disabled={!signedIn} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ candidate, disabled }: { candidate: ShareCandidate; disabled: boolean }) {
  const { phase, target, begin } = useShare();
  const active = target?.path === candidate.path && phase !== "idle";
  const display = candidate.name ?? candidate.dirName;

  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        {/* 名称区整块可点开详情;右侧「分享」按钮在这块外面,不会误触 */}
        <button
          type="button"
          onClick={() => void useLocalDetail.getState().open({ path: candidate.path })}
          className="group flex min-w-0 flex-1 items-center gap-3 text-left"
        >
        <SkillIcon name={display} className="size-[26px] rounded-[6px] text-[12px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-[550] group-hover:text-accent">{display}</span>
            {candidate.problem && (
              <span
                title={candidate.problem}
                className="flex-none rounded-[4px] border border-[#b8860b]/40 px-1.5 py-px text-[10.5px] font-medium text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]"
              >
                {t("share.needsInfo")}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-text-3">
            <span className="flex-none rounded-[4px] border border-border bg-surface-2 px-1.5 py-px text-[10.5px]">
              {candidate.origin.kind === "npxSkills"
                ? t("share.originNpx", { source: candidate.origin.source })
                : t("share.originLocal")}
            </span>
            {candidate.shared && (
              <span>
                {candidate.shared.upToDate ? t("share.upToDate") : t("share.hasChanges")}
              </span>
            )}
          </div>
        </div>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => begin(candidate)}
          className="h-6 flex-none rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
        >
          {candidate.shared && !candidate.shared.upToDate
            ? t("share.actionAgain")
            : t("share.action")}
        </button>
      </div>
      {active && <InlinePanel />}
    </div>
  );
}

/**
 * 评审链接:URL 照旧可选中复制,旁边给「在浏览器中查看」——webview 里 `<a>` 出不去,
 * 打开走 core 的 open_library_url(仅放行与技能库同源的地址)。
 */
function ReviewLink({ url }: { url: string }) {
  const [openError, setOpenError] = useState<string | null>(null);

  return (
    <div className="mt-1">
      <p className="select-text font-mono text-[11.5px] text-text-3">
        {t("share.doneReviewUrl", { url })}
      </p>
      <button
        type="button"
        onClick={() => {
          setOpenError(null);
          openLibraryUrl(url).catch((raw) =>
            setOpenError(isAppError(raw) ? raw.message : t("error.generic")),
          );
        }}
        className="mt-1.5 h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-accent hover:border-border-strong"
      >
        {t("share.openReview")}
      </button>
      {openError && (
        <p className="mt-1 text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">{openError}</p>
      )}
    </div>
  );
}

function InlinePanel() {
  const { phase, target, form, setForm, submit, cancel, staleNotice, shareError, done } =
    useShare();
  if (!target) return null;

  if (phase === "done" && done) {
    return (
      <div className="border-t border-border bg-surface-2 px-3.5 py-3 text-[12.5px]">
        <p className="text-text">
          {done.mode === "pushed" ? t("share.donePushed") : t("share.doneReview")}
        </p>
        {done.reviewUrl && <ReviewLink url={done.reviewUrl} />}
        <button
          type="button"
          onClick={cancel}
          className="mt-2 h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("detail.close")}
        </button>
      </div>
    );
  }

  const busy = phase === "busy";
  const nameOk = validShareName(form.shareName);
  const complete = nameOk && form.displayName.trim() !== "" && form.description.trim() !== "";

  return (
    <div className="border-t border-border bg-surface-2 px-3.5 py-3">
      <p className="text-[12px] font-medium text-text-2">{t("share.formTitle")}</p>
      {staleNotice && (
        <p className="mt-1.5 text-[12px] text-[#9a6c00] dark:text-[#d4a017]">{t("share.stale")}</p>
      )}
      {shareError && (
        <p className="mt-1.5 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("share.failed")}
          {t("punct.labelSeparator")}
          {shareError.message}
        </p>
      )}
      {!target.inCanonical && (
        <p className="mt-1.5 text-[11.5px] leading-[1.5] text-text-3">
          {t("share.formAdoptHint")}
        </p>
      )}
      {target.origin.kind === "npxSkills" && (
        <p className="mt-1.5 text-[11.5px] leading-[1.5] text-text-3">
          {t("share.formNpxHint", { source: target.origin.source })}
        </p>
      )}

      <div className="mt-2.5 flex flex-col gap-2">
        <Field label={t("share.formName")}>
          <input
            value={form.displayName}
            onChange={(e) => setForm({ displayName: e.target.value })}
            className="h-7 w-full rounded-ctl border border-border bg-surface-1 px-2 text-[12.5px] outline-none focus:border-accent"
          />
        </Field>
        <Field label={t("share.formDesc")}>
          <input
            value={form.description}
            onChange={(e) => setForm({ description: e.target.value })}
            className="h-7 w-full rounded-ctl border border-border bg-surface-1 px-2 text-[12.5px] outline-none focus:border-accent"
          />
        </Field>
        <Field
          label={t("share.formSlug")}
          hint={
            form.shareName && !nameOk ? t("share.formSlugInvalid") : t("share.formSlugHint")
          }
          invalid={form.shareName !== "" && !nameOk}
        >
          <input
            value={form.shareName}
            onChange={(e) => setForm({ shareName: e.target.value })}
            spellCheck={false}
            className="h-7 w-full rounded-ctl border border-border bg-surface-1 px-2 font-mono text-[12px] outline-none focus:border-accent"
          />
        </Field>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !complete}
          onClick={() => void submit()}
          className="h-7 rounded-ctl bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t("share.sharing") : t("share.confirm")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={cancel}
          className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
        >
          {t("install.cancel")}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  invalid = false,
  children,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-text-3">{label}</span>
      {children}
      {hint && (
        <span
          className={[
            "mt-0.5 block text-[11px] leading-[1.4]",
            invalid ? "text-[#c0392b] dark:text-[#e0705f]" : "text-text-3",
          ].join(" ")}
        >
          {hint}
        </span>
      )}
    </label>
  );
}