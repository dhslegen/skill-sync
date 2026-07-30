import type { StoreSkillCard } from "@/lib/ipc";

/** 商店过滤档。UI-Demo 里的"文档/代码/数据/办公"分类在 SKILL.md 里没有数据源
 *  (frontmatter 只有 name/description),编造分类会在界面上撒谎。
 *  故保留 chip 形态,换成有真实数据源的三档。见 commit message 里标注的假设。 */
export type StoreFilter = "all" | "available" | "installed";

/** 子串匹配 name / description / 目录名。M1 简版;中文拼音首字母匹配是 M3 增强(UX #7)。 */
export function matchesQuery(skill: StoreSkillCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q) ||
    skill.dirSlug.toLowerCase().includes(q)
  );
}

export function filterSkills(
  skills: StoreSkillCard[],
  query: string,
  filter: StoreFilter,
  installed: ReadonlySet<string>,
): StoreSkillCard[] {
  return skills.filter((skill) => {
    if (!matchesQuery(skill, query)) return false;
    if (filter === "installed") return installed.has(skill.dirSlug);
    if (filter === "available") return !installed.has(skill.dirSlug);
    return true;
  });
}
