import { useEffect } from "react";

import { useAppearance } from "@/store/appearance";
import { useLocalDetail } from "@/store/local-detail";
import { usePlaza } from "@/store/plaza";
import { useStoreIndex } from "@/store/store-index";
import { useUi, type PageId } from "@/store/ui";

const PAGE_ORDER: PageId[] = ["store", "mine", "share", "settings"];

/** `/` 聚焦搜索时,不能把用户正在输入的内容抢走。 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/**
 * 桌面外壳的键盘与右键行为(UI 规范 §6.3 / §6.4)。
 *
 * 所有分支都先让 IME 组合输入通过:拼音候选窗还开着的时候,keydown 里的 key
 * 并不是用户想按的键(Esc 是取消候选、Enter 是上屏),把它们当快捷键会误触。
 */
export function useDesktopChrome() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (useUi.getState().composing) return;
      const mod = e.metaKey || e.ctrlKey;
      const ui = useUi.getState();

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (e.key === "Escape") {
        if (ui.paletteOpen) ui.setPaletteOpen(false);
        else if (useLocalDetail.getState().target !== null) useLocalDetail.getState().close();
        else if (usePlaza.getState().detailOwnerRepo !== null) usePlaza.getState().closeDetail();
        else useStoreIndex.getState().closeDetail();
        return;
      }
      if (mod && e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        ui.setPage(PAGE_ORDER[Number(e.key) - 1]);
        return;
      }
      if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void useStoreIndex.getState().load(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "u") {
        e.preventDefault();
        useAppearance.getState().toggleTheme();
        return;
      }
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        document.getElementById("store-search")?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // 去 web 味:拦掉浏览器默认右键菜单。开发模式留着——那是 webview 里进 devtools 的入口。
    if (import.meta.env.DEV) return;
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
