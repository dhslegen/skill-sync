import { useState } from "react";

import { OutlineButton, PrimaryAction, rowMenuHandler } from "@/components/RowActionControls";
import { t } from "@/i18n";
import { isAppError, openLibraryUrl, skillReveal, type InstalledSkillView } from "@/lib/ipc";
import { buildRowMenuItems, rowAction } from "@/lib/ownership";
import { SHARE_BLOCK_LABEL, SHARE_DONE_LABEL, SHARE_FAILED_LABEL } from "@/lib/share-block";
import { localDiffersNoBaseline, useMySkills } from "@/store/my-skills";
import { useInstall } from "@/store/install";
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
 * **改数据来源,不是接受现状**)。此前 `InstalledSkillView` 上唯一的库链接是
 * `review.url`,只有「审核中」那一档有值——那个限制已经由 core 侧的
 * `my_skills::library_url` 解掉:用内建源的编译期地址 + 索引里这个技能的真实
 * `path` 拼出网页地址,只对确实在公司技能库里的行(`section` 是
 * `installedFrom`/`sharedTo`)给值。
 *
 * 🔴 **拼接必须在 core**(铁律 5:源码里不得出现真实内网地址),前端只是把串
 * 交给 `open_library_url`(带同源白名单守卫)。拼不出来 → `null` → **不摆**,
 * 而不是摆一颗点开是 404 的按钮。
 *
 * ## 🔴 「审核中」那一档改吃 `review.url`(终审 I-1)
 *
 * 上一版这里写着「与 `underReview` 档那颗同名按钮不会同屏」,并据此认为审核中的
 * 行在页脚不需要库链接——**推理对了一半、结论错了**:`review` 非空 ⟹ `section`
 * 是 `shareable` ⟹ `relation` 是 `Draft` ⟹ `my_skills::row_library_url` 第一句就
 * `return None`,所以 `libraryUrl` 对这一档**恒为 null**,页脚那颗按钮**根本渲染
 * 不出来**。同一期任务 5 把行上的链接删掉时,注释说"页脚还有一颗"——指的却是
 * 另一个字段,于是 `RowAction.underReview.url` 变成全仓零消费,审核中的技能唯一
 * 的库入口只剩**默认收起**的「在哪」折叠头里那一条。这正是 v7 任务 7 修复轮 1
 * 修过的「core 算出来了却没有渲染点」的编号回归。
 *
 * 所以这颗按钮的数据来源是 **`libraryUrl` 优先、退回 `review.url`**:两者不会
 * 同时有值(前者只给在库里的行、后者只给「可分享到」区),所以不存在"摆两颗"的
 * 问题;`review.url` 本身可以是 `null`(降级路 / 直推留下的记录没有链接),
 * 那一档仍然不摆——判据始终是"有没有一个能打开的地址",不是"是不是审核中"。
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
 * **今天不可达**:`localPresent` 为真时 `buildRowMenuItems` 必然产出「移除」一项,
 * 为假时 `rowAction` 必然是 `pull`,两边都进不了"无动作且无菜单项"。一个不可达、
 * 没有测试覆盖、只能靠注释声明自己存在意义的防御分支,正是本项目记的空转模式 ①
 * (同一条规则查了两遍,其中一遍永远不触发)——**它最大的危害是会兜住本该打红的
 * 注入信号**。所以整条删掉,`return` 的形状交给上面那两条前提保证。
 * 🔴 如果将来真的出现"这个块渲染成一个空壳"的现象,说明那两条前提之一变了,
 * 那时它就是一条**真实分支**,该配测试正面处理,而不是再补一道防御性早退。
 *
 * # 不在这里摆的两样(有意为之)
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
export function SkillActionsBlock({
  skill,
  remoteChanged,
}: {
  skill: InstalledSkillView;
  /** 「库里那一版变了没有」。**由调用方按 section 分流算好**(`hasUpdate` /
   *  `remoteChangedForShareable`),与折叠头的结论行、「技能库里」那一块吃的是
   *  同一个布尔量——三处各算一遍就是本项目记的空转模式 ①,而且「可分享到」区
   *  外部来源的行会在其中一处静默丢掉"有新版"。 */
  remoteChanged: boolean;
}) {
  const index = useStoreIndex((s) => s.index);
  const pulling = useInstall((s) => s.dirSlug === skill.dirSlug && s.phase === "running");
  const sharing = useMySkills((s) => s.shareBusy === skill.dirSlug);
  const openVersions = useMySkills((s) => s.versionChoice !== null);
  // 🔴 归属校验:两个字段都是全局的,只认自己这一行的那一条(见组件文档)。
  const rawShareError = useMySkills((s) => s.shareError);
  const rawShareDone = useMySkills((s) => s.shareDone);
  const shareError = rawShareError?.dirSlug === skill.dirSlug ? rawShareError : null;
  const shareDone = rawShareDone?.dirSlug === skill.dirSlug ? rawShareDone : null;

  const noBaselineDiffers = localDiffersNoBaseline(skill, index);
  const action = rowAction(skill, remoteChanged);
  // 🔴 `reveal` **不再过滤**(Q3:打开文件夹只留页脚这一处,见组件文档)。
  // 「移除」单独摘出来靠右摆,其余按 `buildRowMenuItems` 的自然顺序排在左边
  // ——那个顺序本来就是「打开文件夹」在前、「移除」在末,与画布一致。
  const allItems = buildRowMenuItems(skill, action, remoteChanged, noBaselineDiffers);
  const items = allItems.filter((spec) => spec.kind !== "remove");
  const removeItem = allItems.find((spec) => spec.kind === "remove") ?? null;

  // 🔴 终审 I-1:审核中那一档 `libraryUrl` 恒 null(见组件文档),库入口退回
  // `review.url`。两者互斥,所以这不是"两个来源抢同一颗按钮",是同一颗按钮的
  // 两种数据来源;都没有就不摆。
  const libraryLink = skill.libraryUrl ?? (action.kind === "underReview" ? action.url : null);

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

  return (
    <div className="flex-none border-t border-border px-5 py-3.5">
      {/* `flex-wrap`:按钮数量随档位变(`conflict` 档有五颗),480px 宽的面板放不下时
          换行比压扁好。「移除」用 `ml-auto` 靠右——换行后它会在自己那一行的最右边,
          与不换行时的效果一致(画布里它就在最右)。 */}
      <div className="flex flex-wrap items-center gap-2">
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
        {libraryLink && (
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
        {removeItem && (
          <div className="ml-auto">
            <OutlineButton size="footer" onClick={onRemove}>
              {t(removeItem.labelKey)}
            </OutlineButton>
          </div>
        )}
      </div>
      {revealError && (
        <p className="mt-1.5 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.openFolderFailed")}
          {t("punct.labelSeparator")}
          {revealError}
        </p>
      )}
      {linkError && (
        <p className="mt-1.5 text-[12px] text-[#c0392b] dark:text-[#e0705f]">{linkError}</p>
      )}
      {/* 🔴 分享的成功与失败:归属过滤后自己摆一份,理由见组件文档。
          文案按 `flow` 分流,**不按渲染那一刻的 `action` 反推**——首次分享成功后
          这一行的 section/rowAction 已经换档了,反推出来的答案恰恰在成功路径上是错的
          (见 `lib/share-block.ts::ShareFlow` 的文档)。 */}
      {shareError && (
        <p className="mt-1.5 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t(SHARE_FAILED_LABEL[shareError.flow])}
          {t("punct.labelSeparator")}
          {shareError.error.message}
        </p>
      )}
      {shareDone && (
        <p className="mt-1.5 text-[12px] text-text-2">{t(SHARE_DONE_LABEL[shareDone.flow][shareDone.mode])}</p>
      )}
      {action.kind === "shareBlocked" && (
        <p className="mt-1.5 rounded-card border border-[#b8860b]/40 px-2.5 py-1.5 text-[11.5px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
          {t(SHARE_BLOCK_LABEL[action.reason])}
        </p>
      )}
    </div>
  );
}
