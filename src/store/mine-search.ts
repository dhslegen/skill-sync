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
 * 🔴 **v7 任务 7 订正**:任务 4 当时的判断("只匹配 dirSlug/sourceLabel,不匹配
 * 名字")留了一个真实缺陷——页面每行显示的是**展示名**
 * (`nameOf(skill.dirSlug)`,公司库技能显示成「接口脚本生成」这类中文名),
 * 而搜索只匹配 `dirSlug`,用户搜他在屏幕上看得见的那串字,一条都搜不到。
 * `InstalledSkillView` 这份 DTO 本身确实没有展示名字段(它是"这台电脑上有什么"
 * 的记账视图,不是"这个技能长什么样"的展示视图)这条观察没有错;错在解法
 * ——不该"不匹配",该"调用方把它已经解析好的展示名传进来"。
 *
 * 🔴 **`displayName` 是必填参数,不是可选**:写成必填,忘了接这条搜索就过不了
 * `tsc`,而不是留一句注释指望"调用方记得传"——本项目的既有教训是"约定会被
 * 下一个人无声打破,类型不会"。调用方(`MySkillsPage.tsx`)按与既有 `nameOf`
 * 相同的口径解析(`useStoreIndex().index` 查得到就用展示名,查不到退回
 * `dirSlug` 本身——那份索引只覆盖"当前浏览的那个技能库"这条既有局限没有变,
 * 只是不再让搜索完全放弃这个字段)。`sourceLabel` 仍然匹配,不撤销。
 */
export function matchesMineQuery(
  skill: Pick<InstalledSkillView, "dirSlug" | "sourceLabel">,
  displayName: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (displayName.toLowerCase().includes(q)) return true;
  if (skill.dirSlug.toLowerCase().includes(q)) return true;
  return skill.sourceLabel?.toLowerCase().includes(q) ?? false;
}
