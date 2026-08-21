import { WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ChangelogCard } from "@/components/ChangelogCard";
import { Icon } from "@/components/Icon";
import { PlazaCard } from "@/components/PlazaCard";
import { SkillCard } from "@/components/SkillCard";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { relativeTimeFromIso, relativeTimeFromUnix } from "@/lib/format";
import { PLAZA_REGISTRY_ID, type PlazaSkillCard } from "@/lib/ipc";
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

/**
 * 商店页。**外壳只负责在内容之上摆升级后的更新日志卡片**,页面本身的逻辑
 * 一行没动——`StoreBody` 里有好几处早退分支(广场搜索态、加载中、出错),
 * 把卡片逐个塞进每条分支既啰嗦又必然漏掉一条,包一层是唯一不重复的写法。
 */
export function StorePage() {
  return (
    <>
      <ChangelogCard />
      <StoreBody />
    </>
  );
}

function StoreBody() {
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
 * 技能广场的搜索结果区(M9 任务 5)。四档:还没搜过("全网热门"排行榜,见
 * {@link PlazaLeaderboard},M10 任务 4)/ 搜索失败 / 空结果 / 结果网格。
 * 搜索框在 Toolbar 里(复用现有 SearchBox,IME 处理不重写),这里只管结果展示。
 *
 * 🔴 判据是 **`submittedQuery`(已提交的查询词)而不是 `query`(输入框里的文本)**
 * (M10 追加,搜索改成显式触发之后):按输入框判的话,用户刚敲下第一个字、还没点
 * 搜索,热门榜就整片消失换成"没有匹配"——什么都没发生却像是坏了。
 * `submittedQuery` 已经是 trim 后的值(见 store),这里不再重复 trim。
 *
 * 加载态分两档:**首次搜索**(手上还没有结果)给一句加载提示;**已有结果时再搜**
 * 保持旧结果可见、不闪空(与上面浏览态刷新的既有做法一致),转圈由顶栏那个**既有的
 * 刷新按钮**承担(不为加载指示新造控件)——整片闪白是最差的做法。
 */
function PlazaResults() {
  const submittedQuery = usePlaza((s) => s.submittedQuery);
  const results = usePlaza((s) => s.results);
  const status = usePlaza((s) => s.status);
  const openDetail = usePlaza((s) => s.openDetail);

  if (submittedQuery === "") {
    // 还没搜过不是一片空白:打开就有"全网热门"排行榜(用户明确要求"适配公司
    // 技能库的展示风格");提交一次搜索就切到下面的搜索结果分支,排行榜整个
    // 不渲染——两者互斥,不会同屏叠加。
    return <PlazaLeaderboard />;
  }
  if (status === "error") {
    return <p className="py-6 text-[12.5px] text-text-3">{t("plaza.searchFailed")}</p>;
  }
  if (status === "loading" && results.length === 0) {
    // 搜索用自己的文案:这一档读的不是"技能列表"(那是浏览态的措辞)。
    return <p className="py-6 text-[12.5px] text-text-3">{t("plaza.searching")}</p>;
  }
  if (results.length === 0) {
    return (
      <p className="py-6 text-[12.5px] text-text-3">
        {t("store.emptySearch", { query: submittedQuery })}
      </p>
    );
  }

  return <PlazaCardGrid cards={results} onOpen={openDetail} className="mt-2.5" />;
}

/** 每批渲染的卡片数。24 ≈ 一屏,沿用热门榜旧的"一屏够看"实测值。 */
const PLAZA_PAGE_SIZE = 24;

/**
 * 广场卡片网格,搜索结果区与排行榜(M10 任务 4)共用——两处除了外层间距
 * (排行榜网格上面还有一行"全网热门"标题,搜索结果区没有)之外逐行相同,
 * 之前各写一份是本项目已经因 DRY 问题返工过三次的那类重复,这里收成一处。
 *
 * **滚到底自动加载更多**(2026-08-19,对齐 skills.sh 官网观感)也落在这里,同样
 * 是为了搜索与热门两边行为自动一致——不在 `PlazaResults`/`PlazaLeaderboard` 里
 * 各写一份。要点:
 * - **零新请求**:数据本来就整批在手里(热门榜上游首页一次给 600 条;搜索上游
 *   没有分页、`offset` 实测无效,只能一次要 `PLAZA_SEARCH_LIMIT` 条)。这里做的
 *   纯粹是"先渲染前 N 张卡片",滚到底再切下一批;
 * - 🔴 **`cards` 一变就必须回到第一批**:换搜索词、清空搜索框切回热门,都得从头
 *   开始。不重置的话用户搜个新词,看到的是上一次滚到的那个条数;
 * - **全部渲染完之后哨兵整个不摆**,也不显示"没有更多了"之类的噪音(UI 规范:
 *   信息密度对齐 Demo,不加装饰性文案)。切换是瞬时的(数据在内存里),
 *   也就没有"加载中"可言。
 */
function PlazaCardGrid({
  cards,
  onOpen,
  className,
}: {
  cards: PlazaSkillCard[];
  onOpen: (ownerRepo: string, name: string, slug: string) => void;
  className?: string;
}) {
  const [visibleCount, setVisibleCount] = useState(PLAZA_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // 换了一批卡片就回到第一批(见上面的 🔴)。
  useEffect(() => {
    setVisibleCount(PLAZA_PAGE_SIZE);
  }, [cards]);

  const hasMore = visibleCount < cards.length;

  useEffect(() => {
    if (!hasMore) return;
    if (typeof IntersectionObserver === "undefined") {
      // 老 webview 没有 IntersectionObserver:一次全渲染。列表长一点无所谓,
      // 把剩下的条目永久藏起来才是死路——界面上没有"加载更多"按钮可点。
      setVisibleCount(cards.length);
      return;
    }
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // 必须查 isIntersecting:真实 IntersectionObserver 在 observe() 那一刻就会
        // 用**当前**状态回调一次,哨兵还在首屏之下时那一次是 false。不查的话
        // 一挂载就会白白多渲染一批(而 jsdom 里的替身不会自己触发,这种偏差
        // 恰恰是本地测试看不见、只有真机才暴露的那一类)。
        if (!entries.some((e) => e.isIntersecting)) return;
        setVisibleCount((count) => Math.min(count + PLAZA_PAGE_SIZE, cards.length));
      },
      // 提前一屏开始加载,滚到底时下一批已经在了,不给用户看见空白
      { rootMargin: "400px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // 依赖里带 visibleCount 是有意的:每加载一批就重建观察者,重新 observe 会用
    // 当前状态立刻回调一次——哨兵若仍在视口内(比如窗口很高、一批填不满),
    // 就继续加载下一批直到填满,不会卡在第二批上。
  }, [hasMore, cards.length, visibleCount]);

  return (
    <>
      <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(288px,1fr))] gap-2.5", className)}>
        {cards.slice(0, visibleCount).map((card) => (
          <PlazaCard
            key={card.ownerRepo + "/" + card.slug}
            card={card}
            onOpen={() => onOpen(card.ownerRepo, card.name, card.slug)}
          />
        ))}
      </div>
      {/* 哨兵放在网格**外面**:放进去会占掉一个网格单元,在卡片之间留一个空位 */}
      {hasMore && (
        <div ref={sentinelRef} data-testid="plaza-scroll-sentinel" aria-hidden className="h-px" />
      )}
    </>
  );
}

/**
 * 广场空态的"全网热门"排行榜(M10 任务 4):skills.sh 首页的热门排行,与公司技能库
 * 同款卡片网格展示(用户明确诉求"适配公司技能库的展示风格")。
 *
 * **解析失败一律降级为空列表,这里退回原来的"输入关键词搜索"提示**
 * ——`plazaLeaderboard()` 本身不会抛错(见 core `plaza::fetch_leaderboard` 文档),
 * 空数组是"上游改版/网络不通/真的没数据"三种情况共同的表现,界面上不去猜是哪一种,
 * 统一退回同一句提示(DoD 明确要求:测试钉住这条退回路径)。
 */
function PlazaLeaderboard() {
  const leaderboard = usePlaza((s) => s.leaderboard);
  const leaderboardStatus = usePlaza((s) => s.leaderboardStatus);
  const loadLeaderboard = usePlaza((s) => s.loadLeaderboard);
  const openDetail = usePlaza((s) => s.openDetail);

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  if (leaderboardStatus === "loading" && leaderboard.length === 0) {
    return <p className="py-6 text-[12.5px] text-text-3">{t("store.loading")}</p>;
  }
  if (leaderboard.length === 0) {
    return <p className="py-6 text-[12.5px] text-text-3">{t("plaza.emptyQuery")}</p>;
  }

  return (
    <>
      <div className="mt-2.5 mb-2.5 flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-text-2">{t("plaza.trendingLabel")}</span>
        <span className="text-[11.5px] text-text-3">{t("plaza.emptyQuery")}</span>
      </div>
      <PlazaCardGrid cards={leaderboard} onOpen={openDetail} />
    </>
  );
}
