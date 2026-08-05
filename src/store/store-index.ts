// 商店索引的前端状态。数据全部来自 core 的 store_index / store_skill_detail,
// 这里只做"取过来、记住、按搜索与筛选算出要显示哪些"。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  isAppError,
  storeIndex,
  storeSkillDetail,
  type AppError,
  type SkillDetail,
  type StoreIndexView,
} from "@/lib/ipc";
import type { StoreFilter } from "@/lib/search";

type Status = "idle" | "loading" | "ready" | "error";

interface StoreIndexState {
  status: Status;
  index: StoreIndexView | null;
  error: AppError | null;
  query: string;
  filter: StoreFilter;
  /** 标签单选(M5 任务 3):null = 不按标签过滤。 */
  tagFilter: string | null;
  /** 当前浏览的源(M3 多源)。默认内建。 */
  activeRegistry: string;
  /** 当前浏览的仓(M4 一源多仓):寻址键 `owner/repo`。null = 该源主仓。 */
  activeRepo: string | null;
  /** 已安装技能的目录名。任务 10 接 installed_list 后填充;M1 恒为空集,
   *  卡片状态机因此只会走到"安装"那一档——组件本身三档都实现且有测试。 */
  installed: Set<string>;

  /** 详情面板:null 表示关闭。 */
  detailSlug: string | null;
  detail: SkillDetail | null;
  detailError: AppError | null;

  load: (force?: boolean) => Promise<void>;
  /** 切换浏览的库:清掉上一个库的索引并立即按新库重载。repo 缺省 = 该源主仓。 */
  setRegistry: (registryId: string, repo?: string | null) => Promise<void>;
  setQuery: (query: string) => void;
  setFilter: (filter: StoreFilter) => void;
  /** 同一枚再点一次 = 取消(单选语义在这里收口,UI 只管把点击的标签传进来)。 */
  toggleTag: (tag: string) => void;
  openDetail: (dirSlug: string) => Promise<void>;
  closeDetail: () => void;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

export const useStoreIndex = create<StoreIndexState>((set, get) => ({
  status: "idle",
  index: null,
  error: null,
  query: "",
  filter: "all",
  tagFilter: null,
  activeRegistry: "company",
  activeRepo: null,
  installed: new Set(),
  detailSlug: null,
  detail: null,
  detailError: null,

  load: async (force = false) => {
    // 已有内容时保持列表可见,只在首次加载显示骨架——刷新不该让页面闪空
    const registryId = get().activeRegistry;
    const repo = get().activeRepo;
    set({ status: "loading", error: null });
    try {
      const index = await storeIndex(force, registryId, repo ?? undefined);
      // 等待期间用户可能又切了库:旧库的结果不能写进来冒充新库
      if (get().activeRegistry === registryId && get().activeRepo === repo) {
        set({ index, status: "ready", error: null });
      }
    } catch (raw) {
      // 拿不到索引也不弹对话框:界面上给一条带下一步动作的提示 + 重试按钮
      if (get().activeRegistry === registryId && get().activeRepo === repo) {
        set({ error: toAppError(raw), status: "error" });
      }
    }
  },

  setRegistry: async (registryId, repo = null) => {
    if (get().activeRegistry === registryId && get().activeRepo === repo) return;
    // 上一个库的索引立刻清掉:挂着旧库的列表却标着新库,等于对用户撒谎。
    // 标签筛选一并清——别的库多半没有这个标签,残留会把新库的列表锁死成空
    set({
      activeRegistry: registryId,
      activeRepo: repo,
      index: null,
      detailSlug: null,
      detail: null,
      tagFilter: null,
    });
    await get().load();
  },

  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),
  toggleTag: (tag) => set({ tagFilter: get().tagFilter === tag ? null : tag }),

  openDetail: async (dirSlug) => {
    set({ detailSlug: dirSlug, detail: null, detailError: null });
    try {
      const detail = await storeSkillDetail(dirSlug, get().activeRegistry, get().activeRepo ?? undefined);
      // 面板可能在等待期间被关掉或换了技能,回来的结果就不该再写进去
      if (get().detailSlug === dirSlug) set({ detail });
    } catch (raw) {
      if (get().detailSlug === dirSlug) set({ detailError: toAppError(raw) });
    }
  },

  closeDetail: () => set({ detailSlug: null, detail: null, detailError: null }),
}));
