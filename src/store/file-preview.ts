import { create } from "zustand";

import { PLAZA_REGISTRY_ID, type RegistryView } from "@/lib/ipc";

/**
 * 详情面板「文件」页签里正在预览哪个文件(v8 任务 10 / 设计 Q19-B:点文件 →
 * 预览替换文件列表那一栏)。
 *
 * # 为什么是全局 store 而不是组件里的 state
 *
 * Esc 要分两层:**先回到列表,再按一次才关面板**(顾问提醒)。关面板那一层在
 * `useDesktopChrome` 里(挂在 document 冒泡阶段的唯一一处 Esc 处理),它要知道
 * "眼下有没有一层预览"才能先让路。放在组件 state 里它看不见;另挂一个捕获阶段
 * 监听器又会和确认屏(`ShareConfirm` 也在捕获阶段接 Esc)同时触发——确认屏盖在
 * 面板上时按一次 Esc 会把两层一起关掉。收进同一条 Esc 链,层级就是那条 if 链的顺序。
 *
 * # 🔴 归属:`owner` 是"哪个来源的哪个技能"
 *
 * 面板不关、直接换一个技能看(广场一个仓多个技能、「我的技能」里点另一行)时,
 * 上一个技能的预览绝不能挂在新技能上。宿主只认 `owner` 等于自己的那一份,
 * 并在自己卸载或换了 `owner` 时调 `release` 清掉**自己名下**的那一份。
 */
interface FilePreviewState {
  owner: string | null;
  file: string | null;
  show: (owner: string, file: string) => void;
  /** 回到文件列表(「返回」按钮与 Esc 共用)。 */
  back: () => void;
  /** 宿主卸载 / 换技能时清掉自己名下的预览;不是自己的不动。 */
  release: (owner: string) => void;
}

export const useFilePreview = create<FilePreviewState>((set, get) => ({
  owner: null,
  file: null,
  show: (owner, file) => set({ owner, file }),
  back: () => set({ owner: null, file: null }),
  release: (owner) => {
    if (get().owner === owner) set({ owner: null, file: null });
  },
}));

/**
 * 这个来源在**点开之前**能不能看文件内容(设计 Q15「拿不了就不给点」)。
 *
 * 判据只用手上现成的 registry 列表(`useRegistries.list`),不新发请求:
 * - 技能广场虽然 kind 也是 github,但走 skills.sh 的快照,**能看**;
 * - 其余 kind 为 github 的(自定义 GitHub 源)拿不到单个文件 → 不给点;
 * - 列表还没加载(`null`)或找不到这个源时**放行**:拿"不知道"当"不能"是另一种撒谎,
 *   真点了拿到 `unavailable` 那一档,查看器照样说同一句话兜底。
 */
export function sourceCanShowFiles(registryId: string, registries: RegistryView[] | null): boolean {
  if (registryId === PLAZA_REGISTRY_ID) return true;
  return registries?.find((r) => r.id === registryId)?.kind !== "github";
}
