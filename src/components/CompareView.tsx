import { useCallback, useEffect, useRef, useState } from "react";

import { SharePlanList } from "@/components/SharePlanList";
import { t } from "@/i18n";
import { isAppError, skillCompareLibrary, type AppError, type Comparison } from "@/lib/ipc";

/**
 * 「与库里不同」到底哪里不同(0.8.0 任务 3)——四处入口共用的唯一实现:
 * 详情面板里的「看看哪里不同」与冲突弹窗都嵌它。
 *
 * 清单的渲染与就地展开**整个复用** `SharePlanList`(`mode="compare"`):分享确认屏
 * 已经把「点文件名就地看差异 / 看全文 / 看库里那一版」做完了,这里再写一份就是
 * 两处"同一份清单、两种看法"。
 *
 * 🔴 读本地文件用 core 回来的 `localPath`(本体的绝对路径),**不用 dirSlug**
 * ——无记账时 dirSlug 会落回统一目录,而本体常常住在 Claude Code 的目录里
 * (v8 定向复审 I-1:测试曾把错误的形状钉成正确)。
 *
 * 每次挂载都现比一次,不缓存:本地内容随时在变,比对的是**此刻**的磁盘。
 * 调用方按「哪个技能 × 哪个库」给 `key`,换了就重挂,旧结果不会留在屏上。
 */
export function CompareView({
  dirSlug,
  registryId,
  repo,
}: {
  dirSlug: string;
  registryId?: string;
  repo?: string;
}) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; error: AppError } | { kind: "done"; result: Comparison }
  >({ kind: "loading" });

  const load = useCallback(() => {
    let alive = true;
    setState({ kind: "loading" });
    skillCompareLibrary({ dirSlug, registryId, repo })
      .then((result) => {
        if (!alive) return;
        // 形状不对(契约漂移、mock 漏配)按失败说出来:这个组件嵌在冲突弹窗里,
        // 渲染期一个 `undefined.identical` 就会把整棵界面树卸掉,比"比对失败"糟得多
        if (!result || !result.plan) {
          setState({ kind: "error", error: { code: "IPC_FAILED", message: t("error.generic") } });
          return;
        }
        setState({ kind: "done", result });
      })
      .catch(
        (raw: unknown) =>
          alive &&
          setState({
            kind: "error",
            error: isAppError(raw) ? raw : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) },
          }),
      );
    return () => {
      alive = false;
    };
  }, [dirSlug, registryId, repo]);

  // 重试也要能取消(终审 M-8):把最近一次请求的取消函数留着,卸载时一并调用
  const cancelRef = useRef<(() => void) | null>(null);
  const run = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = load();
  }, [load]);
  useEffect(() => {
    run();
    return () => cancelRef.current?.();
  }, [run]);

  if (state.kind === "loading") {
    return <p className="mt-2 text-[12px] text-text-3">{t("compare.loading")}</p>;
  }
  if (state.kind === "error") {
    return (
      <div className="mt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
        {t("compare.failed")}
        {t("punct.labelSeparator")}
        {state.error.message}
        <button
          type="button"
          onClick={run}
          className="ml-2 font-medium text-accent underline-offset-2 hover:underline"
        >
          {t("compare.retry")}
        </button>
      </div>
    );
  }
  if (state.result.identical) {
    return <p className="mt-2 text-[12px] text-text-2">{t("compare.identical")}</p>;
  }
  return (
    <SharePlanList
      key={`${dirSlug}:${state.result.remoteHash}`}
      plan={state.result.plan}
      localTarget={{ path: state.result.localPath }}
      mode="compare"
    />
  );
}
