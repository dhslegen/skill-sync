import { ExternalLink, FileCode, FileText, Folder, FolderOpen, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { InstallPanel } from "@/components/InstallPanel";
import { Markdown } from "@/components/Markdown";
import { SkillIcon } from "@/components/SkillIcon";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes, relativeTimeFromIso, shortSha } from "@/lib/format";
import { isAppError, openLibraryUrl, type LocalSkillDetail, type SkillDetail } from "@/lib/ipc";
import { useLocalDetail } from "@/store/local-detail";
import { locatePlazaSkill, usePlaza } from "@/store/plaza";
import { useStoreIndex } from "@/store/store-index";

/** 详情是右侧滑出面板,不整页跳转(UI 规范 §5:借 Raycast 的"详情不跳页")。
 *  三个数据源共用同一个壳:商店详情(远端缓存)、本地详情(我的技能/分享页,直接读盘)、
 *  技能广场详情(M9 任务 5,现拉——"详情面板不联网"承诺的唯一破例,范围钉死在广场,
 *  见 core/plaza.rs 模块头)。 */
export function DetailPanel() {
  const { detailSlug, detail, detailError, closeDetail, index } = useStoreIndex();
  const local = useLocalDetail();
  const plaza = usePlaza();
  const localOpen = local.target !== null;
  const plazaOpen = plaza.detailOwnerRepo !== null;
  const open = detailSlug !== null || localOpen || plazaOpen;
  const close = localOpen ? local.close : plazaOpen ? plaza.closeDetail : closeDetail;
  const plazaMatched =
    plazaOpen && plaza.detailSkills
      ? locatePlazaSkill(plaza.detailSkills, plaza.detailWantedName, plaza.selectedDirSlug)
      : null;
  const title = localOpen
    ? local.detail?.name
    : plazaOpen
      ? (plazaMatched?.name ?? plaza.detailWantedName ?? plaza.detailOwnerRepo ?? undefined)
      : detail?.name;
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // 焦点管理。声明了 aria-modal 就得真的把焦点圈住:
  // 否则 Tab 会走到遮罩背后的卡片列表里,读屏用户完全不知道自己已经离开了面板。
  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    // 关闭时把焦点还给点开它的那张卡片,而不是丢回 <body>
    return () => returnFocusTo.current?.focus?.();
  }, [open]);

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div
        aria-hidden
        onClick={close}
        className={cn(
          "fixed inset-0 z-50 bg-[rgba(15,14,12,.25)] backdrop-blur-[2px] transition-opacity duration-150",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? t("detail.loading")}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          "fixed inset-y-0 right-0 z-51 flex w-[480px] flex-col border-l border-border bg-surface-1 shadow-[var(--shadow-pop)] outline-none",
          "transition-[transform,opacity] duration-[180ms] ease-out",
          open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0",
        )}
      >
        {localOpen ? (
          local.detail ? (
            <LocalPanelBody detail={local.detail} />
          ) : (
            <div className="p-5 text-[12.5px] text-text-3">
              {local.error ? local.error.message : t("detail.loading")}
            </div>
          )
        ) : plazaOpen ? (
          <PlazaPanelBody />
        ) : open && detail ? (
          <PanelBody detail={detail} repo={index?.repo ?? ""} />
        ) : open ? (
          <div className="p-5 text-[12.5px] text-text-3">
            {detailError ? detailError.message : t("detail.loading")}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** 「在访达/资源管理器中打开」的按钮文案按平台挑。webview 里没有可靠的 OS API,
 *  userAgent 足够区分三档——挑错平台也只是措辞不地道,不影响行为。 */
export function revealLabel(userAgent: string): string {
  if (userAgent.includes("Mac")) return t("detail.revealMac");
  if (userAgent.includes("Windows")) return t("detail.revealWin");
  return t("detail.revealOther");
}

function LocalPanelBody({ detail }: { detail: LocalSkillDetail }) {
  const { close, reveal, revealError } = useLocalDetail();
  const [tab, setTab] = useState<"readme" | "files">("readme");

  return (
    <>
      <div className="px-5 pt-[18px]">
        <div className="flex items-center gap-3">
          <SkillIcon name={detail.name} className="size-10 rounded-[10px] text-[17px]" />
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-[650] tracking-[-0.015em]">{detail.name}</h2>
            <div className="mt-px truncate font-mono text-[11.5px] text-text-3" title={detail.path}>
              {detail.path}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            title={t("detail.close")}
            aria-label={t("detail.close")}
            className="ml-auto grid size-7 shrink-0 place-items-center self-start rounded-ctl text-text-2 hover:bg-surface-3 hover:text-text"
          >
            <Icon icon={X} />
          </button>
        </div>

        <div className="mt-3.5 flex gap-4 border-y border-border py-2.5">
          <Meta
            label={t("detail.metaFiles")}
            value={t("detail.metaFilesValue", { count: detail.files.length })}
          />
        </div>
      </div>

      <div className="flex gap-0.5 px-5 pt-2.5" role="tablist">
        <Tab selected={tab === "readme"} onClick={() => setTab("readme")}>
          {t("detail.tabReadme")}
        </Tab>
        <Tab selected={tab === "files"} onClick={() => setTab("files")}>
          {t("detail.tabFiles", { count: detail.files.length })}
        </Tab>
      </div>

      <div className="selectable flex-1 overflow-y-auto px-5 pb-5 pt-3.5">
        {tab === "readme" ? (
          stripFrontmatter(detail.skillMd).trim() ? (
            <Markdown source={stripFrontmatter(detail.skillMd)} />
          ) : (
            <p className="text-[12.5px] text-text-3">{t("detail.noBody")}</p>
          )
        ) : (
          <FileTree detail={detail} />
        )}
      </div>

      <div className="border-t border-border px-5 py-3">
        <button
          type="button"
          onClick={() => void reveal()}
          className="inline-flex h-7 items-center gap-1.5 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          <Icon icon={FolderOpen} />
          {revealLabel(navigator.userAgent)}
        </button>
        {revealError && (
          <p className="mt-1.5 text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">
            {revealError.message}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * 技能广场详情态(M9 任务 5)。数据来自 `usePlaza`(现拉,不是索引缓存),
 * 三档:加载中/错误(+ 重试)/成功。成功之后还有一层"定位不到点击的那个"
 * (设计文档 §2.2:一个仓多个技能,名字对不上就落到该仓技能列表让用户挑)。
 */
function PlazaPanelBody() {
  const {
    detailOwnerRepo,
    detailWantedName,
    detailSlug,
    detailSkills,
    detailStatus,
    detailError,
    selectedDirSlug,
    retryDetail,
    selectDetailSkill,
  } = usePlaza();

  if (detailStatus === "error") {
    return (
      <div className="p-5">
        <p className="text-[12.5px] text-text-2">{detailError?.message}</p>
        <button
          type="button"
          onClick={() => void retryDetail()}
          className="mt-2.5 h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("store.retry")}
        </button>
      </div>
    );
  }

  if (detailStatus !== "ready" || !detailSkills) {
    return <div className="p-5 text-[12.5px] text-text-3">{t("detail.loading")}</div>;
  }

  const matched = locatePlazaSkill(detailSkills, detailWantedName, selectedDirSlug);
  if (matched) {
    return (
      <PanelBody
        detail={matched}
        repo={detailOwnerRepo ?? ""}
        plaza={{ ownerRepo: detailOwnerRepo ?? "", slug: detailSlug ?? "" }}
      />
    );
  }

  return (
    <PlazaSkillPicker ownerRepo={detailOwnerRepo ?? ""} skills={detailSkills} onPick={selectDetailSkill} />
  );
}

/** 定位不到点击的那个技能时,落到该仓的技能列表让用户另选一个。 */
function PlazaSkillPicker({
  ownerRepo,
  skills,
  onPick,
}: {
  ownerRepo: string;
  skills: SkillDetail[];
  onPick: (dirSlug: string) => void;
}) {
  const closePlaza = usePlaza((s) => s.closeDetail);

  return (
    <>
      <div className="flex items-center gap-3 px-5 pt-[18px]">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[15px] font-[650]">{ownerRepo}</h2>
        </div>
        <button
          type="button"
          onClick={closePlaza}
          title={t("detail.close")}
          aria-label={t("detail.close")}
          className="grid size-7 shrink-0 place-items-center self-start rounded-ctl text-text-2 hover:bg-surface-3 hover:text-text"
        >
          <Icon icon={X} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-5 pt-3.5">
        {skills.length === 0 ? (
          <p className="text-[12.5px] text-text-3">{t("store.empty")}</p>
        ) : (
          <>
            <p className="mb-2.5 text-[12px] text-text-3">{t("plaza.detailAmbiguous")}</p>
            <div className="flex flex-col gap-1.5">
              {skills.map((s) => (
                <button
                  key={s.dirSlug}
                  type="button"
                  onClick={() => onPick(s.dirSlug)}
                  className="rounded-card border border-border px-3 py-2 text-left hover:border-border-strong"
                >
                  <div className="text-[13px] font-medium">{s.name}</div>
                  {s.description && (
                    <div className="clamp-2 mt-0.5 text-[12px] text-text-2">{s.description}</div>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** 跳去 skills.sh 的技能页——`open_library_url` 通道,同源白名单已在 core 放行(M9)。 */
function PlazaBrowserLink({ slug }: { slug: string }) {
  const [openError, setOpenError] = useState<string | null>(null);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => {
          setOpenError(null);
          openLibraryUrl(`https://skills.sh/${slug}`).catch((raw) =>
            setOpenError(isAppError(raw) ? raw.message : t("error.generic")),
          );
        }}
        className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-accent hover:underline"
      >
        <Icon icon={ExternalLink} size={12} />
        {t("plaza.openInBrowser")}
      </button>
      {openError && (
        <p className="mt-1 text-[11px] text-[#c0392b] dark:text-[#e0705f]">{openError}</p>
      )}
    </div>
  );
}

function PanelBody({
  detail,
  repo,
  plaza,
}: {
  detail: SkillDetail;
  repo: string;
  /** 广场态(M9 任务 5):关闭走广场自己的 store,多一个"在浏览器查看"入口,
   *  底部获取区带着来源坐标走 `beginFromPlaza`。 */
  plaza?: { ownerRepo: string; slug: string };
}) {
  const closeDetailStore = useStoreIndex((s) => s.closeDetail);
  const closePlaza = usePlaza((s) => s.closeDetail);
  const closeDetail = plaza ? closePlaza : closeDetailStore;
  const [tab, setTab] = useState<"readme" | "files">("readme");

  return (
    <>
      <div className="px-5 pt-[18px]">
        <div className="flex items-center gap-3">
          <SkillIcon name={detail.name} className="size-10 rounded-[10px] text-[17px]" />
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-[650] tracking-[-0.015em]">{detail.name}</h2>
            <div className="mt-px truncate font-mono text-[11.5px] text-text-3">
              {repo}/{detail.dirSlug} @ {shortSha(detail.commitSha)}
            </div>
          </div>
          <button
            type="button"
            onClick={closeDetail}
            title={t("detail.close")}
            aria-label={t("detail.close")}
            className="ml-auto grid size-7 shrink-0 place-items-center self-start rounded-ctl text-text-2 hover:bg-surface-3 hover:text-text"
          >
            <Icon icon={X} />
          </button>
        </div>
        {plaza && <PlazaBrowserLink slug={plaza.slug} />}

        <div className="mt-3.5 flex flex-wrap gap-4 border-y border-border py-2.5">
          {/* 作者/贡献者来自技能库的 authors.json(服务端维护);没有就整栏不摆。
              作者排第一,对齐 UI-Demo 的 p-meta 顺序 */}
          {detail.attribution && (
            <Meta label={t("detail.metaAuthor")} value={detail.attribution.author} />
          )}
          <Meta label={t("detail.metaUpdated")} value={relativeTimeFromIso(detail.committedAt)} />
          <Meta label={t("detail.metaVersion")} value={shortSha(detail.commitSha)} mono />
          <Meta
            label={t("detail.metaFiles")}
            value={t("detail.metaFilesValue", { count: detail.files.length })}
          />
          {/* 标签来自技能库的 tags.json(服务端管理);没有就整栏不摆 */}
          {detail.tags.length > 0 && (
            <Meta label={t("detail.metaTags")} value={detail.tags.join(t("punct.listSeparator"))} />
          )}
          {detail.attribution && detail.attribution.contributors.length > 0 && (
            <Meta
              label={t("detail.metaContributors")}
              value={contributorsText(detail.attribution.contributors)}
            />
          )}
        </div>
      </div>

      <div className="flex gap-0.5 px-5 pt-2.5" role="tablist">
        <Tab selected={tab === "readme"} onClick={() => setTab("readme")}>
          {t("detail.tabReadme")}
        </Tab>
        <Tab selected={tab === "files"} onClick={() => setTab("files")}>
          {t("detail.tabFiles", { count: detail.files.length })}
        </Tab>
      </div>

      {/* 正文区是全站唯一放开选中与文本光标的地方 */}
      <div className="selectable flex-1 overflow-y-auto px-5 pb-5 pt-3.5">
        {tab === "readme" ? (
          detail.skillMd.trim() ? (
            <Markdown source={stripFrontmatter(detail.skillMd)} />
          ) : (
            <p className="text-[12.5px] text-text-3">{t("detail.noBody")}</p>
          )
        ) : (
          <FileTree detail={detail} />
        )}
      </div>

      <InstallPanel dirSlug={detail.dirSlug} plaza={plaza ? { ownerRepo: plaza.ownerRepo } : undefined} />
    </>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="text-[11px] leading-[1.4] text-text-3">
      {label}
      <b
        className={cn(
          "block text-[12.5px] font-[550] text-text",
          mono && "font-mono font-medium",
        )}
      >
        {value || "—"}
      </b>
    </div>
  );
}

function Tab({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "rounded-ctl px-2.5 py-[5px] text-[12.5px] font-medium",
        selected ? "bg-accent-soft font-[550] text-accent" : "text-text-2 hover:bg-surface-3 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|ps1|rb)$/i;

/** 文件树。对脚本文件单独用另一种图标,并在目录行给出"含可执行脚本"警示(UX 增强 #2)。
 *  商店详情与本地详情共用,只依赖两者都有的三个字段。 */
function FileTree({
  detail,
}: {
  detail: Pick<SkillDetail, "dirSlug" | "files" | "hasScripts">;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-border">
      <div className="flex items-center gap-2 bg-surface-2 px-3 py-1.5 text-[12.5px] font-[550]">
        <Icon icon={Folder} />
        <span className="font-mono text-[12px]">{detail.dirSlug}/</span>
        {detail.hasScripts && (
          <span className="inline-flex items-center gap-1 rounded-[4px] bg-[rgba(200,150,20,.12)] px-[7px] py-px text-[11px] font-medium text-[#9a6a00] dark:text-[#d9a94a]">
            <Icon icon={TriangleAlert} size={11} />
            {t("skill.hasScripts")}
          </span>
        )}
      </div>
      {detail.files.map((file) => (
        <div
          key={file.path}
          className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[12.5px]"
        >
          <Icon icon={SCRIPT_EXT.test(file.path) ? FileCode : FileText} />
          <span className="truncate font-mono text-[12px]">{file.path}</span>
          <span className="ml-auto shrink-0 text-[11px] text-text-3">
            {formatBytes(file.size)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染正文时去掉 frontmatter。
 *
 * 缓存里存的是 SKILL.md 全文(详情要能离线打开),而 frontmatter 是给机器看的元数据,
 * 直接渲染会在正文顶部露出一段 `name:`/`description:`。
 */
/** 贡献者展示文案:3 人以内全列,超出列前 3 并缀「等 N 人」(N = 总人数)。
 *  元信息区是一行窄栏,十几个名字全列会把整行挤崩——截断是版式约束,不是隐藏信息,
 *  完整名单在技能库页面上本来就查得到。 */
export function contributorsText(names: string[]): string {
  const MAX_SHOWN = 3;
  if (names.length <= MAX_SHOWN) return names.join(t("punct.listSeparator"));
  return t("detail.metaContributorsMore", {
    names: names.slice(0, MAX_SHOWN).join(t("punct.listSeparator")),
    count: names.length,
  });
}

export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
