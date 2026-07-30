import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 条件类名 + 冲突去重。同 shadcn/ui 的 cn 工具。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
