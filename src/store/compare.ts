import { create } from "zustand";

/**
 * 详情面板里「看看哪里不同」那一块要不要一打开就展开(0.8.0 任务 3)。
 *
 * 入口在详情面板**之外**(商店卡片的「与库里不同」、「我的技能」那一行的
 * 「和库里的不一样」),它们打开详情的同时声明"这次是冲着差异来的"。
 * 按 `dirSlug` 记归属:换了技能就不展开,免得把上一个技能的意图带到下一个上。
 */
interface CompareState {
  expandedFor: string | null;
  expand: (dirSlug: string) => void;
  collapse: () => void;
}

export const useCompare = create<CompareState>((set) => ({
  expandedFor: null,
  expand: (dirSlug) => set({ expandedFor: dirSlug }),
  collapse: () => set({ expandedFor: null }),
}));
