import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";

/**
 * 「更多」下拉菜单——「我的技能」每一行「至多一颗主按钮,其余在「…」里」这条
 * 设计约束的落点(v7 任务 7)。
 *
 * # 为什么要有这个组件
 *
 * 一行同时能做的事其实不止一件:「打开文件夹」「移除」这两个几乎每行都在,
 * 外加判定表里被压过一头、暂时不是主按钮但仍然可点的动作(比如
 * `shareable` 区某一版分享合格但外源又有新版时,「分享」退进这里;
 * `shareBlocked` 压过 `update` 时,「更新」退进这里——见
 * `src/lib/ownership.ts` 的 `RowAction` 判定表文档)。这些动作**没有消失**,
 * 只是不该在同一行里跟主按钮抢注意力,`InstallScopeMenu.tsx` 已经是这个项目
 * 里同款"主按钮 + 下拉里的次要动作"的先例,这里复用同一套无障碍骨架
 * (`aria-haspopup`/`aria-expanded`/`role="menu"`/`role="menuitem"`、
 * Esc 关闭、点外面关闭、关闭后焦点回到触发按钮)。
 *
 * # 🔴 触发按钮永远走 `aria-label`,不靠可见文字
 *
 * 它是一个纯图标按钮(`MoreHorizontal`),可访问名只能来自 `aria-label`。
 * 这不是随手一致——「我的技能」整页有一条测试断言"每行只有一颗**不带
 * `aria-label` 属性**的按钮"(主按钮那颗,靠自己的可见文字当可访问名),
 * 图标按钮反过来必须带 `aria-label` 才能被这条测试正确地排除在外。
 *
 * # 没有条目时不渲染
 *
 * 不摆一个打开了空空如也的菜单——那不比不摆更有用(项目里"不摆比摆一个
 * 没有意义的东西好"这条既定取舍的又一处应用)。
 */
export interface SkillRowMenuItem {
  key: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function SkillRowMenu({ items }: { items: SkillRowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // 捕获阶段监听:菜单内部按钮的 onClick 先跑完再关,不会被抢先。
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus(); // 焦点回到触发处,键盘用户不会掉到页面开头
  };

  if (items.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("mine.rowMenu")}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            close();
          }
        }}
        className="flex h-6 w-6 flex-none items-center justify-center rounded-ctl border border-border text-text-2 hover:border-border-strong hover:text-text"
      >
        <Icon icon={MoreHorizontal} size={13} />
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
          className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-card border border-border bg-surface-1 py-1 shadow-[var(--shadow-panel)]"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className="block w-full px-3 py-1.5 text-left text-[12.5px] text-text hover:bg-surface-2 disabled:pointer-events-none disabled:text-text-3"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
