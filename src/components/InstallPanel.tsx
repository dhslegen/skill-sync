import { Check, TriangleAlert } from "lucide-react";

import { Icon } from "@/components/Icon";
import { InstallButton } from "@/components/InstallButton";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { PLAZA_REGISTRY_ID, type InstallStage } from "@/lib/ipc";
import { cardState, remoteHashOf, type LibraryRef } from "@/lib/update";
import { failedLinks, linkedAgents, useInstall } from "@/store/install";
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
}: {
  dirSlug: string;
  plaza?: { ownerRepo: string };
  onBegin: () => void;
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

  return (
    <div className="flex items-center gap-2.5 border-t border-border px-5 py-3.5">
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
      {record?.localModified && (
        <span className="text-[11.5px] text-text-3">{t("conflict.modifiedTitle")}</span>
      )}
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
