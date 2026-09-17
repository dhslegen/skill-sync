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

/**
 * 这个技能自己最后一次被改动的时间(v8 任务 1,`core::store::SkillUpdatedAt`)。
 *
 * 🔴 **三档,不是 `string | null`**:两种"没有时间"必须分得开——
 * - `longAgo`:翻完提交历史都没见到它,属实"很久以前",**照实显示**;
 * - `unknown`:这个源根本算不出(技能广场 / GitHub 源),界面**整行不摆**。
 *
 * 压成同一个值的后果是广场每张卡片都写「很久以前」,那是编造。同一个坑在
 * `lib/update.ts` 的 {@link LocalProbe}(「还没探到」vs「探过、没有」)记过一次。
 */
export type SkillUpdatedAt =
  | { kind: "at"; at: string }
  | { kind: "longAgo" }
  | { kind: "unknown" };

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
  /** 这个技能自己最后一次被改动的时间。见 {@link SkillUpdatedAt}。 */
  updatedAt: SkillUpdatedAt;
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
  /** 整库分支头的提交时间。**不是**这个技能自己的更新时间(那是 `updatedAt`)。 */
  committedAt: string;
  /** 这个技能自己最后一次被改动的时间。见 {@link SkillUpdatedAt}。 */
  updatedAt: SkillUpdatedAt;
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
  /**
   * 相对项目根的技能目录(注册表 `skillsDir`,如 `.claude/skills`)。项目行事后改选
   * 的 picker 用它拼落点路径(0.6.x K3);与 core 建链用的是同一个注册表字段。
   * **仅供展示**,别拿它去比对任何路径——Windows 上 `<项目>\x` + `/.claude/skills`
   * 是混排的,core 自己 `join` 出来的也是同一种混排。
   */
  skillsDir: string;
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
  /**
   * **无账**,本地已有一份实体,内容与库里这一版逐字节相同(v6 二期)。
   * 装 = 记账 + 启用,本体一个字节都不写(它已经是对的了)。典型场景:
   * 用户在 `~/.claude/skills/` 下开发技能、经 git 直推进库,换台电脑再取回。
   */
  | { status: "alreadyHere"; body: string }
  /** **无账**,本地已有一份实体但内容不同(v6 二期):用库里的 / 保留本地,两选。 */
  | { status: "localDiffers"; existing: string }
  /** **无账**,同名技能在多处各有一份且内容有分歧(v6 二期):先拍板留哪一份。 */
  | { status: "needsVersionChoice"; versions: SkillVersion[] }
  | { status: "managed"; installedSha: string; upToDate: boolean }
  | { status: "locallyModified"; installedSha: string }
  /** 同名技能已装自另一个技能库(M4 一源多仓):不是更新,是替换。 */
  | { status: "otherLibrary"; installedSha: string; sourceOwner: string; sourceRepo: string }
  /**
   * 技能库里记的分享者就是当前登录的这个人(v6 任务 3)。
   *
   * 取代了作者在自己技能上会看到的「这不是本应用装的」/`locallyModified`/
   * `managed{upToDate:false}` 三种说法——它们讲的是"这东西是怎么来的",而作者
   * 要的是"我这边和库里哪边新"。`localChanged`:本地本体与账上基线不符;
   * `remoteChanged`:库里这一版与账上基线不符。
   */
  | { status: "mine"; localChanged: boolean; remoteChanged: boolean };

/**
 * 🔴 **这里刻意没有"外来目录"那一档**(v6 二期任务 8 删除,连同 `ForeignOrigin`)。
 *
 * core 侧的 `Precheck::Foreign` 已随本期撤销:「这个位置上的技能不是本应用装的」
 * 正是这一期要消灭的那句话——用户在 `~/.claude/skills/` 下自己写的技能被当成了
 * 外人。取代它的是 `alreadyHere` / `localDiffers` / `needsVersionChoice` 三档
 * ——**按内容比对,而不是按"这个文件夹是谁建的"猜**(磁盘上根本回答不了后者)。
 *
 * 类型里留着它就等于给 `ConflictDialog` 的兜底分支一个继续存在的理由,
 * 而那个分支说的就是那句假话。别再加回来。
 */

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
  // 🔴 这里曾有一个 `links`(各位置的健康态,连同 `LinkHealth`/`LinkHealthReport`
  // 两个类型),v6 二期任务 8
  // 删除:「N 处异常」那类说法整体撤销,同一件事现在由 {@link tools} 的每个勾
  // 如实回显(`missing` = 那个位置上的东西已经不是我们放的了,再点一次勾即自愈)。
  // 删之前查过前端零读者。**core 那侧仍在填这个字段**——多出来的 JSON 键会被
  // 忽略,不影响任何行为;要不要一并从 core 摘掉是独立议题,不在本任务范围。
  /**
   * 本体现在住在哪(绝对路径);只在库里、本地没有本体时是空串。
   *
   * **它是「本体永不搬动」这条承诺在界面上的落点**:用户要能看见"这个技能就在
   * 我 `~/.claude/skills/` 下的那个文件夹里",而不是被告知一个他从没听说过的
   * 统一目录路径。「打开文件夹」按钮的目标就是它——🔴 **传 `path: skill.body`,
   * 不传 `dirSlug`**:后者会被 `skill_reveal` 解析成统一目录下的同名目录,
   * 而本体很可能根本不在那里,打开的就是另一个地方(或者什么都打不开)。
   */
  body: string;
  /**
   * 本体此刻的**实时**内容指纹(读不出来留空)。
   *
   * 🔴 与 {@link contentHash} 是两样东西,别混:那个是**安装那一刻的基线**,
   * 没有记录的行恒为空;这个是"本体现在长什么样"。前端要回答"本地与库里
   * 一不一样"(无基线那一档的唯一问法)只能靠它。
   */
  localHash: string;
  /** 各 AI 工具的启用态。**「每个工具一个勾」这组 checkbox 的唯一真相**,
   *  不是 {@link agents}(那份是期望态,建链失败的目标也留在里面)。 */
  tools: ToolView[];
  /** 这个技能眼下有几份内容不同的实体(含本体自己)。长度 > 1 = 有分歧,
   *  界面要让用户先拍板留哪份({@link skillKeepVersion})。 */
  versions: SkillVersion[];
  /** 分享前的标准校验没过的话,是哪一条。`null` = 可以分享。
   *  本地没有本体的行恒 `null`(没什么可校验的)。 */
  shareBlocked: ShareBlock | null;
  /**
   * 「我的技能」页按**公司技能库**分的三区(v7,`core::ownership::section(relation)`
   * 的**唯一**填法,前端直接按它分区,不再自己从 {@link relation} 推)。
   *
   * `installedFrom` = 安装自公司技能库(库里有,作者不是我);
   * `sharedTo` = 已分享到公司技能库(库里有,作者是我);
   * `shareable` = 可分享到公司技能库(不在公司库:本地草稿,或从广场/GitHub/
   * 自定义源装的)。
   */
  section: Section;
  /**
   * 「可分享到」区的审核态(v7)。有它就是"审核中"——界面据此隐藏「分享」按钮,
   * 避免用户重复提交。`null` = 从没分享过,或这次查询失败又没有本地兜底证据,
   * 两者在界面上是同一档"可以分享"。
   *
   * 🔴 `url` 本身可能是 `null`(直推进 main 留下的记录、或 v7 之前的存量记录都
   * 没有 PR 链接可给,但记录本身仍然成立"审核中"这件事)——**不要用空串冒充
   * 链接**,按 `null` 判断要不要显示可点的「查看审核」。
   */
  review: ReviewView | null;
  /**
   * 「在技能库里查看」那颗按钮要打开的网页地址(v7.1 任务 3)。
   * `null` = 拼不出来(不在公司技能库里 / 编译期没注入内网地址 / 索引缓存里
   * 没有这个技能的路径),界面**不摆这颗按钮**——不摆比摆一个必然报错的按钮好。
   *
   * 🔴 **前端不自己拼这个地址**:内网 Gitea 地址是编译期常量,铁律 5 要求源码里
   * 不得出现真实地址;库内路径也取自索引的真实 `path`,不是 `skills/<dirSlug>`
   * 猜出来的。拿到之后原样交给 {@link openLibraryUrl}(它带同源白名单守卫)。
   */
  libraryUrl: string | null;
  /**
   * 本体住在**统一技能目录**(canonical)时,这台电脑上正读着那个目录的工具
   * **展示名**;本体不在那里时是 `null`(v7.1 任务 1)。
   *
   * 🔴 与 {@link InstalledSkillView.tools} 是互补的两半:本体在统一目录时,共用
   * 那个目录的六个工具(Cline/Dexto/Kimi Code CLI/Loaf/Warp/Zed)恒 `body`——
   * **不可勾也不可取消**,摆进可勾清单只会让用户以为自己该做点什么,所以 core
   * 已经把它们从 `tools` 里拿掉,换成这份名单(界面摆进「…」里展开)。
   * 本体住某个**工具目录**时行为完全不变:那一个工具仍标 `body`、仍在 `tools`
   * 里,这个字段为 `null`。
   *
   * ⚠️ **core 已经按"这台机器上装没装那个工具"收窄过了**,与 `tools`(core 不
   * 收窄、前端按 `agents_detected` 收窄)刻意不同——拿到直接显示,别再用
   * `visibleTools` 之类收窄一次。空数组是合法档(本体确实在统一目录,但那六个
   * 工具一个都没装),它与 `null`(本体不在统一目录)是两件事。
   */
  canonicalReaders: string[] | null;
}

/** 「我的技能」页按公司技能库分的三区(`core::ownership::Section`)。 */
export type Section = "installedFrom" | "sharedTo" | "shareable";

/** 「可分享到」区的审核态(`core::my_skills::ReviewView`)。 */
export interface ReviewView {
  url: string | null;
}

/**
 * 一个 AI 工具眼下能不能读到这个技能(`core::my_skills::ToolState`)。
 *
 * - `body` 本体就住在这个工具的目录里(用户在这里开发它)。**这个勾恒亮且
 *   不可取消**——取消等于删本体;
 * - `linked` 这个工具能读到本体;
 * - `copy` 位置上是一份实体副本(Windows 无权建链时的降级形态);
 * - `missing` 账上有这个位置,但那里的东西已经不是我们放的了(再点一次即自愈);
 * - `off` 没有在这个工具里启用。
 */
export type ToolState = "body" | "linked" | "copy" | "missing" | "off";

export interface ToolView {
  agent: string;
  state: ToolState;
}

/**
 * 分享前的标准校验没过的原因(`core::skills::ShareBlock`)。
 *
 * 判据是 Agent Skills 开放标准 <https://agentskills.io/specification>,
 * 口径契约在 `fixtures/share-validation-samples.json`(Rust 与前端共读那一份)。
 * 界面按这个字面量查 `mine.shareBlocked.*` 的人话文案。
 */
export type ShareBlock =
  | "nameMissing"
  | "nameMismatch"
  | "nameFormat"
  | "dirFormat"
  | "descriptionMissing"
  | "descriptionTooLong"
  | "skillMdUnreadable";

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

/**
 * 移除的结论。**只剩一档**(v6 二期):改过本体的二次确认已撤销——铁律 7 改由
 * "本体进系统废纸篓、可逆"落实,`core::remove::RemoveOutcome` 那侧同样只剩
 * `Removed`。声明成单成员联合而不是接口,是为了与 core 那侧"保持枚举形状"的
 * 取舍一致:将来若真有第二档(比如"本体在别的电脑上"),两侧都不必换形状。
 */
export type RemoveOutcome = { outcome: "removed"; report: UninstallReport; lock: string };

/** 订阅一次安装的进度。契约 3.3:长任务走 `progress://{taskId}` 事件。 */
/**
 * 订阅本地技能目录的变更(M4 任务 6c 级别 3)。
 *
 * 载荷为空——它只是"去重新扫描一下"的信号。core 侧滤掉了本应用自己写盘引发的
 * 事件(见 core/watcher.rs),所以收到它**基本上**意味着外面真的改了东西。
 *
 * ⚠️ **"基本上"三个字是认真的**:过滤靠的是每个写盘编排函数自己持有
 * `watcher::app_write()` 守卫,那是一份**人工维护的名单**,不是语言层面的保证。
 * 终审 I-3 就抓到过三处漏持(`converge::set_agents` / `converge::keep_version` /
 * `share::share`,而任务 5 同期把监听根从 1 个扩到 8 个),当时这句话是假话。
 * 现在名单由 `tests/watcher_guard.rs` 钉着——**它守的是"已知的那几个别被摘掉",
 * 守不住"新写的第七个忘了拿"**。加新的写盘编排时自己拿一个,并把它加进那份名单。
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

/**
 * 移除一个技能。**没有 `force`**(v6 二期):`SkillRemoveArgs` 那侧只剩 `dir_slug`,
 * 带一个 core 已经不认的字段过去,只会让读代码的人以为那道闸还在。
 */
export const skillRemove = (args: { dirSlug: string }) =>
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
  /**
   * 这个技能眼下实际链接到了哪些工具(内部 agent 名,上屏前必须换成展示名)。
   *
   * 🔴 事后改选 picker 的初始勾选**唯一**来源——不能自己猜。`project_skill_set_agents`
   * 收的是完整目标集,不是增量:picker 若从"全不勾"起步,用户点一个勾就会把
   * 这里没显示出来的其余真实关联一并摘掉。提交时必须以这份全量列表为基底
   * (当前集 ∪/∖ 这一次翻转),不能只发"这次勾选框里能看到的"那几个
   * ——与 `ToolChecks`(全局版)"提交名单从全量 tools 派生,不是从收窄后的
   * shown"同一条纪律。
   */
  agents: string[];
  /**
   * 本体(`.agents/skills/<key>`)此刻在不在磁盘上。`false` = lock 里还有记录、文件已被
   * 删掉——界面标出缺失,只给「重新装回」与「从记录里去掉」。
   */
  bodyPresent: boolean;
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

/**
 * 更新一个已装进项目的技能。
 *
 * 🔴 **没有 `agentIds`——v7 任务 3 已把 `project_skill_update` 改成从磁盘反推
 * 当初关联的那批工具(`project::current_agents`),不再吃前端传的探测/禁用状态**
 * (任务 3 修复的正是"用现场重建的默认值覆盖用户当初选的那批"这个缺陷)。
 * `ProjectUpdateArgs` 那个字段已经删了,这里跟着清掉——不删的话前端每次调用都在
 * 拼一个 Rust 不认的死参数(serde 忽略未知键,发出去不报错,但读代码的人会
 * 以为它还在起作用)。
 */
export const projectSkillUpdate = (args: {
  projectPath: string;
  key: string;
  dirSlug: string;
  registryId?: string;
  repo?: string;
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

/** 装完之后事后改选「这个技能在这个项目里对哪些工具生效」的回报。 */
export interface ProjectSetAgentsDone {
  /** 新建了链接的 agent 名单(内部标识,上屏前必须换成展示名)。 */
  linked: string[];
  /** 摘掉了链接的 agent 名单。 */
  unlinked: string[];
  /**
   * 该建/该摘的位置被一个内容不同的东西占着,一个字节没动、原样留下(铁律 7)。
   * 界面必须有渲染点——这一档不是"没做成",是"停下来问你"。
   */
  kept: string[];
}

export const projectSkillSetAgents = (args: { projectPath: string; key: string; agentIds: string[] }) =>
  call<ProjectSetAgentsDone>("project_skill_set_agents", { args });
