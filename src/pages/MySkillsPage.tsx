import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import { CreateSkillButton, CreateSkillPanel } from "@/components/CreateSkill";
import { Icon } from "@/components/Icon";
import { ProjectSections } from "@/components/ProjectSections";
import { ChipButton, PrimaryAction, rowMenuHandler } from "@/components/RowActionControls";
import { SkillIcon } from "@/components/SkillIcon";
import { SkillRowMenu, type SkillRowMenuItem } from "@/components/SkillRowMenu";
import { t } from "@/i18n";
import { skillReveal, type InstalledSkillView, type Section } from "@/lib/ipc";
import { buildRowMenuItems, needsAttention, rowAction, type RowAction } from "@/lib/ownership";
import { SHARE_BLOCK_LABEL, SHARE_DONE_LABEL, SHARE_FAILED_LABEL } from "@/lib/share-block";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { useMineCollapse } from "@/store/mine-collapse";
import { matchesMineQuery, useMineSearch } from "@/store/mine-search";
import {
  cardFor,
  hasUpdate,
  localDiffersNoBaseline,
  remoteChangedForShareable,
  sections,
  updateCount,
  useMySkills,
} from "@/store/my-skills";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/**
 * 「我的技能」页(v7 任务 7 整页重画)。
 *
 * # 三区 + 每行至多一颗主按钮
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
 * # 两个页头信号
 *
 * 「N 个有更新」只数**能被「全部更新」一键处理的行**(`rowAction.kind ===
 * "update"`,与侧栏角标 `updateCount` 同一个集合)——不含需要拍板的冲突行,
 * 也不含「可分享到」区"外源有新版"那颗自己的更新按钮(那颗按钮走
 * per-row `pull`,`skill_install_batch` 一次只吃一对 `registryId`/`repo`,
 * 协议上表达不出跨源批量,见 `my-skills.ts::updateAll` 的文档)。
 * 「M 个有改动未分享」数 `localModified === true` 且不在「可分享到」区的行
 * ——那个区的技能本来就没有"分享给库"这件事的进度可言。
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
  const [tab, setTab] = useState<"general" | "projects">("general");
  const collapsed = useMineCollapse((s) => s.collapsed);
  const toggleCollapsed = useMineCollapse((s) => s.toggle);

  // 三级刷新的级别 2(切页):页面组件挂载时 load 一次。级别 1(窗口重获焦点)
  // 与级别 3(文件监听)是 `useLocalRefresh()` 的活,全局挂在 App.tsx,这里不重复。
  useEffect(() => {
    void load();
  }, [load]);

  // 更新流程结束后(done)刷新列表,状态才跟得上
  useEffect(() => {
    if (installPhase === "done") void load();
  }, [installPhase, load]);

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
    return rowAction(skill, remoteChanged);
  };
  const updatesCount = updateCount(list, index);
  const unsyncedCount = list.filter(
    (s) => s.section !== "shareable" && s.localModified,
  ).length;

  // 每行的 `rowAction` 对**全量** list 只算一轮,渲染、分区排序与折叠头的计数
  // 共用这一份——分开各算一遍就是本项目记录的空转模式 #1(同一条规则查两遍)。
  const actionOf = new Map(list.map((s) => [s.dirSlug, secAction(s)] as const));
  const actionFor = (skill: InstalledSkillView): RowAction =>
    actionOf.get(skill.dirSlug) ?? secAction(skill);

  const filteredList = list.filter((s) => matchesMineQuery(s, nameOf(s.dirSlug), query));
  const secs = sections(filteredList, actionFor);

  // 🔴 折叠头的两个数走**全量** list,不走 filteredList:搜索只影响展示,
  // 头上写的"这个区一共有多少 / 其中几个要处理"是这个区的事实,搜索时按筛选后
  // 的条数报数就成了假话(与页头总览 band 同一个口径,见上面那两个计数)。
  const statsOf = (key: Section) => {
    const rows = list.filter((s) => s.section === key);
    return {
      total: rows.length,
      attention: rows.filter((s) => needsAttention(actionFor(s))).length,
    };
  };

  // 🔴 搜索必须穿透折叠:`query` 非空时折叠整体失效(展示态恒为展开),否则
  // "搜到了但那个区折着"在用户看来就是**搜索坏了**。存储态不受影响——搜索期间
  // 点折叠头照常写进 localStorage,清空搜索后生效。
  const searching = query.trim() !== "";

  return (
    <div>
      {/* 🔴 M2(复审):页头不再多摆一行「N 个技能」计数——四块画板都没有这一行,
          「新建技能」搬进 TabsRow 自己那一条(design #16 那句"新建技能"紧跟在
          "项目里"之后的顺序)。空态那一档不同:它自己的 CTA 行已经有「新建技能」,
          TabsRow 不重复摆一份。 */}
      <TabsRow tab={tab} onChange={setTab} showCreate={tab === "general" && list.length > 0} />
      {tab === "general" && <CreateSkillPanel />}

      {tab === "projects" ? (
        <ProjectSections />
      ) : list.length === 0 ? (
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
                {installShareResult.mode === "pushed" ? t("mine.shareChangesDone") : t("mine.shareChangesReview")}
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

          {/* 页头总览:只在"有事要做"时出现(design 的「一切正常」板完全没有这一块)。
              🔴 v7.1 任务 5:**一行轻字 + 内联 chip**,不是卡片。画布 `Main.dc.html`
              里这块没有边框、没有底色、没有内边距,就是正文流里的一行 12.5px 灰字,
              后面跟一颗浅橙 chip。此前的 `rounded-card border bg-surface-1` 把
              "有几件事要做"这句状态说明做成了一张与下面技能卡同等重量的卡片
              ——状态不该和内容抢分量(Q5B)。别再给它加回边框/底色。 */}
          {(updatesCount > 0 || unsyncedCount > 0) && (
            <div
              data-testid="mine-overview"
              className="flex items-center gap-2.5 pb-3 text-[12.5px] text-text-2"
            >
              <span>
                {updatesCount > 0 && t("mine.overviewUpdates", { count: updatesCount })}
                {updatesCount > 0 && unsyncedCount > 0 && <span className="mx-1.5">·</span>}
                {unsyncedCount > 0 && t("mine.overviewUnsynced", { count: unsyncedCount })}
              </span>
              {updatesCount > 0 && (
                <ChipButton disabled={updateAllBusy} onClick={() => void updateAll()}>
                  {updateAllBusy ? t("mine.updating") : t("mine.updateAll")}
                </ChipButton>
              )}
            </div>
          )}

          {filteredList.length === 0 ? (
            <p className="py-6 text-[12.5px] text-text-3">{t("mine.searchEmpty", { query })}</p>
          ) : (
            secs.map((sec, secIndex) => {
              const stats = statsOf(sec.key);
              const expanded = searching || !collapsed.includes(sec.key);
              const bodyId = `mine-section-${sec.key}`;
              return (
              <section key={sec.key} className="mt-3 first-of-type:mt-0">
                <SectionHeader
                  title={sec.title}
                  total={stats.total}
                  attention={stats.attention}
                  expanded={expanded}
                  bodyId={bodyId}
                  onToggle={() => toggleCollapsed(sec.key)}
                />
                {/* 🔴 M5(复审):未登录提示紧跟在**第一个**区标题旁边,不是摆在
                    整个区列表的最上面——画布里它就贴在「安装自技能库」标题下方。
                    「已分享到」区未登录时天然不会出现(core 的 relation 决定,
                    这里不需要按登录态过滤 sec)。
                    🔴 终审 M-8:光判 `secIndex === 0` 不够——用户**只有草稿**
                    (没有任何"安装自"的行)时,「可分享到」会顶到第一位,这句
                    "登录后能区分哪些是你分享的"贴在草稿标题下毫无意义(草稿本来
                    就与登录态无关,是"安装自 vs 已分享到"这对区分才需要登录)。
                    改判 `secs[0]?.key === "installedFrom"`:未登录时 `sharedTo`
                    结构性必空(design 决策 #4),所以第一区要么是
                    `installedFrom`(该摆)要么是 `shareable`(不该摆),这一条
                    判据就够穷尽两种情形。 */}
                {/* 🔴 **刻意不跟随折叠**(下一个人多半会有"折起来就该一起收"的
                    直觉,所以把理由写在这里):这句话解释的是**三个区标题为什么
                    长这样**(登录后才区分得出哪些是你分享的),它是**标题的**注解,
                    不是行的注解。而区标题恰恰是折叠之后唯一还看得见的东西——
                    折起来时用户只剩三个标题,正是最可能纳闷"这几个区按什么分的"
                    的时刻,这句话那时反而更需要在场。 */}
                {secIndex === 0 && secs[0]?.key === "installedFrom" && sessionStatus !== "signedIn" && (
                  <p className="pb-1.5 text-[11.5px] text-text-3">{t("mine.signedOutHint")}</p>
                )}
                <div
                  id={bodyId}
                  hidden={!expanded}
                  className="overflow-hidden rounded-card border border-border bg-surface-1"
                >
                  {sec.items.map((skill) => {
                    const remoteChanged =
                      skill.section === "shareable"
                        ? remoteChangedForShareable(skill, shareableIndexes)
                        : hasUpdate(skill, index);
                    // 🔴 C3 修复(v7 任务 7 修复轮 1):没有安装基线的行,
                    // `rowAction` 从不读 `localHash`——两方指纹直接比,只影响
                    // 「更多」菜单要不要多一条「改用库里的版本」,不进判定表。
                    const noBaselineDiffers = localDiffersNoBaseline(skill, index);
                    return (
                      <Row
                        key={skill.dirSlug}
                        skill={skill}
                        name={nameOf(skill.dirSlug)}
                        description={cardOf(skill)?.description ?? null}
                        action={rowAction(skill, remoteChanged)}
                        remoteChanged={remoteChanged}
                        noBaselineDiffers={noBaselineDiffers}
                        pulling={activeSlug === skill.dirSlug && installPhase === "running"}
                        sharing={shareBusy === skill.dirSlug}
                        onPull={() => void pull(skill.dirSlug)}
                        onShareChanges={() => void shareChanges(skill.dirSlug)}
                        onShare={() => beginShare(skill.dirSlug)}
                        onRemove={() => askRemove(skill.dirSlug)}
                        onReveal={revealOrExplain}
                        onOpenDetail={() => {
                          void useLocalDetail
                            .getState()
                            .open(skill.body ? { path: skill.body } : { dirSlug: skill.dirSlug });
                          // 🔴 I3(用户拍板)+ 修复轮 2 订正:点击是"立即查"
                          // 这一半的触发点——只对这一行自己的外部来源发请求,
                          // 不碰其余行(修复轮 2 之前这句话是假话:`forceDirSlugs`
                          // 与被动兜底共用一次"或"判据,首次点击时全部来源都还
                          // 没有时间戳、恒 stale,实际会把当时**全部**外部来源
                          // 探一遍——行为仍在预算内但与这句注释不符,现在两条
                          // 路径已经拆开,这里传参就是精确只查这一个)。
                          // shareableSourceKey 为 null(非 shareable 区/纯本地
                          // 草稿)时 ensureShareableIndexes 自己会跳过,这里不必
                          // 先判一遍。
                          void ensureShareableIndexes([skill.dirSlug]);
                        }}
                      />
                    );
                  })}
                </div>
              </section>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 分区的折叠头(用户真机反馈:条目一多就得一路滚)。
 *
 * # 吸顶
 *
 * `sticky top-0`——参照系是 `App.tsx` 那个 `overflow-y-auto` 容器,而 `Toolbar`
 * (`h-11 flex-none`)在它**外面**是 flex 兄弟,所以不需要任何偏移。`z-10` 压在
 * 行卡片之上、又在「更多」下拉(`SkillRowMenu` 的 `z-20`)与详情面板
 * (`z-50`)之下,三者都实测读过类名。**必须给一个不透明的页面地色**
 * (`bg-bg` = `--bg`,`body` 用的同一个 token;不是 `bg-surface-1`——那是行卡片
 * 的色,用它吸顶条会像一根悬空的卡片),否则滚动时行会从字底下透出来。
 * UI 规范禁毛玻璃,这里就是纯不透明底色。
 *
 * # 计数
 *
 * 「安装自技能库 · 12 · 2 个要处理」,后半段只在 > 0 时出现。判据是
 * `lib/ownership.ts` 的 {@link needsAttention}——**不是**页头总览那两个数
 * (它们漏掉 conflict/chooseVersion/shareBlocked/underReview 四档,拿它们做
 * 折叠头会让折叠打穿 v7「只写例外」的承诺)。
 *
 * # 可访问性
 *
 * 折叠头是 `<button>`,可访问名就是它的可见文字(区名 + 计数),**刻意不加
 * `aria-label`**;`aria-expanded` 跟**实际展示态**走(搜索期间恒 true),
 * `aria-controls` 指向下面那个行容器的 `id`。
 * ⚠️ 它在 `row-*` 之外,不进「每行至多一颗不带 aria-label 的按钮」那条既有
 * 测试契约的统计范围(那条只在 `within(row)` 里数)。
 */
function SectionHeader({
  title,
  total,
  attention,
  expanded,
  bodyId,
  onToggle,
}: {
  title: string;
  total: number;
  attention: number;
  expanded: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  return (
    // 仍然是 `<h3>`(区标题的语义没变,屏幕阅读器的标题导航照旧),里面套一颗
    // 全宽按钮——吸顶与地色挂在 h3 上,可点区域是整条。
    <h3 className="sticky top-0 z-10 -mx-1 bg-bg px-1 pb-1.5 pt-1 text-[11.5px] font-medium">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 text-left text-text-3 hover:text-text-2"
      >
        <Icon icon={expanded ? ChevronDown : ChevronRight} size={13} />
        <span>{title}</span>
        <span aria-hidden className="text-text-3">·</span>
        <span>{total}</span>
        {attention > 0 && (
          <>
            <span aria-hidden className="text-text-3">·</span>
            <span className="text-accent">{t("mine.sectionAttention", { count: attention })}</span>
          </>
        )}
      </button>
    </h3>
  );
}

function TabsRow({
  tab,
  onChange,
  showCreate,
}: {
  tab: "general" | "projects";
  onChange: (tab: "general" | "projects") => void;
  /** 只在「通用」且列表非空时给 true——空态自己的 CTA 行已经有「新建技能」,
   *  这里不重复摆一份(design #16:「新建技能」紧跟在「项目里」之后)。 */
  showCreate: boolean;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between border-b border-border pb-2.5">
      <div role="tablist" className="flex items-center gap-1">
        <TabButton active={tab === "general"} onClick={() => onChange("general")}>
          {t("mine.tabGeneral")}
        </TabButton>
        <TabButton active={tab === "projects"} onClick={() => onChange("projects")}>
          {t("mine.tabProjects")}
        </TabButton>
      </div>
      {showCreate && <CreateSkillButton />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        active
          ? "h-7 rounded-ctl bg-[rgba(194,65,12,.08)] px-2.5 text-[12.5px] font-[550] text-accent"
          : "h-7 rounded-ctl px-2.5 text-[12.5px] font-[450] text-text-2 hover:text-text"
      }
    >
      {children}
    </button>
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
 * `underReview` 那档:一句文字,没有按钮可点——审核结果不由用户这一步决定)。
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
            {/* 🔴 M3/④(复审):design §6 点名这一行是"等宽来源标签"——UI 硬规则
                "等宽字体展示 slug/路径/sha"在这里的落点。这处与 WhereBlocks.tsx
                (设计 §11「技能库里」那一块)不是同一个元素,那边没有被点名要求
                等宽,不与本处捆绑修改。 */}
            {skill.section === "shareable" && skill.sourceLabel && (
              <div className="mt-0.5 truncate font-mono text-[11px] text-text-3">
                {t("mine.sourceLabel", { label: skill.sourceLabel })}
              </div>
            )}
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
          <SkillRowMenu items={menuItems} />
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
