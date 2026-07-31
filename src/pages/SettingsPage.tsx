import { LogIn } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import type { Accent, ThemeMode } from "@/lib/ipc";
import { skillGlyph } from "@/lib/tint";
import { ACCENT_LABEL_KEY, ACCENT_SWATCH, useAppearance } from "@/store/appearance";
import { useSession } from "@/store/session";

/**
 * 设置页(M2 任务 1:账号 + 外观;技能库/Agent/更新分区随任务 2 落地)。
 * 视觉基准 = UI-Demo 的 set-section / set-card / set-row 形态,信息密度不放宽。
 */
export function SettingsPage() {
  return (
    <div className="py-4">
      <Section title="settings.sectionAccount">
        <AccountRow />
      </Section>
      <Section title="settings.sectionAppearance">
        <ThemeRow />
        <AccentRow />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: MessageKey; children: React.ReactNode }) {
  return (
    <section className="mb-[26px] max-w-[620px]">
      <h3 className="mb-2 text-[11px] font-[550] tracking-[0.05em] text-text-3">{t(title)}</h3>
      <div className="rounded-card border border-border bg-surface-1">{children}</div>
    </section>
  );
}

/** set-row:首行无上边框,其余行 1px 分隔。 */
function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0">
      {children}
    </div>
  );
}

function RowText({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] font-medium">{label}</div>
      <div className="text-[11.5px] text-text-3">{desc}</div>
    </div>
  );
}

// ============================================================ 账号

function AccountRow() {
  const { status, user, signIn, signOut, error } = useSession();

  if (status === "signedIn" && user) {
    return (
      <Row>
        <span className="grid size-[26px] flex-none place-items-center rounded-full border border-border-strong bg-surface-3 text-[11px] font-semibold text-text-2">
          {skillGlyph(user.displayName)}
        </span>
        <RowText label={user.displayName} desc={t("account.connectedTo")} />
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void signOut()}
            className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("account.signOut")}
          </button>
        </div>
      </Row>
    );
  }

  return (
    <Row>
      <span className="grid size-[26px] flex-none place-items-center rounded-full border border-border-strong bg-surface-3 text-text-3">
        <Icon icon={LogIn} size={13} />
      </span>
      <RowText label={t("account.signedOut")} desc={t("account.signInHint")} />
      <div className="ml-auto flex items-center gap-2">
        {error && (
          <span className="text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">{error.message}</span>
        )}
        <button
          type="button"
          onClick={() => void signIn()}
          disabled={status === "signingIn"}
          className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
        >
          {status === "signingIn" ? t("account.signingIn") : t("account.signIn")}
        </button>
      </div>
    </Row>
  );
}

// ============================================================ 外观

const THEME_OPTIONS: { mode: ThemeMode; label: MessageKey }[] = [
  { mode: "light", label: "settings.themeLight" },
  { mode: "dark", label: "settings.themeDark" },
  { mode: "system", label: "settings.themeSystem" },
];

function ThemeRow() {
  const mode = useAppearance((s) => s.mode);
  const setMode = useAppearance((s) => s.setMode);

  return (
    <Row>
      <RowText label={t("settings.theme")} desc={t("settings.themeHint")} />
      <div
        className="ml-auto flex overflow-hidden rounded-ctl border border-border"
        role="group"
        aria-label={t("settings.theme")}
      >
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.mode}
            type="button"
            aria-pressed={mode === opt.mode}
            onClick={() => setMode(opt.mode)}
            className={cn(
              "border-l border-border px-2.5 py-[3px] text-[12px] text-text-2 first:border-l-0",
              mode === opt.mode && "bg-surface-3 font-[550] text-text",
            )}
          >
            {t(opt.label)}
          </button>
        ))}
      </div>
    </Row>
  );
}

function AccentRow() {
  const accent = useAppearance((s) => s.accent);
  const setAccent = useAppearance((s) => s.setAccent);

  return (
    <Row>
      <RowText label={t("settings.accent")} desc={t("settings.accentHint")} />
      <div
        className="ml-auto flex items-center gap-1"
        role="group"
        aria-label={t("settings.accent")}
      >
        {(Object.keys(ACCENT_SWATCH) as Accent[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={accent === key}
            onClick={() => setAccent(key)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-ctl border border-transparent px-2 text-[12px] text-text-2 hover:bg-surface-3",
              accent === key && "border-border bg-surface-3 font-[550] text-text",
            )}
          >
            <span className="size-[11px] rounded-full" style={{ background: ACCENT_SWATCH[key] }} />
            {t(ACCENT_LABEL_KEY[key])}
          </button>
        ))}
      </div>
    </Row>
  );
}
