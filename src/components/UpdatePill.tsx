// 左下角更新提示 pill(M6 任务 2)。挂在侧边栏账号行上方,对齐 Cursor/Claude 桌面端:
// 新版已在后台装好,这里只问一件事——现在重启还是稍后。不是弹窗,不抢焦点、不劫持 Esc。
import { X } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { useUpdatePrompt } from "@/store/update-prompt";

export function UpdatePill() {
  const readyVersion = useUpdatePrompt((s) => s.readyVersion);
  const dismissed = useUpdatePrompt((s) => s.dismissed);
  const dismiss = useUpdatePrompt((s) => s.dismiss);
  const restart = useUpdatePrompt((s) => s.restart);

  if (!readyVersion || dismissed) return null;

  return (
    <div className="mb-2 rounded-[8px] border border-border bg-surface-2 p-2.5">
      <div className="flex items-start gap-1.5">
        <p className="flex-1 text-[12px] leading-[1.45] text-text-2">
          {t("updatePill.ready", { version: `v${readyVersion}` })}
        </p>
        <button
          type="button"
          aria-label={t("updatePill.dismiss")}
          onClick={dismiss}
          className="shrink-0 text-text-3 hover:text-text"
        >
          <Icon icon={X} size={13} />
        </button>
      </div>
      <button
        type="button"
        onClick={() => void restart()}
        className="mt-2 w-full rounded-ctl bg-accent px-2 py-[5px] text-[12px] font-[550] text-white hover:opacity-90"
      >
        {t("updatePill.restart")}
      </button>
    </div>
  );
}
