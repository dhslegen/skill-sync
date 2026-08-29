import { useEffect, useState } from "react";

import { CreateSkillButton, CreateSkillPanel } from "@/components/CreateSkill";
import { ProjectSections } from "@/components/ProjectSections";
import { SkillIcon } from "@/components/SkillIcon";
import { SkillRowMenu, type SkillRowMenuItem } from "@/components/SkillRowMenu";
import { t } from "@/i18n";
import { isAppError, openLibraryUrl, skillReveal, type InstalledSkillView } from "@/lib/ipc";
import { rowAction, type RowAction } from "@/lib/ownership";
import { SHARE_BLOCK_LABEL } from "@/lib/share-block";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { matchesMineQuery, useMineSearch } from "@/store/mine-search";
import {
  hasUpdate,
  localDiffersNoBaseline,
  remoteChangedForShareable,
  sections,
  shareableCardFor,
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
 * `src/lib/ownership.ts` 的 `rowAction`,十一档穷尽,`kind !== "none"` 时
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
  const cardOf = (skill: InstalledSkillView) =>
    skill.section === "shareable"
      ? shareableCardFor(skill, shareableIndexes)
      : (index?.skills.find((s) => s.dirSlug === skill.dirSlug) ?? null);
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

  const filteredList = list.filter((s) => matchesMineQuery(s, nameOf(s.dirSlug), query));
  const secs = sections(filteredList, secAction);

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
          {shareError && <ErrorLine label={t("mine.shareChangesFailed")} detail={shareError.message} />}
          {shareDone && (
            <p className="pb-2 text-[12px] text-text-2">
              {shareDone.mode === "pushed" ? t("mine.shareChangesDone") : t("mine.shareChangesReview")}
            </p>
          )}
          {keepError && !versionChoiceOpen && (
            <ErrorLine label={t("mine.keepFailed")} detail={keepError.message} />
          )}
          {installPhaseIsError && installError && activeSlug && (
            <ErrorLine label={t("mine.pullFailed", { name: nameOf(activeSlug) })} detail={installError.message} />
          )}
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

          {/* 页头总览:只在"有事要做"时出现(design 的「一切正常」板完全没有这一块)。 */}
          {(updatesCount > 0 || unsyncedCount > 0) && (
            <div className="mb-2.5 flex items-center gap-3 rounded-card border border-border bg-surface-1 px-3.5 py-2.5">
              <p className="flex-1 text-[12.5px] text-text-2">
                {updatesCount > 0 && t("mine.overviewUpdates", { count: updatesCount })}
                {updatesCount > 0 && unsyncedCount > 0 && <span className="mx-1.5">·</span>}
                {unsyncedCount > 0 && t("mine.overviewUnsynced", { count: unsyncedCount })}
              </p>
              {updatesCount > 0 && (
                <button
                  type="button"
                  disabled={updateAllBusy}
                  onClick={() => void updateAll()}
                  className="h-7 flex-none rounded-ctl bg-accent px-2.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {updateAllBusy ? t("mine.updating") : t("mine.updateAll")}
                </button>
              )}
            </div>
          )}

          {filteredList.length === 0 ? (
            <p className="py-6 text-[12.5px] text-text-3">{t("mine.searchEmpty", { query })}</p>
          ) : (
            secs.map((sec, secIndex) => (
              <section key={sec.key} className="mt-3 first-of-type:mt-0">
                <h3 className="pb-1.5 text-[11.5px] font-medium text-text-3">{sec.title}</h3>
                {/* 🔴 M5(复审):未登录提示紧跟在**第一个**区标题旁边,不是摆在
                    整个区列表的最上面——画布里它就贴在「安装自技能库」标题下方。
                    「已分享到」区未登录时天然不会出现(core 的 relation 决定,
                    这里不需要按登录态过滤 sec),所以固定挂在 secIndex===0 那一区
                    就等价于"第一个真正渲染出来的区"。 */}
                {secIndex === 0 && sessionStatus !== "signedIn" && (
                  <p className="pb-1.5 text-[11.5px] text-text-3">{t("mine.signedOutHint")}</p>
                )}
                <div className="overflow-hidden rounded-card border border-border bg-surface-1">
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
                          // 🔴 I3(用户拍板):点击是"立即查"这一半的触发点
                          // ——只对这一行自己的外部来源发请求,不碰其余行、
                          // 不无视其余来源的节流。shareableSourceKey 为 null
                          // (非 shareable 区/纯本地草稿)时 ensureShareableIndexes
                          // 自己会跳过,这里不必先判一遍。
                          void ensureShareableIndexes([skill.dirSlug]);
                        }}
                      />
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
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

  const menuItems: SkillRowMenuItem[] = [];
  if (skill.body) {
    menuItems.push({ key: "reveal", label: t("mine.openFolder"), onClick: () => onReveal(skill.body) });
  }
  // 🔴 I1 修复:`conflict` 压过主按钮之后,「贡献更改」/「分享改动」这两个
  // 动作不会消失——用户可能就是想直接把本地内容推去评审,不想先经过
  // `ConflictDialog` 那条"要不要保留本地"的三选一。两个区共用同一个判据
  // (`localModified`),只是文案不同。
  if (action.kind === "conflict" && skill.localModified) {
    menuItems.push({
      key: "contributeOrShareChanges",
      label: skill.section === "installedFrom" ? t("mine.contribute") : t("mine.shareChanges"),
      onClick: onShareChanges,
    });
  }
  // 被压过一头、暂时不是主按钮的动作,不会丢失,退进这里(见 RowAction 的判定表文档)。
  if (skill.section === "shareable") {
    if (action.kind === "shareBlocked" && remoteChanged) {
      menuItems.push({ key: "update", label: t("mine.update"), onClick: onPull });
    } else if (action.kind === "update") {
      menuItems.push({ key: "share", label: t("mine.share"), onClick: onShare });
    }
  }
  // 🔴 C3 修复:没有安装基线时,「改用库里的版本」是这一档**唯一**的出口
  // ——点击复用既有 `pull`(等价 `beginUpdate`),core 的预检会把它判成需要
  // 拍板的那一档,自然弹出既有的 `ConflictDialog`,这里不用再造一层确认。
  if (noBaselineDiffers) {
    menuItems.push({
      key: "useLibraryVersion",
      label: t("mine.useLibraryVersion"),
      title: t("mine.useLibraryVersionHint"),
      onClick: onPull,
    });
  }
  if (skill.localPresent && action.kind !== "chooseVersion") {
    // 破坏性动作放最后,并与上面"能做的事"用一条分隔线隔开,防止手滑
    // (I1:此前"移除"混在中间,没有视觉上的"这条不一样"提示)。
    menuItems.push({
      key: "remove",
      label: t("mine.remove"),
      onClick: onRemove,
      separatorBefore: menuItems.length > 0,
    });
  }

  const explainShareBlocked = action.kind === "shareBlocked";

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
            {skill.section === "shareable" && skill.sourceLabel && (
              <div className="mt-0.5 truncate text-[11px] text-text-3">
                {t("mine.sourceLabel", { label: skill.sourceLabel })}
              </div>
            )}
            {description && <div className="mt-0.5 truncate text-[11.5px] text-text-3">{description}</div>}
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

      {explainShareBlocked && action.kind === "shareBlocked" && (
        <p className="mt-1.5 rounded-card border border-[#b8860b]/40 px-2.5 py-1.5 text-[11.5px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
          {t(SHARE_BLOCK_LABEL[action.reason])}
        </p>
      )}
    </div>
  );
}

/** 每一档 `RowAction.kind` 翻成一颗按钮(或者一句没有按钮的话)。 */
function PrimaryAction({
  action,
  pulling,
  sharing,
  openVersions,
  onPull,
  onShareChanges,
  onShare,
  onChooseVersion,
}: {
  action: RowAction;
  pulling: boolean;
  sharing: boolean;
  openVersions: boolean;
  onPull: () => void;
  onShareChanges: () => void;
  onShare: () => void;
  onChooseVersion: () => void;
}) {
  switch (action.kind) {
    case "none":
      return null;
    case "chooseVersion":
      return (
        <SolidButton disabled={openVersions} onClick={onChooseVersion}>
          {t("mine.chooseVersion")}
        </SolidButton>
      );
    case "pull":
      return (
        <SolidButton disabled={pulling} onClick={onPull}>
          {pulling ? t("mine.pulling") : t("mine.pull")}
        </SolidButton>
      );
    case "update":
      return (
        <SolidButton disabled={pulling} onClick={onPull}>
          {pulling ? t("mine.updating") : t("mine.update")}
        </SolidButton>
      );
    case "conflict":
      // 浅色文字链形态:这一档不是"点了就做完",是"点了会先问你"。
      return (
        <button
          type="button"
          disabled={pulling}
          onClick={onPull}
          className="h-6 rounded-ctl px-1.5 text-[11.5px] font-medium text-text-2 underline decoration-dotted underline-offset-2 hover:text-text disabled:opacity-50"
        >
          {pulling ? t("mine.updating") : t("mine.conflictPending")}
        </button>
      );
    case "contribute":
      return (
        <OutlineButton disabled={sharing} onClick={onShareChanges}>
          {sharing ? t("mine.contributing") : t("mine.contribute")}
        </OutlineButton>
      );
    case "shareChanges":
      return (
        <OutlineButton disabled={sharing} onClick={onShareChanges}>
          {sharing ? t("mine.sharingChanges") : t("mine.shareChanges")}
        </OutlineButton>
      );
    case "share":
      return (
        <SolidButton disabled={sharing} onClick={onShare}>
          {t("mine.share")}
        </SolidButton>
      );
    case "shareBlocked": {
      // 🔴 C1:三个区都可能落进这一档,按钮文案要说对被拦下的是哪个动作
      // ——不是每次都说「分享」(那句话对 installedFrom/sharedTo 是错的)。
      const label =
        action.blockedAction === "contribute"
          ? t("mine.contribute")
          : action.blockedAction === "shareChanges"
            ? t("mine.shareChanges")
            : t("mine.share");
      const Btn = action.blockedAction === "share" ? SolidButton : OutlineButton;
      return (
        <Btn disabled onClick={() => {}}>
          {label}
        </Btn>
      );
    }
    case "underReview":
      return <ReviewPendingText url={action.url} />;
  }
}

/**
 * 「审核中」+(有链接时)「在技能库里查看」——`RowAction.underReview.url` 此前
 * 只在算出来就没有任何渲染点用过(I1 修复:v7 任务 7 修复轮 1)。
 *
 * 自己开一份局部错误状态,不复用页面级的 `revealError`——那个字段说的是
 * "打开文件夹"失败,这里是"打开外部链接"失败,是两件不同的事,合并成一个
 * 字段只会在两种失败同时发生时互相覆盖。与 `WhereBlocks.tsx` 的 `ReviewLink`
 * 是同一个模式的两处独立实现(那边服务详情面板,这边服务列表行,两处场景
 * 不同不共用状态,但都遵守"失败要有渲染点"这条硬规则)。
 */
function ReviewPendingText({ url }: { url: string | null }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-1.5 px-1.5 text-[11.5px] text-text-3">
      {t("detail.whereReviewPending")}
      {url && (
        <button
          type="button"
          onClick={() => {
            setError(null);
            openLibraryUrl(url).catch((raw: unknown) =>
              setError(isAppError(raw) ? raw.message : t("error.generic")),
            );
          }}
          className="text-accent underline decoration-dotted underline-offset-2 hover:opacity-80"
        >
          {t("mine.reviewLink")}
        </button>
      )}
      {error && <span className="text-[#c0392b] dark:text-[#e0705f]">{error}</span>}
    </span>
  );
}

function SolidButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function OutlineButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** 状态徽标(来源已移除等)。归类徽标已撤,只剩警示这一种语气。 */
function Badge({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className="flex-none rounded-[4px] border border-[#b8860b]/40 px-1.5 py-px text-[10.5px] font-medium text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]"
    >
      {children}
    </span>
  );
}
