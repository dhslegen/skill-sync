import { useEffect, useState } from "react";

import { CreateSkillButton, CreateSkillPanel } from "@/components/CreateSkill";
import { ChipButton, PrimaryAction, rowMenuHandler } from "@/components/RowActionControls";
import { SkillIcon } from "@/components/SkillIcon";
import { SkillRowMenu, type SkillRowMenuItem } from "@/components/SkillRowMenu";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { skillReveal, type InstalledSkillView, type Section } from "@/lib/ipc";
import { buildRowMenuItems, needsAttention, rowAction, type RowAction } from "@/lib/ownership";
import { SHARE_BLOCK_LABEL, SHARE_DONE_LABEL, SHARE_FAILED_LABEL } from "@/lib/share-block";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { matchesMineQuery, useMineSearch } from "@/store/mine-search";
import {
  cardFor,
  groupBySource,
  hasUpdate,
  libraryAuthorFor,
  localDiffersNoBaseline,
  remoteChangedForShareable,
  sections,
  shareTargetRegistryId,
  shareTargetRepo,
  updateCount,
  useMySkills,
} from "@/store/my-skills";
import { useSession } from "@/store/session";
import { shareTargetKey, useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/**
 * 「我的技能」页(v7 任务 7 整页重画)。
 *
 * # 🔴 三区 = 三个**页签**(v7.2 需求 1,推翻了 v7 的"一页三区")
 *
 * 🔴 **v7.3 起页签只剩三个**:「项目里」已经挪进左侧边栏成为独立一页
 * (「项目里的技能」,见 `store/ui.ts::PageId`)。理由是那一行**混了两个轴**
 * ——前三个回答"与公司技能库的关系",「项目里」回答"装在哪",正交的两个问题
 * 排成一行,扫过去没有能串起来的逻辑,这才是用户说的"凌乱"的根。
 *
 * v7 把三个区竖着排在同一页里,v7.1 又给每个区加了折叠头。用户真机反馈是
 * 「目前不直观,滚动效率很低」——两个机制都在解同一个问题(一次只想看一个区),
 * 而竖排那条路无论怎么折叠都要先滚到那个区。所以这一版把三个区**并列成页签**,
 * 与原有的「项目里」一起是**四个**:安装自 / 已分享到 / 可分享到 / 项目里。
 * 分区折叠(`store/mine-collapse.ts` + `SectionHeader` + 吸顶那一套)**整套删除**
 * ——页签已经解决了"一次只看一区",留着就是两套并行机制。
 *
 * 🔴 **折叠时定下的那条原则原样转移到页签上**:未选中的页签必须写出里面有几个
 * "要处理",否则切到一个页签,另外两个里等着你的事就整个看不见了。判据仍是
 * `lib/ownership.ts::needsAttention`(**不是**页头总览那两个数——它们漏掉
 * conflict/chooseVersion/shareBlocked 三档;原先这里还写着第四档 `underReview`,
 * 那一档已随提交审核于 v8 任务 3 删除)。计数与总数都走**全量**
 * `list`、不走 `filteredList`:搜索只影响展示,页签上写的是这个区的事实。
 *
 * # 每行至多一颗主按钮
 *
 * 按公司技能库分:安装自 / 已分享到 / 可分享到(`core::ownership::Section`,
 * v7 任务 1-4 已埋好)。每一行**只讲一句"该做什么"**——判定表在
 * `src/lib/ownership.ts` 的 `rowAction`,十档穷尽(brief 九档 + R3 追加的
 * `pull`,`RowAction` 的字面量联合类型实测数下来是十种,不是十一种——档数订正
 * 见 `lib/ownership.test.ts`),`kind !== "none"` 时
 * 摆一颗主按钮,其余能做但不是当务之急的事(打开文件夹/移除/被压过一头的
 * 分享或更新)收进行尾的「更多」菜单(`SkillRowMenu`)。
 *
 * # 不再有状态字
 *
 * v6 二期那版每行都有一句「已同步」「库里有新版」这类状态文案——同一件事
 * 主按钮已经说得更清楚(有更新就摆「更新」,没有就什么都不摆),状态字是
 * 重复的第二遍。这一版整页删掉了它,连同支撑它的 `sharedState`/`SharedState`
 * 判定(v6 二期两分区页专用,唯一消费者就是这个旧页面)。
 *
 * # 🔴 两块区域,两种口径(v7.3 Q27-A / Q28-C / Q29-B)
 *
 * 判据一句话:**页签行是跨栏区域,放整页级的东西;列表上方是本栏区域,
 * 放本栏级的东西**。
 *
 * - **页签行**(`TabsRow`):三个页签 + 「全部更新 · N」+「新建技能」。
 *   后两颗都是**页面级动作**——「全部更新」跨三栏一起更新,数字写在按钮
 *   自己身上(点之前要知道会动几个)。N 只数**能被它一键处理的行**
 *   (`rowAction.kind === "update"`,与侧栏角标 `updateCount` 同一个集合)
 *   ——不含需要拍板的冲突行,也不含「可分享到」区"外源有新版"那颗自己的
 *   更新按钮(那颗走 per-row `pull`,`skill_install_batch` 一次只吃一对
 *   `registryId`/`repo`,协议上表达不出跨源批量,见 `my-skills.ts::updateAll`)。
 * - **列表上方**(`mine-section-bar`):「共 N 个技能」+ 这一栏的筛选态。
 *
 * 第 6/7 轮把这两者搞反过一次:整页汇总文字留在列表上方(于是在「可分享到」
 * 栏下说出"3 个有改动未分享"而那 3 个一个都不在这一栏),无辜的总数反被挪去
 * 页签行。本轮对调回来,并把那两段整页汇总文字**整个撤掉**——页签角标已经
 * **逐栏**报了"有几件事等你"且更精确(`needsAttention` 覆盖六档),那两段是
 * 同一批事实的冗余表达。
 *
 * # 🔴 行内不再摆工具勾组(与视觉基准对齐,不是遗漏)
 *
 * 设计画布的四块相关画板(`Main`/`Quiet`/`Empty`/`LoggedOut`)逐行核对过
 * ——没有一处渲染 checkbox。v6 二期版本每行都摆一份 `ToolChecks`("各个工具里"
 * 那一块),这一版把它整段收回详情面板:点开一行就是`一个技能,三个在哪`的完整
 * 三块(`WhereBlocks`,v7 任务 6 已经做好),含"各个工具里"那一份可勾选的
 * `ToolChecks`。列表行因此只回答"这一行现在该不该做点什么",不重复展示
 * "启用到了哪些工具"这件事——那件事仍然可达,只是要点进详情看。
 */
export function MySkillsPage() {
  const {
    list,
    loading,
    loadError,
    load,
    agentNames,
    askRemove,
    shareChanges,
    shareBusy,
    shareDone,
    shareError,
    setAgentsError,
    toolFailures,
    toolFailuresFor,
    dismissToolFailures,
    beginShare,
    pull,
    shareableIndexes,
    ensureShareableIndexes,
    updateAll,
    updateAllBusy,
    updateAllError,
    updateAllFailures,
    dismissUpdateAllFailures,
    alignStaleBaselines,
  } = useMySkills();
  const index = useStoreIndex((s) => s.index);
  const installPhase = useInstall((s) => s.phase);
  const activeSlug = useInstall((s) => s.dirSlug);
  const installShareResult = useInstall((s) => s.shareResult);
  const installError = useInstall((s) => s.error);
  const installPhaseIsError = installPhase === "error";
  const keepError = useMySkills((s) => s.keepError);
  const versionChoiceOpen = useMySkills((s) => s.versionChoice !== null);
  const setPage = useUi((s) => s.setPage);
  const sessionStatus = useSession((s) => s.status);
  const query = useMineSearch((s) => s.query);
  const [tab, setTab] = useState<Section>("installedFrom");
  // 🔴 v7.3 需求 6:点页签上的角标 = 切到那个页签 + **只看要处理的**。
  // 局部 state 而不是 store:它是"这一眼我想怎么看"的瞬时视角,不该跨页面/
  // 跨会话留存(留存的话用户下次打开会看到一个只剩三行的列表,而它明明有 8 个)。
  const [attentionOnly, setAttentionOnly] = useState(false);

  // 三级刷新的级别 2(切页):页面组件挂载时 load 一次。级别 1(窗口重获焦点)
  // 与级别 3(文件监听)是 `useLocalRefresh()` 的活,全局挂在 App.tsx,这里不重复。
  useEffect(() => {
    void load();
  }, [load]);

  // 更新流程结束后(done)刷新列表,状态才跟得上
  useEffect(() => {
    if (installPhase === "done") void load();
  }, [installPhase, load]);

  // 基线自愈(v8 任务 2,D3):列表与索引都在手上时,把「本地与库里已经一致、
  // 账上的基线却停在旧值」的那些行对齐一次——它们眼下永远显示「库里有新版」,
  // 那正是 v8 的起因:同事点分享一次次开出内容为空的审核请求,自己出不来。
  //
  // 重复触发是安全的:store 里按「库坐标 + 目录名 + 实时指纹」记着已经发过的行,
  // 同一份数据不会重复发(窗口重获焦点刷新、5 分钟兜底、StrictMode 双挂载都会
  // 让这个 effect 重跑)。失败静默,理由见 `alignStaleBaselines`。
  //
  // 🔴 那份去重记录是这条 effect 的**必要条件,不是优化**:对齐成功后
  // `alignStaleBaselines` 会 `load()`,而 `list` 一换这个 effect 就重跑。
  // 去掉去重之后本文件的测试直接**跑不完**(对齐 → load → 对齐 的死循环,
  // 注入验证实测),真机上就是这一页一直在发请求。
  useEffect(() => {
    void alignStaleBaselines(index);
  }, [list, index, alignStaleBaselines]);

  // 🔴 只读用户禁用态(v8 任务 3 / D8)要在**进这一页时**就知道,不能等到打开
  // 分享确认屏才探——行上的分享族按钮此刻就要画成禁用态。探一次就够(权限是
  // 仓库级的,不跟着"在看哪个技能"走),失败即 `unknown`、不禁任何按钮。
  // 🔴 **按这一行自己的库坐标探**(终审 I-4):权限是「(源, 技能库)」级的,
  // 而三区的行分享目标并不相同——「可分享到」恒推公司库,其余推账上那个库。
  // 一份全局结果套在所有行上,两种错法(该禁没禁 / 不该禁禁了)都是撒谎。
  const ensurePreviewFor = useShare((s) => s.ensurePreviewFor);
  const previews = useShare((s) => s.previews);
  useEffect(() => {
    for (const skill of list ?? []) {
      ensurePreviewFor(shareTargetRegistryId(skill), shareTargetRepo(skill, null));
    }
  }, [list, ensurePreviewFor]);
  // `unknown` 一律当"不知道",不禁——预检永远 fail-open(见 `SharePath`)。
  const noAccessFor = (skill: InstalledSkillView) =>
    previews[shareTargetKey(shareTargetRegistryId(skill), shareTargetRepo(skill, null))] ===
    "noAccess";

  // 🔴 需求 3:搜索**穿透页签**(三栏一起搜)。同一条原则在 v7.1 分区折叠时就
  // 定过——"搜索必须穿透折叠,否则'搜到了但那区折着',用户看到的就是搜索坏了";
  // 页签是同一个形状。搜索期间页签整行让位,换成「「xxx」的搜索结果」+ 按栏分组。
  const searching = query.trim() !== "";

  // 🔴 筛选与搜索互斥(需求 6 的技术约束):进搜索即清筛选。两个都开着的话,
  // 用户看到的是"搜索结果里还少了一半",而少的那一半没有任何提示。
  // **退出搜索不恢复**——所以这个 effect 只在 `searching` 为真时清,不做还原。
  useEffect(() => {
    if (searching) setAttentionOnly(false);
  }, [searching]);

  const [revealError, setRevealError] = useState<string | null>(null);
  const revealOrExplain = (path: string) => {
    setRevealError(null);
    void skillReveal({ path }).catch((e: unknown) =>
      setRevealError(
        typeof e === "object" && e && "message" in e
          ? String((e as { message: unknown }).message)
          : t("error.generic"),
      ),
    );
  };

  // 展示名 / 描述:安装自/已分享到走当前浏览的公司库索引(与既有 nameOf 同一个
  // 局限——那份索引只覆盖"当前浏览的那个库",见 CLAUDE.md);可分享到且有外部
  // 来源的行走它自己那个来源的索引(shareableIndexes,同一趟请求也用来判定
  // 「外源有没有新版」);纯本地草稿没有数据源,展示名退回 dirSlug、描述不摆
  // ——不编一个不存在的字段。
  // 判定本身在 `store/my-skills.ts::cardFor`(详情面板的概览行读同一份),
  // 这里只是把这一页的两个索引喂进去。
  const cardOf = (skill: InstalledSkillView) => cardFor(skill, index, shareableIndexes);
  const nameOf = (dirSlug: string) => {
    const skill = list?.find((s) => s.dirSlug === dirSlug);
    if (!skill) return index?.skills.find((s) => s.dirSlug === dirSlug)?.name ?? dirSlug;
    return cardOf(skill)?.name ?? dirSlug;
  };

  if (!list && loading) {
    return <p className="py-6 text-[12.5px] text-text-3">{t("mine.loading")}</p>;
  }
  if (!list && loadError) {
    // 读不到 ≠ 没装任何技能:失败要正面说,不能画成空状态
    return (
      <div className="py-6">
        <p className="text-[12.5px] text-text-2">
          {t("mine.loadFailed")}
          {t("punct.labelSeparator")}
          {loadError.message}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2.5 h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("mine.retry")}
        </button>
      </div>
    );
  }
  if (!list) return null;

  // 判定用**全量** list(搜索只影响展示,不影响"有没有事要做"这件事本身)
  const secAction = (skill: InstalledSkillView): RowAction => {
    const remoteChanged =
      skill.section === "shareable"
        ? remoteChangedForShareable(skill, shareableIndexes)
        : hasUpdate(skill, index);
    return rowAction(skill, remoteChanged, noAccessFor(skill));
  };
  // 🔴 v7.3 Q28-C:整页口径的那两段文字(「N 个有更新 · N 个有改动未分享」)已撤掉
  // ——页签角标**逐栏**报了"有几件事等你"且更精确(`needsAttention` 覆盖六档),
  // 整页汇总是同一批事实的冗余表达。`unsyncedCount` 随之没有消费者,一并删除。
  // `updatesCount` 留着,因为「全部更新 · N」那颗按钮要把数字写在自己身上
  // ——点之前应当知道会动几个。
  const updatesCount = updateCount(list, index);

  // 每行的 `rowAction` 对**全量** list 只算一轮,渲染、分区排序与折叠头的计数
  // 共用这一份——分开各算一遍就是本项目记录的空转模式 #1(同一条规则查两遍)。
  const actionOf = new Map(list.map((s) => [s.dirSlug, secAction(s)] as const));
  const actionFor = (skill: InstalledSkillView): RowAction =>
    actionOf.get(skill.dirSlug) ?? secAction(skill);

  const filteredList = list.filter((s) => matchesMineQuery(s, nameOf(s.dirSlug), query));
  const secs = sections(filteredList, actionFor);

  // 🔴 这两个数走**全量** list,不走 filteredList:搜索只影响展示,
  // "这个区一共有多少 / 其中几个要处理"是这个区的事实,搜索时按筛选后的条数
  // 报数就成了假话(与页头总览 band 同一个口径,见上面那两个计数)。
  // ⚠️ v7.3 Q19-C 起 `total` 的渲染点不在页签上了,而在总览行行首;`attention`
  // 仍是页签角标。两个数由**同一个** statsOf 出,别再各算一遍(空转模式 #1)。
  const statsOf = (key: Section) => {
    const rows = list.filter((s) => s.section === key);
    return {
      total: rows.length,
      attention: rows.filter((s) => needsAttention(actionFor(s))).length,
    };
  };

  // 当前页签要渲染的那一区(`sections()` 会把空区整个滤掉,所以这里可能是
  // undefined——页签是常驻的,那一档要有自己的空态文案,见 TAB_EMPTY)。
  const activeSec = secs.find((s) => s.key === tab);
  // 筛选态只**在展示层**收窄这一页签的行,不影响页签上写的两个数(那是事实)。
  const activeItems = activeSec
    ? attentionOnly
      ? activeSec.items.filter((s) => needsAttention(actionFor(s)))
      : activeSec.items
    : [];

  const changeTab = (next: Section) => {
    setTab(next);
    // 🔴 切页签即清筛选(需求 6):否则切到一个没有待办的页签会看到空列表,
    // 而它明明有 8 个技能,用户第一反应是"东西呢"。
    setAttentionOnly(false);
  };
  const toggleAttention = (key: Section) => {
    if (tab === key) setAttentionOnly((v) => !v);
    else {
      setTab(key);
      setAttentionOnly(true);
    }
  };

  /** 一个区的行:「可分享到」按来源分组,其余平铺。两条路共用 `renderRow`。 */
  const renderItems = (key: Section, items: InstalledSkillView[]) =>
    key === "shareable" ? (
      /* 🔴 需求 4:无来源那一组**不摆标题**,顶格排最前(`groupBySource` 已经
         把 `label === null` 排在最前面)。它是**默认档**——给"正常情况"起名字
         反而暗示它异常,与 v7「只写例外」是同一条原则。 */
      groupBySource(items).map((group) => (
        <section key={group.key} className="mt-3 first-of-type:mt-0">
          {group.label !== null && (
            <h3 className="pb-1.5 text-[11.5px] font-medium text-text-3">
              <span className="font-mono">{t("mine.sourceLabel", { label: group.label })}</span>
            </h3>
          )}
          <RowCard>{group.items.map(renderRow)}</RowCard>
        </section>
      ))
    ) : (
      <RowCard>{items.map(renderRow)}</RowCard>
    );

  // 一行的渲染(平铺与「按来源分组」两条路共用同一份——分开各写一遍就是
  // 本项目记录的空转模式 #1 的变体:两处会各自漂)。
  const renderRow = (skill: InstalledSkillView) => {
    const remoteChanged =
      skill.section === "shareable"
        ? remoteChangedForShareable(skill, shareableIndexes)
        : hasUpdate(skill, index);
    // 🔴 C3 修复(v7 任务 7 修复轮 1):没有安装基线的行,`rowAction` 从不读
    // `localHash`——两方指纹直接比,只影响「更多」菜单要不要多一条
    // 「改用库里的版本」,不进判定表。
    const noBaselineDiffers = localDiffersNoBaseline(skill, index);
    return (
      <Row
        key={skill.dirSlug}
        skill={skill}
        name={nameOf(skill.dirSlug)}
        description={cardOf(skill)?.description ?? null}
        action={rowAction(skill, remoteChanged, noAccessFor(skill))}
        remoteChanged={remoteChanged}
        noBaselineDiffers={noBaselineDiffers}
        noWriteAccess={noAccessFor(skill)}
        libraryAuthor={libraryAuthorFor(skill, index)}
        pulling={activeSlug === skill.dirSlug && installPhase === "running"}
        sharing={shareBusy === skill.dirSlug}
        onPull={() => void pull(skill.dirSlug)}
        onShareChanges={() => void shareChanges(skill.dirSlug, nameOf(skill.dirSlug))}
        onShare={() => beginShare(skill.dirSlug)}
        onRemove={() => askRemove(skill.dirSlug)}
        onReveal={revealOrExplain}
        onOpenDetail={() => {
          // 本地没有本体(换电脑后「已分享到」里只在库里的行):内容从库索引取,
          // 不去读一个不存在的本地文件夹(2026-09-14 真机,见 `openFromLibrary`)。
          if (!skill.localPresent && skill.registryId && skill.sourceOwner && skill.sourceRepo) {
            void useLocalDetail.getState().openFromLibrary({
              dirSlug: skill.dirSlug,
              registryId: skill.registryId,
              repo: `${skill.sourceOwner}/${skill.sourceRepo}`,
            });
          } else {
            void useLocalDetail
              .getState()
              .open(skill.body ? { path: skill.body } : { dirSlug: skill.dirSlug });
          }
          // 🔴 I3(用户拍板)+ 修复轮 2 订正:点击是"立即查"这一半的触发点
          // ——只对这一行自己的外部来源发请求,不碰其余行。
          // shareableSourceKey 为 null(非 shareable 区/纯本地草稿)时
          // ensureShareableIndexes 自己会跳过,这里不必先判一遍。
          void ensureShareableIndexes([skill.dirSlug]);
        }}
      />
    );
  };

  return (
    <div>
      {/* 🔴 M2(复审)+ v7.3 Q27-A:页头不另起一行摆计数——「共 N 个技能」是本栏
          口径,归**列表上方**那一行(`mine-section-bar`);页签行上放的是页面级
          动作(「全部更新 · N」「新建技能」)。空态那一档不同:它自己的 CTA 行
          已经有「新建技能」,TabsRow 不重复摆一份。 */}
      {searching ? (
        <SearchHeader query={query} />
      ) : (
        <TabsRow
          tab={tab}
          attentionOnly={attentionOnly}
          onChange={changeTab}
          onToggleAttention={toggleAttention}
          statsOf={statsOf}
          updatesCount={updatesCount}
          updateAllBusy={updateAllBusy}
          onUpdateAll={() => void updateAll()}
          showCreate={list.length > 0}
        />
      )}
      <CreateSkillPanel />

      {list.length === 0 ? (
        <div className="py-6">
          <p className="text-[12.5px] text-text-2">{t("mine.empty")}</p>
          <p className="mt-1 text-[12.5px] text-text-3">{t("mine.emptyHint")}</p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage("store")}
              className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("mine.emptyCta")}
            </button>
            <CreateSkillButton />
          </div>
        </div>
      ) : (
        <div>
          {/* 🔴 M7(复审,记录不改):这个横幅与 WhereBlocks.tsx(详情面板)的
              EachToolBlock 各自渲染一份"勾选失败"——不是漏删的重复。design §13
              把这类反馈挪进了详情面板,但那个前提是"用户点开了详情"；
              `confirmRemove`/`keepVersion` 两条路的失败(`toolFailuresFor` 恒
              为 null)**没有**对应的详情面板入口——它们是"移除"/"留哪一份"
              这两个页面级动作的失败,不是某个技能详情里的事。如果只留详情面板
              那一份,这两类失败会回到终审 C-1/I-1 修过的"零渲染点"状态。
              所以这里保留双份:有 `toolFailuresFor`(setAgents 来源)时两处都会
              显示同一件事(轻微冗余,但用户从哪条路径看到都不奇怪);无归属时
              只有这里显示。 */}
          {/* 🔴 勾选的部分失败必须有渲染点(见 my-skills.ts 模块头)。 */}
          {toolFailures && (
            <ToolFailuresBanner
              failures={toolFailures}
              failuresFor={toolFailuresFor}
              agentNames={agentNames}
              nameOf={nameOf}
              onDismiss={dismissToolFailures}
              onReveal={revealOrExplain}
            />
          )}
          {revealError && <ErrorLine label={t("mine.openFolderFailed")} detail={revealError} />}
          {setAgentsError && (
            <ErrorLine
              label={toolFailuresFor ? t("mine.toolsFailedFor", { name: nameOf(toolFailuresFor) }) : t("mine.toolsFailed")}
              detail={setAgentsError.message}
            />
          )}
          {/* 文案按 `flow` 分流:首次分享说不带"改动"的那句,推回改动才说"改动"
              (终审复审轮 1 #3;判据与详情面板动作区共用同一张表,不各写一份)。 */}
          {shareError && (
            <ErrorLine
              label={t(SHARE_FAILED_LABEL[shareError.flow])}
              detail={shareError.error.message}
            />
          )}
          {shareDone && (
            <p className="pb-2 text-[12px] text-text-2">
              {t(SHARE_DONE_LABEL[shareDone.flow][shareDone.mode])}
            </p>
          )}
          {keepError && !versionChoiceOpen && (
            <ErrorLine label={t("mine.keepFailed")} detail={keepError.message} />
          )}
          {installPhaseIsError && installError && activeSlug && (
            <ErrorLine label={t("mine.pullFailed", { name: nameOf(activeSlug) })} detail={installError.message} />
          )}
          {/* ⚠️ 这一份**不带 flow**,也不需要:`useInstall.shareResult` 的两条写入
              路径都走 `skill_share_changes`(「保留并分享」的前提就是"库里有新版、
              你改过本体"),恒是"推回改动"那一档。别顺手"统一"成上面那张表。 */}
          {installShareResult &&
            ("error" in installShareResult ? (
              <ErrorLine label={t("mine.shareChangesFailed")} detail={installShareResult.error.message} />
            ) : (
              <p className="pb-2 text-[12px] text-text-2">
                {t(SHARE_DONE_LABEL.changes[installShareResult.mode])}
              </p>
            ))}
          {updateAllError && <ErrorLine label={t("mine.updateAllFailed")} detail={updateAllError.message} />}
          {updateAllFailures && (
            <div className="mb-2 rounded-card border border-[#c0392b]/40 px-2.5 py-2 dark:border-[#e0705f]/40">
              <p className="text-[12px] font-medium text-[#c0392b] dark:text-[#e0705f]">
                {t("mine.updateAllPartialFailed", { count: updateAllFailures.length })}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {updateAllFailures.map((f) => (
                  <li key={f.dirSlug} className="text-[11.5px] text-text-2">
                    {nameOf(f.dirSlug)}
                    {t("punct.labelSeparator")}
                    {f.message}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={dismissUpdateAllFailures}
                className="mt-1.5 h-6 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
              >
                {t("mine.dismiss")}
              </button>
            </div>
          )}

          {/* 🔴 未登录提示只在「安装自技能库」页签下摆:这句话解释的是
              **安装自 vs 已分享到这对区分**为什么需要登录(v7 终审 M-8 已经
              查明它贴在草稿那一区标题下毫无意义)。页签化之后判据变简单了
              ——就是"用户正在看那一个页签"。 */}
          {tab === "installedFrom" && sessionStatus !== "signedIn" && (
            <p className="pb-1.5 text-[11.5px] text-text-3">{t("mine.signedOutHint")}</p>
          )}

          {/* 🔴 需求 3:搜索态整页按栏分组渲染**全部**命中,与当前页签无关。
              `sections()` 吃的已经是筛过的 `filteredList`,空区它自己会滤掉,
              所以这里拿到的三组就是"哪些栏里有命中"。零命中才说那句
              「没有匹配的技能」——而不是像页签态那样只报当前这一栏。 */}
          {searching ? (
            secs.length === 0 ? (
              <p className="py-6 text-[12.5px] text-text-3">{t("mine.searchEmpty", { query })}</p>
            ) : (
              secs.map((sec) => (
                <section key={sec.key} className="mt-4 first-of-type:mt-0">
                  <h3 className="pb-1.5 text-[12px] font-[550] text-text-2">{sec.title}</h3>
                  {renderItems(sec.key, sec.items)}
                </section>
              ))
            )
          ) : (
            <>
              {/* 🔴 v7.3 Q27-A / Q29-B:列表上方这一行是**本栏区域**,只放"关于当前
                  这一栏的话"——总数,以及这一栏的筛选态。判据一句话:**页签行是跨栏
                  区域,放整页级的东西;列表上方是本栏区域,放本栏级的东西**。
                  第 6/7 轮把这两者搞反了(整页口径的「N 个有更新 · N 个有改动未分享」
                  留在这里,于是在「可分享到」栏下说出"3 个有改动未分享"而那 3 个一个
                  都不在这一栏;无辜的「共 N 个」反倒被挪去了页签行),本轮对调回来。

                  两处刻意的例外:①**搜索态整行不摆**——列表是跨栏命中,"共 N 个"
                  指谁都不对(这一整段就在 `!searching` 分支里);②**空页签不摆总数**
                  ——下面已经是空态文案,「共 0 个技能」纯属噪音。

                  筛选态是第二处印证(需求 6):角标的按下态说明"是谁在起作用",
                  这一行给出口。只靠角标太隐蔽——列表突然只剩 3 行,用户未必知道
                  自己在筛选态、更未必知道怎么退。 */}
              {(activeSec !== undefined || attentionOnly) && (
                <div
                  data-testid="mine-section-bar"
                  className="flex items-center gap-1.5 pb-2 text-[12px] text-text-3"
                >
                  {activeSec && (
                    <span data-testid="mine-total">
                      {t("mine.overviewTotal", { count: statsOf(tab).total })}
                    </span>
                  )}
                  {attentionOnly && (
                    <>
                      {activeSec && <span aria-hidden>·</span>}
                      <span>{t("mine.filterAttention")}</span>
                      <span aria-hidden>·</span>
                      <button
                        type="button"
                        onClick={() => setAttentionOnly(false)}
                        className="font-medium text-accent underline decoration-dotted underline-offset-2 hover:opacity-80"
                      >
                        {t("mine.filterShowAll")}
                      </button>
                    </>
                  )}
                </div>
              )}
              {!activeSec ? (
                <TabEmpty
                  tab={tab}
                  onGoStore={() => setPage("store")}
                  showCreate={list.length > 0}
                />
              ) : activeItems.length === 0 ? (
                /* 筛选开着、但这一栏的待办已经被处理光了。这一档不能画成
                   "这个分类是空的"——它明明有行,只是被筛掉了(那才是撒谎)。
                   🔴 **出路不在这里,在上面那行**:`attentionOnly` 为真时
                   「只看要处理的 · 显示全部」恒在,再摆第二颗一模一样的按钮是重复。
                   而这一档恰恰是**角标已经消失**的时刻(`attention` 归 0 就不渲染
                   角标了),上面那颗「显示全部」是退出筛选态的仅存入口——它与这句
                   说明必须同屏,有测试正面钉住这一点。 */
                <p className="py-6 text-[12.5px] text-text-3">{t("mine.filterEmpty")}</p>
              ) : (
                renderItems(tab, activeItems)
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 行卡片容器(一张卡里若干行)。 */
function RowCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface-1">{children}</div>
  );
}

/** 每个页签自己的空态文案。三区各说各的事实,不用一句笼统的"这里没有技能"。 */
const TAB_EMPTY: Record<Section, MessageKey> = {
  installedFrom: "mine.tabEmptyInstalledFrom",
  sharedTo: "mine.tabEmptySharedTo",
  shareable: "mine.tabEmptyShareable",
};

/**
 * 这个页签在**全量** list 里就是空的时候说的话(共识 §7)。
 *
 * 两条既有原则:**每条都给一个出路**(不是只说"空的");**不解释状态、只说下一步**。
 * 「安装自」给「去技能商店看看」,「可分享到」给「新建技能」(复用既有的
 * `CreateSkillButton`,不另造一颗);「已分享到」的出路是一句指路
 * ——它没有对应的一键动作,分享要先有技能,所以文案直接告诉用户去哪儿分享。
 *
 * 🔴 **"搜了但这个页签里没匹配上"那一档已经删掉**:v7.3 起搜索**穿透页签**
 * (整行让位、按栏分组),不存在"在 A 页签搜 B 页签里的技能"这种场景了,
 * 连带 `mine.searchOtherTabs`(「其他分类里有 N 个匹配」)这个键也一并撤销。
 */
function TabEmpty({
  tab,
  onGoStore,
  showCreate,
}: {
  tab: Section;
  onGoStore: () => void;
  /** 页签行是不是已经摆着一颗「新建技能」了(列表非空时它就在)。摆着就别再摆
   *  第二颗——同屏两颗一模一样的按钮是噪音,而"给一个出路"这条已经满足了。 */
  showCreate: boolean;
}) {
  return (
    <div className="py-6">
      <p className="text-[12.5px] text-text-3">{t(TAB_EMPTY[tab])}</p>
      {tab === "installedFrom" && (
        <button
          type="button"
          onClick={onGoStore}
          className="mt-2.5 h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("mine.tabEmptyInstalledFromCta")}
        </button>
      )}
      {tab === "shareable" && !showCreate && (
        <div className="mt-2.5">
          <CreateSkillButton />
        </div>
      )}
    </div>
  );
}

/** 搜索态的页签行替身(需求 3):页签整行让位,只说"这是谁的搜索结果"。 */
function SearchHeader({ query }: { query: string }) {
  return (
    <div className="mb-2.5 flex h-7 items-center border-b border-border pb-2.5">
      <p className="min-w-0 truncate text-[12.5px] font-[550]">
        {t("mine.searchResults", { query })}
      </p>
    </div>
  );
}

const TAB_ORDER: { key: Section; title: MessageKey }[] = [
  // 三区顺序与 `my-skills.ts::SECTION_TITLES` 一致(design 根决策 #2),
  // 标题也复用同一批键——两份标题各写一份必然漂。
  { key: "installedFrom", title: "mine.sectionInstalledFrom" },
  { key: "sharedTo", title: "mine.sectionSharedTo" },
  { key: "shareable", title: "mine.sectionShareable" },
];

/**
 * 页签行(v7.3 需求 2 + 6 重画,Q19-C / Q20-A 再收,Q27-A/Q28-C 定下这一行的职责)。
 *
 * # 这一行是**跨栏区域**:三个页签 + 页面级动作
 *
 * 右侧只摆**整页口径**的东西——「全部更新 · N」与「新建技能」。本栏口径的
 * 「共 N 个技能」不在这里,它归列表上方那一行(`mine-section-bar`)。
 * 第 7 轮曾把总数摆在这里,Q27-A 已纠正;**别再往这一行加回本栏级的数**。
 *
 * # 形态 = 名字 + 橙色实心角标(仅 >0)
 *
 * 🔴 **撤掉了所有 `·` 分隔符与「个要处理」四个字**:凌乱的直接来源就是它们
 * ——每个页签因此变成一句话(「可分享到技能库 · 41 · 1 个要处理」),三句话
 * 并排,扫过去只能逐字读。
 *
 * 🔴 **Q19-C 又把总数也拿走了**(推翻第 3 轮"总数留在页签上"):`名字 6 3` 这种
 * 两个裸数字并排,没有任何标签说明谁是谁,而且 `3 < 6` 会被读成"第 6 项 / 第 3 项"。
 * 总数搬去**列表上方**那一行(`mine-section-bar`),那里有文字作语境、语义也对
 * ——它是关于当前这一栏的话。页签上只剩**一个**数字,它的含义由形态本身说明:
 * 实心橙小块 = 这一栏里要你动手的条数。
 * 角标在激活页签(浅橙底)里仍然是**实心强调色 + 白字**——同色相的弱底上放弱色
 * 数字会糊成一团。
 *
 * # 🔴 Q20-A:接近性靠**纯间距**,不靠分隔线也不靠底色
 *
 * "看起来像 6 块而不是 3 块"的根因是页签**内部**(名字↔角标)与页签**之间**的
 * 间距差不多,眼睛就按等距切成六份。所以内部 `gap-1`(4px)、之间 `gap-5`(20px),
 * 五倍差。⚠️ **别拿分隔线/底色去补**:那是用装饰还间距的账,而且会让这一行更密
 * ——"密"正是用户最初的抱怨。
 *
 * # 🔴 角标本身可点(需求 6):点它 = 切到这个页签 + 只看要处理的
 *
 * 技术约束:**不做 `button` 套 `button`**(HTML 不允许)。所以每个页签是一个
 * `div`(`role="presentation"`),名字那颗挂 `role="tab"`,角标那颗是独立按钮、
 * 有自己的 `aria-label`(「只看「安装自技能库」里要处理的 3 个」)——两颗都能
 * 用键盘分别到达。按下态用与 Toolbar 强调色圆点同款的 ring(`aria-pressed`
 * + 双层 shadow 描边),不是新造一套样式,也不是 glow。
 *
 * 「项目里」已经不在这一行(v7.3 挪进侧边栏),所以这里不再有"没有计数的第四档"。
 */
function TabsRow({
  tab,
  attentionOnly,
  onChange,
  onToggleAttention,
  statsOf,
  updatesCount,
  updateAllBusy,
  onUpdateAll,
  showCreate,
}: {
  tab: Section;
  attentionOnly: boolean;
  onChange: (tab: Section) => void;
  onToggleAttention: (tab: Section) => void;
  /** 只读 `attention`(角标)——总数是**本栏**口径,归列表上方那一行,
   *  别再往这里加回一个 `total`(Q27-A 就是在纠正那一步)。 */
  statsOf: (key: Section) => { attention: number };
  /** 整页有几个技能能被「全部更新」一键处理。0 时那颗按钮整个不摆。 */
  updatesCount: number;
  updateAllBusy: boolean;
  onUpdateAll: () => void;
  /** 只在列表非空时给 true——空态自己的 CTA 行已经有「新建技能」,
   *  这里不重复摆一份(design #16:「新建技能」紧跟在页签之后)。 */
  showCreate: boolean;
}) {
  return (
    <div
      data-testid="mine-tabs-row"
      className="mb-2.5 flex items-center justify-between gap-2 border-b border-border pb-2.5"
    >
      {/* 🔴 窄窗口下页签行要**横向滚动**,不能挤:`min-w-0` 让它真的能收缩,
          页签自己 `shrink-0 whitespace-nowrap` 保持完整。高度写在**外层 div**
          上(不是那颗 `role="tab"` 的按钮上),里面的文字与角标都靠
          `items-center` 居中——v7.2 把 `h-7` 写死在按钮上,文字一挤就在 28px
          里换行、上下被切掉。 */}
      <div role="tablist" className="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto">
        {TAB_ORDER.map(({ key, title }) => {
          const stats = statsOf(key);
          const active = tab === key;
          const filtering = active && attentionOnly;
          return (
            <div
              key={key}
              role="presentation"
              className={cn(
                // gap-1 = 4px:页签内部(名字↔角标)必须明显紧于页签之间的
                // gap-5 = 20px,否则六个元素等距排开,读成六块(Q20-A)。
                "flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-ctl",
                stats.attention > 0 ? "pl-2.5 pr-1.5" : "px-2.5",
                active && "bg-accent-soft",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onChange(key)}
                className={cn(
                  "whitespace-nowrap text-[12.5px]",
                  active ? "font-[550] text-accent" : "font-[450] text-text-2 hover:text-text",
                )}
              >
                {t(title)}
              </button>
              {stats.attention > 0 && (
                <button
                  type="button"
                  data-testid={`tab-badge-${key}`}
                  aria-pressed={filtering}
                  aria-label={t(
                    filtering ? "mine.tabAttentionFilterOff" : "mine.tabAttentionFilter",
                    { section: t(title), count: stats.attention },
                  )}
                  onClick={() => onToggleAttention(key)}
                  className={cn(
                    "min-w-[16px] rounded-[4px] bg-accent px-1 text-center font-mono text-[10.5px] leading-4 text-white hover:opacity-90",
                    filtering && "shadow-[0_0_0_1.5px_var(--bg),0_0_0_3px_var(--text-3)]",
                  )}
                >
                  {stats.attention}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* 🔴 Q27-A / Q28-C:「全部更新」是**整页**口径的动作(它跨三栏一起更新),
          所以它属于**页签行这个跨栏区域**,而不是某一栏的列表上方——摆在后者就等于
          在「可分享到」栏下说一句关于另外两栏的话。数字挂在按钮自己身上
          (「全部更新 · 1」):点之前应当知道会动几个,而这是最省地方的说法。
          原先那两段整页汇总文字(「N 个有更新 · N 个有改动未分享」)已撤掉
          ——页签角标逐栏报得更精确,那两段是同一批事实的冗余表达。
          🔴 **行为一个字没动**:仍是整页口径、仍走 `updateAll()`。
          摆在「新建技能」**左侧**:后者常驻,让它保持最右锚点,免得这颗按钮
          出现/消失时把用户的点击目标挪来挪去。 */}
      {updatesCount > 0 && (
        <ChipButton disabled={updateAllBusy} onClick={onUpdateAll}>
          {updateAllBusy ? t("mine.updating") : t("mine.updateAll", { count: updatesCount })}
        </ChipButton>
      )}
      {/* ⚠️ 不给它包一层容器:有一条测试正面钉住「新建技能」与 tablist 是**同一个
          父容器下的兄弟节点**(design #16)。 */}
      {showCreate && <CreateSkillButton />}
    </div>
  );
}

function ErrorLine({ label, detail }: { label: string; detail: string }) {
  return (
    <p className="pb-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
      {label}
      {t("punct.labelSeparator")}
      {detail}
    </p>
  );
}

/** 勾选工具的部分失败横幅(逐字沿用 v6 二期任务 6/9 的既有渲染,只是从组件正文
 *  抽了出来,减少 MySkillsPage 正文的长度)。 */
function ToolFailuresBanner({
  failures,
  failuresFor,
  agentNames,
  nameOf,
  onDismiss,
  onReveal,
}: {
  failures: NonNullable<ReturnType<typeof useMySkills.getState>["toolFailures"]>;
  failuresFor: string | null;
  agentNames: Map<string, string>;
  nameOf: (dirSlug: string) => string;
  onDismiss: () => void;
  onReveal: (path: string) => void;
}) {
  const isRealFailure = failures.some((f) => f.kind !== "differs");
  const title = failuresFor
    ? isRealFailure
      ? t("mine.toolsPartialFailedFor", { name: nameOf(failuresFor), count: failures.length })
      : t("mine.toolsNeedLookFor", { name: nameOf(failuresFor), count: failures.length })
    : isRealFailure
      ? t("mine.toolsPartialFailed", { count: failures.length })
      : t("mine.toolsNeedLook", { count: failures.length });

  return (
    <div className="mb-2 rounded-card border border-[#c0392b]/40 px-2.5 py-2 dark:border-[#e0705f]/40">
      <p className="text-[12px] font-medium text-[#c0392b] dark:text-[#e0705f]">{title}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {failures.map((f, i) => (
          <li
            key={`${f.kind === "location" ? f.path : (f.agent ?? "-")}-${i}`}
            className="text-[11.5px] text-text-2"
          >
            {f.kind === "differs" ? (
              (() => {
                const tool = f.agent ? (agentNames.get(f.agent) ?? f.agent) : t("mine.toolCanonical");
                return (
                  <>
                    <span>{t("mine.toolOccupied", { tool })}</span>
                    <button
                      type="button"
                      aria-label={t("mine.openFolderOf", { tool })}
                      onClick={() => onReveal(f.existing)}
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
        onClick={onDismiss}
        className="mt-1.5 h-6 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
      >
        {t("mine.dismiss")}
      </button>
    </div>
  );
}

/**
 * 「我的技能」的一行。
 *
 * # 主按钮由 `rowAction.kind` 唯一决定
 *
 * 判定表在 `src/lib/ownership.ts`;这里只管把每一档翻译成一颗按钮(或者
 * `shareBlocked`/`noWriteAccess` 那两档:同一颗按钮的禁用形态 + 一句说明)。
 * 🔴 **主按钮永远不带 `aria-label`**(靠自己的可见文字当可访问名),
 * 「更多」的触发按钮永远带 `aria-label`——`MySkillsPage.test.tsx` 那条
 * "每行至多一颗主按钮"测试按这条规则过滤,写错了测试会连带失真。
 *
 * # 名称区整块可点开详情,动作按钮在它外面
 *
 * 两组按钮是**兄弟节点**,不是嵌套关系——点开详情的按钮不包含任何动作按钮,
 * 天然不存在"点动作按钮会不会也触发详情"的冒泡问题,不需要 `stopPropagation`
 * 这类容易被遗漏的防御。
 */
function Row({
  skill,
  name,
  description,
  action,
  remoteChanged,
  noBaselineDiffers,
  noWriteAccess,
  libraryAuthor,
  pulling,
  sharing,
  onPull,
  onShareChanges,
  onShare,
  onRemove,
  onReveal,
  onOpenDetail,
}: {
  skill: InstalledSkillView;
  name: string;
  description: string | null;
  action: RowAction;
  remoteChanged: boolean;
  /** C3 修复:没有安装基线,但本体现在的内容与库里那一版不一样。 */
  noBaselineDiffers: boolean;
  /** 对目标技能库没有写权限(D8)。「…」菜单也要据此收窄,见 `buildRowMenuItems`。 */
  noWriteAccess: boolean;
  /** 库里登记的作者(v8 任务 6):`differsFromLibrary` 那一档提示"请联系谁"。
   *  `null` = 库里没登记,只说"和库里的不一样",不编名字。 */
  libraryAuthor: string | null;
  pulling: boolean;
  sharing: boolean;
  onPull: () => void;
  onShareChanges: () => void;
  onShare: () => void;
  onRemove: () => void;
  onReveal: (path: string) => void;
  onOpenDetail: () => void;
}) {
  const openVersions = useMySkills((s) => s.versionChoice);
  const setVersionChoice = useMySkills.setState;

  // 🔴 终审 §12:菜单**判定**(摆哪几项、什么文案)搬进 `lib/ownership.ts` 的
  // `buildRowMenuItems`,详情面板的动作区共用同一份——这里只把 `kind` 翻成
  // 这一行自己的回调。分开各写一份判定正是本项目记录的空转测试模式 #1。
  const menuItems: SkillRowMenuItem[] = buildRowMenuItems(
    skill,
    action,
    remoteChanged,
    noBaselineDiffers,
    noWriteAccess,
  ).map((spec) => ({
    key: spec.kind,
    label: t(spec.labelKey),
    title: spec.titleKey ? t(spec.titleKey) : undefined,
    separatorBefore: spec.separatorBefore,
    onClick: rowMenuHandler(spec.kind, { onReveal: () => onReveal(skill.body), onShareChanges, onPull, onShare, onRemove }),
  }));

  return (
    <div data-testid={`row-${skill.dirSlug}`} className="border-t border-border px-3.5 py-2.5 first:border-t-0">
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid={`row-${skill.dirSlug}-body`}
          // 🔴 必须带 aria-label,不能靠可见文字(名字)当可访问名:
          // 屏幕阅读器用户点一个只念得出技能名字的按钮,分不清它是"打开详情"
          // 还是别的动作。这也是"每行至多一颗**不带 aria-label** 的按钮"这条
          // 测试契约的另一半——主按钮靠可见文字当可访问名,这颗靠 aria-label,
          // 两者不能都不带、也不能都带,否则那条测试数不出"恰好一颗主按钮"。
          aria-label={t("mine.openDetail", { name })}
          onClick={onOpenDetail}
          className="group flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <SkillIcon name={name} className="size-[26px] rounded-[6px] text-[12px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-[550] group-hover:text-accent">{name}</span>
              {skill.sourceRemoved && (
                <Badge title={t("mine.badgeSourceRemovedHint")}>{t("mine.badgeSourceRemoved")}</Badge>
              )}
              {skill.libraryRemoved && (
                <Badge title={t("mine.badgeLibraryRemovedHint")}>{t("mine.badgeLibraryRemoved")}</Badge>
              )}
            </div>
            {/* ⚠️ v7.2 需求 4:行内那一行等宽来源标签**已经删掉**——「可分享到」
                页签现在按来源分组,来源写在组头上(同样是等宽,UI 硬规则
                "等宽字体展示 slug/路径/sha"的落点从行搬到了组头)。两处都写就是
                同屏两遍同样的字符串。其余两个页签本来就不摆来源。 */}
            {description && <div className="mt-0.5 truncate text-[11.5px] text-text-3">{description}</div>}
            {/* 🔴 v7.1 任务 5:校验没过的说明是**文本列里的第三行小字**,不是横跨
                整行的描边大框。画布 `Main.dc.html` 的 polyglot 行就长这样:
                `margin-top:2px; font-size:11.5px; color:#9a6c00`,无边框无底色。
                它是"为什么这颗按钮点不动"的注解,跟着名字与简介走;做成大框会让
                一行普通技能凭空长到两倍高,把整页的密度带垮。 */}
            {action.kind === "shareBlocked" && (
              <div className="mt-0.5 text-[11.5px] leading-[1.5] text-[#9a6c00] dark:text-[#d4a017]">
                {t(SHARE_BLOCK_LABEL[action.reason])}
              </div>
            )}
            {/* 🔴 v8 任务 6 / D7:「和库里的不一样」。这一档**没有主按钮**,这句话
                就是这一行全部的可见性——不摆的话,用户看到的是一行什么都没有的
                技能,而他明明改过它。作者名取自索引里已有的归因数据(零新增查询);
                **取不到就只说"不一样"**,绝不编一个名字出来(公司库里那个叫
                「测试」的技能就是这一档)。 */}
            {action.kind === "differsFromLibrary" && (
              <div className="mt-0.5 text-[11.5px] leading-[1.5] text-[#9a6c00] dark:text-[#d4a017]">
                {t("mine.differsFromLibrary")}
                {libraryAuthor && (
                  <span className="ml-1.5">
                    {t("mine.differsFromLibraryAuthor", { author: libraryAuthor })}
                  </span>
                )}
              </div>
            )}
            {/* D8:「为什么这颗按钮点不动」。与上面那一档同一种形态——两者都是
                "主按钮禁用 + 注解",只是原因一个在技能身上、一个在权限上。 */}
            {action.kind === "noWriteAccess" && (
              <div className="mt-0.5 text-[11.5px] leading-[1.5] text-[#9a6c00] dark:text-[#d4a017]">
                {t("mine.shareNoAccess")}
              </div>
            )}
          </div>
        </button>

        <div className="flex flex-none items-center gap-1.5">
          <PrimaryAction
            action={action}
            pulling={pulling}
            sharing={sharing}
            openVersions={openVersions !== null}
            onPull={onPull}
            onShareChanges={onShareChanges}
            onShare={onShare}
            onChooseVersion={() =>
              setVersionChoice({
                versionChoice: { dirSlug: skill.dirSlug, versions: skill.versions },
                keepError: null,
              })
            }
          />
          <SkillRowMenu items={menuItems} preferredPlacement={"down"} subject={name} />
        </div>
      </div>
    </div>
  );
}

/** 状态徽标(来源已移除等)。归类徽标已撤,只剩警示这一种语气。 */
function Badge({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className="flex-none rounded-[4px] bg-[#b8860b]/10 px-1.5 py-px text-[10.5px] font-medium text-[#9a6c00] dark:bg-[#d4a017]/15 dark:text-[#d4a017]"
    >
      {children}
    </span>
  );
}
