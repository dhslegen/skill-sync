// 技能广场(skills.sh 发现层,M9)的前端状态:搜索 + 详情。
//
// 设计文档 §2.1/§2.2 的两条前端约束都落在这里:
// - 搜索去空白后不足 2 字符不发请求(上游 400 的边界),防抖 250ms 合并连续键入;
// - 详情是"详情面板不联网"承诺的唯一破例,范围钉死在广场——core 侧已把这条边界
//   写进 `core/plaza.rs` 模块头,这里只是消费它,不重复越界。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  isAppError,
  plazaDetail,
  plazaLeaderboard,
  plazaSearch,
  type AppError,
  type PlazaSkillCard,
  type SkillDetail,
} from "@/lib/ipc";

type Status = "idle" | "loading" | "ready" | "error";

/** 上游 400 的边界:去空白后不足这个字符数就不发请求。 */
const MIN_QUERY_CHARS = 2;
/** 防抖窗口,对齐上游 CLI(`npx skills find`)交互手感的既有约定。 */
const SEARCH_DEBOUNCE_MS = 250;

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

interface PlazaState {
  query: string;
  results: PlazaSkillCard[];
  status: Status;
  error: AppError | null;
  /** 输入即触发(内部防抖 + 边界判定),调用方不用自己管定时器。 */
  setQuery: (query: string) => void;

  // ---- 首页热门排行榜(M10 任务 4:广场空态打开就有内容) ----
  leaderboard: PlazaSkillCard[];
  leaderboardStatus: Status;
  /** 幂等触发:已经在读或已经读到过就不重复发 IPC——core 侧自己也有一份不失效的
   *  进程内缓存(见 `commands::plaza_leaderboard_cache`),这里只是省一次往返,
   *  不是正确性所必需。空结果(降级态)算"读到过"但**不算成功**,组件据此展示
   *  回退提示,而不是无限期停在 loading。 */
  loadLeaderboard: () => Promise<void>;

  // ---- 详情(点开一条搜索结果时现拉该仓全部技能) ----
  /** 当前打开的仓;null = 详情面板关闭。 */
  detailOwnerRepo: string | null;
  /** 点击时那条搜索结果的 frontmatter 名字,用于在多技能仓里定位;
   *  skills.sh 页面 slug,给"在浏览器查看"拼 URL。 */
  detailWantedName: string | null;
  detailSlug: string | null;
  detailSkills: SkillDetail[] | null;
  detailStatus: Status;
  detailError: AppError | null;
  /** 定位不到点击的那个技能时(该仓多技能且名字对不上),用户从列表里另选一个。 */
  selectedDirSlug: string | null;

  openDetail: (ownerRepo: string, name: string, slug: string) => Promise<void>;
  retryDetail: () => Promise<void>;
  closeDetail: () => void;
  selectDetailSkill: (dirSlug: string) => void;
}

export const usePlaza = create<PlazaState>((set, get) => {
  // 防抖定时器与请求序号是这个 store 实例私有的实现细节,不进 state——
  // 它们不该触发订阅者重渲染,也没有界面需要读它们。
  let debounceHandle: ReturnType<typeof setTimeout> | undefined;
  let searchSeq = 0;

  async function runSearch(query: string) {
    const seq = (searchSeq += 1);
    set({ status: "loading", error: null });
    try {
      const results = await plazaSearch(query);
      // 连续输入时,先发的慢请求可能后回来:只有"我还是最新这一次"才准写结果
      if (seq === searchSeq) set({ results, status: "ready" });
    } catch (raw) {
      if (seq === searchSeq) set({ error: toAppError(raw), status: "error", results: [] });
    }
  }

  return {
    query: "",
    results: [],
    status: "idle",
    error: null,

    setQuery: (query) => {
      set({ query });
      if (debounceHandle) clearTimeout(debounceHandle);
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY_CHARS) {
        // 不发请求直接回到空态。同时让在途的旧请求作废(bump 序号)——否则
        // "输两个字触发请求 → 又删成一个字" 时,那个仍在飞的响应落地后会用
        // `seq === searchSeq` 的旧判定通过检查,把已经清空的结果又救回来。
        searchSeq += 1;
        set({ results: [], status: "idle", error: null });
        return;
      }
      debounceHandle = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    },

    leaderboard: [],
    leaderboardStatus: "idle",

    loadLeaderboard: async () => {
      // 只挡"同一时刻已经在飞的重复请求"(比如 React 严格模式的双调用),
      // 不挡"上一次已经读完"——是否需要真的再发一次网络请求这件事交给 core 侧
      // 自己的进程内缓存去判断(见 `commands::plaza_leaderboard_cache`:非空结果
      // 不失效地缓存、空结果不缓存以便下次重试)。组件每次挂载都会调这个方法
      // (切出搜索结果又切回空态就是一次新挂载),这样设计后每次挂载至少能有一次
      // 机会把"上次恰好网络抖动"的空态翻回有数据,不会在一次失败后就困死一整个会话。
      if (get().leaderboardStatus === "loading") return;
      set({ leaderboardStatus: "loading" });
      try {
        // `?? []`:纯防御性写法,给测试里裸 `vi.fn()`(解析成 `undefined`)与任何
        // IPC 边界异常兜底,真实运行时 core 侧恒返回数组,这里不该也不会取到默认值。
        const leaderboard = (await plazaLeaderboard()) ?? [];
        set({ leaderboard, leaderboardStatus: "ready" });
      } catch (raw) {
        // core 侧已经把网络/解析失败都降级成空数组(见 plazaLeaderboard 文档),
        // 这条分支理论上不会命中——留着只是给 IPC 通道本身的极端故障(比如根本
        // 不在 Tauri 里跑)兜底,同样落到"ready + 空列表",让界面统一走
        // "leaderboard 为空 → 退回原空态提示"这一条路径,不新造一种展示。
        void raw;
        set({ leaderboard: [], leaderboardStatus: "ready" });
      }
    },

    detailOwnerRepo: null,
    detailWantedName: null,
    detailSlug: null,
    detailSkills: null,
    detailStatus: "idle",
    detailError: null,
    selectedDirSlug: null,

    openDetail: async (ownerRepo, name, slug) => {
      set({
        detailOwnerRepo: ownerRepo,
        detailWantedName: name,
        detailSlug: slug,
        detailSkills: null,
        detailStatus: "loading",
        detailError: null,
        selectedDirSlug: null,
      });
      try {
        // slug/name 就是这条搜索结果自带的 skills.sh id 与 frontmatter 名字——
        // 原样带给 core 侧,给了就优先走 blob 快路径(M10 任务 2)。
        const skills = await plazaDetail(ownerRepo, slug, name);
        // 面板可能在等待期间被关掉或换了别的仓,回来的结果就不该再写进去
        if (get().detailOwnerRepo === ownerRepo) {
          set({ detailSkills: skills, detailStatus: "ready" });
        }
      } catch (raw) {
        if (get().detailOwnerRepo === ownerRepo) {
          set({ detailError: toAppError(raw), detailStatus: "error" });
        }
      }
    },

    retryDetail: async () => {
      const { detailOwnerRepo, detailWantedName, detailSlug } = get();
      if (!detailOwnerRepo) return;
      await get().openDetail(detailOwnerRepo, detailWantedName ?? "", detailSlug ?? "");
    },

    closeDetail: () =>
      set({
        detailOwnerRepo: null,
        detailWantedName: null,
        detailSlug: null,
        detailSkills: null,
        detailStatus: "idle",
        detailError: null,
        selectedDirSlug: null,
      }),

    selectDetailSkill: (dirSlug) => set({ selectedDirSlug: dirSlug }),
  };
});

/**
 * 从该仓的技能列表里定位"用户点击的那一个"(设计文档 §2.2):
 * 用户先选过(`selectedDirSlug`)就认它;否则按搜索结果的 name 对 frontmatter name;
 * 都对不上返回 null,调用方据此落到"该仓技能列表"那一档。
 */
export function locatePlazaSkill(
  skills: SkillDetail[],
  wantedName: string | null,
  selectedDirSlug: string | null,
): SkillDetail | null {
  if (selectedDirSlug) {
    const picked = skills.find((s) => s.dirSlug === selectedDirSlug);
    if (picked) return picked;
  }
  if (!wantedName) return null;
  return skills.find((s) => s.name === wantedName) ?? null;
}
