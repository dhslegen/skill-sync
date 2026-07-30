import { useEffect, useState } from "react";

import { CommandPalette } from "@/components/CommandPalette";
import { DetailPanel } from "@/components/DetailPanel";
import { Sidebar } from "@/components/Sidebar";
import { Toolbar } from "@/components/Toolbar";
import { useDesktopChrome } from "@/hooks/useDesktopChrome";
import { t } from "@/i18n";
import { call } from "@/lib/ipc";
import { StorePage } from "@/pages/StorePage";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

interface AppInfo {
  version: string;
  builtinConfigured: boolean;
}

export default function App() {
  const page = useUi((s) => s.page);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useDesktopChrome();

  useEffect(() => {
    // 商店索引与登录态并行拉:技能库公开可匿名读,浏览不必等登录查完
    void useStoreIndex.getState().load();
    void useSession.getState().refresh();
    void call<AppInfo>("app_info").then(setInfo).catch(() => {});
  }, []);

  return (
    <div className="grid h-full grid-cols-[208px_1fr]">
      {/* macOS 红绿灯占位。原生窗口控制属打包任务,这里只把 44px 让出来 */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-40 h-11" data-tauri-drag-region />

      <Sidebar version={info?.version ?? "0.0.0"} />

      <main className="flex min-w-0 flex-col">
        <Toolbar />
        <div className="flex-1 overflow-y-auto px-5 pb-8 pt-1">
          <div className="max-w-[980px]">
            {page === "store" ? (
              <StorePage />
            ) : (
              <p className="py-6 text-[12.5px] text-text-3">{t("page.comingSoon")}</p>
            )}
          </div>
        </div>
      </main>

      <DetailPanel />
      <CommandPalette />
    </div>
  );
}
