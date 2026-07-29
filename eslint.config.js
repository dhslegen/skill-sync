import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // scripts/ 是 Node 维护脚本(非应用代码),用的是 node 全局环境,不纳入前端 lint 规则
  { ignores: ["dist/", "src-tauri/target/", "node_modules/", "scripts/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
