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
  skillShareChanges,
  type AppError,
  type InstalledSkillView,
  type ShareMode,
} from "@/lib/ipc";
import { remoteHashOf } from "@/lib/update";
import { defaultSelectedAgents, useInstall } from "@/store/install";

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

  /** 「分享改动」/「分享更新」:正在推的技能 / 刚推完的结果 / 错误。
   *  两个动作共用这一组状态——它们都是同一个底层动作(把本地改动推回来源),
   *  只是「我分享的」区块换了个更贴切的说法。 */
  shareBusy: string | null;
  shareDone: { dirSlug: string; mode: ShareMode } | null;
  shareError: AppError | null;
  /**
   * 冲突档(M5 任务 1):远端在获取之后被别人改过,core 一个字节没动就退了回来。
   * 等用户拍板:提交审核(confirmShareReview)/ 先不动(cancelShareConflict)。
   * 没有「强行覆盖」——覆盖别人的改动不该是一个按钮。
   */
  shareConflict: { dirSlug: string; historyUrl: string | null } | null;

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

  /** 把改过的已装技能推回来源仓库(冲突弹窗承诺的"分享改动"通道,「我安装的」区块用)。 */
  shareChanges: (dirSlug: string) => Promise<void>;

  /**
   * 「我分享的」区块 · localAhead 状态的主动作:把本地改动分享更新回库里
   * (v6 任务 4)。底层与 `shareChanges` 同一条编排——本地有账的技能,把改动
   * 推回来源就是推回来源,分区只是换了个更贴切的说法,不该另写一份逻辑。
   */
  shareUpdate: (dirSlug: string) => Promise<void>;

  /**
   * 「我分享的」区块 · notHere/remoteAhead/both 状态的主动作:取回这一版
   * (v6 任务 4)。底层复用获取流程的 `beginUpdate`——`both` 时 core 的 precheck
   * 会返回 `needsDecision`(`Mine` 档),自然落进全局挂载的 `ConflictDialog`,
   * 不需要这里另开一条弹窗通道。
   *
   * `notHere`(这台电脑从没装过)时账上没有"上次启用了哪些工具"可沿用,
   * 退化为按默认规则(已探测到、未在设置里禁用的)勾选,而不是取回后
   * 一个 agent 都不关联——那等同于把"取回"做成一个半成品动作。
   */
  pull: (dirSlug: string) => Promise<void>;

  /** 冲突档的确认:改动走提交审核(带 forceReview 的第二跳,绝不直推)。 */
  confirmShareReview: () => Promise<void>;
  /** 冲突档的取消:什么都不发,改动留在本地。 */
  cancelShareConflict: () => void;
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
  shareConflict: null,

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

  shareChanges: async (dirSlug) => {
    await runShareChanges(dirSlug, false, set, get);
  },

  shareUpdate: async (dirSlug) => {
    await runShareChanges(dirSlug, false, set, get);
  },

  pull: async (dirSlug) => {
    const skill = get().list?.find((s) => s.dirSlug === dirSlug);
    if (!skill) return;
    const repo = skill.sourceRepo ? `${skill.sourceOwner}/${skill.sourceRepo}` : undefined;
    let agentIds = skill.agents;
    if (agentIds.length === 0) {
      // 这台电脑从没装过(notHere):账上没有"上次启用了哪些工具"可沿用,
      // 退化为按默认规则(已探测到、未在设置里禁用的)勾选——不这样做的话
      // 取回会静默装出一个不关联任何 AI 工具的技能,等于半成品。
      try {
        const detected = await agentsDetected();
        agentIds = defaultSelectedAgents(detected.agents);
      } catch {
        // 拿不到检测结果就先把本体取回来,关联可以之后再补
      }
    }
    await useInstall.getState().beginUpdate(dirSlug, agentIds, skill.registryId || undefined, repo);
  },

  confirmShareReview: async () => {
    const conflict = get().shareConflict;
    if (!conflict) return;
    set({ shareConflict: null });
    await runShareChanges(conflict.dirSlug, true, set, get);
  },

  cancelShareConflict: () => set({ shareConflict: null }),
}));

async function runShareChanges(
  dirSlug: string,
  forceReview: boolean,
  set: (partial: Partial<MySkillsState>) => void,
  get: () => MySkillsState,
) {
  set({ shareBusy: dirSlug, shareDone: null, shareError: null });
  try {
    const registryId = get().list?.find((s) => s.dirSlug === dirSlug)?.registryId;
    const outcome = await skillShareChanges({ dirSlug, registryId, forceReview });
    if (outcome.kind === "remoteChanged") {
      // 别人改过:core 一个字节没动就退回来了,弹拍板而不是报错
      set({ shareConflict: { dirSlug, historyUrl: outcome.historyUrl } });
      return;
    }
    set({ shareDone: { dirSlug, mode: outcome.mode } });
    // 直推成功后 core 已更新记账,「已改动」徽标随刷新消失;
    // 走了评审则记账没动,徽标留着——改动确实还没进库
    await get().load();
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code === "CONFLICT_STALE") {
      // 检测与提交之间被人抢先:语义与冲突档相同,进同一个拍板弹窗
      // (拿不到历史链接,降级为纯文案)
      set({ shareConflict: { dirSlug, historyUrl: null } });
      return;
    }
    set({ shareError: err });
  } finally {
    set({ shareBusy: null });
  }
}

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
 *
 * **v6 任务 4**:早退分支从 `skill.localOnly || skill.unclaimed`(两个字段已删)
 * 改成 `skill.relation === "draft"`——草稿没有来源,同样没有更新去处。
 * `relation === "shared"` 且远端指纹不等时**不再被特殊排除**:它照常计入
 * "有更新",页内(`sharedState` 的 `remoteAhead`/`both`)与侧边栏角标
 * (`updateCount` 逐条走这个函数)因此是同一份判定——`CLAUDE.md` 记的既有铁规。
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
  // 草稿压根没有来源,同理(v6 任务 4)——**显式判掉,不靠"空串恰好对不上 index"碰运气**。
  if (!index || skill.sourceRemoved || skill.libraryRemoved) return false;
  if (skill.relation === "draft") return false;
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

/**
 * 侧边栏角标的计数(M6 任务 3)。
 *
 * **必须逐条走 `hasUpdate`**,不另写一套判定——角标与页内徽标是同一件事的两个说法,
 * 口径一漂就会出现"角标说 3、点进去只有 1"。草稿/来源已移除两档由
 * `hasUpdate` 统一判掉:它们没有更新去处,计进角标就是虚报。
 */
export function updateCount(
  list: InstalledSkillView[] | null | undefined,
  index: Parameters<typeof hasUpdate>[1],
): number {
  if (!list) return 0;
  return list.filter((skill) => hasUpdate(skill, index)).length;
}

export interface MySkillsSection {
  key: "shared" | "installed";
  title: string;
  items: InstalledSkillView[];
}

/**
 * 「我的技能」页的两分区(v6 任务 4,取代此前的三分区)。
 *
 * `relation === "draft"` 归并进「我分享的」——它是"还没分享出去的草稿",
 * 与"库里记的分享者是我"共享同一个心智:这两档都是"这是我的技能",
 * 只是有没有已经进库的区别,分区标题即区分,不需要再拆一档。
 * 空分区被滤掉,调用方不用再判。
 */
export function sections(list: InstalledSkillView[]): MySkillsSection[] {
  const all: MySkillsSection[] = [
    {
      key: "shared",
      title: t("mine.sectionShared"),
      items: list.filter((s) => s.relation === "shared" || s.relation === "draft"),
    },
    {
      key: "installed",
      title: t("mine.sectionInstalled"),
      items: list.filter((s) => s.relation === "installed"),
    },
  ];
  return all.filter((sec) => sec.items.length > 0);
}
