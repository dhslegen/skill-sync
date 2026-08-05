import { useEffect, useMemo } from "react";

import { SkillIcon } from "@/components/SkillIcon";
import { t, type MessageKey } from "@/i18n";
import { relativeTimeFromIso } from "@/lib/format";
import type { InstalledSkillView, LinkHealth } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { hasUpdate, useMySkills } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/**
 * 「我的技能」页:行式列表(UI-Demo 的 mine 视图形态)。
 *
 * 假设(文档未覆盖):Demo 汇总条里的「全部更新」按钮不做——批量安装属任务 12,
 * 摆一个点了没反应的按钮和空状态撒谎是同一类问题。汇总条只报数量。
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
    shareBusy,
    shareDone,
    shareError,
    claim,
    unclaim,
    claimBusy,
    claimError,
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
      {claimError && (
        <p className="pb-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.claimFailed")}
          {t("punct.labelSeparator")}
          {claimError.message}
        </p>
      )}
      {shareDone && (
        <p className="pb-2 text-[12px] text-text-2">
          {shareDone.mode === "pushed"
            ? t("mine.shareChangesDone")
            : t("mine.shareChangesReview")}
        </p>
      )}
      {/* 三分区,固定顺序:商店安装 → 本地创建 → npx skills 安装(M5 任务 2 用户拍板)。
          归类判据全部来自 core:第 1 档是 state 记账且目录真实存在,第 2 档是文件系统
          扫描(localOnly),第 3 档是 .skill-lock.json(unclaimed)。空分区不显示。 */}
      {sectionsOf(list).map((sec) => (
        <section key={sec.key} className="mt-3 first-of-type:mt-0">
          <h3 className="pb-1.5 text-[11.5px] font-medium text-text-3">{sec.title}</h3>
          <div className="overflow-hidden rounded-card border border-border bg-surface-1">
            {sec.items.map((skill) =>
              skill.localOnly ? (
                <LocalOnlyRow
                  key={skill.dirSlug}
                  skill={skill}
                  name={nameOf(skill.dirSlug)}
                  onGoShare={() => setPage("share")}
                />
              ) : skill.unclaimed ? (
                <UnclaimedRow
                  key={skill.dirSlug}
                  skill={skill}
                  name={nameOf(skill.dirSlug)}
                  claiming={claimBusy === skill.dirSlug}
                  onClaim={() => void claim(skill.dirSlug)}
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
                  unclaiming={claimBusy === skill.dirSlug}
                  onUnclaim={() => void unclaim(skill.dirSlug)}
                />
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 三分区的归类与顺序。空分区被滤掉,调用方不用再判。 */
function sectionsOf(list: InstalledSkillView[]) {
  return [
    {
      key: "store",
      title: t("mine.sectionStore"),
      items: list.filter((s) => !s.localOnly && !s.unclaimed),
    },
    { key: "local", title: t("mine.sectionLocal"), items: list.filter((s) => s.localOnly) },
    { key: "npx", title: t("mine.sectionNpx"), items: list.filter((s) => s.unclaimed) },
  ].filter((sec) => sec.items.length > 0);
}

/** 上游(npx skills)装的未认领行:只有「认领」可做,其余动作认领后开放。 */
function UnclaimedRow({
  skill,
  name,
  claiming,
  onClaim,
}: {
  skill: InstalledSkillView;
  name: string;
  claiming: boolean;
  onClaim: () => void;
}) {
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
          {/* 归类徽标已撤(M5 任务 2):分区标题即区分,行内不再重复喊一遍 */}
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-[550] group-hover:text-accent">{name}</span>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-text-3">
            {t("mine.source", {
              library: skill.sourceRepo
                ? `${skill.sourceOwner}/${skill.sourceRepo}`
                : skill.sourceOwner,
            })}
          </div>
        </div>
      </button>
      <div className="flex flex-none items-center">
        <button
          type="button"
          disabled={claiming}
          onClick={onClaim}
          className="h-6 rounded-ctl bg-accent px-2.5 text-[11.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {claiming ? t("mine.claiming") : t("mine.claim")}
        </button>
      </div>
    </div>
  );
}

/**
 * 第三档:本地技能(自己新建的 / 手放进 canonical 的)。
 *
 * 它没有来源、没有关联记账,所以**更新、修复关联、分享改动、移除一概不摆**
 * ——摆出来就是引诱用户点一个必然失败的按钮。能做的只有看详情与去分享,
 * 而"去分享"正是这类技能的下一步。
 */
function LocalOnlyRow({
  skill,
  name,
  onGoShare,
}: {
  skill: InstalledSkillView;
  name: string;
  onGoShare: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0">
      <button
        type="button"
        onClick={() => void useLocalDetail.getState().open({ dirSlug: skill.dirSlug })}
        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <SkillIcon name={name} className="size-[26px] rounded-[6px] text-[12px]" />
        <div className="min-w-0 flex-1">
          {/* 归类徽标已撤(M5 任务 2):分区标题即区分 */}
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-[550] group-hover:text-accent">{name}</span>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-text-3">{t("mine.localHint")}</div>
        </div>
      </button>
      <div className="flex flex-none items-center">
        <button
          type="button"
          onClick={onGoShare}
          className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("mine.goShare")}
        </button>
      </div>
    </div>
  );
}

const HEALTH_LABEL: Record<Exclude<LinkHealth, "healthy">, MessageKey> = {
  broken: "health.broken",
  redirected: "health.redirected",
  occupied: "health.occupied",
  missing: "health.missing",
};

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
  unclaiming,
  onUnclaim,
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
  unclaiming: boolean;
  onUnclaim: () => void;
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
        {/* 认领来的才给「取消认领」:它只删记账、磁盘一个字节不动,是认领的逆操作。
            在它之前,认领后唯一的退路是「移除」,而移除会连 npx skills 那边的
            安装一起毁掉——无害的进入,破坏性的退出。 */}
        {skill.claimed && (
          <button
            type="button"
            disabled={unclaiming}
            onClick={onUnclaim}
            title={t("mine.unclaimHint")}
            className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {unclaiming ? t("mine.unclaiming") : t("mine.unclaim")}
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

/** 状态徽标(已改动/来源已移除/关联异常)。归类徽标已撤,只剩警示这一种语气。 */
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
