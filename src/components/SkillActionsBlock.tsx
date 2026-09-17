import { useState } from "react";

import { OutlineButton, PrimaryAction, rowMenuHandler } from "@/components/RowActionControls";
import { SkillRowMenu, type SkillRowMenuItem } from "@/components/SkillRowMenu";
import { t } from "@/i18n";
import { isAppError, openLibraryUrl, skillReveal, type InstalledSkillView } from "@/lib/ipc";
import { buildRowMenuItems, rowAction } from "@/lib/ownership";
import { SHARE_BLOCK_LABEL, SHARE_DONE_LABEL, SHARE_FAILED_LABEL } from "@/lib/share-block";
import { localDiffersNoBaseline, useMySkills } from "@/store/my-skills";
import { useInstall } from "@/store/install";
import { useShare } from "@/store/share";
import { useStoreIndex } from "@/store/store-index";

/**
 * 详情面板的「动作区」(设计 §12,终审 C-3 补齐的三条漏项之一)。
 *
 * # 为什么非补不可
 *
 * 详情面板是 `role="dialog" aria-modal` + 遮罩(`DetailPanel.tsx`),开着时
 * 行上的按钮(「我的技能」列表页的 `Row`)**不可达**——用户想更新/分享/移除
 * 一个技能,必须先关掉详情才能点到那些按钮。设计原文:「动作区把行上主按钮
 * 与「…」各项全部再摆一遍(主填充、余描边)」。
 *
 * # 判定与 `Row` 逐字共用,不重新发明
 *
 * 主按钮走 `rowAction` + `PrimaryAction`(与 `Row` 完全相同);「…」各项走
 * `buildRowMenuItems`(与 `Row` 完全相同,见该函数文档)——这里只是把它们的
 * `kind` 全部铺开渲染成描边按钮,不再收进一个下拉菜单(design §12:「全部再
 * 摆一遍」,不是再摆一个「更多」触发器)。分开各写一份判定正是本项目记录的
 * 空转测试模式 #1。
 *
 * # 🔴 v7.1 任务 3:它变成了详情面板的**固定页脚**,「打开文件夹」只此一处
 *
 * 照设计画布 `Detail.dc.html` 最后那个 `border-top` 的 div:
 * 主按钮 → 打开文件夹 → 在技能库里查看(有链接才摆)→ 其余动作 → 撑开 → 移除。
 * 它不再夹在「在哪」与页签之间(那个位置把 md 正文挤出首屏,违反 Q1A
 * 「md 是主角」),而是钉在面板底部,正文区 `flex:1`。
 *
 * ## 🔴 v7.6 任务 2(Q44-A):两种宿主,`host` 是闭合联合而不是可选 prop
 *
 * 「我的技能」详情(`LocalPanelBody`)与商店/广场详情(`PanelBody`)此前各自
 * 摆出一份"固定页脚"——后者其实是**两份**同时挂着(这个块的主按钮 + 底下
 * `InstallPanel` 自己的主按钮),用户截图里同屏出现两个看着都像主按钮的东西。
 * `host: "store" | "mine"` 拍板不复议:
 * - `host="mine"`(「我的技能」详情,行为**一个字不变**):这个组件仍然是
 *   **完整的**固定页脚——自己的边框/内边距、主按钮走 `rowAction`
 *   (分享/贡献更改/取回……这些都是「我的技能」的语境)、分享结果的成功与
 *   失败也在这里渲染(见下面「动作搬进来了」一节)。
 * - `host="store"`:**不渲染自己的主按钮**——那一格让给 `InstallPanel`
 *   (它的 `cardState` 才是"拉"的语境:获取/更新/换成库里的版本)。这里返回的
 *   是**裸按钮**(不带外层容器、也不带自己的 row div,见下面「v7.6 任务 3」),
 *   由 `InstallPanel` 直接插进它自己那一行——这才是"并进底部页脚"的字面意思,
 *   不是两个 bordered 的 div 前后紧贴,也不是两行紧贴。**只贡献次要动作**
 *   (打开文件夹 / 在技能库里查看 / 移除):`items` 过滤掉除 `reveal`
 *   以外的所有 `buildRowMenuItems` 结果——分享/贡献更改/更新这些都是"推"的
 *   动作,v7.4 已拍板"推"的动作不摆在"拉"的界面里,`rowAction` 本身
 *   也不该在这个宿主下驱动任何按钮。分享结果(`shareError`/`shareDone`/
 *   `shareBlocked` 的原因)同理不渲染——触发它们的按钮在这个宿主下根本不存在,
 *   摆出来要么是孤儿反馈,要么会把「我的技能」页上一次操作的陈旧结果
 *   带到商店详情里(归属校验挡的是"另一个技能",挡不住"同一个技能、
 *   另一个语境的旧结果")。
 *
 * ### 🔴 v7.6 任务 3(Q44-A 原文,逐字引用):「…」收危险动作
 *
 * 用户批的原文是「主按钮(获取／更新／已在电脑上)+ 次要动作(打开文件夹、
 * 在技能库里查看)+ **「…」收危险动作(移除)**」——同一行。v7.6 任务 2 把
 * `host="store"` 做成了 `<>{row}{messages}</>`,`row` 仍是一整条自带
 * `flex flex-wrap` 的 div,「移除」是这条 row 里一颗常驻可见的 `OutlineButton`
 * ——这是 task-2 brief 把用户批的原文转写成「——撑开——[移除]」时留下的偏差
 * (原文里"「…」收危险动作"这半句没有被转写进去),实现照做,合并出来的页脚
 * 变成了"一行主按钮 + 另起一行次要动作(末尾露着一颗移除)",不是用户批的
 * "同一行,危险动作收进「…」"。
 *
 * 现在改正:`host="store"` 下不再有自己的 `row` div——`secondaryButtons`
 * (reveal + libraryLink)与 `removeControl`(`ml-auto` 撑开的「…」触发器)都是
 * 裸元素,直接作为 `SkillActionsBlock` 的返回值交给 `InstallPanel`,后者把它们
 * 插进自己那唯一一行(与主按钮、「装到项目…」同排)。`removeControl` 按
 * `caps.removeInMenu` 分流:`host="mine"` 仍是常驻可见的 `OutlineButton`
 * (这个宿主行为一个字不变——用户批的原文只管商店/广场详情这一处页脚,
 * 「我的技能」行尾本就另有一颗「更多」,§12 的裁定是"全部摆开、不收下拉",
 * 两处是不同的裁定,不能顺手"统一");`host="store"` 换成 `SkillRowMenu`
 * (单项菜单,`items` 只有「移除」一条,复用它现成的
 * `aria-haspopup`/`Esc`/点外面关闭骨架,不重新发明一套下拉)。
 *
 * `messages`(`revealError`/`linkError`,`host="store"` 下仅有的两种反馈,
 * `shareFeedback` 在这个宿主恒 `false`)给了 `basis-full`:这两段要和
 * `secondaryButtons`/`removeControl` 一起插进 `InstallPanel` 的
 * `flex flex-wrap` 行,`basis-full` 让它们在这个共享的换行容器里独占一整行、
 * 排在按钮下方,不需要再拆一份"messages" ReactNode 单独往外传。`host="mine"`
 * 下 `messages` 本来就是普通块级兄弟(不在 flex 容器里),`basis-full` 在那里
 * 是无操作的安全属性,不影响既有布局。
 *
 * 🔴 **刻意是闭合联合,不是 `boolean`/可选 prop**:本项目连续两笔栽在
 * 这上面(v7.5 复审的 `InstallButtonVariant`、v7.6 任务 1 复审的
 * `LocalProbe`)——"约定会被下一个人无声打破,类型不会"。`host` 加第三档时
 * 这里与调用方的每一处判断都会被 `tsc` 逼着表态。
 *
 * `reveal` 此前**被过滤掉**,理由是 `WhereBlocks`「这台电脑上」那一块里已经有
 * 一颗同样的按钮。Q3 拍板反过来:那一块里的按钮删掉、面板底部那颗「在访达中
 * 打开」也删掉,**动作只留页脚这一处**——此前是同一个动作两个入口两种叫法,
 * 而「在访达中打开」在 Windows 上还是错的。所以这里的过滤一并撤销。
 * ⚠️ 撤销过滤之后 `onReveal` 就不能再是空函数了:它要真的调
 * `skill_reveal`,并且**传 `skill.body`(本体的绝对路径)、绝不传 `dirSlug`**
 * ——后者会被 core 解析成统一目录下的同名目录,而本体很可能根本不在那里
 * (v6 二期「本体住在它现在所在的地方」)。失败要有渲染点,见下面的 `revealError`:
 * 「这台电脑上」那一块被删掉时,它原来的失败渲染点也一起没了。
 *
 * # 「在技能库里查看」
 *
 * 照画布摆在页脚,数据是 core 新给的 `skill.libraryUrl`(v7.1 复审后用户裁定:
 * **改数据来源,不是接受现状**)。它由 core 侧的
 * `my_skills::library_url` 给出:用内建源的编译期地址 + 索引里这个技能的真实
 * `path` 拼出网页地址,只对确实在公司技能库里的行(`section` 是
 * `installedFrom`/`sharedTo`)给值。
 *
 * 🔴 **拼接必须在 core**(铁律 5:源码里不得出现真实内网地址),前端只是把串
 * 交给 `open_library_url`(带同源白名单守卫)。拼不出来 → `null` → **不摆**,
 * 而不是摆一颗点开是 404 的按钮。
 *
 * ⚠️ **v8 任务 3**:这里曾经还有一路数据来源 `review.url`(「审核中」那一档,
 * 那时 `libraryUrl` 对 `shareable` 区恒为 null)。提交审核整条链路下线之后,
 * 库链接只剩 `skill.libraryUrl` 这一个来源,没有就不摆——判据始终是"有没有一个
 * 能打开的地址"。
 *
 * # 挂载位置与全局对话框的关系
 *
 * 这个组件不关心 `MySkillsPage` 在不在场——「移除」「分享」这些动作触发的是
 * `useMySkills` 的状态(`removeTarget`/`shareTarget`),而 `RemoveDialog`/
 * `ShareConfirm`/`ConflictDialog`/`VersionChooser` 都全局挂在 `App.tsx`,
 * 不依赖 `MySkillsPage` 是否挂载(从商店页打开详情、`MySkillsPage` 根本没
 * 渲染时,这些动作依然生效——这正是 §12 要解决的问题本身)。
 *
 * # 🔴 动作搬进来了,反馈必须一起搬(终审复审轮 1,C-A)
 *
 * 上一句只说对了一半:**弹窗**确实全局挂着,但分享的**结果**(成功与失败)
 * 此前只写进 `useMySkills` 的 `shareDone`/`shareError`,而它们唯一的渲染点在
 * `MySkillsPage`。于是这个块把动作搬进详情面板之后,同一个缺陷换了个落点复现:
 * - 从商店/广场详情打开时 `MySkillsPage` 根本没挂载 → 成功与失败**都零反馈**;
 * - 从「我的技能」打开时 `MySkillsPage` 在场,但详情面板是 `fixed inset-0 z-50`
 *   的全屏遮罩,那一行反馈被盖在后面,连「知道了」都点不到。
 *
 * 「贡献更改」这一档后果最重:core 刻意**不动任何记账**(`share.rs` 模块头
 * 「记账一个字不动」),所以刷新之后按钮原样还是「贡献更改」——用户看到的是
 * "点了没反应",而再点一次会**开出第二个内容相同的合并请求**
 * (`share.rs::review_branch` 的分支名带时间戳)。所以**成功也要有反馈**,
 * 不只是失败。
 *
 * 归属校验(`shareDone.dirSlug`/`shareError.dirSlug` 必须等于本行的 `dirSlug`)
 * 不是可选的:本期已经抓到过这条的变体——补上渲染点却不校验归属,详情面板 B
 * 会显示技能 A 的失败,**从"零反馈"变成"错误的反馈"**,撒的谎是"哪个技能出了
 * 问题"。同款护栏见 `WhereBlocks.tsx::EachToolBlock` 的 `toolFailuresFor`。
 *
 * ⚠️ **这里没有"没东西可摆就整块 return null"的早退,是有意删掉的**
 * (终审复审轮 1,#2 裁定)。原先那句 `action.kind === "none" && items.length === 0`
 * 在 `host="mine"` 下**不可达**:`localPresent` 为真时 `buildRowMenuItems` 必然
 * 产出「移除」一项,为假时 `rowAction` 必然是 `pull`,两边都进不了"无动作且无
 * 菜单项"。一个不可达、没有测试覆盖、只能靠注释声明自己存在意义的防御分支,
 * 正是本项目记的空转模式 ①(同一条规则查了两遍,其中一遍永远不触发)——
 * **它最大的危害是会兜住本该打红的注入信号**。所以整条删掉,`return` 的形状
 * 交给上面那两条前提保证。
 * 🔴 如果将来真的出现"这个块渲染成一个空壳"的现象,说明那两条前提之一变了,
 * 那时它就是一条**真实分支**,该配测试正面处理,而不是再补一道防御性早退。
 * ⚠️ **`host="store"` 下这条不变量不成立**——items 被收窄到只剩 `reveal`,
 * `skill.localPresent` 为真但 `skill.body` 恰好为空这类边缘情况下确实可能渲染
 * 出一个空 Fragment。这**不是问题**:`host="store"` 下这个组件从来不是一个
 * 独立的、必须有内容的块,它是嵌进 `InstallPanel` 自己那层容器的可选内容
 * (见上面「两种宿主」一节),空了就是空了,`InstallPanel` 的边框与内边距
 * 不依赖它是否有内容。
 *
 * # 不在这里摆的两样(有意为之,均只谈 `host="mine"`——`host="store"` 下
 * 这些反馈本来就不会产生,见上面「两种宿主」一节)
 *
 * - **取回/更新的失败**:`PanelBody`(商店/广场详情)下方的 `InstallPanel` 已有
 *   `ErrorFooter`,摆在这里就是同屏两份。`LocalPanelBody` 那条路没有
 *   `InstallPanel`,所以它自己接了一处(见 `DetailPanel.tsx`)。
 * - **移除的部分失败**(`toolFailures` 的 `location` 档,即解链失败/跳过)。
 *   ⚠️ 这一条**不是"不重要",是结构上装不下**,判据有三层,缺一条都不足以不摆:
 *   ① `confirmRemove` 成功后 `load()` 会把这一行从 `list` 里拿掉,而这个块挂在
 *   `PanelBody`/`LocalPanelBody` 的 `{skill && <SkillActionsBlock/>}` 之下
 *   ——**块本身会卸载**,摆在这里的失败最多闪一帧,等于没摆;
 *   ② 它**不是永久零反馈**:`toolFailures` 要等下一次动作或「知道了」才被清掉,
 *   用户下次进「我的技能」页那条横幅还在(延迟反馈,不是丢失);
 *   ③ **硬失败**那条路(`skill_remove` 抛错)另有渲染点——`RemoveDialog` 的
 *   `removeError`,而且那个弹窗是全局挂在 `App.tsx` 的,不依赖任何一页。
 *   真要摆得换个承载位置(比如提升成 App 级的一次性提示),超出本波边界。
 */
/** 这个组件的两种宿主。见组件文档「两种宿主」一节。 */
export type ActionsHost = "store" | "mine";

/**
 * 宿主能力表。**穷尽 switch、无 default**——`host` 加第三档时这里当场编译失败,
 * 逼着人把三项能力逐个想清楚,而不是让新宿主默默继承 `host === "mine"` 这种
 * 散落各处的布尔比较的另一半。
 *
 * 这是组件文档里那句「`host` 加第三档时编译器会指着你」的**兑现处**:v7.6 任务 2
 * 复审指出,原实现三处都是裸的 `host === "mine"`,联合虽然是闭合的,但"加档时会
 * 编译失败"这件事并不成立——那句话当时只是一条注释里的约定。
 */
function capsOf(host: ActionsHost): {
  /** 摆不摆自己的 `rowAction` 主按钮(`host="store"` 下那一格让给 `InstallPanel`)。 */
  ownPrimary: boolean;
  /** 次要动作是否全摆(`false` = 只留 `reveal`「打开文件夹」)。 */
  allSecondaryItems: boolean;
  /** 摆不摆分享的成功/失败/受阻三段反馈。 */
  shareFeedback: boolean;
  /** 自己带不带外层容器(边框 + 内边距)。`false` = 交裸内容,由宿主包。 */
  ownWrapper: boolean;
  /**
   * 「移除」收进「…」(`SkillRowMenu`)还是摆成常驻可见按钮。
   * v7.6 任务 3(Q44-A 原文「「…」收危险动作」):`host="store"` 下页脚并成
   * 一行之后,「移除」不能再是同排里的一颗常驻按钮;`host="mine"` 的「移除」
   * 与这条无关(那是详情面板固定页脚里的按钮,不是「我的技能」行尾的
   * 「更多」——§12 对那一处的裁定是"全部摆开、不收下拉",这里不改)。
   */
  removeInMenu: boolean;
  /**
   * 「在技能库里查看」收不收进「…」。
   *
   * 🔴 起因是**硬约束**(2026-09-10 用户真机):详情面板固定宽 480px
   * (`DetailPanel.tsx`),页脚可用 440px,而 `[主按钮][装到项目…][打开文件夹]
   * [在技能库里查看][⋯]` 在主按钮是「已在电脑上」(5 字 + 绿勾)那一档合计约
   * 472px——`flex-wrap` 把「…」挤到第二行,**省了「移除」的位置却赔上整行给一个
   * 24px 的图标**,用户原话"白折叠了"。
   *
   * 砍掉「在技能库里查看」而不是「打开文件夹」:后者是这个应用最常用的出口之一
   * (v7.1 Q3 拍板「动作只留页脚这一处」时特意为它删掉了别处的重复入口),
   * 前者是去浏览器看网页、低频。⚠️ 这是对 Q44-A 原文(「次要动作(打开文件夹、
   * 在技能库里查看)」都在行上)的偏离,**用户 2026-09-10 看过测算后拍板同意**。
   */
  libraryLinkInMenu: boolean;
} {
  switch (host) {
    case "mine":
      return {
        ownPrimary: true,
        allSecondaryItems: true,
        shareFeedback: true,
        ownWrapper: true,
        removeInMenu: false,
        libraryLinkInMenu: false,
      };
    case "store":
      return {
        ownPrimary: false,
        allSecondaryItems: false,
        shareFeedback: false,
        ownWrapper: false,
        removeInMenu: true,
        libraryLinkInMenu: true,
      };
  }
}

export function SkillActionsBlock({
  skill,
  remoteChanged,
  host,
  subject,
}: {
  skill: InstalledSkillView;
  /** 技能的展示名,只给「…」的可访问名用(`SkillRowMenu.subject`)。`InstalledSkillView`
   *  里没有展示名,`dirSlug` 又是内部标识不能进可访问名,所以由 `DetailPanel` 把
   *  `detail.name` 传进来。 */
  subject: string;
  /** 「库里那一版变了没有」。**由调用方按 section 分流算好**(`hasUpdate` /
   *  `remoteChangedForShareable`),与折叠头的结论行、「技能库里」那一块吃的是
   *  同一个布尔量——三处各算一遍就是本项目记的空转模式 ①,而且「可分享到」区
   *  外部来源的行会在其中一处静默丢掉"有新版"。 */
  remoteChanged: boolean;
  /**
   * 宿主区分(Q44-A,v7.6 任务 2)。闭合联合,不是布尔/可选 prop——理由见组件
   * 文档「两种宿主」一节。`"mine"` = 「我的技能」详情,行为一个字不变;
   * `"store"` = 商店/广场详情,只贡献次要动作,嵌进 `InstallPanel` 的页脚里。
   */
  host: ActionsHost;
}) {
  const index = useStoreIndex((s) => s.index);
  const pulling = useInstall((s) => s.dirSlug === skill.dirSlug && s.phase === "running");
  const sharing = useMySkills((s) => s.shareBusy === skill.dirSlug);
  const openVersions = useMySkills((s) => s.versionChoice !== null);
  // 🔴 归属校验:两个字段都是全局的,只认自己这一行的那一条(见组件文档)。
  // `host="store"` 下这两个值从不渲染(见下面 `messages`),但仍然无条件调用
  // 这两个 hook——hook 顺序不能按 host 分支跳过。
  const rawShareError = useMySkills((s) => s.shareError);
  const rawShareDone = useMySkills((s) => s.shareDone);
  const shareError = rawShareError?.dirSlug === skill.dirSlug ? rawShareError : null;
  const shareDone = rawShareDone?.dirSlug === skill.dirSlug ? rawShareDone : null;

  const noBaselineDiffers = localDiffersNoBaseline(skill, index);
  // 🔴 v8 任务 3 / D8:没有写权限时分享族主按钮禁用 + 一句说明。`unknown`
  // (探不到)不禁——预检永远 fail-open。`host="store"` 下主按钮来自
  // `cardState` 不来自这里,但次要动作(「…」里的贡献更改/分享)同样要拦,
  // 所以这个判定在两个宿主下都参与。
  const noWriteAccess = useShare((s) => s.preview) === "noAccess";
  const action = rowAction(skill, remoteChanged, noWriteAccess);
  // 🔴 `reveal` **不再过滤**(Q3:打开文件夹只留页脚这一处,见组件文档)。
  // 「移除」单独摘出来靠右摆,其余按 `buildRowMenuItems` 的自然顺序排在左边
  // ——那个顺序本来就是「打开文件夹」在前、「移除」在末,与画布一致。
  const allItems = buildRowMenuItems(skill, action, remoteChanged, noBaselineDiffers, noWriteAccess);
  // 🔴 `host="store"` 下只留 `reveal`(打开文件夹)——`contributeOrShareChanges`/
  // `update`/`share`/`useLibraryVersion` 都是"推"的动作(改库里的内容、或是
  // `rowAction` 语境下的取回),v7.4 已拍板"推"的动作不摆在"拉"的界面里,见组件
  // 文档「两种宿主」一节。
  const caps = capsOf(host);
  const items = allItems.filter(
    (spec) => spec.kind !== "remove" && (caps.allSecondaryItems || spec.kind === "reveal"),
  );
  const removeItem = allItems.find((spec) => spec.kind === "remove") ?? null;

  const libraryLink = skill.libraryUrl;

  const [revealError, setRevealError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const onReveal = () => {
    setRevealError(null);
    // 🔴 传 body(本体的绝对路径),绝不传 dirSlug——后者会被 skill_reveal
    // 解析成统一目录下的同名目录,本体很可能根本不在那里。
    skillReveal({ path: skill.body }).catch((raw: unknown) =>
      setRevealError(isAppError(raw) ? raw.message : t("error.generic")),
    );
  };
  const onPull = () => void useMySkills.getState().pull(skill.dirSlug);
  const onShareChanges = () => void useMySkills.getState().shareChanges(skill.dirSlug);
  const onShare = () => useMySkills.getState().beginShare(skill.dirSlug);
  const onRemove = () => useMySkills.getState().askRemove(skill.dirSlug);
  const onChooseVersion = () =>
    useMySkills.setState({
      versionChoice: { dirSlug: skill.dirSlug, versions: skill.versions },
      keepError: null,
    });

  // 打开文件夹 / 在技能库里查看——host="store" 下这就是全部内容
  // (`items` 已按 `caps.allSecondaryItems` 收窄到只剩 `reveal`);host="mine"
  // 下它们是 `row` 的一部分。**裸元素,不带自己的 flex 容器**(v7.6 任务 3,
  // 见组件文档「「…」收危险动作」一节)——`host="mine"` 把它们摆进自己的
  // `row` div,`host="store"` 直接把它们交给 `InstallPanel` 的那一行。
  const secondaryButtons = (
    <>
      {items.map((spec) => (
        <OutlineButton
          key={spec.kind}
          size="footer"
          title={spec.titleKey ? t(spec.titleKey) : undefined}
          onClick={rowMenuHandler(spec.kind, { onReveal, onShareChanges, onPull, onShare, onRemove })}
        >
          {t(spec.labelKey)}
        </OutlineButton>
      ))}
      {libraryLink && !caps.libraryLinkInMenu && (
        <OutlineButton
          size="footer"
          onClick={() => {
            setLinkError(null);
            // core 已经保证这个串与内建 Gitea 同源;`open_library_url` 自己
            // 还有一道同源白名单守卫,这里不重复判,失败如实说出来。
            openLibraryUrl(libraryLink).catch((raw: unknown) =>
              setLinkError(isAppError(raw) ? raw.message : t("error.generic")),
            );
          }}
        >
          {t("mine.reviewLink")}
        </OutlineButton>
      )}
    </>
  );

  // 「移除」永远靠右(`ml-auto`)。v7.6 任务 3 之前两个宿主都是常驻可见的
  // `OutlineButton`;现在按 `caps.removeInMenu` 分流:`host="mine"` 不变,
  // `host="store"` 收进 `SkillRowMenu`(「…」),见组件文档「「…」收危险动作」。
  const openLibrary = () => {
    if (!libraryLink) return;
    setLinkError(null);
    openLibraryUrl(libraryLink).catch((raw: unknown) =>
      setLinkError(isAppError(raw) ? raw.message : t("error.generic")),
    );
  };
  // 「…」里的项:库链接(如果收进来了)在前、「移除」在末并带分隔线
  // ——与 `buildRowMenuItems` 的自然顺序一致(破坏性动作永远在最后)。
  const menuItems: SkillRowMenuItem[] = [
    ...(libraryLink && caps.libraryLinkInMenu
      ? [{ key: "library", label: t("mine.reviewLink"), onClick: openLibrary }]
      : []),
    ...(removeItem
      ? [
          {
            key: "remove",
            label: t(removeItem.labelKey),
            onClick: onRemove,
            separatorBefore: true,
          },
        ]
      : []),
  ];
  // `host="mine"`:「移除」仍是常驻可见的 `OutlineButton`(§12「全部摆开」);
  // `host="store"`:「…」收下库链接与「移除」——两支的**存在条件不同**,
  // 所以分开写而不是共用一个 `menuItems.length > 0`(mine 那支要的是
  // `removeItem` 本身,而 menuItems 非空也可能只是因为有库链接)。
  const removeControl = caps.removeInMenu ? (
    menuItems.length > 0 && (
      <div className="ml-auto">
        <SkillRowMenu items={menuItems} preferredPlacement={"up"} subject={subject} />
      </div>
    )
  ) : removeItem ? (
    <div className="ml-auto">
      <OutlineButton size="footer" onClick={onRemove}>
        {t(removeItem.labelKey)}
      </OutlineButton>
    </div>
  ) : null;

  // `flex-wrap`:按钮数量随档位变(`host="mine"` 的 `conflict` 档有五颗),480px
  // 宽的面板放不下时换行比压扁好。**只有 `host="mine"` 用到这个 `row`**
  // ——`host="store"` 不再有自己的行容器,见下面的 return。
  const row = (
    <div className="flex flex-wrap items-center gap-2">
      {caps.ownPrimary && (
        <PrimaryAction
          action={action}
          pulling={pulling}
          sharing={sharing}
          openVersions={openVersions}
          size="footer"
          onPull={onPull}
          onShareChanges={onShareChanges}
          onShare={onShare}
          onChooseVersion={onChooseVersion}
        />
      )}
      {secondaryButtons}
      {removeControl}
    </div>
  );

  // 🔴 `shareError`/`shareDone`/`shareBlocked` 三段只在 `host="mine"` 下渲染:
  // 触发它们的按钮(`PrimaryAction`/`contributeOrShareChanges` 等)在
  // `host="store"` 下根本不存在,摆出来要么是孤儿反馈,要么会把「我的技能」页
  // 上一次操作的陈旧结果带进商店详情(见组件文档「两种宿主」一节)。
  //
  // `basis-full`:`host="store"` 下 `revealError`/`linkError` 要和
  // `secondaryButtons`/`removeControl` 一起插进 `InstallPanel` 的
  // `flex flex-wrap` 行,这个属性让它们在那个共享容器里独占一整行、排在
  // 按钮下方。`host="mine"` 下 `messages` 是普通块级兄弟(不在 flex 容器里),
  // 这个属性在那里是无操作的安全属性。
  const messages = (
    <>
      {revealError && (
        <p className="mt-1.5 basis-full text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.openFolderFailed")}
          {t("punct.labelSeparator")}
          {revealError}
        </p>
      )}
      {linkError && (
        <p className="mt-1.5 basis-full text-[12px] text-[#c0392b] dark:text-[#e0705f]">{linkError}</p>
      )}
      {/* 分享的成功与失败:归属过滤后自己摆一份,理由见组件文档。
          文案按 `flow` 分流,**不按渲染那一刻的 `action` 反推**——首次分享成功后
          这一行的 section/rowAction 已经换档了,反推出来的答案恰恰在成功路径上是错的
          (见 `lib/share-block.ts::ShareFlow` 的文档)。 */}
      {caps.shareFeedback && shareError && (
        <p className="mt-1.5 basis-full text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t(SHARE_FAILED_LABEL[shareError.flow])}
          {t("punct.labelSeparator")}
          {shareError.error.message}
        </p>
      )}
      {caps.shareFeedback && shareDone && (
        <p className="mt-1.5 basis-full text-[12px] text-text-2">
          {t(SHARE_DONE_LABEL[shareDone.flow][shareDone.mode])}
        </p>
      )}
      {caps.shareFeedback && action.kind === "shareBlocked" && (
        <p className="mt-1.5 basis-full rounded-card border border-[#b8860b]/40 px-2.5 py-1.5 text-[11.5px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
          {t(SHARE_BLOCK_LABEL[action.reason])}
        </p>
      )}
      {/* 🔴 D8:「为什么这颗按钮点不动」。禁用态没有这句说明就是个哑按钮,
          而 D8 明确要求**说清原因**(此处刻意不套用「不摆比解释好」)。
          「打开文件夹」由上面的 `secondaryButtons` 恒摆着,出口不丢。 */}
      {caps.shareFeedback && action.kind === "noWriteAccess" && (
        <p className="mt-1.5 basis-full rounded-card border border-[#b8860b]/40 px-2.5 py-1.5 text-[11.5px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
          {t("mine.shareNoAccess")}
        </p>
      )}
    </>
  );

  // `host="mine"`:完整的固定页脚,自己的边框/内边距,`row` 是自己的一整条
  // flex 行(行为一个字不变)。
  if (caps.ownWrapper) {
    return (
      <div className="flex-none border-t border-border px-5 py-3.5">
        {row}
        {messages}
      </div>
    );
  }
  // `host="store"`:裸按钮(不含 `row` 这层容器)——`InstallPanel` 把它当
  // `actions` prop 接住,直接插进自己那一行(见组件文档「「…」收危险动作」)。
  return (
    <>
      {secondaryButtons}
      {removeControl}
      {messages}
    </>
  );
}
