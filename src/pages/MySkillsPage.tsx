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

  // 草稿(relation === "draft")跳分享页并预选那个候选——分享页自己的 load()
  // 只刷新 candidates,不碰 phase/target,所以在导航前把 begin() 定下来即可。
  const goShareDraft = async (dirSlug: string) => {
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
                  onShareDraft={() => void goShareDraft(skill.dirSlug)}
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
};

const HEALTH_LABEL: Record<Exclude<LinkHealth, "healthy">, MessageKey> = {
  broken: "health.broken",
  redirected: "health.redirected",
  occupied: "health.occupied",
  missing: "health.missing",
};

/**
 * 「我分享的」区块的一行:六状态机(`sharedState`)驱动主动作,状态本身
 * 替代了此前给作者自己技能显示的「已改动」徽标——`draft`/`both`/`localAhead`
 * 的状态文案已经把"哪边有改动"说清楚了,不需要再叠一个徽标说同一件事。
 *
 * `hasRecord`(`commitSha !== ""`)是判断"这一行有没有 `state.installed` 真实
 * 记账"的唯一信号——只有这样的行才谈得上「修复」「移除」(`skill_repair`/
 * `skill_remove` 都要求记账存在,没有就报 `FS_NOT_INSTALLED`)。
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
  onShareDraft,
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
  onShareDraft: () => void;
  onRepair: () => void;
  onRemove: () => void;
}) {
  const state = sharedState(skill, remoteChanged);
  const hasRecord = skill.commitSha !== "";
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
            onClick={onShareDraft}
            className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90"
          >
            {t("mine.share")}
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
        {state === "localAhead" && (
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
          <span>{t("mine.source", { library: `${skill.sourceOwner}/${skill.sourceRepo}` })}</span>
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
        <button
          type="button"
          onClick={onRemove}
          className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("mine.remove")}
        </button>
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
