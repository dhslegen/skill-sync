import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import type { RowAction, RowMenuItemKind } from "@/lib/ownership";

/**
 * 按钮的两档尺寸(v7.1 任务 3)。设计画布里列表行上的按钮是 24px/11.5px
 * (`Main.dc.html`),详情面板固定页脚上的是 30px/12.5px(`Detail.dc.html`)
 * ——同一套控件、两个场景两个尺寸。默认 `row`,所以既有调用方一个字不用改。
 */
export type ButtonSize = "row" | "footer";

const SIZE_CLASS: Record<ButtonSize, string> = {
  row: "h-6 px-2.5 text-[11.5px]",
  // 🔴 `shrink-0` 照画布(每颗页脚按钮都是 `flex:none`)。没有它,页脚里按钮一多
  // (`conflict` 档会同时有 主按钮/打开文件夹/分享改动/在技能库里查看/移除 五颗)
  // 就会被压扁,文字在按钮里折成两行——真机走查看到的正是这种"挤成一团"。
  footer: "h-[30px] shrink-0 whitespace-nowrap px-3 text-[12.5px]",
};

/**
 * 「我的技能」一行主按钮的判定表 → 按钮控件,以及「…」菜单条目的判定结果
 * (`buildRowMenuItems`,见 `lib/ownership.ts`)→ 回调这两件事的**唯一实现**
 * (终审 §12)。
 *
 * # 为什么要单独抽出这个文件
 *
 * 此前只有 `MySkillsPage.tsx` 的 `Row` 用得到它;详情面板(`DetailPanel.tsx`)
 * 是一层浮出面板 + 遮罩,开着时行上的按钮不可达——用户想更新/分享/移除必须先
 * 关掉详情。design §12 要求详情面板自己也有一份"动作区",把行上主按钮与「…」
 * 各项全部再摆一遍(主填充、余描边)。两处必须共用**同一份**按钮渲染与「…」
 * 菜单的回调映射,不能各写一份——那正是本项目记录的空转测试模式 #1
 * (同一条规则查了/写了两遍,其中一份漂移不会被任何测试发现)。
 */
export function PrimaryAction({
  action,
  pulling,
  sharing,
  openVersions,
  size = "row",
  onPull,
  onShareChanges,
  onShare,
  onChooseVersion,
}: {
  action: RowAction;
  pulling: boolean;
  sharing: boolean;
  openVersions: boolean;
  size?: ButtonSize;
  onPull: () => void;
  onShareChanges: () => void;
  onShare: () => void;
  onChooseVersion: () => void;
}) {
  switch (action.kind) {
    case "none":
      return null;
    case "chooseVersion":
      return (
        <SolidButton size={size} disabled={openVersions} onClick={onChooseVersion}>
          {t("mine.chooseVersion")}
        </SolidButton>
      );
    case "pull":
      return (
        <SolidButton size={size} disabled={pulling} onClick={onPull}>
          {pulling ? t("mine.pulling") : t("mine.pull")}
        </SolidButton>
      );
    case "update":
      return (
        <SolidButton size={size} disabled={pulling} onClick={onPull}>
          {pulling ? t("mine.updating") : t("mine.update")}
        </SolidButton>
      );
    case "conflict":
      // 🔴 v7.1 任务 5:浅橙 chip(`ChipButton`),照画布 `Main.dc.html`
      // ——**不是**此前的虚线下划线文字链。它是这一行**唯一**的主按钮,
      // 弱到看不出可点就是缺陷(2026-09-02 真机走查用户点名)。
      // 🔴 文案末尾的省略号是**有语义的**:这一档不是"点了就做完",是
      // "点了会先问你留哪一份"。别当成文本被截断顺手"修"掉。
      return (
        <ChipButton size={size} disabled={pulling} onClick={onPull}>
          {pulling ? t("mine.updating") : t("mine.conflictPending")}
        </ChipButton>
      );
    case "differsFromLibrary":
      // 🔴 v8 任务 6 / D7:**没有按钮**。这一档只是一句如实的陈述
      // (「和库里的不一样」),它的两条出路——提示联系作者、「…」里的
      // 「改用库里的版本」——分别由行上/详情动作区的提示区与「…」菜单承担。
      // 摆一颗禁用 chip 是另一种撒谎:用户会以为"等某个条件满足就能点"。
      return null;
    case "shareChanges":
      // 画布里「分享改动」是实心(自己分享的技能推自己的改动,是本行的主动作)。
      return (
        <SolidButton size={size} disabled={sharing} onClick={onShareChanges}>
          {sharing ? t("mine.sharingChanges") : t("mine.shareChanges")}
        </SolidButton>
      );
    case "share":
      // 🔴 v7.3 需求 5 的全站规则(Q21-A 定稿的措辞):
      //   **实心 = 这一栏里的例外;chip = 这一栏里人人都有的那个动作。**
      // 「分享」是「可分享到技能库」
      // 那一整栏的**常态**——41 行里 41 行都有它。此前它是实心橙,于是满屏
      // 实心橙,那 1 个真正要处理的行(冲突/选版本/没有写权限)完全淹掉。
      // 对照「已分享到」栏没有这个问题,正因为那一栏的常态是"没有按钮"。
      // `needsAttention` 早就把 `share` 排除在"要处理"之外了(那个判定是对的),
      // 错的是**视觉没有跟着这个判定走**——这里把它补上。
      return (
        <ChipButton size={size} disabled={sharing} onClick={onShare}>
          {t("mine.share")}
        </ChipButton>
      );
    case "shareBlocked": {
      // 🔴 C1:三个区都可能落进这一档,按钮文案要说对被拦下的是哪个动作
      // ——不是每次都说「分享」(那句话对 installedFrom/sharedTo 是错的)。
      const label =
        action.blockedAction === "shareChanges" ? t("mine.shareChanges") : t("mine.share");
      // 🔴 v7.1 任务 5:被拦下的形态必须与它**启用时**的形态一致,只多一层
      // `disabled:opacity-50`(画布里禁用态就是"同一颗按钮 + opacity .5")。
      // 用另一种形态画禁用态,等于对用户撒谎——他分不出被禁的到底是哪个动作。
      // 🔴 v7.3:「分享」降级成 chip 之后,它被拦下的形态也要跟着降
      // ——"被禁用的形态必须与它启用时的形态一致,只多一层 opacity"这条规矩没变,
      // 变的是「分享」启用时长什么样。三档里只剩「分享改动」还是实心。
      const Btn = action.blockedAction === "shareChanges" ? SolidButton : ChipButton;
      return (
        <Btn size={size} disabled onClick={() => {}}>
          {label}
        </Btn>
      );
    }
    case "noWriteAccess": {
      // 🔴 v8 任务 3 / D8:没有写权限时,主按钮**禁用且保持它启用时的形态**
      // ——与 `shareBlocked` 逐字同款(用另一种形态画禁用态,用户分不出被禁的
      // 是哪个动作)。为什么不干脆不摆:见 `RowAction.noWriteAccess` 的文档。
      // 「为什么不能点」那句说明与「打开文件夹」出口在行上的提示区与详情面板
      // 动作区各自渲染。
      const label =
        action.blockedAction === "shareChanges" ? t("mine.shareChanges") : t("mine.share");
      const Btn = action.blockedAction === "shareChanges" ? SolidButton : ChipButton;
      return (
        <Btn size={size} disabled onClick={() => {}}>
          {label}
        </Btn>
      );
    }
  }
}

export function SolidButton({
  disabled,
  size = "row",
  onClick,
  children,
}: {
  disabled?: boolean;
  size?: ButtonSize;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-ctl bg-accent font-medium text-white hover:opacity-90 disabled:opacity-50",
        SIZE_CLASS[size],
      )}
    >
      {children}
    </button>
  );
}

/**
 * 浅橙 chip 按钮(`bg-accent-soft` = `rgba(194,65,12,.08)`,与画布内联值逐字相同)。
 *
 * 画布 `Main.dc.html` 的行按钮只有三种形态,这是中间那一档。判据(v7.3 Q21-A 定稿):
 *
 *   **实心 = 这一栏里的例外;chip = 这一栏里人人都有的那个动作。**
 *
 * ghost 图标 = 「更多」。⚠️ **刻意不枚举具体档位**:此前这里列的是
 * "实心 = 更新/分享改动/取回,chip = 分享/库里有新版…",一加新档就对不上,
 * 而且会诱导人按名单对号入座、不看它在自己那一栏里是不是常态。v7.3 把「分享」
 * 从实心挪到这一档,正是按上面那句原则办的(见 `PrimaryAction` 的 `share` 分支)。所有 chip **必须共用这一个实现**
 * ——各写一份就是本项目记录的空转模式 #1(其中一份漂移了没有任何测试发现)。
 */
export function ChipButton({
  disabled,
  size = "row",
  onClick,
  children,
}: {
  disabled?: boolean;
  size?: ButtonSize;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-ctl border border-transparent bg-accent-soft font-medium text-accent hover:opacity-80 disabled:opacity-50",
        SIZE_CLASS[size],
      )}
    >
      {children}
    </button>
  );
}

export function OutlineButton({
  disabled,
  title,
  size = "row",
  onClick,
  children,
}: {
  disabled?: boolean;
  /** 原生 `title`(悬浮提示)。目前只有动作区的「改用库里的版本」用它说明后果。 */
  title?: string;
  size?: ButtonSize;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-ctl border border-border font-medium text-text-2 hover:border-border-strong hover:text-text disabled:opacity-50",
        SIZE_CLASS[size],
      )}
    >
      {children}
    </button>
  );
}

/** {@link RowMenuItemKind} → 这一行/这个技能自己的那一套回调。`onReveal` 刻意
 *  收 `() => void`(不是 `(path) => void`)——两处调用方(行 / 详情动作区)
 *  拿到 `path` 的方式不同(行从入参 `skill.body` 现拼,详情面板直接闭包住
 *  `skill`),让这里多收一个参数只会把两处调用方都变得更绕。 */
export interface RowMenuHandlers {
  onReveal: () => void;
  onShareChanges: () => void;
  onPull: () => void;
  onShare: () => void;
  onRemove: () => void;
}

export function rowMenuHandler(kind: RowMenuItemKind, handlers: RowMenuHandlers): () => void {
  switch (kind) {
    case "reveal":
      return handlers.onReveal;
    case "shareChangesFromMenu":
      return handlers.onShareChanges;
    case "update":
      return handlers.onPull;
    case "share":
      return handlers.onShare;
    case "useLibraryVersion":
      return handlers.onPull;
    case "remove":
      return handlers.onRemove;
  }
}
