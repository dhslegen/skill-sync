import { SkillIcon } from "@/components/SkillIcon";
import { t } from "@/i18n";
import { formatInstalls } from "@/lib/format";
import type { PlazaSkillCard } from "@/lib/ipc";

/**
 * 技能广场的搜索结果卡片。
 *
 * 与 {@link import("./SkillCard").SkillCard} 刻意不共用:数据形状不同
 * ——搜索结果没有 description(设计文档 §2.5 明确"不显示 description,数据里没有,
 * 不编造")、没有 dirSlug/contentHash,只有 name/来源仓/安装量。装了什么状态、
 * 是否已启用,要等点开详情、`plaza_detail` 现拉之后才知道——卡片本身不判定,
 * 与设计文档"只做发现"的定位一致,也避免了按 name 弱匹配"已装"状态的假阳性。
 */
export function PlazaCard({ card, onOpen }: { card: PlazaSkillCard; onOpen: () => void }) {
  const installsLabel = formatInstalls(card.installs);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={card.name}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex min-h-[76px] flex-col gap-1.5 rounded-card border border-border bg-surface-1 px-[14px] py-3 text-left shadow-[var(--shadow-card)] transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-border-strong focus-visible:border-accent focus-visible:outline-none"
    >
      <div className="flex items-center gap-2.5">
        <SkillIcon name={card.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold tracking-[-0.01em]">
            {card.name}
          </div>
          {/* owner/repo 是 GitHub 的外部真名,不是本 app 的内部标识——按规范等宽展示 */}
          <div className="truncate font-mono text-[11px] text-text-3">{card.ownerRepo}</div>
        </div>
      </div>
      {installsLabel && (
        <div className="mt-auto text-[11.5px] text-text-3">
          {t("plaza.installsLabel", { installs: installsLabel })}
        </div>
      )}
    </div>
  );
}
