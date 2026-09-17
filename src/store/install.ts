// 获取流程的前端状态机。
//
// 一次安装的可能走向:
//   idle → choosing(勾 agent) → running → done
//                                   ↓
//                              conflict(等用户拍板) → running → done
//                                   ↓
//                                 error
//
// 冲突那一档是整条流程的重点:core 在发现"用户改过它 / 这台电脑上已有一份不一样的 /
// 同名的有好几份"时**不动磁盘**就返回,前端拿到结论再带着 resolution 重来一次。
//
// 「同名的有好几份」不进 conflict 而是转去 `VersionChooser`——`Resolution` 的两档
// (保留本地 / 用库里的)回答不了"留哪一份";拍完板由 `keepVersion` 自动重来。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  installedList,
  isAppError,
  listenProgress,
  PLAZA_REGISTRY_ID,
  plazaEnsureRepo,
  skillInstall,
  skillSetAgents,
  skillShareChanges,
  type AppError,
  type DetectedAgent,
  type InstallReport,
  type InstallStage,
  type Precheck,
  type Resolution,
  type SkillVersion,
} from "@/lib/ipc";
import type { ShareResultKind } from "@/lib/share-block";
import { useRegistries } from "@/store/registries";
// 🔴 与 `my-skills.ts` 的循环导入(它反过来 `import { useInstall } from "@/store/install"`
// ——`pull`/`confirmRemove`/`setAgents` 都要用到获取流程与已装清单;这一侧则要在
// 没有安装基线时打开分享确认屏,见 `goToSharePage`)。
// (v6 二期任务 7 之前这个环的另一端是 `share.ts`,分享的编排搬进 `my-skills.ts`
// 之后环也跟着搬了家,**性质与约束完全相同**。)
// 现在运行时没事、测试也全绿,前提是**这两个 store 只在函数体内使用,绝不在
// 模块顶层解构**(`import { useMySkills } from ...` 之后直接 `const { load } = useMySkills`
// 那种写法会在其中一侧的模块求值时读到还没初始化完的绑定)。不要重构去消掉这个环
// (牵动一片),但往这两个文件里加新引用前,先确认新代码也遵守"只在函数体内用"这条。
import { useMySkills } from "@/store/my-skills";
import { useOverwrite } from "@/store/overwrite";
import { useUi } from "@/store/ui";


/**
 * 默认勾选哪些 agent:**装了的、且没在设置里被禁用的**。
 *
 * 抽成函数是因为项目级安装(store/project.ts 那条路)也要"沿用全局默认"
 * ——两处各写一份的话口径会悄悄漂移(判定只有一处实现,是本项目反复吃过亏的一条)。
 * 手动勾选不受它约束,它只决定默认值。
 */
export function defaultSelectedAgents(agents: DetectedAgent[]): string[] {
  return agents.filter((a) => a.installed && !a.disabled).map((a) => a.name);
}

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
  /**
   * 走完 `AcquireOutcome::Kept` 的结果:core 什么都没写(不是一次真的安装),
   * `remoteChanged` 原样带出。`null` = 这次「done」不是走的这条路,`DoneFooter` 据此不显示
   * 「已启用/已安装」这类对这一档是假话的完成文案。
   *
   * ⚠️ **名字里的 "mine" 只是它的第一个来路**:v6 二期起 `localDiffers` +
   * 「保留本地的」同样落进这个字段(core 那侧是同一个 `Kept` 出口,
   * `remoteChanged` 恒为 true——"库里那一版与本地这份不同"就是这一档的定义)。
   * 两档共用它是对的:它表达的是"core 一个字节都没写",不是"这是我分享的"。
   * 但**只有 `mine` 那一档会去调 `keepLocalAndShareMine`**——`localDiffers`
   * 走的是 `run("keepLocal")`,到 done 就结束,不接分享。
   *
   * 🔴 `kind` 因此是必要的:两档在装完那一屏上**要说的话不一样**。`mine` 那档
   * 后面还有一段分享结果接着说,`localDiffers` 那档说完就没了——不告诉用户
   * "想让某个工具用它得去哪儿",那一屏就是条死路(与 v5「装完那一屏零操作入口」
   * 那次用户反馈同一个形状)。**别把两句文案合并回一句**。
   */
  mineKept: { remoteChanged: boolean; kind: "mine" | "localDiffers" } | null;
  /** 「保留并分享」的分享结果。null = 没走这条路。 */
  shareResult: { mode: ShareResultKind } | { error: AppError } | null;
  precheck: Precheck | null;
  error: AppError | null;
  /** 已安装技能:商店卡片的状态机数据源。 */
  installed: Map<
    string,
    {
      commitSha: string;
      contentHash: string;
      localModified: boolean;
      /** 来源坐标:判定"是不是同一个技能库"要用(M4 一源多仓)。 */
      registryId: string;
      sourceOwner: string;
      sourceRepo: string;
    }
  >;

  refreshInstalled: () => Promise<void>;
  /** 点"安装"→ 展开 agent 勾选。`registryId` 缺省 = 内建源。 */
  begin: (dirSlug: string, registryId?: string, repo?: string | null) => Promise<void>;
  /**
   * 技能广场的安装编排(M9 任务 5):先幂等挂仓(`plazaEnsureRepo`),拿到挂仓后的
   * `owner/repo` 寻址键,再走既有的 `begin` 全链路——协议与编排层零新代码,
   * 这里只是把"挂仓"这一步接在"选 agent"前面。挂仓失败直接进错误态,不能让用户
   * 先勾完 agent 才发现装不了。
   */
  beginFromPlaza: (ownerRepo: string, dirSlug: string) => Promise<void>;
  /** 「我的技能」页的更新:沿用上次记账的工具与**来源**,不再问一遍。冲突照走 ConflictDialog。 */
  beginUpdate: (dirSlug: string, agentIds: string[], registryId?: string, repo?: string | null) => Promise<void>;
  toggleAgent: (name: string) => void;
  /** 确认安装。`resolution` 只在从冲突弹窗回来时带。 */
  run: (resolution?: Resolution) => Promise<void>;
  /**
   * 「我分享的」冲突弹窗(v6 任务 5)的默认选项:「以本地为准,分享更新」。
   *
   * ⚠️ **v8 任务 6 起这是唯一的"保留并分享"通道**:它的兄弟 `keepLocalAndShare`
   * (改**别人**的技能那一档)已随「贡献更改」整条下线(D7),core 侧
   * `share_installed` 对非本人技能直接拒。
   */
  keepLocalAndShareMine: () => Promise<void>;
  cancel: () => void;

  /** 正在收敛的那个位置(结果面板里逐条「在工具里启用」)。 */
  enablingDir: string | null;
  enableError: AppError | null;
  /**
   * 结果面板里那些没成的位置:再让这个技能在各个工具里启用一次。
   *
   * ⚠️ **没有"替换掉那个位置上的目录"这条路**(v6 二期任务 8 删掉了
   * `retryLink`/`confirmRetry`/`cancelRetry` 与 `RetryLinkDialog`):新模型里
   * 内容不同的位置由 core 报「有几份不一样的」交给用户拍板,一个字节都不覆盖。
   */
  enableInTools: (dir: string) => Promise<void>;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

/** 每次安装一个独立频道,避免上一次的残余进度串到这一次。 */
let taskSeq = 0;

/**
 * 「我分享的」+ 以本地为准,但没有安装基线那一档(v6 任务 3 顾虑 1):
 * `share_installed` 一进门就要求基线存在,走不通,改走「分享」确认屏。
 *
 * ⚠️ **这一处是 v6 二期任务 7 删掉 `PageId."share"` 时被迫改的**(分享页整页撤销)。
 * 原先是"跳分享页 + 预选候选",现在分享是「我的技能」那一行上的一次确认,
 * 所以改成打开确认屏 + 把页面切到「我的技能」(确认屏是全局挂载的模态,
 * 但用户关掉它之后应当落在那个技能所在的页面上,而不是原地不动)。
 * 这条编排的其余部分归任务 8。
 */
function goToSharePage(dirSlug: string) {
  useUi.getState().setPage("mine");
  useMySkills.getState().beginShare(dirSlug);
}

/**
 * `ConflictDialog` 能替用户拍板的那几档——**这份名单就是那个弹窗的分支表**,
 * 两边必须一起改。
 *
 * 刻意逐项列出而不是"排除掉已知的几档":core 将来加一个新的 `Precheck` 变体时,
 * 排除法会把它静默放进弹窗、落到某个说不着的分支上;正列法则让它落进
 * {@link InstallState.run} 里那条"契约对不上"的错误出口,至少有人看得见。
 *
 * 🔴 **这里没有"外来目录"那一档**(v6 二期):「这不是本应用装的」正是本期要消灭
 * 的那句话,core 的 `Precheck::Foreign` 与前端类型里的那个变体都已删除。
 */
function isDecidable(p: Precheck): boolean {
  return (
    p.status === "locallyModified" ||
    p.status === "otherLibrary" ||
    p.status === "mine" ||
    p.status === "localDiffers"
  );
}

/**
 * 把「留哪一份」交给「我的技能」页那个拍板框(全局挂载的 `VersionChooser`)。
 *
 * 🔴 **版本清单取 precheck 带回来的那份,不取 `useMySkills.list` 上的**
 * ——与 `my-skills.ts::setAgents` 里"口径统一:用这一页 list 上的 versions"
 * 那条**刻意不同**,两处注释互相指着对方,别当成疏漏去"统一"掉:
 * 那条路的入口在「我的技能」页,`list` 必然已加载;而获取流程的入口在商店页,
 * `list` 通常是 null,照抄过来就是一个**零选项的空拍板框**。
 * precheck 的这份就是 core `converge::locate` 的候选集,也正是
 * `skill_keep_version` 校验 `keepPath` 用的那一份,选任何一项都合法。
 */
function openVersionChoice(dirSlug: string, versions: SkillVersion[]) {
  useMySkills.setState({
    versionChoice: { dirSlug, versions, after: "install" },
    keepError: null,
  });
}

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
  mineKept: null,
  shareResult: null,
  precheck: null,
  error: null,
  installed: new Map(),

  refreshInstalled: async () => {
    try {
      const list = await installedList();
      set({
        installed: new Map(
          list
            // 🔴 **只有真正有 `state.installed` 记账的行才进这张 map**。
            // `contentHash` 非空就是"有记账基线"这件事的现成判据:`installed_list`
            // 的另外两档(canonical 有本体但没记账 / 只在库里本地没本体)都把
            // commitSha 与 contentHash 一起留空,只有第一档填得出真值。
            //
            // 混进没有记账的行,商店里的同名技能会显示禁用的「已启用」或「已同步」
            // ——那是假话(用户用别的工具装的是他自己那个,不是库里这个),而且
            // 因为按钮是禁用的,他**永远没法从商店获取库里那一版**。真去点获取时
            // core 的预检会认出 canonical 里有目录但没记账并要求拍板,那才是对的路径。
            //
            // ⚠️ 这一条**单独成立,不要再叠 `relation !== "draft"` 或 `localPresent`**:
            // 那两条判的是同一批行(草稿与"只在库里"的行 contentHash 必空),叠上去
            // 就是本项目记的空转模式 ①——多余那道闸会把注入信号整个吞掉。
            .filter((s) => s.contentHash !== "")
            .map((s) => [
            s.dirSlug,
            {
              commitSha: s.commitSha,
              contentHash: s.contentHash,
              localModified: s.localModified,
              // 来源坐标必须带上:少了它,商店切到同源的另一个技能库时,那边的同名
              // 技能会被判成"更新"——而点下去是替换,不是更新(M4 一源多仓)
              registryId: s.registryId,
              sourceOwner: s.sourceOwner,
              sourceRepo: s.sourceRepo,
            },
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
      mineKept: null,
      shareResult: null,
    });
    try {
      const detected = await agentsDetected();
      set({
        agents: detected.agents,
        // 默认全选**已检测到**的(交接包 3.5 任务 9):没装的工具勾上也没意义;
        // 设置页关掉的也不进默认勾选(M2 任务 2),但手动勾选不拦
        selected: new Set(defaultSelectedAgents(detected.agents)),
      });
    } catch (raw) {
      set({ phase: "error", error: toAppError(raw) });
    }
  },

  beginFromPlaza: async (ownerRepo, dirSlug) => {
    set({
      phase: "choosing",
      dirSlug,
      registryId: PLAZA_REGISTRY_ID,
      // 挂仓探测还没回来,先占位——`run()` 靠这个字段拼获取请求,真正装之前必须
      // 已经被下面的挂仓结果覆盖成一个可用的寻址键。AgentChooser 据此在挂仓完成前
      // 禁用「确定」按钮(M9 终审修复):不禁用的话,勾选面板会带着上一次安装
      // 残留的 agents/selected 可点渲染出来,点下去必然报"技能广场没有默认技能库"
      // ——那句错误跟用户刚点的按钮毫无关系。
      repo: null,
      // 同一次修复:上一次安装(哪怕是别的技能)残留的勾选状态不该带进这一次——
      // 不重置的话用户会看到一份不属于这次广场安装的 agent 列表且可能可点确定。
      agents: [],
      selected: new Set(),
      stage: null,
      report: null,
      error: null,
      precheck: null,
      localKept: false,
      mineKept: null,
      shareResult: null,
    });
    try {
      const [detected, repoView] = await Promise.all([agentsDetected(), plazaEnsureRepo(ownerRepo)]);
      set({
        agents: detected.agents,
        selected: new Set(defaultSelectedAgents(detected.agents)),
        repo: repoView.key,
      });
      // 库切换器的"已挂仓子条目"是 §2.4 更新徽标口径落地的关键(设计文档):
      // 挂仓这一刻起这个仓就该在切换器里可见、可切进去按普通库浏览。不等安装
      // 完成才刷新——即便用户随后在 agent 勾选那步取消,仓本身已经真挂上了。
      void useRegistries.getState().load();
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
      mineKept: null,
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
        // core 没动磁盘,等用户拍板。**拍板去哪一屏由这一档的形状决定**:
        const p = result.precheck;
        if (p.status === "needsVersionChoice") {
          // 「留哪一份」不是 `Resolution` 的两档能回答的问题(保留本地 / 用远端
          // 覆盖都答不出"留哪一份"),core 因此无视 resolution 恒退回这一档。
          // 转去 `VersionChooser`,拍完板由 `keepVersion` 自动重来一次安装。
          openVersionChoice(dirSlug, p.versions);
          // 🔴 落 idle 而不是 running/conflict:磁盘零写入,这一刻**没有任何
          // 事情在进行**。停在 running 的话用户关掉拍板框就永远看着「正在安装…」;
          // 停在 conflict 更糟——`ConflictDialog` 的 `open` 要求 precheck 非空,
          // 这里没有可摆的弹窗,底部却按 conflict 画成"安装中",一样是死局。
          // dirSlug/selected/registryId/repo 全部留着:拍完板要凭它们重来一次。
          set({ phase: "idle", stage: null, precheck: null });
          return;
        }
        if (!isDecidable(p)) {
          // 走到这里就是 core 与前端的契约对不上(core 目前只对下面四档退回
          // needsDecision)。**必须有落点**:静默停在 conflict 会让底部永远画成
          // "安装中"而弹窗一个都不弹,用户既看不到原因也没有出口。
          set({ phase: "error", error: { code: "IPC_UNKNOWN_DECISION", message: t("install.undecidable"), detail: p.status } });
          return;
        }
        set({ phase: "conflict", precheck: p });
        return;
      }
      if (result.outcome === "kept") {
        // core 什么都没做(磁盘、账、各工具的启用状态零变化)。落 "done" 是为了让
        // `keepLocalAndShareMine` 能沿用既有的 phase 惯例继续往下走分享,但
        // `report` 留空——`DoneFooter` 必须靠 `mineKept` 认出这一档,不能显示
        // "已启用/已安装"这类对它是假话的完成文案。
        //
        // 🔴 **`kind` 取自触发这次 keepLocal 的那一档**:`Kept` 只有两个来路
        // (`Mine + KeepLocal` / `LocalDiffers + KeepLocal`),而 `precheck` 此刻
        // 正是弹窗那一轮留下的那个,映射是精确的。读不到时落回 `"mine"`
        // ——那一档的文案「未做其他改动」对两边都是真话,兜底不会说假话。
        const kind = get().precheck?.status === "localDiffers" ? "localDiffers" : "mine";
        set({
          phase: "done",
          mineKept: { remoteChanged: result.remoteChanged, kind },
          precheck: null,
        });
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

  keepLocalAndShareMine: async () => {
    await get().run("keepLocal");
    // core 走的是 `AcquireOutcome::Kept`(见 run() 里的处理)才该继续往下分享——
    // 又冲突或出错时 `mineKept` 仍是 null,分享的前提(本地已经站稳)不成立。
    const kept = get().mineKept;
    if (!kept) return;
    const dirSlug = get().dirSlug;
    if (!dirSlug) return;
    await pushMyChanges(dirSlug, false, set, get);
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
      mineKept: null,
      shareResult: null,
      enablingDir: null,
      enableError: null,
    }),

  enablingDir: null,
  enableError: null,

  enableInTools: async (dir) => {
    await runEnable(dir, set, get);
  },
}));

/**
 * 「保留本地并把改动推回去」那一跳(获取冲突弹窗的「保留并分享」)。
 *
 * **v8 任务 4**:`remoteChanged` 是拍板档不是失败——库里那一版与本地基线不符,
 * 推上去会顶掉它,摆覆盖确认屏(点名覆盖谁、什么时候推的、去哪找回);
 * 用户按「仍然覆盖」就带 `overwrite: true` 重跑这同一个函数。
 *
 * 🔴 失败仍写进 `shareResult`(装完那一屏自己的渲染点),满足
 * `useOverwrite` 对 `confirm` 的契约:它自己不设第二处错误状态。
 */
async function pushMyChanges(
  dirSlug: string,
  confirmed: boolean,
  set: (partial: Partial<InstallState>) => void,
  get: () => InstallState,
) {
  try {
    const outcome = await skillShareChanges({
      dirSlug,
      registryId: get().registryId ?? undefined,
      ...(confirmed ? { confirmed: true } : {}),
    });
    if (outcome.kind === "needsConfirm") {
      useOverwrite.getState().ask({
        dirSlug,
        name: dirSlug,
        plan: outcome.plan,
        warning: outcome.overwrite,
        confirm: () => pushMyChanges(dirSlug, true, set, get),
      });
      return;
    }
    if (outcome.kind === "alreadyInSync") {
      set({ shareResult: { mode: "inSync" } });
      await get().refreshInstalled();
      return;
    }
    set({ shareResult: { mode: outcome.mode } });
    await get().refreshInstalled();
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code === "FS_NOT_INSTALLED") {
      // 没有安装基线:`share_installed` 一进门就要求它存在,走不通(v6 任务 3
      // 顾虑 1 记的真问题,典型场景:自己写的技能直接推进了库、或换电脑后重装 app)。
      // 改走「分享」确认屏——它走的是 `skill_share`,不要求基线。
      goToSharePage(dirSlug);
      return;
    }
    set({ shareResult: { error: err } });
  }
}

/**
 * 让这个技能在它期望的整组工具里启用一次(结果面板里那些没成的位置)。
 *
 * `dir` 只用来定位"这一处服务哪些工具"(把结果并回结果面板那一行)与显示忙碌态;
 * 真正发出去的是 `selected` 那份**完整期望名单**——`skill_set_agents` 的契约就是
 * 完整期望态,只传这一处的那几个会把其余位置**停用掉**。
 */
async function runEnable(
  dir: string,
  set: (partial: Partial<InstallState>) => void,
  get: () => InstallState,
) {
  const { dirSlug, report, selected } = get();
  const entry = report?.links.find((l) => l.dir === dir);
  if (!dirSlug || !entry) return;

  set({ enablingDir: dir, enableError: null });
  try {
    const outcome = await skillSetAgents({ dirSlug, agents: [...selected] });
    if (outcome.outcome === "needsVersionChoice") {
      // 这一处有几份内容不同的实体,不是"再启用一次就能好"的事。结果面板没有
      // 拍板界面(那在「我的技能」页),这里如实报出来,不装作已经成了。
      set({ enableError: { code: "FS_NEEDS_VERSION_CHOICE", message: t("install.enableVersions") } });
      return;
    }
    // 只把这条目录上那些 agent 的结局并回去:其余目录的结局是上一次安装的事实,
    // 不该被这次覆盖。任一 agent 失败即这一行仍算失败。
    const failed = outcome.results.find(
      ([agent, r]) => entry.agents.includes(agent) && "Err" in r,
    );
    const merged = get().report;
    if (merged) {
      set({
        report: {
          ...merged,
          links: merged.links.map((l) =>
            l.dir === dir
              ? {
                  ...l,
                  result:
                    failed && "Err" in failed[1]
                      ? { status: "failed" as const, error: failed[1].Err }
                      : { status: "linked" as const, mode: l.result.status === "linked" ? l.result.mode : "symlink" },
                }
              : l,
          ),
        },
      });
    }
    if (failed && "Err" in failed[1]) set({ enableError: failed[1].Err });
    await get().refreshInstalled();
  } catch (raw) {
    set({ enableError: toAppError(raw) });
  } finally {
    set({ enablingDir: null });
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
