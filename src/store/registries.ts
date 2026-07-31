// 技能库来源管理(M3 任务 2):设置页「技能库来源」区与商店源切换器的数据源。
//
// add/remove 不做乐观更新:后端把"更新后的完整列表"作为返回值,成功即整份替换,
// 失败保持原列表并亮出错误——来源列表是低频操作,没必要为它冒"界面与磁盘不一致"的险。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  authLoginToken,
  isAppError,
  registryAdd,
  registryList,
  registryRemove,
  type AppError,
  type RegistryView,
} from "@/lib/ipc";

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

export interface RegistryAddForm {
  name: string;
  /** `gitea` | `github`(任务 4 起两种都可加)。 */
  kind: "gitea" | "github";
  baseUrl: string;
  /** `所属者/名称` 一段式输入,提交前在本地拆开。 */
  repoPath: string;
}

interface RegistriesState {
  /** null = 尚未加载成功。 */
  list: RegistryView[] | null;
  error: AppError | null;
  busy: boolean;
  /** 登录成功的自定义源:registryId → 用户显示名(仅展示,权威在钥匙串)。 */
  loggedIn: Record<string, string>;

  load: () => Promise<void>;
  /** 新增自定义源。成功返回 true(界面收起表单)。 */
  add: (form: RegistryAddForm) => Promise<boolean>;
  remove: (registryId: string) => Promise<void>;
  /** 自定义源的 PAT 登录。成功返回 true。 */
  tokenLogin: (registryId: string, token: string) => Promise<boolean>;
}

export const useRegistries = create<RegistriesState>((set, get) => ({
  list: null,
  error: null,
  busy: false,
  loggedIn: {},

  load: async () => {
    try {
      set({ list: await registryList(), error: null });
    } catch (raw) {
      set({ error: toAppError(raw) });
    }
  },

  add: async (form) => {
    // "所属者/名称"在本地拆开:发一个后端注定拒绝的请求没有意义,
    // 而且本地能给出比通用校验错误更贴表单的提示
    const parts = form.repoPath.split("/").map((p) => p.trim());
    if (parts.length !== 2 || parts.some((p) => !p)) {
      set({
        error: { code: "UI_INVALID_REPO_PATH", message: t("registries.invalidRepoPath") },
      });
      return false;
    }
    const [owner, repo] = parts;
    set({ busy: true, error: null });
    try {
      const list = await registryAdd({
        name: form.name,
        kind: form.kind,
        baseUrl: form.baseUrl,
        owner,
        repo,
      });
      set({ list, busy: false });
      return true;
    } catch (raw) {
      set({ error: toAppError(raw), busy: false });
      return false;
    }
  },

  remove: async (registryId) => {
    set({ busy: true, error: null });
    try {
      const list = await registryRemove(registryId);
      const loggedIn = { ...get().loggedIn };
      delete loggedIn[registryId];
      set({ list, busy: false, loggedIn });
    } catch (raw) {
      set({ error: toAppError(raw), busy: false });
    }
  },

  tokenLogin: async (registryId, token) => {
    set({ busy: true, error: null });
    try {
      const user = await authLoginToken({ registryId, token });
      set({
        loggedIn: { ...get().loggedIn, [registryId]: user.displayName },
        busy: false,
      });
      return true;
    } catch (raw) {
      set({ error: toAppError(raw), busy: false });
      return false;
    }
  },
}));
