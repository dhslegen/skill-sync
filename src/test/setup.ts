// vitest 全局前置。
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// 没开 `globals` 时 testing-library 不会自己注册 afterEach,渲染结果会在用例之间累积
// ——症状是查询突然报 "found multiple elements",而被测代码其实没问题。
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
