// 界面级瞬时状态:当前页、命令面板开关、以及 IME 组合输入标志。
import { create } from "zustand";

// 「分享」页已于 v6 二期撤销:首次分享收进「我的技能」那一行的确认屏。
//
// 🔴 v7.3:「项目里」从「我的技能」的第四个页签**升成侧边栏一条独立的页**
// (`"projects"`,标题「项目里的技能」)。原因是 v7.2 那一行页签**混了两个轴**
// ——前三个回答"与公司技能库的关系",「项目里」回答"装在哪",正交的两个问题
// 排成一行,扫过去没有能串起来的逻辑。侧边栏那一层本来就是按"这是哪一类东西"
// 分的,「项目里的技能」放在那里与「技能商店」「我的技能」同构。
export type PageId = "store" | "mine" | "projects" | "settings";

interface UiState {
  page: PageId;
  paletteOpen: boolean;
  /**
   * 是否正在拼音/日文等组合输入中。
   *
   * 组合期间既不能触发搜索(会拿着半截拼音去过滤),也不能响应 Cmd+K、Esc 这类快捷键
   * ——输入法把候选窗交给页面时,keydown 里的键值并不是用户想按的键(UI 规范 §6.4)。
   */
  composing: boolean;
  setPage: (page: PageId) => void;
  setPaletteOpen: (open: boolean) => void;
  setComposing: (composing: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  page: "store",
  paletteOpen: false,
  composing: false,
  setPage: (page) => set({ page }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setComposing: (composing) => set({ composing }),
}));
