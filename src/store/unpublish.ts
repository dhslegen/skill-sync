import { create } from "zustand";

import { t } from "@/i18n";
import { isAppError, skillUnpublish, type AppError, type UnpublishLocal } from "@/lib/ipc";
import { refreshAfterLibraryWrite } from "@/store/my-skills";

/**
 * 「从技能库删除」的确认流程(0.8.0 任务 6)。弹窗全局挂在 `App.tsx`,所以**成功与失败
 * 都在弹窗里说**——触发它的那一行/那个详情面板在删除成功后可能整个消失或换区,
 * 那里不是可靠的渲染点(CLAUDE.md「把一个动作搬到新地方时,成功与失败由谁渲染」)。
 *
 * 两轮:`begin` 发预览轮(零写请求)拿清单与 `remoteRev`;`confirm` 带回同一个 `remoteRev`。
 * core 判出过期时回一份新清单(`stale`),这里原样换上、让用户再看一遍。
 */
export interface UnpublishTarget {
  dirSlug: string;
  displayName: string;
  registryId?: string;
  repo?: string;
  /** 本机有没有这一份——没有就不摆「同时把本机这份移到废纸篓」。 */
  localPresent: boolean;
}

type Phase =
  | { kind: "loading" }
  | { kind: "confirm"; files: string[]; remoteRev: string; historyUrl: string; stale: boolean }
  | { kind: "running"; files: string[]; remoteRev: string; historyUrl: string }
  | { kind: "done"; local: UnpublishLocal; trashRequested: boolean; historyUrl: string }
  | { kind: "error"; error: AppError };

interface UnpublishState {
  target: UnpublishTarget | null;
  phase: Phase;
  /** 默认不勾(设计 §3)。 */
  alsoTrashLocal: boolean;
  begin: (target: UnpublishTarget) => Promise<void>;
  setAlsoTrashLocal: (v: boolean) => void;
  confirm: () => Promise<void>;
  close: () => void;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw) ? raw : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

export const useUnpublish = create<UnpublishState>((set, get) => ({
  target: null,
  phase: { kind: "loading" },
  alsoTrashLocal: false,

  begin: async (target) => {
    set({ target, phase: { kind: "loading" }, alsoTrashLocal: false });
    try {
      const out = await skillUnpublish({ dirSlug: target.dirSlug, registryId: target.registryId, repo: target.repo });
      // 用户可能已经关掉、或换成了另一个技能:旧结果不能盖到新弹窗上
      if (get().target !== target) return;
      if (out.outcome === "needsConfirm") {
        set({ phase: { kind: "confirm", files: out.files, remoteRev: out.remoteRev, historyUrl: out.historyUrl, stale: false } });
      } else {
        // 预览轮不带凭据,core 不会走到删除——真出现就是契约漂移,如实说出来
        set({ phase: { kind: "error", error: { code: "IPC_UNEXPECTED", message: t("error.generic") } } });
      }
    } catch (raw) {
      if (get().target !== target) return;
      set({ phase: { kind: "error", error: toAppError(raw) } });
    }
  },

  setAlsoTrashLocal: (v) => set({ alsoTrashLocal: v }),

  confirm: async () => {
    const { target, phase, alsoTrashLocal } = get();
    if (!target || phase.kind !== "confirm") return;
    set({ phase: { kind: "running", files: phase.files, remoteRev: phase.remoteRev, historyUrl: phase.historyUrl } });
    try {
      const out = await skillUnpublish({
        dirSlug: target.dirSlug,
        registryId: target.registryId,
        repo: target.repo,
        confirmRev: phase.remoteRev,
        alsoTrashLocal: alsoTrashLocal && target.localPresent,
      });
      if (out.outcome === "needsConfirm") {
        set({ phase: { kind: "confirm", files: out.files, remoteRev: out.remoteRev, historyUrl: out.historyUrl, stale: true } });
        return;
      }
      set({
        phase: {
          kind: "done",
          local: out.local,
          trashRequested: alsoTrashLocal && target.localPresent,
          // 终审 M-6:删完才是用户真需要「去哪找回」的时候
          historyUrl: phase.historyUrl,
        },
      });
      // 库里那一版没了:先刷**被删的那个库**的索引,再重读「我的技能」(终审 I-1,
      // 并发重读会读到删除前的缓存,刚删的技能以「只在库里 + 取回」复活)
      void refreshAfterLibraryWrite(target.registryId, target.repo);
    } catch (raw) {
      set({ phase: { kind: "error", error: toAppError(raw) } });
    }
  },

  close: () => set({ target: null, phase: { kind: "loading" }, alsoTrashLocal: false }),
}));

/**
 * 从「我的技能」那一行算出删除目标(行与详情动作区共用,不各拼一份)。
 * 库坐标取这一行的记账来源——「已分享到」区与只在库里的那一档,来源就是它所在的库。
 */
export function unpublishTargetOf(
  skill: { dirSlug: string; registryId: string; sourceOwner: string; sourceRepo: string; localPresent: boolean },
  displayName: string,
): UnpublishTarget {
  return {
    dirSlug: skill.dirSlug,
    displayName,
    registryId: skill.registryId || undefined,
    repo: skill.sourceRepo ? `${skill.sourceOwner}/${skill.sourceRepo}` : undefined,
    localPresent: skill.localPresent,
  };
}
