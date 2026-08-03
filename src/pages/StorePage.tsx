import { WifiOff } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Icon } from "@/components/Icon";
import { SkillCard } from "@/components/SkillCard";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { relativeTimeFromIso, relativeTimeFromUnix } from "@/lib/format";
import { filterSkills, type StoreFilter } from "@/lib/search";
import { cardState } from "@/lib/update";
import { useInstall } from "@/store/install";
import { useRegistries } from "@/store/registries";
import { useStoreIndex } from "@/store/store-index";

const FILTERS: { id: StoreFilter; label: MessageKey }[] = [
  { id: "all", label: "store.filterAll" },
  { id: "available", label: "store.filterAvailable" },
  { id: "installed", label: "store.filterInstalled" },
];

export function StorePage() {
  const { index, status, error, query, filter, setFilter, openDetail, load } = useStoreIndex();
  const records = useInstall((s) => s.installed);
  // 已安装集合来自 installed_list(core 的 state.json),不再是恒空的占位
  const installed = useMemo(() => new Set(records.keys()), [records]);
  const registries = useRegistries((s) => s.list);
  const loadRegistries = useRegistries((s) => s.load);

  // 源列表懒加载一次:只有一个源时切换器不渲染,商店与 M1 一模一样
  useEffect(() => {
    if (!registries) void loadRegistries();
  }, [registries, loadRegistries]);

  const visible = useMemo(
    () => (index ? filterSkills(index.skills, query, filter, installed) : []),
    [index, query, filter, installed],
  );

  // 首屏骨架只在还没有任何内容时显示;刷新时保持旧列表可见,不闪空
  if (!index && status === "loading") {
    return <p className="py-6 text-[12.5px] text-text-3">{t("store.loading")}</p>;
  }

  if (!index && status === "error" && error) {
    return (
      <div className="py-6">
        <p className="text-[12.5px] text-text-2">{error.message}</p>
        <button
          type="button"
          onClick={() => load(true)}
          className="mt-2.5 h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("store.retry")}
        </button>
      </div>
    );
  }

  if (!index) return null;
  const updatedAt = relativeTimeFromIso(index.committedAt);

  return (
    <>
      {index.offline && (
        <div className="mt-2.5 flex items-start gap-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-[12px] text-text-2">
          <Icon icon={WifiOff} className="mt-[3px]" />
          <span>{t("store.offline")}</span>
          <button
            type="button"
            onClick={() => load(true)}
            className="ml-auto shrink-0 font-medium text-accent"
          >
            {t("store.retry")}
          </button>
        </div>
      )}

      <SourcePicker />

      <div className="my-2.5 mb-4 flex items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-2.5 py-[3px] text-[12px]",
              filter === f.id
                ? "border-text bg-text font-medium text-bg"
                : "border-border bg-surface-1 text-text-2 hover:border-border-strong hover:text-text",
            )}
          >
            {t(f.label)}
          </button>
        ))}
        <span className="ml-auto text-[12px] text-text-3">
          {index.offline
            ? t("store.summaryOffline", { count: index.skills.length, library: index.repo })
            : t("store.summary", {
                count: index.skills.length,
                library: index.repo,
                when: relativeTimeFromUnix(index.fetchedAt),
              })}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-[12.5px] text-text-3">
          {/*
            三种"没东西"要分清,否则会对用户撒谎:
            切到「已安装」而一个都没装时,说"这个技能库里还没有技能"是错的
            ——技能库里明明有 9 个。第三档专门给筛选用。
          */}
          {query.trim()
            ? t("store.emptySearch", { query })
            : filter !== "all"
              ? t("store.emptyFilter")
              : t("store.empty")}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(288px,1fr))] gap-2.5">
          {visible.map((skill) => (
            <SkillCard
              key={skill.dirSlug}
              skill={skill}
              repo={index.repo}
              updatedAt={updatedAt}
              state={cardState(records.get(skill.dirSlug), skill.contentHash)}
              onOpen={() => void openDetail(skill.dirSlug)}
            />
          ))}
        </div>
      )}

      {index.skipped.length > 0 && (
        <p className="mt-4 text-[11.5px] text-text-3">
          {t("store.skippedNotice", { count: index.skipped.length })}
        </p>
      )}
    </>
  );
}

/** 源切换器(M3 多源)。只有一个源时不渲染——摆一个没得选的选择器是噪音。 */
function SourcePicker() {
  const registries = useRegistries((s) => s.list);
  const activeRegistry = useStoreIndex((s) => s.activeRegistry);
  const setRegistry = useStoreIndex((s) => s.setRegistry);

  if (!registries || registries.length <= 1) return null;

  return (
    <div
      className="mt-2.5 flex items-center gap-1.5"
      role="group"
      aria-label={t("store.sourcePicker")}
    >
      <span className="text-[11.5px] text-text-3">{t("store.sourcePicker")}</span>
      {registries.map((r) => (
        <button
          key={r.id}
          type="button"
          aria-pressed={activeRegistry === r.id}
          onClick={() => void setRegistry(r.id)}
          className={cn(
            "rounded-full border px-2.5 py-[3px] text-[12px]",
            activeRegistry === r.id
              ? "border-border-strong bg-surface-3 font-medium text-text"
              : "border-border bg-surface-1 text-text-2 hover:border-border-strong hover:text-text",
          )}
        >
          {r.builtin ? t("registries.builtinName") : r.name}
        </button>
      ))}
    </div>
  );
}
