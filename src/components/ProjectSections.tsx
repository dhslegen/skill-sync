import { useEffect, useState } from "react";
import { FolderOpen, TriangleAlert } from "lucide-react";

import { Icon } from "@/components/Icon";
import { SkillIcon } from "@/components/SkillIcon";
import { t } from "@/i18n";
import { defaultSelectedAgents } from "@/store/install";
import {
  agentsDetected,
  projectReveal,
  type ProjectGroupView,
  type ProjectSkillView,
} from "@/lib/ipc";
import { useProjects } from "@/store/project";

/**
 * 「我的技能」的第四分区:装在项目里的技能。
 *
 * 与其他三区(扁平列表)结构不同——这一区**按项目分组**,所以做成独立组件而不是
 * 塞进 `sectionsOf`。组的语义是"一个工作文件夹",不是一类技能。
 *
 * 三种组态各自能做什么:
 * - 正常:每个技能可更新(来源可还原时)/ 移除;
 * - 目录不在了:整组只提供「从列表移除」——技能列不出来,别的动作也无从做起;
 * - 记账文件看不懂:只读展示。本应用一个字节都不写(见 core::project_lock 的版本闸门)。
 */
export function ProjectSections() {
  const groups = useProjects((s) => s.groups);
  const loading = useProjects((s) => s.loading);
  const load = useProjects((s) => s.load);
  const notice = useProjects((s) => s.notice);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && groups.length === 0) return null;

  return (
    <section>
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {t("mine.sectionProjects")}
      </h2>

      {groups.length === 0 ? (
        <div className="rounded-card border border-border bg-surface-1 px-3.5 py-4">
          <p className="text-[12.5px] text-text-2">{t("mine.projectsEmpty")}</p>
          <p className="mt-1 text-[11.5px] text-text-3">{t("mine.projectsEmptyCta")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {groups.map((g) => (
            <ProjectGroup key={g.path} group={g} />
          ))}
        </div>
      )}

      {notice && <p className="mt-2 text-[11.5px] text-text-2">{notice}</p>}
    </section>
  );
}

function ProjectGroup({ group }: { group: ProjectGroupView }) {
  const forget = useProjects((s) => s.forget);

  return (
    <div className="rounded-card border border-border bg-surface-1">
      <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
        <Icon icon={FolderOpen} size={15} className="shrink-0 text-text-3" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-[550]">{group.folderName}</div>
          {/* 路径用等宽字体(UI 规范:路径/slug/sha 一律等宽) */}
          <div className="truncate font-mono text-[11px] text-text-3" title={group.path}>
            {group.path}
          </div>
        </div>
        {!group.missing && !group.readOnly && (
          <span className="shrink-0 text-[11.5px] text-text-3">
            {t("mine.projectSkillCount", { count: String(group.skills?.length ?? 0) })}
          </span>
        )}
        {!group.missing && (
          <button
            type="button"
            onClick={() => void projectReveal(group.path)}
            className="h-6 shrink-0 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("mine.projectReveal")}
          </button>
        )}
        <button
          type="button"
          title={t("mine.projectForgetHint")}
          onClick={() => void forget(group.path)}
          className="h-6 shrink-0 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("mine.projectForget")}
        </button>
      </div>

      {group.missing ? (
        <StatusRow
          text={t("mine.projectMissing")}
          hint={t("mine.projectMissingHint")}
          warn
        />
      ) : group.readOnly ? (
        <StatusRow
          text={t("mine.projectReadOnly")}
          hint={t("mine.projectReadOnlyHint")}
          warn
        />
      ) : (group.skills?.length ?? 0) === 0 ? (
        <StatusRow text={t("mine.projectEmpty")} />
      ) : (
        (group.skills ?? []).map((skill) => (
          <ProjectSkillRow key={skill.key} projectPath={group.path} skill={skill} />
        ))
      )}
    </div>
  );
}

function StatusRow({ text, hint, warn }: { text: string; hint?: string; warn?: boolean }) {
  return (
    <div className="px-3.5 py-3">
      <p
        className={
          warn
            ? "flex items-center gap-1.5 text-[12.5px] text-[#9a6a00] dark:text-[#d9a94a]"
            : "text-[12.5px] text-text-3"
        }
      >
        {warn && <Icon icon={TriangleAlert} size={13} />}
        {text}
      </p>
      {hint && <p className="mt-1 text-[11.5px] text-text-3">{hint}</p>}
    </div>
  );
}

function ProjectSkillRow({
  projectPath,
  skill,
}: {
  projectPath: string;
  skill: ProjectSkillView;
}) {
  const update = useProjects((s) => s.update);
  const remove = useProjects((s) => s.remove);
  const busyKey = useProjects((s) => s.busyKey);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const busy = busyKey === skill.key;

  const runUpdate = async () => {
    const detected = await agentsDetected();
    await update({
      projectPath,
      key: skill.key,
      // 必须用仓库目录名,不能用 key(frontmatter name)——两者常不同,
      // 拿 key 取数会 REPO_NOT_FOUND。core 侧从 lock 的 skillPath 推出来,
      // 推不出来时 updatable 为 false,这个按钮根本不会渲染。
      dirSlug: skill.dirSlug ?? skill.key,
      // 源与库坐标按**账上**的来源走,不能缺省——缺省是内建源主仓,
      // 广场技能与多库场景下会装错内容(M4「更新必须带账上的仓库坐标」)。
      // core 已从 lock 的 source/sourceUrl 还原好,这里只是原样送回去。
      registryId: skill.registryId ?? undefined,
      repo: skill.repo ?? undefined,
      agentIds: defaultSelectedAgents(detected.agents),
    });
  };

  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0">
      <SkillIcon name={skill.displayName} className="size-[26px] rounded-[6px] text-[12px]" />
      <div className="min-w-0 flex-1">
        {/* 界面只露展示名,不露内部键 */}
        <div className="truncate text-[13px] font-[550]">{skill.displayName}</div>
        <div className="truncate text-[11.5px] text-text-3">
          {skill.description || t("mine.source", { library: skill.source })}
        </div>
      </div>

      {/* 来源还原不了的(local/node_modules/well-known)**不摆更新按钮**
          ——摆一个必然报错的按钮就是在耍用户(M6「绑不上就不摆」同款) */}
      {skill.updatable && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void runUpdate()}
          className="h-6 shrink-0 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
        >
          {busy ? t("mine.projectUpdating") : t("mine.projectUpdate")}
        </button>
      )}

      {confirmingRemove ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11.5px] text-text-3">
            {t("mine.projectRemoveTitle", { name: skill.displayName })}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirmingRemove(false);
              void remove(projectPath, skill.key, true);
            }}
            className="h-6 rounded-ctl border border-[#c0392b] px-2 text-[11.5px] font-medium text-[#c0392b] hover:bg-[#c0392b] hover:text-white disabled:opacity-60"
          >
            {t("mine.projectRemove")}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingRemove(false)}
            className="h-6 rounded-ctl px-2 text-[11.5px] font-medium text-text-3 hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirmingRemove(true)}
          className="h-6 shrink-0 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
        >
          {t("mine.projectRemove")}
        </button>
      )}
    </div>
  );
}
