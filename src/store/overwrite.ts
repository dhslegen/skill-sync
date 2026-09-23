import { create } from "zustand";
import type { LocalSkillTarget, OverwriteWarning, SharePlan, StaleReason } from "@/lib/ipc";

/**
 * 一次待拍板的分享(v8 任务 4 / 决策 D2,任务 5 / D9 扩成统一确认屏)。
 *
 * 「这次分享会让技能库有哪些变化」这件事有**两个发起方**走这个 store
 * (「分享改动」与获取冲突里的「保留并分享」);「可分享到」区那条路有自己的
 * 确认屏(`ShareConfirm`),那一屏在同一处渲染同一份清单——**一个动作一屏**
 * 是 D9 的原话,不是先弹覆盖框再弹清单框。
 *
 * 🔴 **渲染点必须是全局的**:从商店详情发起时 `MySkillsPage` 根本没挂载,
 * 从「我的技能」发起时它被详情面板的遮罩盖着。本项目已经因为"错误写进了
 * 状态却没有渲染点"被打回六次,这一条不重蹈。
 */
export interface OverwriteDecision {
  /** 哪个技能。用于归属校验与文案点名——绝不显示别的技能的拍板信息。 */
  dirSlug: string;
  /** 技能展示名(拿不到时发起方传 dirSlug)。 */
  name: string;
  /**
   * 这次会新增/修改/**删除**哪些文件(v8 任务 5)。它是这一屏存在的主要理由:
   * 覆盖警告是"可能有"(`warning` 为 `null` 就是没人被顶掉),清单是"一定有"
   * ——差集为空时 core 根本不会走到这里(那一档是「库里已与本地一致」)。
   */
  plan: SharePlan;
  /**
   * 确认屏上点开「新增」文件、切到「全文」时,**去哪个目录读本地字节**(v8 定向复审 I-1)。
   *
   * 🔴 **必须与 core 算这份清单时定位本体的方式一致**,看到的才是要推的那一份。
   * 两个发起方走的是两条不同的 core 通道,定位方式也不同:
   * - `share_installed`(「分享改动」有安装基线 /「保留并分享」)按 `dirSlug` 找本体
   *   (`converge::home_of`),传 `{ dirSlug }`;
   * - 没有安装基线的「分享改动」改走 `share()`,它用 `converge::locate` **扫描**出本体
   *   ——无记账、本体住在工具目录、canonical 下没有链接时,`home_of` 按 `dirSlug`
   *   只会给出 canonical 下一个不存在的路径,新增文件与「全文」一律读不出来。
   *   这一支传 `{ path: <那一行的 body> }`(「我的技能」那一行的 `body` 就是
   *   `locate` 的结果,与 `ShareConfirm` 同一个理由)。
   *
   * **必填**:让 `tsc` 逼每个发起方都表态,别再有人照着"两个发起方都走同一条通道"
   * 这种已经不成立的前提默认一个。
   */
  localTarget: LocalSkillTarget;
  /**
   * 库里那一版还会被顶掉时的警告,摆在清单**顶部**。
   * `null` = 库里那一版与本地基线一致,没有人会被顶掉,这一段整条不摆。
   */
  warning: OverwriteWarning | null;
  /**
   * `true` = 用户上一次按过确认,但技能库在他看清单的这段时间里又变了,这是
   * **重新算出来的**第二份清单(终审 C-1)。界面据此如实说一句;静默换掉清单,
   * 用户会以为自己看花了眼,而这一屏最重要的那一栏是"库里哪几个文件会没"。
   */
  stale: boolean;
  /**
   * 变的是库里那一头(别人推了东西)还是本地这一头(编辑器/用户自己改的)。
   * 🔴 **两种原因是两句不同的话**,指向的下一步也不同——合成一句就是对其中
   * 一半用户说假话(v8 任务 8 / 顾问①)。
   *
   * 🔴 **必填**(v8 任务 10 收口):可选的时候,漏传的发起方会静默落回「库里变了」
   * 那一句——对本地改了的人说是同事改的。必填之后漏传的地方 `tsc` 当场指出来。
   */
  staleReason: StaleReason | null;
  /**
   * 用户按「仍然覆盖」时重跑的那一跳。
   *
   * 🔴 **由发起方带着自己的上下文闭包进来**,不在这里重新拼参数:三个发起方
   * 各自要带的东西不同(目标库坐标、registryId、要不要先 `run("keepLocal")`),
   * 在确认屏里重算一遍就是把"分享去哪"这个判断抄成第二份——而本项目记着
   * 「显示与提交分两处算就会出现"确认屏说推去 A、实际推去 B"」。
   *
   * 🔴 **契约:它必须自己把失败写进自己那条既有的渲染点**
   * (`useMySkills.shareError` / `useInstall.shareResult`,两者都已在界面上)。
   * 这个 store 不另设一处错误状态——那会变成同一件事两个说法,而且
   * "覆盖这一跳失败了"与"分享失败了"本来就是同一句话。
   */
  confirm: () => Promise<void>;
}

interface OverwriteState {
  pending: OverwriteDecision | null;
  /**
   * 第几次 `ask`(v8 任务 10)。确认屏里展开过的文件内容属于**那一份**清单;
   * 重算过的第二份清单进来时,界面按它换一个 key 把展开状态清掉——
   * 过期的差异留在屏上,等于让用户照着旧清单点确认。
   */
  round: number;
  busy: boolean;
  ask: (decision: OverwriteDecision) => void;
  confirmOverwrite: () => Promise<void>;
  /** 「先不动」:只清状态,**零 IPC**。 */
  cancel: () => void;
}

export const useOverwrite = create<OverwriteState>((set, get) => ({
  pending: null,
  busy: false,
  round: 0,

  ask: (decision) => set({ pending: decision, busy: false, round: get().round + 1 }),

  confirmOverwrite: async () => {
    const pending = get().pending;
    if (!pending) return;
    set({ busy: true });
    try {
      await pending.confirm();
    } finally {
      // 成功与失败都关掉:失败的那句话由发起方写进它自己那条渲染点
      // (见 `confirm` 的契约)。`finally` 而不是 `then`——发起方万一漏了
      // 一条 catch,弹窗也不能永远停在忙碌态。
      //
      // 🔴 **除非这一跳自己又 `ask` 了一次**(终审 C-1):技能库在用户看清单的
      // 这会儿又变了,core 不提交、退回一份**重算过的**清单。无条件清空会把它
      // 连同那句"这是重新算出来的"一起关掉,用户看到的就是"点了确认,弹窗没了,
      // 什么也没发生"——而实际上什么都没推。按**身份**比,不是按有没有值。
      const stillMine = get().pending === pending;
      set(stillMine ? { pending: null, busy: false } : { busy: false });
    }
  },

  cancel: () => set({ pending: null, busy: false }),
}));
