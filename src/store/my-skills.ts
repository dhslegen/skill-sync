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
  skillClaim,
  skillRemove,
  skillRepair,
  skillShareChanges,
  type AppError,
  type InstalledSkillView,
  type ShareMode,
} from "@/lib/ipc";
import { remoteHashOf } from "@/lib/update";
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

  /** 「分享改动」:正在推的技能 / 刚推完的结果 / 错误。 */
  shareBusy: string | null;
  shareDone: { dirSlug: string; mode: ShareMode } | null;
  shareError: AppError | null;

  /** 「认领」(M3 任务 6):正在认领的技能 / 错误。 */
  claimBusy: string | null;
  claimError: AppError | null;

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

  /** 把改过的已装技能推回来源仓库(冲突弹窗承诺的"分享改动"通道)。 */
  shareChanges: (dirSlug: string) => Promise<void>;

  /** 认领上游(npx skills)装的技能,成功后刷新列表。 */
  claim: (dirSlug: string) => Promise<void>;
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
  shareBusy: null,
  shareDone: null,
  shareError: null,
  claimBusy: null,
  claimError: null,

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

  claim: async (dirSlug) => {
    set({ claimBusy: dirSlug, claimError: null });
    try {
      await skillClaim({ dirSlug });
      await get().load();
      // 认领后它成了正式的已装技能,商店卡片状态也要跟上
      await useInstall.getState().refreshInstalled();
    } catch (raw) {
      set({ claimError: toAppError(raw) });
    } finally {
      set({ claimBusy: null });
    }
  },

  shareChanges: async (dirSlug) => {
    set({ shareBusy: dirSlug, shareDone: null, shareError: null });
    try {
      const registryId = get().list?.find((s) => s.dirSlug === dirSlug)?.registryId;
      const submitted = await skillShareChanges({ dirSlug, registryId });
      set({ shareDone: { dirSlug, mode: submitted.mode } });
      // 直推成功后 core 已更新记账,「已改动」徽标随刷新消失;
      // 走了评审则记账没动,徽标留着——改动确实还没进库
      await get().load();
    } catch (raw) {
      set({ shareError: toAppError(raw) });
    } finally {
      set({ shareBusy: null });
    }
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

/**
 * 与商店页同口径:**逐技能**比内容指纹。
 *
 * 曾经比的是整库 HEAD sha(`skill.commitSha !== index.commitSha`),于是库里任何
 * 一次提交——哪怕是别人分享了另一个技能——都会让全部已装技能同时亮起"有更新"
 * (2026-08-03 用户实测报的缺陷)。指纹由 core 在建索引时按与
 * `fsops::dir_content_hash` 同一套算法算出,两边可直接比较。
 *
 * 另有两道门:索引必须是**同一个技能库**的——源相同还不够,一源多仓后
 * (M4 任务 1)同一个源下有多份索引,商店切到设计部技能库时它的内容说明不了
 * 主库装的技能;两库有同名技能时按源比会直接比出错误结论。
 * 来源已移除的技能没有更新去处,永不亮"有新版本"。
 */
export function hasUpdate(
  skill: InstalledSkillView,
  index:
    | {
        registryId: string;
        owner: string;
        repo: string;
        skills: { dirSlug: string; contentHash: string }[];
      }
    | null
    | undefined,
): boolean {
  // 来源没了、或这个技能库不在列表里,更新都没有去处:摆出「更新」就是引诱用户
  // 去点一个必然报 REPO_UNKNOWN_REPO 的按钮(M4 任务 2)。
  if (!index || skill.sourceRemoved || skill.libraryRemoved) return false;
  if (
    skill.registryId !== index.registryId ||
    skill.sourceOwner !== index.owner ||
    skill.sourceRepo !== index.repo
  ) {
    return false;
  }
  const remote = remoteHashOf(index, skill.dirSlug);
  // 拿不到任一侧的指纹就说"没有更新":宁可漏报,也不能凭空催所有人去更新
  if (!remote || !skill.contentHash) return false;
  return remote !== skill.contentHash;
}
