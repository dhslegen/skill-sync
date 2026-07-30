// 外观:主题三档 + 强调色三色。全套走 CSS 变量(global.css 的 data-theme / data-accent),
// 这里只负责决定"当前该是哪一档"并同步到 <html>。
//
// 假设(文档未覆盖):偏好先存 localStorage。设置页要把它落进 config.json 才算跨机器,
// 那是设置页所在任务的事;M1 任务 8 不动 config 的 schema。
import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type Accent = "clay" | "teal" | "ink";

const THEME_KEY = "skillsync.theme";
const ACCENT_KEY = "skillsync.accent";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];
const ACCENTS: Accent[] = ["clay", "teal", "ink"];

function readStored<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    // 隐私模式等场景下 localStorage 可能抛错,不该拖垮启动
    return fallback;
  }
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不下就算了,本次会话内仍然生效
  }
}

export function systemPrefersDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

/** 三档模式 + 系统偏好 → 实际生效的主题。 */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

interface AppearanceState {
  mode: ThemeMode;
  accent: Accent;
  /** 系统当前是否深色。跟随系统时由 matchMedia 事件驱动。 */
  prefersDark: boolean;
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: Accent) => void;
  /** 顶栏那个图标按钮:在浅色/深色之间切,不进"跟随系统"(那一档在设置里选)。 */
  toggleTheme: () => void;
  setPrefersDark: (prefersDark: boolean) => void;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  // 主题默认浅色(C-UI 已拍板)
  mode: readStored<ThemeMode>(THEME_KEY, THEME_MODES, "light"),
  accent: readStored<Accent>(ACCENT_KEY, ACCENTS, "clay"),
  prefersDark: typeof window === "undefined" ? false : systemPrefersDark(),
  setMode: (mode) => {
    persist(THEME_KEY, mode);
    set({ mode });
  },
  setAccent: (accent) => {
    persist(ACCENT_KEY, accent);
    set({ accent });
  },
  toggleTheme: () => {
    const { mode, prefersDark } = get();
    get().setMode(resolveTheme(mode, prefersDark) === "dark" ? "light" : "dark");
  },
  setPrefersDark: (prefersDark) => set({ prefersDark }),
}));

/** 把状态同步到 <html> 的 data 属性上。CSS 变量整套换肤就靠这两个属性。 */
function applyToDocument(mode: ThemeMode, accent: Accent, prefersDark: boolean) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(mode, prefersDark);
  root.dataset.accent = accent;
}

/**
 * 启动时调一次:立刻同步一次 DOM,并订阅系统主题变化。
 * 「跟随系统」要求实时生效(UI 规范 §6.5),所以必须挂 matchMedia 的 change 事件,
 * 只在启动时读一次是不够的。
 */
export function initAppearance(): () => void {
  const { mode, accent, prefersDark } = useAppearance.getState();
  applyToDocument(mode, accent, prefersDark);

  const unsubscribe = useAppearance.subscribe((s) =>
    applyToDocument(s.mode, s.accent, s.prefersDark),
  );

  const media = window.matchMedia?.(DARK_QUERY);
  const onChange = (e: MediaQueryListEvent) =>
    useAppearance.getState().setPrefersDark(e.matches);
  media?.addEventListener?.("change", onChange);

  return () => {
    unsubscribe();
    media?.removeEventListener?.("change", onChange);
  };
}
