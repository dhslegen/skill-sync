// jsdom 不实现 IntersectionObserver,而技能广场列表的"滚到底自动加载更多"
// (`StorePage.tsx` 的 `PlazaCardGrid`)正是靠它。这里装一个可手动触发的替身:
// 真实浏览器里由滚动触发,测试里由 {@link triggerIntersection} 显式触发。
//
// ⚠️ **断开的观察者必须不再触发**:被测组件每加载一批就重建一次观察者
// (effect 依赖里带着已渲染条数),旧的那个在 cleanup 里 `disconnect()`。
// 这里若不把它从 `live` 里摘掉,一次触发会同时打到新旧两个回调上,一次加载两批
// ——断言会漂,而实现其实是对的(这类"测试替身自己制造的假象"是本项目吃过亏的
// 空转/假红温床,所以宁可在替身里多写这几行)。

type Callback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void;

const live = new Set<FakeIntersectionObserver>();

class FakeIntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[] = [0];
  private readonly targets = new Set<Element>();
  private readonly callback: Callback;

  constructor(callback: Callback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.rootMargin = options?.rootMargin ?? "0px";
    live.add(this);
  }

  observe(el: Element) {
    this.targets.add(el);
  }

  unobserve(el: Element) {
    this.targets.delete(el);
  }

  disconnect() {
    this.targets.clear();
    live.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  fire(isIntersecting: boolean) {
    if (this.targets.size === 0) return;
    const entries = [...this.targets].map(
      (target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/** 装上替身(全局 setup 调用一次)。用 defineProperty 是为了在 Node 26 那种
 *  全局已有同名 accessor 的环境里也能真正换掉——与 localStorage shim 同一个理由。 */
export function installIntersectionObserverMock() {
  Object.defineProperty(globalThis, "IntersectionObserver", {
    value: FakeIntersectionObserver,
    configurable: true,
    writable: true,
  });
}

/**
 * 触发所有仍然活着的观察者。
 *
 * `isIntersecting: false` 也要能发出去——真实 IntersectionObserver 在 `observe()`
 * 那一刻就会用**当前**状态回调一次(哨兵在首屏之下时就是 false),被测代码必须
 * 据此判断而不是"回调来了就加载"。测试要能钉住这条。
 */
export function triggerIntersection(isIntersecting = true) {
  for (const observer of [...live]) observer.fire(isIntersecting);
}

/** 用例之间清账:组件正常卸载会 disconnect,但断言失败提前退出等情况会留下残余。 */
export function resetIntersectionObservers() {
  live.clear();
}
