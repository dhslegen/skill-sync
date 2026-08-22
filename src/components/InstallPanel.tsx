import { useEffect } from "react";
import { Check, TriangleAlert } from "lucide-react";

import { Icon } from "@/components/Icon";
import { InstallButton } from "@/components/InstallButton";
import { InstallScopeMenu } from "@/components/InstallScopeMenu";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { PLAZA_REGISTRY_ID, type InstallStage } from "@/lib/ipc";
import { cardState, remoteHashOf, type LibraryRef } from "@/lib/update";
import { agentsDetected } from "@/lib/ipc";
import { defaultSelectedAgents, failedLinks, linkedAgents, useInstall } from "@/store/install";
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

  if (!mine || phase === "idle") {
    return (
      <IdleFooter
        dirSlug={dirSlug}
        plaza={plaza}
        activeRegistryId={activeRegistry}
        activeRepoKey={activeRepo}
        onBegin={() =>
          plaza
            ? void beginFromPlaza(plaza.ownerRepo, dirSlug)
            : void begin(dirSlug, activeRegistry, activeRepo)
        }
      />
    );
  }
  if (phase === "choosing") return <AgentChooser onCancel={cancel} />;
  if (phase === "running") return <Running />;
  if (phase === "done") return <DoneFooter />;
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

  const installToProject = useProjects((s) => s.install);
  const requestInstall = useProjects((s) => s.requestInstall);
  const confirm = useProjects((s) => s.confirm);
  const dismissProjectNotice = useProjects((s) => s.dismissNotice);
  const cancelConfirm = useProjects((s) => s.cancelConfirm);

  // 换一个技能看详情时,把上一次的提示与待确认收干净。
  // 🔴 不清的话,提示说的是**另一个技能**的事(dismissNotice 此前定义了却一处没调用),
  // 待确认条更糟——点「装到这里」装的是上一个技能。
  useEffect(() => {
    dismissProjectNotice();
    cancelConfirm();
  }, [dirSlug, dismissProjectNotice, cancelConfirm]);
  const installing = useProjects((s) => s.installing);
  const projectNotice = useProjects((s) => s.notice);

  // 装到项目沿用全局默认 agent(2026-08-20 拍板:不再单独问一次)。
  // 口径与全局安装共用 `defaultSelectedAgents`,不另写一份。
  const runProjectInstall = async (projectPath: string) => {
    const detected = await agentsDetected();
    await installToProject({
      projectPath,
      dirSlug,
      agentIds: defaultSelectedAgents(detected.agents),
      registryId: plaza ? PLAZA_REGISTRY_ID : (activeRegistryId ?? undefined),
      repo: plaza ? plaza.ownerRepo : (activeRepoKey ?? undefined),
    });
  };

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
          onChooseRecent={(path) => void runProjectInstall(path)}
        />
        {record?.localModified && (
          <span className="text-[11.5px] text-text-3">{t("conflict.modifiedTitle")}</span>
        )}
      </div>
      {installing && (
        <p className="mt-2 text-[11.5px] text-text-3">
          {t("install.installingToProject", { project: folderNameOf(installing.projectPath) })}
        </p>
      )}
      {!installing && projectNotice && (
        <p className="mt-2 text-[11.5px] text-text-2">{projectNotice}</p>
      )}
      {confirm && <ConfirmBar />}
    </div>
  );
}

/** 路径末段。界面不拿完整路径当标题(太长),完整路径挂在 title 上。 */
function folderNameOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
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
          {/* 已经装过就不摆「装到这里」——摆一个点了也白点的按钮就是耍用户
              (M6「绑不上就不摆」同款)。要更新去「我的技能」的项目分区。 */}
          {!confirm.alreadyInstalled && (
            <button
              type="button"
              onClick={() => void confirmInstall()}
              className="h-7 rounded-ctl bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover"
            >
              {t("install.confirmGo")}
            </button>
          )}
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

function DoneFooter() {
  const { report, localKept, shareResult, agents: detected } = useInstall();
  const failed = failedLinks(report);
  const agents = linkedAgents(report, detected);

  return (
    <div className="border-t border-border px-5 py-3.5">
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-ok">
        <Icon icon={Check} size={14} />
        {agents.length > 0
          ? t("install.done", { agents: agents.join(t("punct.listSeparator")) })
          : t("install.doneCanonicalOnly")}
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
