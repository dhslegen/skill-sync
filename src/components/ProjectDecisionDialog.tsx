import { useEffect, useRef } from "react";

import { t } from "@/i18n";
import { useProjects } from "@/store/project";

/** 路径末段,用作展示名。 */
function folderNameOf(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 项目级安装/更新需要用户拍板的两档。
 *
 * 与 `RemoveDialog` 同一形态:必须打断的决策才用居中模态,**默认焦点在取消上**
 * ——回车绝不等于覆盖用户的内容。
 *
 * 两档的共同前提:core 侧到这一步**磁盘一个字节都没动过**,取消就是真的什么都没发生。
 */
export function ProjectDecisionDialog() {
  const decision = useProjects((s) => s.decision);
  const dismiss = useProjects((s) => s.dismissDecision);
  const install = useProjects((s) => s.install);
  const update = useProjects((s) => s.update);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (decision) cancelRef.current?.focus();
  }, [decision]);

  useEffect(() => {
    if (!decision) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [decision, dismiss]);

  if (!decision) return null;

  const project = folderNameOf(decision.projectPath);
  const replacing = decision.kind === "replace";

  const confirm = () => {
    dismiss();
    if (decision.kind === "replace") {
      void install({
        projectPath: decision.projectPath,
        dirSlug: decision.dirSlug,
        agentIds: decision.agentIds,
        registryId: decision.registryId,
        repo: decision.repo,
        confirmedReplace: true,
      });
    } else {
      void update({
        projectPath: decision.projectPath,
        key: decision.key,
        dirSlug: decision.dirSlug,
        agentIds: decision.agentIds,
        registryId: decision.registryId,
        repo: decision.repo,
        discardLocalEdits: true,
      });
    }
  };

  return (
    <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(15,14,12,.35)] backdrop-blur-[2px]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-decision-title"
        className="w-[420px] rounded-pop border border-border-strong bg-surface-1 p-5 shadow-[var(--shadow-pop)]"
      >
        <h2 id="project-decision-title" className="text-[14px] font-semibold">
          {replacing
            ? t("install.projectReplaceTitle", { project })
            : t("mine.projectLocalEditsTitle")}
        </h2>
        <p className="mt-2 text-[12.5px] leading-[1.6] text-text-2">
          {replacing
            ? t("install.projectReplaceBody")
            : t("mine.projectLocalEditsBody")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={dismiss}
            className="h-7 rounded-ctl border border-border px-3 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("conflict.cancel")}
          </button>
          <button
            type="button"
            onClick={confirm}
            className="h-7 rounded-ctl bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent-hover"
          >
            {replacing
              ? t("install.projectReplaceConfirm")
              : t("mine.projectLocalEditsConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
