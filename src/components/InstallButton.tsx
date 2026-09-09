import { Check } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

/** 安装状态机。判定唯一实现在 `lib/update.ts` 的 `cardState`,这里只负责画。
 *  `otherLibrary` = 同名技能已装自另一个技能库(M4 一源多仓):那不是更新,
 *  是替换,按钮文案与去向都不同。
 *
 *  ⚠️ **v7.4 起 `mine*` 四档已删除**(用户第 9 轮拷问拍板撤掉商店卡片的
 *  作者四档:「取回」一词背三种意思、「已同步」回答的是没人问的问题,商店
 *  只该回答"我有没有 / 我要不要"这一件事)。库里有新版时(不论是不是自己
 *  分享的、不论本地改没改)一律落进 `update`,点下去交给 core 的
 *  `acquire::precheck` 去判"这是不是我分享的"、要不要弹 `Mine` 变体的冲突框
 *  ——那份折叠机制原样留在 `core/acquire.rs`,这里删掉的只是曾经借按钮文案
 *  抢答的四个展示分支,不是背后的安全判定。 */
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

  const terminal = state === "installed";

  // 置灰的主按钮不能只是"半透明的实心强调色":深色主题下它看着还是个能点的主按钮,
  // 用户会反复去点。降级成 ghost 灰,一眼就知道现在不可用。
  const inert = disabled && !terminal;

  return (
    <button
      type="button"
      title={hint}
      aria-label={hint ? `${label} — ${hint}` : label}
      // 已启用是终态,不接受点击;其余状态由调用方决定
      disabled={disabled || terminal}
      onClick={onClick}
      className={cn(
        // 宽度给下限:状态切换时按钮不该变宽变窄让整行跳动(UI 规范 §3 动效)
        "inline-flex min-w-[52px] items-center justify-center gap-[5px] rounded-ctl",
        "border border-transparent text-[12px] font-[550] transition-colors duration-150",
        size === "lg" ? "h-[30px] px-[14px] text-[12.5px]" : "h-6 px-[10px]",
        // 🔴 v7.3 需求 5 的全站规则(Q21-A 定稿的措辞):
        //   **实心 = 这一栏里的例外;chip = 这一栏里人人都有的那个动作。**
        //   (不枚举具体档位——枚举一加档就对不上,这正是 Q21-A 要消灭的形态。)
        // 商店卡片是这条规则点名要复查的
        // 第一处:满屏卡片人人都有「获取」,此前它是实心橙,于是整页实心橙,
        // 真正的例外(「有更新」「取回」「分享更新」)反而比常态还弱一档
        // ——形态与"哪件事更要紧"恰好是反的。现在**倒过来**:
        // 「获取」= 常态 → 浅橙 chip;其余几档都是例外 → 实心。
        // ✅ 这个"倒置"已由 Q22-A 拍板接受(共识第 6 轮),不再是存疑点;
        //   主 CTA 降级的风险已如实告知,待真机扫一眼确认。
        !inert && state === "install" && "bg-accent-soft text-accent hover:opacity-80",
        !inert && state === "update" && "bg-accent text-white hover:bg-accent-hover",
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
