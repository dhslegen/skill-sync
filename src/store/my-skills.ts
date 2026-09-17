// 「我的技能」页的状态(v6 二期任务 7 重写;v7 任务 7 三区重画)。
//
// # 这一页现在只讲三件事:一个技能,三个「在哪」
//
// 这台电脑上(`body`,本体住在哪、永不搬动)/ 各个工具里(`tools`,每个工具一个勾)/
// 技能库里(按公司技能库分的三区:安装自 / 已分享到 / 可分享到,见下面的
// `sections`/`rowAction`)。
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
  skillInstallBatch,
  skillKeepVersion,
  skillAlignBaseline,
  skillRemove,
  skillSetAgents,
  skillShare,
  skillShareChanges,
  storeIndex,
  type AppError,
  type BatchItem,
  type InstalledSkillView,
  type Converged,
  type KeepReport,
  type RustResult,
  type Section,
  type SetAgentsOutcome,
  type ShareMode,
  type SkillVersion,
  type StoreIndexView,
  type ToolView,
  type UninstallReport,
} from "@/lib/ipc";
import { rowAction, type RowAction } from "@/lib/ownership";
import type { ShareFlow } from "@/lib/share-block";
import { remoteHashOf } from "@/lib/update";
import { defaultSelectedAgents, useInstall } from "@/store/install";
import { useOverwrite } from "@/store/overwrite";
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
  /**
   * `toolFailures`/`setAgentsError` 归属的那个 `dirSlug`(v7 任务 6 修复轮 2,
   * R19)——这两个字段是**全局**的(`ToolBlocked` 类型里没有 `dirSlug`),此前
   * 只在 `MySkillsPage` 当页面级横幅渲染,语义上勉强成立(页面只有一份、
   * 紧跟用户刚做的动作)。详情面板的 `WhereBlocks`(块 2)把同一份全局状态接了
   * 进来,而它明确针对**某一个** `skill.dirSlug`——不按归属过滤的话,对技能 A
   * 打勾失败后不点「知道了」就去开技能 B 的详情,B 的面板会显示 A 的占用路径,
   * 「打开文件夹」按钮也指向 A 的位置:从"零反馈"变成了"**错误的反馈**"。
   *
   * 只在 `setAgents` 写入失败/错误时记下真实 `dirSlug`;`confirmRemove`/
   * `keepVersion` 写 `toolFailures` 时统一清成 `null`(它们的失败不是"某个工具
   * 勾"的失败,`EachToolBlock` 按设计就不该显示,清空比留一个错误的 dirSlug
   * 更安全——错就错在"不显示",不会错成"显示给错的技能看")。
   */
  toolFailuresFor: string | null;

  /** 「有几个版本,留哪一份」待拍板;null = 没有。 */
  versionChoice: VersionChoice | null;
  keepBusy: boolean;
  keepError: AppError | null;

  /** 分享确认屏的目标;null = 没开。 */
  shareTarget: { dirSlug: string } | null;

  /** 「分享改动」/「分享更新」/「分享」:正在推的技能 / 刚推完的结果 / 错误。 */
  shareBusy: string | null;
  shareDone: { dirSlug: string; mode: ShareMode; flow: ShareFlow } | null;
  /**
   * 分享失败。**带归属**(终审复审轮 1,C-A):形状与 `shareDone` 对称。
   *
   * 🔴 原先是裸 `AppError`,唯一渲染点是 `MySkillsPage` 的页面级横幅——页面只有
   * 一份、紧跟用户刚做的动作,不带归属勉强成立。§12 把「贡献更改」「分享」这些
   * 动作搬进了详情面板的动作区(`SkillActionsBlock`),而那个块明确针对**某一个**
   * `skill.dirSlug`:不带归属的话,对技能 A 分享失败后不关面板去开技能 B 的详情,
   * B 会显示 A 的失败——从"零反馈"变成"错误的反馈",对用户撒谎的是"哪个技能
   * 出了问题"(与 `toolFailuresFor` 修的是同一类,见那个字段的文档)。
   *
   * **刻意做成带 dirSlug 的形状,而不是再加一个平行的 `shareErrorFor` 字段**:
   * 平行字段靠"下一个人记得同步写"维系,而类型逼着每一个写点当场给出归属
   * ——本项目的既有结论是"约定会被下一个人无声打破,类型不会"。
   */
  shareError: { dirSlug: string; error: AppError; flow: ShareFlow } | null;
  /**
   * 「可分享到」区里,有外部来源(GitHub/plaza/自定义源,不是公司库)的行——
   * 它自己那个来源的索引(v7 任务 7)。键是 {@link shareableSourceKey}。
   */
  shareableIndexes: Map<string, StoreIndexView>;
  /**
   * 每个来源(`shareableSourceKey`)**上一次真的发出过请求**的时间戳(ms)。
   *
   * 🔴 **v7 任务 7 修复轮 1(I3,用户拍板)**:最初版本按"每个来源每次会话只取
   * 一次"节流(一个永久的已尝试集合),被现场叫停——`ensureShareableIndexes`
   * 是一条**新增的对外网络行为**,而它挂在 `load()` 里意味着这一页**每次窗口
   * 重获焦点都会触发**(`useLocalRefresh` 的既有机制)。`storeIndex` 即便命中
   * 服务端缓存也要探一次 `branch_head`;缓存未命中时是整个仓的 zipball
   * (CLAUDE.md 实测过 `wshobson/agents` 3.1 MB / 50 s)。按会话节流治标不治本
   * ——挡得住"同一次打开反复刷"，挡不住"这一次打开开一整天"这种长会话里
   * 数据始终陈旧的问题。
   *
   * 现在的模型是**点击立即查 + 每源每小时最多一次的被动兜底**:
   * - `ensureShareableIndexes(forceDirSlugs)` 传了 `forceDirSlugs` 时,那几个
   *   技能对应的来源**无视节流、立即发请求**——这是"用户点了一下"这个动作
   *   本身的信号,克制没有意义;
   * - 不传时是被动扫一遍,**只碰上次请求距今 ≥ 1 小时的来源**
   *   ({@link SHAREABLE_INDEX_STALE_MS})——这条路径接在
   *   `hooks/useLocalRefresh.ts` 的**窗口重获焦点**那一级,不接在 `load()`
   *   本身,所以**翻开这一页这个动作本身不发任何请求**(`load()` 已经不再
   *   调用 `ensureShareableIndexes`)。
   *
   * 节流状态**只存内存,不落盘**:它只是"最近探过没有"这一件事,跨会话没有
   * 保真的必要,重启应用后重新探一遍是可接受的代价(比持久化的复杂度换来的
   * 收益小)。
   */
  shareableIndexesLastFetchedAt: Map<string, number>;
  /**
   * 给 `list` 里「可分享到」且有外部来源的行,去探一次自己来源的索引。
   *
   * @param forceDirSlugs 传了就是"用户点了一下、要这几个技能的来源立即查"
   *   (比如打开了它的详情)——那几个来源无视节流。不传就是被动兜底扫描,
   *   见上面字段文档的完整取舍。
   *
   * 🔴 **单个来源探测失败一律静默降级**:那一行仍然主动作是「分享」,不摆错误
   * 横幅——这是刻意的**漏报不误报**,与 `hasUpdate`/`WhereBlocks` 的
   * `LibraryBlock`"拿不准就不摆"是同一档既定取舍,不是没处理异常。失败同样
   * 盖上时间戳(不是只有成功才算),避免对一个持续连不上的来源反复重试刷屏。
   *
   * 🔴 **绝不顺手挂仓**:plaza 源没挂过的仓,`storeIndex` 会报
   * `REPO_UNKNOWN_REPO`——同样归入静默降级,**不会**去调
   * `plaza_ensure_repo`/`plazaEnsureRepo`。挂仓只属于"用户按下了装"这个动作
   * (`plaza_ensure_repo`/`project_skill_install` 两处,见 `CLAUDE.md`),
   * 翻开「我的技能」页看一眼不该有这个副作用。
   */
  ensureShareableIndexes: (forceDirSlugs?: string[]) => Promise<void>;

  /** 「全部更新」批量结果的正在跑 / 部分失败(v7 任务 7 页头总览)。 */
  updateAllBusy: boolean;
  updateAllError: AppError | null;
  updateAllFailures: { dirSlug: string; message: string }[] | null;
  /**
   * 页头「全部更新」。**只覆盖公司库 index 的 `hasUpdate` 判「有更新」的行**
   * (`rowAction(..).kind === "update"`)——`shareable` 区"外源有新版"的行
   * 也摆着自己的「更新」按钮,但那颗按钮走的是 per-row `pull`,不进这个批量:
   * `skill_install_batch` 一次只收一对 `registryId`/`repo`,`shareable` 行
   * 各自可能来自不同的外部源,批量 IPC 在协议上就表达不出"跨源批量"。
   * 这条分歧写在这里,不是遗漏——页头计数、侧栏角标、这个函数三者故意
   * 用同一个集合(见 `updateCount` 与页面里的 `updatableCount`)。
   */
  updateAll: () => Promise<void>;
  dismissUpdateAllFailures: () => void;

  load: () => Promise<void>;

  /**
   * 已经发过对齐请求的行,键是 {@link alignKey}(库坐标 + 目录名 + 那一刻的实时
   * 指纹)。**判据里带指纹**,所以本体内容真的变了之后还会再试一次,而"同一份
   * 数据反复渲染"不会。
   *
   * 🔴 **必须活在 store(或模块级),不能是组件里的 state**:窗口重获焦点刷新、
   * 5 分钟只读兜底、开发版 StrictMode 的双挂载都会让那个 effect 重跑一遍。
   * 失败的行同样记进来——对一条 core 每次都会拒的行反复重试是纯粹的刷屏。
   * 所以**失败的行不随刷新重试,只在本体内容真的再变一次时重试**(键里带着
   * 那一刻的 `localHash`),或者重启应用——这份记录只存内存、不落盘。
   */
  alignAttempted: Set<string>;
  /**
   * 基线自愈:把「本地与技能库里已经一致、账上的基线却停在旧值」的那些行对齐一次
   * (v8 任务 2,D3)。判定在前端是因为远端指纹在索引里、本体指纹在列表里,
   * 两份数据都只在这一层齐全;core 那边只提供一个带三道守卫的写入口。
   *
   * @param index 当前浏览的公司技能库索引(与 {@link hasUpdate} 同一份)。
   */
  alignStaleBaselines: (index: Parameters<typeof hasUpdate>[1]) => Promise<void>;

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

  /**
   * 取回这一版(`notHere`/`remoteAhead`/`both` 的主动作)。
   *
   * 底层复用获取流程的 `beginUpdate`——`both` 时 core 的预检会返回"需要拍板"
   * (`Mine` 档),自然落进全局挂载的 `ConflictDialog`,不需要这里另开一条通道。
   */
  pull: (dirSlug: string) => Promise<void>;
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

/**
 * 分享这一行,最终会去哪个库——由 **section** 决定,不由"有没有坐标"决定
 * (终审 C-1)。
 *
 * # 🔴 为什么不能按"有没有坐标"分流
 *
 * `shareable` 区(草稿,以及从广场/GitHub/自定义源装来的技能)的
 * `sourceOwner`/`sourceRepo` 说的是**它自己的外部来源**,不是公司技能库
 * ——分享确认屏上写的却恒是「分享到公司技能库」(`mine.shareTitle`)。此前
 * "有坐标就用账上坐标"那支会把这类技能推去它自己的外部源仓:最可能是未登录
 * 报错(GitHub/plaza 与公司库是两套凭证),若登录过就在别人的公开仓开出一个
 * PR——界面说一件事、代码做另一件事。
 *
 * `sharedTo`/`installedFrom` 区(第 1/4 源:公司库的记账或"我分享的但本地
 * 没有")的 `sourceOwner`/`sourceRepo` **就是公司库自己的坐标**,继续信账上
 * 的值——这是 `install.ts::goToSharePage`("我分享的、没有安装基线")那条路
 * 唯一会走到的分支,要避免把一个技能的更新推到另一个库去。
 *
 * # 与 `ShareConfirm.tsx` 共用同一份判定
 *
 * 确认屏上的「分享目标」展示行必须调用**同一个函数**——分开各写一份的话,
 * 界面显示的目标库与实际提交的目标库很容易对不上,是与 C-1 本身同一种缺陷
 * (显示与行为分叉),只是换了个地方。
 *
 * @returns `undefined` = 该源主库(IPC `skill_share` 的缺省值);其余是
 *   `owner/repo` 寻址键。
 */
export function shareTargetRepo(
  skill: Pick<InstalledSkillView, "section" | "sourceOwner" | "sourceRepo"> | undefined,
  chosenRepo: string | null,
): string | undefined {
  if (skill && skill.section !== "shareable" && skill.sourceOwner && skill.sourceRepo) {
    return `${skill.sourceOwner}/${skill.sourceRepo}`;
  }
  return chosenRepo ?? undefined;
}

/** {@link shareTargetRepo} 的 `registryId` 一半:`shareable` 区恒不传
 *  (IPC 缺省内建源),其余区继续信账上的坐标。 */
export function shareTargetRegistryId(
  skill: Pick<InstalledSkillView, "section" | "registryId"> | undefined,
): string | undefined {
  if (skill && skill.section !== "shareable" && skill.registryId) return skill.registryId;
  return undefined;
}

/** 「可分享到」外源索引被动兜底的节流窗口:1 小时(v7 任务 7 修复轮 1,I3)。 */
export const SHAREABLE_INDEX_STALE_MS = 60 * 60 * 1000;

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
  toolFailuresFor: null,
  versionChoice: null,
  keepBusy: false,
  keepError: null,
  shareTarget: null,
  shareBusy: null,
  shareDone: null,
  shareError: null,
  shareableIndexes: new Map(),
  shareableIndexesLastFetchedAt: new Map(),
  updateAllBusy: false,
  updateAllError: null,
  updateAllFailures: null,
  alignAttempted: new Set(),

  alignStaleBaselines: async (index) => {
    const { list, alignAttempted } = get();
    if (!list || !index) return;
    const targets = list.filter(
      (s) => baselineNeedsAlign(s, index) && !alignAttempted.has(alignKey(s)),
    );
    if (targets.length === 0) return;
    // 🔴 先把这一批记进去、再发请求:标记与筛选之间**没有 await**,所以同一帧里
    // 两次调用(StrictMode 双挂载是最容易撞上的一种)第二次会筛出空集合。
    const next = new Set(alignAttempted);
    for (const s of targets) next.add(alignKey(s));
    set({ alignAttempted: next });

    let aligned = false;
    for (const s of targets) {
      try {
        await skillAlignBaseline({
          dirSlug: s.dirSlug,
          // 发**实时**指纹而不是基线:core 拿它与本体此刻的内容比对,这是
          // "你看到的还作不作数"的凭据,不是要写进去的值。
          contentHash: s.localHash,
          registryId: s.registryId,
          owner: s.sourceOwner,
          repo: s.sourceRepo,
        });
        aligned = true;
      } catch {
        // 🔴 刻意静默,**不是忘了处理**:这是自愈,用户没有点任何东西。摆一条
        // 错误横幅等于让他去排查一件自己没做过的事;失败的后果只是这一行维持
        // 原状(与修之前一样),而 core 那侧已经记了一行日志。这条取舍与本项目
        // 「每加一个错误出口都要问它失败时用户在哪看到」并不冲突——这里的答案
        // 是"刻意哪儿都看不到",理由写在这里,别当成漏了渲染点去补。
      }
    }
    // 一行都没成功就不必重读:什么都没变,白跑一趟还会闪一下 loading。
    if (aligned) await get().load();
  },

  load: async () => {
    set({ loading: true, loadError: null });
    try {
      const list = await installedList();
      set({ list, loading: false });
      // 🔴 v7 任务 7 修复轮 1(I3):这里**刻意不再触发**
      // `ensureShareableIndexes`——翻开这一页本身不该产生对外网络请求。
      // 点击触发挂在 `Row` 的 `onOpenDetail`;被动的每小时兜底挂在
      // `hooks/useLocalRefresh.ts` 的窗口重获焦点那一级。两条路都不在这里。
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
    // confirmRemove 的失败不是"某个工具勾"的失败,EachToolBlock 不该显示它
    // ——清成 null 而不是留着上一次 setAgents 可能写下的 dirSlug,防止误配对。
    set({ removePhase: "busy", removeError: null, toolFailures: null, toolFailuresFor: null });
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
    // 🔴 归属在动作一开始就落定(R19):不管这一轮成功还是失败,只要
    // toolFailures/setAgentsError 之后被写入非空值,它们说的都是这个 dirSlug。
    set({ setAgentsBusy: dirSlug, setAgentsError: null, toolFailures: null, toolFailuresFor: dirSlug });
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
    // 同 confirmRemove:keepVersion 的失败按位置报,不是"某个工具勾"的失败,
    // EachToolBlock 不该显示它,清成 null 防止误配对。
    set({ keepBusy: true, keepError: null, toolFailures: null, toolFailuresFor: null });
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

  dismissToolFailures: () =>
    set({ toolFailures: null, setAgentsError: null, toolFailuresFor: null }),

  beginShare: (dirSlug) => {
    set({ shareTarget: { dirSlug }, shareError: null, shareDone: null });
    // 路径预告(能不能直接保存进去)是**仓库级**的,探一次就够;
    // 探不到就是 unknown,确认屏照常可提交——它只是提示,不是判据。
    void useShare.getState().refreshPreview();
  },

  cancelShare: () => set({ shareTarget: null, shareError: null }),

  confirmShare: async () => {
    const target = get().shareTarget;
    if (!target) return;
    await runShare(target.dirSlug, false, set, get);
  },
  shareChanges: async (dirSlug) => {
    // ⚠️ **v8 任务 3**:这里曾经按 `section` 分流——「安装自」那一区的贡献更改
    // 恒带 `forceReview`(那不是我的技能,作者该先看一眼),其余走权限分流。
    // 提交审核整条链路下线之后**只剩一条路**,分流没有了,所以这个函数退化成
    // 一层薄壳。⚠️ **「改别人的技能」这件事本身的出路是 v8 任务 6**(D7:
    // 入口下线,改说「和库里的不一样」+ 联系作者),**不是**在这里悄悄改成直推
    // 别人的技能就完事了——今天它仍然走同一条提交路径,只是不再开合并请求。
    //
    // 🔴 查不到这一行就不发请求(与 `pull` 同款防护,M2 修复轮 1):今天的入口
    // (界面按行渲染按钮)保证 `skill` 存在,这条闸是防将来的调用方(比如批量
    // 入口)传一个不在 `list` 里的 dirSlug ——那种情况下连"要推哪个库"都答不出。
    if (!get().list?.some((s) => s.dirSlug === dirSlug)) return;
    await runShareChanges(dirSlug, set, get);
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

  ensureShareableIndexes: async (forceDirSlugs) => {
    const list = get().list ?? [];
    const lastFetchedAt = get().shareableIndexesLastFetchedAt;
    const now = Date.now();
    const targets = new Map<string, { registryId: string; owner: string; repo: string }>();
    if (forceDirSlugs) {
      // 🔴 修复轮 2:点击触发路径**只查这几个技能自己的来源**,不顺带扫一遍
      // 其余行——这两件事此前用一次"或"判据(`forceKeys.has(key) || stale`)
      // 混在一起,首次点击时全部来源都还没有时间戳、恒 stale,于是"点开一行
      // 详情"会把**所有**外部来源都探一遍,与"只对这一行自己的外部来源发
      // 请求"这句注释的字面意思不符(哪怕仍在每源每小时的预算内)。现在两条
      // 路径各自独立:传了 `forceDirSlugs` 就精确只查这几个,不管其余来源
      // 过没过期。
      for (const slug of forceDirSlugs) {
        const skill = list.find((s) => s.dirSlug === slug);
        const key = skill ? shareableSourceKey(skill) : null;
        if (key && skill) {
          targets.set(key, { registryId: skill.registryId, owner: skill.sourceOwner, repo: skill.sourceRepo });
        }
      }
    } else {
      // 被动兜底(未传参数):扫一遍所有 shareable 行,只碰距上次请求
      // ≥ 1 小时的来源。
      for (const skill of list) {
        const key = shareableSourceKey(skill);
        if (!key) continue;
        const last = lastFetchedAt.get(key);
        const stale = last === undefined || now - last >= SHAREABLE_INDEX_STALE_MS;
        if (stale) {
          targets.set(key, { registryId: skill.registryId, owner: skill.sourceOwner, repo: skill.sourceRepo });
        }
      }
    }
    if (targets.size === 0) return;
    // 先盖时间戳再发请求:并发调用(比如打开详情的同时窗口也重获了焦点)
    // 不会对同一个来源重复发起探测。失败也盖(见字段文档),不是只有成功才算。
    const stamped = new Map(lastFetchedAt);
    for (const key of targets.keys()) stamped.set(key, now);
    set({ shareableIndexesLastFetchedAt: stamped });
    await Promise.all(
      [...targets].map(async ([key, { registryId, owner, repo }]) => {
        try {
          const index = await storeIndex(false, registryId, `${owner}/${repo}`);
          set({ shareableIndexes: new Map(get().shareableIndexes).set(key, index) });
        } catch {
          // 静默降级(见字段文档):这一档"外源有没有新版"答不上来,主按钮仍是
          // 「分享」,不摆错误横幅——宁可漏报,不为一次锦上添花的探测打扰用户。
        }
      }),
    );
  },

  updateAll: async () => {
    const { list } = get();
    const index = useStoreIndex.getState().index;
    if (!list || !index) return;
    const targets = list.filter((s) => rowAction(s, hasUpdate(s, index)).kind === "update");
    if (targets.length === 0) return;
    const dirSlugs = targets.map((s) => s.dirSlug);
    // 批量 IPC 只吃一份统一的 agentIds(BatchAgents::Uniform,core 侧硬编码,
    // 见 skill_install_batch 的实现)——「全部更新」不该趁机悄悄改变某个技能
    // 启用到了哪些工具,所以取这批技能各自已经启用过的工具的**并集**,
    // 不用"这台机器检测到的全部工具"(那是 Wizard 首次安装那一套"全选"语义,
    // 搬到更新动作上会凭空新增关联)。并集意味着某个技能可能因此多出一个
    // 它本来没有的工具(如果同批里另一个技能启用了它)——这是并集写法本身的
    // 已知局限,比"重置成系统全部工具"更接近用户原意,不是完美解。
    const agentIds = [...new Set(targets.flatMap((s) => s.agents))];
    set({ updateAllBusy: true, updateAllError: null, updateAllFailures: null });
    try {
      const results = await skillInstallBatch({
        dirSlugs,
        agentIds,
        registryId: index.registryId,
        repo: `${index.owner}/${index.repo}`,
      });
      const failures = results
        .filter((r): r is BatchItem & { outcome: "failed" } => r.outcome === "failed")
        .map((r) => ({ dirSlug: r.dirSlug, message: r.error.message }));
      set({ updateAllFailures: failures.length > 0 ? failures : null });
      await get().load();
      await useInstall.getState().refreshInstalled();
    } catch (raw) {
      set({ updateAllError: toAppError(raw) });
    } finally {
      set({ updateAllBusy: false });
    }
  },

  dismissUpdateAllFailures: () => set({ updateAllFailures: null, updateAllError: null }),
}));

/**
 * 「贡献更改」/「分享改动」共用的那一跳。
 *
 * **v8 任务 4:「库里那一版与本地基线不符」是一个拍板档,不是失败。**
 * 走 `useOverwrite.ask` 摆覆盖确认屏(点名覆盖谁、什么时候推的、去哪找回),
 * 用户按「仍然覆盖」就带 `overwrite: true` 重跑这同一个函数。
 *
 * 🔴 走 `shareError` 而不是静默返回,是因为本项目记着的「错误被写进状态却没有
 * 渲染点」那条:`shareError` 在「我的技能」页与详情面板动作区都有渲染点,
 * 且带 `dirSlug` 归属校验。静默返回的表现是"点了没反应",而"没反应"会诱发
 * 重复提交。
 */
/**
 * 「分享」那一跳(`skill_share`)。
 *
 * `overwrite` 为真 = 用户已在覆盖确认屏上按过「仍然覆盖」;为假时 core 可能
 * 退回 `needsOverwrite`——**那不是错误**,是"库里已有我的另一版,推上去会顶掉
 * 它",要用户先拍板(v8 任务 4 / 决策 D2)。
 */
async function runShare(
  dirSlug: string,
  overwrite: boolean,
  set: (partial: Partial<MySkillsState>) => void,
  get: () => MySkillsState,
) {
  const skill = get().list?.find((s) => s.dirSlug === dirSlug);
  set({ shareBusy: dirSlug, shareError: null, shareDone: null });
  try {
    // 🔴 目标库按 `section` 分流,而且**确认屏的路径预告与这里调的是同一个
    // 函数**——显示与提交分两处算就会出现"确认屏说推去 A、实际推去 B"。
    const repo = shareTargetRepo(skill, useShare.getState().targetRepo);
    const registryId = shareTargetRegistryId(skill);
    const result = await skillShare({
      dirSlug,
      ...(registryId ? { registryId } : {}),
      ...(repo ? { repo } : {}),
      ...(overwrite ? { overwrite: true } : {}),
    });
    if (result.outcome === "needsOverwrite") {
      // core 一个字节都没动就退回来了。关掉分享确认屏、摆覆盖确认屏。
      set({ shareTarget: null });
      useOverwrite.getState().ask({
        dirSlug,
        // 🔴 点名用**文件夹名**,不去索引里换展示名:文件夹名就是各个 AI 工具
        // 里调用它的那个名字,界面本来就在展示它;而展示名要跨 store 现查一份
        // 索引,等于为一句标题多接一条会失灵的依赖。
        name: dirSlug,
        warning: {
          lastAuthor: result.lastAuthor,
          lastAt: result.lastAt,
          historyUrl: result.historyUrl,
        },
        confirm: () => runShare(dirSlug, true, set, get),
      });
      return;
    }
    set({ shareTarget: null, shareDone: { dirSlug, mode: result.mode, flow: "share" } });
    // 分享成功后要刷新的不止这一页:商店索引(库里多了一个技能)、
    // 已装记录(商店卡片的按钮档位据它决定)、本页(直推进库的技能会被 core
    // 当场记进账,状态从「尚未分享」变成「已同步」)。
    await get().load();
    void useStoreIndex.getState().load(true);
    void useInstall.getState().refreshInstalled();
  } catch (raw) {
    set({ shareError: { dirSlug, error: toAppError(raw), flow: "share" } });
  } finally {
    set({ shareBusy: null });
  }
}

async function runShareChanges(
  dirSlug: string,
  set: (partial: Partial<MySkillsState>) => void,
  get: () => MySkillsState,
  overwrite = false,
) {
  const remoteChangedError = (): AppError => ({
    code: "CONFLICT_REMOTE_CHANGED",
    message: t("mine.shareRemoteChanged"),
  });
  set({ shareBusy: dirSlug, shareDone: null, shareError: null });
  try {
    const skill = get().list?.find((s) => s.dirSlug === dirSlug);
    const registryId = skill?.registryId;
    const outcome = await skillShareChanges({
      dirSlug,
      registryId,
      ...(overwrite ? { overwrite: true } : {}),
    });
    if (outcome.kind === "remoteChanged") {
      // 库里那一版与本地基线不符:core 一个字节没动就退回来了,
      // 摆覆盖确认屏让用户拍板(v8 任务 4),而不是只说一句"没分享成"。
      useOverwrite.getState().ask({
        dirSlug,
        // 🔴 点名用**文件夹名**,不去索引里换展示名:文件夹名就是各个 AI 工具
        // 里调用它的那个名字,界面本来就在展示它;而展示名要跨 store 现查一份
        // 索引,等于为一句标题多接一条会失灵的依赖。
        name: dirSlug,
        warning: {
          lastAuthor: outcome.lastAuthor,
          lastAt: outcome.lastAt,
          historyUrl: outcome.historyUrl,
        },
        confirm: () => runShareChanges(dirSlug, set, get, true),
      });
      return;
    }
    set({ shareDone: { dirSlug, mode: outcome.mode, flow: "changes" } });
    // 直推成功后 core 已更新记录,「有改动未分享」随刷新消失
    await get().load();
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code === "CONFLICT_STALE") {
      // 检测与提交之间被人抢先:语义与上面那一档相同,说同一句话
      set({ shareError: { dirSlug, error: remoteChangedError(), flow: "changes" } });
      return;
    }
    set({ shareError: { dirSlug, error: err, flow: "changes" } });
  } finally {
    set({ shareBusy: null });
  }
}

/** `hasUpdate` 与 `remoteChangedForShareable` 共用的坐标 + 内容指纹比对
 *  ——两者的差别只在"喂哪份索引",判据本身只有这一处实现。 */
function remoteContentDiffers(
  skill: Pick<InstalledSkillView, "registryId" | "sourceOwner" | "sourceRepo" | "dirSlug" | "contentHash">,
  index: { registryId: string; owner: string; repo: string; skills: { dirSlug: string; contentHash: string }[] },
): boolean {
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
 * 🔴 **`relation === "draft"` 恒 `false`**:这个函数比的是**当前浏览的公司
 * 技能库**索引,而 draft(v7 的 `shareable` 区)行的"真正来源"可能是它自己的
 * 外部源——那件事由 {@link remoteChangedForShareable} 另外回答(喂一份不同的
 * 索引,复用同一套 `remoteContentDiffers`,不是重新发明判定)。
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
  return remoteContentDiffers(skill, index);
}

/**
 * 「可分享到」区,有外部来源(不是公司库)的行,它自己那个来源有没有新版
 * (v7 任务 7)。
 *
 * `hasUpdate` 对 `relation === "draft"` 恒返回 `false`——它比的是**当前浏览的
 * 那个公司技能库**索引,而这一档行的"真正来源"是它自己的外部源(GitHub/plaza/
 * 自定义源),不是公司库。这里换一份索引(那个来源自己的,来自
 * {@link MySkillsState.shareableIndexes}),复用同一套 `remoteContentDiffers`,
 * 不重新发明判定。
 *
 * 🔴 拿不到那份索引(还没抓到 / 抓失败 / 没有外部来源)时返回 `false`:
 * 这是刻意的**漏报不误报**,主按钮仍是「分享」、不摆错误横幅——与
 * `hasUpdate`/`WhereBlocks` 的 `LibraryBlock`"拿不准就不摆"是同一档既定取舍。
 */
export function remoteChangedForShareable(
  skill: InstalledSkillView,
  shareableIndexes: Map<string, StoreIndexView>,
): boolean {
  const key = shareableSourceKey(skill);
  if (!key) return false;
  const index = shareableIndexes.get(key);
  if (!index) return false;
  return remoteContentDiffers(skill, index);
}

/**
 * 「本体此刻的内容」与「公司库里那一版」一不一样——**只在没有安装基线时**才有
 * 意义的问法(v7 任务 7 修复轮 1,C3:恢复 v6 二期 `localEqualsRemote` 曾经
 * 回答过的这个问题,那个函数被删的时候没有东西接手它)。
 *
 * # 为什么这一档不能靠 `remoteContentDiffers`/`hasUpdate` 回答
 *
 * `remoteContentDiffers` 比的是 `contentHash`(安装那一刻的基线)与远端指纹
 * ——**核心库对没有 `state.installed` 记账的行恒填 `contentHash: ""`**
 * (作者绕过 app 直接 git 推库,又在本地改了本体,是 v6 立项时的原始动机场景)。
 * 这类行的 `localModified` 也恒是 `false`(core 侧同一个理由),于是
 * `rowAction` 在 `sharedTo`/`installedFrom` 分支里全部落进 `{kind:"none"}`
 * ——库里已经不是本地这一份了,页面却一个字都不说。
 *
 * 这一档不问"谁动过"(没有基线,这件事本来就答不上来),只问"现在是不是
 * 一样"——两方的**实时**指纹直接比:`localHash`(本体现在长什么样)与索引里
 * 的 `contentHash`(库里那一版现在长什么样)。
 *
 * # 只接进「更多」菜单,不接进 `rowAction`(design §8 给的两个选项里选了更轻的那个)
 *
 * `rowAction` 的判定表是 Task 4 已审过的契约,这里不新开一档主按钮
 * ——`MySkillsPage.tsx` 的 `Row` 在算出这个布尔量为真时,往「更多」菜单里加一条
 * 「改用库里的版本」,点击复用**既有的** `pull`(等价 `beginUpdate`):core 的
 * precheck 会把这类"本体与账不一致"的行判成需要拍板的那一档,自然弹出
 * `ConflictDialog` 的"本地被改过"变体——这个函数不需要自己再造一层确认。
 *
 * @param index 与 `hasUpdate` 同一份公司库索引(即便技能属于 `shareable` 区、
 *   走的是 `shareableIndexes`,这个函数目前只服务 `installedFrom`/`sharedTo`
 *   ——`shareable` 区的行 `in_library` 本来就是 `false`,索引里查不到自己,
 *   函数会自然返回 `false`,不需要额外分支)。
 */
export function localDiffersNoBaseline(
  skill: Pick<InstalledSkillView, "registryId" | "sourceOwner" | "sourceRepo" | "dirSlug" | "contentHash" | "localHash" | "sourceRemoved" | "libraryRemoved">,
  index: Parameters<typeof hasUpdate>[1],
): boolean {
  // 有基线的话该信 localModified/remoteChanged——它们分得清"哪边动的",
  // 这个函数只回答分不清的那一半,渗进有基线的行会有反效果(见模块头教训)。
  if (skill.contentHash) return false;
  if (!index || skill.sourceRemoved || skill.libraryRemoved) return false;
  if (
    skill.registryId !== index.registryId ||
    skill.sourceOwner !== index.owner ||
    skill.sourceRepo !== index.repo
  ) {
    return false;
  }
  const remote = remoteHashOf(index, skill.dirSlug);
  // 拿不到任一侧指纹就是"不知道",不能猜——诚实地不摆这一项,不是摆错一项。
  if (!remote || !skill.localHash) return false;
  return remote !== skill.localHash;
}

/**
 * 「这一行的安装基线陈旧了,可以自愈」的判据(v8 任务 2,D3)。
 *
 * # 它在回答什么
 *
 * 基线(`contentHash`)记的是"上一次本地与技能库里确认一致时的指纹",两个方向的
 * 判定都靠它:本地 ≠ 基线 = 我改过;库里 ≠ 基线 = 库里有新版。走「提交审核」的
 * 分享一个字节都不写基线,于是审核合并之后基线仍停在旧值——**本地与库里明明
 * 逐字节相同,行上却永远写着「库里有新版」**,点分享又开一个内容为空的审核请求。
 * 同事真机上卡死的四行就是这个形状(2026-09-16 服务端实证)。
 *
 * 所以判据是三方指纹的一个特定组合:`localHash === remote`(本地与库里已经一致,
 * 这是唯一能确定基线**应该**是多少的时刻)且 `contentHash !== remote`(基线却不是
 * 那个值)。
 *
 * 🔴 **三个量都必须非空**:任一为空就是"不知道",宁可漏报也不能拿一个猜出来的值
 * 去写基线——基线写歪之后"我改过没有"这件事再也发现不了,比不自愈严重得多。
 * `contentHash` 为空还额外意味着**这一行压根没有获取记录**,对齐入口会拒它
 * (绝不凭空建账,那是本项目否决过的「自动补账」)。
 *
 * 坐标判据与 {@link hasUpdate}/{@link localDiffersNoBaseline} 同一套:索引必须是
 * **这条记录自己那个技能库**的,两个库的同名技能是两个东西。
 */
export function baselineNeedsAlign(
  skill: Pick<
    InstalledSkillView,
    "registryId" | "sourceOwner" | "sourceRepo" | "dirSlug" | "contentHash" | "localHash"
  >,
  index: Parameters<typeof hasUpdate>[1],
): boolean {
  if (!index) return false;
  if (
    skill.registryId !== index.registryId ||
    skill.sourceOwner !== index.owner ||
    skill.sourceRepo !== index.repo
  ) {
    return false;
  }
  const remote = remoteHashOf(index, skill.dirSlug);
  if (!remote || !skill.localHash || !skill.contentHash) return false;
  return skill.localHash === remote && skill.contentHash !== remote;
}

/** {@link MySkillsState.alignAttempted} 的键:库坐标 + 目录名 + 那一刻的实时指纹。 */
function alignKey(
  skill: Pick<InstalledSkillView, "registryId" | "sourceOwner" | "sourceRepo" | "dirSlug" | "localHash">,
): string {
  return `${skill.registryId}/${skill.sourceOwner}/${skill.sourceRepo}/${skill.dirSlug}@${skill.localHash}`;
}

/**
 * `shareable` 区里"这一行有没有一个值得去探的外部来源"的判据 + 探测用的键
 * (`{@link MySkillsState.shareableIndexes}` 的键)。
 *
 * 只对 `section === "shareable"` 判;来源已不可用(`sourceRemoved`/
 * `libraryRemoved`)或坐标任一段缺失(纯本地草稿,或 lock 第 3 源来的行
 * `registryId` 是空串)时返回 `null` —— 没有坐标就没有索引可探。
 */
export function shareableSourceKey(
  skill: Pick<
    InstalledSkillView,
    "section" | "registryId" | "sourceOwner" | "sourceRepo" | "sourceRemoved" | "libraryRemoved"
  >,
): string | null {
  if (skill.section !== "shareable") return null;
  if (skill.sourceRemoved || skill.libraryRemoved) return null;
  if (!skill.registryId || !skill.sourceOwner || !skill.sourceRepo) return null;
  return `${skill.registryId}::${skill.sourceOwner}/${skill.sourceRepo}`;
}

/**
 * `shareable` 区、有外部来源的行,从它自己来源的索引里取回展示用的卡片
 * (名字/描述——`InstalledSkillView` 本身没有这两个字段)。取不到就是
 * `null`,调用方按"这一行没有可展示的名字/描述"处理,不编。
 */
export function shareableCardFor(
  skill: InstalledSkillView,
  shareableIndexes: Map<string, StoreIndexView>,
) {
  const key = shareableSourceKey(skill);
  if (!key) return null;
  const index = shareableIndexes.get(key);
  return index?.skills.find((s) => s.dirSlug === skill.dirSlug) ?? null;
}

/**
 * 「这一行的展示卡片(名字/描述/作者/标签)从哪份索引里取」的**唯一实现**
 * (v7.1 任务 3 抽出)。
 *
 * `InstalledSkillView` 上没有 name/description/author/tags——它们全部来自技能库
 * 索引。而"该查哪份索引"分两档:`shareable` 区且有外部来源的行,查它自己来源的
 * 那份({@link shareableCardFor});其余行查**当前浏览的那个库**的索引。
 *
 * 原先这段判定只长在 `MySkillsPage.tsx` 的 `cardOf` 里;v7.1 详情面板的概览行
 * (作者/更新/标签)要问同一个问题,再抄一份就是本项目记录的空转模式 ①
 * ——两份判定漂移了,没有任何测试会发现。
 *
 * 取不到返回 `null`,调用方按"这一列没有可摆的东西"处理(整列不摆),不编。
 */
export function cardFor(
  skill: InstalledSkillView,
  index: StoreIndexView | null | undefined,
  shareableIndexes: Map<string, StoreIndexView>,
) {
  return skill.section === "shareable"
    ? shareableCardFor(skill, shareableIndexes)
    : (index?.skills.find((s) => s.dirSlug === skill.dirSlug) ?? null);
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

// ---------------------------------------------------------------------------
// v7 任务 7:「我的技能」重设计的三区(按公司技能库分:安装自 / 已分享到 /
// 可分享到),取代 v6 任务 4 的两分区(「我分享的」/「我安装的」)。旧实现与
// `MySkillsPage.tsx` 的旧页面一起删除(唯一消费者),这一套顺势改回原名
// `sections`/`MySkillsSection`——任务 4 当时因为占名叫 `librarySections`/
// `LibrarySection`,这里是那条"任务 7 重写整页时顺手改回来"的承诺的执行。
// ---------------------------------------------------------------------------

export interface MySkillsSection {
  key: Section;
  title: string;
  items: InstalledSkillView[];
}

/** 三区固定顺序(design 根决策 #2,用户拍板的理由:"原创必然少于安装;
 *  从商店跳过来的心流是先看装了些啥")。 */
const SECTION_TITLES: { key: Section; title: MessageKey }[] = [
  { key: "installedFrom", title: "mine.sectionInstalledFrom" },
  { key: "sharedTo", title: "mine.sectionSharedTo" },
  { key: "shareable", title: "mine.sectionShareable" },
];

/**
 * 「我的技能」v7 三区(按公司技能库分)。
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
export function sections(
  list: InstalledSkillView[],
  action: (skill: InstalledSkillView) => RowAction,
): MySkillsSection[] {
  const byName = (a: InstalledSkillView, b: InstalledSkillView) =>
    a.dirSlug.localeCompare(b.dirSlug);
  // `action` 每行只算一次,在三个分区之外算好(M4 复审建议):调用方传的 action
  // 很可能是"部分应用了 remoteChanged"的闭包(见 rowAction 文档),原先在每个分区
  // 各自的两个 filter 里各调一次,三区下来一行最多被算两次;算在分区循环*里面*
  // 更划不来(会变成按分区数重算整个 list,不是省事反而更贵)。这里改成对整份
  // list 只算一轮,分区循环只做筛选与排序,不再触碰 action。
  const rows = list.map((skill) => ({ skill, hasAction: action(skill).kind !== "none" }));
  const all: MySkillsSection[] = SECTION_TITLES.map(({ key, title }) => {
    const inSection = rows.filter((r) => r.skill.section === key);
    const withAction = inSection.filter((r) => r.hasAction).sort((a, b) => byName(a.skill, b.skill));
    const rest = inSection.filter((r) => !r.hasAction).sort((a, b) => byName(a.skill, b.skill));
    return { key, title: t(title), items: [...withAction, ...rest].map((r) => r.skill) };
  });
  return all.filter((sec) => sec.items.length > 0);
}

/** 「可分享到技能库」页签里按来源分出来的一组(v7.2 需求 4)。 */
export interface SourceGroup {
  /** React key。有来源就是 `sourceLabel` 本身;无来源那一组固定是空串。 */
  key: string;
  /** 来源展示文案(`ownership::source_label` 归一化后的 `owner/repo` 或域名);
   *  `null` = 这一组的技能没有任何来源记录。 */
  label: string | null;
  items: InstalledSkillView[];
}

/**
 * 把「可分享到技能库」那一区按**来源**分组(v7.2 需求 4:那一区混着本地自建的
 * 草稿、从技能广场/GitHub 装来的、从别的技能库装来的,一列平铺读不出所以然)。
 *
 * # 分组键 = `sourceLabel`
 *
 * 它是 core 侧 `ownership::source_label` 归一化之后的那一句(`owner/repo` 或
 * 域名),已经是"这东西从哪来的"这件事在界面上的唯一说法——再造第二把尺子
 * (比如自己去解析 `sourceUrl`)就是本项目记的"同一条规则查两遍"。
 *
 * # 顺序:无来源在前,其余按 label 排
 *
 * 无来源那一组放最前面,因为它是**用户自己的东西**(本地新建的草稿,以及
 * `converge::set_agents` 建的空来源记账那类存量行)——这一区的主语是"我可以
 * 分享点什么给团队",自己写的排在最前最合理。其余按 `localeCompare` 排,给一个
 * 稳定、可预期的顺序;**组内不重排**,原样保留调用方(`sections()`)已经排好的
 * "有动作的在前、其余按名字"。
 *
 * ⚠️ 无来源那一组**不等于** `relation === "draft"`:空来源的记账(v0.5.0 存量、
 * 或勾工具时 `set_agents` 自建的那种)同样落进来。所以组名按事实起(「没有来源」),
 * 不按归属起。
 */
export function groupBySource(items: InstalledSkillView[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const skill of items) {
    const label = skill.sourceLabel ?? null;
    const key = label ?? "";
    const found = groups.get(key);
    if (found) found.items.push(skill);
    else groups.set(key, { key, label, items: [skill] });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.label === null) return b.label === null ? 0 : -1;
    if (b.label === null) return 1;
    return a.label.localeCompare(b.label);
  });
}
