import { Moon, RefreshCw, Sun } from "lucide-react";

import { Icon } from "@/components/Icon";
import { SearchBox } from "@/components/SearchBox";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_LABEL_KEY,
  ACCENT_SWATCH,
  resolveTheme,
  useAppearance,
  type Accent,
} from "@/store/appearance";
import { useStoreIndex } from "@/store/store-index";
import { useUi, type PageId } from "@/store/ui";

const TITLES: Record<PageId, MessageKey> = {
  store: "nav.store",
  mine: "nav.mine",
  share: "nav.share",
  settings: "nav.settings",
};

/**
 * 44px 极薄顶栏,同时是窗口拖拽区。
 *
 * `data-tauri-drag-region` 只挂在容器上,内部每个可点控件都不在拖拽区内
 * ——否则按下按钮会被当成拖窗口,点击永远发不出去(UI 规范 §6.1 明确点出这个坑)。
 * 原生窗口控制(Windows 自绘、macOS 红绿灯垂直居中微调)属打包任务,这里只留出位置。
 */
export function Toolbar() {
  const page = useUi((s) => s.page);
  const { query, setQuery, load, status } = useStoreIndex();
  const { mode, prefersDark, accent, setAccent, toggleTheme } = useAppearance();
  const dark = resolveTheme(mode, prefersDark) === "dark";

  return (
    <div
      data-tauri-drag-region
      className="flex h-11 flex-none items-center gap-2.5 pl-5 pr-4"
    >
      <h1 className="mr-1 text-[13.5px] font-semibold tracking-[-0.01em]">{t(TITLES[page])}</h1>

      {page === "store" && <SearchBox value={query} onChange={setQuery} kbdHint="⌘K" />}

      <div className="flex-1" />

      <div className="flex items-center gap-1.5 px-1.5" role="group" aria-label={t("toolbar.accent")}>
        {(Object.keys(ACCENT_SWATCH) as Accent[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-label={t(ACCENT_LABEL_KEY[key])}
            aria-pressed={accent === key}
            onClick={() => setAccent(key)}
            style={{ background: ACCENT_SWATCH[key] }}
            className={cn(
              "size-[13px] rounded-full",
              accent === key && "shadow-[0_0_0_1.5px_var(--bg),0_0_0_3px_var(--text-3)]",
            )}
          />
        ))}
      </div>

      <IconButton label={t("toolbar.theme")} onClick={toggleTheme} icon={dark ? Moon : Sun} />
      <IconButton
        label={t("toolbar.refresh")}
        onClick={() => load(true)}
        icon={RefreshCw}
        spinning={status === "loading"}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  icon,
  spinning = false,
}: {
  label: string;
  onClick: () => void;
  icon: typeof Sun;
  spinning?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-ctl border border-transparent text-text-2 hover:bg-surface-3 hover:text-text"
    >
      <Icon icon={icon} className={spinning ? "animate-spin" : undefined} />
    </button>
  );
}
