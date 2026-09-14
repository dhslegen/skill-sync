// 项目级安装的前端状态(v5)。
//
// 与全局安装(store/install.ts)刻意分开:全局那套围绕 canonical 与 state.installed,
// 项目级的真相在各项目根的 skills-lock.json 里(与 npx skills 共用),
// 两者的记账、判定、可做的操作都不一样,合成一个 store 只会让两边互相牵制。
import { create } from "zustand";
import { applyGroupToggle, projectHasSkill } from "@/lib/project-tools";

import { t } from "@/i18n";
import {
  agentsDetected,
  isAppError,
  projectForget,
  projectList,
  projectPick,
  projectSkillInstall,
  projectSkillRemove,
  projectSkillSetAgents,
  projectSkillUpdate,
  type AppError,
  type DetectedAgent,
  type ProjectGroupView,
} from "@/lib/ipc";

/** 界面「最近的项目」最多摆几条。再多就该去「我的技能」里看了。 */
export const RECENT_PROJECT_LIMIT = 5;

/**
 * 最近用过的、还存在的项目,最多 RECENT_PROJECT_LIMIT 条。
 *
 * ⚠️ **刻意做成纯函数而不是 store 方法**:写成 `useProjects((s) => s.recent())` 的话,
 * 每次调用都 `filter().slice()` 返回新数组,Zustand 按 `Object.is` 比引用 →
 * 永远判定"变了" → 无限重渲染(2026-08-21 实测,当场打红 58 条测试)。
 * selector 里绝不能造新对象;要派生就在组件里 useMemo。
 */
export function recentProjects(groups: ProjectGroupView[]): ProjectGroupView[] {
  return groups.filter((g) => !g.missing).slice(0, RECENT_PROJECT_LIMIT);
}

/**
 * 选完文件夹之后、真正写盘之前的待确认态。
 *
 * # 为什么要有这一步(2026-08-22 用户真机反馈后拍板)
 *
 * 原先是"选完路径立刻安装",用户的原话是"我以为是选完路径后点击安装,结果直接
 * 安装了"。落差有个准确的名字:**选择位置 ≠ 确认写入**。系统选择框的按钮写着
 * 「打开」,那是"选中"语义;而这一步要往用户的项目目录里写文件、建关联、
 * 写 skills-lock.json —— 是写盘动作。业界对这条分得很清(克隆仓库、新建工程、
 * 安装游戏都要在选完位置后再点一次执行;只有"打开文件夹"这类只读操作选完即执行)。
 *
 * ⚠️ 本想改系统选择框的按钮文案为「装到这里」,那样"选完即装"就名正言顺——
 * **这条路不通**:`tauri-plugin-dialog` 2.7.2 的 `FileDialogBuilder` 只暴露
 * `set_title`/`set_directory`/`set_parent`/`set_can_create_directories`,
 * 没有按钮文案(底层 rfd 有 `set_button_label`,插件没转出来)。
 *
 * 「最近的项目」那条路**刻意豁免**这一步:用户点的是具体项目名,意图已经明确,
 * 再问一遍"是不是这个项目"纯属啰嗦。
 */
export interface ProjectConfirm {
  projectPath: string;
  dirSlug: string;
  agentIds: string[];
  /** 会关联到的工具**展示名**。界面绝不露 agent name(内部标识不能露给用户)。 */
  agentLabels: string[];
  registryId?: string;
  repo?: string;
  /** 这个项目里已经有这个技能了。确认条据此改口,不当成一次新安装。 */
  alreadyInstalled: boolean;
}

/** 一次「装到项目」的进行态。 */
interface InstallingState {
  projectPath: string;
  dirSlug: string;
}

/**
 * 需要用户拍板的两种情形。
 *
 * 🔴 `localEdits`(更新路径)**没有** `agentIds`——`project_skill_update` 已经
 * 不吃这个参数了(见 `update` 的文档)。`replace`(安装路径)的 `agentIds` 还活着,
 * 别一起删:那一档最终会走到 `project_skill_install`,那条 IPC 仍然需要它。
 */
export type ProjectDecision =
  | { kind: "replace"; projectPath: string; dirSlug: string; agentIds: string[]; registryId?: string; repo?: string }
  | { kind: "localEdits"; projectPath: string; key: string; dirSlug: string; registryId?: string; repo?: string };

interface ProjectState {
  groups: ProjectGroupView[];
  loading: boolean;
  error: AppError | null;

  installing: InstallingState | null;
  /** 安装/更新成功后的一句提示,展示完即清。 */
  notice: string | null;
  decision: ProjectDecision | null;
  busyKey: string | null;
  /** 选完文件夹、等用户点「装到这里」。null = 没有待确认的。 */
  confirm: ProjectConfirm | null;

  /** agent 内部名 → 展示名。界面绝不露内部标识,渲染前一律经这份 map。 */
  agentNames: Map<string, string>;
  /**
   * agent 内部名 → 相对项目根的技能目录(`DetectedAgent.skillsDir`)。给"已关联但
   * 不在候选里"那一档拼落点路径用——那一档手里只有 agent 名。与 `agentNames`
   * 同一次探测得来、同一处写入;探测失败时两份都保留上一次的值(它们来自注册表,
   * 不随探测结果变),只有 `pickableAgents` 归 null。
   */
  agentSkillsDirs: Map<string, string>;
  /**
   * 这台机器上装了、且不是 universal 的 agent 名单——事后改选 picker 的候选列表。
   * universal agent(如 cursor/codex)不摆:项目级 `current_agents`/`link_dirs`
   * 都跳过它们(它们的 `skillsDir` 落在 `.agents/skills`,与本体同一处,
   * 点了也没有效果),摆出来就是一个死勾。
   *
   * 🔴 `null` = 探测失败。这里**没有**"通用"页 `ToolChecks`(R21)那种
   * "不收窄"可用——那条规则的前提是有一份不受探测影响的全量列表可退(`tools`
   * 就是),而项目 picker 的候选**唯一**来源就是 `agents_detected`,失败了
   * 没有全量可退,candidates 只能是空。**空不等于"这台机器没有可选的工具"**,
   * 是两件不同的事:界面必须按 `pickableAgents === null` 单独走一句失败态文案
   * (`mine.projectToolsUnknown`),不能把它并进"候选为空"那一档说成"没有能
   * 改选的工具"——那是一句假话。已经关联的工具(`skill.agents`)不受这条影响,
   * 仍然照常显示、可以取消勾选,只是没法新增。
   */
  pickableAgents: DetectedAgent[] | null;

  setAgentsBusy: string | null;
  setAgentsError: AppError | null;
  /**
   * 上一次事后改选里,内容不同的位置一个字节没动、原样留下的 agent 名单
   * (铁律 7)。**必须有渲染点**——这一档不是"没做成",是"停下来问你"。
   */
  toolFailures: string[] | null;
  /** `toolFailures`/`setAgentsError` 归属的那个技能键,渲染时用来对应到具体是哪一行。 */
  toolFailuresFor: string | null;

  load: () => Promise<void>;

  pick: () => Promise<string | null>;
  install: (args: {
    projectPath: string;
    dirSlug: string;
    agentIds: string[];
    registryId?: string;
    repo?: string;
    confirmedReplace?: boolean;
    force?: boolean;
  }) => Promise<void>;
  /**
   * 更新一个已装进项目的技能。
   *
   * 🔴 **没有 `agentIds` 参数**——`project_skill_update` 早在 v7 任务 3 就改成从
   * 磁盘反推当初关联的那批工具(`project::current_agents`),不再吃前端传的
   * 探测/禁用状态现场重建的默认值。这里跟着删,免得调用方以为传了就会生效。
   */
  update: (args: {
    projectPath: string;
    key: string;
    dirSlug: string;
    registryId?: string;
    repo?: string;
    discardLocalEdits?: boolean;
  }) => Promise<void>;
  /**
   * 事后改选「这个技能在这个项目里对哪些工具生效」(v7 任务 8,补上 v5 留下的
   * 缺口——装完之后此前没有任何入口能改)。`agentIds` 是**完整目标集**,
   * 不是增量:调用方必须自己算好"当前全量集 ∪/∖ 这一次翻转"再传进来
   * ——picker 组件自己负责这件事,这个方法只是薄壳。
   */
  setAgents: (projectPath: string, key: string, agentIds: string[]) => Promise<void>;
  dismissToolFailures: () => void;
  /**
   * 进入待确认态。不给 `projectPath` 就弹选择框让用户选一个。
   *
   * 给 `projectPath` 的用法是「最近的项目」里**已经装过**的那一项:那时项目已经
   * 指定了,不该再弹一次选择框,但也不能直接装——直接装只会拿回一句"已经有了",
   * 用户依旧没有覆盖的机会(2026-08-22 用户反馈的正是这个死路)。
   */
  requestInstall: (args: {
    dirSlug: string;
    registryId?: string;
    repo?: string;
    projectPath?: string;
  }) => Promise<void>;
  /**
   * 用户点了「装到这里」,或已装过时点了「覆盖重装」(`force`)。
   *
   * 🔴 `force` **不蕴含**"丢弃我的改动":本体被改过时 core 仍会返回 needsDecision,
   * 走既有的决策对话框。合并成一个开关就是静默抹掉用户改过的内容。
   */
  confirmInstall: (force?: boolean) => Promise<void>;
  /**
   * 确认条上勾/取消**一组**工具(design §15 前半:「装到项目」的确认条上可选工具
   * ——IPC 早就收 `agentIds`,只是前端没摆控件,用户只能沿用 `requestInstall`
   * 算好的默认集合)。
   *
   * `agentLabels`(展示名)与 `agentIds` 一起更新,不留一份对不上的展示文案
   * ——`agentNames` 是登录时 `load()` 探测出来的 agent 内部名→展示名映射,
   * 内部标识不能露给用户,这里现算一次而不是让上一次的 `agentLabels` 漂移。
   *
   * 🔴 **收的是一组,不是一个**(2026-09-14 真机走查):Trae 与 Trae CN 在项目里共用
   * `.trae/skills`,一条链接同时对两者生效。按单个 agent 翻转的话,取消一个、另一个
   * 留着,装下去那个目录照样建链——勾说关了,盘上开着。所以组内任一在选中集合里
   * 就整组去掉,否则整组加上;分组规则见 `lib/project-tools.ts`。
   */
  toggleConfirmAgents: (agents: string[]) => void;
  cancelConfirm: () => void;
  remove: (projectPath: string, key: string, confirmed: boolean) => Promise<void>;
  forget: (path: string) => Promise<void>;

  dismissDecision: () => void;
  dismissNotice: () => void;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

/** 路径的末段,用作展示名(界面不摆完整路径当标题)。 */
function folderNameOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export const useProjects = create<ProjectState>((set, get) => ({
  groups: [],
  loading: false,
  error: null,
  installing: null,
  notice: null,
  decision: null,
  busyKey: null,
  confirm: null,
  agentNames: new Map(),
  agentSkillsDirs: new Map(),
  pickableAgents: null,
  setAgentsBusy: null,
  setAgentsError: null,
  toolFailures: null,
  toolFailuresFor: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      // IPC 返回值不可信:通道异常或旧版本 core 都可能给回 null/非数组,
      // 直接塞进 state 会让渲染层在 `.length` 上崩掉(2026-08-21 实测,
      // 测试里没 mock 这条 command 时当场复现)。挡在入口比在每个渲染点判空可靠。
      const groups = await projectList();
      set({ groups: Array.isArray(groups) ? groups : [], loading: false });
    } catch (e) {
      set({ error: toAppError(e), loading: false });
    }
    try {
      const detected = await agentsDetected();
      set({
        agentNames: new Map(detected.agents.map((a) => [a.name, a.displayName])),
        agentSkillsDirs: new Map(detected.agents.map((a) => [a.name, a.skillsDir])),
        pickableAgents: detected.agents.filter((a) => a.installed && !a.isUniversal),
      });
    } catch {
      // 探测失败不该让整页挂掉——但候选**确实**只能归零(没有全量列表可退,
      // 见 `pickableAgents` 的字段 doc)。留下 `null` 而不是 `[]`,是为了让
      // 界面分得清"候选为空"与"探测失败、候选未知"这两件事,走不同的文案。
      set({ pickableAgents: null });
    }
  },

  pick: async () => {
    try {
      return await projectPick();
    } catch (e) {
      set({ error: toAppError(e) });
      return null;
    }
  },

  requestInstall: async ({ dirSlug, registryId, repo, projectPath: known }) => {
    const projectPath = known ?? (await get().pick());
    if (!projectPath) return; // 用户取消,什么都不发生

    // 关联工具沿用全局默认(设置页没禁用的那些),与「最近的项目」那条路一致。
    const detected = await agentsDetected().catch(() => ({ agents: [] as DetectedAgent[] }));
    const chosen = detected.agents.filter((a) => a.installed && !a.disabled);

    // 已装判定在**点之前**做:不这么做的话,用户要等一整轮网络请求
    // (下压缩包、建索引)才被告知"已经有了"。判据是仓库目录名,不是安装键
    // ——两者在广场技能里经常不同。
    const already = get().groups.some(
      (g) => g.path === projectPath && projectHasSkill(g, dirSlug),
    );

    set({
      notice: null,
      confirm: {
        projectPath,
        dirSlug,
        agentIds: chosen.map((a) => a.name),
        agentLabels: chosen.map((a) => a.displayName),
        registryId,
        repo,
        alreadyInstalled: already,
      },
    });
  },

  confirmInstall: async (force) => {
    const confirm = get().confirm;
    if (!confirm) return;
    set({ confirm: null });
    await get().install({
      projectPath: confirm.projectPath,
      dirSlug: confirm.dirSlug,
      agentIds: confirm.agentIds,
      registryId: confirm.registryId,
      repo: confirm.repo,
      force,
    });
  },

  cancelConfirm: () => set({ confirm: null }),

  toggleConfirmAgents: (agents) => {
    const confirm = get().confirm;
    if (!confirm) return;
    const on = agents.some((a) => confirm.agentIds.includes(a));
    const agentIds = applyGroupToggle(confirm.agentIds, agents, !on);
    const agentNames = get().agentNames;
    const agentLabels = agentIds.map((a) => agentNames.get(a) ?? a);
    set({ confirm: { ...confirm, agentIds, agentLabels } });
  },

  install: async ({ projectPath, dirSlug, agentIds, registryId, repo, confirmedReplace, force }) => {
    set({ installing: { projectPath, dirSlug }, error: null, notice: null });
    try {
      const outcome = await projectSkillInstall({
        projectPath,
        dirSlug,
        agentIds,
        registryId,
        repo,
        confirmedReplace,
        force,
      });
      const project = folderNameOf(projectPath);
      if (outcome.status === "needsDecision") {
        // 拍板之前 core 侧磁盘零写入,这里也不刷新列表——什么都还没发生。
        set({
          installing: null,
          decision: { kind: "replace", projectPath, dirSlug, agentIds, registryId, repo },
        });
        return;
      }
      set({
        installing: null,
        notice:
          outcome.status === "alreadyInstalled"
            ? t("install.projectAlreadyInstalled", { project })
            : t("install.installedToProject", { project }),
      });
      await get().load();
    } catch (e) {
      set({ installing: null, error: toAppError(e) });
    }
  },

  update: async ({ projectPath, key, dirSlug, registryId, repo, discardLocalEdits }) => {
    set({ busyKey: key, error: null, notice: null });
    try {
      const outcome = await projectSkillUpdate({
        projectPath,
        key,
        dirSlug,
        registryId,
        repo,
        discardLocalEdits,
      });
      if (outcome.status === "hasLocalEdits") {
        set({
          busyKey: null,
          decision: { kind: "localEdits", projectPath, key, dirSlug, registryId, repo },
        });
        return;
      }
      set({
        busyKey: null,
        notice:
          outcome.status === "alreadyLatest"
            ? t("mine.projectAlreadyLatest")
            : t("mine.projectUpdated"),
      });
      await get().load();
    } catch (e) {
      set({ busyKey: null, error: toAppError(e) });
    }
  },

  remove: async (projectPath, key, confirmed) => {
    set({ busyKey: key, error: null, notice: null });
    try {
      const done = await projectSkillRemove(projectPath, key, confirmed);
      // 没清理干净的位置要如实告诉用户(core 侧刻意不删内容不一样的实体目录)。
      set({
        busyKey: null,
        notice: done.kept.length
          ? t("mine.projectRemoveKept", { count: String(done.kept.length) })
          : null,
      });
      await get().load();
    } catch (e) {
      set({ busyKey: null, error: toAppError(e) });
    }
  },

  forget: async (path) => {
    try {
      await projectForget(path);
      await get().load();
    } catch (e) {
      set({ error: toAppError(e) });
    }
  },

  setAgents: async (projectPath, key, agentIds) => {
    // 归属在动作一开始就落定(与 `useMySkills.setAgents` 同一姿态):不管这一轮
    // 成功还是失败,只要 toolFailures/setAgentsError 之后被写入非空值,
    // 它们说的都是这个 key。
    set({ setAgentsBusy: key, setAgentsError: null, toolFailures: null, toolFailuresFor: key });
    try {
      const done = await projectSkillSetAgents({ projectPath, key, agentIds });
      set({ toolFailures: done.kept.length > 0 ? done.kept : null });
      await get().load();
    } catch (e) {
      set({ setAgentsError: toAppError(e) });
    } finally {
      set({ setAgentsBusy: null });
    }
  },

  dismissToolFailures: () => set({ toolFailures: null, setAgentsError: null, toolFailuresFor: null }),

  dismissDecision: () => set({ decision: null }),
  dismissNotice: () => set({ notice: null }),
}));
