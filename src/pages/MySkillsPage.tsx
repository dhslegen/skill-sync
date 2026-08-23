import { useEffect, useMemo } from "react";

import { ProjectSections } from "@/components/ProjectSections";
import { SkillIcon } from "@/components/SkillIcon";
import { t, type MessageKey } from "@/i18n";
import { relativeTimeFromIso } from "@/lib/format";
import type { InstalledSkillView, LinkHealth } from "@/lib/ipc";
import { sharedState, type SharedState } from "@/lib/ownership";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { hasUpdate, sections, useMySkills } from "@/store/my-skills";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/**
 * 「我的技能」页:行式列表(UI-Demo 的 mine 视图形态)。
 *
 * 假设(文档未覆盖):Demo 汇总条里的「全部更新」按钮不做——批量安装属任务 12,
 * 摆一个点了没反应的按钮和空状态撒谎是同一类问题。汇总条只报数量。
 *
 * v6 任务 4:此前的「由技能库管理 / 本地创建 / 其他工具装的」三分区(靠
 * `unclaimed`/`claimBindable`/`localOnly`/`claimed` 四个字段与「纳入管理 /
 * 移出管理」两个动作维持)整个撤销,换成「我分享的 / 我安装的」两分区
 * ——归属不再靠本地记账猜测,库里的 `authors.json` 才是权威(`relation` 字段)。
 */
export function MySkillsPage() {
  const {
    list,
    loading,
    loadError,
    load,
    agentNames,
    askRemove,
    repair,
    repairBusy,
    repairError,
    shareChanges,
    shareUpdate,
    shareBusy,
    shareDone,
    shareError,
    pull,
  } = useMySkills();
  const index = useStoreIndex((s) => s.index);
  const installPhase = useInstall((s) => s.phase);
  const activeSlug = useInstall((s) => s.dirSlug);
  // 「以本地为准,分享更新」(冲突弹窗里那一条)走的是 useInstall 的
  // keepLocalAndShareMine,结果只写进 useInstall.shareResult——而它此前唯一的
  // 渲染点在 InstallPanel 的装完那一屏,从这一页点进去时那个面板根本不在场:
  // 弹窗一消失就什么都没有,**分享失败也静默**。这里接到本页既有的提示位上。
  // 假设:shareResult 一直留到下一次 begin()/cancel(),所以从商店页做完同样的
  // 动作再切过来也会看到这句——话是真的,只是位置多了一处,好过静默失败。
  const installShareResult = useInstall((s) => s.shareResult);
  const setPage = useUi((s) => s.setPage);

  useEffect(() => {
    void load();
  }, [load]);

  // 更新流程结束后(done/idle)刷新列表,徽标才跟得上
  useEffect(() => {
    if (installPhase === "done") void load();
  }, [installPhase, load]);

  const nameOf = useMemo(() => {
    const map = new Map(index?.skills.map((s) => [s.dirSlug, s.name]) ?? []);
    return (slug: string) => map.get(slug) ?? slug;
  }, [index]);

  // 跳分享页并预选那个候选——分享页自己的 load() 只刷新 candidates,不碰
  // phase/target,所以在导航前把 begin() 定下来即可。两档共用:`draft`(还没
  // 分享过)与 `noBaseline`(库里记我是作者,但没有安装记账、没法走
  // `share_installed` 那条更新路径,只能走分享页的同名三分支重新推一次)。
  const goShare = async (dirSlug: string) => {
    await useShare.getState().load();
    const candidate = useShare.getState().candidates?.find((c) => c.dirName === dirSlug);
    if (candidate) useShare.getState().begin(candidate);
    setPage("share");
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

  if (list.length === 0) {
    return (
      <div className="py-6">
        <p className="text-[12.5px] text-text-2">{t("mine.empty")}</p>
        <button
          type="button"
          onClick={() => setPage("store")}
          className="mt-2.5 h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("mine.emptyCta")}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3.5 py-2.5 text-[12.5px] text-text-2">
        {t("mine.count", { count: list.length })}
      </div>
      {repairError && (
        <p className="pb-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.repairFailed")}
          {t("punct.labelSeparator")}
          {repairError.message}
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
      {/* 两分区,固定顺序:我分享的 → 我安装的(v6 任务 4)。归类判据全部来自
          core 的 `relation` 字段:`shared`/`draft` 归「我分享的」,`installed`
          归「我安装的」。空分区不显示。 */}
      {sections(list).map((sec) => (
        <section key={sec.key} className="mt-3 first-of-type:mt-0">
          <h3 className="pb-1.5 text-[11.5px] font-medium text-text-3">{sec.title}</h3>
          <div className="overflow-hidden rounded-card border border-border bg-surface-1">
            {sec.items.map((skill) =>
              sec.key === "shared" ? (
                <SharedRow
                  key={skill.dirSlug}
                  skill={skill}
                  name={nameOf(skill.dirSlug)}
                  agentNames={agentNames}
                  remoteChanged={hasUpdate(skill, index)}
                  pulling={activeSlug === skill.dirSlug && installPhase === "running"}
                  sharing={shareBusy === skill.dirSlug}
                  repairing={repairBusy === skill.dirSlug}
                  onPull={() => void pull(skill.dirSlug)}
                  onShareUpdate={() => void shareUpdate(skill.dirSlug)}
                  onGoShare={() => void goShare(skill.dirSlug)}
                  onRepair={() => void repair(skill.dirSlug)}
                  onRemove={() => askRemove(skill.dirSlug)}
                />
              ) : (
                <Row
                  key={skill.dirSlug}
                  skill={skill}
                  name={nameOf(skill.dirSlug)}
                  agentNames={agentNames}
                  updateAvailable={hasUpdate(skill, index)}
                  updating={activeSlug === skill.dirSlug && installPhase === "running"}
                  repairing={repairBusy === skill.dirSlug}
                  sharing={shareBusy === skill.dirSlug}
                  onUpdate={() =>
                    // 更新带账上的来源坐标(M4 多仓):缺省会打到该源主仓,追加仓的技能就更新错了库
                    void useInstall
                      .getState()
                      .beginUpdate(
                        skill.dirSlug,
                        skill.agents,
                        skill.registryId,
                        `${skill.sourceOwner}/${skill.sourceRepo}`,
                      )
                  }
                  onRepair={() => void repair(skill.dirSlug)}
                  onShareChanges={() => void shareChanges(skill.dirSlug)}
                  onRemove={() => askRemove(skill.dirSlug)}
                />
              ),
            )}
          </div>
        </section>
      ))}
      {/* 第三区:装在项目里的。按项目分组,与上面两区的扁平列表结构不同,
          所以是独立组件(数据源也不同:项目级真相在各项目的记账文件里)。 */}
      <ProjectSections />
    </div>
  );
}

const SHARED_STATE_LABEL: Record<SharedState, MessageKey> = {
  synced: "mine.stateSynced",
  localAhead: "mine.stateLocalAhead",
  remoteAhead: "mine.stateRemoteAhead",
  both: "mine.stateBoth",
  draft: "mine.stateDraft",
  notHere: "mine.stateNotHere",
  noBaseline: "mine.stateNoBaseline",
};

const HEALTH_LABEL: Record<Exclude<LinkHealth, "healthy">, MessageKey> = {
  broken: "health.broken",
  redirected: "health.redirected",
  occupied: "health.occupied",
  missing: "health.missing",
};

/**
 * 「我分享的」区块的一行:七状态机(`sharedState`)驱动主动作,状态本身
 * 替代了此前给作者自己技能显示的「已改动」徽标——`draft`/`both`/`localAhead`
 * 的状态文案已经把"哪边有改动"说清楚了,不需要再叠一个徽标说同一件事。
 *
 * `hasRecord`(`contentHash !== ""`)是判断"这一行有没有 `state.installed` 真实
 * 记账"的唯一信号(🔴 **判据是 `contentHash` 不是 `commitSha`**:存量 `state.json`
 * 里旧版「认领」写下的条目 `commit_sha` 为空、`content_hash` 却有值,按 commitSha
 * 判会把它们误判成"没有记账"——而它们的记账真实存在,「修复关联」「移除」对它们
 * 完全有效。把有效的动作撤掉就是做成死路,与 v6 终审修复里 `install.ts` 那条
 * 用的是同一把尺子)——只有这样的行才谈得上「修复」「移除」(`skill_repair`/
 * `skill_remove` 都要求记账存在,没有就报 `FS_NOT_INSTALLED`)。**`noBaseline`
 * 恰恰就是 `hasRecord` 为假的那一档**(没有记账就没有 `contentHash` 基线),
 * 所以它与 `draft` 一样只能走「修复」「移除」以外的路——主动作是「分享更新」,
 * 但走的是分享页(`onGoShare`),不是 `share_installed`(`onShareUpdate`):
 * 后者一进门就要求记账存在,必撞 `FS_NOT_INSTALLED`。
 */
function SharedRow({
  skill,
  name,
  agentNames,
  remoteChanged,
  pulling,
  sharing,
  repairing,
  onPull,
  onShareUpdate,
  onGoShare,
  onRepair,
  onRemove,
}: {
  skill: InstalledSkillView;
  name: string;
  agentNames: Map<string, string>;
  remoteChanged: boolean;
  pulling: boolean;
  sharing: boolean;
  repairing: boolean;
  onPull: () => void;
  onShareUpdate: () => void;
  onGoShare: () => void;
  onRepair: () => void;
  onRemove: () => void;
}) {
  const state = sharedState(skill, remoteChanged);
  const hasRecord = skill.contentHash !== "";
  const issues = skill.links.filter((l) => l.health !== "healthy");

  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0">
      {/* 名称区整块可点开详情;右侧动作按钮在这块外面,不会误触 */}
      <button
        type="button"
        onClick={() => void useLocalDetail.getState().open({ dirSlug: skill.dirSlug })}
        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <SkillIcon name={name} className="size-[26px] rounded-[6px] text-[12px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-[550] group-hover:text-accent">{name}</span>
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
            {issues.length > 0 && (
              <Badge
                title={issues
                  .map(
                    (l) =>
                      `${l.dir}${t("punct.labelSeparator")}${t(
                        HEALTH_LABEL[l.health as Exclude<LinkHealth, "healthy">],
                      )}`,
                  )
                  .join("\n")}
              >
                {t("mine.badgeLinkIssue", { count: issues.length })}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-text-3">
            <span>{t(SHARED_STATE_LABEL[state])}</span>
            {skill.sourceLabel && (
              <>
                <span>·</span>
                <span>{t("mine.sourceLabel", { label: skill.sourceLabel })}</span>
              </>
            )}
            {hasRecord && (
              <>
                <span>·</span>
                <span>
                  {skill.agents.length > 0
                    ? t("mine.enabledFor", {
                        agents: skill.agents
                          .map((a) => agentNames.get(a) ?? a)
                          .join(t("punct.listSeparator")),
                      })
                    : t("mine.enabledNone")}
                </span>
                <span>·</span>
                <span>{t("mine.acquiredAt", { when: relativeTimeFromIso(skill.updatedAt) })}</span>
              </>
            )}
          </div>
        </div>
      </button>

      <div className="flex flex-none items-center gap-1.5">
        {issues.length > 0 && hasRecord && (
          <button
            type="button"
            disabled={repairing}
            onClick={onRepair}
            className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {repairing ? t("mine.repairing") : t("mine.repair")}
          </button>
        )}
        {state === "draft" && (
          <button
            type="button"
            onClick={onGoShare}
            className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90"
          >
            {t("mine.share")}
          </button>
        )}
        {/* noBaseline:没有 state.installed 记账,`share_installed` 一进门就要求
            记账存在,直调必撞 FS_NOT_INSTALLED——只能走分享页那条路(与 draft
            共用 `onGoShare`),同名三分支会处理"远端已存在"。按钮文案用
            「分享更新」(与 localAhead 那颗字面相同)是刻意的:两者都是"把本地
            内容重新推一次",只是走的编排不同,用户不需要分辨。 */}
        {state === "noBaseline" && (
          <button
            type="button"
            onClick={onGoShare}
            className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90"
          >
            {t("mine.shareUpdate")}
          </button>
        )}
        {(state === "notHere" || state === "remoteAhead" || state === "both") && (
          <button
            type="button"
            disabled={pulling}
            onClick={onPull}
            className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {pulling ? t("mine.pulling") : t("mine.pull")}
          </button>
        )}
        {/* 与既有 Row 的「分享改动」同款闸门(`localModified && !sourceRemoved &&
            !libraryRemoved`):来源没了,回推没有去处,摆出来就是引诱用户撞
            必然报错的按钮。这是 `localAhead` 七状态里唯一摆得出这个按钮、
            同时又可能撞上来源问题的一档——`remoteAhead`/`both` 已经被
            `hasUpdate` 的早退挡住(sourceRemoved/libraryRemoved 时它恒返回
            false,进不了这两档),`notHere` 的这两个标志在 core 侧恒为
            false(见 `commands::InstalledSkillView.local_present` 注释),
            `noBaseline` 走的是分享页而不是这条闸门守着的 `share_installed`。
            状态文字「有改动未分享」仍然是实话,保留;上面的徽标已经把
            "为什么没有按钮"说清楚了。 */}
        {state === "localAhead" && !skill.sourceRemoved && !skill.libraryRemoved && (
          <button
            type="button"
            disabled={sharing}
            onClick={onShareUpdate}
            className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {sharing ? t("mine.sharingChanges") : t("mine.shareUpdate")}
          </button>
        )}
        {hasRecord && (
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
  );
}

function Row({
  skill,
  name,
  agentNames,
  updateAvailable,
  updating,
  repairing,
  sharing,
  onUpdate,
  onRepair,
  onShareChanges,
  onRemove,
}: {
  skill: InstalledSkillView;
  name: string;
  agentNames: Map<string, string>;
  updateAvailable: boolean;
  updating: boolean;
  repairing: boolean;
  sharing: boolean;
  onUpdate: () => void;
  onRepair: () => void;
  onShareChanges: () => void;
  onRemove: () => void;
}) {
  const issues = skill.links.filter((l) => l.health !== "healthy");
  // 与 SharedRow 同一个概念、**同一把尺子**:这一行有没有 `state.installed` 记账。
  // 判据用 `contentHash`(记账基线)——`installed_list` 的另外两档把它留空,只有真正
  // 有记账的第一档填得出真值。`skill_remove` 一进门就要求记账存在,没有记账
  // 却摆出「移除」,点下去先弹一句"将从所有 AI 工具解除关联,并删除本地技能文件",
  // 然后报 FS_NOT_INSTALLED——不摆比解释好。
  const hasRecord = skill.contentHash !== "";
  // 内部字段的空值不许漏到界面上:没有记账的行 sourceOwner/sourceRepo 都是空串,
  // 直接拼出来是「来自 /」;updatedAt 为空时 relativeTimeFromIso 返回空串,
  // 渲染出来是「获取于 」。值为空就整段不摆。
  const library =
    skill.sourceOwner && skill.sourceRepo ? `${skill.sourceOwner}/${skill.sourceRepo}` : "";
  const acquiredAt = relativeTimeFromIso(skill.updatedAt);

  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0">
      {/* 名称区整块可点开详情;右侧动作按钮在这块外面,不会误触 */}
      <button
        type="button"
        onClick={() => void useLocalDetail.getState().open({ dirSlug: skill.dirSlug })}
        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
      >
      <SkillIcon name={name} className="size-[26px] rounded-[6px] text-[12px]" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-[550] group-hover:text-accent">{name}</span>
          {/* 每个徽标都要能说清"这是什么、我该做什么":其余徽标一直有 tooltip,
              这两个的文案早就写好却没接上,悬停什么也看不到 */}
          {skill.localModified && (
            <Badge title={t("mine.badgeModifiedHint")}>
              {t("mine.badgeModified")}
            </Badge>
          )}
          {skill.sourceRemoved && (
            <Badge title={t("mine.badgeSourceRemovedHint")}>
              {t("mine.badgeSourceRemoved")}
            </Badge>
          )}
          {/* 源在、库不在:与上面互斥(core 保证两者不同时为 true),但话不一样 */}
          {skill.libraryRemoved && (
            <Badge title={t("mine.badgeLibraryRemovedHint")}>
              {t("mine.badgeLibraryRemoved")}
            </Badge>
          )}
          {issues.length > 0 && (
            <Badge
              title={issues
                .map(
                  (l) =>
                    `${l.dir}${t("punct.labelSeparator")}${t(
                      HEALTH_LABEL[l.health as Exclude<LinkHealth, "healthy">],
                    )}`,
                )
                .join("\n")}
            >
              {t("mine.badgeLinkIssue", { count: issues.length })}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-text-3">
          {library && (
            <>
              <span>{t("mine.source", { library })}</span>
              <span>·</span>
            </>
          )}
          <span>
            {skill.agents.length > 0
              ? t("mine.enabledFor", {
                  agents: skill.agents
                    .map((a) => agentNames.get(a) ?? a)
                    .join(t("punct.listSeparator")),
                })
              : t("mine.enabledNone")}
          </span>
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
        {/* 目录已删的条目 core 不再返回(M5 任务 2),这里不必再判本体存在性 */}
        {skill.localModified && !skill.sourceRemoved && !skill.libraryRemoved && (
          // 冲突弹窗承诺过的那条路:改动可以推回来源技能库;来源没了就没有去处
          <button
            type="button"
            disabled={sharing}
            onClick={onShareChanges}
            className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {sharing ? t("mine.sharingChanges") : t("mine.shareChanges")}
          </button>
        )}
        {issues.length > 0 && (
          <button
            type="button"
            disabled={repairing}
            onClick={onRepair}
            className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {repairing ? t("mine.repairing") : t("mine.repair")}
          </button>
        )}
        {updateAvailable && (
          <button
            type="button"
            disabled={updating}
            onClick={onUpdate}
            className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {updating ? t("mine.updating") : t("mine.update")}
          </button>
        )}
        {hasRecord && (
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
  );
}

/** 状态徽标(来源已移除/关联异常等)。归类徽标已撤,只剩警示这一种语气。 */
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
