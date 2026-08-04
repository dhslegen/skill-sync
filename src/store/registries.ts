// 技能库来源管理(M3 任务 2):设置页「技能库来源」区与商店源切换器的数据源。
//
// add/remove 不做乐观更新:后端把"更新后的完整列表"作为返回值,成功即整份替换,
// 失败保持原列表并亮出错误——来源列表是低频操作,没必要为它冒"界面与磁盘不一致"的险。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  authDeviceStart,
  authDeviceWait,
  authLoginToken,
  isAppError,
  registryAdd,
  registryAddRepo,
  registryList,
  registryRemove,
  registryRemoveRepo,
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

  /** 正在进行的 GitHub 一键登录:展示用户码,等浏览器侧完成。null = 没有进行中的。 */
  devicePrompt: { registryId: string; userCode: string } | null;

  load: () => Promise<void>;
  /** 新增自定义源。成功返回 true(界面收起表单)。 */
  add: (form: RegistryAddForm) => Promise<boolean>;
  remove: (registryId: string) => Promise<void>;
  /** 给源追加技能库(M4 一源多仓)。成功返回 true(界面收起表单)。 */
  addRepo: (registryId: string, form: { repoPath: string; name: string }) => Promise<boolean>;
  /** 移除源里的一个技能库(repo = 寻址键 `owner/repo`)。 */
  removeRepo: (registryId: string, repo: string) => Promise<void>;
  /** 自定义源的 PAT 登录。成功返回 true。 */
  tokenLogin: (registryId: string, token: string) => Promise<boolean>;
  /** GitHub 一键登录(device flow):start 展示用户码 → 后台等授权 → 记录用户。 */
  deviceLogin: (registryId: string) => Promise<void>;
  /** 收起用户码提示。core 的轮询会自然过期,授权若已完成凭证照常入钥匙串。 */
  dismissDevicePrompt: () => void;
}

export const useRegistries = create<RegistriesState>((set, get) => ({
  list: null,
  error: null,
  busy: false,
  loggedIn: {},
  devicePrompt: null,

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

  addRepo: async (registryId, form) => {
    // 与 add 同款的本地拆分:表单是「所属者/名称」一段式
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
      const name = form.name.trim();
      const list = await registryAddRepo({
        registryId,
        owner,
        repo,
        ...(name ? { name } : {}),
      });
      set({ list, busy: false });
      return true;
    } catch (raw) {
      set({ error: toAppError(raw), busy: false });
      return false;
    }
  },

  removeRepo: async (registryId, repo) => {
    set({ busy: true, error: null });
    try {
      const list = await registryRemoveRepo({ registryId, repo });
      set({ list, busy: false });
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

  deviceLogin: async (registryId) => {
    set({ busy: true, error: null });
    try {
      const start = await authDeviceStart(registryId);
      // 授权页已由 core 打开;把用户码亮出来,后台开始等
      set({ devicePrompt: { registryId, userCode: start.userCode }, busy: false });
      const user = await authDeviceWait({
        registryId,
        deviceCode: start.deviceCode,
        expiresIn: start.expiresIn,
        interval: start.interval,
      });
      set({
        loggedIn: { ...get().loggedIn, [registryId]: user.displayName },
        devicePrompt: null,
      });
    } catch (raw) {
      // 用户可能已手动收起提示(取消):迟到的失败不再打扰
      const dismissed = get().devicePrompt === null && !get().busy;
      set({
        error: dismissed ? get().error : toAppError(raw),
        devicePrompt: null,
        busy: false,
      });
    }
  },

  dismissDevicePrompt: () => set({ devicePrompt: null }),
}));
