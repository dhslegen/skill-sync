import { t } from "./i18n";

// M1 任务 1:空壳窗口。页面骨架(侧边栏/商店/我的技能/分享/设置)从任务 8 起实现。
function App() {
  return (
    <main className="grid h-full place-items-center">
      <div className="text-center">
        <h1 className="text-base font-semibold tracking-tight">{t("app.name")}</h1>
        <p className="mt-1 text-text-2">{t("app.tagline")}</p>
      </div>
    </main>
  );
}

export default App;
