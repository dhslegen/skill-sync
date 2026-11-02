import { useEffect, useState } from "react";

import { CompareView } from "@/components/CompareView";
import { t } from "@/i18n";
import { isAppError } from "@/lib/ipc";
import { useCompare } from "@/store/compare";
import { useInstall } from "@/store/install";

/**
 * 详情面板里的「看看哪里不同」(0.8.0 任务 3)。两条渲染路径(商店详情 /
 * 「我的技能」详情)共用,摆不摆由宿主按各自的判定决定后传进来——这里不重新判。
 *
 * 默认收起:正文才是详情的主角(v7.1 Q1A)。从卡片的「与库里不同」或「我的技能」
 * 那一行点进来时,入口先 `useCompare.expand(dirSlug)`,这里据此展开;用户自己
 * 收起时清掉意图(为什么不在挂载时清,见 `toggle` 上的注释)。
 *
 * 展开后就地拍板:「换成库里的版本」直接带 overwrite 跑(用户刚看完差异,不再弹
 * 一次冲突框问同一件事);「收起差异」= 先不动。「保留我的版本」见任务 4。
 * 换的进度与失败由宿主既有的渲染点负责(商店侧 `InstallPanel`、「我的技能」侧
 * `LocalPanelBody` 的 pullError),都按 dirSlug 校验归属;这里只在进行中把按钮置灰。
 */
export function CompareSection({
  dirSlug,
  registryId,
  repo,
  onReplace,
  keepMine,
  kept = false,
}: {
  dirSlug: string;
  registryId?: string;
  repo?: string;
  onReplace: () => void;
  /**
   * 「保留我的版本」(0.8.0 任务 4)。宿主按"是不是作者"给两种之一:作者 → 进分享流程
   * (`share`,标签「保留并分享我的版本」);其他人 → 记住对库里这一版已保留(`remember`)。
   * `run` 失败要抛出来,这一块自己渲染——它是点按钮那一处唯一看得见的地方。
   */
  keepMine: { kind: "share" | "remember"; run: () => Promise<void> };
  /** 对库里这一版已经选过保留:摘要换成安静的一句,「保留」那颗不再摆。 */
  kept?: boolean;
}) {
  const intended = useCompare((s) => s.expandedFor === dirSlug);
  const [toggled, setToggled] = useState<boolean | null>(null);
  // 用户自己点过就以用户为准;没点过就看入口有没有声明"冲着差异来的"
  const open = toggled ?? intended;
  const busy = useInstall((s) => s.phase === "running" && s.dirSlug === dirSlug);
  const [keeping, setKeeping] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);
  const onKeep = () => {
    setKeeping(true);
    setKeepError(null);
    keepMine
      .run()
      .then(() => {
        // 记住了就收起(作者那一档交给分享确认屏,这里同样收起让位)
        setToggled(false);
        useCompare.getState().collapse();
      })
      .catch((raw: unknown) =>
        setKeepError(isAppError(raw) ? raw.message : t("error.generic")),
      )
      .finally(() => setKeeping(false));
  };

  useEffect(() => {
    // 换技能:用户在上一个技能上的开合不带过来
    setToggled(null);
  }, [dirSlug]);

  // 🔴 **意图不在挂载时消费**(截图 harness 当场抓到):商店详情加载期间,本机技能
  // 列表会重读一次,判定短暂离开「与库里不同」这一档,这一块随之卸载又重挂——
  // 挂载即清空的话,第二次挂上来时意图已经没了,从卡片点进来看到的是收起的。
  // jsdom 里没有这种来回挂载,单测测不出来。现在只在用户**自己收起**时清掉。
  const toggle = () => {
    const next = !open;
    setToggled(next);
    if (!next) useCompare.getState().collapse();
  };

  return (
    <div className="mx-5 mt-3 rounded-card border border-border px-3 py-2.5" data-testid="compare-section">
      <div className="flex flex-wrap items-center gap-2">
        {kept ? (
          <span className="text-[12px] text-text-3">{t("compare.keptSummary")}</span>
        ) : (
          <span className="text-[12px] text-[#9a6c00] dark:text-[#d4a017]">{t("compare.summary")}</span>
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="text-[12px] font-medium text-accent underline-offset-2 hover:underline"
        >
          {open ? t("compare.toggleClose") : t("compare.toggle")}
        </button>
      </div>
      {open && (
        <>
          <CompareView key={`${dirSlug}:${registryId ?? ""}:${repo ?? ""}`} dirSlug={dirSlug} registryId={registryId} repo={repo} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!kept && (
              <button
                type="button"
                disabled={keeping || busy}
                onClick={onKeep}
                title={keepMine.kind === "share" ? t("compare.shareMineHint") : t("compare.keepMineHint")}
                className="h-7 rounded-ctl border border-accent bg-accent-soft px-3 text-[12px] font-medium text-accent hover:opacity-80 disabled:cursor-default disabled:opacity-50"
              >
                {keepMine.kind === "share" ? t("compare.shareMine") : t("compare.keepMine")}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={onReplace}
              title={t("compare.useLibraryHint")}
              className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text disabled:cursor-default disabled:opacity-50"
            >
              {t("compare.useLibrary")}
            </button>
          </div>
          <p className="mt-1.5 text-[11.5px] leading-[1.6] text-text-3">
            {!kept && (keepMine.kind === "share" ? t("compare.shareMineHint") : t("compare.keepMineHint"))}
            {!kept && " "}
            {t("compare.useLibraryHint")}
          </p>
          {keepError && (
            <p className="mt-1 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
              {t("compare.keepFailed")}
              {t("punct.labelSeparator")}
              {keepError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
