// 设置页的可变配置:自动更新档位与 agent 开关。
//
// 写入都是"乐观更新 + 失败回滚":界面立刻响应,IPC 失败把状态滚回去并亮出错误
// ——设置项没存上却显示已生效,等于对用户撒谎。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  agentsSetDisabled,
  autoUpdateGet,
  autoUpdateSet,
  isAppError,
  listenSchedulerReport,
  updateCheckNow,
  type AppError,
  type AutoUpdate,
  type CheckReport,
  type DetectedAgent,
} from "@/lib/ipc";

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

interface SettingsState {
  agents: DetectedAgent[] | null;
  autoUpdate: AutoUpdate | null;
  error: AppError | null;
  /** 最近一轮定时/手动检查的结果(scheduler://report)。 */
  lastReport: CheckReport | null;
  /** 「立即检查」按下后、结果事件回来前为 true。 */
  checking: boolean;
  load: () => Promise<void>;
  toggleAgent: (name: string) => Promise<void>;
  /** 三档之一:手动(enabled=false,频率保留)/ 每 4 小时 / 每天。 */
  setSkillsUpdate: (next: { enabled: boolean; intervalHours?: number }) => Promise<void>;
  setAppUpdate: (app: boolean) => Promise<void>;
  checkNow: () => Promise<void>;
  /** 启动时挂一次:检查结果落进 store(设置页与后续的通知都从这拿)。 */
  attachReportListener: () => Promise<() => void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  agents: null,
  autoUpdate: null,
  error: null,
  lastReport: null,
  checking: false,

  load: async () => {
    try {
      const [detected, autoUpdate] = await Promise.all([agentsDetected(), autoUpdateGet()]);
      set({ agents: detected.agents, autoUpdate, error: null });
    } catch (raw) {
      set({ error: toAppError(raw) });
    }
  },

  toggleAgent: async (name) => {
    const { agents } = get();
    if (!agents) return;
    const next = agents.map((a) => (a.name === name ? { ...a, disabled: !a.disabled } : a));
    set({ agents: next, error: null });
    try {
      await agentsSetDisabled(next.filter((a) => a.disabled).map((a) => a.name));
    } catch (raw) {
      set({ agents, error: toAppError(raw) });
    }
  },

  setSkillsUpdate: async ({ enabled, intervalHours }) => {
    const { autoUpdate } = get();
    if (!autoUpdate) return;
    const next: AutoUpdate = {
      ...autoUpdate,
      skills: {
        enabled,
        // 「手动」只关开关不动频率——用户回头再打开时,原来的档位还在
        intervalHours: intervalHours ?? autoUpdate.skills.intervalHours,
      },
    };
    set({ autoUpdate: next, error: null });
    try {
      await autoUpdateSet(next);
    } catch (raw) {
      set({ autoUpdate, error: toAppError(raw) });
    }
  },

  setAppUpdate: async (app) => {
    const { autoUpdate } = get();
    if (!autoUpdate) return;
    const next = { ...autoUpdate, app };
    set({ autoUpdate: next, error: null });
    try {
      await autoUpdateSet(next);
    } catch (raw) {
      set({ autoUpdate, error: toAppError(raw) });
    }
  },

  checkNow: async () => {
    set({ checking: true, error: null });
    try {
      await updateCheckNow();
      // 结果由 scheduler://report 事件送达,这里只负责把"转起来了"亮出来
    } catch (raw) {
      set({ checking: false, error: toAppError(raw) });
    }
  },

  attachReportListener: () => {
    return listenSchedulerReport((report) => {
      set({ lastReport: report, checking: false });
    });
  },
}));
