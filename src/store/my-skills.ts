// 「我的技能」页的状态:列表 + 移除流程。
//
// 移除的走向(与获取流程的冲突档同构):
//   idle → confirming(第一重弹窗) → busy → 完成(列表刷新)
//                    ↓ core 报 needsDecision(用户改过本体)
//              confirmingForce(第二重弹窗,红色警示) → busy(force) → 完成
//
// core 在 force=false 时遇到本地改动**不动磁盘**就返回,第二重确认拿到后才真删。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  installedList,
  isAppError,
  skillRemove,
  skillRepair,
  type AppError,
  type InstalledSkillView,
} from "@/lib/ipc";
import { useInstall } from "@/store/install";

export type RemovePhase = "idle" | "confirming" | "confirmingForce" | "busy";

interface MySkillsState {
  /** null = 尚未加载成功。区分于"加载成功但一个都没有"——空状态不能撒谎。 */
  list: InstalledSkillView[] | null;
  loadError: AppError | null;
  loading: boolean;
  /** agent 内部名 → 显示名。界面上不摆 `claude-code` 这种机器标识。 */
  agentNames: Map<string, string>;

  removePhase: RemovePhase;
  removeTarget: string | null;
  removeError: AppError | null;

  /** 正在等替换确认的修复目标(链接位置被实体目录占用时才需要)。 */
  repairConfirmTarget: string | null;
  repairBusy: string | null;
  repairError: AppError | null;

  load: () => Promise<void>;
  askRemove: (dirSlug: string) => void;
  cancelRemove: () => void;
  /** 弹窗里的确认。第一重不带 force;core 说要再确认时进入第二重,那一次才带。 */
  confirmRemove: () => Promise<void>;

  /**
   * 修复关联。断链/丢失/被改指的**链接**直接重建(链接不是用户数据,无需确认);
   * 只有占位是实体目录时才先弹确认——替换会删掉那个目录,原内容无法找回。
   */
  repair: (dirSlug: string) => Promise<void>;
  cancelRepair: () => void;
  confirmRepair: () => Promise<void>;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

export const useMySkills = create<MySkillsState>((set, get) => ({
  list: null,
  loadError: null,
  loading: false,
  agentNames: new Map(),
  removePhase: "idle",
  removeTarget: null,
  removeError: null,
  repairConfirmTarget: null,
  repairBusy: null,
  repairError: null,

  load: async () => {
    set({ loading: true, loadError: null });
    try {
      const list = await installedList();
      set({ list, loading: false });
    } catch (raw) {
      // 读不到就说读不到,保留上次的列表;绝不把失败画成"你还没装任何技能"
      set({ loadError: toAppError(raw), loading: false });
    }
    try {
      const detected = await agentsDetected();
      set({ agentNames: new Map(detected.agents.map((a) => [a.name, a.displayName])) });
    } catch {
      // 拿不到显示名就先用内部名顶着,不值得为它挂掉整页
    }
  },

  askRemove: (dirSlug) =>
    set({ removePhase: "confirming", removeTarget: dirSlug, removeError: null }),

  cancelRemove: () => set({ removePhase: "idle", removeTarget: null, removeError: null }),

  confirmRemove: async () => {
    const { removePhase, removeTarget } = get();
    if (!removeTarget) return;
    const force = removePhase === "confirmingForce";
    set({ removePhase: "busy", removeError: null });
    try {
      const result = await skillRemove({ dirSlug: removeTarget, force });
      if (result.outcome === "needsDecision") {
        // core 没动磁盘:用户改过本体,升级为第二重红色警示
        set({ removePhase: "confirmingForce" });
        return;
      }
      set({ removePhase: "idle", removeTarget: null });
      await get().load();
      // 商店卡片的"已启用"状态也要跟上
      await useInstall.getState().refreshInstalled();
    } catch (raw) {
      set({ removePhase: force ? "confirmingForce" : "confirming", removeError: toAppError(raw) });
    }
  },

  repair: async (dirSlug) => {
    const skill = get().list?.find((s) => s.dirSlug === dirSlug);
    // 有实体目录占位时,先问过用户才动它;其余形态直接修
    if (skill?.links.some((l) => l.health === "occupied")) {
      set({ repairConfirmTarget: dirSlug, repairError: null });
      return;
    }
    await runRepair(dirSlug, false, set, get);
  },

  cancelRepair: () => set({ repairConfirmTarget: null, repairError: null }),

  confirmRepair: async () => {
    const target = get().repairConfirmTarget;
    if (!target) return;
    set({ repairConfirmTarget: null });
    await runRepair(target, true, set, get);
  },
}));

async function runRepair(
  dirSlug: string,
  replaceOccupied: boolean,
  set: (partial: Partial<MySkillsState>) => void,
  get: () => MySkillsState,
) {
  set({ repairBusy: dirSlug, repairError: null });
  try {
    await skillRepair({ dirSlug, replaceOccupied });
    await get().load();
  } catch (raw) {
    set({ repairError: toAppError(raw) });
  } finally {
    set({ repairBusy: null });
  }
}

/** 与商店页同口径:整库 head 变了就提示可更新(SKILL.md 级别的精确比对是 M2 的事)。 */
export function hasUpdate(skill: InstalledSkillView, indexSha: string | undefined): boolean {
  return Boolean(indexSha) && skill.commitSha !== indexSha;
}
