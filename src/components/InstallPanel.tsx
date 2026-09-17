import { useEffect, type ReactNode } from "react";
import { Check, TriangleAlert } from "lucide-react";

import { Icon } from "@/components/Icon";
import { InstallButton } from "@/components/InstallButton";
import { InstallScopeMenu } from "@/components/InstallScopeMenu";
import { ToolPicker, type ToolPickerItem } from "@/components/ToolPicker";
import { t, type MessageKey } from "@/i18n";
import { failedLinks, linkedAgents, useInstall } from "@/store/install";
import { cn } from "@/lib/cn";
import { PLAZA_REGISTRY_ID, type InstallStage, type ToolState } from "@/lib/ipc";
import { cardState, localProbeOf, remoteHashOf, type LibraryRef } from "@/lib/update";
import { useLocalDetail } from "@/store/local-detail";
import { useMySkills } from "@/store/my-skills";
import { groupProjectTools } from "@/lib/project-tools";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/** `owner/repo` → 广场坐标下的 `LibraryRef`。广场技能永远走固定的 `plaza` 源。 */
function ownerRepoToLibrary(ownerRepo: string): LibraryRef {
  const [owner, repo] = ownerRepo.split("/");
  return { registryId: PLAZA_REGISTRY_ID, owner: owner ?? "", repo: repo ?? "" };
}

const STAGE_LABEL: Record<InstallStage, MessageKey> = {
  fetching: "install.stageFetching",
  checking: "install.stageChecking",
  writing: "install.stageWriting",
  linking: "install.stageLinking",
  recording: "install.stageRecording",
  done: "install.stageDone",
};

/**
 * 详情面板底部的获取区,**也是商店/广场详情面板唯一的一层页脚容器**
 * (Q44-A,v7.6 任务 2)。
 *
 * agent 多选做成**行内展开**而不是弹窗:面板本身已经是一层浮层,再叠一个模态
 * 在桌面应用里既挡视线又难退出。冲突那一档才用弹窗——它是必须打断的决策。
 *
 * # 🔴 `actions`:`SkillActionsBlock`(host="store")的并入点
 *
 * 此前商店/广场详情面板同时挂着 `SkillActionsBlock`(自己的边框 + 主按钮)
 * 与这个组件(自己的边框 + 主按钮)——两份看着都像"这一行的主按钮"堆在一起,
 * 是用户截图里那个 bug 的直接成因。Q44-A 拍板"只留一个页脚",做法是把
 * `SkillActionsBlock` 的次要动作(打开文件夹/在技能库里查看/移除)当作一个
 * `ReactNode` 传进来,摆进这个组件**唯一**的边框容器里(`border-t border-border`
 * 上提到最外层,各阶段自己的内容不再各带一份)。
 *
 * 这个组件**不需要知道** `InstalledSkillView`/`rowAction` 这些「我的技能」
 * 语境的类型——调用方(`DetailPanel.tsx` 的 `PanelBody`)算好一个 `ReactNode`
 * 传进来,这里只负责摆放位置,与既有的 `projectArea`(项目安装的进行态/提示/
 * 待确认)是同一种"顶层拼装、不下渗进子组件"的先例。
 *
 * ## 🔴 v7.6 任务 3(Q44-A 原文,逐字引用):`actions` 只在 idle / done 合并进主行
 *
 * 用户批的原文是「主按钮(获取／更新／已在电脑上)+ 次要动作(打开文件夹、
 * 在技能库里查看)+「…」收危险动作(移除)」——**同一行**。task-2 的 brief 把
 * 最后一段转写成了「——撑开——[移除]」,实现照做,变成了"一行主按钮 + 另起一行
 * 次要动作(末尾露着一颗常驻可见的「移除」)",且这第二行**不分 phase 无条件
 * 渲染**——running 档的进度条下面也会跟着出现「移除」,挨在一起很怪。
 *
 * 现在改正:`actions`(`SkillActionsBlock` host="store" 返回的裸按钮,见该组件
 * 文档)只作为 `IdleFooter`/`DoneFooter` 自己那条 `flex flex-wrap` 行的**尾部
 * 内联项**传入——`choosing`/`running`/`error`/`conflict` 这几个 phase 根本没有
 * 一条"主按钮所在的行"可以合并,索性不摆,而不是继续用一个独立的第二行。
 * 「移除」本身也已经不再是常驻按钮:`SkillActionsBlock` 把它收进了
 * `SkillRowMenu`(「…」),`ml-auto` 撑开的是这颗菜单触发器,不是「移除」按钮
 * 本身。
 */
export function InstallPanel({
  dirSlug,
  plaza,
  actions,
}: {
  dirSlug: string;
  /**
   * 技能广场详情态(M9 任务 5):不经 `useStoreIndex` 判定库,直接给来源坐标。
   * 有值时"点安装"先幂等挂仓(`beginFromPlaza`)再走同一条 agent 勾选/运行/结果链路
   * ——除了触发方式与"这个技能属于哪个库"的判定来源,其余阶段渲染与普通安装完全一样。
   */
  plaza?: { ownerRepo: string };
  /** `SkillActionsBlock`(host="store")算好的次要动作行,见组件文档「actions」一节。 */
  actions?: ReactNode;
}) {
  const { phase, dirSlug: active, begin, beginFromPlaza, cancel } = useInstall();
  // 详情面板只会从商店打开:装的就是商店当前浏览的那个库(M3 多源 + M4 多仓)。
  // 广场详情态没有"当前浏览的库"这回事(广场本身是搜索态),坐标由 plaza 参数给。
  const activeRegistry = useStoreIndex((s) => s.activeRegistry);
  const activeRepo = useStoreIndex((s) => s.activeRepo);
  const mine = active === dirSlug;

  const dismissProjectNotice = useProjects((s) => s.dismissNotice);
  const cancelConfirm = useProjects((s) => s.cancelConfirm);

  // 打开(或换一个)技能详情时的收尾。三件事都与"这一次会话"绑定,不是技能的属性:
  //
  // 1. 上一次的项目安装提示与待确认条——不清的话提示说的是**另一个技能**的事,
  //    待确认条更糟:点「装到这里」装的是上一个技能;
  // 2. 🔴 **上一次安装的结果报告**(「已启用到 Claude Code、Trae」)。它是**本次安装
  //    做了什么**的临时态,不是这个技能的属性。上个月装的技能打开就是简简单单一句
  //    「已启用」,刚装的却永远带着一段结果报告,同一个东西两种面孔——而且此前
  //    **只有重启应用才能回到简易态**(2026-08-22 用户反馈)。
  //
  // ⚠️ **进行中的流程绝不能清**(running/choosing/conflict):关掉详情面板时安装
  //    可能还在跑,清掉状态等于把进行中的流程整个丢掉。只收终态。
  //
  // 用 `getState()` 读 phase 而不是订阅:订阅的话 phase 一变成 done 就会被这个
  // effect 立刻清掉,结果报告一帧都看不到。
  useEffect(() => {
    dismissProjectNotice();
    cancelConfirm();
    const s = useInstall.getState();
    if (s.phase === "done" || s.phase === "error") s.cancel();
  }, [dirSlug, dismissProjectNotice, cancelConfirm]);

  const scope = { dirSlug, plaza, activeRegistryId: activeRegistry, activeRepoKey: activeRepo };

  // 项目安装的进行态/提示/待确认与**全局安装的 phase 无关**,所以在顶层渲染。
  // 🔴 此前它们挂在 `IdleFooter` 内部,于是"装完那一屏"(done)里点最近项目,
  // 确认条整个渲染不出来——用户看得到入口、点了却没反应。只在 idle/done 两档
  // 摆出来,与合并页脚之前的既有行为逐字相同。
  const projectArea = <ProjectStatus />;

  let body: ReactNode;
  let showProjectArea = false;
  if (!mine || phase === "idle") {
    body = (
      <IdleFooter
        {...scope}
        actions={actions}
        onBegin={() =>
          plaza
            ? void beginFromPlaza(plaza.ownerRepo, dirSlug)
            : void begin(dirSlug, activeRegistry, activeRepo)
        }
      />
    );
    showProjectArea = true;
  } else if (phase === "choosing") {
    body = <AgentChooser onCancel={cancel} />;
  } else if (phase === "running") {
    body = <Running />;
  } else if (phase === "done") {
    body = <DoneFooter {...scope} actions={actions} />;
    showProjectArea = true;
  } else if (phase === "error") {
    body = <ErrorFooter />;
  } else {
    // conflict 由 ConflictDialog 接管,底部保持"安装中"的静态样子
    body = <Running />;
  }

  // 🔴 唯一的一层 `border-t border-border`(Q44-A):各阶段的内容组件不再自带
  // 边框,只留内边距。`actions` 不再作为独立的第二行摆在这里——它已经被
  // `IdleFooter`/`DoneFooter` 合并进各自的主行(见上面文档「v7.6 任务 3」)。
  return (
    <div className="flex-none border-t border-border" data-testid="detail-footer">
      {body}
      {showProjectArea && projectArea}
    </div>
  );
}

function IdleFooter({
  dirSlug,
  plaza,
  onBegin,
  activeRegistryId,
  activeRepoKey,
  actions,
}: {
  dirSlug: string;
  plaza?: { ownerRepo: string };
  onBegin: () => void;
  /** 当前浏览的库坐标(装到项目时要原样带上,否则会打到主仓)。 */
  activeRegistryId?: string | null;
  activeRepoKey?: string | null;
  /** `SkillActionsBlock`(host="store")的裸按钮,合并进这一行的尾部(Q44-A)。 */
  actions?: ReactNode;
}) {
  const installed = useInstall((s) => s.installed);
  const index = useStoreIndex((s) => s.index);
  const record = installed.get(dirSlug);
  // v7.6:这台电脑上这个 dirSlug 的本体指纹——`cardState` 起,判定入口从"问账本"
  // 改成"问磁盘",这个值不论有没有记账都要读取(见 `lib/update.ts::cardState`
  // 文档注释)。数据来自 `useMySkills` 的 `list`——**这里不主动 load()**,商店页
  // 挂载时已经 load 过一次(见 `StorePage.tsx`),而 `InstallPanel` 只会从商店
  // (含广场搜索结果)打开,那时 `list` 要么已经在加载、要么已经加载完。
  const myList = useMySkills((s) => s.list);
  const local = localProbeOf(myList, dirSlug);
  // 与商店卡片同一条判定。曾经这里只算 install/installed 两档,于是卡片显示
  // "更新"、点进来按钮却是禁用的「已启用」——用户点了毫无反应(2026-08-03 实测缺陷)。
  //
  // 广场详情态没有索引可比(广场是搜索态,不建索引——设计文档 §2.4):remoteHash
  // 传空串,`cardState` 对指纹缺失按「已在电脑上」(`onDisk`)处理,宁可漏报
  // "有更新"也不能编造一个。真正精确的"有更新"判定,要等这个仓被挂上、
  // 用户切到它按普通库浏览时才出现(那条路走的是 store_index,自然有指纹可比,
  // §2.4 说的正是这件事)。
  //
  // v7.4 起 `cardState` 不再收作者/登录身份两个形参(用户第 9 轮拷问拍板撤掉商店
  // 卡片的作者四档,见 `lib/update.ts` 文档注释):商店只回答"我有没有 / 我要不要",
  // "这是不是我分享的"这件事交给 core 的 `acquire::precheck` 在点下去之后判定。
  const state = plaza
    ? cardState(record, "", ownerRepoToLibrary(plaza.ownerRepo), local)
    : cardState(
        record,
        remoteHashOf(index, dirSlug),
        index ? { registryId: index.registryId, owner: index.owner, repo: index.repo } : undefined,
        local,
      );
  const requestInstall = useProjects((s) => s.requestInstall);
  const installing = useProjects((s) => s.installing);


  // 装到项目沿用全局默认 agent(2026-08-20 拍板:不再单独问一次)。
  // 口径与全局安装共用 `defaultSelectedAgents`,不另写一份。

  return (
    <div className="px-5 py-3.5">
      {/* Q44-A(v7.6 任务 3):主按钮 + 装到项目 + 徽标 + 次要动作(打开文件夹/
          在技能库里查看)+「…」全部同一行,`flex-wrap` 只是窄宽度下的降级
          (结构上仍是一行,不是刻意的两行)。 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <InstallButton
          state={state}
          size="lg"
          onClick={onBegin}
          // 详情面板底部的 differs(v7.6 前叫 onDiskDiffers)说的是**动作**
          // 「换成库里的版本」,不是卡片上那句状态陈述「与库里不同」——两处不同词
          // 是有意的(v7.5 共识,v7.6 未变)。文案表在 `InstallButton.tsx::labelOf`,
          // 这里只说"我是哪一处"。
          variant="panel"
          hint={
            state === "otherLibrary" && record
              ? t("skill.otherLibraryHint", {
                  library: `${record.sourceOwner}/${record.sourceRepo}`,
                })
              : undefined
          }
        />
        <InstallScopeMenu
          dirSlug={dirSlug}
          // 主按钮是终态(「已在电脑上」,v7.6 起 `onDisk` 是唯一终态)不可点时,
          // 把作用域入口显性化成文字按钮——那一档整块看起来就是"做完了",小三角
          // 不足以让人想到还能装到项目(2026-08-22 用户反馈,v7.5 Q39-A 沿用同一条
          // 判据,v7.6 未变)。可点动作那几档保持图标,免得抢注意力。
          label={state === "onDisk" ? t("install.scopeProject") : undefined}
          disabled={!!installing}
          onGlobal={onBegin}
          onPickProject={() => {
            void (async () => {
              await requestInstall({
                dirSlug,
                registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
                repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
              });
            })();
          }}
          onChooseRecent={(path) =>
            // 「最近的项目」省掉的**只是选文件夹那一步**,后续与手选文件夹完全一样
            // ——一样进确认条、一样点「装到这里」才写盘(2026-08-22 用户拍板,
            // 推翻了此前"最近项目豁免确认"的设计)。同一个动作在两个入口两种行为,
            // 心流是断的;一致性比省一次点击值钱。
            void requestInstall({
              dirSlug,
              projectPath: path,
              registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
              repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
            })
          }
        />
        {/* v7.4 起 mine* 四档已删除,`state` 不再有能标出"本地改过"的档位
            (商店的按钮状态自 v7.4 起不区分"是不是我分享的",见 `lib/update.ts`
            文档注释)。这条徽标因此不再按 state 过滤——本地改没改是与作者身份
            无关的独立信息,任何已装技能只要本体内容变了就提示,不再是曾经被
            mine* 状态吞掉的那一小部分。 */}
        {/* 检查点 3(brief):徽标紧跟在主按钮组(获取/更新 + 装到项目)之后、
            次要动作(actions)之前——它说的是"这个技能"的事,与"这一行还能
            做什么"是两类信息,不掺进 `actions` 的 `ml-auto` 撑开区间里,
            不会被「…」的靠右挤乱。 */}
        {record?.localModified && (
          <span className="text-[11.5px] text-text-3">{t("conflict.modifiedTitle")}</span>
        )}
        {actions}
      </div>
    </div>
  );
}

/** 路径末段。界面不拿完整路径当标题(太长),完整路径挂在 title 上。 */
function folderNameOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 项目安装的进行态 / 结果提示 / 待确认条。
 *
 * 🔴 **与全局安装的 phase 无关,所以在 `InstallPanel` 顶层渲染**:此前它们挂在
 * `IdleFooter` 内部,于是"装完那一屏"(`phase === "done"`)里点最近项目,确认条
 * 整个渲染不出来——用户看得到入口、点下去却没反应。这类"入口在这一屏、
 * 反馈在另一屏"的错位,单测不特意跨 phase 构造就发现不了。
 */
function ProjectStatus() {
  const installing = useProjects((s) => s.installing);
  const notice = useProjects((s) => s.notice);
  const confirm = useProjects((s) => s.confirm);

  if (!installing && !notice && !confirm) return null;

  return (
    <div className="px-5 pb-3.5">
      {installing && (
        <p className="text-[11.5px] text-text-3">
          {t("install.installingToProject", { project: folderNameOf(installing.projectPath) })}
        </p>
      )}
      {!installing && notice && <p className="text-[11.5px] text-text-2">{notice}</p>}
      {confirm && <ConfirmBar />}
    </div>
  );
}

/**
 * 选完文件夹之后的确认条(2026-08-22 用户真机反馈后加)。
 *
 * 原先是选完路径立刻写盘,用户的原话是"我以为是选完路径后点击安装,结果直接安装了"。
 * 完整原委与"为什么不改系统选择框的按钮文案"见 `store/project.ts` 的 `ProjectConfirm`。
 *
 * 它同时是**成功反馈的锚点**:点下去之后原地变成结果提示,视线不用移动——
 * 比在别处冒出一行小字可靠得多(用户另一条反馈:"安装提示不够明显")。
 *
 * ## 🔴 v7.6 任务 3(B1/B2/B3):竖排头行 + 删重复句 + picker 换 inline
 *
 * 此前是 `flex items-start` 两列:左列竖排五段(标题/文件夹名/路径/信息句/
 * picker),右列三颗按钮——`items-start` 让左高右矮,右下方空出一大片。
 *
 * **B1**:头一行压成一句「将装到 <文件夹名> · <路径>」,与三颗按钮同排右对齐;
 * picker(在场时)与信息句退到下面独占一整行——左列不再是五段堆叠,右下的
 * 空白也就没有了。
 *
 * **B2**:`install.confirmAgents`(「会启用到 X、Y」)在 picker 上了确认条
 * (终审 §15)之后成了同一份信息的死重复,**只在 picker 不在场时**才渲染。
 * 另外两句(`confirmAlready`「已经装过」、`confirmNoAgents`「没有可选工具」)
 * 与 picker 在不在场无关,不受影响;新增第四档
 * `install.confirmToolsUnknown`——`pickableAgents === null`(探测失败)时,
 * 如果 `confirm.agentLabels`(`requestInstall` 自己那次独立探测的结果,
 * 与 `pickableAgents` 不是同一次探测,见下)仍然有值,那句话本身没说谎、继续用;
 * 只有**两次探测都没拿到结果**时才落到这句降级句,不能说成 `confirmNoAgents`
 * ——那是在探测失败时编造"没有可选的工具",CLAUDE.md 记过这条教训
 * (`mine.projectToolsUnknown` 同款,但那句话里"已经启用的仍能取消"是「行改选」
 * 场景专属的后半句,装前的确认条不适用,所以另起一个键而不是复用它)。
 *
 * **B3**:picker 从 `layout="list"` 换成 `layout="inline"`——这里的 `item.path`
 * 恒为 `""`(候选口径与「行改选」`ProjectSections.tsx` 同一份;⚠️ 0.6.x K3 起
 * 项目内相对路径**已经可穿**、`ProjectSections` 那一处已填上,这里仍留空是
 * **刻意的**:`inline` chip 流不是为路径设计的,`item.path` 在两种布局下都会
 * 渲染,填上就是把一串等宽路径混进 chip 里;而维持 `inline` 本身是用户看过
 * 截图批的,理由不再是"没有路径"而是"确认条这个语境 chip 流更合适"),`list`
 * 相对 `inline` 唯一的优势就是带路径,在这个语境下买不到任何东西。9 个工具约两行,`max-h-[140px]` 的滚动盒与"第一项被切
 * 一半"这种滚动中态视觉一起消失。⚠️ **这是对设计画布 §15 的偏离**(画布给
 * 确认条画的是 `list`),以本任务截图获批为准。`AgentChooser`(08 号截图)
 * 不受影响,继续用 `list`——它的 `item.path` 是真实的 `agent.globalSkillsDir`,
 * R17 的"带路径清单"理由在那里仍然成立。
 */
function ConfirmBar() {
  const confirm = useProjects((s) => s.confirm)!;
  const confirmInstall = useProjects((s) => s.confirmInstall);
  const cancelConfirm = useProjects((s) => s.cancelConfirm);
  const requestInstall = useProjects((s) => s.requestInstall);
  const pickableAgents = useProjects((s) => s.pickableAgents);
  const toggleConfirmAgents = useProjects((s) => s.toggleConfirmAgents);

  // design §15 前半:确认条上可选工具——IPC 早就收 `agentIds`,只是此前没摆
  // 控件,用户只能沿用 `requestInstall` 算好的默认集合。候选口径与「行改选」
  // (`ProjectSections.tsx`)同一份:`pickableAgents`(已排除 universal——那类
  // 工具的 skillsDir 与本体同一处,勾了也没用),落点路径这一层同样没有项目内
  // 相对路径可穿(0.6.x K3 起可穿了,`ProjectSections` 已填;这里刻意留空,
  // 原委见上面 `ConfirmBar` 的文档)。
  //
  // 🔴 `pickableAgents === null`(探测失败)时不摆 picker——摆一个空的会让人
  // 以为"这台机器没有可选的工具"(那是假话,只是探测失败)。文字那一侧的降级
  // 见下面 `infoLine`。
  //
  // 🔴 共用同一个项目目录的工具(Trae 与 Trae CN 都是 `.trae/skills`)合并成一个勾、整组
  // 进出,与项目行事后改选同一套规则(`lib/project-tools.ts`,2026-09-14 真机走查)。
  const groups = groupProjectTools(
    (pickableAgents ?? []).map((a) => ({
      agent: a.name,
      label: a.displayName,
      skillsDir: a.skillsDir,
      on: confirm.agentIds.includes(a.name),
      detected: true,
    })),
  );
  const items: ToolPickerItem[] = groups.map((g) => ({
    agent: g.id,
    label: g.labels.join(t("common.listSep")),
    path: "",
    state: (g.on ? "linked" : "off") as ToolState,
  }));

  // B2:`confirmAgents` 只在 picker 不在场时渲染,其余三档(已装过/降级/无可选)
  // 与 picker 在不在场无关——它们本来就只在 `items.length === 0` 时才可能触发
  // (items 由 `pickableAgents` 派生),不需要再额外拿 `items.length` 去挡。
  const infoLine = confirm.alreadyInstalled
    ? t("install.confirmAlready")
    : items.length > 0
      ? null
      : confirm.agentLabels.length > 0
        ? t("install.confirmAgents", { agents: confirm.agentLabels.join(t("common.listSep")) })
        : pickableAgents === null
          ? t("install.confirmToolsUnknown")
          : t("install.confirmNoAgents");

  return (
    <div className="mt-2.5 rounded-card border border-border bg-surface-2 px-3 py-2.5">
      {/* B1:头一行,三颗按钮同排右对齐。 */}
      <div className="flex items-center gap-3">
        <div
          className="min-w-0 flex-1 truncate text-[12.5px]"
          title={confirm.projectPath}
        >
          <span className="text-text-3">{t("install.confirmTitle")}</span>{" "}
          <span className="font-[550]">{folderNameOf(confirm.projectPath)}</span>
          <span className="text-text-3">{t("punct.middleDot")}</span>
          {/* 路径用等宽(UI 规范);整行 `truncate` 时子元素不必各自再截一遍,
              完整值挂在外层容器的 `title` 上(CSS 只能截尾)。 */}
          <span className="font-mono text-[11px] text-text-3">{confirm.projectPath}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 已经装过时主动作换成「覆盖重装」而不是撤掉按钮(2026-08-22 用户拍板:
              "装过的也能装,保留足够权利")。**这不违反「不摆比解释好」**——那条针对的是
              点了必然报错的按钮;重装是完全合法的操作,内容一样时它仍会重建 agent 关联,
              那正是用户想重装的理由。 */}
          {confirm.alreadyInstalled ? (
            <button
              type="button"
              title={t("install.confirmForceHint")}
              onClick={() => void confirmInstall(true)}
              className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("install.confirmForce")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void confirmInstall()}
              className="h-7 rounded-ctl bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover"
            >
              {t("install.confirmGo")}
            </button>
          )}
          {/* 就地换一个文件夹(2026-08-22 用户拍板:"装到一个目录不应该没有任何
              可装到别的目录操作空间")。此前这一档只有「取消」,是条死路。 */}
          <button
            type="button"
            onClick={() =>
              void requestInstall({
                dirSlug: confirm.dirSlug,
                registryId: confirm.registryId,
                repo: confirm.repo,
              })
            }
            className="h-7 rounded-ctl px-2.5 text-[12px] font-medium text-text-2 hover:text-text"
          >
            {t("install.confirmPickOther")}
          </button>
          <button
            type="button"
            onClick={cancelConfirm}
            className="h-7 rounded-ctl px-2.5 text-[12px] font-medium text-text-3 hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
        </div>
      </div>
      {infoLine && <div className="mt-1.5 text-[11.5px] text-text-3">{infoLine}</div>}
      {items.length > 0 && (
        <div className="mt-1.5 max-h-[140px] overflow-y-auto rounded-ctl border border-border p-2">
          {/* 🔴 key={confirm.projectPath}:`ToolPicker` 的"已勾排前面"只在
              拿到第一份非空 items 时排一次(见该组件文档),往后不重排。
              用户点「换个文件夹」时 `ConfirmBar` 实例不会卸载(只有换技能
              才会,见 `InstallPanel` 顶层那个按 dirSlug 收尾的 effect),
              换一个 key 强制它换成一份干净的 `useRef`,新项目默认勾选的
              那批工具才排得对,不会沿用上一个项目的排序。 */}
          <ToolPicker
            key={confirm.projectPath}
            items={items}
            onToggle={(id) => {
              const group = groups.find((g) => g.id === id);
              if (group) toggleConfirmAgents(group.agents);
            }}
            layout="inline"
          />
        </div>
      )}
    </div>
  );
}

function AgentChooser({ onCancel }: { onCancel: () => void }) {
  const { agents, selected, toggleAgent, run, registryId, repo } = useInstall();
  // 需要建链的才列出来:通用目录的 agent(cursor/codex 等)落在 canonical 就能读到,
  // 让用户去勾一个"勾不勾都一样"的选项只会让人困惑。
  const linkable = agents.filter((a) => a.needsLink);
  // 广场的挂仓探测是异步的(beginFromPlaza):在它回来、`repo` 被换成真实寻址键之前,
  // 「确定」点下去必然带着 repo: null 去调 skill_install,报"技能广场没有默认技能库"
  // ——这句错误跟用户刚点的按钮毫无关系(M9 终审修复)。禁用比放行后报一句文不对题
  // 的错误更诚实。
  const confirmDisabled = registryId === PLAZA_REGISTRY_ID && repo === null;

  // v7 任务 5:与「我的技能」的勾组共用同一个 ToolPicker(同一套 checkbox/label
  // token),但用 layout="list"(R17 裁定)——这里没有 body/copy/missing 这几档
  // (还没装,谈不上本体在哪),只有勾没勾两态;而"工具名 + 落点路径"天然是一份
  // 竖排清单,拉平成 chip 流会让长 mono 路径和工具名混排,是真实的可读性回归。
  const items: ToolPickerItem[] = linkable.map((agent) => ({
    agent: agent.name,
    label: agent.displayName,
    path: agent.installed ? (agent.globalSkillsDir ?? "") : t("install.notDetected"),
    state: selected.has(agent.name) ? "linked" : "off",
  }));

  return (
    <div className="px-5 py-3.5">
      <div className="mb-2 text-[12px] font-[550]">{t("install.choose")}</div>
      {/* `px-3` 的理由与 `ConfirmBar` 那个盒子逐字相同(终审 I-2,见那里的注释)。 */}
      <div className="max-h-[168px] overflow-y-auto rounded-card border border-border px-3">
        <ToolPicker items={items} onToggle={(agent) => toggleAgent(agent)} layout="list" />
      </div>
      <p className="mt-2 text-[11.5px] leading-[1.5] text-text-3">{t("install.chooseHint")}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={confirmDisabled}
          onClick={() => void run()}
          className="h-[30px] rounded-ctl bg-accent px-[14px] text-[12.5px] font-[550] text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {t("install.confirm")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-[30px] rounded-ctl border border-border px-[14px] text-[12.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("install.cancel")}
        </button>
      </div>
    </div>
  );
}

const STAGE_ORDER: InstallStage[] = ["fetching", "checking", "writing", "linking", "recording", "done"];

function Running() {
  const stage = useInstall((s) => s.stage);
  // 进度条按阶段推进。没有字节级进度可报(压缩包一次性下完),阶段本身就是最诚实的粒度。
  const done = stage ? STAGE_ORDER.indexOf(stage) + 1 : 0;
  const percent = Math.round((done / STAGE_ORDER.length) * 100);

  return (
    <div className="px-5 py-3.5">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-text-2">
        <span>{stage ? t(STAGE_LABEL[stage]) : t("install.installing")}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full bg-accent transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

function DoneFooter({
  dirSlug,
  plaza,
  activeRegistryId,
  activeRepoKey,
  actions,
}: {
  dirSlug: string;
  plaza?: { ownerRepo: string };
  activeRegistryId?: string | null;
  activeRepoKey?: string | null;
  /** `SkillActionsBlock`(host="store")的裸按钮,合并进这一行的尾部(Q44-A)。 */
  actions?: ReactNode;
}) {
  const { report, localKept, mineKept, shareResult, agents: detected, begin, beginFromPlaza } =
    useInstall();
  const requestInstall = useProjects((s) => s.requestInstall);
  const failed = failedLinks(report);
  const agents = linkedAgents(report, detected);

  return (
    <div className="px-5 py-3.5">
      {/* Q44-A(v7.6 任务 3):`actions` 摆在这一行尾部,与「装到项目…」同排。
          `flex-wrap` 是窄宽度下的降级。 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 items-center gap-2 text-[12.5px] font-medium text-ok">
          <Icon icon={Check} size={14} />
          {/* 🔴 `mineKept` 时 core 什么都没写——「已启用到…」「已安装到通用目录」
              这两句对这一档都是假话,必须换成"保留了本地内容"这句真话
              (`AcquireOutcome::Kept`:磁盘、账、各工具的启用状态零变化)。 */}
          {mineKept
            ? // 🔴 两档说的话不一样:`localDiffers` 那档 core 一处启用都没改
              //(`acquire.rs` 对 `LocalDiffers + KeepLocal` 早退,排在 `link_only`
              // 之前),说完「已保留」就没有下文了,必须把出路一起说了
              //——否则这一屏是死路。`mine` 那档后面还有分享结果接着说。
              mineKept.kind === "localDiffers"
              ? t("install.localDiffersKept")
              : t("install.mineKept")
            : agents.length > 0
              ? t("install.done", { agents: agents.join(t("punct.listSeparator")) })
              : t("install.doneCanonicalOnly")}
        </div>
        {/* design §18:商店装完那一屏加「在我的技能里查看」,切页并直接打开
            那一行的详情——此前装完只能自己去「我的技能」页里找。用 dirSlug
            打开(不是 body 路径):`skill_local_detail` 的 dirSlug 分支走
            `converge::home_of` 从账上解析本体位置。

            🔴 **`localDiffers` 那一档不摆这颗按钮**(终审复审轮 1,I-C)。
            这里原先写着"装完这一刻账已经写好了",对**这一档是假话**:
            `LocalDiffers + KeepLocal` 时 `acquire` 早退返回 `Kept`,
            **磁盘、账、启用状态全都零变化**(CLAUDE.md 的「本体与位置模型」
            一节写明它刻意不记账)。没有记账时 `converge::home_of` 回落
            canonical,而这一档的本体多半住在某个工具目录里(用户自己写的
            那一份)、canonical 上什么都没有——点下去打开的是一个
            "这个文件夹不是技能"的报错面板。按本项目已拍板的
            **「不摆比摆一个必然报错的按钮好」**处理:这一档不摆它,
            出路由紧邻的 `install.localDiffersKept` 那句话给出
            (「到『我的技能』里勾一下」)。
            `mine` 那一档不受影响——它有记账,`home_of` 解析得到本体。 */}
        {mineKept?.kind !== "localDiffers" && (
          <button
            type="button"
            onClick={() => {
              useUi.getState().setPage("mine");
              void useLocalDetail.getState().open({ dirSlug });
            }}
            className="h-6 flex-none rounded-ctl px-1.5 text-[11.5px] font-medium text-text-2 underline decoration-dotted underline-offset-2 hover:text-text"
          >
            {t("install.viewInMine")}
          </button>
        )}
        {/* 装完那一屏也要留出口(2026-08-22 用户反馈:"这时候也没有更多操作空间")。
            与「已启用」终态同一形态:结果是状态,「装到项目…」是动作,并排摆。 */}
        <InstallScopeMenu
          dirSlug={dirSlug}
          label={t("install.scopeProject")}
          onGlobal={() =>
            plaza
              ? void beginFromPlaza(plaza.ownerRepo, dirSlug)
              : void begin(dirSlug, activeRegistryId ?? undefined, activeRepoKey)
          }
          onPickProject={() =>
            void requestInstall({
              dirSlug,
              registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
              repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
            })
          }
          onChooseRecent={(path) =>
            void requestInstall({
              dirSlug,
              projectPath: path,
              registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
              repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
            })
          }
        />
        {actions}
      </div>
      {/* 「保留并分享」的结果盖过普通的"已保留":它把下一步也交代了 */}
      {shareResult ? (
        <p
          className={[
            "mt-1.5 text-[11.5px]",
            "error" in shareResult ? "text-[#c0392b] dark:text-[#e0705f]" : "text-text-3",
          ].join(" ")}
        >
          {"error" in shareResult
            ? `${t("install.shareAfterKeepFailed")}${t("punct.labelSeparator")}${shareResult.error.message}`
            : /* v8 任务 5:「库里已经和本地一样」也是一种成功,而且是**什么都没变**
                 的那种——不单独说一句的话,用户看到的是"点了没反应"。 */
              shareResult.mode === "inSync"
              ? t("mine.shareInSync")
              : t("install.sharedAfterKeep")}
        </p>
      ) : (
        localKept && (
          <p className="mt-1.5 text-[11.5px] text-text-3">{t("install.keptLocal")}</p>
        )
      )}
      {failed > 0 && (
        <div className="mt-2 rounded-card border border-border bg-surface-2 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[12px] text-[#9a6a00] dark:text-[#d9a94a]">
            <Icon icon={TriangleAlert} size={12} />
            {t("install.linkFailed", { count: failed })}
          </div>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-text-3">
            {t("install.linkFailedHint")}
          </p>
          {report?.links
            .filter((l) => l.result.status === "failed")
            .map((l) => (
              <FailedLinkRow
                key={l.dir}
                dir={l.dir}
                message={l.result.status === "failed" ? l.result.error.message : ""}
              />
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * 没能启用的一处:说明 + 就地再来一次。成功后这一行会从列表里消失。
 *
 * 按钮说的是**用户要的结果**(在工具里启用),不是"重试"这个动作——上一版那颗
 * 「重试」点下去可能弹出一个承诺"替换掉那个目录"的确认框,而新模型里内容不同的
 * 位置一个字节都不覆盖,由 core 报「有几份不一样的」交给用户拍板。
 */
function FailedLinkRow({ dir, message }: { dir: string; message: string }) {
  const enableInTools = useInstall((s) => s.enableInTools);
  const enablingDir = useInstall((s) => s.enablingDir);
  const enableError = useInstall((s) => s.enableError);
  const busy = enablingDir === dir;

  return (
    <div className="mt-1.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-3">
          {dir}
          {message && `${t("punct.labelSeparator")}${message}`}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void enableInTools(dir)}
          className="h-6 flex-none rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
        >
          {busy ? t("install.enabling") : t("install.enableInTools")}
        </button>
      </div>
      {!busy && enableError && (
        <p className="mt-1 text-[11px] text-[#c0392b] dark:text-[#e0705f]">{enableError.message}</p>
      )}
    </div>
  );
}

function ErrorFooter() {
  const { error, run, cancel } = useInstall();
  return (
    <div className="px-5 py-3.5">
      <p className={cn("text-[12.5px]", "text-text-2")}>{error?.message ?? t("error.generic")}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void run()}
          className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("install.retry")}
        </button>
        <button
          type="button"
          onClick={cancel}
          className="h-7 rounded-ctl px-2.5 text-[12px] font-medium text-text-3 hover:text-text"
        >
          {t("install.cancel")}
        </button>
      </div>
    </div>
  );
}
