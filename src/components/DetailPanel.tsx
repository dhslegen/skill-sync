import { FileCode, FileText, Folder, FolderOpen, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { InstallPanel } from "@/components/InstallPanel";
import { Markdown } from "@/components/Markdown";
import { SkillIcon } from "@/components/SkillIcon";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes, relativeTimeFromIso, shortSha } from "@/lib/format";
import type { LocalSkillDetail, SkillDetail } from "@/lib/ipc";
import { useLocalDetail } from "@/store/local-detail";
import { useStoreIndex } from "@/store/store-index";

/** 详情是右侧滑出面板,不整页跳转(UI 规范 §5:借 Raycast 的"详情不跳页")。
 *  两个数据源共用同一个壳:商店详情(远端缓存)与本地详情(我的技能/分享页,直接读盘)。 */
export function DetailPanel() {
  const { detailSlug, detail, detailError, closeDetail, index } = useStoreIndex();
  const local = useLocalDetail();
  const localOpen = local.target !== null;
  const open = detailSlug !== null || localOpen;
  const close = localOpen ? local.close : closeDetail;
  const title = localOpen ? local.detail?.name : detail?.name;
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

function PanelBody({ detail, repo }: { detail: SkillDetail; repo: string }) {
  const closeDetail = useStoreIndex((s) => s.closeDetail);
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

        <div className="mt-3.5 flex gap-4 border-y border-border py-2.5">
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

      <InstallPanel dirSlug={detail.dirSlug} />
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
export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
