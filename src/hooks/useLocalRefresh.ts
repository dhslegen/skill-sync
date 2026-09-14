// 本地技能变更的实时刷新(M4 任务 6c)。
//
// 要解决的体验:用户在编辑器里改完 SKILL.md 切回应用,列表还是旧的——
// 两个页面都只有 `useEffect(() => void load(), [load])`,而 `load` 是 zustand 的
// 稳定引用,依赖数组永远不变,所以它**只在组件挂载时跑一次**。前端此前从未监听过
// 窗口焦点事件,"切出去改完再切回来"这条桌面应用最基本的路径整个没人管。
//
// 更尴尬的是新建向导的完成页自己写着「然后回到这一页分享给团队」,而回到这一页
// 看到的却是旧状态——引导语与实现脱节。
//
// 三级刷新(用户 2026-08-04 明确要求全做):
//   1. 窗口重获焦点 —— 本文件,覆盖"切到编辑器改完切回来"这条主路径;
//   2. 切换页面 —— 「我的技能」「项目」页组件挂载时 load;商店页的索引由 App 启动拉一次,
//      切回商店时由本文件补一次只读刷新(0.6.x 对齐:此前点另外两页会刷、点商店不会);
//   3. 文件系统监听 —— core 侧 watcher,另行接入。
//   4. 5 分钟只读兜底(0.6.x)—— 覆盖"库里变了"这件前三级都收不到信号的事,
//      见 `refreshPeriodicallyFor`。顶栏刷新按钮的按页语义见 `refreshManuallyFor`。
//
// **只刷当前页需要的东西**:无脑全刷会在每次切窗口时打三次 IPC,而其中两次的结果
// 没人看。`load` 只写列表不碰表单(已确认),所以刷新不会打断正在填的分享表单。
import { useEffect, useRef } from "react";

import { listenLocalSkillsChanged } from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useMySkills } from "@/store/my-skills";
import { useProjects } from "@/store/project";
import { useStoreIndex } from "@/store/store-index";
import { useUi, type PageId } from "@/store/ui";

/** 按页刷新本地技能相关的状态。导出供 level 3 的文件监听复用。 */
export function refreshLocalFor(page: PageId): void {
  switch (page) {
    case "mine":
      // 🔴 v7 任务 7 修复轮 1(I3,用户拍板):「可分享到」外源索引的**被动
      // 每小时兜底**接在这里(级别 1 窗口重获焦点 / 级别 3 文件监听),刻意
      // **不**接在 `load()` 本身——`MySkillsPage` 挂载/切页(级别 2)只直接调
      // `load()`,不经过这个函数,所以"翻开这一页"这个动作本身不产生任何
      // `ensureShareableIndexes` 请求。
      //
      // 🔴 **必须 `await load()` 之后再调,不能两个都 `void` 平行发出**:
      // `ensureShareableIndexes` 读的是 `get().list` 这份**同步快照**,如果
      // 跟 `load()` 同一拍触发,读到的是上一轮的旧列表(`installed_list` 还没
      // 返回),新出现的 shareable 行这一轮会被漏掉、要等下一次刷新才追上
      // ——这里链式等待,保证喂给它的 `list` 是这一轮刚读到的那份。
      void (async () => {
        await useMySkills.getState().load();
        await useMySkills.getState().ensureShareableIndexes();
      })();
      break;
    case "store":
      // 已装技能可能在外部被删掉了,回来该显示「获取」而不是「已启用」
      void useInstall.getState().refreshInstalled();
      // v7.5 起卡片「已在电脑上」读的是本机技能列表(磁盘是真相),只刷记账跟不上外部删改
      void useMySkills.getState().load();
      break;
    case "projects":
      // v7.3:项目页独立成页之后也要接进级别 1/3——它展示的同样是磁盘上的
      // 真实内容(项目根的 `skills-lock.json` 与各工具目录),切到编辑器里
      // 删掉一个技能再切回来,不刷新就会一直显示一条已经不存在的行。
      void useProjects.getState().load();
      break;
    case "settings":
      // 设置页不展示技能,无需刷新
      break;
  }
}

/** 只读兜底刷新的间隔。与设置里「技能更新检查」档位无关(那个会安装)。 */
export const PERIODIC_REFRESH_MS = 5 * 60_000;

/**
 * 5 分钟只读兜底(级别 4,0.6.x,2026-09-14 用户拍板「只读刷新恒定 5 分钟」)。
 *
 * 焦点/切页/文件监听三级都是"本地变了"的信号;**库里变了**(同事分享了新版)
 * 之前没有任何信号能让打开着的页面知道——scheduler 只在有已装技能、且档位不是
 * 「手动」时才跑,而且它的职责是安装。这一级补上"不点也会跟上"。
 *
 * 🔴 **只读**:只调各页已有的读取路径,绝不走 `updateAll`/`acquire`——安装与否仍然
 * 只由设置里的档位决定。
 * - `store`:非强制检查当前技能库(head 没变就零下载)+ 重读已装状态;广场搜索态
 *   `load` 自己早退,不会替用户重新搜索。
 * - `mine`:与级别 1 相同(重扫 + 外源每小时节流)再加非强制检查技能库——「有更新」
 *   比对的正是那份索引。
 * - `projects`:重读项目文件夹(项目目录不在文件监听里,这是它唯一的被动刷新)。
 *
 * ⚠️ 与 scheduler 的 tick 可能撞在同一分钟,各查一次 head,无害,不去协调。
 */
export function refreshPeriodicallyFor(page: PageId): void {
  switch (page) {
    case "store":
      void useStoreIndex.getState().load(false);
      refreshLocalFor("store");
      break;
    case "mine":
      void useStoreIndex.getState().load(false);
      refreshLocalFor("mine");
      break;
    case "projects":
      refreshLocalFor("projects");
      break;
    case "settings":
      break;
  }
}

/**
 * 顶栏刷新按钮:用户**明确要求**重新获取当前页展示的东西(0.6.x,2026-09-14 用户拍板
 * 「每页各自的语义」)。与 `refreshLocalFor`(被动、只读本地)的差别是它可以联网、可以
 * 绕过节流——用户按下了按钮,就不该被"一小时内查过了"挡回去。
 *
 * - `store`:强制重建当前技能库索引(M7 那个「缓存挡住新字段」的逃生口就是这一下),
 *   顺带重读已装状态。广场搜索态不走这里(Toolbar 按当前词重新提交搜索)。
 * - `mine`:先重新扫描本地,再用非强制方式检查库里有没有新版(head 没变就零下载),
 *   并对「可分享到」区的外源**不看节流**逐个查一次。
 *   ⚠️ 「有更新」比对的是商店页此刻选中的那个技能库索引(`hasUpdate` 读
 *   `useStoreIndex.index`)——既有耦合,这里只是如实刷新它,不加深也不拆。
 * - `projects`:重读项目文件夹。
 * - `settings`:没有按钮,不会走到。
 */
export function refreshManuallyFor(page: PageId): void {
  switch (page) {
    case "store":
      void useStoreIndex.getState().load(true);
      void useInstall.getState().refreshInstalled();
      break;
    case "mine":
      void (async () => {
        // 与 `refreshLocalFor` 同一个理由链式等待:外源检查读的是 `list` 同步快照
        await Promise.all([useMySkills.getState().load(), useStoreIndex.getState().load(false)]);
        const shareable = (useMySkills.getState().list ?? [])
          .filter((s) => s.section === "shareable")
          .map((s) => s.dirSlug);
        await useMySkills.getState().ensureShareableIndexes(shareable);
      })();
      break;
    case "projects":
      void useProjects.getState().load();
      break;
    case "settings":
      break;
  }
}

/**
 * 窗口重获焦点时刷新当前页(级别 1)。
 *
 * 用 ref 存当前页而不是把 `page` 放进依赖数组:那样每次切页都要重新注册一次
 * 原生监听,而我们要的只是"回来时刷新此刻这一页"。
 */
export function useLocalRefresh(): void {
  const page = useUi((s) => s.page);
  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        // 动态 import:浏览器里(vitest / vite dev 直开)没有 Tauri runtime,
        // 顶层 import 会让整个模块加载失败,连级别 2 都跟着废掉
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const stop = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) refreshLocalFor(pageRef.current);
        });
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // 注册不上就降级到级别 2 与 3,不拦任何东西——刷新是锦上添花,
        // 挂掉它不该让应用少一块功能
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 级别 2 的商店那一半(0.6.x):另外两页挂载即 load,商店的索引只在 App 启动时拉一次,
  // 于是"点另外两页会刷新、点商店不会"。**只在页面真的变成商店时刷**:启动时 App 已经拉过。
  // ⚠️ 不能写成"跳过首次 effect":开发版 StrictMode 挂载时把 effect 跑两遍,ref 保留,
  // 第二遍就会当成"切过来了"再拉一次。比较上一页才对双跑免疫。
  const prevPage = useRef(page);
  useEffect(() => {
    if (prevPage.current === page) return;
    prevPage.current = page;
    if (page === "store") refreshPeriodicallyFor("store");
  }, [page]);

  // 级别 4:5 分钟只读兜底(0.6.x)。见 `refreshPeriodicallyFor`。
  useEffect(() => {
    const timer = setInterval(() => {
      void (async () => {
        // 缩到托盘时暂停。两道都查:WebView 对"窗口被 hide"未必同步报 visibilityState,
        // 而 Tauri 的 isVisible 在浏览器环境里取不到——哪道说"看不见"都不刷。
        if (document.visibilityState === "hidden") return;
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          if (!(await getCurrentWindow().isVisible())) return;
        } catch {
          // 取不到窗口状态就按可见处理:只读刷新,多刷一次无害
        }
        refreshPeriodicallyFor(pageRef.current);
      })();
    }, PERIODIC_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // 级别 3:core 侧的文件监听。窗口有焦点时改动也能立刻反映
  //(应用和编辑器并排放着的用法)。core 滤掉了本应用自己写盘引发的事件
  // ——但那份过滤名单是人工维护的,漏持守卫的写盘会让这一级在动作进行到一半时
  // 替换整张列表(终审 I-3 的现场)。完整说明见 `lib/ipc.ts` 的
  // `listenLocalSkillsChanged`。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenLocalSkillsChanged(() => refreshLocalFor(pageRef.current))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // 监听不上就降级到级别 1 与 2
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
