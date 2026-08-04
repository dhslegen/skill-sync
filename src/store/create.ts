// 「新建技能」向导的状态(M4 任务 4)。
//
// 与首启向导的 `store/wizard.ts` **刻意不复用状态机**:那个是"第一次打开应用要不要
// 装点东西"的一次性引导,这个是随时可用的表单。共用一套 step 会把两个不相干的流程
// 绑在一起,以后改任一个都要顾虑另一个。
//
// 流程只有三档:closed → form(填写,失败留在这档)→ done(完成提示)。
import { create } from "zustand";

import { t } from "@/i18n";
import { isAppError, skillCreate, skillReveal, type AppError } from "@/lib/ipc";
import { validSlug } from "@/lib/slug";
import { useShare } from "@/store/share";

export type CreatePhase = "closed" | "form" | "busy" | "done";

export interface CreateForm {
  dirSlug: string;
  displayName: string;
  description: string;
}

const EMPTY_FORM: CreateForm = { dirSlug: "", displayName: "", description: "" };

interface CreateState {
  phase: CreatePhase;
  form: CreateForm;
  error: AppError | null;
  /** 创建成功后的绝对路径,完成页用它做「在访达中显示」。 */
  createdPath: string | null;

  open: () => void;
  close: () => void;
  setForm: (patch: Partial<CreateForm>) => void;
  submit: () => Promise<void>;
  reveal: () => Promise<void>;
}

function toAppError(raw: unknown): AppError {
  return isAppError(raw)
    ? raw
    : { code: "IPC_FAILED", message: t("error.generic"), detail: String(raw) };
}

/** 表单是否可提交。slug 走与 core 同一把尺子,另两项非空即可(core 会再 trim 一次)。 */
export function createFormComplete(form: CreateForm): boolean {
  return (
    validSlug(form.dirSlug) &&
    form.displayName.trim() !== "" &&
    form.description.trim() !== ""
  );
}

export const useCreate = create<CreateState>((set, get) => ({
  phase: "closed",
  form: EMPTY_FORM,
  error: null,
  createdPath: null,

  open: () => set({ phase: "form", form: EMPTY_FORM, error: null, createdPath: null }),

  close: () => set({ phase: "closed", form: EMPTY_FORM, error: null, createdPath: null }),

  setForm: (patch) => set({ form: { ...get().form, ...patch } }),

  submit: async () => {
    const { form } = get();
    if (!createFormComplete(form)) return;
    set({ phase: "busy", error: null });
    try {
      const report = await skillCreate({
        dirSlug: form.dirSlug,
        displayName: form.displayName,
        description: form.description,
      });
      set({ phase: "done", createdPath: report.path });
      // 新技能立刻成为分享候选,列表要跟上——不刷新的话用户看不到自己刚建的东西
      await useShare.getState().load();
    } catch (raw) {
      // 留在表单档:撞名与名字不合规都是改一改就能重来的,不该把已填内容丢掉
      set({ phase: "form", error: toAppError(raw) });
    }
  },

  reveal: async () => {
    const path = get().createdPath;
    if (!path) return;
    try {
      await skillReveal({ path });
    } catch (raw) {
      set({ error: toAppError(raw) });
    }
  },
}));
