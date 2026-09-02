// 把 `window.__TAURI_INTERNALS__` 的假实现装进页面(v7.1 任务 2)。
//
// 🔴 **零生产代码改动**是这个 harness 的硬约束。`src/lib/ipc.ts` 通过
// `@tauri-apps/api` 调用,而那个包最终只碰 `window.__TAURI_INTERNALS__` 的
// 五个成员(`invoke` / `transformCallback` / `unregisterCallback` /
// `convertFileSrc` / `metadata`)。所以注入点在**这里**,`src/` 里一行不动。
//
// 注入必须走 `addInitScript`:它在页面每个文档的**任何脚本之前**执行,
// 而 `@tauri-apps/api/core` 在模块求值时就可能读到这个对象。用
// `page.evaluate` 事后补是来不及的。

/**
 * @param {import('playwright-core').Page} page
 * @param {ReturnType<import('./fixtures.mjs').buildFixtures>} fixtures
 */
export async function installTauriMock(page, fixtures) {
  await page.addInitScript((data) => {
    /** 已注册的事件回调:`transformCallback` 发号,`plugin:event|listen` 记名。 */
    const callbacks = new Map();
    let nextId = 1;

    /** 记下这一趟跑过哪些 command,截图脚本收尾时打出来——
     *  fixture 覆盖不全的时候要一眼看得出来。 */
    const seen = [];

    function indexKeyFor(args) {
      const a = (args && args.args) || {};
      const registryId = a.registryId || "company";
      const repo = a.repo || (registryId === "company" ? "skills/skills" : "");
      return `${registryId}::${repo}`;
    }

    function route(cmd, args) {
      // ---- Tauri 事件系统。App.tsx 启动路径上有两条 listen,不接就是未捕获拒绝
      if (cmd === "plugin:event|listen") return nextId++;
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "plugin:event|emit") return null;
      if (cmd.startsWith("plugin:opener|")) return null;
      if (cmd.startsWith("plugin:window|")) return null;

      if (cmd === "store_index") {
        const hit = data.indexes[indexKeyFor(args)];
        if (hit) return hit;
        // 未知的库:与 core 一样报错,而不是回一份空索引冒充"这个库是空的"
        throw { code: "REPO_UNKNOWN_REPO", message: "harness 没有为这个技能库准备索引" };
      }
      if (cmd === "skill_local_detail") {
        const a = (args && args.args) || {};
        const hit =
          data.localDetails[a.path] ||
          Object.values(data.localDetails).find((d) => d.dirSlug === a.dirSlug);
        if (hit) return hit;
        throw { code: "FS_NOT_FOUND", message: "harness 没有为这个技能准备本地详情" };
      }

      if (Object.prototype.hasOwnProperty.call(data.responses, cmd)) {
        return data.responses[cmd];
      }
      // 🔴 默认分支必须**吵**。回一个空对象的话,界面会画出一屏看起来像
      // 应用缺陷的空白,而真正的原因只是 fixture 没覆盖到这条 command。
      throw { code: "MOCK_MISSING", message: `harness 未覆盖的 command:${cmd}` };
    }

    const internals = {
      invoke(cmd, args) {
        seen.push(cmd);
        return new Promise((resolve, reject) => {
          try {
            resolve(route(cmd, args));
          } catch (e) {
            reject(e);
          }
        });
      },
      transformCallback(callback, once) {
        const id = nextId++;
        callbacks.set(id, { callback, once });
        return id;
      },
      unregisterCallback(id) {
        callbacks.delete(id);
      },
      convertFileSrc(path) {
        return path;
      },
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    };

    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: internals, writable: true });
    // `@tauri-apps/api/event` 的 unlisten 走的是**另一个**全局对象,不是 INTERNALS。
    // 少了它,App.tsx 卸载两条常驻监听时会抛 "Cannot read properties of undefined
    // (reading 'unregisterListener')" —— 不致命,但会把真正的错误淹在噪音里。
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: { unregisterListener() {} },
      writable: true,
    });
    // 截图脚本用它做收尾诊断
    Object.defineProperty(window, "__VISUAL_HARNESS__", { value: { seen }, writable: true });
  }, fixtures);
}
