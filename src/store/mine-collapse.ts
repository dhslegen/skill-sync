import { create } from "zustand";

import type { Section } from "@/lib/ipc";

/**
 * 「我的技能」三区的折叠状态(用户真机反馈:条目一多就得一路滚)。
 *
 * # 🔴 落 localStorage,**绝不**落 `config.ui`
 *
 * `config.json` 的 `ui` 字段是 `Option`,而 `None` 有独立语义("从未设置过外观"
 * → 前端做一次性的 localStorage 迁移,见 `store/prefs.ts`)。往里写第一个值就会
 * 把它物化成 `Some(默认值)`,**用户存在 localStorage 里的主题会当场丢失**——
 * 一个与外观毫无关系的动作毁掉外观设置(`CLAUDE.md` 记的 M11 教训,那次是
 * `lastSeenVersion` 因此被放在 config 顶层而不是 `ui` 里)。
 * 折叠是纯本机的视图偏好,本来也没有跨机器同步的价值。
 *
 * # 默认全部展开
 *
 * 第一次打开就折着会让用户以为技能丢了——"收起来"应当是他自己做过的选择才被
 * 记住。所以只持久化**折叠了的**那几个区(存成一个 key 数组),读不到 / 读坏了
 * 一律当作全展开。
 *
 * 读写都包 try/catch:隐私模式、禁站点数据等场景下访问器本身会抛,不该拖垮页面。
 */
const KEY = "skillsync.mineCollapsed";

const SECTIONS: Section[] = ["installedFrom", "sharedTo", "shareable"];

function read(): Section[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 只认识的区名才收——存量里混进别的字符串(改过区名、手工改过这条记录)
    // 不该让整份状态失效,过滤掉即可。
    return SECTIONS.filter((s) => parsed.includes(s));
  } catch {
    return [];
  }
}

function persist(collapsed: Section[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(collapsed));
  } catch {
    // 存不下就算了,本次会话内仍然生效
  }
}

interface MineCollapseState {
  collapsed: Section[];
  toggle: (key: Section) => void;
}

export const useMineCollapse = create<MineCollapseState>((set, get) => ({
  collapsed: read(),
  toggle: (key) => {
    const next = get().collapsed.includes(key)
      ? get().collapsed.filter((k) => k !== key)
      : [...get().collapsed, key];
    persist(next);
    set({ collapsed: next });
  },
}));
