import { useEffect } from "react";
import { Check, TriangleAlert } from "lucide-react";

import { Icon } from "@/components/Icon";
import { InstallButton } from "@/components/InstallButton";
import { InstallScopeMenu } from "@/components/InstallScopeMenu";
import { t, type MessageKey } from "@/i18n";
import { failedLinks, linkedAgents, useInstall } from "@/store/install";
import { cn } from "@/lib/cn";
import { PLAZA_REGISTRY_ID, type InstallStage } from "@/lib/ipc";
import { cardState, remoteHashOf, type LibraryRef } from "@/lib/update";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";

/** `owner/repo` → 广场坐标下的 `LibraryRef`。广场技能永远走固定的 `plaza` 源。 */
function ownerRepoToLibrary(ownerRepo: string): LibraryRef {
  const [owner, repo] = ownerRepo.split("/");
  return { registryId: PLAZA_REGISTRY_ID, owner: owner ?? "", repo: repo ?? "" };
}

const STAGE_LABEL: Record<InstallStage, MessageKey> = {
  fetching: "install.stageFetching",
  checking: "install.stageChecking",
  writing: "install.stageWriting",
  linking: "install.stageLinking",
  recording: "install.stageRecording",
  done: "install.stageDone",
};

/**
 * 详情面板底部的获取区。
 *
 * agent 多选做成**行内展开**而不是弹窗:面板本身已经是一层浮层,再叠一个模态
 * 在桌面应用里既挡视线又难退出。冲突那一档才用弹窗——它是必须打断的决策。
 */
export function InstallPanel({
  dirSlug,
  plaza,
}: {
  dirSlug: string;
  /**
   * 技能广场详情态(M9 任务 5):不经 `useStoreIndex` 判定库,直接给来源坐标。
   * 有值时"点安装"先幂等挂仓(`beginFromPlaza`)再走同一条 agent 勾选/运行/结果链路
   * ——除了触发方式与"这个技能属于哪个库"的判定来源,其余阶段渲染与普通安装完全一样。
   */
  plaza?: { ownerRepo: string };
}) {
  const { phase, dirSlug: active, begin, beginFromPlaza, cancel } = useInstall();
  // 详情面板只会从商店打开:装的就是商店当前浏览的那个库(M3 多源 + M4 多仓)。
  // 广场详情态没有"当前浏览的库"这回事(广场本身是搜索态),坐标由 plaza 参数给。
  const activeRegistry = useStoreIndex((s) => s.activeRegistry);
  const activeRepo = useStoreIndex((s) => s.activeRepo);
  const mine = active === dirSlug;

  const dismissProjectNotice = useProjects((s) => s.dismissNotice);
  const cancelConfirm = useProjects((s) => s.cancelConfirm);

  // 打开(或换一个)技能详情时的收尾。三件事都与"这一次会话"绑定,不是技能的属性:
  //
  // 1. 上一次的项目安装提示与待确认条——不清的话提示说的是**另一个技能**的事,
  //    待确认条更糟:点「装到这里」装的是上一个技能;
  // 2. 🔴 **上一次安装的结果报告**(「已启用到 Claude Code、Trae」)。它是**本次安装
  //    做了什么**的临时态,不是这个技能的属性。上个月装的技能打开就是简简单单一句
  //    「已启用」,刚装的却永远带着一段结果报告,同一个东西两种面孔——而且此前
  //    **只有重启应用才能回到简易态**(2026-08-22 用户反馈)。
  //
  // ⚠️ **进行中的流程绝不能清**(running/choosing/conflict):关掉详情面板时安装
  //    可能还在跑,清掉状态等于把进行中的流程整个丢掉。只收终态。
  //
  // 用 `getState()` 读 phase 而不是订阅:订阅的话 phase 一变成 done 就会被这个
  // effect 立刻清掉,结果报告一帧都看不到。
  useEffect(() => {
    dismissProjectNotice();
    cancelConfirm();
    const s = useInstall.getState();
    if (s.phase === "done" || s.phase === "error") s.cancel();
  }, [dirSlug, dismissProjectNotice, cancelConfirm]);

  const scope = { dirSlug, plaza, activeRegistryId: activeRegistry, activeRepoKey: activeRepo };

  // 项目安装的进行态/提示/待确认与**全局安装的 phase 无关**,所以在顶层渲染。
  // 🔴 此前它们挂在 `IdleFooter` 内部,于是"装完那一屏"(done)里点最近项目,
  // 确认条整个渲染不出来——用户看得到入口、点了却没反应。
  const projectArea = <ProjectStatus />;

  if (!mine || phase === "idle") {
    return (
      <>
        <IdleFooter
          {...scope}
          onBegin={() =>
            plaza
              ? void beginFromPlaza(plaza.ownerRepo, dirSlug)
              : void begin(dirSlug, activeRegistry, activeRepo)
          }
        />
        {projectArea}
      </>
    );
  }
  if (phase === "choosing") return <AgentChooser onCancel={cancel} />;
  if (phase === "running") return <Running />;
  if (phase === "done") {
    return (
      <>
        <DoneFooter {...scope} />
        {projectArea}
      </>
    );
  }
  if (phase === "error") return <ErrorFooter />;
  // conflict 由 ConflictDialog 接管,底部保持"安装中"的静态样子
  return <Running />;
}

function IdleFooter({
  dirSlug,
  plaza,
  onBegin,
  activeRegistryId,
  activeRepoKey,
}: {
  dirSlug: string;
  plaza?: { ownerRepo: string };
  onBegin: () => void;
  /** 当前浏览的库坐标(装到项目时要原样带上,否则会打到主仓)。 */
  activeRegistryId?: string | null;
  activeRepoKey?: string | null;
}) {
  const installed = useInstall((s) => s.installed);
  const index = useStoreIndex((s) => s.index);
  const record = installed.get(dirSlug);
  // 与商店卡片同一条判定。曾经这里只算 install/installed 两档,于是卡片显示
  // "更新"、点进来按钮却是禁用的「已启用」——用户点了毫无反应(2026-08-03 实测缺陷)。
  //
  // 广场详情态没有索引可比(广场是搜索态,不建索引——设计文档 §2.4):remoteHash
  // 传空串,`cardState` 对指纹缺失按"已启用"处理,宁可漏报"有更新"也不能编造一个。
  // 真正精确的"有更新"判定,要等这个仓被挂上、用户切到它按普通库浏览时才出现
  // (那条路走的是 store_index,自然有指纹可比,§2.4 说的正是这件事)。
  const state = plaza
    ? cardState(record, "", ownerRepoToLibrary(plaza.ownerRepo))
    : cardState(
        record,
        remoteHashOf(index, dirSlug),
        index ? { registryId: index.registryId, owner: index.owner, repo: index.repo } : undefined,
      );
  const requestInstall = useProjects((s) => s.requestInstall);
  const installing = useProjects((s) => s.installing);


  // 装到项目沿用全局默认 agent(2026-08-20 拍板:不再单独问一次)。
  // 口径与全局安装共用 `defaultSelectedAgents`,不另写一份。

  return (
    <div className="border-t border-border px-5 py-3.5">
      <div className="flex items-center gap-2.5">
        <InstallButton
          state={state}
          size="lg"
          onClick={onBegin}
          hint={
            state === "otherLibrary" && record
              ? t("skill.otherLibraryHint", {
                  library: `${record.sourceOwner}/${record.sourceRepo}`,
                })
              : undefined
          }
        />
        <InstallScopeMenu
          dirSlug={dirSlug}
          // 主按钮是终态(「已启用」不可点)时,把作用域入口显性化成文字按钮
          // ——那一档整块看起来就是"做完了",小三角不足以让人想到还能装到项目
          // (2026-08-22 用户反馈)。可点动作那几档保持图标,免得抢注意力。
          label={state === "installed" ? t("install.scopeProject") : undefined}
          disabled={!!installing}
          onGlobal={onBegin}
          onPickProject={() => {
            void (async () => {
              await requestInstall({
                dirSlug,
                registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
                repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
              });
            })();
          }}
          onChooseRecent={(path) =>
            // 「最近的项目」省掉的**只是选文件夹那一步**,后续与手选文件夹完全一样
            // ——一样进确认条、一样点「装到这里」才写盘(2026-08-22 用户拍板,
            // 推翻了此前"最近项目豁免确认"的设计)。同一个动作在两个入口两种行为,
            // 心流是断的;一致性比省一次点击值钱。
            void requestInstall({
              dirSlug,
              projectPath: path,
              registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
              repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
            })
          }
        />
        {record?.localModified && (
          <span className="text-[11.5px] text-text-3">{t("conflict.modifiedTitle")}</span>
        )}
      </div>

    </div>
  );
}

/** 路径末段。界面不拿完整路径当标题(太长),完整路径挂在 title 上。 */
function folderNameOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 项目安装的进行态 / 结果提示 / 待确认条。
 *
 * 🔴 **与全局安装的 phase 无关,所以在 `InstallPanel` 顶层渲染**:此前它们挂在
 * `IdleFooter` 内部,于是"装完那一屏"(`phase === "done"`)里点最近项目,确认条
 * 整个渲染不出来——用户看得到入口、点下去却没反应。这类"入口在这一屏、
 * 反馈在另一屏"的错位,单测不特意跨 phase 构造就发现不了。
 */
function ProjectStatus() {
  const installing = useProjects((s) => s.installing);
  const notice = useProjects((s) => s.notice);
  const confirm = useProjects((s) => s.confirm);

  if (!installing && !notice && !confirm) return null;

  return (
    <div className="px-5 pb-3.5">
      {installing && (
        <p className="text-[11.5px] text-text-3">
          {t("install.installingToProject", { project: folderNameOf(installing.projectPath) })}
        </p>
      )}
      {!installing && notice && <p className="text-[11.5px] text-text-2">{notice}</p>}
      {confirm && <ConfirmBar />}
    </div>
  );
}

/**
 * 选完文件夹之后的确认条(2026-08-22 用户真机反馈后加)。
 *
 * 原先是选完路径立刻写盘,用户的原话是"我以为是选完路径后点击安装,结果直接安装了"。
 * 完整原委与"为什么不改系统选择框的按钮文案"见 `store/project.ts` 的 `ProjectConfirm`。
 *
 * 它同时是**成功反馈的锚点**:点下去之后原地变成结果提示,视线不用移动——
 * 比在别处冒出一行小字可靠得多(用户另一条反馈:"安装提示不够明显")。
 */
function ConfirmBar() {
  const confirm = useProjects((s) => s.confirm)!;
  const confirmInstall = useProjects((s) => s.confirmInstall);
  const cancelConfirm = useProjects((s) => s.cancelConfirm);
  const requestInstall = useProjects((s) => s.requestInstall);

  return (
    <div className="mt-2.5 rounded-card border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-text-3">{t("install.confirmTitle")}</div>
          <div className="truncate text-[13px] font-[550]">{folderNameOf(confirm.projectPath)}</div>
          {/* 路径用等宽(UI 规范),完整值挂 title —— CSS 只能截尾 */}
          <div className="truncate font-mono text-[10.5px] text-text-3" title={confirm.projectPath}>
            {confirm.projectPath}
          </div>
          <div className="mt-1 text-[11.5px] text-text-3">
            {confirm.alreadyInstalled
              ? t("install.confirmAlready")
              : confirm.agentLabels.length > 0
                ? t("install.confirmAgents", {
                    agents: confirm.agentLabels.join(t("common.listSep")),
                  })
                : t("install.confirmNoAgents")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 已经装过时主动作换成「覆盖重装」而不是撤掉按钮(2026-08-22 用户拍板:
              "装过的也能装,保留足够权利")。**这不违反「不摆比解释好」**——那条针对的是
              点了必然报错的按钮;重装是完全合法的操作,内容一样时它仍会重建 agent 关联,
              那正是用户想重装的理由。 */}
          {confirm.alreadyInstalled ? (
            <button
              type="button"
              title={t("install.confirmForceHint")}
              onClick={() => void confirmInstall(true)}
              className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
            >
              {t("install.confirmForce")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void confirmInstall()}
              className="h-7 rounded-ctl bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover"
            >
              {t("install.confirmGo")}
            </button>
          )}
          {/* 就地换一个文件夹(2026-08-22 用户拍板:"装到一个目录不应该没有任何
              可装到别的目录操作空间")。此前这一档只有「取消」,是条死路。 */}
          <button
            type="button"
            onClick={() =>
              void requestInstall({
                dirSlug: confirm.dirSlug,
                registryId: confirm.registryId,
                repo: confirm.repo,
              })
            }
            className="h-7 rounded-ctl px-2.5 text-[12px] font-medium text-text-2 hover:text-text"
          >
            {t("install.confirmPickOther")}
          </button>
          <button
            type="button"
            onClick={cancelConfirm}
            className="h-7 rounded-ctl px-2.5 text-[12px] font-medium text-text-3 hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentChooser({ onCancel }: { onCancel: () => void }) {
  const { agents, selected, toggleAgent, run, registryId, repo } = useInstall();
  // 需要建链的才列出来:通用目录的 agent(cursor/codex 等)落在 canonical 就能读到,
  // 让用户去勾一个"勾不勾都一样"的选项只会让人困惑。
  const linkable = agents.filter((a) => a.needsLink);
  // 广场的挂仓探测是异步的(beginFromPlaza):在它回来、`repo` 被换成真实寻址键之前,
  // 「确定」点下去必然带着 repo: null 去调 skill_install,报"技能广场没有默认技能库"
  // ——这句错误跟用户刚点的按钮毫无关系(M9 终审修复)。禁用比放行后报一句文不对题
  // 的错误更诚实。
  const confirmDisabled = registryId === PLAZA_REGISTRY_ID && repo === null;

  return (
    <div className="border-t border-border px-5 py-3.5">
      <div className="mb-2 text-[12px] font-[550]">{t("install.choose")}</div>
      <div className="max-h-[168px] overflow-y-auto rounded-card border border-border">
        {linkable.map((agent) => (
          <label
            key={agent.name}
            className="flex cursor-default items-center gap-2.5 border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-2"
          >
            <input
              type="checkbox"
              checked={selected.has(agent.name)}
              onChange={() => toggleAgent(agent.name)}
              className="size-3.5 accent-[var(--accent)]"
            />
            <span className="text-[12.5px] font-medium">{agent.displayName}</span>
            <span className="ml-auto truncate font-mono text-[11px] text-text-3">
              {agent.installed ? agent.globalSkillsDir : t("install.notDetected")}
            </span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-[11.5px] leading-[1.5] text-text-3">{t("install.chooseHint")}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={confirmDisabled}
          onClick={() => void run()}
          className="h-[30px] rounded-ctl bg-accent px-[14px] text-[12.5px] font-[550] text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {t("install.confirm")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-[30px] rounded-ctl border border-border px-[14px] text-[12.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("install.cancel")}
        </button>
      </div>
    </div>
  );
}

const STAGE_ORDER: InstallStage[] = ["fetching", "checking", "writing", "linking", "recording", "done"];

function Running() {
  const stage = useInstall((s) => s.stage);
  // 进度条按阶段推进。没有字节级进度可报(压缩包一次性下完),阶段本身就是最诚实的粒度。
  const done = stage ? STAGE_ORDER.indexOf(stage) + 1 : 0;
  const percent = Math.round((done / STAGE_ORDER.length) * 100);

  return (
    <div className="border-t border-border px-5 py-3.5">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-text-2">
        <span>{stage ? t(STAGE_LABEL[stage]) : t("install.installing")}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full bg-accent transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

function DoneFooter({
  dirSlug,
  plaza,
  activeRegistryId,
  activeRepoKey,
}: {
  dirSlug: string;
  plaza?: { ownerRepo: string };
  activeRegistryId?: string | null;
  activeRepoKey?: string | null;
}) {
  const { report, localKept, shareResult, agents: detected, begin, beginFromPlaza } = useInstall();
  const requestInstall = useProjects((s) => s.requestInstall);
  const failed = failedLinks(report);
  const agents = linkedAgents(report, detected);

  return (
    <div className="border-t border-border px-5 py-3.5">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 text-[12.5px] font-medium text-ok">
          <Icon icon={Check} size={14} />
          {agents.length > 0
            ? t("install.done", { agents: agents.join(t("punct.listSeparator")) })
            : t("install.doneCanonicalOnly")}
        </div>
        {/* 装完那一屏也要留出口(2026-08-22 用户反馈:"这时候也没有更多操作空间")。
            与「已启用」终态同一形态:结果是状态,「装到项目…」是动作,并排摆。 */}
        <InstallScopeMenu
          dirSlug={dirSlug}
          label={t("install.scopeProject")}
          onGlobal={() =>
            plaza
              ? void beginFromPlaza(plaza.ownerRepo, dirSlug)
              : void begin(dirSlug, activeRegistryId ?? undefined, activeRepoKey)
          }
          onPickProject={() =>
            void requestInstall({
              dirSlug,
              registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
              repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
            })
          }
          onChooseRecent={(path) =>
            void requestInstall({
              dirSlug,
              projectPath: path,
              registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
              repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
            })
          }
        />
      </div>
      {/* 「保留并分享」的结果盖过普通的"已保留":它把下一步也交代了 */}
      {shareResult ? (
        <p
          className={[
            "mt-1.5 text-[11.5px]",
            "error" in shareResult ? "text-[#c0392b] dark:text-[#e0705f]" : "text-text-3",
          ].join(" ")}
        >
          {"error" in shareResult
            ? `${t("install.shareAfterKeepFailed")}${t("punct.labelSeparator")}${shareResult.error.message}`
            : shareResult.mode === "pushed"
              ? t("install.sharedAfterKeep")
              : t("install.sharedAfterKeepReview")}
        </p>
      ) : (
        localKept && (
          <p className="mt-1.5 text-[11.5px] text-text-3">{t("install.keptLocal")}</p>
        )
      )}
      {failed > 0 && (
        <div className="mt-2 rounded-card border border-border bg-surface-2 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[12px] text-[#9a6a00] dark:text-[#d9a94a]">
            <Icon icon={TriangleAlert} size={12} />
            {t("install.linkFailed", { count: failed })}
          </div>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-text-3">
            {t("install.linkFailedHint")}
          </p>
          {report?.links
            .filter((l) => l.result.status === "failed")
            .map((l) => (
              <FailedLinkRow
                key={l.dir}
                dir={l.dir}
                message={l.result.status === "failed" ? l.result.error.message : ""}
              />
            ))}
        </div>
      )}
    </div>
  );
}

/** 失败的一条关联:说明 + 就地重试。重试成功后这一行会从列表里消失。 */
function FailedLinkRow({ dir, message }: { dir: string; message: string }) {
  const retryLink = useInstall((s) => s.retryLink);
  const retryingDir = useInstall((s) => s.retryingDir);
  const retryError = useInstall((s) => s.retryError);
  const busy = retryingDir === dir;

  return (
    <div className="mt-1.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-3">
          {dir}
          {message && `${t("punct.labelSeparator")}${message}`}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void retryLink(dir)}
          className="h-6 flex-none rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
        >
          {busy ? t("install.retrying") : t("install.retryLink")}
        </button>
      </div>
      {!busy && retryError && (
        <p className="mt-1 text-[11px] text-[#c0392b] dark:text-[#e0705f]">{retryError.message}</p>
      )}
    </div>
  );
}

function ErrorFooter() {
  const { error, run, cancel } = useInstall();
  return (
    <div className="border-t border-border px-5 py-3.5">
      <p className={cn("text-[12.5px]", "text-text-2")}>{error?.message ?? t("error.generic")}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void run()}
          className="h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("install.retry")}
        </button>
        <button
          type="button"
          onClick={cancel}
          className="h-7 rounded-ctl px-2.5 text-[12px] font-medium text-text-3 hover:text-text"
        >
          {t("install.cancel")}
        </button>
      </div>
    </div>
  );
}
