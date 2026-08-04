// 本地技能变更的实时刷新(M4 任务 6c)。
//
// 要解决的体验:用户在编辑器里改完 SKILL.md 切回应用,列表还是旧的——
// 两个页面都只有 `useEffect(() => void load(), [load])`,而 `load` 是 zustand 的
// 稳定引用,依赖数组永远不变,所以它**只在组件挂载时跑一次**。前端此前从未监听过
// 窗口焦点事件,"切出去改完再切回来"这条桌面应用最基本的路径整个没人管。
//
// 更尴尬的是新建向导的完成页自己写着「然后回到这一页分享给团队」,而回到这一页
// 看到的却是旧状态——引导语与实现脱节。
//
// 三级刷新(用户 2026-08-04 明确要求全做):
//   1. 窗口重获焦点 —— 本文件,覆盖"切到编辑器改完切回来"这条主路径;
//   2. 切换页面 —— 页面组件挂载时 load,由 `refreshes-on-page-switch` 测试钉住,
//      不再是"靠组件卸载重挂"的巧合;
//   3. 文件系统监听 —— core 侧 watcher,另行接入。
//
// **只刷当前页需要的东西**:无脑全刷会在每次切窗口时打三次 IPC,而其中两次的结果
// 没人看。`load` 只写列表不碰表单(已确认),所以刷新不会打断正在填的分享表单。
import { useEffect, useRef } from "react";

import { listenLocalSkillsChanged } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useShare } from "@/store/share";
import { useUi, type PageId } from "@/store/ui";

/** 按页刷新本地技能相关的状态。导出供 level 3 的文件监听复用。 */
export function refreshLocalFor(page: PageId): void {
  switch (page) {
    case "mine":
      void useMySkills.getState().load();
      break;
    case "share":
      void useShare.getState().load();
      break;
    case "store":
      // 已装技能可能在外部被删掉了,回来该显示「获取」而不是「已启用」
      void useInstall.getState().refreshInstalled();
      break;
    case "settings":
      // 设置页不展示技能,无需刷新
      break;
  }
}

/**
 * 窗口重获焦点时刷新当前页(级别 1)。
 *
 * 用 ref 存当前页而不是把 `page` 放进依赖数组:那样每次切页都要重新注册一次
 * 原生监听,而我们要的只是"回来时刷新此刻这一页"。
 */
export function useLocalRefresh(): void {
  const page = useUi((s) => s.page);
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        // 动态 import:浏览器里(vitest / vite dev 直开)没有 Tauri runtime,
        // 顶层 import 会让整个模块加载失败,连级别 2 都跟着废掉
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const stop = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) refreshLocalFor(pageRef.current);
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // 注册不上就降级到级别 2 与 3,不拦任何东西——刷新是锦上添花,
        // 挂掉它不该让应用少一块功能
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 级别 3:core 侧的文件监听。窗口有焦点时改动也能立刻反映
  //(应用和编辑器并排放着的用法)。core 已经滤掉本应用自己写盘引发的事件。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenLocalSkillsChanged(() => refreshLocalFor(pageRef.current))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // 监听不上就降级到级别 1 与 2
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
