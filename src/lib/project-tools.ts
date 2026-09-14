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
  /**
   * 这台机器探测到了它(`DetectedAgent.installed`)。没探测到、只因"已经关联"才被带进来的
   * 成员(本机没装国际版 Trae,但 `.trae/skills` 的链接对它同样生效)**留在组里**——取消时
   * 要一起摘——但**不进标签**:否则勾上时叫「Trae CN、Trae」、取消后叫「Trae CN」,
   * 同一个开关两种名字(2026-09-14 复验),而确认条只列探测到的工具,两处也对不上。
   */
  detected: boolean;
}

/** 合并之后的一个开关:同一个项目目录的工具共用它。 */
export interface ProjectToolGroup {
  /** 组内全部 agent 名(保持首次出现的顺序)。提交时整组一起进出。 */
  agents: string[];
  /**
   * 稳定标识,用作 `ToolPickerItem.agent`。**按目录定**(`dir:<skillsDir>`),目录未知时取 agent 名。
   * 🔴 不能由成员拼成:成员会随"已关联"进出(见 `detected`),id 一变 ToolPicker 就当成
   * 另一批数据,刚点的那一项跳走(2026-09-14 复验回归)。
   */
  id: string;
  /** 组内展示名(只含探测到的成员;一个都没有时退回全部),调用方负责用列表分隔符拼起来。 */
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
  type Draft = { group: ProjectToolGroup; detectedLabels: string[]; allLabels: string[] };
  const drafts: Draft[] = [];
  const byDir = new Map<string, Draft>();
  for (const m of members) {
    const existing = m.skillsDir ? byDir.get(m.skillsDir) : undefined;
    if (existing) {
      existing.group.on = existing.group.on || m.on;
      if (existing.group.agents.includes(m.agent)) {
        if (m.detected && !existing.detectedLabels.includes(m.label)) existing.detectedLabels.push(m.label);
        continue;
      }
      existing.group.agents.push(m.agent);
      existing.allLabels.push(m.label);
      if (m.detected) existing.detectedLabels.push(m.label);
      continue;
    }
    const draft: Draft = {
      group: {
        agents: [m.agent],
        id: m.skillsDir ? `dir:${m.skillsDir}` : m.agent,
        labels: [],
        skillsDir: m.skillsDir,
        on: m.on,
      },
      detectedLabels: m.detected ? [m.label] : [],
      allLabels: [m.label],
    };
    drafts.push(draft);
    if (m.skillsDir) byDir.set(m.skillsDir, draft);
  }
  return drafts.map((d) => ({
    ...d.group,
    labels: d.detectedLabels.length > 0 ? d.detectedLabels : d.allLabels,
  }));
}

/**
 * 翻转一整组之后的目标集合:打开 = 并上整组,关闭 = 去掉整组。
 * 只去掉/加上这一组,其余已选的原样保留(`project_skill_set_agents` 收的是完整目标集)。
 */
export function applyGroupToggle(current: string[], groupAgents: string[], next: boolean): string[] {
  const rest = current.filter((a) => !groupAgents.includes(a));
  return next ? [...rest, ...groupAgents] : rest;
}
