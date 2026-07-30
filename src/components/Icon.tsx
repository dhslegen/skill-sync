import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

/**
 * 图标统一入口。UI 规范 §2.2:图标一律 Lucide、stroke-width **1.5**(不是默认的 2)。
 * 把这条规则收在一个组件里,免得几十处调用逐个记着传。
 */
export function Icon({
  icon: Glyph,
  size = 15,
  className,
}: {
  icon: LucideIcon;
  size?: number;
  className?: string;
}) {
  return (
    <Glyph size={size} strokeWidth={1.5} aria-hidden className={cn("shrink-0", className)} />
  );
}
