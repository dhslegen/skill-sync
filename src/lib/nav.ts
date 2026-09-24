import { FolderOpen, Laptop, Settings, Store } from "lucide-react";

import type { MessageKey } from "@/i18n";
import type { PageId } from "@/store/ui";

/**
 * 侧边栏的页面清单——**页面顺序的唯一真相**。
 *
 * 侧边栏按它渲染,`⌘1`…`⌘N` 的快捷键按 {@link PAGE_ORDER}(由它推出)切页。
 * 🔴 原先两边各记一份:v7.3 把「项目里的技能」加进侧边栏时快捷键那份没跟上,
 * `⌘3` 跳到了设置、`⌘4` 把页面切成 `undefined`(整页空白)。别再在别处手写页序。
 */
export const NAV: { group: MessageKey; items: { id: PageId; label: MessageKey; icon: typeof Store }[] }[] = [
  {
    group: "nav.groupSkills",
    items: [
      // 🔴 v7.3 Q25/Q26:这一组的轴是**技能在哪**(远端商店 / 这台电脑 / 项目文件夹),
      // 所以三个图标都必须落在"位置"这个轴上。换掉的两个原本不在:
      // `LayoutGrid` 说的是**布局**,`Check` 说的是**已完成/已勾选**——它表达的是
      // 状态,与"在哪"无关。`Store`(店面 = 一个地方)与 `Laptop`(这台电脑)才在轴上。
      // `Laptop` 还与详情面板打通:`WhereBlocks` 里它已经代表「这台电脑上」,两处同义。
      // ⚠️ **别把 `Library` 拿来用**:它在详情面板里特指"公司技能库",而侧边栏这一条
      // 含义更宽(可切库、含技能广场),复用会把详情面板那块的含义稀释掉。
      { id: "store", label: "nav.store", icon: Store },
      { id: "mine", label: "nav.mine", icon: Laptop },
      // 🔴 v7.3:「项目里的技能」从「我的技能」的第四个页签升成侧边栏一条
      // ——见 `store/ui.ts` 的 `PageId` 注释(那一行页签混了两个轴)。
      // **刻意不摆角标**:项目级链路算不出"有几个要处理"这个数(不联动
      // scheduler,是 v5 拍板的边界),摆一个没有含义的点比不摆更糟。
      { id: "projects", label: "nav.projects", icon: FolderOpen },
    ],
  },
  {
    group: "nav.groupApp",
    items: [{ id: "settings", label: "nav.settings", icon: Settings }],
  },
];

/** `⌘N` = 侧边栏从上往下第 N 项(macOS 惯例)。由 {@link NAV} 推出,不手写。 */
export const PAGE_ORDER: PageId[] = NAV.flatMap((g) => g.items.map((i) => i.id));
