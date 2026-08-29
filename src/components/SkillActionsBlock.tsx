import { OutlineButton, PrimaryAction, rowMenuHandler } from "@/components/RowActionControls";
import { t } from "@/i18n";
import type { InstalledSkillView } from "@/lib/ipc";
import { buildRowMenuItems, rowAction } from "@/lib/ownership";
import { SHARE_BLOCK_LABEL } from "@/lib/share-block";
import { hasUpdate, localDiffersNoBaseline, remoteChangedForShareable, useMySkills } from "@/store/my-skills";
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
 * 🔴 **`reveal`("打开文件夹")这一项被过滤掉,不铺进这个动作区**:紧挨着它
 * 之上的 `WhereBlocks`「这台电脑上」那一块(`ThisComputerBlock`)已经摆着
 * 同样文案、同样动作的按钮——「全部再摆一遍」摆的是"行上有、详情面板此前没有
 * 的动作",不是把已经在详情面板别处存在的动作再复制一份。两处若都摆,
 * 用户会在同一屏看到两颗一模一样的「打开文件夹」,是噪音不是补齐。
 *
 * # 挂载位置与全局对话框的关系
 *
 * 这个组件不关心 `MySkillsPage` 在不在场——「移除」「分享」这些动作触发的是
 * `useMySkills` 的状态(`removeTarget`/`shareTarget`),而 `RemoveDialog`/
 * `ShareConfirm`/`ConflictDialog`/`VersionChooser` 都全局挂在 `App.tsx`,
 * 不依赖 `MySkillsPage` 是否挂载(从商店页打开详情、`MySkillsPage` 根本没
 * 渲染时,这些动作依然生效——这正是 §12 要解决的问题本身)。
 */
export function SkillActionsBlock({ skill }: { skill: InstalledSkillView }) {
  const index = useStoreIndex((s) => s.index);
  const shareableIndexes = useMySkills((s) => s.shareableIndexes);
  const pulling = useInstall((s) => s.dirSlug === skill.dirSlug && s.phase === "running");
  const sharing = useMySkills((s) => s.shareBusy === skill.dirSlug);
  const openVersions = useMySkills((s) => s.versionChoice !== null);

  const remoteChanged =
    skill.section === "shareable"
      ? remoteChangedForShareable(skill, shareableIndexes)
      : hasUpdate(skill, index);
  const noBaselineDiffers = localDiffersNoBaseline(skill, index);
  const action = rowAction(skill, remoteChanged);
  // 🔴 `reveal` 过滤掉,理由见组件文档——`WhereBlocks` 的「这台电脑上」那一块
  // 已经摆着同样的按钮。
  const items = buildRowMenuItems(skill, action, remoteChanged, noBaselineDiffers).filter(
    (spec) => spec.kind !== "reveal",
  );

  if (action.kind === "none" && items.length === 0) return null;

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
    <div className="border-t border-border px-5 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <PrimaryAction
          action={action}
          pulling={pulling}
          sharing={sharing}
          openVersions={openVersions}
          onPull={onPull}
          onShareChanges={onShareChanges}
          onShare={onShare}
          onChooseVersion={onChooseVersion}
        />
        {items.map((spec) => (
          <OutlineButton
            key={spec.kind}
            title={spec.titleKey ? t(spec.titleKey) : undefined}
            // `reveal` 已被过滤,`onReveal` 这里永远不会真的被调用——仍然要传
            // 一个符合 `RowMenuHandlers` 形状的值,`rowMenuHandler` 不为了这一处
            // 单开一个"少一个键"的类型。
            onClick={rowMenuHandler(spec.kind, { onReveal: () => {}, onShareChanges, onPull, onShare, onRemove })}
          >
            {t(spec.labelKey)}
          </OutlineButton>
        ))}
      </div>
      {action.kind === "shareBlocked" && (
        <p className="mt-1.5 rounded-card border border-[#b8860b]/40 px-2.5 py-1.5 text-[11.5px] leading-[1.6] text-[#9a6c00] dark:border-[#d4a017]/40 dark:text-[#d4a017]">
          {t(SHARE_BLOCK_LABEL[action.reason])}
        </p>
      )}
    </div>
  );
}
