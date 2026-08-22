// 项目级安装的前端状态(v5)。
//
// 与全局安装(store/install.ts)刻意分开:全局那套围绕 canonical 与 state.installed,
// 项目级的真相在各项目根的 skills-lock.json 里(与 npx skills 共用),
// 两者的记账、判定、可做的操作都不一样,合成一个 store 只会让两边互相牵制。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  agentsDetected,
  isAppError,
  projectForget,
  projectList,
  projectPick,
  projectSkillInstall,
  projectSkillRemove,
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

/** 需要用户拍板的两种情形。 */
export type ProjectDecision =
  | { kind: "replace"; projectPath: string; dirSlug: string; agentIds: string[]; registryId?: string; repo?: string }
  | { kind: "localEdits"; projectPath: string; key: string; dirSlug: string; agentIds: string[]; registryId?: string; repo?: string };

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
  update: (args: {
    projectPath: string;
    key: string;
    dirSlug: string;
    agentIds: string[];
    registryId?: string;
    repo?: string;
    discardLocalEdits?: boolean;
  }) => Promise<void>;
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
      (g) => g.path === projectPath && (g.skills ?? []).some((s) => s.dirSlug === dirSlug),
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

  update: async ({ projectPath, key, dirSlug, agentIds, registryId, repo, discardLocalEdits }) => {
    set({ busyKey: key, error: null, notice: null });
    try {
      const outcome = await projectSkillUpdate({
        projectPath,
        key,
        dirSlug,
        agentIds,
        registryId,
        repo,
        discardLocalEdits,
      });
      if (outcome.status === "hasLocalEdits") {
        set({
          busyKey: null,
          decision: { kind: "localEdits", projectPath, key, dirSlug, agentIds, registryId, repo },
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

  dismissDecision: () => set({ decision: null }),
  dismissNotice: () => set({ notice: null }),
}));
