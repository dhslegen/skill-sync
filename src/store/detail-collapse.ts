import { create } from "zustand";

/**
 * 详情面板「在哪」折叠头的展开状态(v7.1 任务 3,Q2 拍板)。
 *
 * # 与 `store/mine-collapse.ts` 极性相反,别照抄那边的存法
 *
 * 「我的技能」三区**默认全部展开**,所以那边持久化的是"被折叠了的那几个区"
 * ——用户没做过任何选择时读出空数组,恰好等于全展开。
 *
 * 这里恰好反过来:「在哪」三块**默认收起**(Q1A「md 是主角」的直接推论——
 * 详情面板打开时先看到的必须是正文,不是三块位置信息)。所以持久化的是
 * "用户主动展开过"这一个标记,读不到 / 读坏了一律当作**收起**。
 * 两个 store 刻意不合并:一个是分区级的多键集合、默认展开,一个是面板级的
 * 单一开关、默认收起,合成一个只会让两边的默认值互相绊住。
 *
 * # 落 localStorage,不落 `config.ui`
 *
 * 与 `mine-collapse` 同一个理由:`config.json` 的 `ui` 是 `Option`,`None` 有
 * 独立语义(从未设置过外观 → 前端做一次性的 localStorage 迁移,见
 * `store/prefs.ts`)。往里写第一个值就会把它物化成 `Some(默认值)`,用户存在
 * localStorage 里的主题会当场丢失。折叠是纯本机的视图偏好,没有跨机器同步的价值。
 *
 * 读写都包 try/catch:隐私模式、禁站点数据等场景下访问器本身会抛,不该拖垮页面。
 */
const KEY = "skillsync.detailWhereExpanded";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function persist(expanded: boolean) {
  try {
    localStorage.setItem(KEY, expanded ? "1" : "0");
  } catch {
    // 存不下就算了,本次会话内仍然生效
  }
}

interface DetailCollapseState {
  whereExpanded: boolean;
  toggleWhere: () => void;
}

export const useDetailCollapse = create<DetailCollapseState>((set, get) => ({
  whereExpanded: read(),
  toggleWhere: () => {
    const next = !get().whereExpanded;
    persist(next);
    set({ whereExpanded: next });
  },
}));
