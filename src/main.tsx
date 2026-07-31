import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAppearance } from "./store/appearance";
import { bindAppearanceToConfig, syncUiPrefs } from "./store/prefs";
import "./styles/global.css";

// 在首帧之前就把 data-theme / data-accent 写好,否则会先闪一下默认浅色。
// 同时挂上系统主题监听——「跟随系统」要求切换时实时生效。
initAppearance();
// 偏好落盘(M2 任务 1):先挂"外观一变就写 config"的订阅,再做启动同步
// (config 有值则回灌覆盖缓存;从未设置过则拿缓存现状一次性迁移进 config)。
bindAppearanceToConfig();
void syncUiPrefs();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
