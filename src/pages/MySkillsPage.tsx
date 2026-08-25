import { useEffect, useMemo, useState } from "react";

import { CreateSkillButton, CreateSkillPanel } from "@/components/CreateSkill";
import { ProjectSections } from "@/components/ProjectSections";
import { SkillIcon } from "@/components/SkillIcon";
import { ToolChecks } from "@/components/ToolChecks";
import { t, type MessageKey } from "@/i18n";
import { relativeTimeFromIso } from "@/lib/format";
import { skillReveal, type InstalledSkillView } from "@/lib/ipc";
import { sharedState, type SharedState } from "@/lib/ownership";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { hasUpdate, localEqualsRemote, sections, useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/**
 * 「我的技能」页(v6 二期任务 7 重画)。
 *
 * # 一行只讲三件事:一个技能,三个「在哪」
 *
 * 1. **这台电脑上**——`body`,本体住在哪、永不搬动。「打开文件夹」直接去那里;
 * 2. **各个工具里**——`<ToolChecks/>`,每个工具一个勾,点一下就启用/停用;
 * 3. **技能库里**——状态文案(`sharedState` 的八档)+ 一个主动作。
 *
 * # 撤掉的东西,以及为什么
 *
 * - **「修复」按钮**:它缺的不是实现,是概念错了——"修复关联"这件事本身就是
 *   "在某某工具里启用它"这个勾。断链的位置现在显示成没启用,再点一次即自愈。
 * - **「N 处关联异常」徽标**:同一件事已经由勾的状态如实说了,徽标是第二遍。
 * - **「已启用:A、B」那行文字**:勾组把它讲得更清楚,而且能点。
 *
 * # 两个分区的判据仍是 core 的 `relation`
 *
 * `shared`/`draft` 归「我分享的」,`installed` 归「我安装的」——归属不靠本地
 * 记录猜测,库里的作者文件才是权威。
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
    shareUpdate,
    shareBusy,
    shareDone,
    shareError,
    setAgentsBusy,
    setAgentsError,
    toolFailures,
    dismissToolFailures,
    beginShare,
    pull,
  } = useMySkills();
  const index = useStoreIndex((s) => s.index);
  const installPhase = useInstall((s) => s.phase);
  const activeSlug = useInstall((s) => s.dirSlug);
  // 「以本地为准,分享更新」(冲突弹窗里那一条)走的是 useInstall 的
  // keepLocalAndShareMine,结果只写进 useInstall.shareResult——而它此前唯一的
  // 渲染点在 InstallPanel 的装完那一屏,从这一页点进去时那个面板根本不在场:
  // 弹窗一消失就什么都没有,**分享失败也静默**。这里接到本页既有的提示位上。
  const installShareResult = useInstall((s) => s.shareResult);
  const setPage = useUi((s) => s.setPage);
  // 🔴 「打开文件夹」的失败必须有落点(R30)。`skill_reveal` 的守卫是
  // 「必须是目录、且目录下有 SKILL.md」,而 `differs` 给的 `existing` **两条都不保证**
  // ——占位物完全可能是一个普通文件、或一个不含 SKILL.md 的目录(`converge` 对
  // `!target.is_dir()` 同样返回 `Differs`)。守卫会返 `FS_NOT_A_SKILL`,
  // 而那正是这个项目有专门记忆的那一类:**前端全对却没反应**,零痕迹、最难排查。
  // `ShareConfirm` 里的同款出口一直是把错误摆出来的,这里此前反而吞掉了。
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

  useEffect(() => {
    void load();
  }, [load]);

  // 更新流程结束后(done)刷新列表,状态才跟得上
  useEffect(() => {
    if (installPhase === "done") void load();
  }, [installPhase, load]);

  const nameOf = useMemo(() => {
    const map = new Map(index?.skills.map((s) => [s.dirSlug, s.name]) ?? []);
    return (slug: string) => map.get(slug) ?? slug;
  }, [index]);

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

  if (list.length === 0) {
    return (
      <div className="py-6">
        <p className="text-[12.5px] text-text-2">{t("mine.empty")}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage("store")}
            className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("mine.emptyCta")}
          </button>
          {/* 空态也要有「新建技能」:一个技能都没有的人,恰恰最可能是想自己写一个 */}
          <CreateSkillButton />
        </div>
        {/* 展开态是整卡宽度,必须摆在那条 flex 行**外面**(见 CreateSkill 模块头) */}
        <div className="mt-2.5">
          <CreateSkillPanel />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3.5 py-2.5 text-[12.5px] text-text-2">
        <span>{t("mine.count", { count: list.length })}</span>
        <CreateSkillButton />
      </div>
      {/* 展开态是整卡宽度,必须摆在那条 flex 行**外面**(见 CreateSkill 模块头) */}
      <CreateSkillPanel />
      {/* 🔴 勾选的部分失败必须有渲染点:收集了不摆出来,就等于把"报错中断"换成了
          "静默撒谎"——用户看到勾变了、以为成了,那个工具里其实什么都没发生。 */}
      {toolFailures && (
        <div className="mb-2 rounded-card border border-[#c0392b]/40 px-2.5 py-2 dark:border-[#e0705f]/40">
          <p className="text-[12px] font-medium text-[#c0392b] dark:text-[#e0705f]">
            {/* 按内容分流:全是"停下来问你"时说「需要你看一下」,
                只要有一条是真失败就得说「没能完成」——只读标题的人不该把
                一屏真失败当成温和的提示。 */}
            {toolFailures.some((f) => f.kind === "failed")
              ? t("mine.toolsPartialFailed", { count: toolFailures.length })
              : t("mine.toolsNeedLook", { count: toolFailures.length })}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {toolFailures.map((f, i) => (
              <li key={`${f.agent ?? "-"}-${i}`} className="text-[11.5px] text-text-2">
                {/* 🔴 `differs` 与真正的失败说**不同的话**:它不是"没做成",
                    是"停下来问你"——那个位置上已经有一份内容不同的东西,
                    core 按铁律 7 绝不覆盖。再给一个「打开文件夹」让用户去看看
                    那是什么;没有这个出口的话,他点几次勾都只会看到勾弹回去。 */}
                {f.kind === "differs" ? (
                  (() => {
                    const tool = f.agent
                      ? (agentNames.get(f.agent) ?? f.agent)
                      : t("mine.toolCanonical");
                    return (
                      <>
                        <span>{t("mine.toolOccupied", { tool })}</span>
                        {/* 页面上可能同时有好几个「打开文件夹」(行内的、失败框里的),
                            可访问名一样的话屏幕阅读器与真机扫视都分不出指向哪个位置
                            ——所以这一个带上工具名。 */}
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
            className="mt-1.5 h-6 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("mine.dismiss")}
          </button>
        </div>
      )}
      {/* 「打开文件夹」的失败摆在页面级,不挂在失败框里:行内与「有几个版本」那两档
          的同款按钮也走 `revealOrExplain`,挂进失败框的话它们失败时又没有渲染点了。 */}
      {revealError && (
        <p className="pb-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.openFolderFailed")}
          {t("punct.labelSeparator")}
          {revealError}
        </p>
      )}
      {setAgentsError && (
        <p className="pb-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.toolsFailed")}
          {t("punct.labelSeparator")}
          {setAgentsError.message}
        </p>
      )}
      {shareError && (
        <p className="pb-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.shareChangesFailed")}
          {t("punct.labelSeparator")}
          {shareError.message}
        </p>
      )}
      {shareDone && (
        <p className="pb-2 text-[12px] text-text-2">
          {shareDone.mode === "pushed"
            ? t("mine.shareChangesDone")
            : t("mine.shareChangesReview")}
        </p>
      )}
      {installShareResult &&
        ("error" in installShareResult ? (
          <p className="pb-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
            {t("mine.shareChangesFailed")}
            {t("punct.labelSeparator")}
            {installShareResult.error.message}
          </p>
        ) : (
          <p className="pb-2 text-[12px] text-text-2">
            {installShareResult.mode === "pushed"
              ? t("mine.shareChangesDone")
              : t("mine.shareChangesReview")}
          </p>
        ))}
      {sections(list).map((sec) => (
        <section key={sec.key} className="mt-3 first-of-type:mt-0">
          <h3 className="pb-1.5 text-[11.5px] font-medium text-text-3">{sec.title}</h3>
          <div className="overflow-hidden rounded-card border border-border bg-surface-1">
            {sec.items.map((skill) => (
              <Row
                key={skill.dirSlug}
                skill={skill}
                name={nameOf(skill.dirSlug)}
                agentNames={agentNames}
                state={sharedState(
                  skill,
                  hasUpdate(skill, index),
                  localEqualsRemote(skill, index),
                )}
                busy={setAgentsBusy === skill.dirSlug}
                pulling={activeSlug === skill.dirSlug && installPhase === "running"}
                sharing={shareBusy === skill.dirSlug}
                onPull={() => void pull(skill.dirSlug)}
                onShareUpdate={() =>
                  // 有安装基线才走得通 share_installed;没有基线的走确认屏
                  skill.contentHash
                    ? void shareUpdate(skill.dirSlug)
                    : beginShare(skill.dirSlug)
                }
                onShareChanges={() => void shareChanges(skill.dirSlug)}
                onShare={() => beginShare(skill.dirSlug)}
                onUpdate={() =>
                  // 更新带账上的来源坐标(M4 多仓):缺省会打到该源主库,
                  // 追加库的技能就更新错了库
                  void useInstall
                    .getState()
                    .beginUpdate(
                      skill.dirSlug,
                      skill.agents,
                      skill.registryId,
                      `${skill.sourceOwner}/${skill.sourceRepo}`,
                    )
                }
                onRemove={() => askRemove(skill.dirSlug)}
                onReveal={revealOrExplain}
              />
            ))}
          </div>
        </section>
      ))}
      {/* 第三区:装在项目里的。按项目分组,与上面两区的扁平列表结构不同,
          所以是独立组件(数据源也不同:项目级真相在各项目自己的文件里)。 */}
      <ProjectSections />
    </div>
  );
}

const STATE_LABEL: Record<SharedState, MessageKey> = {
  versions: "mine.stateVersions",
  draft: "mine.stateDraft",
  notHere: "mine.stateNotHere",
  differs: "mine.stateDiffers",
  both: "mine.stateBoth",
  localAhead: "mine.stateLocalAhead",
  remoteAhead: "mine.stateRemoteAhead",
  synced: "mine.stateSynced",
};

/**
 * 「我的技能」的一行。
 *
 * # 主动作按状态分派(每一档只摆一个,不让用户在同一行里做选择题)
 *
 * | 状态 | 主动作 |
 * |---|---|
 * | `versions` | 「选择保留哪一份」——**其余动作一概不渲染** |
 * | `draft` | 「分享」(打开确认屏) |
 * | `notHere` / `remoteAhead` / `both` | 「取回」(**仅「我分享的」**) |
 * | `localAhead` | 「分享更新」(**仅「我分享的」**) |
 * | `differs` | **两个都摆**:「改用库里的版本」与「分享更新」 |
 * | `synced` | 无 |
 *
 * ⚠️ **上表说的是「我分享的」那一区**。「我安装的」(`relation === "installed"`)
 * 走另一套动作,因为那些技能不是我分享的、「分享更新」对它们没有意义:
 *
 * | 条件 | 动作 |
 * |---|---|
 * | `remoteAhead` **或** `both` | 「更新」 |
 * | `localModified` 且来源还在 | 「分享改动」(把改动推回来源) |
 *
 * 🔴 `both` 在两区**都要有出口**:漏掉「我安装的」那一半,状态文案写着
 * 「库里有新版」、角标照样计数,而页面上一个能点的更新入口都没有。
 *
 * 🔴 **`versions` 那一档必须把其余动作全部收起来**:磁盘上有几份内容不同的实体时,
 * 「取回」「分享更新」这些动作的主语是不确定的(拿哪一份去比?去推?),
 * 摆出来就是让用户在一个没有确定答案的问题上做决定。先拍板,再谈其余。
 *
 * 🔴 **`differs` 那一档刻意两个都摆、不默认谁**:这一档没有安装基线,
 * app **确实不知道**是用户改了本地、还是别人更新了库里那一版。挑一个当主动作
 * 就是在猜,而两个方向的代价完全不对称(猜错一次就覆盖掉一边的成果)。
 * 摆两个、让用户自己看,是这里唯一诚实的做法。
 *
 * # 「移除」只在本体确实在这台电脑上时才摆
 *
 * `localPresent` 为假时本体根本不在,`skill_remove` 也没什么可移的;
 * 摆一个点了必然报错的按钮,不如不摆(项目既定取舍)。
 */
function Row({
  skill,
  name,
  agentNames,
  state,
  busy,
  pulling,
  sharing,
  onPull,
  onShareUpdate,
  onShareChanges,
  onShare,
  onUpdate,
  onRemove,
  onReveal,
}: {
  skill: InstalledSkillView;
  name: string;
  agentNames: Map<string, string>;
  state: SharedState;
  busy: boolean;
  pulling: boolean;
  sharing: boolean;
  onPull: () => void;
  onShareUpdate: () => void;
  onShareChanges: () => void;
  onShare: () => void;
  onUpdate: () => void;
  onRemove: () => void;
  /** 「打开文件夹」。**失败要摆出来**,不能吞——见页面组件里 `revealOrExplain` 的说明。 */
  onReveal: (path: string) => void;
}) {
  const openVersions = useMySkills((s) => s.versionChoice);
  const setVersionChoice = useMySkills.setState;
  const acquiredAt = relativeTimeFromIso(skill.updatedAt);
  // 「我安装的」那一区讲的是"库里有没有新版",不是"我和库里谁新"——
  // 那一区的技能不是我分享的,「分享更新」对它没有意义。
  const isInstalled = skill.relation === "installed";
  // 🔴 **`both` 必须和 `remoteAhead` 一样摆「更新」**(R29,修复轮 2 修的真回归)。
  // 只判 `remoteAhead` 的话,「我安装的」技能在 `both`(本地改过 + 库里也有新版)
  // 这一档**一个更新入口都没有**:取回按钮有 `!isInstalled` 闸、更新按钮判不到,
  // 于是状态文案写着「库里有新版」、侧边栏角标照样在计数,而页面上点不到任何东西
  // ——正是 CLAUDE.md 记着的「角标说 3、点进去只有 1」那个缺陷。
  // 本地也改过时不必在这里分流:`skill_install` 的预检会返回"需要拍板",
  // 自然落进全局挂载的 `ConflictDialog` 走三选。
  const showUpdate = isInstalled && (state === "remoteAhead" || state === "both");
  const showShareChanges =
    isInstalled && skill.localModified && !skill.sourceRemoved && !skill.libraryRemoved;

  return (
    <div className="border-t border-border px-3.5 py-2.5 first:border-t-0">
      <div className="flex items-center gap-3">
        {/* 名称区整块可点开详情;右侧动作按钮在这块外面,不会误触 */}
        <button
          type="button"
          onClick={() =>
            void useLocalDetail
              .getState()
              // 本体不在统一目录里也要打得开:优先按本体绝对路径查
              .open(skill.body ? { path: skill.body } : { dirSlug: skill.dirSlug })
          }
          className="group flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <SkillIcon name={name} className="size-[26px] rounded-[6px] text-[12px]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-[550] group-hover:text-accent">
                {name}
              </span>
              {skill.sourceRemoved && (
                <Badge title={t("mine.badgeSourceRemovedHint")}>
                  {t("mine.badgeSourceRemoved")}
                </Badge>
              )}
              {skill.libraryRemoved && (
                <Badge title={t("mine.badgeLibraryRemovedHint")}>
                  {t("mine.badgeLibraryRemoved")}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-text-3">
              <span>{t(STATE_LABEL[state])}</span>
              {skill.sourceLabel && (
                <>
                  <span>·</span>
                  <span>{t("mine.sourceLabel", { label: skill.sourceLabel })}</span>
                </>
              )}
              {acquiredAt && (
                <>
                  <span>·</span>
                  <span>{t("mine.acquiredAt", { when: acquiredAt })}</span>
                </>
              )}
            </div>
          </div>
        </button>

        <div className="flex flex-none items-center gap-1.5">
          {state === "versions" ? (
            <button
              type="button"
              onClick={() =>
                setVersionChoice({
                  versionChoice: { dirSlug: skill.dirSlug, versions: skill.versions },
                  keepError: null,
                })
              }
              disabled={openVersions !== null}
              className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t("mine.chooseVersion")}
            </button>
          ) : (
            <>
              {state === "draft" && (
                <button
                  type="button"
                  onClick={onShare}
                  className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90"
                >
                  {t("mine.share")}
                </button>
              )}
              {(state === "notHere" || state === "remoteAhead" || state === "both") &&
                !isInstalled && (
                  <button
                    type="button"
                    disabled={pulling}
                    onClick={onPull}
                    className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {pulling ? t("mine.pulling") : t("mine.pull")}
                  </button>
                )}
              {/* differs:两个方向都摆,不默认谁——见组件文档 */}
              {state === "differs" && (
                <button
                  type="button"
                  disabled={pulling}
                  onClick={onPull}
                  title={t("mine.useLibraryConfirm")}
                  className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
                >
                  {pulling ? t("mine.pulling") : t("mine.useLibrary")}
                </button>
              )}
              {(state === "localAhead" || state === "differs") &&
                !skill.sourceRemoved &&
                !skill.libraryRemoved &&
                !isInstalled && (
                  <button
                    type="button"
                    disabled={sharing}
                    onClick={onShareUpdate}
                    className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {sharing ? t("mine.sharingChanges") : t("mine.shareUpdate")}
                  </button>
                )}
              {showShareChanges && (
                <button
                  type="button"
                  disabled={sharing}
                  onClick={onShareChanges}
                  className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
                >
                  {sharing ? t("mine.sharingChanges") : t("mine.shareChanges")}
                </button>
              )}
              {showUpdate && (
                <button
                  type="button"
                  disabled={pulling}
                  onClick={onUpdate}
                  className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {pulling ? t("mine.updating") : t("mine.update")}
                </button>
              )}
            </>
          )}
          {/* 「打开文件夹」在每一档都摆(含 versions):它是只读动作,而且恰恰是
              用户拍板/改名/改 SKILL.md 时最需要的那个出口。本体不在就没有目标。 */}
          {skill.body && (
            <button
              type="button"
              onClick={() => onReveal(skill.body)}
              className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("mine.openFolder")}
            </button>
          )}
          {state !== "versions" && skill.localPresent && (
            <button
              type="button"
              onClick={onRemove}
              className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("mine.remove")}
            </button>
          )}
        </div>
      </div>

      {/* 「各个工具里」。versions 那一档不摆:还没决定留哪份,"启用哪一份"无从谈起。 */}
      {state !== "versions" && skill.localPresent && (
        <ToolChecks
          dirSlug={skill.dirSlug}
          tools={skill.tools}
          agentNames={agentNames}
          disabled={busy}
        />
      )}
    </div>
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
