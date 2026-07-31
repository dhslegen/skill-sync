// 偏好的落盘协调:config.json 是最终归宿(跨机器、随备份走),localStorage 只是
// 本机缓存——它能在首帧前同步读到,避免主题闪一下默认色。
//
// 同步方向只有一条:**config 有值则 config 赢**(缓存被回灌);config 从未设置过
// 则拿缓存里的现状做一次性迁移写入。IPC 读失败(测试环境、极端故障)时本次会话
// 退回纯缓存行为,且绝不往 config 写——拿猜出来的值覆盖真数据比"这次没同步"糟得多。
import { uiPrefsGet, uiPrefsSet, type UiPrefs } from "@/lib/ipc";
import { useAppearance } from "@/store/appearance";

/** 向导完成标记的缓存键。config 不可用时它就是唯一依据(与 M1 行为一致)。 */
export const WIZARD_DONE_KEY = "skillsync.wizardDone";

/** 同步成功后 = "config 里应有的当前值",此后随每次 push 更新;
 *  null = 尚未同步或同步失败(不可写)。 */
let known: UiPrefs | null = null;
let syncPromise: Promise<void> | null = null;
/** 正在把 config 的值回灌进 appearance store:此间的变化不要再推回 config。 */
let applying = false;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 缓存写不进不致命,下次启动从 config 恢复
  }
}

function assembleFromLocal(): UiPrefs {
  const { mode, accent } = useAppearance.getState();
  return { theme: mode, accent, wizardDone: safeGet(WIZARD_DONE_KEY) !== null };
}

/**
 * 启动同步只做一次;之后每次调用都返回**当下**的已知值——向导在同一会话里
 * 完成后再查,拿到的是 push 过的新值,而不是启动那一刻的快照。
 * IPC 不可用(或迁移写入失败)返回 null,调用方退回 localStorage 缓存。
 */
export function syncUiPrefs(): Promise<UiPrefs | null> {
  syncPromise ??= doSync();
  return syncPromise.then(() => known);
}

async function doSync(): Promise<void> {
  let stored: UiPrefs | null;
  try {
    stored = await uiPrefsGet();
  } catch {
    return;
  }

  if (!stored) {
    // 一次性迁移:把本机现状(含 M1 存下的旧 localStorage 值)写成 config 的初值
    const migrated = assembleFromLocal();
    try {
      await uiPrefsSet(migrated);
      known = migrated;
    } catch {
      // 写不进就保持"不可写"状态,下次启动再试
    }
    return;
  }

  known = stored;
  applying = true;
  try {
    const appearance = useAppearance.getState();
    appearance.setMode(stored.theme); // setMode/setAccent 会顺手刷新 localStorage 缓存
    appearance.setAccent(stored.accent);
  } finally {
    applying = false;
  }
}

/** 偏好变化后推完整值到 config。没同步成功过就不推——不拿猜的值覆盖真数据。 */
function push(patch: Partial<UiPrefs>) {
  if (!known) return;
  known = { ...known, ...patch };
  void uiPrefsSet(known).catch(() => {
    // 推失败不打断当前会话(本次仍生效),下次启动同步会再对齐
  });
}

/** 向导完成:缓存与 config 双写。 */
export function markWizardDone() {
  safeSet(WIZARD_DONE_KEY, "1");
  push({ wizardDone: true });
}

/**
 * 挂上"外观一变就推 config"的订阅。启动时(main.tsx)调一次,返回退订函数。
 * 回灌期间(applying)的变化来自 config 本身,不再推回去,免得每次启动空写一轮。
 */
export function bindAppearanceToConfig(): () => void {
  return useAppearance.subscribe((s, prev) => {
    if (applying) return;
    if (s.mode !== prev.mode || s.accent !== prev.accent) {
      push({ theme: s.mode, accent: s.accent });
    }
  });
}

/** 仅测试用:清掉模块级缓存,让每条用例从"未同步"状态出发。 */
export function resetPrefsForTests() {
  known = null;
  syncPromise = null;
  applying = false;
}
