import { Check } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

/** 安装状态机。判定唯一实现在 `lib/update.ts` 的 `cardState`,这里只负责画。
 *  `otherLibrary` = 同名技能已装自另一个技能库(M4 一源多仓):那不是更新,
 *  是替换,按钮文案与去向都不同。 */
export type InstallState = "install" | "installed" | "update" | "otherLibrary";

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
          : t("skill.actionInstall");

  // 置灰的主按钮不能只是"半透明的实心强调色":深色主题下它看着还是个能点的主按钮,
  // 用户会反复去点。降级成 ghost 灰,一眼就知道现在不可用。
  const inert = disabled && state !== "installed";

  return (
    <button
      type="button"
      title={hint}
      aria-label={hint ? `${label} — ${hint}` : label}
      // 已启用是终态,不接受点击;其余状态由调用方决定
      disabled={disabled || state === "installed"}
      onClick={onClick}
      className={cn(
        // 宽度给下限:状态切换时按钮不该变宽变窄让整行跳动(UI 规范 §3 动效)
        "inline-flex min-w-[52px] items-center justify-center gap-[5px] rounded-ctl",
        "border border-transparent text-[12px] font-[550] transition-colors duration-150",
        size === "lg" ? "h-[30px] px-[14px] text-[12.5px]" : "h-6 px-[10px]",
        !inert && state === "install" && "bg-accent text-white hover:bg-accent-hover",
        !inert && state === "update" && "bg-accent-soft text-accent",
        // 替换不是常规动作:给中性描边,不用强调色去引诱点击
        !inert && state === "otherLibrary" && "border-border bg-transparent text-text-2 hover:border-border-strong hover:text-text",
        state === "installed" && "bg-transparent font-medium text-ok",
        inert && "cursor-default border-border bg-transparent font-medium text-text-3",
      )}
    >
      {state === "installed" && <Icon icon={Check} size={13} />}
      {label}
    </button>
  );
}
