import { useEffect, useState } from "react";

import { LogIn } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import type { Accent, CheckReport, RegistryView, ThemeMode } from "@/lib/ipc";
import { skillGlyph } from "@/lib/tint";
import { ACCENT_LABEL_KEY, ACCENT_SWATCH, useAppearance } from "@/store/appearance";
import { useRegistries } from "@/store/registries";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";

/**
 * 设置页(M2 任务 1-2:账号 / 外观 / AI 工具 / 更新;技能库源管理属 M3 registry)。
 * 视觉基准 = UI-Demo 的 set-section / set-card / set-row 形态,信息密度不放宽。
 */
export function SettingsPage() {
  const load = useSettings((s) => s.load);
  const error = useSettings((s) => s.error);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="py-4">
      {error && (
        <p className="mb-3 max-w-[620px] text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {error.message}
        </p>
      )}
      <Section title="settings.sectionAccount">
        <AccountRow />
      </Section>
      <RegistriesSection />
      <Section title="settings.sectionAppearance">
        <ThemeRow />
        <AccentRow />
      </Section>
      <AgentsSection />
      <UpdatesSection />
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

// ============================================================ 技能库来源(M3 任务 2)

function RegistriesSection() {
  const list = useRegistries((s) => s.list);
  const error = useRegistries((s) => s.error);
  const load = useRegistries((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  if (!list) return null;

  return (
    <Section title="settings.sectionRegistries">
      {list.map((r) => (
        <RegistryRow key={r.id} registry={r} />
      ))}
      <AddRegistryRow />
      {error && (
        <div className="border-t border-border px-3.5 py-2 text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">
          {error.message}
        </div>
      )}
    </Section>
  );
}

const FIELD_INPUT =
  "h-7 w-full rounded-ctl border border-border bg-surface-1 px-2 text-[12.5px] outline-none focus:border-accent";
const SMALL_BUTTON =
  "h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50";

function RegistryRow({ registry }: { registry: RegistryView }) {
  const [mode, setMode] = useState<"idle" | "confirmRemove" | "credentials">("idle");
  const [token, setToken] = useState("");
  const remove = useRegistries((s) => s.remove);
  const tokenLogin = useRegistries((s) => s.tokenLogin);
  const busy = useRegistries((s) => s.busy);
  const loggedName = useRegistries((s) => s.loggedIn[registry.id]);

  const name = registry.builtin ? t("registries.builtinName") : registry.name;
  const coords = registry.repo
    ? `${registry.baseUrl} · ${registry.repo.owner}/${registry.repo.repo}`
    : registry.builtin
      ? t("registries.notConfigured")
      : registry.baseUrl;

  return (
    <div className="border-t border-border first:border-t-0">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{name}</span>
            {registry.builtin && (
              <span className="flex-none rounded-[4px] border border-border px-1.5 py-px text-[10.5px] font-medium text-text-3">
                {t("registries.builtinTag")}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11.5px] text-text-3">
            {coords}
            {loggedName &&
              `${t("punct.listSeparator")}${t("registries.loggedInAs", { name: loggedName })}`}
          </div>
        </div>
        {!registry.builtin && mode === "idle" && (
          <div className="flex flex-none items-center gap-1.5">
            <button type="button" className={SMALL_BUTTON} onClick={() => setMode("credentials")}>
              {t("registries.credentials")}
            </button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setMode("confirmRemove")}>
              {t("registries.remove")}
            </button>
          </div>
        )}
        {mode === "confirmRemove" && (
          <div className="flex flex-none items-center gap-1.5">
            <span className="text-[11.5px] text-text-3">{t("registries.removeConfirmHint")}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void remove(registry.id).then(() => setMode("idle"));
              }}
              className="h-6 rounded-ctl border border-[#c0392b]/50 px-2.5 text-[11.5px] font-medium text-[#c0392b] hover:border-[#c0392b] disabled:opacity-50 dark:border-[#e0705f]/50 dark:text-[#e0705f]"
            >
              {t("registries.removeConfirm")}
            </button>
            <button type="button" className={SMALL_BUTTON} onClick={() => setMode("idle")}>
              {t("registries.formCancel")}
            </button>
          </div>
        )}
      </div>
      {mode === "credentials" && (
        <div className="flex items-center gap-2 px-3.5 pb-2.5">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t("registries.tokenPlaceholder")}
            title={t("registries.credentialsHint")}
            spellCheck={false}
            className={cn(FIELD_INPUT, "max-w-[300px] font-mono text-[12px]")}
          />
          <button
            type="button"
            disabled={busy || !token.trim()}
            onClick={() => {
              void tokenLogin(registry.id, token).then((ok) => {
                if (ok) {
                  setMode("idle");
                  setToken("");
                }
              });
            }}
            className={SMALL_BUTTON}
          >
            {t("registries.tokenSubmit")}
          </button>
          <button
            type="button"
            className={SMALL_BUTTON}
            onClick={() => {
              setMode("idle");
              setToken("");
            }}
          >
            {t("registries.formCancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function AddRegistryRow() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const add = useRegistries((s) => s.add);
  const busy = useRegistries((s) => s.busy);

  const reset = () => {
    setOpen(false);
    setName("");
    setBaseUrl("");
    setRepoPath("");
  };

  if (!open) {
    return (
      <Row>
        <button type="button" className={SMALL_BUTTON} onClick={() => setOpen(true)}>
          {t("registries.addButton")}
        </button>
      </Row>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border px-3.5 py-2.5">
      <label className="flex items-center gap-2 text-[11.5px] text-text-3">
        <span className="w-[76px] flex-none">{t("registries.formName")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("registries.formNamePlaceholder")}
          className={FIELD_INPUT}
        />
      </label>
      <label className="flex items-center gap-2 text-[11.5px] text-text-3">
        <span className="w-[76px] flex-none">{t("registries.formBaseUrl")}</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t("registries.formBaseUrlPlaceholder")}
          spellCheck={false}
          className={cn(FIELD_INPUT, "font-mono text-[12px]")}
        />
      </label>
      <label className="flex items-center gap-2 text-[11.5px] text-text-3">
        <span className="w-[76px] flex-none">{t("registries.formRepoPath")}</span>
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder={t("registries.formRepoPathPlaceholder")}
          spellCheck={false}
          className={cn(FIELD_INPUT, "font-mono text-[12px]")}
        />
      </label>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy || !name.trim() || !baseUrl.trim() || !repoPath.trim()}
          onClick={() => {
            void add({ name, baseUrl, repoPath }).then((ok) => {
              if (ok) reset();
            });
          }}
          className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t("registries.formSubmit")}
        </button>
        <button type="button" className={SMALL_BUTTON} onClick={reset}>
          {t("registries.formCancel")}
        </button>
      </div>
    </div>
  );
}

// ============================================================ 外观

const THEME_OPTIONS: { mode: ThemeMode; label: MessageKey }[] = [
  { mode: "light", label: "settings.themeLight" },
  { mode: "dark", label: "settings.themeDark" },
  { mode: "system", label: "settings.themeSystem" },
];

// ============================================================ AI 工具 / 更新

/** Demo 的 .toggle:32×18 圆角开关。原生 button 自带键盘行为,ARIA 用 switch 语义。 */
function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative h-[18px] w-8 flex-none rounded-[10px] transition-colors",
        on ? "bg-accent" : "bg-border-strong",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-[left]",
          on ? "left-[16px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/**
 * AI 工具开关。只列「已检测到的 ∪ 已被关掉的」:未检测到的 agent 本就不进默认勾选,
 * 给它摆开关是没有意义的选项;被关掉但已卸载的仍要显示,否则用户永远找不回开关。
 */
function AgentsSection() {
  const agents = useSettings((s) => s.agents);
  const toggleAgent = useSettings((s) => s.toggleAgent);
  if (!agents) return null;

  const rows = agents.filter((a) => a.installed || a.disabled);
  if (rows.length === 0) return null;

  return (
    <Section title="settings.sectionAgents">
      {rows.map((agent) => (
        <Row key={agent.name}>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{agent.displayName}</div>
            <div className="truncate font-mono text-[11.5px] text-text-3">
              {agent.installed ? (agent.globalSkillsDir ?? "") : t("settings.agentNotDetected")}
            </div>
          </div>
          <div className="ml-auto">
            <Toggle
              on={!agent.disabled}
              label={agent.displayName}
              onChange={() => void toggleAgent(agent.name)}
            />
          </div>
        </Row>
      ))}
    </Section>
  );
}

const FREQ_OPTIONS: { label: MessageKey; enabled: boolean; intervalHours?: number }[] = [
  { label: "settings.freqManual", enabled: false },
  { label: "settings.freqEvery4h", enabled: true, intervalHours: 4 },
  { label: "settings.freqDaily", enabled: true, intervalHours: 24 },
];

function UpdatesSection() {
  const autoUpdate = useSettings((s) => s.autoUpdate);
  const setSkillsUpdate = useSettings((s) => s.setSkillsUpdate);
  const setAppUpdate = useSettings((s) => s.setAppUpdate);
  if (!autoUpdate) return null;

  const active = (opt: (typeof FREQ_OPTIONS)[number]) =>
    opt.enabled === autoUpdate.skills.enabled &&
    (!opt.enabled || opt.intervalHours === autoUpdate.skills.intervalHours);

  return (
    <Section title="settings.sectionUpdates">
      <Row>
        <RowText label={t("settings.autoSkills")} desc={t("settings.autoSkillsHint")} />
        <div
          className="ml-auto flex overflow-hidden rounded-ctl border border-border"
          role="group"
          aria-label={t("settings.autoSkills")}
        >
          {FREQ_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              aria-pressed={active(opt)}
              onClick={() =>
                void setSkillsUpdate({ enabled: opt.enabled, intervalHours: opt.intervalHours })
              }
              className={cn(
                "border-l border-border px-2.5 py-[3px] text-[12px] text-text-2 first:border-l-0",
                active(opt) && "bg-surface-3 font-[550] text-text",
              )}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </Row>
      <Row>
        <RowText label={t("settings.autoApp")} desc={t("settings.autoAppHint")} />
        <div className="ml-auto">
          <Toggle
            on={autoUpdate.app}
            label={t("settings.autoApp")}
            onChange={() => void setAppUpdate(!autoUpdate.app)}
          />
        </div>
      </Row>
      <CheckNowRow />
      <AppUpdateRow />
    </Section>
  );
}

/** App 自更新行:检查 → 有新版 → 下载安装 → 提示重启。 */
function AppUpdateRow() {
  const appUpdate = useSettings((s) => s.appUpdate);
  const checkAppUpdate = useSettings((s) => s.checkAppUpdate);
  const installAppUpdate = useSettings((s) => s.installAppUpdate);
  const restartApp = useSettings((s) => s.restartApp);

  const desc = (() => {
    switch (appUpdate.phase) {
      case "upToDate":
        return t("settings.appUpToDate");
      case "available":
      case "installing":
        return t("settings.appAvailable", { version: appUpdate.version });
      case "installed":
        return t("settings.appInstalled");
      case "failed":
        return appUpdate.error.message;
      default:
        return t("settings.appUpdateHint");
    }
  })();

  const button = (() => {
    switch (appUpdate.phase) {
      case "checking":
        return { label: t("settings.checking"), action: undefined, disabled: true };
      case "available":
        return { label: t("settings.appInstall"), action: installAppUpdate, disabled: false };
      case "installing":
        return { label: t("settings.appInstalling"), action: undefined, disabled: true };
      case "installed":
        return { label: t("settings.appRestart"), action: restartApp, disabled: false };
      default:
        return { label: t("settings.appCheck"), action: checkAppUpdate, disabled: false };
    }
  })();

  return (
    <Row>
      <RowText label={t("settings.appCheck")} desc={desc} />
      <div className="ml-auto">
        <button
          type="button"
          disabled={button.disabled}
          onClick={() => button.action && void button.action()}
          className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
        >
          {button.label}
        </button>
      </div>
    </Row>
  );
}

/** 报告 → 一句人话。目录名是内部标识,这里只报数量,明细去「我的技能」看。 */
function reportSummary(report: CheckReport): string {
  switch (report.status) {
    case "nothingInstalled":
      return t("settings.checkReportNothing");
    case "upToDate":
      return t("settings.checkReportUpToDate");
    case "checked":
      return t("settings.checkReportSummary", {
        updated: report.updated.length,
        skipped: report.skipped.length,
        failed: report.failed.length,
      });
  }
}

function CheckNowRow() {
  const checkNow = useSettings((s) => s.checkNow);
  const checking = useSettings((s) => s.checking);
  const lastReport = useSettings((s) => s.lastReport);

  return (
    <Row>
      <RowText
        label={t("settings.checkNow")}
        desc={lastReport ? reportSummary(lastReport) : t("settings.checkNowHint")}
      />
      <div className="ml-auto">
        <button
          type="button"
          disabled={checking}
          onClick={() => void checkNow()}
          className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
        >
          {checking ? t("settings.checking") : t("settings.checkNow")}
        </button>
      </div>
    </Row>
  );
}

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
