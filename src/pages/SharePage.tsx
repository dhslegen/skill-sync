import { Check, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { revealLabel } from "@/components/DetailPanel";
import { Icon } from "@/components/Icon";
import { SkillIcon } from "@/components/SkillIcon";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { isAppError, openLibraryUrl, type ShareCandidate } from "@/lib/ipc";
import { validSlug } from "@/lib/slug";
import { createFormComplete, useCreate } from "@/store/create";
import { useRegistries } from "@/store/registries";
import { useLocalDetail } from "@/store/local-detail";
import { useSession } from "@/store/session";
import { useShare, validShareName } from "@/store/share";

/**
 * 分享页:排除法候选列表(UI-Demo share 视图形态)+ 新建技能入口(M4 任务 4)。
 *
 * 表单做行内展开(与获取流程的 agent 多选同理):它不是必须打断的决策;
 * 「名称被占用」那一档才是,由 ShareTakenDialog 弹窗接管。
 *
 * 新建向导同样行内展开在列表上方——它是"从无到有",不属于任何一行候选。
 * 它**不需要登录**:创建只写本地文件,登录是分享那一步的前提。
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
      <TargetPicker />
      <SharePathNotice />
      <CreatePanel />
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

/** 分享目标库选择器(M4)。只有一个库时不渲染——没得选的选择器是噪音。
 *  只列**内建源**的库:分享到自定义源要先在设置里给那个源登录,不是这一屏的事。 */
function TargetPicker() {
  const registries = useRegistries((s) => s.list);
  const loadRegistries = useRegistries((s) => s.load);
  const targetRepo = useShare((s) => s.targetRepo);
  const setTargetRepo = useShare((s) => s.setTargetRepo);

  useEffect(() => {
    if (!registries) void loadRegistries();
  }, [registries, loadRegistries]);

  const repos = registries?.find((r) => r.builtin)?.repos ?? [];
  if (repos.length <= 1) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2.5" role="group" aria-label={t("share.targetLabel")}>
      <span className="text-[11.5px] text-text-3">{t("share.targetLabel")}</span>
      {repos.map((repo) => {
        const key = repo.primary ? null : repo.key;
        const active = targetRepo === key;
        return (
          <button
            key={repo.key}
            type="button"
            title={repo.key}
            aria-pressed={active}
            onClick={() => void setTargetRepo(key)}
            className={cn(
              "rounded-full border px-2.5 py-[3px] text-[12px]",
              active
                ? "border-border-strong bg-surface-3 font-medium text-text"
                : "border-border bg-surface-1 text-text-2 hover:border-border-strong hover:text-text",
            )}
          >
            {repo.name ?? repo.repo}
          </button>
        );
      })}
    </div>
  );
}

/** 「分享后会发生什么」的预告(M4 任务 2)。
 *  探不到(未登录、网络不通、旧版服务器)就整条不显示——**宁可不说,不说错**。 */
function SharePathNotice() {
  const preview = useShare((s) => s.preview);
  if (preview === "unknown") return null;

  // 逐档显式匹配,**不给"其余一切"兜底**:原先的三元链把任何意料外的值都落进
  // 「可能直接生效」——最乐观的那一档,与本组件"宁可不说,不说错"的承诺正好相反。
  const message =
    preview === "directPush"
      ? t("share.pathDirectPush")
      : preview === "reviewInRepo"
        ? t("share.pathReviewInRepo")
        : preview === "reviewViaCopy"
          ? t("share.pathReviewViaCopy")
          : preview === "maybeDirect"
            ? t("share.pathMaybeDirect")
            : null;
  if (!message) return null;

  return (
    <p className="pb-2.5 text-[12px] leading-[1.6] text-text-2">{message}</p>
  );
}

/**
 * 「新建技能」入口与表单(M4 任务 4,等价上游 `skills init`)。
 *
 * 只创建文件,不建关联、不进账——理由见 core/create.rs 模块头。完成页因此要如实
 * 说明哪些工具立刻读得到、哪些要走"分享再获取",不含糊过去。
 */
function CreatePanel() {
  const { phase, form, error, createdPath, open, close, setForm, submit, reveal } = useCreate();

  if (phase === "closed") {
    return (
      <div className="pb-2.5">
        <button
          type="button"
          onClick={open}
          className="flex h-7 items-center gap-1.5 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          <Icon icon={Plus} className="size-3.5" />
          {t("create.action")}
        </button>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="mb-2.5 rounded-card border border-border bg-surface-2 px-3.5 py-3">
        <p className="text-[12.5px] font-medium text-text">{t("create.doneTitle")}</p>
        {createdPath && (
          <p className="mt-1 break-all font-mono text-[11.5px] text-text-3">{createdPath}</p>
        )}
        <p className="mt-1.5 text-[12px] leading-[1.6] text-text-2">{t("create.doneHint")}</p>
        <p className="mt-1 text-[11.5px] leading-[1.5] text-text-3">{t("create.doneVisible")}</p>
        {/* 「在访达中打开」失败也要说出来:这一档只有这一处能显示 error,
            漏了它就是点一下没反应、也没提示——与分享页那条「打开被拒时把原因摆出来,
            不静默」是同一条规矩 */}
        {error && (
          <p className="mt-1.5 text-[12px] text-[#c0392b] dark:text-[#e0705f]">{error.message}</p>
        )}
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void reveal()}
            className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {revealLabel(navigator.userAgent)}
          </button>
          <button
            type="button"
            onClick={close}
            className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("create.done")}
          </button>
        </div>
      </div>
    );
  }

  const busy = phase === "busy";
  const slugOk = validSlug(form.dirSlug);
  const complete = createFormComplete(form);

  return (
    <div className="mb-2.5 rounded-card border border-border bg-surface-2 px-3.5 py-3">
      <p className="text-[12px] font-medium text-text-2">{t("create.title")}</p>
      <p className="mt-1 text-[11.5px] leading-[1.5] text-text-3">{t("create.intro")}</p>
      {error && (
        <p className="mt-1.5 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("create.failed")}
          {t("punct.labelSeparator")}
          {error.message}
        </p>
      )}

      <div className="mt-2.5 flex flex-col gap-2">
        <Field label={t("create.formName")} hint={t("create.formNameHint")}>
          <input
            value={form.displayName}
            onChange={(e) => setForm({ displayName: e.target.value })}
            className="h-7 w-full rounded-ctl border border-border bg-surface-1 px-2 text-[12.5px] outline-none focus:border-accent"
          />
        </Field>
        <Field label={t("create.formDesc")} hint={t("create.formDescHint")}>
          <input
            value={form.description}
            onChange={(e) => setForm({ description: e.target.value })}
            className="h-7 w-full rounded-ctl border border-border bg-surface-1 px-2 text-[12.5px] outline-none focus:border-accent"
          />
        </Field>
        <Field
          label={t("create.formSlug")}
          hint={form.dirSlug && !slugOk ? t("create.formSlugInvalid") : t("create.formSlugHint")}
          invalid={form.dirSlug !== "" && !slugOk}
        >
          <input
            value={form.dirSlug}
            onChange={(e) => setForm({ dirSlug: e.target.value })}
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
          {busy ? t("create.creating") : t("create.confirm")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={close}
          className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
        >
          {t("install.cancel")}
        </button>
      </div>
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
            {/* 「已分享」由右侧动作槽位承载,这里只解释"为什么还能再分享一次" */}
            {candidate.shared && !candidate.shared.upToDate && (
              <span>{t("share.hasChanges")}</span>
            )}
          </div>
        </div>
        </button>
        {/* 三档,不是两档:已分享且没改动过的,曾经和"从未分享"显示同一个「分享…」
            ——分享完按钮纹丝不动,看着就像什么都没发生(2026-08-03 用户实测缺陷)。 */}
        {candidate.shared?.upToDate ? (
          <span className="flex h-6 flex-none items-center gap-1 rounded-ctl px-2.5 text-[11.5px] font-medium text-ok">
            <Icon icon={Check} size={12} />
            {t("share.actionShared")}
          </span>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => begin(candidate)}
            className="h-6 flex-none rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {candidate.shared ? t("share.actionAgain") : t("share.action")}
          </button>
        )}
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