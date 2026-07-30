import { cn } from "@/lib/cn";
import { skillGlyph, skillHue } from "@/lib/tint";

/** 技能图标:首字符 + 由名字算出的低饱和底色。全站禁 emoji,这是唯一的视觉识别手段。 */
export function SkillIcon({
  name,
  className,
}: {
  name: string;
  /** 尺寸与圆角由调用处给:卡片 32px、列表行 26px、详情 40px。 */
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "skill-tint grid shrink-0 place-items-center rounded-[8px] font-semibold",
        "size-8 text-[14px]",
        className,
      )}
      style={{ "--tint-h": skillHue(name) } as React.CSSProperties}
    >
      {skillGlyph(name)}
    </span>
  );
}
