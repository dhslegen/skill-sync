import { Check } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

/** 安装状态机。判定唯一实现在 `lib/update.ts` 的 `cardState`,这里只负责画。
 *  `otherLibrary` = 同名技能已装自另一个技能库(M4 一源多仓):那不是更新,
 *  是替换,按钮文案与去向都不同。`mine*` 四档(v6)= 技能库里记的分享者是我,
 *  文案借用「我的技能」页已有的「取回/分享更新/已同步」,不再另造一套词。 */
export type InstallState =
  | "install"
  | "installed"
  | "update"
  | "otherLibrary"
  | "mineSynced"
  | "minePull"
  | "mineShareUpdate"
  | "mineBoth";

/**
 * 安装按钮。
 *
 * **本任务里它不执行安装**:获取流程是下一个任务,而 `Installer::install` 目前仍会
 * 无条件清空重建 canonical 目录(CLAUDE.md「已知待处理」),把它接上等于给用户
 * 一个会静默抹掉本地改动的按钮。所以这里点击只负责打开详情面板,让用户先看清内容。
 * 详情面板底部那个按钮则明确置灰并给出说明。
 */
export function InstallButton({
  state,
  onClick,
  disabled = false,
  hint,
  size = "sm",
}: {
  state: InstallState;
  onClick?: () => void;
  disabled?: boolean;
  /** 置灰时的说明,同时作为可访问名的补充。 */
  hint?: string;
  size?: "sm" | "lg";
}) {
  const label =
    state === "installed"
      ? t("skill.actionInstalled")
      : state === "update"
        ? t("skill.actionUpdate")
        : state === "otherLibrary"
          ? t("skill.actionReplace")
          : state === "mineSynced"
            ? t("mine.stateSynced")
            : // `mineBoth` 用「取回」而不是「分享更新」:与「我的技能」页
              // `both`/`remoteAhead`/`notHere` 三档共用一颗按钮同一个理由
              // (`store/my-skills.ts` 的 `pull` doc)——点下去交给调用方的
              // `onClick`(这颗按钮在 `InstallPanel` 里走的是 `begin`/
              // `beginFromPlaza`,不是 `beginUpdate`;`beginUpdate` 是「我的
              // 技能」页那颗按钮走的路,这里只是借它的理由,不是同一个函数),
              // core 的 precheck 自然会把"本地也改过"折进 `ConflictDialog`,
              // 不需要按钮文案越俎代庖先说一遍。
              state === "minePull" || state === "mineBoth"
              ? t("mine.pull")
              : state === "mineShareUpdate"
                ? t("mine.shareUpdate")
                : t("skill.actionInstall");

  const terminal = state === "installed" || state === "mineSynced";

  // 置灰的主按钮不能只是"半透明的实心强调色":深色主题下它看着还是个能点的主按钮,
  // 用户会反复去点。降级成 ghost 灰,一眼就知道现在不可用。
  const inert = disabled && !terminal;

  return (
    <button
      type="button"
      title={hint}
      aria-label={hint ? `${label} — ${hint}` : label}
      // 已启用/已同步是终态,不接受点击;其余状态由调用方决定
      disabled={disabled || terminal}
      onClick={onClick}
      className={cn(
        // 宽度给下限:状态切换时按钮不该变宽变窄让整行跳动(UI 规范 §3 动效)
        "inline-flex min-w-[52px] items-center justify-center gap-[5px] rounded-ctl",
        "border border-transparent text-[12px] font-[550] transition-colors duration-150",
        size === "lg" ? "h-[30px] px-[14px] text-[12.5px]" : "h-6 px-[10px]",
        !inert && (state === "install" || state === "minePull") && "bg-accent text-white hover:bg-accent-hover",
        !inert &&
          (state === "update" || state === "mineShareUpdate" || state === "mineBoth") &&
          "bg-accent-soft text-accent",
        // 替换不是常规动作:给中性描边,不用强调色去引诱点击
        !inert && state === "otherLibrary" && "border-border bg-transparent text-text-2 hover:border-border-strong hover:text-text",
        terminal && "bg-transparent font-medium text-ok",
        inert && "cursor-default border-border bg-transparent font-medium text-text-3",
      )}
    >
      {terminal && <Icon icon={Check} size={13} />}
      {label}
    </button>
  );
}
