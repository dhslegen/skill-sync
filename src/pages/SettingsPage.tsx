import { useEffect, useState } from "react";

import { ChevronDown, ChevronRight, LogIn } from "lucide-react";

import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { PLAZA_REGISTRY_ID, type Accent, type CheckReport, type RegistryView, type ReleaseNote, type RepoView, type ThemeMode } from "@/lib/ipc";
import { skillGlyph } from "@/lib/tint";
import { ACCENT_LABEL_KEY, ACCENT_SWATCH, useAppearance } from "@/store/appearance";
import { useChangelog } from "@/store/changelog";
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
      <VersionHistorySection />
    </div>
  );
}

/**
 * 版本历史:全部发版说明,默认全收起。
 *
 * 与商店页那张升级后卡片是**同一份数据的两个出口**(`store/changelog.ts` 的
 * `all` 与 `pending`),不各拉一次、更不各解析一份——口径一漂就是"卡片说改了三条、
 * 设置页里那一版只有两条"。
 *
 * 默认全收起是因为标题本身就是一句话主题(`## 0.3.13 —— 窗口终于能用鼠标拖动了`),
 * 扫一眼就够;要读正文才点开。
 */
function VersionHistorySection() {
  const all = useChangelog((s) => s.all);
  const load = useChangelog((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section title="settings.sectionVersionHistory">
      {all.length === 0 ? (
        <Row>
          <span className="text-[12.5px] text-text-3">{t("settings.versionHistoryEmpty")}</span>
        </Row>
      ) : (
        all.map((note) => <VersionRow key={note.versions.join("/")} note={note} />)
      )}
    </Section>
  );
}

function VersionRow({ note }: { note: ReleaseNote }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-border px-3.5 py-2.5 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        {/* 没有这个指示的话,真机上一眼看不出这些行是能点开的(自查发现) */}
        <Icon
          icon={open ? ChevronDown : ChevronRight}
          size={13}
          className="shrink-0 text-text-3"
        />
        {/* 版本号用等宽字体(UI 规范:slug/sha/版本号一律等宽) */}
        <span className="font-mono text-[12px] text-text-2">{note.versions.join(" / ")}</span>
        {note.theme && <span className="flex-1 truncate text-[12.5px] text-text">{note.theme}</span>}
        {/* 日期靠右:一列版本号里,"这是上周的还是去年的"是最先要看清的事。
            没有日期的(还没发出去的那一版)整个不摆,不占位也不编。 */}
        {note.date && (
          <span className="shrink-0 font-mono text-[11px] text-text-3">{note.date}</span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 text-[12.5px]">
          <Markdown source={note.body} />
        </div>
      )}
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
  const [mode, setMode] = useState<"idle" | "confirmRemove" | "credentials" | "addRepo">("idle");
  const [token, setToken] = useState("");
  const remove = useRegistries((s) => s.remove);
  const tokenLogin = useRegistries((s) => s.tokenLogin);
  const deviceLogin = useRegistries((s) => s.deviceLogin);
  const dismissDevicePrompt = useRegistries((s) => s.dismissDevicePrompt);
  const busy = useRegistries((s) => s.busy);
  const loggedName = useRegistries((s) => s.loggedIn[registry.id]);
  const devicePrompt = useRegistries((s) => s.devicePrompt);
  const myDevicePrompt = devicePrompt?.registryId === registry.id ? devicePrompt : null;

  // 广场是锁定的系统源(M9):不落 config.registries,不接受手填的追加库/移除
  // ——`registry_add_repo`/`registry_remove` 对它一律报 `REPO_BUILTIN_LOCKED`
  // (见 core/registry.rs)。摆一个必然报错的按钮不如不摆(M6 沉淀 3「不摆比解释好」)。
  const isPlaza = registry.id === PLAZA_REGISTRY_ID;
  const name = registry.builtin ? t("registries.builtinName") : registry.name;
  const coords = registry.repo
    ? `${registry.baseUrl} · ${registry.repo.owner}/${registry.repo.repo}`
    : registry.builtin
      ? t("registries.notConfigured")
      : registry.baseUrl;
  // 追加技能库只对能解析出坐标的源开放:内建未注入配置的构建没有主仓,谈不上追加;
  // 广场的仓只能由"获取一个搜索结果"这个动作追加,这里的通用表单对它无效。
  const canAddRepo = registry.repos.length > 0 && !isPlaza;

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
            {isPlaza && (
              <span className="flex-none rounded-[4px] border border-border px-1.5 py-px text-[10.5px] font-medium text-text-3">
                {t("registries.plazaTag")}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11.5px] text-text-3">
            {coords}
            {loggedName &&
              `${t("punct.listSeparator")}${t("registries.loggedInAs", { name: loggedName })}`}
          </div>
        </div>
        {mode === "idle" && (
          <div className="flex flex-none items-center gap-1.5">
            {!registry.builtin && registry.kind === "github" && (
              // GitHub 的主通道:device flow 一键登录(任务 5);下面的凭证输入是备用。
              // 广场同样支持它——可选登录只是为了把匿名 60 次/时的配额提到 5000
              // (设计文档 §2.5),不是"广场需要账号才能用"。
              <button
                type="button"
                disabled={busy || myDevicePrompt !== null}
                className={SMALL_BUTTON}
                onClick={() => void deviceLogin(registry.id)}
              >
                {myDevicePrompt ? t("registries.deviceWaiting") : t("registries.deviceLogin")}
              </button>
            )}
            {canAddRepo && (
              // 一源多仓(M4 任务 1):内建源 = 同一公司 Gitea 上的其他技能库;
              // 自定义源 = 同服务器上的另一个库
              <button type="button" className={SMALL_BUTTON} onClick={() => setMode("addRepo")}>
                {t("registries.addRepoButton")}
              </button>
            )}
            {!registry.builtin && !isPlaza && (
              <>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  onClick={() => setMode("credentials")}
                >
                  {t("registries.credentials")}
                </button>
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  onClick={() => setMode("confirmRemove")}
                >
                  {t("registries.remove")}
                </button>
              </>
            )}
            {!registry.builtin && isPlaza && (
              <button
                type="button"
                className={SMALL_BUTTON}
                onClick={() => setMode("credentials")}
              >
                {t("registries.credentials")}
              </button>
            )}
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
      {/*
        广场没有"头部那行坐标"(它没有主仓概念,coords 摆的是 baseUrl,不是任何
        一个具体的仓)——门槛因此降到 > 0:哪怕只挂了一个仓,也得展开子列表,
        不然用户挂上的那个仓在设置页里完全不可见。其余源仍是 > 1(单库时头部
        坐标已经说清,重复一行是噪音)。
      */}
      {registry.repos.length > (isPlaza ? 0 : 1) && (
        <div className="flex flex-col gap-1 px-3.5 pb-2.5">
          {registry.repos.map((repo) => (
            <RepoRow key={repo.key} registryId={registry.id} repo={repo} removable={!isPlaza} />
          ))}
        </div>
      )}
      {mode === "addRepo" && (
        <AddRepoForm registryId={registry.id} onClose={() => setMode("idle")} />
      )}
      {myDevicePrompt && (
        <div className="flex items-center gap-2.5 px-3.5 pb-2.5">
          <span className="rounded-ctl border border-border-strong bg-surface-3 px-2.5 py-1 font-mono text-[15px] font-semibold tracking-[0.12em] select-text">
            {myDevicePrompt.userCode}
          </span>
          <span className="text-[11.5px] text-text-3">{t("registries.deviceCodeHint")}</span>
          <button type="button" className={SMALL_BUTTON} onClick={dismissDevicePrompt}>
            {t("registries.formCancel")}
          </button>
        </div>
      )}
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

/** 源下的一个技能库(M4 一源多仓)。锁定的主仓不给移除入口;移除走内联双确认。 */
function RepoRow({
  registryId,
  repo,
  removable = true,
}: {
  registryId: string;
  repo: RepoView;
  /**
   * 广场的仓 v1 不提供 UI 移除入口(设计文档 §2.3):`registry_remove_repo` 只在
   * `config.registries` 里找,广场的仓记在独立的 `plaza_repos`,压根找不到这个
   * registryId,报出来的错误("找不到这个技能库来源")还文不对题。
   */
  removable?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const removeRepo = useRegistries((s) => s.removeRepo);
  const busy = useRegistries((s) => s.busy);

  return (
    <div className="flex items-center gap-2 rounded-ctl border border-border bg-surface-1 px-2.5 py-1.5">
      <span className="truncate text-[12px] font-medium">{repo.name ?? repo.repo}</span>
      {repo.primary && (
        <span className="flex-none rounded-[4px] border border-border px-1.5 py-px text-[10.5px] font-medium text-text-3">
          {t("registries.repoPrimaryTag")}
        </span>
      )}
      <span className="truncate font-mono text-[11px] text-text-3">{repo.key}</span>
      {removable && !repo.locked && !confirming && (
        <button
          type="button"
          className={cn(SMALL_BUTTON, "ml-auto")}
          onClick={() => setConfirming(true)}
        >
          {t("registries.remove")}
        </button>
      )}
      {confirming && (
        <div className="ml-auto flex flex-none items-center gap-1.5">
          <span className="text-[11.5px] text-text-3">{t("registries.removeConfirmHint")}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void removeRepo(registryId, repo.key).then(() => setConfirming(false));
            }}
            className="h-6 rounded-ctl border border-[#c0392b]/50 px-2.5 text-[11.5px] font-medium text-[#c0392b] hover:border-[#c0392b] disabled:opacity-50 dark:border-[#e0705f]/50 dark:text-[#e0705f]"
          >
            {t("registries.removeConfirm")}
          </button>
          <button type="button" className={SMALL_BUTTON} onClick={() => setConfirming(false)}>
            {t("registries.formCancel")}
          </button>
        </div>
      )}
    </div>
  );
}

/** 给源追加技能库的表单:路径(所属者/名称)+ 可选显示名。
 *  与添加来源的表单同一套字段风格;不暴露分支输入,缺省 main(与添加来源一致)。 */
function AddRepoForm({ registryId, onClose }: { registryId: string; onClose: () => void }) {
  const [repoPath, setRepoPath] = useState("");
  const [name, setName] = useState("");
  const addRepo = useRegistries((s) => s.addRepo);
  const busy = useRegistries((s) => s.busy);

  return (
    <div className="flex flex-col gap-2 px-3.5 pb-2.5">
      <label className="flex items-center gap-2 text-[11.5px] text-text-3">
        <span className="w-[76px] flex-none">{t("registries.formRepoPath")}</span>
        <input
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder={t("registries.formRepoPathPlaceholder")}
          spellCheck={false}
          className={cn(FIELD_INPUT, "max-w-[300px] font-mono text-[12px]")}
        />
      </label>
      <label className="flex items-center gap-2 text-[11.5px] text-text-3">
        <span className="w-[76px] flex-none">{t("registries.formName")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("registries.repoNamePlaceholder")}
          className={cn(FIELD_INPUT, "max-w-[300px]")}
        />
      </label>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy || !repoPath.trim()}
          onClick={() => {
            void addRepo(registryId, { repoPath, name }).then((ok) => {
              if (ok) onClose();
            });
          }}
          className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t("registries.formSubmit")}
        </button>
        <button type="button" className={SMALL_BUTTON} onClick={onClose}>
          {t("registries.formCancel")}
        </button>
      </div>
    </div>
  );
}

function AddRegistryRow() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"gitea" | "github">("gitea");
  const [baseUrl, setBaseUrl] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const add = useRegistries((s) => s.add);
  const busy = useRegistries((s) => s.busy);

  const reset = () => {
    setOpen(false);
    setName("");
    setKind("gitea");
    setBaseUrl("");
    setRepoPath("");
  };

  // GitHub 的地址是固定的,替用户填好;切回 Gitea 时清掉,避免残留误导
  const pickKind = (next: "gitea" | "github") => {
    setKind(next);
    setBaseUrl(next === "github" ? "https://github.com" : "");
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
      <div className="flex items-center gap-2 text-[11.5px] text-text-3">
        <span className="w-[76px] flex-none">{t("registries.formKind")}</span>
        <div
          className="flex overflow-hidden rounded-ctl border border-border"
          role="group"
          aria-label={t("registries.formKind")}
        >
          {(["gitea", "github"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => pickKind(k)}
              className={cn(
                "border-l border-border px-2.5 py-[3px] text-[12px] text-text-2 first:border-l-0",
                kind === k && "bg-surface-3 font-[550] text-text",
              )}
            >
              {k === "gitea" ? "Gitea" : "GitHub"}
            </button>
          ))}
        </div>
      </div>
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
            void add({ name, kind, baseUrl, repoPath }).then((ok) => {
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

// 间隔单位是**分钟**(schema v2 起)。5 分钟那一档是给"急着验刚发的新版"用的
// ——0.3.x 那几轮自更新验证反复证明:等 4 小时等于没有自动更新。
const FREQ_OPTIONS: { label: MessageKey; enabled: boolean; intervalMinutes?: number }[] = [
  { label: "settings.freqManual", enabled: false },
  { label: "settings.freqEvery5m", enabled: true, intervalMinutes: 5 },
  { label: "settings.freqEvery4h", enabled: true, intervalMinutes: 240 },
  { label: "settings.freqDaily", enabled: true, intervalMinutes: 1440 },
];

function UpdatesSection() {
  const autoUpdate = useSettings((s) => s.autoUpdate);
  const setSkillsUpdate = useSettings((s) => s.setSkillsUpdate);
  const setAppUpdate = useSettings((s) => s.setAppUpdate);
  if (!autoUpdate) return null;

  const active = (opt: (typeof FREQ_OPTIONS)[number]) =>
    opt.enabled === autoUpdate.skills.enabled &&
    (!opt.enabled || opt.intervalMinutes === autoUpdate.skills.intervalMinutes);

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
                void setSkillsUpdate({ enabled: opt.enabled, intervalMinutes: opt.intervalMinutes })
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
