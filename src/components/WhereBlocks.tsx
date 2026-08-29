import { ExternalLink, FolderOpen, Laptop, Library, Wrench, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { Icon } from "@/components/Icon";
import { ToolChecks } from "@/components/ToolChecks";
import { t } from "@/i18n";
import { isAppError, openLibraryUrl, skillReveal, type InstalledSkillView, type Section } from "@/lib/ipc";
import { hasUpdate, useMySkills, visibleTools } from "@/store/my-skills";
import { useStoreIndex } from "@/store/store-index";

/**
 * 详情面板「在哪」三块(v7 任务 6):产品语言「一个技能,三个在哪」的落点
 * ——这台电脑上 / 各个工具里 / 技能库里。顺序固定,标题恒渲染(`data-testid`
 * 供测试断言顺序),内容按数据稀疏程度各自降级,不摆比编造好。
 *
 * # 🔴 `bodyLocationText` 是修 Zed 缺陷的核心,必须先比 canonical 再查工具目录
 *
 * 用户报告过真实缺陷:技能明明放在统一技能目录 `~/.agents/skills/<名字>`,
 * 界面却显示成「Zed 本体在这里」。根因是 core 的 `tools_of` 按"本体所在目录"
 * 反查 agent 时,6 个 agent(cline/dexto/kimi-code-cli/loaf/warp/zed)的全局
 * 技能目录恰好都是那个统一目录,前端再按"这台机器探测到哪些"收窄,用户机器上
 * 往往只剩一个,于是被点了名——而本体住统一目录时,它其实不属于任何一个工具。
 *
 * 所以这里绝不做"按目录反查 agent"这件事:`bodyLocationText` 先精确比较
 * 本体的父目录是不是就是 canonical 目录,命中直接返回不点名任何工具的那句话;
 * 只有走到第二步——父目录精确匹配某个工具的专属目录——才点名那一个工具。
 * `toolDirs` 刻意带着那 6 个 canonical 同款 agent(不预先滤掉它们),靠**判定顺序**
 * (canonical 先判)而不是靠"从数据里拿掉"来保证正确性,道理见下面的实现注释。
 */
export function bodyLocationText(
  body: string,
  canonicalDir: string,
  agentNames: Map<string, string>,
  toolDirs: Map<string, string>,
): string {
  const parent = parentDir(body);
  const canonical = normalizeSlashes(canonicalDir);
  // 先比 canonical:命中即返回统一目录那句话,压过下面的逐工具反查。
  // 这一步删掉就是退回"按目录反查 agent"——那正是要修的缺陷本身。
  if (canonical && parent === canonical) {
    return t("detail.whereBodyCanonical");
  }
  for (const [agent, dir] of toolDirs) {
    if (parent && parent === normalizeSlashes(dir)) {
      return t("detail.whereBodyTool", { tool: agentNames.get(agent) ?? agent });
    }
  }
  // 两个都没命中:路径本来就单独摆在旁边,这里给一句不点名任何工具的中性话,
  // 不猜、不编。
  return t("detail.whereBodyOther");
}

function normalizeSlashes(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function parentDir(path: string): string {
  const trimmed = normalizeSlashes(path);
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? "" : trimmed.slice(0, idx);
}

const SECTION_TITLE: Record<Section, "mine.sectionInstalledFrom" | "mine.sectionSharedTo" | "mine.sectionShareable"> = {
  installedFrom: "mine.sectionInstalledFrom",
  sharedTo: "mine.sectionSharedTo",
  shareable: "mine.sectionShareable",
};

function BlockShell({
  icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 border-t border-border py-3 first:border-t-0">
      <Icon icon={icon} size={15} className="mt-0.5 w-5 shrink-0 text-text-3" />
      <div className="min-w-0 flex-1">
        <div
          data-testid="where-title"
          className="text-[11px] font-[550] tracking-[0.05em] text-text-3"
        >
          {title}
        </div>
        <div className="mt-1 text-[12.5px] text-text-2">{children}</div>
      </div>
    </div>
  );
}

/** 块 1:这台电脑上。本体路径 + 「打开文件夹」,失败要有渲染点(不吞)。 */
function ThisComputerBlock({
  skill,
  agentNames,
}: {
  skill: InstalledSkillView;
  agentNames: Map<string, string>;
}) {
  const canonicalDir = useMySkills((s) => s.canonicalDir);
  const toolDirs = useMySkills((s) => s.toolDirs);
  const [revealError, setRevealError] = useState<string | null>(null);

  if (!skill.localPresent || !skill.body) {
    return (
      <BlockShell icon={Laptop} title={t("detail.whereTitle1")}>
        {t("detail.whereNotHere")}
      </BlockShell>
    );
  }

  const text = bodyLocationText(skill.body, canonicalDir, agentNames, toolDirs);

  return (
    <BlockShell icon={Laptop} title={t("detail.whereTitle1")}>
      <p>{text}</p>
      <p className="mt-1 truncate font-mono text-[12px] text-text-3" title={skill.body}>
        {skill.body}
      </p>
      <button
        type="button"
        onClick={() => {
          setRevealError(null);
          // 🔴 传 body(本体的绝对路径),绝不传 dirSlug——后者会被 skill_reveal
          // 解析成统一目录下的同名目录,本体很可能根本不在那里。
          skillReveal({ path: skill.body }).catch((raw: unknown) =>
            setRevealError(isAppError(raw) ? raw.message : t("error.generic")),
          );
        }}
        className="mt-1.5 inline-flex h-6 items-center gap-1.5 rounded-ctl border border-border px-2 text-[11.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
      >
        <Icon icon={FolderOpen} size={12} />
        {t("mine.openFolder")}
      </button>
      {revealError && (
        <p className="mt-1 text-[11px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.openFolderFailed")}
          {t("punct.labelSeparator")}
          {revealError}
        </p>
      )}
    </BlockShell>
  );
}

/**
 * 块 2:各个工具里。直接委托 `ToolChecks`——R21 收窄与"提交名单从全量 tools
 * 派生"两条不变量都活在那一层,这里裸拼 `ToolPicker` 会把两条护栏各抄一份。
 *
 * 🔴 **`setAgents` 的失败必须有渲染点(修复轮 1 Critical-1)**:`ToolChecks`
 * 只管把点击翻成 `skill_set_agents` 请求,失败结果(`toolFailures`/
 * `setAgentsError`)只写进 `useMySkills` 这个 store——它唯一的既有渲染点在
 * `MySkillsPage.tsx`,而这个块可能出现在 `MySkillsPage` 根本没挂载的地方
 * (从商店页打开详情),或者被详情面板的遮罩层盖住(从「我的技能」页打开时,
 * `MySkillsPage` 渲染在遮罩背后)。两种情况下,用户点一个勾遇到 `Ok(Differs)`
 * (那个位置已经有一份内容不同的东西,core 刻意不动它、也不写记录)时看到的
 * 就是:勾自己弹回未选中、零错误、零提示,再点还是一样——所以这里**复用**
 * `MySkillsPage` 那一套失败分流与文案键(不新增文案、不重写判据),自己开一份
 * 渲染点。`disabled={busy}` 同理:不传的话连点会跟正在处理的那次请求打架。
 */
function EachToolBlock({
  skill,
  agentNames,
}: {
  skill: InstalledSkillView;
  agentNames: Map<string, string>;
}) {
  const installedAgents = useMySkills((s) => s.installedAgents);
  const busy = useMySkills((s) => s.setAgentsBusy) === skill.dirSlug;
  // 🔴 跨技能状态泄漏(v7 任务 6 修复轮 2,R19):toolFailures/setAgentsError 是
  // useMySkills 的全局字段(ToolBlocked 类型里没有 dirSlug)。不按 toolFailuresFor
  // 过滤的话,用户对技能 A 打勾失败后不点「知道了」就打开技能 B 的详情,这里会显示
  // A 的占用路径、「打开文件夹」按钮也会指向 A 的位置——从"零反馈"变成了
  // "错误的反馈",对用户撒谎的是"哪个技能出了问题"。
  const rawFailures = useMySkills((s) => s.toolFailures);
  const rawSetAgentsError = useMySkills((s) => s.setAgentsError);
  const failuresFor = useMySkills((s) => s.toolFailuresFor);
  const mine = failuresFor === skill.dirSlug;
  const failures = mine ? rawFailures : null;
  const setAgentsError = mine ? rawSetAgentsError : null;
  const dismissToolFailures = useMySkills((s) => s.dismissToolFailures);
  // 这里裸算一遍 visibleTools 只是为了决定"有没有工具可显示",与 ToolChecks
  // 内部同一次调用结论必然一致(同一个函数、同一份输入)——耦合是隐式的:
  // ToolChecks 的 `if (shown.length === 0) return null` 哪天改了判据,
  // 这里也要跟着改,否则会渲染出一片"标题在、内容空"的空白。
  const shown = visibleTools(skill.tools, installedAgents);
  const [revealError, setRevealError] = useState<string | null>(null);

  const revealOrExplain = (path: string) => {
    setRevealError(null);
    skillReveal({ path }).catch((raw: unknown) =>
      setRevealError(isAppError(raw) ? raw.message : t("error.generic")),
    );
  };

  return (
    <BlockShell icon={Wrench} title={t("detail.whereTitle2")}>
      {shown.length === 0 ? (
        t("detail.whereToolsNone")
      ) : (
        <ToolChecks
          dirSlug={skill.dirSlug}
          tools={skill.tools}
          agentNames={agentNames}
          disabled={busy}
        />
      )}
      {setAgentsError && (
        <p className="mt-1.5 text-[11px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.toolsFailed")}
          {t("punct.labelSeparator")}
          {setAgentsError.message}
        </p>
      )}
      {failures && (
        <div className="mt-1.5 rounded-card border border-[#c0392b]/40 px-2 py-1.5 dark:border-[#e0705f]/40">
          <p className="text-[11px] font-medium text-[#c0392b] dark:text-[#e0705f]">
            {/* 按内容分流,与 MySkillsPage 同一份判据:全是"停下来问你"(differs)
                时说「需要你看一下」,只要有一条是真失败就得说「没能完成」。 */}
            {failures.some((f) => f.kind !== "differs")
              ? t("mine.toolsPartialFailed", { count: failures.length })
              : t("mine.toolsNeedLook", { count: failures.length })}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {failures.map((f, i) => (
              <li
                key={`${f.kind === "location" ? f.path : (f.agent ?? "-")}-${i}`}
                className="text-[11px] text-text-2"
              >
                {f.kind === "differs" ? (
                  (() => {
                    const tool = f.agent
                      ? (agentNames.get(f.agent) ?? f.agent)
                      : t("mine.toolCanonical");
                    return (
                      <>
                        <span>{t("mine.toolOccupied", { tool })}</span>
                        <button
                          type="button"
                          aria-label={t("mine.openFolderOf", { tool })}
                          onClick={() => revealOrExplain(f.existing)}
                          className="ml-1.5 underline decoration-dotted underline-offset-2 hover:text-text"
                        >
                          {t("mine.openFolder")}
                        </button>
                      </>
                    );
                  })()
                ) : f.kind === "location" ? (
                  <>
                    <span className="break-all font-mono text-[11px]" title={f.path}>
                      {f.path}
                    </span>
                    {t("punct.labelSeparator")}
                    {f.message}
                  </>
                ) : f.agent ? (
                  `${agentNames.get(f.agent) ?? f.agent}${t("punct.labelSeparator")}${f.message}`
                ) : (
                  f.message
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={dismissToolFailures}
            className="mt-1 h-6 rounded-ctl border border-border px-2 text-[11px] font-medium text-text-2 hover:border-border-strong hover:text-text"
          >
            {t("mine.dismiss")}
          </button>
          {revealError && (
            <p className="mt-1 text-[11px] text-[#c0392b] dark:text-[#e0705f]">
              {t("mine.openFolderFailed")}
              {t("punct.labelSeparator")}
              {revealError}
            </p>
          )}
        </div>
      )}
    </BlockShell>
  );
}

/**
 * 块 3:技能库里。只用 `InstalledSkillView` 上确实有的字段——作者字段这个类型
 * 上没有,不编;"有没有更新"只在能确定为真时才说,复用既有唯一判定 `hasUpdate`,
 * **不用** `lib/ownership.ts` 的 `sharedState`/`localEqualsRemote`。
 *
 * 🔴 不是"那是任务 7 的活、这里不方便重建"——真实理由是这个组件手上的 `index`
 * (`useStoreIndex().index`)是**当前商店页正浏览的那个库**,不一定是这个技能
 * 真正的来源库(从「我的技能」页之外的地方打开详情时尤其常见)。`hasUpdate`
 * 自己会比对 `registryId`/`sourceOwner`/`sourceRepo`,库不对就返回 `false`,
 * 顶多是这一行不出现;而 `localEqualsRemote` 库不对时返回 `null`,喂给
 * `sharedState` 会落进 `differs`「本地和库里不一样」——对一个其实已经同步的
 * 技能撒谎。所以块 3 只摆"确定为真"的那一半判定,拿不准就不摆这一行。 */
function LibraryBlock({ skill }: { skill: InstalledSkillView }) {
  const index = useStoreIndex((s) => s.index);
  const remoteChanged = hasUpdate(skill, index);

  return (
    <BlockShell icon={Library} title={t("detail.whereTitle3")}>
      <p>{t(SECTION_TITLE[skill.section])}</p>
      {skill.sourceLabel ? (
        <p className="mt-0.5 text-text-3">{t("mine.sourceLabel", { label: skill.sourceLabel })}</p>
      ) : (
        <p className="mt-0.5 text-text-3">{t("detail.whereSourceUnset")}</p>
      )}
      {remoteChanged && <p className="mt-0.5 text-text-3">{t("detail.whereHasUpdate")}</p>}
      {skill.review && (
        <p className="mt-0.5 text-text-3">
          <span>{t("detail.whereReviewPending")}</span>
          {skill.review.url && (
            <>
              {t("punct.labelSeparator")}
              <ReviewLink url={skill.review.url} />
            </>
          )}
        </p>
      )}
    </BlockShell>
  );
}

function ReviewLink({ url }: { url: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          openLibraryUrl(url).catch((raw: unknown) =>
            setError(isAppError(raw) ? raw.message : t("error.generic")),
          );
        }}
        className="inline-flex items-center gap-1 text-accent hover:underline"
      >
        <Icon icon={ExternalLink} size={11} />
        {t("detail.whereReviewLink")}
      </button>
      {error && <span className="ml-1 text-[#c0392b] dark:text-[#e0705f]">{error}</span>}
    </>
  );
}

export function WhereBlocks({
  skill,
  agentNames,
}: {
  skill: InstalledSkillView;
  agentNames: Map<string, string>;
}) {
  return (
    <div className="px-5">
      <ThisComputerBlock skill={skill} agentNames={agentNames} />
      <EachToolBlock skill={skill} agentNames={agentNames} />
      <LibraryBlock skill={skill} />
    </div>
  );
}
