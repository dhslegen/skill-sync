import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAppearance } from "./store/appearance";
import "./styles/global.css";

// 在首帧之前就把 data-theme / data-accent 写好,否则会先闪一下默认浅色。
// 同时挂上系统主题监听——「跟随系统」要求切换时实时生效。
initAppearance();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
