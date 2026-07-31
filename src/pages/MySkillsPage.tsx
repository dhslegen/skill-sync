import { useEffect, useMemo } from "react";

import { SkillIcon } from "@/components/SkillIcon";
import { t, type MessageKey } from "@/i18n";
import { relativeTimeFromIso } from "@/lib/format";
import type { InstalledSkillView, LinkHealth } from "@/lib/ipc";
import { useInstall } from "@/store/install";
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
      {shareDone && (
        <p className="pb-2 text-[12px] text-text-2">
          {shareDone.mode === "pushed"
            ? t("mine.shareChangesDone")
            : t("mine.shareChangesReview")}
        </p>
      )}
      <div className="overflow-hidden rounded-card border border-border bg-surface-1">
        {list.map((skill) => (
          <Row
            key={skill.dirSlug}
            skill={skill}
            name={nameOf(skill.dirSlug)}
            agentNames={agentNames}
            updateAvailable={hasUpdate(skill, index?.commitSha)}
            updating={activeSlug === skill.dirSlug && installPhase === "running"}
            repairing={repairBusy === skill.dirSlug}
            sharing={shareBusy === skill.dirSlug}
            onUpdate={() => void useInstall.getState().beginUpdate(skill.dirSlug, skill.agents)}
            onRepair={() => void repair(skill.dirSlug)}
            onShareChanges={() => void shareChanges(skill.dirSlug)}
            onRemove={() => askRemove(skill.dirSlug)}
          />
        ))}
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
      <SkillIcon name={name} className="size-[26px] rounded-[6px] text-[12px]" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-[550]">{name}</span>
          {skill.localModified && <Badge tone="warn">{t("mine.badgeModified")}</Badge>}
          {!skill.bodyPresent && <Badge tone="danger">{t("mine.badgeBodyMissing")}</Badge>}
          {issues.length > 0 && (
            <Badge
              tone="warn"
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

      <div className="flex flex-none items-center gap-1.5">
        {skill.localModified && skill.bodyPresent && (
          // 冲突弹窗承诺过的那条路:改动可以推回公司技能库
          <button
            type="button"
            disabled={sharing}
            onClick={onShareChanges}
            className="h-6 rounded-ctl border border-border px-2.5 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50"
          >
            {sharing ? t("mine.sharingChanges") : t("mine.shareChanges")}
          </button>
        )}
        {issues.length > 0 && skill.bodyPresent && (
          // 本体不在时链接修不了(link_only 会拒绝),这时该走的是「更新」重新获取
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

function Badge({
  tone,
  title,
  children,
}: {
  tone: "warn" | "danger";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={[
        "flex-none rounded-[4px] border px-1.5 py-px text-[10.5px] font-medium",
        tone === "danger"
          ? "border-[#c0392b]/40 text-[#c0392b] dark:border-[#e0705f]/40 dark:text-[#e0705f]"
          : "border-[#b8860b]/40 text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]",
      ].join(" ")}
    >
      {children}
    </span>
  );
}
