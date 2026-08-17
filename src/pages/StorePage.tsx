import { WifiOff } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Icon } from "@/components/Icon";
import { PlazaCard } from "@/components/PlazaCard";
import { SkillCard } from "@/components/SkillCard";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { relativeTimeFromIso, relativeTimeFromUnix } from "@/lib/format";
import { PLAZA_REGISTRY_ID } from "@/lib/ipc";
import { filterSkills, type StoreFilter } from "@/lib/search";
import { cardState } from "@/lib/update";
import { useInstall } from "@/store/install";
import { usePlaza } from "@/store/plaza";
import { useRegistries } from "@/store/registries";
import { useStoreIndex } from "@/store/store-index";

const FILTERS: { id: StoreFilter; label: MessageKey }[] = [
  { id: "all", label: "store.filterAll" },
  { id: "available", label: "store.filterAvailable" },
  { id: "installed", label: "store.filterInstalled" },
];

export function StorePage() {
  const {
    index,
    status,
    error,
    query,
    filter,
    setFilter,
    tagFilter,
    toggleTag,
    openDetail,
    load,
    activeRegistry,
    activeRepo,
  } = useStoreIndex();
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
    () => (index ? filterSkills(index.skills, query, filter, installed, tagFilter) : []),
    [index, query, filter, installed, tagFilter],
  );

  // 库里全部标签,去重保序(tags.json 由管理员维护,顺序即他排的顺序)。
  // 一个标签都没有时整行不渲染——摆一排永远点不出结果的 chip 就是撒谎。
  const allTags = useMemo(() => {
    const seen: string[] = [];
    for (const s of index?.skills ?? []) {
      for (const tag of s.tags) if (!seen.includes(tag)) seen.push(tag);
    }
    return seen;
  }, [index]);

  // 技能广场的"搜索态"哨兵(registryId=plaza, repo=null,见 store-index.ts 的注释):
  // 广场没有索引可拉,这条分支必须排在下面几个早退之前——否则 `!index` 会一路
  // 落进"首屏骨架"或"读取失败"那两档,把搜索页整个盖住(库切换器的既有教训同款)。
  if (activeRegistry === PLAZA_REGISTRY_ID && activeRepo === null) {
    return (
      <>
        <SourcePicker />
        <PlazaResults />
      </>
    );
  }

  // 加载中与出错这两档也要留着库切换器(2026-08-04 视觉自查抓到):
  // 早退分支把它一起挡掉后,用户切到一个连不上的技能库就**再也点不回来**
  // ——只剩一个「重试」按钮,而重试的还是那个连不上的库,界面成了死路。
  // 首屏骨架只在还没有任何内容时显示;刷新时保持旧列表可见,不闪空。
  if (!index && status === "loading") {
    return (
      <>
        <SourcePicker />
        <p className="py-6 text-[12.5px] text-text-3">{t("store.loading")}</p>
      </>
    );
  }

  if (!index && status === "error" && error) {
    return (
      <>
        <SourcePicker />
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
      </>
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

      {allTags.length > 0 && (
        <div className="-mt-2 mb-4 flex flex-wrap items-center gap-1.5">
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={tagFilter === tag}
              onClick={() => toggleTag(tag)}
              className={cn(
                "rounded-full border px-2.5 py-[3px] text-[12px]",
                tagFilter === tag
                  ? "border-accent bg-accent-soft font-medium text-accent"
                  : "border-border bg-surface-1 text-text-2 hover:border-border-strong hover:text-text",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

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
              state={cardState(records.get(skill.dirSlug), skill.contentHash, {
                registryId: index.registryId,
                owner: index.owner,
                repo: index.repo,
              })}
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

/**
 * 库切换器(M3 多源 + M4 一源多仓 + M9 技能广场):源 × 仓拍平成一排。
 *
 * 广场(§2.5)是**固定档**,不是"选出来"的:即便它还没挂过任何仓也要出现在这一排,
 * 排在自定义源之后——用户要能随时点进去搜索。它自己不是一个"仓",点开它是切进
 * "搜索态"(registryId=plaza, repo=null);已挂过的仓则各自作为普通子条目出现,
 * 点开按普通库浏览(§2.4 更新徽标口径落地正靠这条:那条路走 store_index,天然有
 * 指纹可比)。因为广场恒定贡献至少一枚固定入口,这排切换器现在也就恒定可见了
 * ——不再是"只有一个库时不渲染"的旧语义(旧语义仍适用于"只算真实技能库"的场景)。
 */
function SourcePicker() {
  const registries = useRegistries((s) => s.list);
  const activeRegistry = useStoreIndex((s) => s.activeRegistry);
  const activeRepo = useStoreIndex((s) => s.activeRepo);
  const setRegistry = useStoreIndex((s) => s.setRegistry);
  const closePlazaDetail = usePlaza((s) => s.closeDetail);

  const entries = useMemo(() => {
    if (!registries) return [];
    return registries.flatMap((r) => {
      if (r.id === PLAZA_REGISTRY_ID) {
        return [
          // 固定入口本身:点开进搜索态,不是浏览任何一个仓
          { registryId: r.id, repoKey: null, label: r.name, title: r.name, mono: false },
          ...r.repos.map((repo) => ({
            registryId: r.id,
            repoKey: repo.key,
            // 广场的仓没有源起的展示名可回退(name 恒为 null,§2.3):退到 repo.repo
            // 会让两个不同 owner 的同名仓(如 a/skills 与 b/skills)在这排切换器上
            // 完全同形,只有 title 悬浮才分得出来(M9 终审修复)。退到 key(owner/repo)
            // 才是能区分的形式;真起了展示名(未来若开放)则优先用它,此时不必等宽。
            label: repo.name ?? repo.key,
            title: `${r.name} · ${repo.key}`,
            mono: !repo.name,
          })),
        ];
      }
      const sourceName = r.builtin ? t("registries.builtinName") : r.name;
      return r.repos.map((repo) => ({
        registryId: r.id,
        // 主仓走缺省档:与既有"只带 registryId"的调用语义一致
        repoKey: repo.primary ? null : repo.key,
        // 展示名优先用户起的名;主仓回退源名;追加仓回退 repo slug
        label: repo.name ?? (repo.primary ? sourceName : repo.repo),
        title: `${sourceName} · ${repo.key}`,
        mono: false,
      }));
    });
  }, [registries]);

  // 只有一个可选项时切换器是噪音——但**广场固定入口不算"一个技能库"**:
  // 它是进搜索态的功能入口,哪怕它是唯一条目也必须点得到。
  // 反例(2026-08-17 真机验收撞到):内建源没注入编译期配置时 `registry::list`
  // 给的 `repos` 是空数组,非广场分支一个条目都不产出,广场入口成了唯一条目,
  // 早退一命中就**整个切换器消失、广场彻底不可达**。
  const libraryCount = entries.filter((e) => !(e.registryId === PLAZA_REGISTRY_ID && e.repoKey === null)).length;
  const hasPlazaEntry = entries.length > libraryCount;
  if (!hasPlazaEntry && libraryCount <= 1) return null;

  return (
    <div
      className="mt-2.5 flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={t("store.sourcePicker")}
    >
      <span className="text-[11.5px] text-text-3">{t("store.sourcePicker")}</span>
      {entries.map((e) => {
        const active = activeRegistry === e.registryId && activeRepo === e.repoKey;
        return (
          <button
            key={`${e.registryId}:${e.repoKey ?? ""}`}
            type="button"
            title={e.title}
            aria-pressed={active}
            onClick={() => {
              // 离开/进入哪个库都先清掉广场详情:换库之后那个面板挂着的内容
              // 已经与当前页面无关,留着就是一个能被 Esc/关闭键之外的方式点开的死面板。
              closePlazaDetail();
              void setRegistry(e.registryId, e.repoKey);
            }}
            className={cn(
              "rounded-full border px-2.5 py-[3px] text-[12px]",
              e.mono && "font-mono",
              active
                ? "border-border-strong bg-surface-3 font-medium text-text"
                : "border-border bg-surface-1 text-text-2 hover:border-border-strong hover:text-text",
            )}
          >
            {e.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 技能广场的搜索结果区(M9 任务 5)。四档:空查询提示 / 搜索失败 / 空结果 / 结果网格。
 * 搜索框在 Toolbar 里(复用现有 SearchBox,IME/防抖行为不重写),这里只管结果展示。
 */
function PlazaResults() {
  const query = usePlaza((s) => s.query);
  const results = usePlaza((s) => s.results);
  const status = usePlaza((s) => s.status);
  const openDetail = usePlaza((s) => s.openDetail);

  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return <p className="py-6 text-[12.5px] text-text-3">{t("plaza.emptyQuery")}</p>;
  }
  if (status === "error") {
    return <p className="py-6 text-[12.5px] text-text-3">{t("plaza.searchFailed")}</p>;
  }
  if (status === "loading" && results.length === 0) {
    return <p className="py-6 text-[12.5px] text-text-3">{t("store.loading")}</p>;
  }
  if (results.length === 0) {
    return <p className="py-6 text-[12.5px] text-text-3">{t("store.emptySearch", { query: trimmed })}</p>;
  }

  return (
    <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(288px,1fr))] gap-2.5">
      {results.map((card) => (
        <PlazaCard
          key={card.ownerRepo + "/" + card.slug}
          card={card}
          onOpen={() => void openDetail(card.ownerRepo, card.name, card.slug)}
        />
      ))}
    </div>
  );
}
