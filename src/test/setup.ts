// vitest 全局前置。
//
// 个别测试用 `// @vitest-environment node`(纯读文件、不碰 DOM),这份前置对它们也会执行,
// 所以每一步都要先确认 DOM 在不在——否则那些测试会死在 "window is not defined" 上。
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  installIntersectionObserverMock,
  resetIntersectionObservers,
} from "./intersection-observer";

const hasDom = typeof window !== "undefined";

if (hasDom) {
  // Node 26 起在 globalThis 上自带 localStorage/sessionStorage 的 accessor 属性
  // (无 --localstorage-file 时 getter 返回 undefined)。vitest 往全局拷 jsdom window
  // 属性时,对这种已存在的 accessor 走的是赋值(触发 Node 的 setter,值被丢弃),
  // 而且 vitest 里 window 就是 globalThis——jsdom 的 Storage 实现从两条路都拿不回来。
  // 症状:45 个用到 localStorage 的测试整片假红,而 CI(Node 22)全绿。
  // 只能补一个内存级 shim;defineProperty 才能真正换掉 accessor,赋值只会再喂一次 setter。
  const makeStorageShim = (): Storage => {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k: string) => m.get(k) ?? null,
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
    };
  };
  for (const key of ["localStorage", "sessionStorage"] as const) {
    if (typeof globalThis[key] === "undefined") {
      Object.defineProperty(globalThis, key, { value: makeStorageShim(), configurable: true });
    }
  }

  // 没开 `globals` 时 testing-library 不会自己注册 afterEach,渲染结果会在用例之间累积
  // ——症状是查询突然报 "found multiple elements",而被测代码其实没问题。
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);

  // jsdom 不实现 IntersectionObserver,而广场列表的"滚到底自动加载更多"靠它。
  // 默认装一个**不会自己触发**的替身:绝大多数用例不关心滚动,装上之后它们的
  // 表现与真实浏览器里"首屏还没滚到底"一致(只渲染第一批);要测追加加载的用例
  // 自己 import `triggerIntersection()` 显式触发。
  installIntersectionObserverMock();
  afterEach(resetIntersectionObservers);

  // jsdom 不实现 matchMedia,而"跟随系统主题"就靠它。默认按浅色作答,
  // 需要断言深色的用例自行覆写 window.matchMedia。
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
}
