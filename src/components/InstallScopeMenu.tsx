import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { recentProjects, useProjects } from "@/store/project";

/**
 * 「获取」按钮右侧的作用域下拉。
 *
 * 设计取舍(2026-08-20 拍板):**主动作仍是一键装到这台电脑**,下拉只是第二条路
 * ——只用全局的老用户完全不受影响,不必每次安装先答一道"装哪儿"。
 *
 * agent 选择**沿用全局默认**(设置页没禁用的那些),不再单独问一次:
 * 项目级安装本来就是"给这个文件夹配技能"的快捷动作,再叠一层勾选就失去了快捷的意义。
 * 要改关联去「我的技能」里改。
 */
export function InstallScopeMenu({
  dirSlug,
  onPickProject,
  onChooseRecent,
  onGlobal,
  disabled,
}: {
  /** 正在安装的技能的**仓库目录名**。用来标出"这个项目已经装过它了"。 */
  dirSlug: string;
  /** 打开系统目录选择框。 */
  onPickProject: () => void;
  onChooseRecent: (path: string) => void;
  /** 主按钮那条路(装到这台电脑)。菜单里也摆一份,两条路才对称、用户看得懂。 */
  onGlobal: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const groups = useProjects((s) => s.groups);
  // 在组件里派生:selector 里造新数组会让 Zustand 每次都判"变了"(见 store 里的说明)
  const recent = useMemo(() => recentProjects(groups), [groups]);
  const load = useProjects((s) => s.load);

  // 菜单要摆「最近的项目」,列表得先有。打开时拉一次即可——项目清单变化很低频。
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 点外面关掉。捕获阶段监听:内部按钮的 onClick 先跑完再关,不会被抢先。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus(); // 焦点回到触发处,键盘用户不会掉到页面开头
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("install.scopeMenu")}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            close();
          }
        }}
        className="flex h-7 w-6 items-center justify-center rounded-ctl border border-border text-text-2 hover:border-border-strong hover:text-text disabled:opacity-60"
      >
        <Icon icon={ChevronDown} size={13} />
      </button>

      {open && (
        <div
          role="menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
          className="absolute bottom-full right-0 z-20 mb-1 min-w-[220px] rounded-card border border-border bg-surface-1 py-1 shadow-[var(--shadow-panel)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onGlobal();
            }}
            className="block w-full px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
          >
            {t("install.scopeGlobal")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onPickProject();
            }}
            className="block w-full px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2"
          >
            {t("install.scopeProject")}
          </button>

          {recent.length > 0 && (
            <>
              <div className="mt-1 border-t border-border px-3 pb-1 pt-1.5 text-[11px] text-text-3">
                {t("install.recentProjects")}
              </div>
              {recent.map((g) => {
                // 已经装过就**不给点**:让用户点一下、等一整轮网络请求(下压缩包、
                // 建索引)才被告知"已经有了",是这次真机反馈里最实的一条。
                // 判据是仓库目录名而不是安装键——两者在广场技能里经常不同。
                const already = (g.skills ?? []).some((s) => s.dirSlug === dirSlug);
                return (
                <button
                  key={g.path}
                  type="button"
                  role="menuitem"
                  title={g.path}
                  disabled={already}
                  onClick={() => {
                    setOpen(false);
                    onChooseRecent(g.path);
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-surface-2 disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">
                      {g.folderName}
                    </span>
                    {already && (
                      <span className="shrink-0 text-[10.5px] text-text-3">
                        {t("install.recentAlready")}
                      </span>
                    )}
                  </span>
                  {/* 路径用等宽字体(UI 规范:slug/路径类一律等宽),截断显示尾部更有用,
                      但 CSS 只能截尾——完整路径挂在 title 上 */}
                  <span className="block truncate font-mono text-[10.5px] text-text-3">
                    {g.path}
                  </span>
                </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
