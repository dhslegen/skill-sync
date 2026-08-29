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
//   文件夹名全部只读。不合格的技能(判据是 core 给的 `shareBlocked`)**照常显示,
//   但三颗分享按钮一律禁用**,行上摆一句人话说清哪不合格,出口是既有的
//   「打开文件夹」(A-5)。⚠️ 这段话此前写的是"连按钮都不摆",而 `Row` 从头到尾
//   没读过那个字段——**注释说谎的那个版本正是终审 C-3 的现场**,别把它抄回来。
import { create } from "zustand";

import { t, type MessageKey } from "@/i18n";
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
  type Converged,
  type KeepReport,
  type RustResult,
  type Section,
  type SetAgentsOutcome,
  type ShareMode,
  type SkillVersion,
  type ToolView,
  type UninstallReport,
} from "@/lib/ipc";
import { rowAction, type RowAction } from "@/lib/ownership";
import { remoteHashOf } from "@/lib/update";
import { defaultSelectedAgents, useInstall } from "@/store/install";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";

export type RemovePhase = "idle" | "confirming" | "busy";

/**
 * 一次「勾选哪些工具」里没能如愿的事。`agent` 为 null = 不属于任何一个工具的那一档。
 *
 * **刻意写成可辨联合(discriminated union),不是"一个结构 + 一个 kind 标记"**:
 * 两档携带的东西根本不同,而其中一档带的是**不能给用户看的内部值**。
 *
 * - `failed`:真的失败了(`Err`)——`message` 是 core 给的**用户可读中文**,照摆即可;
 * - `differs`:core **停下来问你**(`Ok(Differs)`)——那个位置上已经有一份内容不同的
 *   东西,core 按铁律 7 绝不覆盖。它携带的 `existing` 是一条**原始文件系统路径**,
 *   属于内部标识,**不是用来直接渲染给用户的**(这个项目连撞过两次:安装结果里
 *   露出内部目录名、冲突弹窗标题用了内部标识)。它只有两个正当用途:
 *   拼「打开文件夹」的目标,以及在错误详情里做佐证。
 * - `location`:**按位置报的失败**(「留哪一份」与「移除」两条路)。它与前两档的
 *   差别在于**没有 agent 可说**:落选版本住在哪、解链失败的是哪个位置,core 给的
 *   都是一条文件系统路径,而那条路径**就是这一条的全部信息量**——不摆它,用户
 *   只会看到"有 1 处没能完成"却不知道是哪一处。这与 `VersionChooser` 用等宽字体
 *   直接摆版本路径是同一个取舍:此处路径不是内部标识,是用户唯一能据以行动的东西。
 *
 * 🔴 写成联合之后,`differs` 那一档**根本没有 `message` 这个字段**——
 * 将来谁想"顺手渲染 `message`",tsc 会当场拦下,而不是等到用户看见一条裸路径。
 * 这比"约定不填"强:约定会被下一个人无声地打破。
 */
export type ToolBlocked =
  | { kind: "failed"; agent: string | null; message: string }
  | { kind: "differs"; agent: string | null; existing: string }
  | { kind: "location"; path: string; message: string };

/**
 * 「留哪一份」待拍板。`after` 记着拍完板本来要做什么,拍完接着做,不让用户再点一次。
 *
 * `"install"` 那一档由**获取流程**置上(`store/install.ts::run` 收到
 * `Precheck.needsVersionChoice` 时),拍完板回到那条路重来一次安装。
 */
export interface VersionChoice {
  dirSlug: string;
  versions: SkillVersion[];
  after?: "share" | "agents" | "install";
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
  /**
   * 统一技能目录的绝对路径(`agents_detected` 的 `canonicalDir`)。
   *
   * 详情面板「这台电脑上」那句话(`bodyLocationText`)靠它判断本体是不是住在
   * 这个位置——**不按目录反查 agent**(那正是"Zed 本体在这里"那个真实缺陷的
   * 根因:6 个 agent 的全局目录恰好都是这里,反查会随机点名其中一个)。
   * 探测失败或还没加载完时是空串,`bodyLocationText` 对空串一律不命中,
   * 落进"这台电脑上"那句中性兜底话,不撒谎。
   */
  canonicalDir: string;
  /**
   * agent 内部名 → 该 agent 的全局技能目录(`agents_detected` 全量给出,
   * **不按"这台机器装没装"过滤**——本体是否住在某个工具专属目录,是一句
   * 路径事实,与这台机器探测不探测得到那个工具无关)。
   */
  toolDirs: Map<string, string>;

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
  toolFailures: ToolBlocked[] | null;

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
 * 从一次 `skill_set_agents` 的结果里把**没能如愿的事**抠出来。
 *
 * 四个来源缺一不可,少收一个就是一类结果会被静默吞掉:
 * - `results` 里的 `Err`:某个工具没配上;
 * - `results` 里的 `Ok(Differs)`:见下,**这一档最险**;
 * - `unlinkFailed`:某个位置没能停用掉(用户以为取消了,那个工具其实还读得到);
 * - `canonical` 的 `Err` / `Ok(Differs)`:统一目录那一处。
 *
 * # 🔴 `Ok(Differs)` 必须收,不能靠"下一轮 tools 会回显"
 *
 * 修复轮 2 之前这里把 `Differs` 排除在外,理由是"core 按设计没动它,下一轮
 * `tools` 会如实回显那个位置的状态"。**顺着这一跳查进 core,那个理由是错的**:
 * `converge::merge_link_record` 对 `Differs` **直接 return、不写任何记录**,
 * 于是 `my_skills::tools_of` 算出来是 `Off` —— 用户看到的是**勾自己弹了回去,
 * 零错误、零提示**。他再点一次,还是一样。**那是一条永久死路。**
 *
 * 所以 `Differs` 进清单,但 `kind` 与真正的 `Err` 分开:它不是"没做成",
 * 是"**停下来问你**"——那个位置上已经有一份内容不同的东西,core 绝不覆盖
 * (铁律 7)。界面据此说不同的话,并摆一个「打开文件夹」让用户去看看那是什么。
 */
export function collectToolFailures(outcome: SetAgentsOutcome): ToolBlocked[] {
  if (outcome.outcome !== "done") return [];
  const out: ToolBlocked[] = [];
  const classify = (agent: string | null, r: RustResult<Converged>): ToolBlocked | null => {
    if ("Err" in r) return { kind: "failed", agent, message: r.Err.message };
    if (r.Ok.kind === "differs") return { kind: "differs", agent, existing: r.Ok.existing };
    return null;
  };
  const canonical = classify(null, outcome.canonical);
  if (canonical) out.push(canonical);
  for (const [agent, result] of outcome.results) {
    const hit = classify(agent, result);
    if (hit) out.push(hit);
  }
  for (const [agent, error] of outcome.unlinkFailed) {
    out.push({ kind: "failed", agent, message: error.message });
  }
  return out;
}

/**
 * 从一次「留哪一份」的结果里把**没能如愿的事**抠出来(终审 C-1)。
 *
 * # 🔴 为什么这个函数必须存在
 *
 * `core::converge::keep_version` 花了三轮修复才从"遇错即中断"改成"失败一律收集
 * 进返回值,**由界面如实回报**"——而界面那一半此前从来没做:`keepVersion` 把
 * `KeepReport` 整个丢掉了,函数照常 resolve,`catch` 永不触发。
 *
 * 后果是一条**零反馈的死循环**:macOS 上废纸篓走 Finder 的自动化授权,被拒时
 * `trash_tree` 返回 `Err`,落选版本原样留着 → 刷新后 `versions` 仍是 2 →
 * 那一行又回到「有几个版本」→ 用户再点再失败,全程一个字都没有。
 *
 * # 三个出口的映射
 *
 * - `links` 的 `Err`(落选版本没能进废纸篓 / 没能摘链 / 没能建链)→ `location`:
 *   它的 `String` 键是**版本目录的绝对路径**,不是 agent 名,没有工具名可说;
 * - `links` 的 `Ok(differs)` —— 今天**不可达**(那个循环里只可能产出
 *   `Linked`/`SameLocation`/`Err`),但类型允许,所以兜底也走 `location` 并带上
 *   路径。**刻意不映到 `agent:null`**:那一档在界面上会被说成「统一技能目录」,
 *   而这里说的根本是另一个位置——宁可少说一个词,不能说错一个位置;
 * - `canonical` 的 `Err` / `Ok(differs)` → 与 `collectToolFailures` 完全同款
 *   (`agent: null` 就是"统一技能目录那一处"),两处共用同一套渲染。
 */
export function collectKeepFailures(report: KeepReport): ToolBlocked[] {
  const out: ToolBlocked[] = [];
  for (const [path, result] of report.links) {
    if ("Err" in result) {
      out.push({ kind: "location", path, message: result.Err.message });
    } else if (result.Ok.kind === "differs") {
      // ⚠️ 今天不可达:`keep_version` 的循环只产出 Linked / SameLocation / Err,
      // 这一档只是类型上的兜底(`Result<Converged,_>` 不兜就得在前端断言"不可能")。
      // 它没有测试覆盖,而且因为 kind 是 "location",标题会把它算进「没能完成」
      // 而不是「需要你看一下」——接受。哪天 core 真产出它,先补测试再决定映成哪档。
      out.push({ kind: "location", path, message: t("mine.locationOccupied") });
    }
  }
  if ("Err" in report.canonical) {
    out.push({ kind: "failed", agent: null, message: report.canonical.Err.message });
  } else if (report.canonical.Ok.kind === "differs") {
    out.push({ kind: "differs", agent: null, existing: report.canonical.Ok.existing });
  }
  return out;
}

/**
 * 从一次移除的结果里把**没能解除的位置**抠出来(终审 I-1)。
 *
 * core 的注释写着「认不出 mode 的记账不猜着删,但也不能不吭声:并进报告让界面
 * 逐条说明」,而 `installer.uninstall` 自身返回 `Ok`、`remove` 随后**无条件**清账
 * ——界面此前把整份报告丢掉,于是:某个工具目录里留着一条悬空链接,而记账已删、
 * 本体已进废纸篓、那一行从「我的技能」上消失,**app 里再没有任何入口能驱动重试**。
 * v5 的项目级移除早就立过这条规矩:「没删掉的东西要如实回报」。
 *
 * 只收 `failed` 与 `skipped` 两档:`unlinked`(解除成功)与 `missing`(那里本来
 * 就没有东西)都是如愿的结果,摆出来是噪音。
 */
export function collectRemoveFailures(report: UninstallReport): ToolBlocked[] {
  const out: ToolBlocked[] = [];
  for (const { dir, result } of report.unlinks) {
    if (result.status === "failed") {
      out.push({ kind: "location", path: dir, message: result.error.message });
    } else if (result.status === "skipped") {
      out.push({ kind: "location", path: dir, message: result.reason });
    }
  }
  return out;
}

export const useMySkills = create<MySkillsState>((set, get) => ({
  list: null,
  loadError: null,
  loading: false,
  agentNames: new Map(),
  installedAgents: null,
  canonicalDir: "",
  toolDirs: new Map(),
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
        canonicalDir: detected.canonicalDir ?? "",
        toolDirs: new Map(
          detected.agents
            .filter((a): a is typeof a & { globalSkillsDir: string } => !!a.globalSkillsDir)
            .map((a) => [a.name, a.globalSkillsDir]),
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
    set({ removePhase: "busy", removeError: null, toolFailures: null });
    try {
      // core 的 RemoveOutcome 只剩「已移除」一档:改过本体的二次确认已撤销,
      // 本体进系统废纸篓所以可逆。这里不再有 needsDecision 分支。
      const outcome = await skillRemove({ dirSlug: removeTarget });
      // 🔴 **`unlinks` 必须摆出来**(终审 I-1):`installer.uninstall` 对解不掉的
      // 位置返回 `Failed`/`Skipped` 而**自身照常 `Ok`**,`remove` 随后无条件清账。
      // 丢掉它的后果是:某个工具目录里留着一条悬空链接,而账已清、本体已进废纸篓、
      // 那一行从这一页消失——app 里再没有任何入口能驱动一次重试,用户还全程被
      // 告知"已移除"。v5 的项目级移除早就立过这条:「没删掉的东西要如实回报」。
      const failures = collectRemoveFailures(outcome.report);
      set({
        removePhase: "idle",
        removeTarget: null,
        toolFailures: failures.length > 0 ? failures : null,
      });
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
        //
        // ⚠️ **这条只对这一页成立,别推广**:获取流程那条路
        // (`store/install.ts::openVersionChoice`)刻意用 precheck 带回来的那份
        // ——它的入口在商店页,`list` 通常还是 null,照抄这里就是一个零选项的
        // 空拍板框。两处注释互相指着对方,别当成疏漏"统一"掉。
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
    set({ keepBusy: true, keepError: null, toolFailures: null });
    try {
      const report = await skillKeepVersion({ dirSlug, keepPath });
      const pending = get().versionChoice;
      // 🔴 **`keep_version` 失败时照常 resolve**(core 把三类失败逐条收集进
      // `KeepReport`,函数本身返回 `Ok`)——所以下面这行是这条路唯一的错误出口,
      // `catch` 分支根本轮不到它。丢掉它就是终审 C-1 那条零反馈死循环。
      const failures = collectKeepFailures(report);
      set({ versionChoice: null, toolFailures: failures.length > 0 ? failures : null });
      await get().load();
      await useInstall.getState().refreshInstalled();
      // 🔴 **有失败就到此为止,不走 `after` 链**。两条理由,任一条都足够:
      // ① `after` 链的第一步 `setAgents` 开头就是 `toolFailures: null`,接着跑
      //    等于**在修复 C-1 的代码里把 C-1 重演一遍**——刚摆出来的失败被自己人清掉;
      // ② `after` 的前提是"分歧已经收敛",而失败恰恰意味着它没有:落选版本还在
      //    原地,再跑一次 `setAgents`/`run()` 只会又被顶回「有几个版本」——
      //    死循环换了个壳。
      if (failures.length > 0) return;
      // 拍板前本来要做的事,拍完接着做——不让用户再点一次同一个按钮
      if (pending?.after === "agents" && pending.agents) {
        await get().setAgents(dirSlug, pending.agents);
      } else if (pending?.after === "share") {
        get().beginShare(dirSlug);
      } else if (pending?.after === "install") {
        // 获取流程被"有好几份不一样的"顶回来过一次。分歧已经收敛,重来一次即可
        // ——`run()` 用的 dirSlug/勾选/来源坐标都还在 install store 里留着
        // (那条路刻意只把 phase 落回 idle,没有 `cancel()` 清掉它们)。
        await useInstall.getState().run();
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
    // 🔴 v7:「安装自」那一区的贡献更改一律走提交审核,不看权限矩阵
    // ——那不是我的技能,即便我有直推权限,作者也该先看一眼。「已分享到」
    // 那一区不强制,走正常的权限分流(与既有回推权限矩阵一致)。
    const skill = get().list?.find((s) => s.dirSlug === dirSlug);
    // 🔴 查不到这一行就不发请求(与 `pull` 同款防护,M2 修复轮 1):
    // "恒走评审"是这个函数唯一要守住的安全属性,`skill` 缺席时
    // `skill?.section === "installedFrom"` 会静默落回 `false`,让理论上不该
    // 发生的异常路径悄悄绕过它。今天的入口(界面按行渲染按钮)保证 `skill` 存在,
    // 这条闸是防将来的调用方(比如批量入口)传一个不在 `list` 里的 dirSlug。
    if (!skill) return;
    const forceReview = skill.section === "installedFrom";
    await runShareChanges(dirSlug, forceReview, set, get);
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
 * 侧边栏角标的计数(M6 任务 3;v7 改按 `rowAction` 重新定义)。
 *
 * 🔴 **v7 起不再是"逐条走 `hasUpdate`"**:v6 的两分区页只有"有没有更新"这一个
 * 问题要回答,`hasUpdate` 恰好就是答案;v7 三区页里,`remoteChanged` 为真时
 * 主按钮可能是「更新」,也可能是「库里有新版…」三选一冲突框(`installedFrom`
 * 本地也改过、或 `sharedTo` 库被别人改过)——角标说的是「全部更新」那颗批量
 * 按钮能一键处理几条(见任务 7 的页头总览),冲突行需要用户拍板,不在其列,
 * 计进角标就是"角标说 3、点了「全部更新」只处理了 1"的重演。
 *
 * 所以这里改成:先用 `hasUpdate` 算出 `remoteChanged`(逐技能比内容指纹、
 * 比到技能库这套既有判据完全不变,草稿/来源已移除两档仍由它统一判掉),
 * 再喂给 `rowAction` 求出这一行**此刻的主按钮**,只数 `kind === "update"` 的行。
 */
export function updateCount(
  list: InstalledSkillView[] | null | undefined,
  index: Parameters<typeof hasUpdate>[1],
): number {
  if (!list) return 0;
  return list.filter((skill) => rowAction(skill, hasUpdate(skill, index)).kind === "update")
    .length;
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

// ---------------------------------------------------------------------------
// v7:「我的技能」重设计的三区(按公司技能库分:安装自 / 已分享到 / 可分享到)。
//
// 🔴 **按 R1 裁定,本任务不删上面的两分区 `sections`/`MySkillsSection`**
// ——`MySkillsPage.tsx:306` 至今仍在调用它(v6 二期的旧页面)。两套实现同名会撞,
// 所以新的这一套改叫 `librarySections`/`LibrarySection`,任务 7 重写整页时把
// 旧的删掉、把这一套的调用方接上、也可以顺手把名字改回 brief 给的
// `sections`/`MySkillsSection`(那时旧实现的唯一消费者已经不存在了)。
// ---------------------------------------------------------------------------

export interface LibrarySection {
  key: Section;
  title: string;
  items: InstalledSkillView[];
}

/** 三区固定顺序(design 根决策 #2,用户拍板的理由:"原创必然少于安装;
 *  从商店跳过来的心流是先看装了些啥")。 */
const LIBRARY_SECTION_TITLES: { key: Section; title: MessageKey }[] = [
  { key: "installedFrom", title: "mine.sectionInstalledFrom" },
  { key: "sharedTo", title: "mine.sectionSharedTo" },
  { key: "shareable", title: "mine.sectionShareable" },
];

/**
 * 「我的技能」v7 三区(按公司技能库分,取代上面的两分区)。
 *
 * 顺序固定:安装自 → 已分享到 → 可分享到,空区不出现(调用方不用再判)。
 *
 * `action` 由调用方传入(通常就是 {@link rowAction} 部分应用了 `remoteChanged`
 * 之后的结果)——这个函数本身不算"库里新不新",只管分区与排序,与
 * `rowAction` 判定表分工明确、不重叠。
 *
 * 区内排序:**有主按钮的行置顶,其余按名字**(design 根决策 #9)。两组各自都
 * 按 `dirSlug` 字典序稳定排序(brief 给的例子只覆盖了"其余"那一组内部要按名字
 * 排,但"置顶"那一组若不给出一个确定顺序,同一份数据在两次渲染之间就可能跳动
 * ——用同一把尺子排序,而不是留一个未定义的相对顺序)。
 */
export function librarySections(
  list: InstalledSkillView[],
  action: (skill: InstalledSkillView) => RowAction,
): LibrarySection[] {
  const byName = (a: InstalledSkillView, b: InstalledSkillView) =>
    a.dirSlug.localeCompare(b.dirSlug);
  // `action` 每行只算一次,在三个分区之外算好(M4 复审建议):任务 7 传的 action
  // 很可能是"部分应用了 remoteChanged"的闭包(见 rowAction 文档),原先在每个分区
  // 各自的两个 filter 里各调一次,三区下来一行最多被算两次;算在分区循环*里面*
  // 更划不来(会变成按分区数重算整个 list,不是省事反而更贵)。这里改成对整份
  // list 只算一轮,分区循环只做筛选与排序,不再触碰 action。
  const rows = list.map((skill) => ({ skill, hasAction: action(skill).kind !== "none" }));
  const all: LibrarySection[] = LIBRARY_SECTION_TITLES.map(({ key, title }) => {
    const inSection = rows.filter((r) => r.skill.section === key);
    const withAction = inSection.filter((r) => r.hasAction).sort((a, b) => byName(a.skill, b.skill));
    const rest = inSection.filter((r) => !r.hasAction).sort((a, b) => byName(a.skill, b.skill));
    return { key, title: t(title), items: [...withAction, ...rest].map((r) => r.skill) };
  });
  return all.filter((sec) => sec.items.length > 0);
}
