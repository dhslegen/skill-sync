import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/*
 * 测试配置。这份文件优先于 vite.config.ts,后者里的 test 字段不会被读到
 * ——任务 8 在这里踩过一次:症状是 environment 静默停留在 node,
 * 报错只说 "localStorage is not defined",看不出配置根本没生效。
 *
 * 组件测试要真 DOM:IME 组合输入、快捷键让路、焦点管理这些只有在 jsdom 上才测得准。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
