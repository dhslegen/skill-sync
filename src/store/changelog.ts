// 更新日志的前端状态(目标 ②)。
//
// 只有两件事:读一次状态、用户关掉卡片时写「已看过」。
// **刻意与自更新那套(store/settings.ts 的 app 自更新档)分开**:那边管的是
// "有新版可装",这边管的是"新版已经在跑了,告诉用户它改了什么"——
// 判据、时机、落盘位置都不一样,合成一个 store 只会互相牵制。
import { create } from "zustand";

import { releaseNotesAck, releaseNotesState, type ReleaseNote } from "@/lib/ipc";

interface ChangelogState {
  current: string;
  /** 这一次该给用户看的段落(新到旧)。空 = 不摆卡片。 */
  pending: ReleaseNote[];
  /** 全部段落,设置页的「版本历史」用。 */
  all: ReleaseNote[];
  /** 用户这一次会话里把卡片关掉了。 */
  dismissed: boolean;

  load: () => Promise<void>;
  dismiss: () => Promise<void>;
}

/** IPC 返回值不可信:通道异常或旧版 core 都可能给回非数组,直接塞进 state 会让渲染层崩。 */
function asNotes(value: unknown): ReleaseNote[] {
  return Array.isArray(value) ? (value as ReleaseNote[]) : [];
}

export const useChangelog = create<ChangelogState>((set) => ({
  current: "",
  pending: [],
  all: [],
  dismissed: false,

  load: async () => {
    try {
      const state = await releaseNotesState();
      set({
        current: state?.current ?? "",
        pending: asNotes(state?.pending),
        all: asNotes(state?.all),
      });
    } catch {
      // 读不到更新日志不该弹错误框——它是锦上添花,不是用户要做的事。
      // 同 core 侧的宽容解析(见 core::release_notes 模块头)。
      set({ pending: [], all: [] });
    }
  },

  dismiss: async () => {
    // 先收起来再写记账:用户点了关闭,界面必须立刻听话。
    // 记账写失败的后果只是下次启动再弹一次;而"点了关闭纹丝不动"会被当成卡死。
    set({ dismissed: true });
    try {
      await releaseNotesAck();
    } catch {
      // 同上,不打扰用户
    }
  },
}));
