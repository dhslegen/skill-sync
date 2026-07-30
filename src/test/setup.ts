// vitest 全局前置。
//
// 个别测试用 `// @vitest-environment node`(纯读文件、不碰 DOM),这份前置对它们也会执行,
// 所以每一步都要先确认 DOM 在不在——否则那些测试会死在 "window is not defined" 上。
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

const hasDom = typeof window !== "undefined";

if (hasDom) {
  // 没开 `globals` 时 testing-library 不会自己注册 afterEach,渲染结果会在用例之间累积
  // ——症状是查询突然报 "found multiple elements",而被测代码其实没问题。
  const { cleanup } = await import("@testing-library/react");
  afterEach(cleanup);

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
