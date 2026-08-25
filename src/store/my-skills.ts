// 「我的技能」页的状态(v6 二期任务 7 重写)。
//
// # 这一页现在只讲三件事:一个技能,三个「在哪」
//
// 这台电脑上(`body`,本体住在哪、永不搬动)/ 各个工具里(`tools`,每个工具一个勾)/
// 技能库里(`relation` + `sharedState` 的状态文案)。
// 「链接」「关联」「修复关联」「收编」「记账」「占位」这些实现层的词整体从产品层消失
// ——它们说的是 app 怎么做到的,而用户要知道的只是东西在不在、能不能用、一不一样。
//
// # 三条链路的去向(与上一版的差异)
//
// - **「修复关联」整个撤销**:它缺的不是按钮,是概念错了——那件事就是"启用到某某
//   工具"这个勾本身。`skill_repair` / `skill_link_agents` 两条 IPC 已在任务 4 删除,
//   自愈落在 `skill_set_agents` 里(再点一次同一个勾就会重新收敛那个位置)。
// - **移除退化成一步**:`skill_remove` 的 `NeedsDecision`(改过本体要二次确认)
//   已在任务 4 删掉——铁律 7 现在靠**可逆**落实(本体进系统废纸篓),不靠多问一遍。
//   确认框拦不住手滑,废纸篓连"程序判断错了"这一档都兜得住。
// - **分享收进这一页**:分享页整页已撤,首次分享变成这一行上的一次确认
//   (`beginShare` → `ShareConfirm` → `confirmShare`),**零编辑**——名称/描述/
//   文件夹名全部只读,不合格的技能连按钮都不摆(判据是 core 给的 `shareBlocked`)。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  installedList,
  isAppError,
  skillKeepVersion,
  skillRemove,
  skillSetAgents,
  skillShare,
  skillShareChanges,
  type AppError,
  type InstalledSkillView,
  type SetAgentsOutcome,
  type ShareMode,
  type SkillVersion,
  type ToolView,
} from "@/lib/ipc";
import { remoteHashOf } from "@/lib/update";
import { defaultSelectedAgents, useInstall } from "@/store/install";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";

export type RemovePhase = "idle" | "confirming" | "busy";

/** 一次「勾选哪些工具」里没能做成的事。`agent` 为 null = 不属于任何一个工具的那一档。 */
export interface ToolFailure {
  agent: string | null;
  message: string;
}

/** 「留哪一份」待拍板。`after` 记着拍完板本来要做什么,拍完接着做,不让用户再点一次。 */
export interface VersionChoice {
  dirSlug: string;
  versions: SkillVersion[];
  after?: "share" | "agents";
  /** `after === "agents"` 时,拍完板要接着落地的那组勾。 */
  agents?: string[];
}

interface MySkillsState {
  /** null = 尚未加载成功。区分于"加载成功但一个都没有"——空状态不能撒谎。 */
  list: InstalledSkillView[] | null;
  loadError: AppError | null;
  loading: boolean;
  /** agent 内部名 → 显示名。界面上不摆 `claude-code` 这种机器标识。 */
  agentNames: Map<string, string>;
  /**
   * 这台电脑上**确实装了**的 AI 工具(R21)。`null` = 探测失败,无从收窄。
   *
   * 勾组要按它过滤,见 {@link visibleTools} 的理由。
   */
  installedAgents: Set<string> | null;

  removePhase: RemovePhase;
  removeTarget: string | null;
  removeError: AppError | null;

  /** 正在落地勾选的技能;界面据此把那一行的勾整体禁用,避免连点打架。 */
  setAgentsBusy: string | null;
  setAgentsError: AppError | null;
  /**
   * 上一次勾选里**没做成的那些**。
   *
   * 🔴 收集了不摆出来,就等于把"报错中断"换成了"静默撒谎":用户看到勾变了、
   * 以为成了,实际那个工具里什么都没发生。所以这个字段一定要有渲染点。
   */
  toolFailures: ToolFailure[] | null;

  /** 「有几个版本,留哪一份」待拍板;null = 没有。 */
  versionChoice: VersionChoice | null;
  keepBusy: boolean;
  keepError: AppError | null;

  /** 分享确认屏的目标;null = 没开。 */
  shareTarget: { dirSlug: string } | null;

  /** 「分享改动」/「分享更新」/「分享」:正在推的技能 / 刚推完的结果 / 错误。 */
  shareBusy: string | null;
  shareDone: { dirSlug: string; mode: ShareMode } | null;
  shareError: AppError | null;
  /**
   * 冲突档(M5 任务 1):库里那一版在获取之后被别人改过,core 一个字节没动就退了回来。
   * 等用户拍板:提交审核 / 先不动。没有「强行覆盖」——覆盖别人的成果不该是一个按钮。
   */
  shareConflict: { dirSlug: string; historyUrl: string | null } | null;

  load: () => Promise<void>;

  askRemove: (dirSlug: string) => void;
  cancelRemove: () => void;
  /** 移除。**只有一步**:本体进系统废纸篓,可逆,所以不再追问第二遍。 */
  confirmRemove: () => Promise<void>;

  /**
   * 「这个技能让哪些工具能用」——一组 checkbox 的落地。
   *
   * `agents` 是**期望的完整名单**(不是增量):core 会把不在名单里的位置停用掉。
   * core 报"有几份内容不同的实体"时转去拍板,拍完接着把这组勾落地。
   */
  setAgents: (dirSlug: string, agents: string[]) => Promise<void>;
  /** 拍板留哪一份。选中的原地留下当本体,其余进废纸篓。 */
  keepVersion: (dirSlug: string, keepPath: string) => Promise<void>;
  cancelVersionChoice: () => void;
  dismissToolFailures: () => void;

  /** 打开分享确认屏(`draft` 与"无基线且与库里不一样"两档的主动作)。 */
  beginShare: (dirSlug: string) => void;
  confirmShare: () => Promise<void>;
  cancelShare: () => void;

  /** 把改过的已装技能推回来源(「我安装的」区块与 `localAhead` 档共用一条编排)。 */
  shareChanges: (dirSlug: string) => Promise<void>;
  shareUpdate: (dirSlug: string) => Promise<void>;

  /**
   * 取回这一版(`notHere`/`remoteAhead`/`both` 的主动作)。
   *
   * 底层复用获取流程的 `beginUpdate`——`both` 时 core 的预检会返回"需要拍板"
   * (`Mine` 档),自然落进全局挂载的 `ConflictDialog`,不需要这里另开一条通道。
   */
  pull: (dirSlug: string) => Promise<void>;

  confirmShareReview: () => Promise<void>;
  cancelShareConflict: () => void;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

/**
 * 勾组要显示哪些工具(R21)。
 *
 * core 给的 `tools` 是**没有按"这台机器上装没装那个工具"过滤过的**——那是刻意的,
 * core 少知道一件事,判定就少一处会漂的地方(见 `my_skills::tools_of` 的文档)。
 * 收窄放在展示层。
 *
 * 🔴 **不收窄的后果是今天每一条存量安装都会中招**:本体住在统一目录时,
 * 共用那个目录的**六个**工具(cline/dexto/kimi-code-cli/loaf/warp/zed)全部
 * 恒亮且不可取消——用户机器上一个都没装,却看到一串没法解释、也点不动的勾。
 *
 * **`body` 档一并收窄,不给豁免**:R21 的动机场景恰恰就是那六个 `body` 勾,
 * 豁免掉它就等于这条规则什么也没做。
 *
 * 探测失败(`installed === null`)时**不收窄**:那时我们没有任何依据说某个工具
 * 不在,藏起来就是拿"不知道"当"没有"。宁可多摆几个,不凭空少摆。
 */
export function visibleTools(tools: ToolView[], installed: Set<string> | null): ToolView[] {
  if (!installed) return tools;
  return tools.filter((tool) => installed.has(tool.agent));
}

/**
 * 从一次 `skill_set_agents` 的结果里把**没做成的事**抠出来。
 *
 * 三个来源缺一不可,少收一个就是一类失败会被静默吞掉:
 * - `results` 里的 `Err`:某个工具没配上;
 * - `unlinkFailed`:某个位置没能停用掉(用户以为取消了,那个工具其实还读得到);
 * - `canonical` 的 `Err`:统一目录那一处没收敛成功。
 *
 * `Ok({kind:"differs"})` **不算失败**:那说明那个位置上有一份内容不同的东西,
 * core 按设计没有动它(绝不静默覆盖)。它会如实回显在下一轮 `tools` 的状态上,
 * 不需要在这里再报一次。
 */
export function collectToolFailures(outcome: SetAgentsOutcome): ToolFailure[] {
  if (outcome.outcome !== "done") return [];
  const out: ToolFailure[] = [];
  if ("Err" in outcome.canonical) out.push({ agent: null, message: outcome.canonical.Err.message });
  for (const [agent, result] of outcome.results) {
    if ("Err" in result) out.push({ agent, message: result.Err.message });
  }
  for (const [agent, error] of outcome.unlinkFailed) {
    out.push({ agent, message: error.message });
  }
  return out;
}

export const useMySkills = create<MySkillsState>((set, get) => ({
  list: null,
  loadError: null,
  loading: false,
  agentNames: new Map(),
  installedAgents: null,
  removePhase: "idle",
  removeTarget: null,
  removeError: null,
  setAgentsBusy: null,
  setAgentsError: null,
  toolFailures: null,
  versionChoice: null,
  keepBusy: false,
  keepError: null,
  shareTarget: null,
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
      set({
        agentNames: new Map(detected.agents.map((a) => [a.name, a.displayName])),
        installedAgents: new Set(
          detected.agents.filter((a) => a.installed).map((a) => a.name),
        ),
      });
    } catch {
      // 拿不到就先用内部名顶着、也不收窄勾组(见 visibleTools):
      // 探测失败不该让整页挂掉,更不该让勾凭空消失
      set({ installedAgents: null });
    }
  },

  askRemove: (dirSlug) =>
    set({ removePhase: "confirming", removeTarget: dirSlug, removeError: null }),

  cancelRemove: () => set({ removePhase: "idle", removeTarget: null, removeError: null }),

  confirmRemove: async () => {
    const { removeTarget } = get();
    if (!removeTarget) return;
    set({ removePhase: "busy", removeError: null });
    try {
      // core 的 RemoveOutcome 只剩「已移除」一档:改过本体的二次确认已撤销,
      // 本体进系统废纸篓所以可逆。这里不再有 needsDecision 分支。
      await skillRemove({ dirSlug: removeTarget });
      set({ removePhase: "idle", removeTarget: null });
      await get().load();
      // 商店卡片的"已启用"状态也要跟上
      await useInstall.getState().refreshInstalled();
    } catch (raw) {
      set({ removePhase: "confirming", removeError: toAppError(raw) });
    }
  },

  setAgents: async (dirSlug, agents) => {
    set({ setAgentsBusy: dirSlug, setAgentsError: null, toolFailures: null });
    try {
      const outcome = await skillSetAgents({ dirSlug, agents });
      if (outcome.outcome === "needsVersionChoice") {
        // 🔴 **口径统一:用这一页 `list` 上的 `versions`,不用 outcome 里的那份**。
        // 两者不对称——后者含内容相同的重复品,前者已经剔掉了。混用会让同一个技能
        // 在"点勾弹出来"和"页面上直接显示"两条路上看到不一样的份数。
        const versions = get().list?.find((s) => s.dirSlug === dirSlug)?.versions ?? [];
        set({ versionChoice: { dirSlug, versions, after: "agents", agents } });
        return;
      }
      const failures = collectToolFailures(outcome);
      set({ toolFailures: failures.length > 0 ? failures : null });
      await get().load();
      await useInstall.getState().refreshInstalled();
    } catch (raw) {
      set({ setAgentsError: toAppError(raw) });
    } finally {
      set({ setAgentsBusy: null });
    }
  },

  keepVersion: async (dirSlug, keepPath) => {
    set({ keepBusy: true, keepError: null });
    try {
      await skillKeepVersion({ dirSlug, keepPath });
      const pending = get().versionChoice;
      set({ versionChoice: null });
      await get().load();
      await useInstall.getState().refreshInstalled();
      // 拍板前本来要做的事,拍完接着做——不让用户再点一次同一个按钮
      if (pending?.after === "agents" && pending.agents) {
        await get().setAgents(dirSlug, pending.agents);
      } else if (pending?.after === "share") {
        get().beginShare(dirSlug);
      }
    } catch (raw) {
      set({ keepError: toAppError(raw) });
    } finally {
      set({ keepBusy: false });
    }
  },

  cancelVersionChoice: () => set({ versionChoice: null, keepError: null }),

  dismissToolFailures: () => set({ toolFailures: null, setAgentsError: null }),

  beginShare: (dirSlug) => {
    set({ shareTarget: { dirSlug }, shareError: null, shareDone: null });
    // 路径预告(直接生效 / 要审核)是**仓库级**的,探一次就够;
    // 探不到就是 unknown,确认屏照常可提交——它只是提示,不是判据。
    void useShare.getState().refreshPreview();
  },

  cancelShare: () => set({ shareTarget: null, shareError: null }),

  confirmShare: async () => {
    const target = get().shareTarget;
    if (!target) return;
    const skill = get().list?.find((s) => s.dirSlug === target.dirSlug);
    set({ shareBusy: target.dirSlug, shareError: null, shareDone: null });
    try {
      // 目标库:账上有来源就用账上的(避免把一个技能的更新推到另一个库去),
      // 没有来源(草稿)才落到确认屏上选中的那个库。
      const repo =
        skill?.sourceOwner && skill.sourceRepo
          ? `${skill.sourceOwner}/${skill.sourceRepo}`
          : (useShare.getState().targetRepo ?? undefined);
      const result = await skillShare({
        dirSlug: target.dirSlug,
        ...(skill?.registryId ? { registryId: skill.registryId } : {}),
        ...(repo ? { repo } : {}),
      });
      set({ shareTarget: null, shareDone: { dirSlug: target.dirSlug, mode: result.mode } });
      // 分享成功后要刷新的不止这一页:商店索引(库里多了一个技能)、
      // 已装记录(商店卡片的按钮档位据它决定)、本页(直推进库的技能会被 core
      // 当场记进账,状态从「尚未分享」变成「已同步」)。
      await get().load();
      void useStoreIndex.getState().load(true);
      void useInstall.getState().refreshInstalled();
    } catch (raw) {
      set({ shareError: toAppError(raw) });
    } finally {
      set({ shareBusy: null });
    }
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
      // 这台电脑从没装过(notHere):账上没有"上次在哪些工具里启用过"可沿用,
      // 退化为按默认规则(已探测到、未在设置里禁用的)勾选——不这样做的话
      // 取回会静默装出一个哪个工具都用不上的技能,等于半成品。
      try {
        const detected = await agentsDetected();
        agentIds = defaultSelectedAgents(detected.agents);
      } catch {
        // 拿不到检测结果就先把本体取回来,之后还能在勾组里补
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
    // 直推成功后 core 已更新记录,「有改动未分享」随刷新消失;
    // 走了评审则记录没动,状态留着——改动确实还没进库
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
  // 草稿压根没有来源,同理——**显式判掉,不靠"空串恰好对不上 index"碰运气**。
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
 * 「本体此刻的内容」与「库里那一版」一不一样(v6 二期任务 7)。
 *
 * 这是**没有安装基线那一档**唯一能问的问题:两方直接比指纹,不需要"安装那一刻
 * 长什么样"这个中间量。`sharedState` 的第 4 档吃它。
 *
 * 🔴 **任一侧指纹缺失一律返回 `null`,不返回 `false` 也不让空串相等冒充 `true`**:
 * `"" === ""` 会把"两边都读不出来"判成"已同步",那是编的。`null` 在
 * `sharedState` 里落进 `differs`——两个动作都摆、不默认谁,是诚实的降级。
 */
export function localEqualsRemote(
  skill: InstalledSkillView,
  index: Parameters<typeof hasUpdate>[1],
): boolean | null {
  if (!index) return null;
  if (
    skill.registryId !== index.registryId ||
    skill.sourceOwner !== index.owner ||
    skill.sourceRepo !== index.repo
  ) {
    return null;
  }
  const remote = remoteHashOf(index, skill.dirSlug);
  if (!remote || !skill.localHash) return null;
  return remote === skill.localHash;
}

/**
 * 侧边栏角标的计数(M6 任务 3)。
 *
 * **必须逐条走 `hasUpdate`**,不另写一套判定——角标与页内状态是同一件事的两个说法,
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
 * 「我的技能」页的两分区(v6 任务 4)。
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
