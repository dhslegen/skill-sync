// 与 Rust core 的唯一通道。架构铁律 1:前端不直接发任何 HTTP 请求,
// 一切数据都经由这里的 command 调用。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { t } from "@/i18n";

/** 契约 3.3 的统一错误模型。message 是可直接展示的中文,detail 只进诊断。 */
export interface AppError {
  code: string;
  message: string;
  detail?: string;
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppError).code === "string" &&
    typeof (value as AppError).message === "string"
  );
}

/**
 * 调用 command。core 抛出的一律是 [`AppError`];其他异常(比如不在 Tauri 里跑)
 * 包一层同样形状,保证界面永远拿到"有中文 message 的错误",不会露出裸的 JS 报错。
 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (raw) {
    if (isAppError(raw)) throw raw;
    throw {
      code: "IPC_FAILED",
      message: t("error.ipcFailed"),
      detail: String(raw),
    } satisfies AppError;
  }
}

// ============================================================ core 侧的返回类型
// 与 src-tauri/src/core/store.rs 的 serde 契约一一对应(camelCase)。

export interface StoreSkillCard {
  name: string;
  dirSlug: string;
  description: string;
  path: string;
  hasScripts: boolean;
  fileCount: number;
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

export interface StoreIndexView {
  registryId: string;
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  committedAt: string;
  fetchedAt: number;
  skills: StoreSkillCard[];
  skipped: SkippedEntry[];
  fromCache: boolean;
  offline: boolean;
}

export interface SkillFile {
  path: string;
  size?: number;
}

export interface SkillDetail {
  name: string;
  dirSlug: string;
  description: string;
  path: string;
  skillMd: string;
  files: SkillFile[];
  hasScripts: boolean;
  commitSha: string;
  committedAt: string;
}

export interface SessionUser {
  login: string;
  displayName: string;
  avatarUrl: string;
}

export interface SessionStatus {
  loggedIn: boolean;
  user?: SessionUser;
}

export const storeIndex = (force = false) =>
  call<StoreIndexView>("store_index", { args: { force } });

export const storeSkillDetail = (dirSlug: string) =>
  call<SkillDetail>("store_skill_detail", { args: { dirSlug } });

export const authStatus = () => call<SessionStatus>("auth_status", { args: {} });
export const authLoginOauth = () => call<SessionUser>("auth_login_oauth", { args: {} });
export const authLogout = () => call<void>("auth_logout", { args: {} });

// ============================================================ 获取流程

export interface DetectedAgent {
  name: string;
  displayName: string;
  installed: boolean;
  globalSkillsDir?: string;
  isUniversal: boolean;
  needsLink: boolean;
}

export interface DetectedAgents {
  agents: DetectedAgent[];
  canonicalDir?: string;
}

/** 与 core::acquire::Stage 的 serde 契约一一对应。 */
export type InstallStage =
  | "fetching"
  | "checking"
  | "writing"
  | "linking"
  | "recording"
  | "done";

export type Precheck =
  | { status: "fresh" }
  | { status: "managed"; installedSha: string; upToDate: boolean }
  | { status: "locallyModified"; installedSha: string }
  | { status: "foreign"; origin: ForeignOrigin };

export type ForeignOrigin = { kind: "npxSkills"; source: string } | { kind: "unknown" };

/** 冲突处置。只有两档:分享流程属后续任务,现在没有可推的通道,
 *  所以"把本地改动分享上去"当下的落地就是"保留本地改动"。 */
export type Resolution = "keepLocal" | "overwrite";

export type LinkResult =
  | { status: "linked"; mode: string }
  | { status: "unchanged"; mode: string }
  | { status: "sameLocation" }
  | { status: "failed"; error: AppError };

export interface LinkReport {
  dir: string;
  agents: string[];
  result: LinkResult;
}

export interface InstallReport {
  dirName: string;
  canonicalDir: string;
  links: LinkReport[];
}

export type AcquireOutcome =
  | { outcome: "needsDecision"; precheck: Precheck }
  | { outcome: "installed"; report: InstallReport; localKept: boolean; lock: string };

export type LinkHealth = "healthy" | "broken" | "redirected" | "occupied" | "missing";

export interface LinkHealthReport {
  dir: string;
  mode: string;
  health: LinkHealth;
}

export interface InstalledSkillView {
  dirSlug: string;
  commitSha: string;
  agents: string[];
  installedAt: string;
  updatedAt: string;
  localModified: boolean;
  sourceOwner: string;
  sourceRepo: string;
  /** 技能本体是否还在。false = 残缺,界面要正面说出来。 */
  bodyPresent: boolean;
  links: LinkHealthReport[];
}

export type UnlinkResult =
  | { status: "unlinked" }
  | { status: "missing" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: AppError };

export interface UninstallReport {
  dirName: string;
  unlinks: { dir: string; result: UnlinkResult }[];
  canonicalRemoved: boolean;
}

export type RemoveOutcome =
  | { outcome: "needsDecision" }
  | { outcome: "removed"; report: UninstallReport; lock: string };

/** 订阅一次安装的进度。契约 3.3:长任务走 `progress://{taskId}` 事件。 */
export function listenProgress(
  taskId: string,
  onStage: (stage: InstallStage) => void,
): Promise<UnlistenFn> {
  return listen<InstallStage>(`progress://${taskId}`, (e) => onStage(e.payload));
}

export const agentsDetected = () => call<DetectedAgents>("agents_detected");
export const installedList = () => call<InstalledSkillView[]>("installed_list");

export const skillInstall = (args: {
  dirSlug: string;
  agentIds: string[];
  taskId: string;
  resolution?: Resolution;
}) => call<AcquireOutcome>("skill_install", { args });

export const skillRemove = (args: { dirSlug: string; force?: boolean }) =>
  call<RemoveOutcome>("skill_remove", { args });

export const skillRepair = (args: { dirSlug: string; replaceOccupied?: boolean }) =>
  call<InstallReport>("skill_repair", { args });
