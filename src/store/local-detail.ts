// 本地技能详情面板的状态:「我的技能」与分享页共用。
// 与商店详情(store-index 里的 detailSlug/detail)是两个独立数据源:
// 已装技能可能来源已移除或是 npx skills 装的,商店索引里根本没有它。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  isAppError,
  skillLocalDetail,
  storeSkillDetail,
  type AppError,
  type LocalSkillDetail,
  type LocalSkillTarget,
} from "@/lib/ipc";

interface LocalDetailState {
  /** null = 面板关闭。 */
  target: LocalSkillTarget | null;
  detail: LocalSkillDetail | null;
  error: AppError | null;

  open: (target: LocalSkillTarget) => Promise<void>;
  /**
   * 「我的技能」里**本地没有本体**的行(换电脑/数据丢之后,`localPresent === false`、`body` 为空)
   * 打开详情:内容从技能库**索引缓存**取(`store_skill_detail`,不联网),面板其余部分
   * ——「在哪」各块、页脚的「取回」——照旧走「我的技能」这条路。
   *
   * 🔴 2026-09-14 真机:此前这类行也走 `open({ dirSlug })`,core 去读 canonical/<slug>,
   * 那个文件夹根本不存在,面板只剩一句「这个文件夹不是技能」,连「取回」都没有。
   * 坐标必须带行上**账面的库坐标**(core 对这一档恒填公司库),缺省会落到商店页当前选中的库。
   */
  openFromLibrary: (args: { dirSlug: string; registryId: string; repo: string }) => Promise<void>;
  close: () => void;
}

// 🔴 v7.1 任务 3(Q3):这里原先还有 `reveal()` 与 `revealError`
// ——「打开文件夹」这个动作在详情面板里此前有两个入口(「这台电脑上」块里一颗、
// 面板底部一颗「在访达中打开」),Q3 拍板只留页脚那一处,而页脚走的是
// `SkillActionsBlock` 自己的 `skill_reveal`(传本体绝对路径,不是 target)。
// 这两个成员因此零生产调用方,只剩测试在养着——本项目的教训是"测试养着的死代码
// 会兜住本该打红的注入信号",所以连同它们的用例一起删掉。

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

export const useLocalDetail = create<LocalDetailState>((set, get) => ({
  target: null,
  detail: null,
  error: null,

  open: async (target) => {
    set({ target, detail: null, error: null });
    try {
      const detail = await skillLocalDetail(target);
      // 等待期间面板被关掉/换了目标,迟到的结果不能顶掉现状
      if (get().target === target) set({ detail });
    } catch (raw) {
      if (get().target === target) set({ error: toAppError(raw) });
    }
  },

  openFromLibrary: async ({ dirSlug, registryId, repo }) => {
    const target: LocalSkillTarget = { dirSlug };
    set({ target, detail: null, error: null });
    try {
      const d = await storeSkillDetail(dirSlug, registryId, repo);
      const detail: LocalSkillDetail = {
        name: d.name,
        dirSlug: d.dirSlug,
        description: d.description,
        path: d.path,
        skillMd: d.skillMd,
        files: d.files,
        hasScripts: d.hasScripts,
      };
      if (get().target === target) set({ detail });
    } catch (raw) {
      if (get().target === target) set({ error: toAppError(raw) });
    }
  },

  close: () => set({ target: null, detail: null, error: null }),

}));
