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
  sharePreview,
  skillShare,
  type AppError,
  type ShareCandidate,
  type ShareOutcome,
  type SharePath,
} from "@/lib/ipc";
import { useInstall } from "@/store/install";
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
  /** 分享目标库(M4):寻址键 `owner/repo`,null = 该源主库。 */
  targetRepo: string | null;
  /** 目标库的路径预告。权限是**仓库级**的,一个目标库探一次,切库才重探
   *  ——不对每个候选技能各发一次(候选可能有十几个)。 */
  preview: SharePath;
  /** CONFLICT_STALE 后回到表单时的提示。 */
  staleNotice: boolean;
  shareError: AppError | null;
  done: Extract<ShareOutcome, { outcome: "shared" }> | null;

  load: () => Promise<void>;
  /** 切换分享目标库并重探路径。 */
  setTargetRepo: (repo: string | null) => Promise<void>;
  /** 探一次目标库的分享路径。**永不抛错**:探不到就是 unknown,表单照常可提交。 */
  refreshPreview: () => Promise<void>;
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

/**
 * 远端目录名的预校验。与新建向导的本地文件夹名**同一把尺子**(见 `lib/slug.ts`)。
 *
 * 这里原本另写了一个正则,已实测不准:它放行 `a--b` / `trail-` / 超长名字,
 * 而 core 会把这三种静默清洗成别的名字——用户填的和落盘的不是一个东西。
 */
export { validSlug as validShareName } from "@/lib/slug";

export const useShare = create<ShareState>((set, get) => ({
  candidates: null,
  scanError: null,
  scanning: false,
  phase: "idle",
  target: null,
  form: EMPTY_FORM,
  targetRepo: null,
  preview: "unknown",
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
    // 预告与候选扫描互不依赖:哪个失败都不影响另一个
    await get().refreshPreview();
  },

  refreshPreview: async () => {
    const repo = get().targetRepo;
    try {
      const preview = await sharePreview(repo ? { repo } : {});
      // 等待期间用户可能又切了库:迟到的结果不能冒充当前库
      if (get().targetRepo === repo) set({ preview });
    } catch {
      // 预告只是提示,失败连错误都不亮——表单照常可提交
      if (get().targetRepo === repo) set({ preview: "unknown" });
    }
  },

  setTargetRepo: async (repo) => {
    if (get().targetRepo === repo) return;
    // 立刻清掉上一个库的预告:挂着旧库的路径却标着新库,等于对用户撒谎
    set({ targetRepo: repo, preview: "unknown" });
    await get().refreshPreview();
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
        // 目标库要带上:缺省会推到该源主库,选了别的库却推错地方
        ...(get().targetRepo ? { repo: get().targetRepo! } : {}),
      });
      if (result.outcome === "needsDecision") {
        // core 没发过任何提交,等用户拍板
        set({ phase: "taken" });
        return;
      }
      set({ phase: "done", done: result });
      // 分享成功后要刷新的不止本页(2026-08-03 用户实测:分享完界面到处都是旧的)。
      // 候选列表:这个技能变成"已分享";商店索引:库里多了(或更新了)一个技能,
      // 不强刷就要等缓存过期才看得见;已装记账:商店卡片的状态机据它决定按钮档位。
      await get().load();
      void useStoreIndex.getState().load(true);
      void useInstall.getState().refreshInstalled();
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