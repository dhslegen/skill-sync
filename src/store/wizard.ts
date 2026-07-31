// 首次启动向导(UX#1)的状态:三步走——认识工具 → 登录(可跳过)→ 精选一键装。
//
// 目标是"3 分钟从安装到用上第一个技能",所以每一步都不设卡点:
// 没检测到工具能继续、不登录能继续、没有精选清单就引导去商店。
//
// 完成标记自 M2 任务 1 起落 config.json(store/prefs.ts),config 有值以 config 为准;
// config 不可用时退回 localStorage 缓存——与 M1 行为一致,不因故障把向导再弹一遍。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  isAppError,
  skillInstallBatch,
  type AppError,
  type BatchItem,
  type DetectedAgent,
} from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { markWizardDone, syncUiPrefs, WIZARD_DONE_KEY } from "@/store/prefs";

export type WizardStep = "agents" | "signIn" | "curated";

interface WizardState {
  open: boolean;
  step: WizardStep;
  agents: DetectedAgent[];
  /** 第三步勾选的技能(dirSlug)。 */
  selected: Set<string>;
  /** 默认全选只播种一次;用 size==0 判断会在用户全取消后把勾又打回来。 */
  seeded: boolean;
  installing: boolean;
  results: BatchItem[] | null;
  error: AppError | null;

  /** 启动时调用:没有完成标记才打开。 */
  maybeOpen: () => Promise<void>;
  next: () => void;
  /** 精选清单就绪后初始化勾选(默认全选)。 */
  seedSelection: (dirSlugs: string[]) => void;
  toggle: (dirSlug: string) => void;
  installSelected: () => Promise<void>;
  /** 完成或「稍后再说」:写标记,关向导。 */
  finish: () => void;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

export const useWizard = create<WizardState>((set, get) => ({
  open: false,
  step: "agents",
  agents: [],
  selected: new Set(),
  seeded: false,
  installing: false,
  results: null,
  error: null,

  maybeOpen: async () => {
    // config 有值以 config 为准(跨机器同步的是它);拿不到时退回本机缓存
    const prefs = await syncUiPrefs();
    const done = prefs ? prefs.wizardDone : localStorage.getItem(WIZARD_DONE_KEY) !== null;
    if (done) return;
    set({ open: true, step: "agents" });
    try {
      const detected = await agentsDetected();
      set({ agents: detected.agents });
    } catch {
      // 检测失败不拦向导:第一步会显示"没检测到",后面照走
    }
  },

  next: () => {
    const { step } = get();
    if (step === "agents") set({ step: "signIn" });
    else if (step === "signIn") set({ step: "curated" });
  },

  seedSelection: (dirSlugs) => {
    if (!get().seeded) {
      set({ selected: new Set(dirSlugs), seeded: true });
    }
  },

  toggle: (dirSlug) => {
    const selected = new Set(get().selected);
    if (selected.has(dirSlug)) selected.delete(dirSlug);
    else selected.add(dirSlug);
    set({ selected });
  },

  installSelected: async () => {
    const { selected, agents } = get();
    if (selected.size === 0) return;
    set({ installing: true, error: null });
    try {
      const results = await skillInstallBatch({
        dirSlugs: [...selected],
        // 关联到全部已检测到的工具——与获取流程的默认勾选同一口径
        agentIds: agents.filter((a) => a.installed).map((a) => a.name),
      });
      set({ results, installing: false });
      await useInstall.getState().refreshInstalled();
    } catch (raw) {
      set({ error: toAppError(raw), installing: false });
    }
  },

  finish: () => {
    markWizardDone();
    set({ open: false });
  },
}));