import { useEffect, useState } from "react";

import { CommandPalette } from "@/components/CommandPalette";
import { ConflictDialog } from "@/components/ConflictDialog";
import { DetailPanel } from "@/components/DetailPanel";
import { RemoveDialog } from "@/components/RemoveDialog";
import { RepairDialog } from "@/components/RepairDialog";
import { ShareConflictDialog } from "@/components/ShareConflictDialog";
import { RetryLinkDialog } from "@/components/RetryLinkDialog";
import { ShareTakenDialog } from "@/components/ShareTakenDialog";
import { Sidebar } from "@/components/Sidebar";
import { Toolbar } from "@/components/Toolbar";
import { Wizard } from "@/components/Wizard";
import { useDesktopChrome } from "@/hooks/useDesktopChrome";
import { useLocalRefresh } from "@/hooks/useLocalRefresh";
import { call } from "@/lib/ipc";
import { MySkillsPage } from "@/pages/MySkillsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SharePage } from "@/pages/SharePage";
import { StorePage } from "@/pages/StorePage";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useSettings } from "@/store/settings";
import { useUpdatePrompt } from "@/store/update-prompt";
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
  // 切到编辑器改完 SKILL.md 再切回来,列表要跟上(M4 任务 6c 级别 1)
  useLocalRefresh();

  useEffect(() => {
    // 商店索引与登录态并行拉:技能库公开可匿名读,浏览不必等登录查完
    void useStoreIndex.getState().load();
    void useSession.getState().refresh();
    void useInstall.getState().refreshInstalled();
    // 侧边栏角标要在任何页面都算得出来,所以已装清单在启动时就拉一次,
    // 不再等用户点进「我的技能」(M6 任务 3)
    void useMySkills.getState().load();
    void call<AppInfo>("app_info").then(setInfo).catch(() => {});
    // 首次启动:没有完成标记才会真的打开
    void useWizard.getState().maybeOpen();
    // 常驻监听:定时检查结果(设置页摘要)与后台静默装好的 App 新版(左下角 pill)
    const detachReport = useSettings.getState().attachReportListener();
    const detachReady = useUpdatePrompt.getState().attach();
    return () => {
      void detachReport.then((f) => f());
      void detachReady.then((f) => f());
    };
  }, []);

  // 行高必须显式钉在 100%:只定义列时,隐式行会按内容撑高、悄悄超出 h-full,
  // 而 body 是 overflow:hidden——内容直接被裁掉,滚动条永远出不来
  return (
    <div className="grid h-full grid-cols-[208px_1fr] grid-rows-[100%]">
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
      <ShareConflictDialog />
      <RetryLinkDialog />
      <ShareTakenDialog />
      <Wizard />
    </div>
  );
}
