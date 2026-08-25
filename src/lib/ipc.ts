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
  /** 作者(技能库根 authors.json,服务端维护)。null = 库里没这条,整栏不摆。 */
  author: string | null;
}

/** 一个技能的作者与贡献者(技能库根 authors.json,服务端维护、客户端只读)。
 *  契约里只有名字没有邮箱——core 的结构上就不存在 email 字段。 */
export interface SkillAttribution {
  author: string;
  contributors: string[];
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
  /** 作者与贡献者(authors.json)。null = 库里没这条,整栏不摆、不编造。 */
  attribution: SkillAttribution | null;
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
  /** 检查间隔(**分钟**,schema v2 起)。档位:5 / 240 / 1440。 */
  skills: { enabled: boolean; intervalMinutes: number };
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
  | { status: "otherLibrary"; installedSha: string; sourceOwner: string; sourceRepo: string }
  /**
   * 技能库里记的分享者就是当前登录的这个人(v6 任务 3)。
   *
   * 取代了作者在自己技能上会看到的 `foreign`/`locallyModified`/`managed{upToDate:false}`
   * 三种说法——它们讲的是"这东西是怎么来的",而作者要的是"我这边和库里哪边新"。
   * `localChanged`:本地本体与账上基线不符;`remoteChanged`:库里这一版与账上基线不符。
   *
   * **完整的三选一变体是任务 5 的范围**——本任务只保证类型存在、且不会落进
   * `foreign` 分支显示那句「不是本应用安装的」假话(见 `ConflictDialog`)。
   */
  | { status: "mine"; localChanged: boolean; remoteChanged: boolean };

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
  /**
   * 「我分享的」+ 以本地为准(v6):`Precheck.Mine` 档选了 `keepLocal` 时,
   * core **什么都不做**——磁盘、记账、关联一个字节都没动,本体就是作者手上的
   * 最新版,覆盖它就是丢改动。下一步是「分享更新」,不是安装。
   *
   * `remoteChanged` 直接带上,免得调用方跨两次 IPC 记住上一轮 `needsDecision`
   * 里的那个值——它为真时后续分享必须带 `forceReview`(前提就是"库里已有新版",
   * 直推等于覆盖同事经审核改过的版本)。
   */
  | { outcome: "kept"; remoteChanged: boolean }
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
  /**
   * 技能与「我」的关系(v6,`ownership::relation` 是**唯一一处**判定实现):
   * `shared` = 技能库里记的分享者是我;`installed` = 其余(含未登录、库里没写
   * 作者、别人分享的);`draft` = 只在本地、库里没有这个技能。
   *
   * **取代了此前的 `unclaimed`/`claimBindable`/`claimed`/`localOnly` 四个字段**
   * ——「纳入管理 / 移出管理」连同 `skillClaim`/`skillUnclaim` 一并撤销。
   * 前端按这一个字段分两区(「我分享的」/「我安装的」),`draft` 归并进「我分享的」。
   */
  relation: "shared" | "installed" | "draft";
  /**
   * 这台电脑上有没有这个技能的本体文件。
   *
   * 对 `relation === "installed"` 与本地扫到的 `shared` 恒为 `true`;
   * **只对 `shared` 才可能是 `false`**——库里记的分享者是我、但这台电脑上没有文件
   * (换电脑 / 目录被删 / 绕过 app 直推)。界面据此显示「不在这台电脑」,
   * 主动作从「已同步/分享更新」换成「取回」。
   */
  localPresent: boolean;
  /**
   * 归一化后的来源展示:`owner/repo` 或域名。`null` = 不摆来源行(本地新建、
   * 从未分享过的草稿本就没有来源)。判据见 core `ownership::source_label`。
   */
  sourceLabel: string | null;
  /** 技能本体是否还在。false = 残缺,界面要正面说出来。 */
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

/**
 * ⚠️ **对应的后端命令 `skill_repair` 已于 v6 二期任务 4 删除。**
 * 「修复关联」作为独立按钮的概念被取消:自愈落在 {@link skillSetAgents} 里
 * ——用户再点一次同一个工具的勾就会重新收敛那个位置。留着这个包装只是为了让
 * 还没重写的 `store/my-skills.ts` 编译得过;**调用它一定会失败**。
 */
export const skillRepair = (args: { dirSlug: string; replaceOccupied?: boolean }) =>
  call<InstallReport>("skill_repair", { args });

/**
 * ⚠️ **对应的后端命令 `skill_link_agents` 已于 v6 二期任务 4 删除**,理由同上,
 * 改用 {@link skillSetAgents}。留着只为让 `store/install.ts` 编译得过。
 */
export const skillLinkAgents = (args: {
  dirSlug: string;
  agentIds: string[];
  replaceOccupied?: boolean;
}) => call<InstallReport>("skill_link_agents", { args });

/**
 * Rust 侧 `Result<T, E>` 的序列化形状。
 *
 * ⚠️ 键是**大写**的 `Ok`/`Err`:那是 serde 对 `Result` 的内建实现,
 * `rename_all` / `rename_all_fields` 都管不到它。这是既定形状,不要"顺手改成小写"。
 */
export type RustResult<T> = { Ok: T } | { Err: AppError };

/** 磁盘上一处「分歧版本」的快照,给「留哪一份」对话框用。 */
export interface SkillVersion {
  path: string;
  /** RFC3339(UTC),取目录内文件里最新的 mtime。 */
  modifiedAt: string;
  files: number;
  contentHash: string;
}

/** 一次收敛的结果(`core::converge::Converged`)。 */
export type Converged =
  | { kind: "linked"; mode: string }
  | { kind: "unchanged" }
  | { kind: "sameLocation" }
  | { kind: "differs"; existing: string };

/**
 * 「勾选哪些工具」的结果。
 *
 * `results` / `unlinkFailed` 是**元组数组**(Rust 的 `(String, ...)` 序列化成
 * JSON 数组),不是对象:`[agent 名, 结果]`。`Err` 表示"这个位置试过了但没成功",
 * 不是"没处理它"——界面要如实摆出来,吞掉就是显示"已完成"而实际没配上。
 */
export type SetAgentsOutcome =
  | { outcome: "needsVersionChoice"; versions: SkillVersion[] }
  | {
      outcome: "done";
      homeBody: string;
      canonical: RustResult<Converged>;
      results: [string, RustResult<Converged>][];
      unlinked: string[];
      unlinkFailed: [string, AppError][];
    };

/** 「这个技能让哪些工具能用」——一组 checkbox 的落地(取代了旧的「修复关联」)。 */
export const skillSetAgents = (args: { dirSlug: string; agents: string[] }) =>
  call<SetAgentsOutcome>("skill_set_agents", { args });

/** 「留哪一份」拍板的结果。`links` 同样是 `[路径, 结果]` 的元组数组。 */
export interface KeepReport {
  body: string;
  /** 被丢弃、进了废纸篓的其余版本。 */
  trashed: string[];
  links: [string, RustResult<Converged>][];
  canonical: RustResult<Converged>;
}

/**
 * 「有几个不一样的版本,留哪一个」拍板落地:选中的那份原地留下当本体,
 * 其余进废纸篓(可逆)、原位换成指向它的链接。
 *
 * `keepPath` 必须是 core 刚给出的候选之一,否则在动任何磁盘之前被
 * `FS_BAD_VERSION_CHOICE` 拒掉。
 */
export const skillKeepVersion = (args: { dirSlug: string; keepPath: string }) =>
  call<KeepReport>("skill_keep_version", { args });

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

/**
 * 分享的结果。**只剩 `shared` 一档**(v6 二期任务 6):库里同名且不是我分享的
 * 不再是"等用户三选一"的拍板档,而是 `REPO_NAME_TAKEN` 这个错误——覆盖别人的
 * 技能这条路整体取消,改名由用户在本地完成。
 *
 * ⚠️ `reviewUrl` 曾经是**收不到的**:core 那侧 `rename_all` 挂在枚举上只改
 * variant 名、不改 struct variant 的字段名,发过来的是 `review_url`,
 * 于是「查看审核」链接从来没渲染过。core 侧已补 `rename_all_fields` 并有
 * 断言完整键集合的测试钉住。
 */
export type ShareOutcome = {
  outcome: "shared";
  mode: ShareMode;
  commitSha: string;
  reviewUrl: string | null;
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

/**
 * ⚠️ **对应的后端命令 `share_candidates` 已于 v6 二期任务 6 删除**(分享页整页撤掉,
 * 首次分享的入口收进「我的技能」那一行)。这个包装还留着,只是因为
 * `store/share.ts` 与它的几个调用方要等做界面的那一轮才重写;**调用它一定会失败**。
 * 重写那一轮请连同 `ShareCandidate` 类型一起删掉。
 */
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

/**
 * 分享一个本机技能。**零编辑**:没有名称/描述/文件夹名可填,也没有 `overwrite`
 * ——core 按 Agent Skills 开放标准全量校验,不合格直接 `FS_SKILL_INVALID`
 * (`detail` 是 `ShareBlock` 的字面量,界面按它查文案表),改由用户在本地改好。
 *
 * 本体在哪也由 core 自己解析(`converge::locate`),前端不传路径。
 */
export const skillShare = (args: {
  dirSlug: string;
  registryId?: string;
  /** 分享目标技能库的寻址键,缺省 = 该源主库。 */
  repo?: string;
}) => call<ShareOutcome>("skill_share", { args });

export const skillShareChanges = (args: {
  dirSlug: string;
  registryId?: string;
  /** 冲突确认后的第二跳:跳过远端变更检测,强制走提交审核。 */
  forceReview?: boolean;
}) => call<ShareInstalledOutcome>("skill_share_changes", { args });

/**
 * 内建源的固定 registryId(与 `core::registry::BUILTIN_REGISTRY_ID` 逐字对应)。
 *
 * 「这是我分享的」按钮(v6 任务 5)要用它做门槛:`useSession` 只反映**内建源**的
 * 登录态(`auth_status` 不带 registryId,`commands.rs` 缺省解析成它),
 * `authors.json`/`claim_attribution` 也只有 Gitea 型的库支持(核心 `share.rs`
 * 对非 Gitea 报 `REPO_NO_ATTRIBUTION`)。摆在别的库详情上会摆出一个门槛判定
 * 与实际登录态对不上、点了很可能报错的按钮。
 */
export const BUILTIN_REGISTRY_ID = "company";

/**
 * 「作者未登记 · 这是我分享的」:把当前登录身份登记进技能库根的作者文件(v6 任务 3)。
 *
 * 走带凭证的写链路,身份取自登录态,没登录会报 `AUTH_REQUIRED`。
 */
export const skillClaimAttribution = (args: {
  dirSlug: string;
  registryId?: string;
  /** 目标技能库的寻址键 `owner/repo`,缺省 = 该源主库。 */
  repo?: string;
}) => call<ShareOutcome>("skill_claim_attribution", { args });

// ============================================================ 技能广场(M9 任务 1)
// 与 src-tauri/src/core/plaza.rs 的 PlazaSkillCard 一一对应(camelCase)。
// 只做发现:安装/更新走既有 GitHub 源机制,复用 ownerRepo 即可,这里不新增能力。

/**
 * 广场源的固定 registryId(与 `core::registry::PLAZA_REGISTRY_ID` 逐字对应)。
 *
 * 前端多处要判断"当前是不是广场"(库切换器、设置页、详情面板),集中成一个常量,
 * 不许各处各写一份 `"plaza"` 字面量——那是下一次改 id 时唯一会漏改的地方。
 */
export const PLAZA_REGISTRY_ID = "plaza";

/**
 * 技能广场(skills.sh)一条卡片数据。搜索结果与首页热门排行榜(M10 任务 4)
 * 共用同一个形状——两条入口都喂给同一个 `PlazaCard` 组件渲染。
 */
export interface PlazaSkillCard {
  name: string;
  /** 上游 `id`(`owner/repo/skill-name`),拼 `https://skills.sh/<slug>` 页面地址用。 */
  slug: string;
  /** 上游 `source`(`owner/repo`),详情与安装的寻址键。 */
  ownerRepo: string;
  installs: number;
  /**
   * 仅热门排行榜端点提供数据;搜索结果恒为 `false`(那个端点没有这个字段,不编造)。
   * 与 core 侧的 `bool`(非 `Option<bool>`)序列化契约对齐,**不标可选**——core
   * 永远会给这个字段,标成可选会让类型说谎(2026-08-17 审查修复:此前标了
   * `?:`,理由是"不强迫既有调用方都补一个值",但那是在替一个本不存在的缺席场景
   * 让步,真实契约里它从不缺席)。
   */
  isOfficial: boolean;
}

/**
 * 搜索技能广场。`query` 去空白后不足 2 字符时 core 侧直接返回空数组、不发请求
 * (上游 400 的边界)。失败统一是 `NET_PLAZA_SEARCH`——调用方按"搜索失败,请稍后
 * 重试"降级展示即可,不需要区分断网还是端点变了形状。
 */
export const plazaSearch = (query: string) =>
  call<PlazaSkillCard[]>("plaza_search", { query });

/**
 * 技能广场首页热门排行榜(M10 任务 4):广场空态("输入关键词搜索"之前)打开就有
 * 内容,不再是一行灰字。**这个命令永不抛出 `AppError`**——core 侧已把网络失败/
 * 上游改版导致的解析失败统一降级成空数组(见 `commands::plaza_leaderboard` 文档),
 * 调用方拿到空数组就该退回原来的空态提示,不需要 try/catch 出一个"获取失败"的分支。
 */
export const plazaLeaderboard = () => call<PlazaSkillCard[]>("plaza_leaderboard");

/**
 * 幂等挂仓(M9 任务 3):把广场搜索结果的 `ownerRepo`(`owner/repo`)坐标写进
 * `config.plazaRepos`。已挂过直接返回既有视图,不重复发探测请求。返回的
 * `RepoView.key` 直接喂给既有获取 IPC(`registryId: "plaza", repo: key`),
 * 走 acquire 全链路——这里只管挂仓这一步(编排在任务 5)。
 */
export const plazaEnsureRepo = (ownerRepo: string) =>
  call<RepoView>("plaza_ensure_repo", { ownerRepo });

/**
 * 广场详情(M9 任务 4,M10 任务 2 改走 blob):点开搜索结果卡片时现拉内容。
 *
 * `skillId`/`wantedName` 就是点击时那条搜索结果的 `slug`/`name`
 * (`usePlaza.openDetail` 已经拿在手里,原样带过来即可)——给了就优先走 blob 快照
 * 只取这一个技能(前端可感知的提速,数十秒降到 1 秒内),返回单项数组;
 * blob 不适用(未给这两个参数 / 404 / 该技能标记 internal / 技能名与点击的搜索结果
 * 对不上)时 core 侧静默回退现拉整仓的 zipball 路径,返回该仓全部技能——与
 * `plazaDetail` 改动前完全同一份行为,`locatePlazaSkill` 该显示"多技能列表"时
 * 照样显示(与商店详情面板同一份 `SkillDetail` 形状,这里不新造 DTO)。
 * 未挂仓也能查(详情先于安装),调用本身**不会**把仓写进 `config.plazaRepos`
 * ——那是 `plazaEnsureRepo` 的事。zipball 路径命中进程内缓存时不再发请求。
 */
export const plazaDetail = (ownerRepo: string, skillId?: string, wantedName?: string) =>
  call<SkillDetail[]>("plaza_detail", { args: { ownerRepo, skillId, wantedName } });

// ============================================================ 项目级安装(v5)

/** 项目分组里的一个技能。`key` 是内部标识,界面一律展示 `displayName`。 */
/** 一段版本说明。`versions` 是一组:仓库里真实存在 `## 0.3.5 / 0.3.4 —— …` 这种写法。 */
export interface ReleaseNote {
  versions: string[];
  /** 发布日期 `YYYY-MM-DD`。null = 这一版还没发出去(发版脚本发版当天自动补)。 */
  date: string | null;
  /** 标题里「——」之后的主题句,给界面当副标题。 */
  theme: string;
  /** 正文,原样 Markdown。 */
  body: string;
}

export interface ReleaseNotesState {
  /** 当前运行的版本。卡片标题用它,不用日志里最新那段的版本号。 */
  current: string;
  /** 这一次该给用户看的段落(新到旧)。空 = 不显示卡片。 */
  pending: ReleaseNote[];
  /** 全部段落,设置页的「版本历史」用。 */
  all: ReleaseNote[];
}

export async function releaseNotesState(): Promise<ReleaseNotesState> {
  return call<ReleaseNotesState>("release_notes_state");
}

/** 记下「这一版的更新日志我看过了」。由用户**关掉卡片**触发,不是显示就写。 */
export async function releaseNotesAck(): Promise<void> {
  return call<void>("release_notes_ack");
}

export interface ProjectSkillView {
  key: string;
  displayName: string;
  description: string;
  source: string;
  sourceType: string;
  /**
   * 仓库里的技能目录名(取数用)。**不是 `key`**——`key` 是 frontmatter name,
   * 两者在广场技能里经常不同(实测 47 个里 8 个),拿 key 取数会 REPO_NOT_FOUND。
   * 推不出来时为 null,此时 `updatable` 必为 false。
   */
  dirSlug: string | null;
  /**
   * 更新时该去哪个源取数。**必须原样传回 `project_skill_update`**——
   * 缺省会落到内建源的主仓,而项目里的技能完全可能来自广场或另一个技能库,
   * 那样点「更新」要么报找不到技能,要么装进来一个同名但完全不同的技能。
   */
  registryId: string | null;
  /** 更新时的寻址键 `owner/repo`,同上必须原样传回。 */
  repo: string | null;
  /**
   * 能不能更新。`sourceType` 为 local/node_modules/well-known 的还原不了来源,
   * 推不出仓库目录名的也不行。界面据此**不摆更新按钮**
   * ——不摆比摆一个必然报错的按钮好(M6「绑不上就不摆」同款)。
   */
  updatable: boolean;
}

/** 一个项目及它里面的技能。 */
export interface ProjectGroupView {
  path: string;
  folderName: string;
  /** 目录不在了(被删或移走)。此时只提供「从列表移除」。 */
  missing: boolean;
  /** 记账文件版本不认识或损坏 → 只读展示,本应用一个字节都不写。 */
  readOnly: boolean;
  skills: ProjectSkillView[];
}

export type ProjectInstallOutcome =
  | { status: "installed"; key: string; linkedAgents: string[] }
  | { status: "alreadyInstalled"; key: string }
  | { status: "needsDecision"; key: string };

export type ProjectUpdateOutcome =
  | { status: "updated"; key: string }
  | { status: "alreadyLatest"; key: string }
  | { status: "hasLocalEdits"; key: string };

export interface ProjectRemoveDone {
  bodyRemoved: boolean;
  unlinked: string[];
  /** 没删掉的东西(内容与本体不同的实体目录),界面要如实告诉用户。 */
  kept: { kind: "keptForeignDir"; dir: string }[];
}

/** 弹目录选择框。用户取消返回 `null`;选中的路径已过守卫校验。 */
export const projectPick = () => call<string | null>("project_pick");

export const projectList = () => call<ProjectGroupView[]>("project_list");

/** 从清单移除。**纯记账**,项目里的技能一个字节都不动。 */
export const projectForget = (path: string) => call<void>("project_forget", { path });

export const projectSkillInstall = (args: {
  projectPath: string;
  dirSlug: string;
  registryId?: string;
  repo?: string;
  agentIds: string[];
  confirmedReplace?: boolean;
  /** 已经装过也照装一遍(重建关联)。**不蕴含 confirmedReplace**:本体被改过时仍会问。 */
  force?: boolean;
}) => call<ProjectInstallOutcome>("project_skill_install", { args });

export const projectSkillUpdate = (args: {
  projectPath: string;
  key: string;
  dirSlug: string;
  registryId?: string;
  repo?: string;
  agentIds: string[];
  discardLocalEdits?: boolean;
}) => call<ProjectUpdateOutcome>("project_skill_update", { args });

/** 移除技能。破坏性操作,`confirmed` 必须是前端确认过的结果(铁律 7)。 */
export const projectSkillRemove = (projectPath: string, key: string, confirmed: boolean) =>
  call<ProjectRemoveDone>("project_skill_remove", { projectPath, key, confirmed });

/**
 * 在文件管理器中显示项目文件夹。
 *
 * 与 `skillReveal` 分开:那条的 core 守卫只放行含 SKILL.md 的技能目录,
 * 项目根不符合。这条的守卫是"必须在项目清单里"——同样不接受任意路径。
 */
export const projectReveal = (path: string) => call<void>("project_reveal", { path });
