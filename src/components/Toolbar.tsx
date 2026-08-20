import { Moon, RefreshCw, Sun } from "lucide-react";

import { Icon } from "@/components/Icon";
import { SearchBox } from "@/components/SearchBox";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { PLAZA_REGISTRY_ID } from "@/lib/ipc";
import {
  ACCENT_LABEL_KEY,
  ACCENT_SWATCH,
  resolveTheme,
  useAppearance,
  type Accent,
} from "@/store/appearance";
import { usePlaza } from "@/store/plaza";
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
  const { query, setQuery, load, status, activeRegistry, activeRepo } = useStoreIndex();
  const { mode, prefersDark, accent, setAccent, toggleTheme } = useAppearance();
  const dark = resolveTheme(mode, prefersDark) === "dark";

  // 技能广场的"搜索态"(registryId=plaza, repo=null):同一个搜索框(现有组件,
  // IME 处理不重写)改喂广场的查询状态,而不是再摆一个第二实例
  // ——`SearchBox` 的 id/data-testid 是写死的单例,重复挂载会撞。
  // 差别在触发方式:广场要发跨外网请求,所以只在这一档传 `onSubmit`(回车);
  // 公司技能库那一档是本地过滤,输入即搜照旧。
  // ⚠️ **不摆「搜索」按钮**(2026-08-19 用户看过真机后拍板撤掉):Demo 里没有这个
  //   控件,多摆一个就与整体割裂(UI 规范:信息密度对齐 Demo,不加装饰性控件)。
  //   回车是唯一的新增触发口;"再搜一次"用下面那个既有的刷新按钮,
  //   搜索中的转圈也挂在它身上——不为加载指示新造控件。
  const isPlazaSearch = activeRegistry === PLAZA_REGISTRY_ID && activeRepo === null;
  const plazaQuery = usePlaza((s) => s.query);
  const setPlazaQuery = usePlaza((s) => s.setQuery);
  const submitPlazaSearch = usePlaza((s) => s.submitSearch);
  const plazaStatus = usePlaza((s) => s.status);

  return (
    <div
      data-tauri-drag-region
      className="flex h-11 flex-none items-center gap-2.5 pl-5 pr-4"
    >
      <h1 className="mr-1 text-[13.5px] font-semibold tracking-[-0.01em]">{t(TITLES[page])}</h1>

      {page === "store" && (
        <SearchBox
          value={isPlazaSearch ? plazaQuery : query}
          onChange={isPlazaSearch ? setPlazaQuery : setQuery}
          onSubmit={isPlazaSearch ? (value) => submitPlazaSearch(value) : undefined}
          kbdHint="⌘K"
        />
      )}

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
        // 广场搜索态没有"索引"可刷新(它是搜索态,不是浏览态):按当前查询词
        // 重新提交一次搜索,与回车走同一个入口。
        // ⚠️ 这里以前写的是 `setPlazaQuery(plazaQuery)`,靠"输入即触发"顺带发请求;
        // 改成显式触发之后那句话会**静默失效**(设了个同值的 query,什么都不发生)。
        onClick={() => (isPlazaSearch ? submitPlazaSearch() : load(true))}
        icon={RefreshCw}
        spinning={isPlazaSearch ? plazaStatus === "loading" : status === "loading"}
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
