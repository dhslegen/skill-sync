import { create } from "zustand";

import type { InstalledSkillView } from "@/lib/ipc";

// 「我的技能」页头搜索框的查询词(v7 任务 4;design 根决策 #16「页头:搜索框
// (商店同款)」)。
//
// **单独一个 store,不塞进 `store-index.ts`**:那份 store 管的是「商店」页的
// 技能索引(联网、按当前浏览的技能库分页),与"我的技能"页要过滤的
// `InstalledSkillView[]`(本地已获取列表,零网络)是完全不同的数据源。
// 与 `usePlaza` 那份独立的搜索状态(`Toolbar.tsx` 已经在按 `page`/`registryId`
// 切换喂哪份 query/setQuery 给同一个 `SearchBox` 单例)同一个先例——任务 7
// 会照这个样子在 `Toolbar` 里再加一档 `page === "mine"` 分支。
//
// **纯本地过滤,不带 `submitSearch`**:与商店"公司技能库"那一档同款
// (`store-index.ts` 的 `query`),不是广场那一档(需要发跨外网请求、
// 靠回车显式触发)——输入即搜,不需要提交动作。
interface MineSearchState {
  query: string;
  setQuery: (query: string) => void;
}

export const useMineSearch = create<MineSearchState>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
}));

/**
 * 「我的技能」搜索的子串匹配。
 *
 * 🔴 **只匹配 `dirSlug` 与 `sourceLabel`,不匹配"名字"/"描述"**——这两样与商店
 * 卡片(`StoreSkillCard`)不同,`InstalledSkillView` 这份 DTO 里根本没有它们
 * (它是"这台电脑上有什么"的记账视图,不是"这个技能长什么样"的展示视图)。
 * `MySkillsPage.tsx` 今天靠额外查一次 `useStoreIndex` 的索引把 `dirSlug` 换成
 * 展示名(`nameOf`),但那份索引只覆盖"当前浏览的那个技能库",覆盖不了「我的
 * 技能」列表里可能来自多个不同来源的行——拿它做搜索的匹配依据,会让搜索结果
 * 随"商店页最后开着哪个库"变来变去,是一个会漂的判据。`dirSlug` 是这份 DTO
 * 里唯一保证存在、且对用户有辨识度的字符串(公司技能库全是 ASCII kebab-case,
 * 就是调用名本身,见 `CLAUDE.md`"命名与目录"一节)。
 */
export function matchesMineQuery(
  skill: Pick<InstalledSkillView, "dirSlug" | "sourceLabel">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (skill.dirSlug.toLowerCase().includes(q)) return true;
  return skill.sourceLabel?.toLowerCase().includes(q) ?? false;
}
