import { useEffect, useState } from "react";

import { CommandPalette } from "@/components/CommandPalette";
import { ConflictDialog } from "@/components/ConflictDialog";
import { DetailPanel } from "@/components/DetailPanel";
import { RemoveDialog } from "@/components/RemoveDialog";
import { RepairDialog } from "@/components/RepairDialog";
import { ShareTakenDialog } from "@/components/ShareTakenDialog";
import { Sidebar } from "@/components/Sidebar";
import { Toolbar } from "@/components/Toolbar";
import { Wizard } from "@/components/Wizard";
import { useDesktopChrome } from "@/hooks/useDesktopChrome";
import { call } from "@/lib/ipc";
import { MySkillsPage } from "@/pages/MySkillsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SharePage } from "@/pages/SharePage";
import { StorePage } from "@/pages/StorePage";
import { useInstall } from "@/store/install";
import { useSettings } from "@/store/settings";
import { useWizard } from "@/store/wizard";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/** 只取版本号。core 还返回 builtinConfigured,但"内建库没配"这件事
 *  已经由 store_index 的 REPO_NOT_CONFIGURED 带着可读文案报出来了,
 *  这里再存一份没人用的标志只会变成死字段。 */
interface AppInfo {
  version: string;
}

export default function App() {
  const page = useUi((s) => s.page);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useDesktopChrome();

  useEffect(() => {
    // 商店索引与登录态并行拉:技能库公开可匿名读,浏览不必等登录查完
    void useStoreIndex.getState().load();
    void useSession.getState().refresh();
    void useInstall.getState().refreshInstalled();
    void call<AppInfo>("app_info").then(setInfo).catch(() => {});
    // 首次启动:没有完成标记才会真的打开
    void useWizard.getState().maybeOpen();
    // 定时检查的结果常驻监听:设置页摘要与后续的系统通知都吃这份数据
    const detach = useSettings.getState().attachReportListener();
    return () => {
      void detach.then((f) => f());
    };
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
            ) : page === "mine" ? (
              <MySkillsPage />
            ) : page === "share" ? (
              <SharePage />
            ) : (
              <SettingsPage />
            )}
          </div>
        </div>
      </main>

      <DetailPanel />
      <CommandPalette />
      <ConflictDialog />
      <RemoveDialog />
      <RepairDialog />
      <ShareTakenDialog />
      <Wizard />
    </div>
  );
}
