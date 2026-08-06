// 设置页的可变配置:自动更新档位与 agent 开关。
//
// 写入都是"乐观更新 + 失败回滚":界面立刻响应,IPC 失败把状态滚回去并亮出错误
// ——设置项没存上却显示已生效,等于对用户撒谎。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  agentsSetDisabled,
  appRestart,
  appUpdateCheck,
  appUpdateInstall,
  autoUpdateGet,
  autoUpdateSet,
  isAppError,
  listenAppUpdateAvailable,
  listenSchedulerReport,
  updateCheckNow,
  type AppError,
  type AutoUpdate,
  type CheckReport,
  type DetectedAgent,
} from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

/** App 自更新的界面状态机。 */
export type AppUpdatePhase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; version: string }
  | { phase: "installing"; version: string }
  | { phase: "installed" }
  | { phase: "failed"; error: AppError };

interface SettingsState {
  agents: DetectedAgent[] | null;
  autoUpdate: AutoUpdate | null;
  error: AppError | null;
  /** 最近一轮定时/手动检查的结果(scheduler://report)。 */
  lastReport: CheckReport | null;
  /** 「立即检查」按下后、结果事件回来前为 true。 */
  checking: boolean;
  appUpdate: AppUpdatePhase;
  load: () => Promise<void>;
  toggleAgent: (name: string) => Promise<void>;
  /** 三档之一:手动(enabled=false,频率保留)/ 每 4 小时 / 每天。 */
  setSkillsUpdate: (next: { enabled: boolean; intervalHours?: number }) => Promise<void>;
  setAppUpdate: (app: boolean) => Promise<void>;
  checkNow: () => Promise<void>;
  /** 启动时挂一次:检查结果落进 store(设置页与后续的通知都从这拿)。 */
  attachReportListener: () => Promise<() => void>;
  checkAppUpdate: () => Promise<void>;
  installAppUpdate: () => Promise<void>;
  restartApp: () => Promise<void>;
  /** 启动时挂一次:启动探测发现新版本时,设置页同步亮出来。 */
  attachAppUpdateListener: () => Promise<() => void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  agents: null,
  autoUpdate: null,
  error: null,
  lastReport: null,
  checking: false,
  appUpdate: { phase: "idle" },

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
      // 定时检查真装了东西时,界面上的记账已经过时:不刷新的话「我的技能」还挂着
      // 「有新版本」、商店卡片还停在"更新"档,而磁盘上早就是新版了。
      if (report.status === "checked" && report.updated.length > 0) {
        void useInstall.getState().refreshInstalled();
        void useMySkills.getState().load();
      }
    });
  },

  checkAppUpdate: async () => {
    set({ appUpdate: { phase: "checking" } });
    try {
      const status = await appUpdateCheck();
      set({
        appUpdate:
          status.status === "available"
            ? { phase: "available", version: status.version }
            : status.status === "ready"
              ? // 后台已静默装好:对设置页而言等价于"装完了,提示重启"
                { phase: "installed" }
              : { phase: "upToDate" },
      });
    } catch (raw) {
      set({ appUpdate: { phase: "failed", error: toAppError(raw) } });
    }
  },

  installAppUpdate: async () => {
    const { appUpdate } = get();
    if (appUpdate.phase !== "available") return;
    set({ appUpdate: { phase: "installing", version: appUpdate.version } });
    try {
      await appUpdateInstall();
      set({ appUpdate: { phase: "installed" } });
    } catch (raw) {
      set({ appUpdate: { phase: "failed", error: toAppError(raw) } });
    }
  },

  restartApp: async () => {
    await appRestart().catch(() => {
      // 重启失败极罕见(权限/被安全软件拦):留在"已安装"态,用户手动重启同样生效
    });
  },

  attachAppUpdateListener: () => {
    return listenAppUpdateAvailable((version) => {
      // 用黑名单而不是白名单:除了"正在装/装完"这两个不能被打断的状态,
      // 其余(含上一次检查失败)都该让位给"有新版本可用"——白名单会漏掉
      // 以后新增的中间态,让事件悄悄失效。
      const { phase } = get().appUpdate;
      if (phase !== "installing" && phase !== "installed") {
        set({ appUpdate: { phase: "available", version } });
      }
    });
  },
}));
