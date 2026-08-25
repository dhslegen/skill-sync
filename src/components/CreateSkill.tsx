import { Plus } from "lucide-react";

import { revealLabel } from "@/components/DetailPanel";
import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { validSlug } from "@/lib/slug";
import { createFormComplete, useCreate } from "@/store/create";

/**
 * 「新建技能」入口与表单(等价上游 `skills init`)。
 *
 * # 它为什么搬到了「我的技能」页
 *
 * 这个功能原本长在**分享页**里,而分享页已于 v6 二期整页撤销——搬家之前
 * `skill_create` 这条 IPC(core 与 store 都完好、20 条测试全绿)**没有任何
 * 界面到得了**,等于功能还在、门没了。新家选这一页,因为新建出来的技能
 * 立刻会以「我分享的 · 尚未分享」的形态出现在下面的列表里:动作与结果在同一屏,
 * 用户点完就看得见自己建了什么。
 *
 * # 只创建文件,不做别的
 *
 * 落 canonical 的 `<slug>/SKILL.md` 一个文件,不启用到任何工具、不进任何清单
 * ——理由见 core/create.rs 模块头(对齐上游 `skills init`)。
 * 完成页因此要如实说明"接下来能做什么",不含糊过去。
 *
 * ⚠️ **完成页的措辞是按 v6 二期的新模型重写过的,不是旧文案照搬**:旧的那句
 * 「Claude Code 和 Trae 要等它分享到技能库、再获取回来才能用」在今天是**假话**
 * ——`skill_set_agents` 已经让本地技能可以直接在这一页勾选启用到任何工具,
 * 不必先绕一圈分享再取回。
 */
export function CreateSkill() {
  const { phase, form, error, createdPath, open, close, setForm, submit, reveal } = useCreate();

  if (phase === "closed") {
    return (
      <button
        type="button"
        onClick={open}
        className="flex h-7 items-center gap-1.5 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
      >
        <Icon icon={Plus} className="size-3.5" />
        {t("create.action")}
      </button>
    );
  }

  if (phase === "done") {
    return (
      <div className="mb-2.5 w-full rounded-card border border-border bg-surface-2 px-3.5 py-3">
        <p className="text-[12.5px] font-medium text-text">{t("create.doneTitle")}</p>
        {createdPath && (
          <p className="mt-1 break-all font-mono text-[11.5px] text-text-3">{createdPath}</p>
        )}
        <p className="mt-1.5 text-[12px] leading-[1.6] text-text-2">{t("create.doneHint")}</p>
        {/* 「在访达中打开」失败也要说出来:这一档只有这一处能显示 error,
            漏了它就是点一下没反应、也没提示 */}
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
    <div className="mb-2.5 w-full rounded-card border border-border bg-surface-2 px-3.5 py-3">
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
