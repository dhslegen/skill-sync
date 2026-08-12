import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatInstalls,
  relativeTime,
  relativeTimeFromIso,
  shortSha,
  skillSlug,
} from "./format";

const NOW = Date.parse("2026-07-30T12:00:00Z");
const ago = (ms: number) => NOW - ms;

describe("relativeTime", () => {
  it("按分/时/天/周/月分档", () => {
    expect(relativeTime(ago(5_000), NOW)).toBe("刚刚");
    expect(relativeTime(ago(3 * 60_000), NOW)).toBe("3 分钟前");
    expect(relativeTime(ago(5 * 3_600_000), NOW)).toBe("5 小时前");
    expect(relativeTime(ago(3 * 86_400_000), NOW)).toBe("3 天前");
    expect(relativeTime(ago(10 * 86_400_000), NOW)).toBe("1 周前");
    expect(relativeTime(ago(60 * 86_400_000), NOW)).toBe("2 个月前");
  });

  it("档位边界不跳错档", () => {
    expect(relativeTime(ago(59_999), NOW)).toBe("刚刚");
    expect(relativeTime(ago(60_000), NOW)).toBe("1 分钟前");
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe("59 分钟前");
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe("1 小时前");
    expect(relativeTime(ago(23 * 3_600_000), NOW)).toBe("23 小时前");
    expect(relativeTime(ago(24 * 3_600_000), NOW)).toBe("1 天前");
    expect(relativeTime(ago(6 * 86_400_000), NOW)).toBe("6 天前");
    expect(relativeTime(ago(7 * 86_400_000), NOW)).toBe("1 周前");
  });

  it("时钟偏差导致的未来时间不显示负数", () => {
    // 服务器时间比本机快几秒是常态,界面上不该出现 "-1 分钟前"
    expect(relativeTime(NOW + 30_000, NOW)).toBe("刚刚");
  });

  it("解析不了的时间串给空串,而不是 Invalid Date", () => {
    expect(relativeTimeFromIso("", NOW)).toBe("");
    expect(relativeTimeFromIso("前天下午", NOW)).toBe("");
    expect(relativeTimeFromIso("2026-07-27T12:00:00Z", NOW)).toBe("3 天前");
  });
});

describe("展示格式", () => {
  it("版本标识只露 7 位短码", () => {
    expect(shortSha("a1b2c3d4e5f6a7b8c9d0")).toBe("a1b2c3d");
    // 已经很短就原样返回,不补位
    expect(shortSha("abc")).toBe("abc");
  });

  it("拿不到文件大小时给占位符而不是 0 B", () => {
    // 二进制文件不进内存树(core 侧的既定行为),size 缺失是正常情况
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4300)).toBe("4.2 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("slug 是 技能库/目录名", () => {
    expect(skillSlug("skills", "weekly-report")).toBe("skills/weekly-report");
  });

  it("安装量中文紧凑展示(技能广场,M9 任务 5)", () => {
    // 边界表:0/负数不显示;万以下原样;万以上保留一位小数
    expect(formatInstalls(0)).toBe("");
    expect(formatInstalls(-5)).toBe("");
    expect(formatInstalls(999)).toBe("999");
    expect(formatInstalls(1000)).toBe("1000");
    expect(formatInstalls(5649)).toBe("5649");
    expect(formatInstalls(625414)).toBe("62.5万");
    expect(formatInstalls(1234567)).toBe("123.5万");
  });
});
