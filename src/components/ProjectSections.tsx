import { useEffect, useState } from "react";
import { FolderOpen, TriangleAlert } from "lucide-react";

import { Icon } from "@/components/Icon";
import { SkillIcon } from "@/components/SkillIcon";
import { SkillRowMenu, type SkillRowMenuItem } from "@/components/SkillRowMenu";
import { ToolPicker, type ToolPickerItem } from "@/components/ToolPicker";
import { t } from "@/i18n";
import {
  projectReveal,
  type ProjectGroupView,
  type ProjectSkillView,
  type ToolState,
} from "@/lib/ipc";
import { matchesProjectQuery, useMineSearch } from "@/store/mine-search";
import { useProjects } from "@/store/project";

/**
 * 「项目里的技能」整页(v7 任务 8 重画;**v7.3 起它是侧边栏上的一页,不再是
 * 「我的技能」的第四个页签**)。
 *
 * 🔴 v7.3 需求 1:那一行页签**混了两个轴**——前三个回答"与公司技能库的关系",
 * 「项目里」回答"装在哪",正交的两个问题排成一行,扫过去没有能串起来的逻辑。
 * 所以它升成了 `PageId` 的一档(`store/ui.ts`),由 `App.tsx` 直接渲染本组件。
 * 侧边栏那一条**刻意不摆角标**(项目级链路算不出"有几个要处理"这个数)。
 * 这一区**按项目分组**,组的语义是"一个工作文件夹",不是一类技能,
 * 所以没有跟着并进 `sections()` 那套扁平分区判定表,继续是独立组件。
 *
 * # 卡片压扁(v7 任务 8)
 *
 * 上一版每张项目卡片的标题区占两行(项目名一行、路径一行)外加两颗常驻按钮
 * (「在文件夹中显示」「从列表移除」)。这一版把项目名与路径压成一行,
 * 两颗按钮收进标题行右侧的「更多」菜单——与「通用」页"至多一颗主按钮、
 * 其余进『…』"同一条纪律,只是这里的主按钮位置从来就没有(项目卡片本身
 * 不是一个可以"更新/分享"的东西),所以标题行只剩「更多」一个可点处。
 *
 * # 技能行与「通用」页同款,外加"事后改选工具"(v7 任务 8 补的缺口)
 *
 * 图标 + 名 + 说明,有更新时一颗「更新」,「移除」退进行尾「更多」。
 * v5 只在装的那一刻选一次「让哪些工具能用」,装完就没有入口能改
 * ——点技能名那一整块(与「通用」页"点名字开详情"同一个手势)现在会
 * 展开一份内联的 `ToolPicker`,复用任务 5 的组件、`list` 变体。
 *
 * 🔴 **项目级删除仍是 v0.5.0 的老规矩:不可逆,不进废纸篓**(v7 未改这一点)
 * ——所以「移除」的确认文案**不能**照抄「通用」页 `RemoveDialog` 那句
 * "会先移到系统废纸篓,可以找回"(那是全局模型 v6 二期才有的能力)。这里用的
 * 是 `mine.projectRemoveTitle`,一个字都没提废纸篓/可找回,且保留了原有的
 * "先点一次展开确认、再点一次才真的删"两步走。
 */
export function ProjectSections() {
  const groups = useProjects((s) => s.groups);
  const loading = useProjects((s) => s.loading);
  const load = useProjects((s) => s.load);
  const notice = useProjects((s) => s.notice);
  // 终审 M-3:页头的搜索框此前是「我的技能」整页共用的单例,而这个组件完全不读
  // `useMineSearch`——用户切到这个子页签往里敲字,界面一个字都不会变,是一颗死控件。
  // ⚠️ **v7.3 独立成页之后这个坑会原样复活**:`Toolbar.tsx` 的搜索框条件必须同时
  // 放行 `page === "projects"`(已改),否则这条匹配当场变回死代码。两页共用同一份
  // query 是刻意的——它们是同一个「我的技能」心智的两半。判定与「通用」页同一条纪律:**只影响展示,不影响项目/技能
  // 本身的计数**(标题行的「N 个技能」仍是未过滤的真实数量)。
  const query = useMineSearch((s) => s.query);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && groups.length === 0) return null;

  return (
    <section>
      {groups.length === 0 ? (
        <div className="rounded-card border border-border bg-surface-1 px-3.5 py-4">
          <p className="text-[12.5px] text-text-2">{t("mine.projectsEmpty")}</p>
          <p className="mt-1 text-[11.5px] text-text-3">{t("mine.projectsEmptyCta")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => (
            <ProjectGroup key={g.path} group={g} query={query} />
          ))}
        </div>
      )}

      {notice && <p className="mt-2 text-[11.5px] text-text-2">{notice}</p>}
    </section>
  );
}

function ProjectGroup({ group, query }: { group: ProjectGroupView; query: string }) {
  const forget = useProjects((s) => s.forget);
  const filteredSkills = (group.skills ?? []).filter((s) => matchesProjectQuery(s, query));

  // 项目级动作:压进标题行的「更多」,不再是两颗常驻按钮。目录不在了就没有
  // 「在文件夹中显示」——摆一个必然失败的按钮不比不摆更有用。
  const menuItems: SkillRowMenuItem[] = [];
  if (!group.missing) {
    menuItems.push({
      key: "reveal",
      label: t("mine.projectReveal"),
      onClick: () => void projectReveal(group.path),
    });
  }
  menuItems.push({
    key: "forget",
    label: t("mine.projectForget"),
    title: t("mine.projectForgetHint"),
    onClick: () => void forget(group.path),
    separatorBefore: menuItems.length > 0,
  });

  return (
    <div className="rounded-card border border-border bg-surface-1">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2">
        <Icon icon={FolderOpen} size={14} className="shrink-0 text-text-3" />
        <span className="shrink-0 text-[13px] font-[550]">{group.folderName}</span>
        {/* 项目名 + 路径一行(卡片压扁):路径用等宽字体(UI 规范:路径/slug/sha
            一律等宽),挤占剩余空间、超长截断。 */}
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-3"
          title={group.path}
        >
          {group.path}
        </span>
        {!group.missing && !group.readOnly && (
          <span className="shrink-0 text-[11.5px] text-text-3">
            {t("mine.projectSkillCount", { count: String(group.skills?.length ?? 0) })}
          </span>
        )}
        <SkillRowMenu items={menuItems} />
      </div>

      {group.missing ? (
        <StatusRow text={t("mine.projectMissing")} hint={t("mine.projectMissingHint")} warn />
      ) : group.readOnly ? (
        <StatusRow text={t("mine.projectReadOnly")} hint={t("mine.projectReadOnlyHint")} warn />
      ) : (group.skills?.length ?? 0) === 0 ? (
        <StatusRow text={t("mine.projectEmpty")} />
      ) : filteredSkills.length === 0 ? (
        // 项目里确实有技能,只是没有一个匹配这次搜索——与上面"这个文件夹里
        // 还没有技能"是两句不同的话,复用「通用」页同一句搜索空态文案。
        <StatusRow text={t("mine.searchEmpty", { query })} />
      ) : (
        filteredSkills.map((skill) => (
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
  const pickableAgents = useProjects((s) => s.pickableAgents);
  const agentNames = useProjects((s) => s.agentNames);
  const setAgents = useProjects((s) => s.setAgents);
  const setAgentsBusy = useProjects((s) => s.setAgentsBusy);
  const setAgentsError = useProjects((s) => s.setAgentsError);
  const toolFailures = useProjects((s) => s.toolFailures);
  const toolFailuresFor = useProjects((s) => s.toolFailuresFor);
  const dismissToolFailures = useProjects((s) => s.dismissToolFailures);

  const [expanded, setExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const busy = busyKey === skill.key;

  const runUpdate = async () => {
    // 🔴 没有 agentIds:`project_skill_update` 早在任务 3 就改成从磁盘反推
    // 当初关联的那批工具,不再吃前端现场重建的默认值(见 `store/project.ts`
    // 的 `update` 文档)。
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
    });
  };

  // 事后改选:提交名单从**全量**当前关联(`skill.agents`)派生,不是从这台机器
  // 探测出来的候选列表——藏起来的已启用工具不能被静默停用(与「通用」页
  // `ToolChecks` 的 R21 同一条纪律)。`pickableAgents` 只管**显示**哪些候选,
  // 已经关联但没被探测认出来的那些仍然作为独立一项摆出来,不会从名单里消失。
  //
  // 🔴 `pickableAgents === null`(探测失败)时 `candidates` 只能是空——这里
  // **没有**全量列表可退(项目 picker 的候选唯一来源就是 `agents_detected`,
  // 不像「通用」页 `ToolChecks` 有 `tools` 兜底)。空 ≠ "没有可选的工具",
  // 两者的界面文案必须分开(见下面渲染那一段),不能让"探测失败"读起来像
  // "这台机器确实没有工具能选"——那是一句假话。
  const currentAgents = skill.agents ?? [];
  const candidates = pickableAgents ?? [];
  const candidateNames = new Set(candidates.map((a) => a.name));
  const items: ToolPickerItem[] = [
    ...candidates.map((a) => ({
      agent: a.name,
      label: a.displayName,
      // 项目级落点是项目根下各工具的目录(如 `<项目>/.claude/skills/`),不是
      // 全局目录——这一层目前没有把每个工具的项目内相对路径穿到前端(既有的
      // `DetectedAgent.globalSkillsDir` 是全局路径,摆在这里就是撒谎),
      // 留空是诚实的"没有这个信息"(与 `ToolChecks` 的既有处置同一姿态)。
      path: "",
      state: (currentAgents.includes(a.name) ? "linked" : "off") as ToolState,
    })),
    ...currentAgents
      .filter((a) => !candidateNames.has(a))
      .map((a) => ({ agent: a, label: agentNames.get(a) ?? a, path: "", state: "linked" as ToolState })),
  ];

  const handleToggle = (agent: string, next: boolean) => {
    const wanted = new Set(currentAgents);
    if (next) wanted.add(agent);
    else wanted.delete(agent);
    void setAgents(projectPath, skill.key, [...wanted]);
  };

  const menuItems: SkillRowMenuItem[] = [
    { key: "remove", label: t("mine.projectRemove"), onClick: () => setConfirmingRemove(true) },
  ];

  return (
    <div data-testid={`prow-${skill.key}`} className="border-t border-border first:border-t-0">
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <button
          type="button"
          data-testid={`prow-${skill.key}-body`}
          aria-label={t("mine.projectToggleTools", { name: skill.displayName })}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="group flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <SkillIcon name={skill.displayName} className="size-[26px] rounded-[6px] text-[12px]" />
          <div className="min-w-0 flex-1">
            {/* 界面只露展示名,不露内部键 */}
            <div className="truncate text-[13px] font-[550] group-hover:text-accent">
              {skill.displayName}
            </div>
            <div className="truncate text-[11.5px] text-text-3">
              {skill.description || t("mine.source", { library: skill.source })}
            </div>
          </div>
        </button>

        {confirmingRemove ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11.5px] text-text-3">
              {t("mine.projectRemoveTitle", { name: skill.displayName })}
            </span>
            <button
              type="button"
              disabled={busy}
              title={t("mine.projectRemoveHint")}
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
          <div className="flex flex-none items-center gap-1.5">
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
            <SkillRowMenu items={menuItems} />
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border bg-surface-2/40 px-3.5 py-2.5">
          {/* 🔴 I1 修复:"探测失败,候选未知"与"探测成功,确实没有可选的工具"
              是两件不同的事,不能合并成同一句"这台机器上没有能改选的工具"
              ——前者是假话。`pickableAgents === null` 单独判,且不拦已关联的
              工具继续显示(仍然可以取消勾选,只是没法新增)。 */}
          {pickableAgents === null ? (
            <>
              <p className="text-[11.5px] text-text-3">{t("mine.projectToolsUnknown")}</p>
              {items.length > 0 && (
                <ToolPicker
                  items={items}
                  onToggle={handleToggle}
                  disabled={setAgentsBusy === skill.key}
                  layout="list"
                />
              )}
            </>
          ) : items.length === 0 ? (
            <p className="text-[11.5px] text-text-3">{t("mine.projectNoTools")}</p>
          ) : (
            <ToolPicker
              items={items}
              onToggle={handleToggle}
              disabled={setAgentsBusy === skill.key}
              layout="list"
            />
          )}
          {setAgentsError && toolFailuresFor === skill.key && (
            <p className="mt-2 text-[11.5px] text-[#c0392b] dark:text-[#e0705f]">
              {t("mine.toolsFailed")}
              {t("punct.labelSeparator")}
              {setAgentsError.message}
            </p>
          )}
          {/* 🔴 `kept` 必须有渲染点(铁律 7):这一档不是"没做成",是"停下来问你"
              ——那个位置上是一份内容不同的东西,一个字节没动、原样留下。 */}
          {toolFailures && toolFailures.length > 0 && toolFailuresFor === skill.key && (
            <div className="mt-2 rounded-card border border-[#c0392b]/40 px-2.5 py-2 dark:border-[#e0705f]/40">
              <p className="text-[12px] font-medium text-[#c0392b] dark:text-[#e0705f]">
                {t("mine.projectToolsKept", { count: toolFailures.length })}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {toolFailures.map((a) => (
                  <li key={a} className="text-[11.5px] text-text-2">
                    {agentNames.get(a) ?? a}
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
        </div>
      )}
    </div>
  );
}
