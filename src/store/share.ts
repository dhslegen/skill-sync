// 分享目标库与「会走哪条路」的预告(v6 二期任务 7 收缩到只剩这件事)。
//
// # 这个 store 现在只剩两个字段,原委值得记
//
// 它原本是**分享页**的状态机(候选扫描 + 名称/描述/文件夹名表单 + 同名被占三选一
// + 提交)。三件事把它掏空了:
//
// 1. **分享页整页撤销**(任务 6):首次分享的入口收进「我的技能」那一行,
//    `share_candidates` 这条 IPC 一并删除;
// 2. **分享零编辑**(v6 二期 A-1):名称、描述、文件夹名全部只读——分享就是分享,
//    补齐 frontmatter 也是改,一并取消。表单因此退化成一块确认屏;
// 3. **分享的编排搬进 `store/my-skills.ts`**(任务 7):`beginShare`/`confirmShare`
//    与那一行的状态长在一起,不再需要一个独立的流程状态机。
//
// 剩下的两件事之所以留在这里而不并进 `my-skills.ts`:**路径预告是「仓库级」的**
// (取决于你对那个技能库有没有写权限、目标分支保不保护),一个目标库探一次就够,
// 不该跟着"当前在看哪个技能"走。
import { create } from "zustand";

import { sharePreview, type SharePath } from "@/lib/ipc";

interface ShareState {
  /** 分享目标库(M4):寻址键 `owner/repo`,null = 该源主库。 */
  targetRepo: string | null;
  /**
   * 目标库的路径预告。**它只是提示**:提交时刻的权限判定才是权威,
   * 预检失败绝不拦分享(所以 `refreshPreview` 永不抛错,探不到就是 `unknown`,
   * 界面对 `unknown` 整条不显示——不假装知道)。
   */
  preview: SharePath;

  /** 切换分享目标库并重探路径。 */
  setTargetRepo: (repo: string | null) => Promise<void>;
  /** 探一次目标库的分享路径。**永不抛错**。 */
  refreshPreview: () => Promise<void>;
}

export const useShare = create<ShareState>((set, get) => ({
  targetRepo: null,
  preview: "unknown",

  refreshPreview: async () => {
    const repo = get().targetRepo;
    try {
      const preview = await sharePreview(repo ? { repo } : {});
      // 等待期间用户可能又切了库:迟到的结果不能冒充当前库
      if (get().targetRepo === repo) set({ preview });
    } catch {
      // 预告只是提示,失败连错误都不亮——确认屏照常可提交
      if (get().targetRepo === repo) set({ preview: "unknown" });
    }
  },

  setTargetRepo: async (repo) => {
    if (get().targetRepo === repo) return;
    // 立刻清掉上一个库的预告:挂着旧库的路径却标着新库,等于对用户撒谎
    set({ targetRepo: repo, preview: "unknown" });
    await get().refreshPreview();
  },
}));
