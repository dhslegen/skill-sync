import { WifiOff } from "lucide-react";
import { useMemo } from "react";

import { Icon } from "@/components/Icon";
import { SkillCard } from "@/components/SkillCard";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { relativeTimeFromIso, relativeTimeFromUnix } from "@/lib/format";
import { filterSkills, type StoreFilter } from "@/lib/search";
import { useStoreIndex } from "@/store/store-index";

const FILTERS: { id: StoreFilter; label: MessageKey }[] = [
  { id: "all", label: "store.filterAll" },
  { id: "available", label: "store.filterAvailable" },
  { id: "installed", label: "store.filterInstalled" },
];

export function StorePage() {
  const { index, status, error, query, filter, installed, setFilter, openDetail, load } =
    useStoreIndex();

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
          {query.trim() ? t("store.emptySearch", { query }) : t("store.empty")}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(288px,1fr))] gap-2.5">
          {visible.map((skill) => (
            <SkillCard
              key={skill.dirSlug}
              skill={skill}
              repo={index.repo}
              updatedAt={updatedAt}
              state={installed.has(skill.dirSlug) ? "installed" : "install"}
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
