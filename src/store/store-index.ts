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
  /** 当前浏览的源(M3 多源)。默认内建。 */
  activeRegistry: string;
  /** 已安装技能的目录名。任务 10 接 installed_list 后填充;M1 恒为空集,
   *  卡片状态机因此只会走到"安装"那一档——组件本身三档都实现且有测试。 */
  installed: Set<string>;

  /** 详情面板:null 表示关闭。 */
  detailSlug: string | null;
  detail: SkillDetail | null;
  detailError: AppError | null;

  load: (force?: boolean) => Promise<void>;
  /** 切换浏览的源:清掉上一个源的索引并立即按新源重载。 */
  setRegistry: (registryId: string) => Promise<void>;
  setQuery: (query: string) => void;
  setFilter: (filter: StoreFilter) => void;
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
  activeRegistry: "company",
  installed: new Set(),
  detailSlug: null,
  detail: null,
  detailError: null,

  load: async (force = false) => {
    // 已有内容时保持列表可见,只在首次加载显示骨架——刷新不该让页面闪空
    const registryId = get().activeRegistry;
    set({ status: "loading", error: null });
    try {
      const index = await storeIndex(force, registryId);
      // 等待期间用户可能又切了源:旧源的结果不能写进来冒充新源
      if (get().activeRegistry === registryId) {
        set({ index, status: "ready", error: null });
      }
    } catch (raw) {
      // 拿不到索引也不弹对话框:界面上给一条带下一步动作的提示 + 重试按钮
      if (get().activeRegistry === registryId) {
        set({ error: toAppError(raw), status: "error" });
      }
    }
  },

  setRegistry: async (registryId) => {
    if (get().activeRegistry === registryId) return;
    // 上一个源的索引立刻清掉:挂着旧源的列表却标着新源,等于对用户撒谎
    set({ activeRegistry: registryId, index: null, detailSlug: null, detail: null });
    await get().load();
  },

  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),

  openDetail: async (dirSlug) => {
    set({ detailSlug: dirSlug, detail: null, detailError: null });
    try {
      const detail = await storeSkillDetail(dirSlug, get().activeRegistry);
      // 面板可能在等待期间被关掉或换了技能,回来的结果就不该再写进去
      if (get().detailSlug === dirSlug) set({ detail });
    } catch (raw) {
      if (get().detailSlug === dirSlug) set({ detailError: toAppError(raw) });
    }
  },

  closeDetail: () => set({ detailSlug: null, detail: null, detailError: null }),
}));
