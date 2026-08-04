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
  skillLinkAgents,
  skillShareChanges,
  type AppError,
  type DetectedAgent,
  type InstallReport,
  type InstallStage,
  type Precheck,
  type Resolution,
  type ShareMode,
} from "@/lib/ipc";

export type InstallPhase = "idle" | "choosing" | "running" | "conflict" | "done" | "error";

interface InstallState {
  phase: InstallPhase;
  /** 正在安装哪个技能(技能库中的目录名)。 */
  dirSlug: string | null;
  /** 装的是哪个源的技能(M3 多源):商店传当前浏览的源,更新传记账的来源。 */
  registryId: string | null;
  /** 装的是哪个仓的技能(M4 一源多仓):寻址键 `owner/repo`,null = 主仓。 */
  repo: string | null;
  agents: DetectedAgent[];
  /** 勾选的 agent name。 */
  selected: Set<string>;
  stage: InstallStage | null;
  report: InstallReport | null;
  /** 本次保留了用户的本地改动。 */
  localKept: boolean;
  /** 「保留并分享」的分享结果。null = 没走这条路。 */
  shareResult: { mode: ShareMode } | { error: AppError } | null;
  precheck: Precheck | null;
  error: AppError | null;
  /** 已安装技能:商店卡片的状态机数据源。 */
  installed: Map<string, { commitSha: string; contentHash: string; localModified: boolean }>;

  refreshInstalled: () => Promise<void>;
  /** 点"安装"→ 展开 agent 勾选。`registryId` 缺省 = 内建源。 */
  begin: (dirSlug: string, registryId?: string, repo?: string | null) => Promise<void>;
  /** 「我的技能」页的更新:沿用上次记账的工具与**来源**,不再问一遍。冲突照走 ConflictDialog。 */
  beginUpdate: (dirSlug: string, agentIds: string[], registryId?: string, repo?: string | null) => Promise<void>;
  toggleAgent: (name: string) => void;
  /** 确认安装。`resolution` 只在从冲突弹窗回来时带。 */
  run: (resolution?: Resolution) => Promise<void>;
  /** 冲突弹窗的默认选项(用户拍板):保留本地改动,随后把改动分享回公司技能库。 */
  keepLocalAndShare: () => Promise<void>;
  cancel: () => void;

  /** 正在重试的目录(结果面板逐条重试)。 */
  retryingDir: string | null;
  /** 需要用户确认替换的占位目录;null = 没有待确认的。 */
  retryConfirmDir: string | null;
  retryError: AppError | null;
  /** 结果面板里逐条重试:补关联到当时没建成的工具。占位一律先问过再动。 */
  retryLink: (dir: string) => Promise<void>;
  confirmRetry: () => Promise<void>;
  cancelRetry: () => void;
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
  registryId: null,
  repo: null,
  agents: [],
  selected: new Set(),
  stage: null,
  report: null,
  localKept: false,
  shareResult: null,
  precheck: null,
  error: null,
  installed: new Map(),

  refreshInstalled: async () => {
    try {
      const list = await installedList();
      set({
        installed: new Map(
          list.map((s) => [
            s.dirSlug,
            { commitSha: s.commitSha, contentHash: s.contentHash, localModified: s.localModified },
          ]),
        ),
      });
    } catch {
      // 读不到已安装列表不该拦住浏览:商店照常显示,只是状态机都停在"安装"这一档
    }
  },

  begin: async (dirSlug, registryId, repo) => {
    set({
      phase: "choosing",
      dirSlug,
      registryId: registryId ?? null,
      repo: repo ?? null,
      stage: null,
      report: null,
      error: null,
      precheck: null,
      localKept: false,
      shareResult: null,
    });
    try {
      const detected = await agentsDetected();
      set({
        agents: detected.agents,
        // 默认全选**已检测到**的(交接包 3.5 任务 9):没装的工具勾上也没意义;
        // 设置页关掉的也不进默认勾选(M2 任务 2),但手动勾选不拦
        selected: new Set(
          detected.agents.filter((a) => a.installed && !a.disabled).map((a) => a.name),
        ),
      });
    } catch (raw) {
      set({ phase: "error", error: toAppError(raw) });
    }
  },

  beginUpdate: async (dirSlug, agentIds, registryId, repo) => {
    set({
      phase: "running",
      dirSlug,
      registryId: registryId ?? null,
      repo: repo ?? null,
      agents: [],
      selected: new Set(agentIds),
      stage: null,
      report: null,
      error: null,
      precheck: null,
      localKept: false,
      shareResult: null,
    });
    await get().run();
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
        registryId: get().registryId ?? undefined,
        repo: get().repo ?? undefined,
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

  keepLocalAndShare: async () => {
    await get().run("keepLocal");
    // 保留那一步没走完(又冲突/出错)就不分享:分享的前提是本地已经站稳
    if (get().phase !== "done") return;
    const dirSlug = get().dirSlug;
    if (!dirSlug) return;
    try {
      const submitted = await skillShareChanges({
        dirSlug,
        registryId: get().registryId ?? undefined,
      });
      set({ shareResult: { mode: submitted.mode } });
      // 直推成功后 core 已把 contentHash 记平,卡片的「已改动」状态要跟上
      await get().refreshInstalled();
    } catch (raw) {
      // 保留已经成功,分享失败只是"下一步没走成"——不能把整个结果画成失败
      set({ shareResult: { error: toAppError(raw) } });
    }
  },

  cancel: () =>
    set({
      phase: "idle",
      dirSlug: null,
      registryId: null,
      repo: null,
      stage: null,
      report: null,
      precheck: null,
      error: null,
      localKept: false,
      shareResult: null,
      retryingDir: null,
      retryConfirmDir: null,
      retryError: null,
    }),

  retryingDir: null,
  retryConfirmDir: null,
  retryError: null,

  retryLink: async (dir) => {
    // 先按"不替换"试一次:断链/丢失这类形态直接就修好了,不该多问一句。
    // 只有确实撞上实体目录占位(FS_LINK_OCCUPIED)才升级成确认弹窗——
    // 那个目录可能是用户自己的技能,替换等于删他的文件(铁律 7)。
    await runRetry(dir, false, set, get);
    if (get().retryError?.code === "FS_LINK_OCCUPIED") {
      set({ retryConfirmDir: dir, retryError: null });
    }
  },

  confirmRetry: async () => {
    const dir = get().retryConfirmDir;
    if (!dir) return;
    set({ retryConfirmDir: null });
    await runRetry(dir, true, set, get);
  },

  cancelRetry: () => set({ retryConfirmDir: null, retryError: null }),
}));

/**
 * 重试一个目录的关联。
 *
 * 目录 → agent 的映射取自本次的 report:core 的建链是**按目录**做的,一个目录可能
 * 服务多个 agent(6 个工具共用 canonical 是常态),所以重试要把这条目录上的
 * agents 整组带上,不能只挑一个。
 */
async function runRetry(
  dir: string,
  replaceOccupied: boolean,
  set: (partial: Partial<InstallState>) => void,
  get: () => InstallState,
) {
  const { dirSlug, report } = get();
  const entry = report?.links.find((l) => l.dir === dir);
  if (!dirSlug || !entry) return;

  set({ retryingDir: dir, retryError: null });
  try {
    const next = await skillLinkAgents({
      dirSlug,
      agentIds: entry.agents,
      replaceOccupied,
    });
    // 只把这条目录的结果并回去:其余目录的结局是上一次安装的事实,不该被这次覆盖
    const merged = get().report;
    if (merged) {
      const updated = next.links.find((l) => l.dir === dir);
      set({
        report: {
          ...merged,
          links: merged.links.map((l) => (l.dir === dir && updated ? updated : l)),
        },
      });
    }
    const failure = next.links.find((l) => l.dir === dir && l.result.status === "failed");
    if (failure && failure.result.status === "failed") {
      set({ retryError: failure.result.error });
    }
    await get().refreshInstalled();
  } catch (raw) {
    set({ retryError: toAppError(raw) });
  } finally {
    set({ retryingDir: null });
  }
}

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
