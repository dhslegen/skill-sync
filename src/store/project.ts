// 项目级安装的前端状态(v5)。
//
// 与全局安装(store/install.ts)刻意分开:全局那套围绕 canonical 与 state.installed,
// 项目级的真相在各项目根的 skills-lock.json 里(与 npx skills 共用),
// 两者的记账、判定、可做的操作都不一样,合成一个 store 只会让两边互相牵制。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  isAppError,
  projectForget,
  projectList,
  projectPick,
  projectSkillInstall,
  projectSkillRemove,
  projectSkillUpdate,
  type AppError,
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

  load: () => Promise<void>;

  pick: () => Promise<string | null>;
  install: (args: {
    projectPath: string;
    dirSlug: string;
    agentIds: string[];
    registryId?: string;
    repo?: string;
    confirmedReplace?: boolean;
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

  install: async ({ projectPath, dirSlug, agentIds, registryId, repo, confirmedReplace }) => {
    set({ installing: { projectPath, dirSlug }, error: null, notice: null });
    try {
      const outcome = await projectSkillInstall({
        projectPath,
        dirSlug,
        agentIds,
        registryId,
        repo,
        confirmedReplace,
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
