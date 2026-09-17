import { create } from "zustand";
import type { OverwriteWarning } from "@/lib/ipc";

/**
 * 一次待拍板的覆盖(v8 任务 4 / 决策 D2)。
 *
 * 「推上去会顶掉库里那一版」这件事有**三个发起方**(「我的技能」的分享、
 * 分享改动,以及获取冲突里的「保留并分享」),而确认屏只该有一处实现——
 * 所以待拍板状态放在这个独立的 store 里,弹窗挂 `App.tsx` 全局。
 *
 * 🔴 **渲染点必须是全局的**:从商店详情发起时 `MySkillsPage` 根本没挂载,
 * 从「我的技能」发起时它被详情面板的遮罩盖着。本项目已经因为"错误写进了
 * 状态却没有渲染点"被打回六次,这一条不重蹈。
 */
export interface OverwriteDecision {
  /** 哪个技能。用于归属校验与文案点名——绝不显示别的技能的拍板信息。 */
  dirSlug: string;
  /** 技能展示名(拿不到时发起方传 dirSlug)。 */
  name: string;
  warning: OverwriteWarning;
  /**
   * 用户按「仍然覆盖」时重跑的那一跳。
   *
   * 🔴 **由发起方带着自己的上下文闭包进来**,不在这里重新拼参数:三个发起方
   * 各自要带的东西不同(目标库坐标、registryId、要不要先 `run("keepLocal")`),
   * 在确认屏里重算一遍就是把"分享去哪"这个判断抄成第二份——而本项目记着
   * 「显示与提交分两处算就会出现"确认屏说推去 A、实际推去 B"」。
   *
   * 🔴 **契约:它必须自己把失败写进自己那条既有的渲染点**
   * (`useMySkills.shareError` / `useInstall.shareResult`,两者都已在界面上)。
   * 这个 store 不另设一处错误状态——那会变成同一件事两个说法,而且
   * "覆盖这一跳失败了"与"分享失败了"本来就是同一句话。
   */
  confirm: () => Promise<void>;
}

interface OverwriteState {
  pending: OverwriteDecision | null;
  busy: boolean;
  ask: (decision: OverwriteDecision) => void;
  confirmOverwrite: () => Promise<void>;
  /** 「先不动」:只清状态,**零 IPC**。 */
  cancel: () => void;
}

export const useOverwrite = create<OverwriteState>((set, get) => ({
  pending: null,
  busy: false,

  ask: (decision) => set({ pending: decision, busy: false }),

  confirmOverwrite: async () => {
    const pending = get().pending;
    if (!pending) return;
    set({ busy: true });
    try {
      await pending.confirm();
    } finally {
      // 成功与失败都关掉:失败的那句话由发起方写进它自己那条渲染点
      // (见 `confirm` 的契约)。`finally` 而不是 `then`——发起方万一漏了
      // 一条 catch,弹窗也不能永远停在忙碌态。
      set({ pending: null, busy: false });
    }
  },

  cancel: () => set({ pending: null, busy: false }),
}));
