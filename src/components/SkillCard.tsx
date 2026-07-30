import { TriangleAlert } from "lucide-react";

import { Icon } from "@/components/Icon";
import { InstallButton, type InstallState } from "@/components/InstallButton";
import { SkillIcon } from "@/components/SkillIcon";
import { t } from "@/i18n";
import { skillSlug } from "@/lib/format";
import type { StoreSkillCard } from "@/lib/ipc";

/**
 * 商店卡片。信息密度对齐 docs/SkillSync-UI-Demo.html:
 * 32px 图标 + 名称 + 等宽 slug + 两行描述 + 底部一行元信息与按钮,最小高度 106px。
 *
 * 容器是 `div[role=button]` 而不是 `<button>`:里面还有一个安装按钮,
 * button 套 button 是非法 HTML(浏览器会把内层拆出去,点击行为随之失控)。
 */
export function SkillCard({
  skill,
  repo,
  updatedAt,
  state,
  onOpen,
}: {
  skill: StoreSkillCard;
  repo: string;
  /** 相对时间文案。C6:取技能库整体的更新时间,不逐技能归因(见 core/store.rs 的假设) */
  updatedAt: string;
  state: InstallState;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={skill.name}
      onClick={onOpen}
      onKeyDown={(e) => {
        // 键盘优先(UI 规范 §6.4):列表里 Enter/Space 等同点开详情
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex min-h-[106px] flex-col gap-1.5 rounded-card border border-border bg-surface-1 px-[14px] py-3 text-left shadow-[var(--shadow-card)] transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-border-strong focus-visible:border-accent focus-visible:outline-none"
    >
      <div className="flex items-center gap-2.5">
        <SkillIcon name={skill.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13.5px] font-semibold tracking-[-0.01em]">
            <span className="truncate">{skill.name}</span>
            {skill.hasScripts && (
              <span
                title={t("skill.hasScriptsHint")}
                className="text-[#9a6a00] dark:text-[#d9a94a]"
              >
                <Icon icon={TriangleAlert} size={12} />
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-text-3">
            {skillSlug(repo, skill.dirSlug)}
          </div>
        </div>
      </div>

      <p className="clamp-2 h-[38px] text-[12.5px] leading-[1.5] text-text-2">
        {skill.description}
      </p>

      <div className="mt-auto flex items-center gap-2 text-[11.5px] text-text-3">
        <span>{t("store.updatedAt", { when: updatedAt })}</span>
        <div className="ml-auto">
          <InstallButton state={state} disabled hint={t("skill.installNotReady")} />
        </div>
      </div>
    </div>
  );
}
