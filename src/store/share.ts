// 分享页的状态:候选列表 + 分享流程。
//
// 一次分享的走向:
//   idle → form(表单:名称/描述/英文文件夹名) → busy → done
//                                     ↑              ↓ core 报 needsDecision(同名被占)
//                                     └── taken(三选:改名 / 查看对方 / 覆盖)
//
// CONFLICT_STALE(提交瞬间被人抢先)→ 回到表单并提示重新确认——设计方案 2.5② 的
// 竞态处置:不盲目重试,让用户带着最新事实重新决定。
import { create } from "zustand";

import { t } from "@/i18n";
import {
  isAppError,
  shareCandidates,
  skillShare,
  type AppError,
  type ShareCandidate,
  type ShareOutcome,
} from "@/lib/ipc";
import { useStoreIndex } from "@/store/store-index";

export type SharePhase = "idle" | "form" | "busy" | "taken" | "done";

interface ShareForm {
  shareName: string;
  displayName: string;
  description: string;
}

interface ShareState {
  candidates: ShareCandidate[] | null;
  scanError: AppError | null;
  scanning: boolean;

  phase: SharePhase;
  target: ShareCandidate | null;
  form: ShareForm;
  /** CONFLICT_STALE 后回到表单时的提示。 */
  staleNotice: boolean;
  shareError: AppError | null;
  done: Extract<ShareOutcome, { outcome: "shared" }> | null;

  load: () => Promise<void>;
  begin: (candidate: ShareCandidate) => void;
  setForm: (patch: Partial<ShareForm>) => void;
  cancel: () => void;
  /** 表单确认。`overwrite` 只在从"被占用"弹窗选覆盖时为 true。 */
  submit: (overwrite?: boolean) => Promise<void>;
  /** 被占用弹窗:改名 → 回表单;查看 → 打开商店详情。 */
  backToForm: () => void;
  viewTheirs: () => void;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

const EMPTY_FORM: ShareForm = { shareName: "", displayName: "", description: "" };

/** 与 core 的 sanitize 同一口径的前端预校验:小写字母/数字/点/下划线/短横线。 */
export function validShareName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) && name !== "unnamed-skill";
}

export const useShare = create<ShareState>((set, get) => ({
  candidates: null,
  scanError: null,
  scanning: false,
  phase: "idle",
  target: null,
  form: EMPTY_FORM,
  staleNotice: false,
  shareError: null,
  done: null,

  load: async () => {
    set({ scanning: true, scanError: null });
    try {
      const candidates = await shareCandidates();
      set({ candidates, scanning: false });
    } catch (raw) {
      // 扫描失败保留上次内容并报错,不画成"没有可分享的技能"
      set({ scanError: toAppError(raw), scanning: false });
    }
  },

  begin: (candidate) =>
    set({
      phase: "form",
      target: candidate,
      staleNotice: false,
      shareError: null,
      done: null,
      form: {
        // 再推沿用上次的远端名;首次用目录名(可用时)
        shareName:
          candidate.shared?.shareName ?? (candidate.dirNameUsable ? candidate.dirName : ""),
        displayName: candidate.name ?? "",
        description: candidate.description ?? "",
      },
    }),

  setForm: (patch) => set({ form: { ...get().form, ...patch } }),

  cancel: () =>
    set({ phase: "idle", target: null, form: EMPTY_FORM, staleNotice: false, shareError: null }),

  submit: async (overwrite = false) => {
    const { target, form } = get();
    if (!target) return;
    set({ phase: "busy", shareError: null, staleNotice: false });
    try {
      const result = await skillShare({
        sourcePath: target.path,
        shareName: form.shareName,
        // 与候选一致就不传:core 只在收到值时改写 SKILL.md
        displayName: form.displayName !== (target.name ?? "") ? form.displayName : undefined,
        description:
          form.description !== (target.description ?? "") ? form.description : undefined,
        origin: target.origin.kind === "npxSkills" ? "npx-skills" : "local",
        overwrite,
      });
      if (result.outcome === "needsDecision") {
        // core 没发过任何提交,等用户拍板
        set({ phase: "taken" });
        return;
      }
      set({ phase: "done", done: result });
      await get().load();
    } catch (raw) {
      const error = toAppError(raw);
      if (error.code === "CONFLICT_STALE") {
        // 提交瞬间被人抢先:回到表单重新确认,不盲目重试
        set({ phase: "form", staleNotice: true, shareError: null });
        return;
      }
      set({ phase: "form", shareError: error });
    }
  },

  backToForm: () => set({ phase: "form" }),

  viewTheirs: () => {
    const name = get().form.shareName;
    set({ phase: "form" });
    useStoreIndex.getState().openDetail(name);
  },
}));