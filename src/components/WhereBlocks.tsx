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

/** 块 2:各个工具里。直接委托 `ToolChecks`——R21 收窄与"提交名单从全量 tools
 *  派生"两条不变量都活在那一层,这里裸拼 `ToolPicker` 会把两条护栏各抄一份。 */
function EachToolBlock({
  skill,
  agentNames,
}: {
  skill: InstalledSkillView;
  agentNames: Map<string, string>;
}) {
  const installedAgents = useMySkills((s) => s.installedAgents);
  const shown = visibleTools(skill.tools, installedAgents);

  return (
    <BlockShell icon={Wrench} title={t("detail.whereTitle2")}>
      {shown.length === 0 ? (
        t("detail.whereToolsNone")
      ) : (
        <ToolChecks dirSlug={skill.dirSlug} tools={skill.tools} agentNames={agentNames} />
      )}
    </BlockShell>
  );
}

/** 块 3:技能库里。只用 `InstalledSkillView` 上确实有的字段——作者字段这个类型
 *  上没有,不编;"有没有更新"只在能确定为真时才说(复用既有唯一判定 `hasUpdate`),
 *  拿不准就不摆这一行,不去重建整套 `sharedState` 抢任务 7 的活。 */
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
