import { useEffect, useMemo } from "react";
import { ArrowRight, Laptop, FolderOpen } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { useInstall } from "@/store/install";
import { useProjects } from "@/store/project";
import { useUi } from "@/store/ui";

/**
 * 详情面板的「已装到」:这个技能在这台机器上装在哪些位置。
 *
 * # 为什么位置要摆出来(2026-08-22 用户真机反馈)
 *
 * 原话:"随后再打开技能详情,没有回显安装到哪些目录了"。全局与项目两级并存之后,
 * **位置是一等信息**,不是安装动作的副产品——同 Steam 的多库文件夹:游戏详情页
 * 直接写「已安装于 <路径>」。
 *
 * # 零新 IPC
 *
 * 全局那档来自 `install.ts` 的 `installed` map(它本来就在),项目那档来自
 * `project_list`(项目分区已经在用)。这一层只做匹配与展示。
 *
 * 🔴 **匹配用仓库目录名 `dirSlug`,不能用项目 lock 的 `key`**:`key` 是
 * frontmatter name,两者在广场技能里经常不同(实测 47 个里 8 个)。按 key 匹配的话,
 * 恰恰是那批最热门的技能永远显示"没装过"。
 *
 * 目录已经不在的项目不列——它不再是一个能去的地方,列出来只会让用户点一个死链接。
 */
export function InstalledScopes({ dirSlug }: { dirSlug: string }) {
  const globalRecord = useInstall((s) => s.installed.get(dirSlug));
  const groups = useProjects((s) => s.groups);
  const loadProjects = useProjects((s) => s.load);
  const setPage = useUi((s) => s.setPage);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // 在组件里派生:selector 里造新数组会让 Zustand 每次都判"变了"(见 store 里的说明)
  const inProjects = useMemo(
    () =>
      groups.filter(
        (g) => !g.missing && (g.skills ?? []).some((s) => s.dirSlug === dirSlug),
      ),
    [groups, dirSlug],
  );

  if (!globalRecord && inProjects.length === 0) return null;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-1.5 text-[11px] font-[550] tracking-[0.05em] text-text-3">
        {t("detail.installedScopes")}
      </div>
      {globalRecord && (
        <div className="flex items-center gap-1.5 px-0.5 py-1 text-[12.5px] text-text-2">
          <Icon icon={Laptop} size={13} className="shrink-0 text-text-3" />
          {t("detail.scopeGlobal")}
        </div>
      )}
      {inProjects.map((g) => (
        <button
          key={g.path}
          type="button"
          title={g.path}
          onClick={() => setPage("mine")}
          className="flex w-full items-center gap-1.5 rounded-ctl px-0.5 py-1 text-left text-[12.5px] text-text-2 hover:text-text"
        >
          <Icon icon={FolderOpen} size={13} className="shrink-0 text-text-3" />
          <span className="min-w-0 flex-1 truncate">{g.folderName}</span>
          <Icon icon={ArrowRight} size={12} className="shrink-0 text-text-3" />
        </button>
      ))}
    </div>
  );
}
