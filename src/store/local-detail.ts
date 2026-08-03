// 本地技能详情面板的状态:「我的技能」与分享页共用。
// 与商店详情(store-index 里的 detailSlug/detail)是两个独立数据源:
// 已装技能可能来源已移除或是 npx skills 装的,商店索引里根本没有它。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  isAppError,
  skillLocalDetail,
  skillReveal,
  type AppError,
  type LocalSkillDetail,
  type LocalSkillTarget,
} from "@/lib/ipc";

interface LocalDetailState {
  /** null = 面板关闭。 */
  target: LocalSkillTarget | null;
  detail: LocalSkillDetail | null;
  error: AppError | null;
  revealError: AppError | null;

  open: (target: LocalSkillTarget) => Promise<void>;
  close: () => void;
  /** 在访达/资源管理器中显示当前技能目录。 */
  reveal: () => Promise<void>;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

export const useLocalDetail = create<LocalDetailState>((set, get) => ({
  target: null,
  detail: null,
  error: null,
  revealError: null,

  open: async (target) => {
    set({ target, detail: null, error: null, revealError: null });
    try {
      const detail = await skillLocalDetail(target);
      // 等待期间面板被关掉/换了目标,迟到的结果不能顶掉现状
      if (get().target === target) set({ detail });
    } catch (raw) {
      if (get().target === target) set({ error: toAppError(raw) });
    }
  },

  close: () => set({ target: null, detail: null, error: null, revealError: null }),

  reveal: async () => {
    const { target } = get();
    if (!target) return;
    set({ revealError: null });
    try {
      await skillReveal(target);
    } catch (raw) {
      set({ revealError: toAppError(raw) });
    }
  },
}));
