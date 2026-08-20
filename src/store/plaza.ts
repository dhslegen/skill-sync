// 技能广场(skills.sh 发现层,M9)的前端状态:搜索 + 详情。
//
// 设计文档 §2.1/§2.2 的两条前端约束都落在这里:
// - 搜索去空白后不足 2 字符不发请求(上游 400 的边界);
// - 详情是"详情面板不联网"承诺的唯一破例,范围钉死在广场——core 侧已把这条边界
//   写进 `core/plaza.rs` 模块头,这里只是消费它,不重复越界。
//
// **搜索是显式触发的**(M10 追加,推翻 M9 的"输入即搜 + 250ms 防抖"):真机验收时
// 用户反馈"按输入不跟手、有延迟"——根因是每敲一个字都在发一次跨外网请求,而
// skills.sh 在公司网络下很慢,界面一路抖动。现在拆成两个字段:
// - `query` = 输入框里的文本,**改它一个请求都不发**,输入完全跟手;
// - `submittedQuery` = 已提交的查询词(**存 trim 后的值**),决定界面展示什么。
// 触发口只有 `submitSearch`(回车 / 顶栏刷新按钮共用;**不摆搜索按钮**,
// 2026-08-19 用户看过真机后拍板撤掉,理由见 `Toolbar.tsx` 的注释)。
// 唯一的例外是"清空输入框":它不需要任何网络请求,立即回到热门榜——显式搜索
// 是为了免掉无谓的请求,不是为了让用户多点一下。
// 假设:输入框非空但不足 2 字符(比如把 "react" 删成 "r")时**保留上一次的结果**
// 不清空——那是用户在改写查询词的中间态,把结果闪掉再闪回来比留着更糟;
// 与 M9 "输入即搜"时代的行为不同,那时它必须清(因为结果与输入框是同一个真相)。
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

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

interface PlazaState {
  /** 输入框里的文本。改它**不发任何请求**。 */
  query: string;
  /** 已提交的查询词(trim 后)。空串 = 还没搜过,界面展示热门榜。 */
  submittedQuery: string;
  results: PlazaSkillCard[];
  status: Status;
  error: AppError | null;
  /** 只更新输入框的值;清空(trim 后为空)时顺带回到热门榜,见模块头。 */
  setQuery: (query: string) => void;
  /** 显式提交一次搜索(回车 / 顶栏刷新按钮)。不传参数就用当前 `query`。 */
  submitSearch: (query?: string) => void;

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
  // 请求序号是这个 store 实例私有的实现细节,不进 state——它不该触发订阅者
  // 重渲染,也没有界面需要读它。
  let searchSeq = 0;

  /** 回到"还没搜过"的状态,并让在途的旧请求作废。 */
  function resetSearch() {
    // bump 序号是关键:否则仍在飞的那次响应落地时,`seq === searchSeq` 的判定
    // 仍然成立,会把已经清空的结果又救回来(热门榜瞬间被旧搜索结果盖掉)。
    searchSeq += 1;
    set({ submittedQuery: "", results: [], status: "idle", error: null });
  }

  async function runSearch(query: string) {
    const seq = (searchSeq += 1);
    set({ submittedQuery: query, status: "loading", error: null });
    try {
      const results = await plazaSearch(query);
      // 短时间内连搜几次时,先发的慢请求可能后回来:只有"我还是最新这一次"
      // 才准写结果。⚠️ 这是**丢弃**不是**取消**:Tauri 的 `invoke` 没有 abort
      // 通道,旧请求仍会在 core 侧跑完(网络往返照发、core 的缓存照写),
      // 我们只是不采纳它的结果。别误以为再点一次搜索就把上一次掐断了。
      if (seq === searchSeq) set({ results, status: "ready" });
    } catch (raw) {
      if (seq === searchSeq) set({ error: toAppError(raw), status: "error", results: [] });
    }
  }

  return {
    query: "",
    submittedQuery: "",
    results: [],
    status: "idle",
    error: null,

    setQuery: (query) => {
      set({ query });
      // 清空输入框 = 立即回热门榜,不需要再点一次搜索(零网络请求,见模块头)。
      // 非空但不足 2 字符是改写查询词的中间态,保留上一次的结果不动。
      if (query.trim() === "") resetSearch();
    },

    submitSearch: (query) => {
      const trimmed = (query ?? get().query).trim();
      if (query !== undefined) set({ query });
      // 防连击:**同一个词、且正在搜它** → 忽略。连按五次回车搜同一个词,发五个
      // 一模一样的请求纯属浪费,网络慢时尤其明显。
      // 🔴 判据必须同时含"同一个词"这一半:退化成"搜索中一律忽略"就成了
      //    "等待上次响应",正是用户明确反对的那个行为——**换了词必须立即以新的
      //    为准**(交给下面的 runSearch + searchSeq,不等旧的回来)。
      //    `submittedQuery` 在 runSearch 一开始就写好了,status=loading 期间
      //    它就是"正在飞的那个词"。
      if (get().status === "loading" && trimmed === get().submittedQuery) return;
      if (trimmed.length < MIN_QUERY_CHARS) {
        // 搜不了的词(上游 400 的边界)当作"回到热门榜"处理,而不是按了回车
        // 毫无反应——空态那句提示本身就写着"至少 2 个字符"。
        resetSearch();
        return;
      }
      void runSearch(trimmed);
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
