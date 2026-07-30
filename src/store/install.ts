// 获取流程的前端状态机。
//
// 一次安装的可能走向:
//   idle → choosing(勾 agent) → running → done
//                                   ↓
//                              conflict(等用户拍板) → running → done
//                                   ↓
//                                 error
//
// 冲突那一档是整条流程的重点:core 在发现"用户改过本体 / 目录是别人的"时**不动磁盘**
// 就返回,前端拿到结论再带着 resolution 重试一次。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  installedList,
  isAppError,
  listenProgress,
  skillInstall,
  type AppError,
  type DetectedAgent,
  type InstallReport,
  type InstallStage,
  type Precheck,
  type Resolution,
} from "@/lib/ipc";

export type InstallPhase = "idle" | "choosing" | "running" | "conflict" | "done" | "error";

interface InstallState {
  phase: InstallPhase;
  /** 正在安装哪个技能(技能库中的目录名)。 */
  dirSlug: string | null;
  agents: DetectedAgent[];
  /** 勾选的 agent name。 */
  selected: Set<string>;
  stage: InstallStage | null;
  report: InstallReport | null;
  /** 本次保留了用户的本地改动。 */
  localKept: boolean;
  precheck: Precheck | null;
  error: AppError | null;
  /** 已安装技能:商店卡片的状态机数据源。 */
  installed: Map<string, { commitSha: string; localModified: boolean }>;

  refreshInstalled: () => Promise<void>;
  /** 点"安装"→ 展开 agent 勾选。 */
  begin: (dirSlug: string) => Promise<void>;
  toggleAgent: (name: string) => void;
  /** 确认安装。`resolution` 只在从冲突弹窗回来时带。 */
  run: (resolution?: Resolution) => Promise<void>;
  cancel: () => void;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

/** 每次安装一个独立频道,避免上一次的残余进度串到这一次。 */
let taskSeq = 0;

export const useInstall = create<InstallState>((set, get) => ({
  phase: "idle",
  dirSlug: null,
  agents: [],
  selected: new Set(),
  stage: null,
  report: null,
  localKept: false,
  precheck: null,
  error: null,
  installed: new Map(),

  refreshInstalled: async () => {
    try {
      const list = await installedList();
      set({
        installed: new Map(
          list.map((s) => [s.dirSlug, { commitSha: s.commitSha, localModified: s.localModified }]),
        ),
      });
    } catch {
      // 读不到已安装列表不该拦住浏览:商店照常显示,只是状态机都停在"安装"这一档
    }
  },

  begin: async (dirSlug) => {
    set({
      phase: "choosing",
      dirSlug,
      stage: null,
      report: null,
      error: null,
      precheck: null,
      localKept: false,
    });
    try {
      const detected = await agentsDetected();
      set({
        agents: detected.agents,
        // 默认全选**已检测到**的(交接包 3.5 任务 9):没装的工具勾上也没意义
        selected: new Set(detected.agents.filter((a) => a.installed).map((a) => a.name)),
      });
    } catch (raw) {
      set({ phase: "error", error: toAppError(raw) });
    }
  },

  toggleAgent: (name) => {
    const selected = new Set(get().selected);
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    set({ selected });
  },

  run: async (resolution) => {
    const { dirSlug, selected } = get();
    if (!dirSlug) return;

    const taskId = `install-${dirSlug}-${(taskSeq += 1)}`;
    set({ phase: "running", stage: null, error: null });

    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listenProgress(taskId, (stage) => set({ stage }));
    } catch {
      // 收不到进度只是少了个动画,不该让安装本身走不下去
    }

    try {
      const result = await skillInstall({
        dirSlug,
        agentIds: [...selected],
        taskId,
        resolution,
      });
      if (result.outcome === "needsDecision") {
        // core 没动磁盘,等用户拍板
        set({ phase: "conflict", precheck: result.precheck });
        return;
      }
      set({
        phase: "done",
        report: result.report,
        localKept: result.localKept,
        precheck: null,
      });
      await get().refreshInstalled();
    } catch (raw) {
      set({ phase: "error", error: toAppError(raw) });
    } finally {
      unlisten?.();
    }
  },

  cancel: () =>
    set({
      phase: "idle",
      dirSlug: null,
      stage: null,
      report: null,
      precheck: null,
      error: null,
      localKept: false,
    }),
}));

/** 建链失败的目录数。技能本体已经装好了,这些只是关联没建上。 */
export function failedLinks(report: InstallReport | null): number {
  return report?.links.filter((l) => l.result.status === "failed").length ?? 0;
}

/**
 * 真正建立了关联的 agent,用于结果文案。
 *
 * 返回**显示名**而不是内部 name:core 里流转的是 `claude-code`、`trae` 这种标识,
 * 直接摆给用户看就成了"已启用到 claude-code、trae"——那是给机器读的名字。
 * 认不出来的标识原样保留,总比丢掉一项强。
 */
export function linkedAgents(
  report: InstallReport | null,
  agents: DetectedAgent[] = [],
): string[] {
  const display = new Map(agents.map((a) => [a.name, a.displayName]));
  return (report?.links ?? [])
    .filter((l) => l.result.status === "linked" || l.result.status === "unchanged")
    .flatMap((l) => l.agents)
    .map((name) => display.get(name) ?? name);
}
