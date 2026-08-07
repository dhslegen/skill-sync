import { Check, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Icon } from "@/components/Icon";
import { SkillIcon } from "@/components/SkillIcon";
import { t, type MessageKey } from "@/i18n";
import type { BatchItem } from "@/lib/ipc";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";
import { useWizard, type WizardStep } from "@/store/wizard";

const STEPS: { id: WizardStep; label: MessageKey }[] = [
  { id: "agents", label: "wizard.stepAgents" },
  { id: "signIn", label: "wizard.stepSignIn" },
  { id: "curated", label: "wizard.stepCurated" },
];

/**
 * 首次启动向导。全屏覆盖,左侧细步骤列表(UI 规范 §23:无数字大圆圈)。
 *
 * 每一步都能走下去:没检测到工具、不登录、没有精选清单,都不是死路。
 */
export function Wizard() {
  const { open, step, finish } = useWizard();
  if (!open) return null;

  // bg-bg(主画布色):这里曾引用不存在的 surface 序号 0,Tailwind v4 对
  // 未定义 token 静默不生成 CSS,向导层透明、文字与主界面叠在一起。
  // 现有 styles/design-tokens.test.ts 守卫钉住这类拼写。
  return (
    <div className="fixed inset-0 z-80 bg-bg">
      <div data-tauri-drag-region className="h-11" />
      <div className="mx-auto flex h-[calc(100%-44px)] max-w-[760px] gap-10 px-8 pt-6">
        <aside className="w-[180px] flex-none pt-1">
          <h1 className="text-[15px] font-semibold">{t("wizard.title")}</h1>
          <ol className="mt-5 flex flex-col gap-1">
            {STEPS.map((s, i) => {
              const activeIdx = STEPS.findIndex((x) => x.id === step);
              const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
              return (
                <li
                  key={s.id}
                  className={[
                    "flex items-center gap-2 border-l-2 py-1.5 pl-3 text-[12.5px]",
                    state === "active"
                      ? "border-accent font-[550] text-text"
                      : state === "done"
                        ? "border-border text-text-3"
                        : "border-border text-text-3",
                  ].join(" ")}
                >
                  {state === "done" && <Icon icon={Check} size={12} />}
                  {t(s.label)}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            onClick={finish}
            className="mt-6 text-[11.5px] text-text-3 hover:text-text"
          >
            {t("wizard.later")}
          </button>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto pb-8 pt-1">
          {step === "agents" && <AgentsStep />}
          {step === "signIn" && <SignInStep />}
          {step === "curated" && <CuratedStep />}
        </main>
      </div>
    </div>
  );
}

function AgentsStep() {
  const { agents, next } = useWizard();
  const found = agents.filter((a) => a.installed);

  return (
    <div>
      <p className="text-[13px] leading-[1.7] text-text-2">
        {found.length > 0 ? t("wizard.agentsIntro") : t("wizard.agentsNone")}
      </p>
      {found.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {found.map((a) => (
            <li
              key={a.name}
              className="flex items-center gap-2.5 rounded-card border border-border bg-surface-1 px-3 py-2"
            >
              <Icon icon={Check} size={13} className="text-ok" />
              <span className="text-[12.5px] font-[550]">{a.displayName}</span>
              {a.globalSkillsDir && (
                <span className="ml-auto font-mono text-[11px] text-text-3">
                  {a.globalSkillsDir}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {found.length > 0 && agents.length > found.length && (
        <p className="mt-2 text-[11.5px] text-text-3">
          {t("wizard.agentsMore", { count: agents.length - found.length })}
        </p>
      )}
      <button
        type="button"
        onClick={next}
        className="mt-5 h-8 rounded-ctl bg-accent px-4 text-[12.5px] font-medium text-white hover:opacity-90"
      >
        {t("wizard.next")}
      </button>
    </div>
  );
}

function SignInStep() {
  const { next } = useWizard();
  // error 必须取出来渲染:漏了它,登录失败在界面上**什么都不显示**,
  // 用户看到的就是"点了授权、回到应用没反应"——2026-08-07 Windows 首个真机版
  // (v0.3.10)登录失败时,真正挡住排查的就是这里(设置页一直有错误行,唯独向导没有)。
  const { status, user, signIn, error } = useSession();
  const signedIn = status === "signedIn";
  const signingIn = status === "signingIn";

  return (
    <div>
      <p className="text-[13px] leading-[1.7] text-text-2">{t("wizard.signInIntro")}</p>
      <div className="mt-4 flex items-center gap-2.5">
        {signedIn ? (
          <>
            <span className="flex items-center gap-1.5 text-[12.5px] text-ok">
              <Icon icon={Check} size={13} />
              {t("wizard.signedInAs", { name: user?.displayName || user?.login || "" })}
            </span>
            <button
              type="button"
              onClick={next}
              className="h-8 rounded-ctl bg-accent px-4 text-[12.5px] font-medium text-white hover:opacity-90"
            >
              {t("wizard.next")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={signingIn}
              onClick={() => void signIn()}
              className="h-8 rounded-ctl bg-accent px-4 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-60"
            >
              {signingIn ? t("wizard.signInWaiting") : t("wizard.signInAction")}
            </button>
            <button
              type="button"
              onClick={next}
              className="h-8 rounded-ctl border border-border px-4 text-[12.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("wizard.skip")}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="mt-3 text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">{error.message}</p>
      )}
    </div>
  );
}

function CuratedStep() {
  const { selected, toggle, seedSelection, installSelected, installing, results, error, finish } =
    useWizard();
  const index = useStoreIndex((s) => s.index);
  const status = useStoreIndex((s) => s.status);
  const setPage = useUi((s) => s.setPage);

  const slugsKey = curatedKey(index?.curated ?? []);
  useEffect(() => {
    if (index) {
      const cards = index.curated.filter((slug) => index.skills.some((s) => s.dirSlug === slug));
      if (cards.length > 0) seedSelection(cards);
    }
    // slugsKey 代表清单内容;index 对象引用每次刷新都会变,不能直接依赖它
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugsKey]);

  if (!index && status === "loading") {
    return <p className="text-[12.5px] text-text-3">{t("wizard.curatedLoading")}</p>;
  }

  const curated = index?.curated ?? [];
  const cards = curated
    .map((slug) => index?.skills.find((s) => s.dirSlug === slug))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  if (cards.length === 0) {
    // 库里没有精选清单:引导去商店,不编一个假清单
    return (
      <div>
        <p className="text-[13px] leading-[1.7] text-text-2">{t("wizard.curatedEmpty")}</p>
        <button
          type="button"
          onClick={() => {
            finish();
            setPage("store");
          }}
          className="mt-4 h-8 rounded-ctl bg-accent px-4 text-[12.5px] font-medium text-white hover:opacity-90"
        >
          {t("wizard.openStore")}
        </button>
      </div>
    );
  }

  if (results) {
    return (
      <div>
        <ul className="flex flex-col gap-1.5">
          {results.map((r) => (
            <ResultRow key={r.dirSlug} item={r} name={nameOf(index, r.dirSlug)} />
          ))}
        </ul>
        <button
          type="button"
          onClick={finish}
          className="mt-5 h-8 rounded-ctl bg-accent px-4 text-[12.5px] font-medium text-white hover:opacity-90"
        >
          {t("wizard.finish")}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[13px] leading-[1.7] text-text-2">{t("wizard.curatedIntro")}</p>
      {error && (
        <p className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">{error.message}</p>
      )}
      <ul className="mt-3 flex flex-col gap-1.5">
        {cards.map((c) => (
          <li key={c.dirSlug}>
            <label className="flex cursor-default items-center gap-2.5 rounded-card border border-border bg-surface-1 px-3 py-2">
              <input
                type="checkbox"
                checked={selected.has(c.dirSlug)}
                onChange={() => toggle(c.dirSlug)}
                className="accent-[var(--accent)]"
              />
              <SkillIcon name={c.name} className="size-[24px] rounded-[6px] text-[11px]" />
              <span className="text-[12.5px] font-[550]">{c.name}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-3">
                {c.description}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={installing || selected.size === 0}
        onClick={() => void installSelected()}
        className="mt-5 h-8 rounded-ctl bg-accent px-4 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {installing ? t("wizard.installing") : t("wizard.installSelected")}
      </button>
    </div>
  );
}

function curatedKey(curated: string[]): string {
  return curated.join("\u0001");
}

function nameOf(
  index: { skills: { dirSlug: string; name: string }[] } | null,
  dirSlug: string,
): string {
  return index?.skills.find((s) => s.dirSlug === dirSlug)?.name ?? dirSlug;
}

function ResultRow({ item, name }: { item: BatchItem; name: string }) {
  return (
    <li className="flex items-center gap-2.5 rounded-card border border-border bg-surface-1 px-3 py-2 text-[12.5px]">
      {item.outcome === "installed" ? (
        <Icon icon={Check} size={13} className="text-ok" />
      ) : (
        <Icon icon={TriangleAlert} size={13} className="text-[#9a6c00] dark:text-[#d4a017]" />
      )}
      <span className="font-[550]">{name}</span>
      <span className="ml-auto text-[11.5px] text-text-3">
        {item.outcome === "installed"
          ? t("wizard.resultInstalled")
          : item.outcome === "skipped"
            ? `${t("wizard.resultSkipped")}${t("punct.labelSeparator")}${item.reason}`
            : `${t("wizard.resultFailed")}${t("punct.labelSeparator")}${item.error.message}`}
      </span>
    </li>
  );
}