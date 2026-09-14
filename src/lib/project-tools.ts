// 项目里的工具勾选:按**项目内技能目录**合并成"真实的开关"(0.6.x,2026-09-14 真机走查)。
//
// # 为什么非合并不可
//
// 注册表里有几组工具在项目里共用同一个 `skillsDir`:Trae 与 Trae CN(`.trae/skills`)、
// Qoder 与 Qoder CN、Zencoder 与 Zenflow。官方文档与上游 vercel-labs/skills 1.5.26
// 都写着同一个项目目录(国内版只有**全局**目录不同,`~/.trae-cn/skills`)。
//
// core 按目录建链、按目录摘链(`project::set_agents`),一条链接同时对同组的工具生效。
// 此前界面给同组每个工具各摆一个勾:取消 Trae 时提交的目标是「只要 Trae CN」,
// 而 Trae CN 需要的还是那个目录,链接留着,刷新后两个勾又回来——**永远单独取消
// 不掉,且零报错**。勾的数量必须等于真实开关的数量,才不是在对用户撒谎。
//
// # 只管项目里
//
// 全局那一侧 Trae 与 Trae CN 是两个目录,不受影响;全局只有 Zencoder/Zenflow 共用
// 目录,用户拍板本次不修(同形状欠账,已登记)。

/** 一个工具在"项目里"这个语境下的原始信息。 */
export interface ProjectToolMember {
  agent: string;
  label: string;
  /** 相对项目根的技能目录(`DetectedAgent.skillsDir`);未知时为 `undefined`,单独成组。 */
  skillsDir: string | undefined;
  /** 这个工具眼下是否已关联(或在确认条上被选中)。 */
  on: boolean;
}

/** 合并之后的一个开关:同一个项目目录的工具共用它。 */
export interface ProjectToolGroup {
  /** 组内全部 agent 名(保持首次出现的顺序)。提交时整组一起进出。 */
  agents: string[];
  /** 稳定标识,用作 `ToolPickerItem.agent`。 */
  id: string;
  /** 组内展示名,调用方负责用列表分隔符拼起来。 */
  labels: string[];
  skillsDir: string | undefined;
  /** 组内任一成员已关联即算开着——它们读的是同一条链接,不存在"一半开着"。 */
  on: boolean;
}

/**
 * 按 `skillsDir` 合并;`skillsDir` 未知的成员各自成组(不拿"不知道"去和别人合并)。
 * 组的顺序按每组第一个成员出现的位置,组内成员保持原相对顺序。
 */
export function groupProjectTools(members: ProjectToolMember[]): ProjectToolGroup[] {
  const groups: ProjectToolGroup[] = [];
  const byDir = new Map<string, ProjectToolGroup>();
  for (const m of members) {
    const existing = m.skillsDir ? byDir.get(m.skillsDir) : undefined;
    if (existing) {
      existing.on = existing.on || m.on;
      if (existing.agents.includes(m.agent)) continue;
      existing.agents.push(m.agent);
      existing.labels.push(m.label);
      existing.id = existing.agents.join("+");
      continue;
    }
    const group: ProjectToolGroup = {
      agents: [m.agent],
      id: m.agent,
      labels: [m.label],
      skillsDir: m.skillsDir,
      on: m.on,
    };
    groups.push(group);
    if (m.skillsDir) byDir.set(m.skillsDir, group);
  }
  return groups;
}

/**
 * 翻转一整组之后的目标集合:打开 = 并上整组,关闭 = 去掉整组。
 * 只去掉/加上这一组,其余已选的原样保留(`project_skill_set_agents` 收的是完整目标集)。
 */
export function applyGroupToggle(current: string[], groupAgents: string[], next: boolean): string[] {
  const rest = current.filter((a) => !groupAgents.includes(a));
  return next ? [...rest, ...groupAgents] : rest;
}
