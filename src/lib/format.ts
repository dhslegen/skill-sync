import { t } from "@/i18n";

/**
 * 相对时间。决策 C6:非研发用户只看"更新于 x 天前",不看版本号。
 * `now` 可注入以便测试。
 */
export function relativeTime(atMs: number, now: number = Date.now()): string {
  // 技能库的时间可能比本机快几秒(服务器时钟偏差是常态)。这里不夹 Math.max(0, …):
  // 负的差值会让 minutes 变负,自然落进下面 `< 1` 那一档变成"刚刚"。
  // 加了反而是一段永不触发的守卫——注入验证时改坏它测试照样通过,那种代码只会误导后来人。
  const minutes = Math.floor((now - atMs) / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("time.daysAgo", { n: days });
  const weeks = Math.floor(days / 7);
  if (days < 30) return t("time.weeksAgo", { n: weeks });
  return t("time.monthsAgo", { n: Math.floor(days / 30) });
}

/** core 给的 unix 秒。 */
export function relativeTimeFromUnix(seconds: number, now?: number): string {
  return relativeTime(seconds * 1000, now);
}

/** 技能库给的 ISO-8601 串。解析不了就返回空串,不在界面上显示 "Invalid Date"。 */
export function relativeTimeFromIso(iso: string, now?: number): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : relativeTime(ms, now);
}

/** 版本标识只以短码露出(terminology.md:不解释,仅等宽展示)。 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** 文件大小。拿不到大小(二进制文件不进内存树)时给一个占位符而不是 "0 B"。 */
export function formatBytes(size?: number): string {
  if (size === undefined) return t("detail.fileSizeUnknown");
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 卡片上的等宽 slug:`技能库/目录名`(UI 规范 §2.6 的"包管理器味")。 */
export function skillSlug(repo: string, dirSlug: string): string {
  return `${repo}/${dirSlug}`;
}
