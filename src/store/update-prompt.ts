// 全局更新提示(M6 任务 2):App 新版在后台静默装好后,左下角 pill 的数据源。
// 生命周期天然到重启为止——重启后运行的就是新版,这份状态不落盘、不需要"忽略此版本"。
import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { appRestart, listenAppUpdateReady } from "@/lib/ipc";
import { useSettings } from "@/store/settings";

interface UpdatePromptState {
  /** 装好等重启的版本;null = 没有待重启的新版。 */
  readyVersion: string | null;
  /** 本次会话内用户点过"暂不":pill 收起,但新版本事件会重新亮出来。 */
  dismissed: boolean;
  /** App 启动时挂一次:监听 app-update://ready。 */
  attach: () => Promise<UnlistenFn>;
  dismiss: () => void;
  restart: () => Promise<void>;
}

export const useUpdatePrompt = create<UpdatePromptState>((set) => ({
  readyVersion: null,
  dismissed: false,

  attach: () =>
    listenAppUpdateReady((version) => {
      // 每个 ready 事件都是一个真正的新版本(core 侧同版本去重),所以 dismissed 重置
      set({ readyVersion: version, dismissed: false });
      // 设置页联动:后台装好对它而言就是"装完了,提示重启"。
      // 黑名单沿用它自己的姿态——正在手动安装的状态机不打断。
      const { phase } = useSettings.getState().appUpdate;
      if (phase !== "installing") {
        useSettings.setState({ appUpdate: { phase: "installed" } });
      }
    }),

  dismiss: () => set({ dismissed: true }),

  restart: async () => {
    await appRestart().catch(() => {
      // 重启失败极罕见(权限/被安全软件拦):pill 留着,用户手动重启同样生效
    });
  },
}));
