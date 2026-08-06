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
  /** 远端这一版的内容哈希。与已装记账的 contentHash 比,才是"有无可用更新"。 */
  contentHash: string;
  /** 标签(技能库根 tags.json,服务端管理、客户端只读)。 */
  tags: string[];
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
  /** 精选清单(dirSlug,已由 core 按 name 匹配好)。空 = 库里没有精选。 */
  curated: string[];
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
  /** 标签(tags.json)。详情面板元信息区展示。 */
  tags: string[];
}

/** 本地技能定位:已装技能给 dirSlug(core 自行解析 canonical 目录),
 *  分享页候选给 path(core 扫描回传的绝对路径原样带回)。 */
export interface LocalSkillTarget {
  dirSlug?: string;
  path?: string;
}

/** skill_local_detail 的返回(core::local_detail::LocalSkillDetail)。 */
export interface LocalSkillDetail {
  name: string;
  dirSlug: string;
  description: string;
  /** 目录绝对路径,详情面板展示 + 「在访达中打开」的目标。 */
  path: string;
  skillMd: string;
  files: SkillFile[];
  hasScripts: boolean;
}

export type ThemeMode = "light" | "dark" | "system";
export type Accent = "clay" | "teal" | "ink";

/** 与 core::state::UiPrefs 的 serde 契约一一对应。`null` = config 里从未设置过。 */
export interface UiPrefs {
  theme: ThemeMode;
  accent: Accent;
  wizardDone: boolean;
}

export const uiPrefsGet = () => call<UiPrefs | null>("ui_prefs_get");
export const uiPrefsSet = (prefs: UiPrefs) => call<void>("ui_prefs_set", { args: { prefs } });

/** 与 core::state::AutoUpdate 的 serde 契约一一对应。 */
export interface AutoUpdate {
  skills: { enabled: boolean; intervalHours: number };
  app: boolean;
}

export const autoUpdateGet = () => call<AutoUpdate>("auto_update_get");
export const autoUpdateSet = (autoUpdate: AutoUpdate) =>
  call<void>("auto_update_set", { args: { autoUpdate } });

/** 整份覆盖禁用名单(开关是幂等的整体状态,不是增量操作)。 */
export const agentsSetDisabled = (disabled: string[]) =>
  call<void>("agents_set_disabled", { args: { disabled } });

/** 在系统浏览器打开技能库页面(评审链接)。非同源地址会被 core 拒绝。 */
export const openLibraryUrl = (url: string) => call<void>("open_library_url", { args: { url } });

/** 与 core::scheduler::CheckReport 的 serde 契约一一对应。 */
export type CheckReport =
  | { status: "nothingInstalled" }
  | { status: "upToDate"; headSha: string }
  | {
      status: "checked";
      headSha: string;
      updated: string[];
      skipped: { dirSlug: string; reason: string }[];
      failed: { dirSlug: string; error: AppError }[];
    };

/** 触发一轮更新检查(即发即忘,结果经 `scheduler://report` 事件回来)。 */
export const updateCheckNow = () => call<void>("update_check_now");

/** 与 core 的 AppUpdateStatus serde 契约一一对应。ready = 已在后台装好,重启即生效。 */
export type AppUpdateStatus =
  | { status: "upToDate" }
  | { status: "available"; version: string }
  | { status: "ready"; version: string };

export const appUpdateCheck = () => call<AppUpdateStatus>("app_update_check");
export const appUpdateInstall = () => call<void>("app_update_install");
export const appRestart = () => call<void>("app_restart");

/** App 新版已在后台静默装好、等重启生效(payload = 版本号)。 */
export function listenAppUpdateReady(onVersion: (v: string) => void): Promise<UnlistenFn> {
  return listen<string>("app-update://ready", (e) => onVersion(e.payload));
}

/** 订阅定时检查结果。 */
export function listenSchedulerReport(
  onReport: (report: CheckReport) => void,
): Promise<UnlistenFn> {
  return listen<CheckReport>("scheduler://report", (e) => onReport(e.payload));
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

// ============================================================ 技能库来源(M3)

/** 一个技能库(仓)在源下的展示数据,与 core::registry::RepoView 一一对应。 */
export interface RepoView {
  /** 仓库寻址键 `owner/repo`,IPC 的 `repo` 参数原样带回。 */
  key: string;
  owner: string;
  repo: string;
  branch: string;
  /** 用户起的展示名;null 时界面回退 repo slug。 */
  name: string | null;
  /** 主仓(缺省落点)。 */
  primary: boolean;
  /** 锁定不可移除(仅内建源主仓)。 */
  locked: boolean;
}

/** 与 core::registry::RegistryView 的 serde 契约一一对应。 */
export interface RegistryView {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  builtin: boolean;
  /** 内建源在未注入配置的构建上为 null,界面据此显示"构建未配置"。 */
  repo: { owner: string; repo: string; branch: string } | null;
  /** 该源下的全部技能库,主仓在首位(M4 任务 1)。 */
  repos: RepoView[];
}

export const registryList = () => call<RegistryView[]>("registry_list");

/** 新增自定义源。返回更新后的完整列表,前端整份替换。 */
export const registryAdd = (args: {
  name: string;
  kind: string;
  baseUrl: string;
  owner: string;
  repo: string;
  branch?: string;
}) => call<RegistryView[]>("registry_add", { args });

export const registryRemove = (registryId: string) =>
  call<RegistryView[]>("registry_remove", { args: { registryId } });

/** 给某个源追加技能库(内建源 = 同一公司 Gitea 上的其他库)。 */
export const registryAddRepo = (args: {
  registryId: string;
  owner: string;
  repo: string;
  branch?: string;
  name?: string;
}) => call<RegistryView[]>("registry_add_repo", { args });

/** 从源里移除一个技能库(repo = 寻址键 `owner/repo`)。已装技能保留。 */
export const registryRemoveRepo = (args: { registryId: string; repo: string }) =>
  call<RegistryView[]>("registry_remove_repo", { args });

export const storeIndex = (force = false, registryId?: string, repo?: string) =>
  call<StoreIndexView>("store_index", { args: { force, registryId, repo } });

export const storeSkillDetail = (dirSlug: string, registryId?: string, repo?: string) =>
  call<SkillDetail>("store_skill_detail", { args: { dirSlug, registryId, repo } });

export const skillLocalDetail = (target: LocalSkillTarget) =>
  call<LocalSkillDetail>("skill_local_detail", { args: target });

export const skillReveal = (target: LocalSkillTarget) =>
  call<void>("skill_reveal", { args: target });

export const authStatus = () => call<SessionStatus>("auth_status", { args: {} });
export const authLoginOauth = () => call<SessionUser>("auth_login_oauth", { args: {} });
export const authLogout = () => call<void>("auth_logout", { args: {} });

/** 个人访问凭证登录。内建源是备用通道;自定义源按 registryId 分开存。 */
export const authLoginToken = (args: { registryId?: string; token: string }) =>
  call<SessionUser>("auth_login_token", { args });

/** GitHub 一键登录(device flow)第一步:拿用户码,core 已顺手打开授权页。 */
export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export const authDeviceStart = (registryId: string) =>
  call<DeviceStart>("auth_device_start", { args: { registryId } });

/** 第二步:等用户在浏览器完成授权(长任务,core 内轮询到成功/明确失败为止)。 */
export const authDeviceWait = (args: {
  registryId: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}) => call<SessionUser>("auth_device_wait", { args });

// ============================================================ 获取流程

export interface DetectedAgent {
  name: string;
  displayName: string;
  installed: boolean;
  globalSkillsDir?: string;
  isUniversal: boolean;
  needsLink: boolean;
  /** 设置页里被关掉:不进默认勾选,手动勾选不拦。 */
  disabled: boolean;
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
  | { status: "foreign"; origin: ForeignOrigin }
  /** 同名技能已装自另一个技能库(M4 一源多仓):不是更新,是替换。 */
  | { status: "otherLibrary"; installedSha: string; sourceOwner: string; sourceRepo: string };

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
  /** 安装(或认领)那一刻的内容哈希 —— 这个技能这一版的指纹。
   *  判"有更新"要用它和商店卡片的 contentHash 比,**不能用 commitSha**:
   *  那是整库 HEAD,库里任何一次提交都会让所有已装技能被判成有更新。 */
  contentHash: string;
  agents: string[];
  installedAt: string;
  updatedAt: string;
  localModified: boolean;
  sourceOwner: string;
  sourceRepo: string;
  /** 来源 registry(更新/回推时原样带回,不展示给用户)。 */
  registryId: string;
  /** 来源已解析不出来(自定义源被移除等):可用可移除,但更新与回推没了去处。 */
  sourceRemoved: boolean;
  /** 源还在,但这个技能库不在源的库列表里(M4)。去向与 sourceRemoved 相同,
   *  但**说法不同**——源好好的,说成「来源已移除」是假话。 */
  libraryRemoved: boolean;
  /** 其他工具装的、尚未纳入管理(M6 任务 4 起用这个说法,原称"认领")。 */
  unclaimed: boolean;
  /**
   * 仅对 `unclaimed` 有意义:纳入管理后绑不绑得上某个技能库。
   *
   * false 时**不摆「纳入管理」**——绑不上的话纳入只多出"修复关联"与"移除",
   * 让用户点一个没有意义的按钮。改摆「分享到技能库」,那才是真正的出路。
   */
  claimBindable: boolean;
  /**
   * 本地技能:自己新建的、或手放进 canonical 的。没有来源、没有关联记账。
   *
   * 能做的事诚实地少:看详情 / 在访达中打开 / 去分享。
   * **更新、修复关联、分享改动、移除都要抑制**——它没有来源,也没建过关联。
   */
  localOnly: boolean;
  /** 这条记账是纳入管理来的,因而可以「移出管理」(只删记账,磁盘一个字节不动)。 */
  claimed: boolean;
  /** 技能本体是否还在。false = 残缺,界面要正面说出来。 */
  links: LinkHealthReport[];
}

/**
 * 移出管理:纳入管理的**精确逆操作**,只删记账,磁盘/链接/lock 一个字节都不动。
 *
 * 与「移除」的区别就是这条命令存在的理由——移除会解链、删本体、清 lock 条目。
 */
export const skillUnclaim = (args: { dirSlug: string }) =>
  call<void>("skill_unclaim", { args });

export interface ClaimReport {
  dirSlug: string;
  adoptedLinks: number;
  bound: boolean;
}

/** 认领上游(npx skills)装的技能:纳入本 app 管理,lock 一个字节不动。 */
export const skillClaim = (args: { dirSlug: string }) =>
  call<ClaimReport>("skill_claim", { args });

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
/**
 * 订阅本地技能目录的变更(M4 任务 6c 级别 3)。
 *
 * 载荷为空——它只是"去重新扫描一下"的信号。core 侧已经滤掉了本应用自己写盘
 * 引发的事件(见 core/watcher.rs),所以收到它就意味着**外面**真的改了东西。
 */
export function listenLocalSkillsChanged(onChanged: () => void): Promise<UnlistenFn> {
  return listen("local-skills://changed", () => onChanged());
}

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
  registryId?: string;
  /** 仓库寻址键 `owner/repo`。商店语境带当前浏览的仓;更新带账上来源坐标。 */
  repo?: string;
}) => call<AcquireOutcome>("skill_install", { args });

export const skillRemove = (args: { dirSlug: string; force?: boolean }) =>
  call<RemoveOutcome>("skill_remove", { args });

export type BatchItem = { dirSlug: string } & (
  | { outcome: "installed"; report: InstallReport }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: AppError }
);

export const skillInstallBatch = (args: {
  dirSlugs: string[];
  agentIds: string[];
  registryId?: string;
  /** 仓库寻址键,缺省 = 主仓(向导的 curated 清单只在主仓)。 */
  repo?: string;
}) => call<BatchItem[]>("skill_install_batch", { args });

export const skillRepair = (args: { dirSlug: string; replaceOccupied?: boolean }) =>
  call<InstallReport>("skill_repair", { args });

/** 安装结果面板里逐条重试:把技能补关联到当时没建成的那个工具上。 */
export const skillLinkAgents = (args: {
  dirSlug: string;
  agentIds: string[];
  replaceOccupied?: boolean;
}) => call<InstallReport>("skill_link_agents", { args });

export type CandidateOrigin = { kind: "local" } | { kind: "npxSkills"; source: string };

export interface ShareCandidate {
  dirName: string;
  path: string;
  inCanonical: boolean;
  origin: CandidateOrigin;
  name: string | null;
  description: string | null;
  /** SKILL.md 不合规的原因(人话);有值 = 分享前要走补齐表单。 */
  problem: string | null;
  shared: { upToDate: boolean; shareName: string } | null;
  dirNameUsable: boolean;
}

export type SharePrecheck = { status: "fresh" } | { status: "mine" } | { status: "taken" };

export type ShareMode = "pushed" | "reviewRequested";

export type ShareOutcome =
  | { outcome: "needsDecision"; precheck: SharePrecheck }
  | {
      outcome: "shared";
      mode: ShareMode;
      commitSha: string;
      reviewUrl: string | null;
      adopted: boolean;
      shareName: string;
    };

export interface Submitted {
  mode: ShareMode;
  commitSha: string;
  reviewUrl: string | null;
}

/**
 * 回推的两种结局(M5 任务 1)。`remoteChanged` 不是错误:远端在获取之后被别人
 * 改过,core 一个字节都没动就退回来,由前端弹确认(提交审核 / 先不动),
 * 确认后带 `forceReview: true` 再来一次。
 */
export type ShareInstalledOutcome =
  | ({ kind: "submitted" } & Submitted)
  | { kind: "remoteChanged"; historyUrl: string | null };

export interface CreateReport {
  dirSlug: string;
  /** 绝对路径,用于完成提示与「在访达中显示」。 */
  path: string;
}

/**
 * 新建一个空技能(等价上游 `skills init`)。
 *
 * 只在 canonical 目录建文件,**不建关联、不进账**——理由见 core/create.rs 模块头。
 * 建完它会作为「本地创建」出现在分享候选里。
 */
export const skillCreate = (args: {
  dirSlug: string;
  displayName: string;
  description: string;
}) => call<CreateReport>("skill_create", { args });

export const shareCandidates = () => call<ShareCandidate[]>("share_candidates");

/**
 * 分享会走哪条路的预告(M4 任务 2)。与 core 的 `share::SharePath` 一一对应。
 *
 * - `directPush` 改动立即生效;`reviewInRepo` 在技能库里开一份待审;
 * - `reviewViaCopy` 先复制一份到自己名下再提交审核;
 * - `maybeDirect` 有写权限但探不到审核规则(GitHub 的保护规则要管理员权限才读得到);
 * - `unknown` 探不到,界面不显示预告。
 *
 * **它只是提示**:提交时刻的权限判定才是权威,预检失败绝不拦分享。
 */
export type SharePath =
  | "directPush"
  | "reviewInRepo"
  | "reviewViaCopy"
  | "maybeDirect"
  | "unknown";

export const sharePreview = (args: { registryId?: string; repo?: string } = {}) =>
  call<SharePath>("share_preview", { args });

export const skillShare = (args: {
  sourcePath: string;
  shareName: string;
  displayName?: string;
  description?: string;
  origin: string;
  overwrite?: boolean;
  registryId?: string;
  /** 分享目标仓的寻址键,缺省 = 主仓;目标选择器进表单归 M4 任务 2。 */
  repo?: string;
}) => call<ShareOutcome>("skill_share", { args });

export const skillShareChanges = (args: {
  dirSlug: string;
  registryId?: string;
  /** 冲突确认后的第二跳:跳过远端变更检测,强制走提交审核。 */
  forceReview?: boolean;
}) => call<ShareInstalledOutcome>("skill_share_changes", { args });
