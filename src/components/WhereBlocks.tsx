import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Laptop,
  Library,
  MoreHorizontal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { Icon } from "@/components/Icon";
import { ToolChecks } from "@/components/ToolChecks";
import { t } from "@/i18n";
import { isAppError, openLibraryUrl, skillReveal, type InstalledSkillView, type Section } from "@/lib/ipc";
import { useDetailCollapse } from "@/store/detail-collapse";
import { useMySkills, visibleTools } from "@/store/my-skills";

/**
 * 详情面板「在哪」三块(v7 任务 6):产品语言「一个技能,三个在哪」的落点
 * ——这台电脑上 / 各个工具里 / 技能库里。顺序固定,标题恒渲染(`data-testid`
 * 供测试断言顺序),内容按数据稀疏程度各自降级,不摆比编造好。
 *
 * # 🔴 `bodyLocationText` 是修 Zed 缺陷的核心,必须先比 canonical 再查工具目录
 *
 * 用户报告过真实缺陷:技能明明放在统一技能目录 `~/.agents/skills/<名字>`,
 * 界面却显示成「Zed 本体在这里」。根因是 core 的 `tools_of` 按"本体所在目录"
 * 反查 agent 时,6 个 agent(cline/dexto/kimi-code-cli/loaf/warp/zed)的全局
 * 技能目录恰好都是那个统一目录,前端再按"这台机器探测到哪些"收窄,用户机器上
 * 往往只剩一个,于是被点了名——而本体住统一目录时,它其实不属于任何一个工具。
 *
 * 所以这里绝不做"按目录反查 agent"这件事:`bodyLocationText` 先精确比较
 * 本体的父目录是不是就是 canonical 目录,命中直接返回不点名任何工具的那句话;
 * 只有走到第二步——父目录精确匹配某个工具的专属目录——才点名那一个工具。
 * `toolDirs` 刻意带着那 6 个 canonical 同款 agent(不预先滤掉它们),靠**判定顺序**
 * (canonical 先判)而不是靠"从数据里拿掉"来保证正确性,道理见下面的实现注释。
 */
export function bodyLocationText(
  body: string,
  canonicalDir: string,
  agentNames: Map<string, string>,
  toolDirs: Map<string, string>,
): string {
  const parent = parentDir(body);
  const canonical = normalizeSlashes(canonicalDir);
  // 先比 canonical:命中即返回统一目录那句话,压过下面的逐工具反查。
  // 这一步删掉就是退回"按目录反查 agent"——那正是要修的缺陷本身。
  if (canonical && parent === canonical) {
    return t("detail.whereBodyCanonical");
  }
  for (const [agent, dir] of toolDirs) {
    if (parent && parent === normalizeSlashes(dir)) {
      return t("detail.whereBodyTool", { tool: agentNames.get(agent) ?? agent });
    }
  }
  // 两个都没命中:路径本来就单独摆在旁边,这里给一句不点名任何工具的中性话,
  // 不猜、不编。
  return t("detail.whereBodyOther");
}

function normalizeSlashes(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function parentDir(path: string): string {
  const trimmed = normalizeSlashes(path);
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? "" : trimmed.slice(0, idx);
}

const SECTION_TITLE: Record<Section, "mine.sectionInstalledFrom" | "mine.sectionSharedTo" | "mine.sectionShareable"> = {
  installedFrom: "mine.sectionInstalledFrom",
  sharedTo: "mine.sectionSharedTo",
  shareable: "mine.sectionShareable",
};

function BlockShell({
  icon,
  title,
  testId,
  children,
}: {
  icon: LucideIcon;
  title: string;
  /** 给测试用的容器钩子(把断言限定在这一块里,别误伤同屏另外两块)。 */
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex items-start gap-2.5 border-t border-border py-3 first:border-t-0">
      <Icon icon={icon} size={15} className="mt-0.5 w-5 shrink-0 text-text-3" />
      <div className="min-w-0 flex-1">
        <div
          data-testid="where-title"
          className="text-[11px] font-[550] tracking-[0.05em] text-text-3"
        >
          {title}
        </div>
        <div className="mt-1 text-[12.5px] text-text-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * 块 1:这台电脑上。本体路径 + 一句"它放在哪一类位置"的说明。
 *
 * 🔴 **这里刻意没有「打开文件夹」按钮**(v7.1 任务 3,Q3 拍板):这个动作在
 * 详情面板里只留**一处**,在固定页脚(`SkillActionsBlock`)。此前是两处——
 * 这一块里一颗「打开文件夹」,面板底部还浮着一颗「在访达中打开」,同一个动作
 * 两个入口两种叫法,而后者在 Windows 上说"访达"还是错的。
 * 失败的渲染点随按钮一起搬去了页脚,不是被删掉了。
 */
function ThisComputerBlock({
  skill,
  agentNames,
}: {
  skill: InstalledSkillView;
  agentNames: Map<string, string>;
}) {
  const canonicalDir = useMySkills((s) => s.canonicalDir);
  const toolDirs = useMySkills((s) => s.toolDirs);
  // 「…」默认收起。刻意是组件本地状态、不落 store:它是"我这会儿想多看一眼"
  // 这种一次性动作,换一个技能就该回到收起态——而详情面板换技能会整体换挂载
  // (`store/local-detail.ts` 的 `open`),这份 useState 天然跟着重置。
  const [readersOpen, setReadersOpen] = useState(false);

  if (!skill.localPresent || !skill.body) {
    return (
      <BlockShell icon={Laptop} title={t("detail.whereTitle1")}>
        {t("detail.whereNotHere")}
      </BlockShell>
    );
  }

  const text = bodyLocationText(skill.body, canonicalDir, agentNames, toolDirs);
  const readers = skill.canonicalReaders;

  return (
    <BlockShell icon={Laptop} title={t("detail.whereTitle1")}>
      <p className="truncate font-mono text-[12px] text-text" title={skill.body}>
        {skill.body}
      </p>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span className="text-[11.5px] text-text-3">{text}</span>
        {/* 「…」只在有名单可展开时才摆,判据见 {@link canReveal}。 */}
        {canReveal(readers) && (
          <button
            type="button"
            aria-label={t("detail.whereReadersToggle")}
            aria-expanded={readersOpen}
            onClick={() => setReadersOpen((v) => !v)}
            className="grid size-5 shrink-0 place-items-center rounded-ctl text-text-3 hover:bg-surface-2 hover:text-text-2"
          >
            <Icon icon={MoreHorizontal} size={13} />
          </button>
        )}
      </div>
      {canReveal(readers) && readersOpen && (
        <div
          data-testid="where-readers"
          className="mt-1 rounded-card border border-border bg-surface-2 px-2.5 py-1.5 text-[11.5px] text-text-2"
        >
          {t("detail.whereReaders", { tools: readers.join(t("punct.listSeparator")) })}
        </div>
      )}
    </BlockShell>
  );
}

/**
 * 「…」该不该摆:本体住在统一技能目录、且那几个共用它的工具这台机器上至少装了
 * 一个(v7.1 任务 4,Q8C+)。**三档不是两档**:
 *
 * - `null` = 本体不在统一目录(住在某个工具自己的目录里)→ 不摆;
 * - `[]` = 本体确实在统一目录,但那几个共用它的工具**这台机器上一个都没装**
 *   → 也不摆。展开一个空标题比不摆更糟:用户点开看到一片空白,会以为界面坏了。
 *   这一档是 core 侧的合法返回值(见 `lib/ipc.ts::canonicalReaders` 的文档),
 *   不是异常,所以要显式判掉,不能只判 `!== null`;
 * - 非空 → 摆。
 *
 * # 这几个工具为什么不在下面的勾选清单里
 *
 * 它们**没有需要用户做的事**:本体就在那个目录里,这些工具天然读得到,勾不掉、
 * 也不用勾。任务 1 已经把它们从 `tools` 里拿掉、换成 core 直接给的
 * `canonicalReaders`——摆进可勾清单只会让用户以为自己该做点什么,而那正是
 * 「Zed 本体在这里」那个真实缺陷的另一半。收进这个默认折起的「…」里:想知道的
 * 点一下能看到,不想知道的不会被一串点不动的勾挡住。
 *
 * 🔴 **名单直接渲染,不过 `agentNames`、不过 `visibleTools`**:core 给的已经是
 * **展示名**,而且已经按"这台机器上装没装"收窄过了(与 `tools` 刻意相反,见
 * `lib/ipc.ts::canonicalReaders`)。再过一次 `agentNames.get` 只会对不在那张表
 * 里的名字拿到 `undefined`。
 */
function canReveal(readers: string[] | null): readers is string[] {
  return readers !== null && readers.length > 0;
}

/**
 * 勾选清单为空时说哪句话——**按成因分三支**(v7.1 任务 4,任务 1 复审转交的
 * C-1)。
 *
 * 🔴 任务 1 把那六个共用统一目录的工具移出 `tools` 之后,空列表**多了一种全新
 * 成因**,而原来那句话一个字没改就变成了假话:本体明明放在统一技能目录(同屏
 * 正上方就写着绝对路径),这里却说「这台电脑上没有本体」。两句话当场打架,而且
 * 撒谎的那句正出现在用户最初报告缺陷的那个现场。
 *
 * 三支各自对应一种成因,谁也不能兼并谁:
 * 1. **本体不在这台电脑上**(第 4 源:库里记着是我分享的,本机没有文件)
 *    → 旧那句话对这一档仍然是真话,原样保留;
 * 2. **本体在统一技能目录**(`canonicalReaders !== null`)→ 读它的工具不需要
 *    单独勾选,所以清单是空的。⚠️ 这句话**不点名任何工具**,因为
 *    `canonicalReaders` 可能是空数组(那六个一个都没装):说"都在读它"就又是
 *    一句假话。要看名单的从上面那个「…」进;
 * 3. **本体在某个工具自己的目录里,但收窄后没有可勾的**(那个工具没被
 *    `agents_detected` 探测到时可达)→ 上面两句都不适用,给一句只说事实、
 *    不解释成因的中性话。套第 2 句会凭空说出"统一技能目录"这个与它无关的位置。
 */
function noToolsText(skill: InstalledSkillView): string {
  if (!skill.localPresent || !skill.body) return t("detail.whereToolsNone");
  if (skill.canonicalReaders !== null) return t("detail.whereToolsNoneCanonical");
  return t("detail.whereToolsNoneOther");
}

/**
 * 块 2:各个工具里。直接委托 `ToolChecks`——R21 收窄与"提交名单从全量 tools
 * 派生"两条不变量都活在那一层,这里裸拼 `ToolPicker` 会把两条护栏各抄一份。
 *
 * 🔴 **`setAgents` 的失败必须有渲染点(修复轮 1 Critical-1)**:`ToolChecks`
 * 只管把点击翻成 `skill_set_agents` 请求,失败结果(`toolFailures`/
 * `setAgentsError`)只写进 `useMySkills` 这个 store——它唯一的既有渲染点在
 * `MySkillsPage.tsx`,而这个块可能出现在 `MySkillsPage` 根本没挂载的地方
 * (从商店页打开详情),或者被详情面板的遮罩层盖住(从「我的技能」页打开时,
 * `MySkillsPage` 渲染在遮罩背后)。两种情况下,用户点一个勾遇到 `Ok(Differs)`
 * (那个位置已经有一份内容不同的东西,core 刻意不动它、也不写记录)时看到的
 * 就是:勾自己弹回未选中、零错误、零提示,再点还是一样——所以这里**复用**
 * `MySkillsPage` 那一套失败分流与文案键(不新增文案、不重写判据),自己开一份
 * 渲染点。`disabled={busy}` 同理:不传的话连点会跟正在处理的那次请求打架。
 */
function EachToolBlock({
  skill,
  agentNames,
}: {
  skill: InstalledSkillView;
  agentNames: Map<string, string>;
}) {
  const installedAgents = useMySkills((s) => s.installedAgents);
  const busy = useMySkills((s) => s.setAgentsBusy) === skill.dirSlug;
  // 🔴 跨技能状态泄漏(v7 任务 6 修复轮 2,R19):toolFailures/setAgentsError 是
  // useMySkills 的全局字段(ToolBlocked 类型里没有 dirSlug)。不按 toolFailuresFor
  // 过滤的话,用户对技能 A 打勾失败后不点「知道了」就打开技能 B 的详情,这里会显示
  // A 的占用路径、「打开文件夹」按钮也会指向 A 的位置——从"零反馈"变成了
  // "错误的反馈",对用户撒谎的是"哪个技能出了问题"。
  const rawFailures = useMySkills((s) => s.toolFailures);
  const rawSetAgentsError = useMySkills((s) => s.setAgentsError);
  const failuresFor = useMySkills((s) => s.toolFailuresFor);
  const mine = failuresFor === skill.dirSlug;
  const failures = mine ? rawFailures : null;
  const setAgentsError = mine ? rawSetAgentsError : null;
  const dismissToolFailures = useMySkills((s) => s.dismissToolFailures);
  // 这里裸算一遍 visibleTools 只是为了决定"有没有工具可显示",与 ToolChecks
  // 内部同一次调用结论必然一致(同一个函数、同一份输入)——耦合是隐式的:
  // ToolChecks 的 `if (shown.length === 0) return null` 哪天改了判据,
  // 这里也要跟着改,否则会渲染出一片"标题在、内容空"的空白。
  const shown = visibleTools(skill.tools, installedAgents);
  const [revealError, setRevealError] = useState<string | null>(null);

  const revealOrExplain = (path: string) => {
    setRevealError(null);
    skillReveal({ path }).catch((raw: unknown) =>
      setRevealError(isAppError(raw) ? raw.message : t("error.generic")),
    );
  };

  return (
    <BlockShell icon={Wrench} title={t("detail.whereTitle2")} testId="where-block-tools">
      {shown.length === 0 ? (
        noToolsText(skill)
      ) : (
        <ToolChecks
          dirSlug={skill.dirSlug}
          tools={skill.tools}
          agentNames={agentNames}
          disabled={busy}
        />
      )}
      {setAgentsError && (
        <p className="mt-1.5 text-[11px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.toolsFailed")}
          {t("punct.labelSeparator")}
          {setAgentsError.message}
        </p>
      )}
      {failures && (
        <div className="mt-1.5 rounded-card border border-[#c0392b]/40 px-2 py-1.5 dark:border-[#e0705f]/40">
          <p className="text-[11px] font-medium text-[#c0392b] dark:text-[#e0705f]">
            {/* 按内容分流,与 MySkillsPage 同一份判据:全是"停下来问你"(differs)
                时说「需要你看一下」,只要有一条是真失败就得说「没能完成」。 */}
            {failures.some((f) => f.kind !== "differs")
              ? t("mine.toolsPartialFailed", { count: failures.length })
              : t("mine.toolsNeedLook", { count: failures.length })}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {failures.map((f, i) => (
              <li
                key={`${f.kind === "location" ? f.path : (f.agent ?? "-")}-${i}`}
                className="text-[11px] text-text-2"
              >
                {f.kind === "differs" ? (
                  (() => {
                    const tool = f.agent
                      ? (agentNames.get(f.agent) ?? f.agent)
                      : t("mine.toolCanonical");
                    return (
                      <>
                        <span>{t("mine.toolOccupied", { tool })}</span>
                        <button
                          type="button"
                          aria-label={t("mine.openFolderOf", { tool })}
                          onClick={() => revealOrExplain(f.existing)}
                          className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-text"
                        >
                          {t("mine.openFolder")}
                        </button>
                      </>
                    );
                  })()
                ) : f.kind === "location" ? (
                  <>
                    <span className="break-all font-mono text-[11px]" title={f.path}>
                      {f.path}
                    </span>
                    {t("punct.labelSeparator")}
                    {f.message}
                  </>
                ) : f.agent ? (
                  `${agentNames.get(f.agent) ?? f.agent}${t("punct.labelSeparator")}${f.message}`
                ) : (
                  f.message
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={dismissToolFailures}
            className="mt-1 h-6 rounded-ctl border border-border px-2 text-[11px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("mine.dismiss")}
          </button>
          {revealError && (
            <p className="mt-1 text-[11px] text-[#c0392b] dark:text-[#e0705f]">
              {t("mine.openFolderFailed")}
              {t("punct.labelSeparator")}
              {revealError}
            </p>
          )}
        </div>
      )}
    </BlockShell>
  );
}

/**
 * 块 3:技能库里。只用 `InstalledSkillView` 上确实有的字段——作者字段这个类型
 * 上没有,不编;"有没有更新"只在能确定为真时才说,判据是既有的唯一实现
 * `hasUpdate`(`store/my-skills.ts`)。
 *
 * 🔴 **`remoteChanged` 由调用方喂进来,这一块自己不再算**(v7.1 任务 3)。
 * 原先它自己调 `hasUpdate(skill, index)`,而「可分享到」区**外部来源**的行,
 * "有没有新版"要按它自己那个源的索引判(`remoteChangedForShareable`)——
 * `hasUpdate` 对那些行恒为 false,于是这一行会静默消失。现在调用方
 * (`WhereBlocks` ← `DetailPanel`)按 section 分流算好一份,折叠头的结论行、
 * 这一块、页脚的主按钮**吃的都是同一个布尔量**,不会互相矛盾。
 *
 * 下面这段讲的仍然成立,只是"拿不准"的判定现在发生在调用方那一层:
 *
 * 🔴 **这一行是"只在确定为真时才说"的单向判定,不是一个双向状态字**
 * (终审复审轮 1,I-A:这段注释原先拿 `sharedState`/`localEqualsRemote` 当活物
 * 讲权衡,而那两个函数已随 v7 任务 7 的旧两分区页一起删除;下面写的是同一条
 * 道理在今天的落点上的说法)。理由是这个组件手上的 `index`
 * (`useStoreIndex().index`)是**当前商店页正浏览的那个库**,不一定是这个技能
 * 真正的来源库(从「我的技能」页之外的地方打开详情时尤其常见)。`hasUpdate`
 * 自己会比对 `registryId`/`sourceOwner`/`sourceRepo`,库不对就返回 `false`
 * ——**代价只是"这一行不出现"(漏报),不会说错**。
 *
 * 反过来,凡是"库不对时会给出一个具体状态"的判定,喂给这一块就会**对一个其实
 * 已经同步的技能撒谎**(说它"和库里不一样")。所以块 3 只摆确定为真的那一半,
 * 拿不准就不摆这一行。今天这一页真正的状态判定在
 * `src/lib/ownership.ts::rowAction`(三区十档,吃 core 给的 `section` +
 * 调用方算好的 `remoteChanged`),它是给**行上那颗主按钮**用的,不是给这一块
 * 用的——别为了"信息更全"把它搬过来:`rowAction` 的 `remoteChanged` 由调用方
 * 负责喂对源(`MySkillsPage`/`SkillActionsBlock` 各自分流 `hasUpdate` 与
 * `remoteChangedForShareable`),这一块手上没有那份分流所需的 `shareableIndexes`
 * 语境。 */
function LibraryBlock({
  skill,
  remoteChanged,
}: {
  skill: InstalledSkillView;
  remoteChanged: boolean;
}) {
  return (
    <BlockShell icon={Library} title={t("detail.whereTitle3")}>
      <p>{t(SECTION_TITLE[skill.section])}</p>
      {skill.sourceLabel ? (
        <p className="mt-0.5 text-text-3">{t("mine.sourceLabel", { label: skill.sourceLabel })}</p>
      ) : (
        <p className="mt-0.5 text-text-3">{t("detail.whereSourceUnset")}</p>
      )}
      {remoteChanged && <p className="mt-0.5 text-text-3">{t("detail.whereHasUpdate")}</p>}
      {skill.review && (
        <p className="mt-0.5 text-text-3">
          <span>{t("detail.whereReviewPending")}</span>
          {skill.review.url && (
            <>
              {t("punct.labelSeparator")}
              <ReviewLink url={skill.review.url} />
            </>
          )}
        </p>
      )}
    </BlockShell>
  );
}

function ReviewLink({ url }: { url: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          openLibraryUrl(url).catch((raw: unknown) =>
            setError(isAppError(raw) ? raw.message : t("error.generic")),
          );
        }}
        className="inline-flex items-center gap-1 text-accent hover:underline"
      >
        <Icon icon={ExternalLink} size={11} />
        {t("detail.whereReviewLink")}
      </button>
      {error && <span className="ml-1 text-[#c0392b] dark:text-[#e0705f]">{error}</span>}
    </>
  );
}

/**
 * 折叠头上那一句结论的**唯一实现**(v7.1 任务 3,Q2)。
 *
 * # 🔴 收起来的东西里"有没有在等我",必须在这一行里说出来
 *
 * 这是本项目已经确立的原则(「我的技能」三区折叠那次定的):折叠不得把例外
 * 藏掉。所以「库里有新版」「审核中」这类**要处理**的信息,收起态下照样出现在
 * 结论里;能折起来的只是路径清单与勾选这些细节。
 *
 * 判据一律复用既有实现,不新写一份:
 * - 第一段 = 这个技能落在哪个区(`SECTION_TITLE`,与「我的技能」页的区标题
 *   同一份文案表);
 * - 「库里有新版」= 调用方按 section 分流算好的 `remoteChanged`
 *   (`hasUpdate` / `remoteChangedForShareable`,见 {@link LibraryBlock} 的文档);
 * - 「审核中」= `skill.review`(core 侧算好的,前端不再判一次)。
 *
 * 🔴 **刻意不数"几个工具开着"**(v7.1 用户裁定):那个数「容易计算错误还不讨好」
 * ——`tools` 与 `canonicalReaders` 是互补的两半,合起来数一次、两边口径再漂一次,
 * 用户拿到的是一个既要维护又没人真的会用的数字。结论行只回答两件事:这个技能
 * 落在哪个区、有没有事在等你。**"有没有事在等你"这一半绝不能跟着删**:折叠不得
 * 把例外藏掉,是本项目已确立的原则。
 *
 * 本地没有本体的行(第 4 源:库里记着是我分享的,这台电脑上没有文件)整句
 * 退回「这台电脑上没有这个技能的文件」——对这种行说它落在哪个区没有意义。
 */
export function whereSummary(skill: InstalledSkillView, remoteChanged: boolean): string[] {
  if (!skill.localPresent || !skill.body) return [t("detail.whereNotHere")];

  const parts = [t(SECTION_TITLE[skill.section])];
  if (remoteChanged) parts.push(t("detail.whereSummaryUpdate"));
  if (skill.review) parts.push(t("detail.whereReviewPending"));
  return parts;
}

/**
 * 详情面板里的「在哪」:一行折叠头(默认收起)+ 展开后的三块(v7.1 任务 3,Q2)。
 *
 * # 为什么默认收起
 *
 * Q1A 拍板「md 是主角」。三块位置信息此前恒占首屏一大半,正文被挤到折叠线以下
 * ——打开一个技能的详情,先看到的却不是它是什么。收起之后正文拿回 `flex:1`,
 * 位置信息压成一行:等宽路径 + 一句结论。
 *
 * 折叠状态记在 localStorage(`store/detail-collapse.ts`),与「我的技能」三区
 * 的折叠是两个 store、默认值相反,理由见那个文件的文档。
 *
 * # 可访问性
 *
 * 折叠头是 `<button>`,可访问名就是它的可见文字(路径 + 结论),**刻意不加
 * `aria-label`**;`aria-expanded` 跟实际展示态走,`aria-controls` 指向下面
 * 那个三块容器的 `id`(与 `MySkillsPage` 的 `SectionHeader` 同一套写法)。
 */
export function WhereBlocks({
  skill,
  agentNames,
  remoteChanged,
}: {
  skill: InstalledSkillView;
  agentNames: Map<string, string>;
  /** 「库里那一版变了没有」——调用方按 section 分流算好,见 {@link LibraryBlock}。 */
  remoteChanged: boolean;
}) {
  const expanded = useDetailCollapse((s) => s.whereExpanded);
  const toggle = useDetailCollapse((s) => s.toggleWhere);
  const bodyId = "detail-where-blocks";
  const summary = whereSummary(skill, remoteChanged).join(t("punct.middleDot"));

  return (
    <div className="px-5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={toggle}
        data-testid="where-toggle"
        className="grid w-full grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 border-t border-border py-2.5 text-left"
      >
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={15} className="mt-0.5 text-text-3" />
        <span className="min-w-0">
          {/* 🔴 没有本体时**不摆这一行**:`whereSummary` 对这类行返回的就是
              「这台电脑上没有这个技能的文件」,这里再拿它兜底就是同一句话上下
              叠两遍(展开后加上块 1 是三遍)。没有路径可显示时,结论行自己
              已经把这件事说清楚了。 */}
          {skill.body && (
            <span className="block truncate font-mono text-[12px] text-text" title={skill.body}>
              {skill.body}
            </span>
          )}
          <span className="mt-0.5 block truncate text-[11.5px] text-text-3">{summary}</span>
        </span>
      </button>
      {expanded && (
        <div id={bodyId} data-testid="where-blocks" className="border-t border-border">
          <ThisComputerBlock skill={skill} agentNames={agentNames} />
          <EachToolBlock skill={skill} agentNames={agentNames} />
          <LibraryBlock skill={skill} remoteChanged={remoteChanged} />
        </div>
      )}
    </div>
  );
}
