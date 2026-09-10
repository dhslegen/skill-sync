import { ExternalLink, FileCode, FileText, Folder, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { InstallPanel } from "@/components/InstallPanel";
import { Markdown } from "@/components/Markdown";
import { SkillActionsBlock } from "@/components/SkillActionsBlock";
import { SkillIcon } from "@/components/SkillIcon";
import { WhereBlocks } from "@/components/WhereBlocks";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes, relativeTimeFromIso } from "@/lib/format";
import {
  BUILTIN_REGISTRY_ID,
  isAppError,
  openLibraryUrl,
  skillClaimAttribution,
  skillReveal,
  type AppError,
  type LocalSkillDetail,
  type SkillDetail,
} from "@/lib/ipc";
import { useInstall } from "@/store/install";
import { useLocalDetail } from "@/store/local-detail";
import { cardFor, hasUpdate, remoteChangedForShareable, useMySkills } from "@/store/my-skills";
import { locatePlazaSkill, usePlaza } from "@/store/plaza";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";

/** 详情是右侧滑出面板,不整页跳转(UI 规范 §5:借 Raycast 的"详情不跳页")。
 *  三个数据源共用同一个壳:商店详情(远端缓存)、本地详情(我的技能/分享页,直接读盘)、
 *  技能广场详情(M9 任务 5,现拉——"详情面板不联网"承诺的唯一破例,范围钉死在广场,
 *  见 core/plaza.rs 模块头)。 */
export function DetailPanel() {
  const { detailSlug, detail, detailError, closeDetail, index } = useStoreIndex();
  const local = useLocalDetail();
  const plaza = usePlaza();
  const localOpen = local.target !== null;
  const plazaOpen = plaza.detailOwnerRepo !== null;
  const open = detailSlug !== null || localOpen || plazaOpen;
  const close = localOpen ? local.close : plazaOpen ? plaza.closeDetail : closeDetail;
  const plazaMatched =
    plazaOpen && plaza.detailSkills
      ? locatePlazaSkill(plaza.detailSkills, plaza.detailWantedName, plaza.selectedDirSlug)
      : null;
  const title = localOpen
    ? local.detail?.name
    : plazaOpen
      ? (plazaMatched?.name ?? plaza.detailWantedName ?? plaza.detailOwnerRepo ?? undefined)
      : detail?.name;
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // 焦点管理。声明了 aria-modal 就得真的把焦点圈住:
  // 否则 Tab 会走到遮罩背后的卡片列表里,读屏用户完全不知道自己已经离开了面板。
  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    // 关闭时把焦点还给点开它的那张卡片,而不是丢回 <body>
    return () => returnFocusTo.current?.focus?.();
  }, [open]);

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div
        aria-hidden
        onClick={close}
        className={cn(
          "fixed inset-0 z-50 bg-[rgba(15,14,12,.25)] backdrop-blur-[2px] transition-opacity duration-150",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? t("detail.loading")}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cn(
          "fixed inset-y-0 right-0 z-51 flex w-[480px] flex-col border-l border-border bg-surface-1 shadow-[var(--shadow-pop)] outline-none",
          "transition-[transform,opacity] duration-[180ms] ease-out",
          open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0",
        )}
      >
        {localOpen ? (
          local.detail ? (
            <LocalPanelBody detail={local.detail} />
          ) : (
            <div className="p-5 text-[12.5px] text-text-3">
              {local.error ? local.error.message : t("detail.loading")}
            </div>
          )
        ) : plazaOpen ? (
          <PlazaPanelBody />
        ) : open && detail ? (
          <PanelBody detail={detail} repo={index?.repo ?? ""} />
        ) : open ? (
          <div className="p-5 text-[12.5px] text-text-3">
            {detailError ? detailError.message : t("detail.loading")}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * 「在哪」各块要用的 `InstalledSkillView`——`PanelBody`(商店/广场详情)与
 * `LocalPanelBody`(本地详情,「我的技能」的行打开的就是这一条路径)共用同一份
 * 查找逻辑:按 `dirSlug` 在 `useMySkills().list` 里找。找不到(浏览商店里一个
 * 从没在这台电脑上出现过的技能)就不渲染「在哪」——那几块本就是在回答"这台电脑上
 * 这个技能的情况",没有 `InstalledSkillView` 就没有可回答的东西。
 *
 * `list` 在 App 启动时已经会加载一次(侧边栏角标需要它),这里的 `load()` 只是
 * 防御性兜底——直接从商店页快速打开详情、或测试环境没有走过启动路径时,
 * 保证这一块不会因为"还没来得及拉"而永远空着。
 */
function useWhereSkill(dirSlug: string) {
  const list = useMySkills((s) => s.list);
  const agentNames = useMySkills((s) => s.agentNames);
  const load = useMySkills((s) => s.load);
  const shareableIndexes = useMySkills((s) => s.shareableIndexes);
  const index = useStoreIndex((s) => s.index);

  useEffect(() => {
    if (list === null) void load();
  }, [list, load]);

  const skill = list?.find((s) => s.dirSlug === dirSlug) ?? null;
  // 🔴 「库里那一版变了没有」在这一处算**一次**,折叠头的结论行、「技能库里」
  // 那一块、页脚的主按钮全部吃它。分流按 section:`shareable` 区有外部来源的行
  // 要按它自己那个源的索引判(`hasUpdate` 对这些行恒 false),其余按当前浏览的
  // 库判。三处各算一遍就是空转模式 ①,而且其中一处必然把外源那一档判丢。
  const remoteChanged = skill
    ? skill.section === "shareable"
      ? remoteChangedForShareable(skill, shareableIndexes)
      : hasUpdate(skill, index)
    : false;
  // 概览行(作者/标签)的数据源与「我的技能」页的行名字同一份实现,不另抄一遍。
  const card = skill ? cardFor(skill, index, shareableIndexes) : null;
  return { skill, agentNames, remoteChanged, card };
}

/**
 * 概览行(v7.1 任务 3,照画布 `Detail.dc.html` 标题区下方那条 `border-y`)。
 *
 * # 🔴 有什么摆什么,缺的整列不摆;**三列全缺时整行不摆**(Q4A)
 *
 * 这是本项目既有原则「没有条目整栏不摆、不编造」的直接应用——占位符
 * (「作者未知」「—」)是最弱的一种编造。全缺时若只是把列去掉而留着那个
 * `border-y` 的容器,画面上会出现一道莫名其妙的粗线,所以整行返回 `null`。
 *
 * 🔴 **「版本标识」那一列已删除**(Q9A):它显示的是 `commitSha`,而那是
 * **整库 HEAD**——别人改任何一个技能它都会变,拿它当"这个技能的版本"是撒谎。
 * 副标题里的 `@ sha` 同理一并删掉。
 * 「文件 N 个」那一列也删了:页签上的「文件 (N)」已经有这个数,两处重复。
 */
function OverviewRow({
  author,
  updated,
  tags,
  children,
}: {
  author?: string | null;
  updated?: string | null;
  tags?: string[] | null;
  /** 作者缺席时的替代内容(商店详情的「这是我分享的」入口)。有它就算这一列有东西。 */
  children?: React.ReactNode;
}) {
  const tagText = tags && tags.length > 0 ? tags.join(t("punct.listSeparator")) : null;
  if (!author && !children && !updated && !tagText) return null;

  return (
    <div className="mt-3.5 flex flex-wrap gap-4 border-y border-border py-2.5">
      {author ? <Meta label={t("detail.metaAuthor")} value={author} /> : children}
      {updated && <Meta label={t("detail.metaUpdated")} value={updated} />}
      {tagText && <Meta label={t("detail.metaTags")} value={tagText} />}
    </div>
  );
}

/** 「在访达/资源管理器中打开」的按钮文案按平台挑。webview 里没有可靠的 OS API,
 *  userAgent 足够区分三档——挑错平台也只是措辞不地道,不影响行为。 */
export function revealLabel(userAgent: string): string {
  if (userAgent.includes("Mac")) return t("detail.revealMac");
  if (userAgent.includes("Windows")) return t("detail.revealWin");
  return t("detail.revealOther");
}

function LocalPanelBody({ detail }: { detail: LocalSkillDetail }) {
  const close = useLocalDetail((s) => s.close);
  const [tab, setTab] = useState<"readme" | "files">("readme");
  const { skill, agentNames, remoteChanged, card } = useWhereSkill(detail.dirSlug);
  // 🔴 取回/更新失败的渲染点(终审复审轮 1,C-A)。`SkillActionsBlock` 的
  // 「更新」/「取回」走 `useMySkills.pull` → `useInstall.beginUpdate`,失败只写进
  // `useInstall.error`。商店/广场那条路(`PanelBody`)下方挂着 `InstallPanel`,
  // 它的 `ErrorFooter` 会把这件事说出来;**本地详情这条路没有 `InstallPanel`**
  // ——不在这里接一处,用户点了「更新」看到的就是"什么都没发生",与 CLAUDE.md
  // 记的「错误被写进某个状态,但没有渲染点」逐字同形。
  // 归属按 `dirSlug` 校验:`useInstall` 是全局单例,不校验的话这一屏会显示
  // 另一个技能上一次失败的话。
  const pullError = useInstall((s) =>
    s.dirSlug === detail.dirSlug && s.phase === "error" ? s.error : null,
  );

  return (
    <>
      <div className="px-5 pt-[18px]">
        <div className="flex items-center gap-3">
          <SkillIcon name={detail.name} className="size-10 rounded-[10px] text-[17px]" />
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-[650] tracking-[-0.015em]">{detail.name}</h2>
            {/* 副标题优先用**技能库里的坐标**(`skills/<目录名>`,照画布)——本体的
                绝对路径就在下面折叠头上等宽显示着,副标题再抄一遍是同屏两份同样的
                字符串。库里查不到这个技能(纯本地草稿)时才退回本体路径:那时
                折叠头是唯一一处,不构成重复。 */}
            <div
              className="mt-px truncate font-mono text-[11.5px] text-text-3"
              title={card?.path ?? detail.path}
            >
              {card?.path ?? detail.path}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            title={t("detail.close")}
            aria-label={t("detail.close")}
            className="ml-auto grid size-7 shrink-0 place-items-center self-start rounded-ctl text-text-2 hover:bg-surface-3 hover:text-text"
          >
            <Icon icon={X} />
          </button>
        </div>

        <OverviewRow
          author={card?.author}
          updated={skill ? relativeTimeFromIso(skill.updatedAt) : null}
          tags={card?.tags}
        />
      </div>

      {/* 🔴 v7.2 需求 2:「在哪」+ 页签 + 正文合用**同一个**滚动区,页脚才是
          真的固定的。见 {@link ScrollArea} 的文档(两个 PanelBody 同构,改一处
          就要改另一处)。 */}
      <ScrollArea>
        {/* 「在哪」压成一行折叠头(Q2),默认收起——正文才是主角。 */}
        {skill && (
          <WhereBlocks skill={skill} agentNames={agentNames} remoteChanged={remoteChanged} />
        )}
        {pullError && (
          <p className="px-5 pt-2 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
            {t("mine.pullFailed", { name: detail.name })}
            {t("punct.labelSeparator")}
            {pullError.message}
          </p>
        )}

        <TabsBar>
          <Tab selected={tab === "readme"} onClick={() => setTab("readme")}>
            {t("detail.tabReadme")}
          </Tab>
          <Tab selected={tab === "files"} onClick={() => setTab("files")}>
            {t("detail.tabFiles", { count: detail.files.length })}
          </Tab>
        </TabsBar>

        <div className="selectable px-5 pb-5 pt-3.5">
          {tab === "readme" ? (
            stripFrontmatter(detail.skillMd).trim() ? (
              <Markdown source={stripFrontmatter(detail.skillMd)} />
            ) : (
              <p className="text-[12.5px] text-text-3">{t("detail.noBody")}</p>
            )
          ) : (
            <FileTree detail={detail} />
          )}
        </div>
      </ScrollArea>

      {/* 固定页脚(Q3)。此前这里是一颗孤零零的「在访达中打开」,而同一个动作
          在「这台电脑上」那一块里还有一颗「打开文件夹」——同一件事两个入口两种
          叫法,且"访达"在 Windows 上是错的。两颗都删,动作统一收进页脚的
          `SkillActionsBlock`(它自己会摆「打开文件夹」并接住失败)。 */}
      {skill ? (
        <SkillActionsBlock skill={skill} remoteChanged={remoteChanged} host="mine" />
      ) : (
        <RevealOnlyFooter path={detail.path} />
      )}
    </>
  );
}

/**
 * 「我的技能」列表里找不到这一行时的**降级页脚**(终审 M-3)。
 *
 * v7.1 任务 3 之前,详情面板底部那颗「在访达中打开」是**无条件**渲染的;搬进
 * `SkillActionsBlock` 之后整个页脚挂在 `{skill && …}` 之下,而 `skill` 来自
 * `useWhereSkill`(在 `useMySkills.list` 里按 `dirSlug` 查)——`load()` 失败、
 * 或者刚装完就跳「到我的技能里看看」而列表还没刷新时,`skill` 就是 `null`,
 * 于是**面板底部一个动作都没有**。那不是"少一颗按钮",是本地详情这条路唯一的
 * 出口整个消失。
 *
 * 只摆「打开文件夹」这一颗:其余动作(更新/分享/移除)都要靠 `InstalledSkillView`
 * 上的字段判档,没有那一行就无从判起,摆出来的会是**猜**的档位。打开文件夹不需要
 * 任何判定——`detail.path` 就是本体所在目录(`core::local_detail` 直接给的绝对
 * 路径),这一条永远成立。文案与失败提示复用页脚那一份,不新增文案键:同一个动作
 * 在两条路上必须是同一个叫法。
 */
function RevealOnlyFooter({ path }: { path: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex-none border-t border-border px-5 py-3.5">
      <button
        type="button"
        onClick={() => {
          setError(null);
          skillReveal({ path }).catch((raw: unknown) =>
            setError(isAppError(raw) ? raw.message : t("error.generic")),
          );
        }}
        className="h-[30px] shrink-0 whitespace-nowrap rounded-ctl border border-border px-3 text-[12.5px] font-medium text-text-2 hover:border-border-strong hover:text-text"
      >
        {t("mine.openFolder")}
      </button>
      {error && (
        <p className="mt-1.5 text-[12px] text-[#c0392b] dark:text-[#e0705f]">
          {t("mine.openFolderFailed")}
          {t("punct.labelSeparator")}
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 技能广场详情态(M9 任务 5)。数据来自 `usePlaza`(现拉,不是索引缓存),
 * 三档:加载中/错误(+ 重试)/成功。成功之后还有一层"定位不到点击的那个"
 * (设计文档 §2.2:一个仓多个技能,名字对不上就落到该仓技能列表让用户挑)。
 */
function PlazaPanelBody() {
  const {
    detailOwnerRepo,
    detailWantedName,
    detailSlug,
    detailSkills,
    detailStatus,
    detailError,
    selectedDirSlug,
    retryDetail,
    selectDetailSkill,
  } = usePlaza();

  if (detailStatus === "error") {
    return (
      <div className="p-5">
        <p className="text-[12.5px] text-text-2">{detailError?.message}</p>
        <button
          type="button"
          onClick={() => void retryDetail()}
          className="mt-2.5 h-7 rounded-ctl border border-border px-2.5 text-[12px] font-medium text-text-2 hover:border-border-strong hover:text-text"
        >
          {t("store.retry")}
        </button>
      </div>
    );
  }

  if (detailStatus !== "ready" || !detailSkills) {
    return <div className="p-5 text-[12.5px] text-text-3">{t("detail.loading")}</div>;
  }

  const matched = locatePlazaSkill(detailSkills, detailWantedName, selectedDirSlug);
  if (matched) {
    return (
      <PanelBody
        detail={matched}
        repo={detailOwnerRepo ?? ""}
        plaza={{ ownerRepo: detailOwnerRepo ?? "", slug: detailSlug ?? "" }}
      />
    );
  }

  return (
    <PlazaSkillPicker ownerRepo={detailOwnerRepo ?? ""} skills={detailSkills} onPick={selectDetailSkill} />
  );
}

/** 定位不到点击的那个技能时,落到该仓的技能列表让用户另选一个。 */
function PlazaSkillPicker({
  ownerRepo,
  skills,
  onPick,
}: {
  ownerRepo: string;
  skills: SkillDetail[];
  onPick: (dirSlug: string) => void;
}) {
  const closePlaza = usePlaza((s) => s.closeDetail);

  return (
    <>
      <div className="flex items-center gap-3 px-5 pt-[18px]">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[15px] font-[650]">{ownerRepo}</h2>
        </div>
        <button
          type="button"
          onClick={closePlaza}
          title={t("detail.close")}
          aria-label={t("detail.close")}
          className="grid size-7 shrink-0 place-items-center self-start rounded-ctl text-text-2 hover:bg-surface-3 hover:text-text"
        >
          <Icon icon={X} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-5 pt-3.5">
        {skills.length === 0 ? (
          <p className="text-[12.5px] text-text-3">{t("store.empty")}</p>
        ) : (
          <>
            <p className="mb-2.5 text-[12px] text-text-3">{t("plaza.detailAmbiguous")}</p>
            <div className="flex flex-col gap-1.5">
              {skills.map((s) => (
                <button
                  key={s.dirSlug}
                  type="button"
                  onClick={() => onPick(s.dirSlug)}
                  className="rounded-card border border-border px-3 py-2 text-left hover:border-border-strong"
                >
                  <div className="text-[13px] font-medium">{s.name}</div>
                  {s.description && (
                    <div className="clamp-2 mt-0.5 text-[12px] text-text-2">{s.description}</div>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** 跳去 skills.sh 的技能页——`open_library_url` 通道,同源白名单已在 core 放行(M9)。 */
function PlazaBrowserLink({ slug }: { slug: string }) {
  const [openError, setOpenError] = useState<string | null>(null);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => {
          setOpenError(null);
          openLibraryUrl(`https://skills.sh/${slug}`).catch((raw) =>
            setOpenError(isAppError(raw) ? raw.message : t("error.generic")),
          );
        }}
        className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-accent hover:underline"
      >
        <Icon icon={ExternalLink} size={12} />
        {t("plaza.openInBrowser")}
      </button>
      {openError && (
        <p className="mt-1 text-[11px] text-[#c0392b] dark:text-[#e0705f]">{openError}</p>
      )}
    </div>
  );
}

function PanelBody({
  detail,
  repo,
  plaza,
}: {
  detail: SkillDetail;
  repo: string;
  /** 广场态(M9 任务 5):关闭走广场自己的 store,多一个"在浏览器查看"入口,
   *  底部获取区带着来源坐标走 `beginFromPlaza`。 */
  plaza?: { ownerRepo: string; slug: string };
}) {
  const closeDetailStore = useStoreIndex((s) => s.closeDetail);
  const closePlaza = usePlaza((s) => s.closeDetail);
  const closeDetail = plaza ? closePlaza : closeDetailStore;
  const [tab, setTab] = useState<"readme" | "files">("readme");
  const {
    skill: whereSkill,
    agentNames: whereAgentNames,
    remoteChanged: whereRemoteChanged,
  } = useWhereSkill(detail.dirSlug);

  // 「这是我分享的」(v6 任务 5)的门槛:`useSession` 只反映**内建源**的登录态
  // (`auth_status` 不带 registryId),`claim_attribution` 也只有 Gitea 型的库支持
  // ——广场(GitHub)与任何非内建源都不满足,摆出来就是一个必然报错的按钮。
  const registryId = useStoreIndex((s) => s.index?.registryId);
  const activeRepo = useStoreIndex((s) => s.activeRepo);
  const signedIn = useSession((s) => s.status === "signedIn");
  const canClaimAttribution = !plaza && registryId === BUILTIN_REGISTRY_ID && signedIn;

  return (
    <>
      <div className="px-5 pt-[18px]">
        <div className="flex items-center gap-3">
          <SkillIcon name={detail.name} className="size-10 rounded-[10px] text-[17px]" />
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-[650] tracking-[-0.015em]">{detail.name}</h2>
            {/* 🔴 副标题里**不出现** `@ sha`(Q9A):那是整库 HEAD,不是这个
                技能的版本,摆出来是在撒谎。 */}
            <div className="mt-px truncate font-mono text-[11.5px] text-text-3">
              {repo}/{detail.dirSlug}
            </div>
          </div>
          <button
            type="button"
            onClick={closeDetail}
            title={t("detail.close")}
            aria-label={t("detail.close")}
            className="ml-auto grid size-7 shrink-0 place-items-center self-start rounded-ctl text-text-2 hover:bg-surface-3 hover:text-text"
          >
            <Icon icon={X} />
          </button>
        </div>
        {plaza && <PlazaBrowserLink slug={plaza.slug} />}

        {/* 作者/贡献者来自技能库的 authors.json(服务端维护);没有就整栏不摆,
            换成「作者未登记 · 这是我分享的」这个入口(登录了、且是内建源才摆)。 */}
        <OverviewRow
          author={detail.attribution?.author}
          updated={relativeTimeFromIso(detail.committedAt)}
          tags={detail.tags}
        >
          {!detail.attribution && canClaimAttribution && (
            <ClaimAttribution dirSlug={detail.dirSlug} repo={activeRepo ?? undefined} />
          )}
        </OverviewRow>
        {detail.attribution && detail.attribution.contributors.length > 0 && (
          <div className="flex flex-wrap gap-4 border-b border-border py-2.5">
            <Meta
              label={t("detail.metaContributors")}
              value={contributorsText(detail.attribution.contributors)}
            />
          </div>
        )}
      </div>

      {/* 🔴 v7.2 需求 2:与 `LocalPanelBody` 同构的滚动区,见 {@link ScrollArea}。 */}
      <ScrollArea>
        {whereSkill && (
          <WhereBlocks
            skill={whereSkill}
            agentNames={whereAgentNames}
            remoteChanged={whereRemoteChanged}
          />
        )}

        <TabsBar>
          <Tab selected={tab === "readme"} onClick={() => setTab("readme")}>
            {t("detail.tabReadme")}
          </Tab>
          <Tab selected={tab === "files"} onClick={() => setTab("files")}>
            {t("detail.tabFiles", { count: detail.files.length })}
          </Tab>
        </TabsBar>

        {/* 正文区是全站唯一放开选中与文本光标的地方(`selectable` 只挂在这一层,
            不上提到 ScrollArea——上提就把「在哪」与页签也一起放开了)。 */}
        <div className="selectable px-5 pb-5 pt-3.5">
          {tab === "readme" ? (
            detail.skillMd.trim() ? (
              <Markdown source={stripFrontmatter(detail.skillMd)} />
            ) : (
              <p className="text-[12.5px] text-text-3">{t("detail.noBody")}</p>
            )
          ) : (
            <FileTree detail={detail} />
          )}
        </div>
      </ScrollArea>

      {/* 设计 §12 的动作区,v7.1 起搬到正文之下(md 是主角)。
          🔴 v7.6 任务 2(Q44-A):此前这里还有一段注释说"两者上下并存"——那是
          在承认欠账:`SkillActionsBlock`(自己的边框 + 主按钮)与下面的
          `InstallPanel`(自己的边框 + 主按钮)分别渲染,商店详情面板同屏出现
          两个看着都像主按钮的东西,正是用户截图里那个 bug。现在真正并了进去:
          `SkillActionsBlock` 不再单独出现在这里,而是以 `host="store"` 算出
          一份**只有次要动作**(打开文件夹/在技能库里查看/移除,不含主按钮)的
          `ReactNode`,交给 `InstallPanel` 的 `actions` prop——`InstallPanel`
          自己**唯一**的一层 `border-t` 容器才是这条路真正的、单一的页脚。
          「已装到」(原 `InstalledScopes`)已经并进 `WhereBlocks` 的第四块
          「项目里」(Q46-A),不再是夹在正文与页脚之间的第三个独立块。 */}
      <InstallPanel
        dirSlug={detail.dirSlug}
        plaza={plaza ? { ownerRepo: plaza.ownerRepo } : undefined}
        actions={
          whereSkill ? (
            <SkillActionsBlock skill={whereSkill} remoteChanged={whereRemoteChanged} host="store" />
          ) : undefined
        }
      />
    </>
  );
}

/**
 * 「作者未登记 · 这是我分享的」(v6 任务 3 的 `skill_claim_attribution`)。
 *
 * `done`/`review` 两档都**只落本地 `status`,不触碰 `useStoreIndex` 的任何字段**
 * ——既不调 `openDetail(dirSlug)` 也不调 `load(true)`,即便看起来"重刷一下索引/
 * 详情,让作者信息自然出现"更省事:
 * - `review`(走审核)那一支根本还没合并进默认分支,重载出来的 `attribution`
 *   仍是 `null`,门槛条件不变,按钮会重新摆出来引诱用户再交一次审核(核心的
 *   `CONFLICT_ALREADY_ATTRIBUTED` 只挡"已经登记过"的库,挡不住"我自己交了
 *   两次审核"这件事);
 * - `done`(直推)按理攒得到新数据,但**这个组件的门槛 `canClaimAttribution`
 *   与外层 `PanelBody` 的渲染分支,读的是同一份 `useStoreIndex` 状态**
 *   (`registryId`/`detail`)。`openDetail` 第一步就同步把 `detail` 置空当
 *   加载态;`load(true)` 在请求落地前会先换新 `index` 对象、请求本身失败或
 *   竞态时甚至可能把 `index` 变成 `null`——两条路殊途同归:只要 `index`/
 *   `detail` 一变,门槛判定就可能翻转,把这个组件连同刚设的 "done" 状态一起
 *   卸载,用户看到的是面板闪一下"正在读取…",连「已登记为分享者」这句确认都
 *   看不见(2026-08-24 本地复现两次,分别踩中这两条路,都不是测试假象)。
 *
 * 所以两档都不摸 `useStoreIndex`,状态只活在这个组件实例里(换一个技能查看会
 * 重新挂载、重新判一次门槛);商店卡片上的作者字段留到下一次自然刷新
 * (重新进商店页/手动重试)才会跟上——这是刻意接受的代价,好过一个必然
 * 自我卸载的组件。
 */
function ClaimAttribution({ dirSlug, repo }: { dirSlug: string; repo?: string }) {
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "review" | "error">("idle");
  const [error, setError] = useState<AppError | null>(null);

  const claim = async () => {
    setStatus("pending");
    setError(null);
    try {
      const outcome = await skillClaimAttribution({ dirSlug, repo });
      if (outcome.outcome === "shared") {
        setStatus(outcome.mode === "pushed" ? "done" : "review");
      }
      // 🔴 到此为止,**不**顺手刷 `useStoreIndex`(既不是 `openDetail(dirSlug)`
      // 也不是 `load(true)`):这个组件的 `canClaimAttribution` 门槛与外层
      // `PanelBody` 的渲染分支都读同一份 `useStoreIndex` 状态
      // (`registryId`/`detail`)。`openDetail` 第一步就同步把 `detail` 置空
      // 当加载态;`load(true)` 在请求落地前会先把 `index` 换成新对象、请求本身
      // 失败或竞态时甚至可能把 `index` 变成 `null`——两条路殊途同归:只要
      // `index`/`detail` 一变,`canClaimAttribution` 或 `open && detail` 的判定
      // 就可能翻转,把这个组件连同刚设的 "done"/"review" 状态一起卸载
      // (2026-08-24 本地复现两次,分别踩中这两条路,都不是测试假象)。
      // 商店卡片上的作者字段留到下一次自然刷新(重新进商店页/手动重试)才会跟上,
      // 这是刻意接受的代价——好过一个必然自我卸载的组件。
    } catch (raw) {
      setStatus("error");
      setError(isAppError(raw) ? raw : null);
    }
  };

  if (status === "done" || status === "review") {
    return (
      <div className="text-[11px] leading-[1.4] text-text-3">
        {t("detail.metaAuthor")}
        <b className="block text-[12.5px] font-[550] text-text">
          {status === "done" ? t("detail.claimAttributionDone") : t("detail.claimAttributionReview")}
        </b>
      </div>
    );
  }

  return (
    <div className="text-[11px] leading-[1.4] text-text-3">
      {t("detail.metaAuthor")}
      <div className="mt-px flex items-center gap-1.5">
        <span className="text-[12.5px] font-[550] text-text">{t("detail.unattributed")}</span>
        <span aria-hidden className="text-text-3">
          ·
        </span>
        <button
          type="button"
          disabled={status === "pending"}
          onClick={() => void claim()}
          className="text-[12.5px] font-[550] text-accent hover:underline disabled:opacity-50"
        >
          {status === "pending" ? t("detail.claimAttributionPending") : t("detail.claimAttribution")}
        </button>
      </div>
      {status === "error" && error && (
        <p className="mt-1 max-w-[220px] text-[11px] leading-[1.4] text-[#c0392b] dark:text-[#e0705f]">
          {error.message}
        </p>
      )}
    </div>
  );
}

/** 概览行里的一列。**`mono` 那个可选参数已删**(v7.1 任务 3):它唯一的用户是
 *  Q9A 撤掉的「版本标识」列,留着就是一个没有调用方的分支。 */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-[11px] leading-[1.4] text-text-3">
      {label}
      <b className="block text-[12.5px] font-[550] text-text">{value || "—"}</b>
    </div>
  );
}

/**
 * 详情面板的滚动区(v7.2 需求 2)。
 *
 * # 为什么「在哪」也得住进来
 *
 * 面板是一列 flex:头部 / 「在哪」/ 页签 / 正文 / 固定页脚。v7.1 里正文是唯一的
 * 滚动区(`flex-1 overflow-y-auto`),而 `flex-1` = `flex: 1 1 0%`——**基准是 0**,
 * 于是正文被压到 0 之后整列就再也没有可压缩的余量了,「在哪」或它里面的「…」
 * 再展开一点,溢出的部分直接把页脚顶出列外。用户的原话是"「…」展开会把底部
 * 操作按钮顶下去";矮窗口下实测页脚 y 从 596 跳到 626(视口高 640)。
 *
 * 只给「在哪」封一个 `max-h` 治不了本:vh 值是拍脑袋的,窗口再矮一点照样溢出,
 * 还多一层嵌套滚动条。正解是**把会长高的东西全部放进同一个滚动区**,页脚保持
 * `flex-none`,于是"页脚固定"是结构保证的,不是靠内容恰好不够高。
 *
 * `min-h-0` 不能省:flex 子项的 `min-height:auto` 会按内容撑开,加了
 * `overflow-y-auto` 才解析成 0——两者要一起写才真的可收缩。
 *
 * ⚠️ 两个 PanelBody(本地详情 / 商店·广场详情)结构同构,**改一处必须改另一处**
 * ——v7.1 那次就是只看了其中一个三明治。
 */
function ScrollArea({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/**
 * 说明/文件两个页签那一条。搬进滚动区之后要 `sticky top-0` 才不会被「在哪」
 * 顶走,而吸顶**必须给不透明底色**(`bg-surface-1` = 面板底色),否则正文会从
 * 它字底下透出来。UI 规范禁毛玻璃,这里就是纯不透明底色。
 * `z-10` 压在正文之上,又在「更多」下拉与遮罩之下。
 */
function TabsBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="sticky top-0 z-10 flex gap-0.5 border-t border-border bg-surface-1 px-5 pt-2.5"
      role="tablist"
    >
      {children}
    </div>
  );
}

function Tab({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "rounded-ctl px-2.5 py-[5px] text-[12.5px] font-medium",
        selected ? "bg-accent-soft font-[550] text-accent" : "text-text-2 hover:bg-surface-3 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|ps1|rb)$/i;

/** 文件树。对脚本文件单独用另一种图标,并在目录行给出"含可执行脚本"警示(UX 增强 #2)。
 *  商店详情与本地详情共用,只依赖两者都有的三个字段。 */
function FileTree({
  detail,
}: {
  detail: Pick<SkillDetail, "dirSlug" | "files" | "hasScripts">;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-border">
      <div className="flex items-center gap-2 bg-surface-2 px-3 py-1.5 text-[12.5px] font-[550]">
        <Icon icon={Folder} />
        <span className="font-mono text-[12px]">{detail.dirSlug}/</span>
        {detail.hasScripts && (
          <span className="inline-flex items-center gap-1 rounded-[4px] bg-[rgba(200,150,20,.12)] px-[7px] py-px text-[11px] font-medium text-[#9a6a00] dark:text-[#d9a94a]">
            <Icon icon={TriangleAlert} size={11} />
            {t("skill.hasScripts")}
          </span>
        )}
      </div>
      {detail.files.map((file) => (
        <div
          key={file.path}
          className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[12.5px]"
        >
          <Icon icon={SCRIPT_EXT.test(file.path) ? FileCode : FileText} />
          <span className="truncate font-mono text-[12px]">{file.path}</span>
          <span className="ml-auto shrink-0 text-[11px] text-text-3">
            {formatBytes(file.size)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染正文时去掉 frontmatter。
 *
 * 缓存里存的是 SKILL.md 全文(详情要能离线打开),而 frontmatter 是给机器看的元数据,
 * 直接渲染会在正文顶部露出一段 `name:`/`description:`。
 */
/** 贡献者展示文案:3 人以内全列,超出列前 3 并缀「等 N 人」(N = 总人数)。
 *  元信息区是一行窄栏,十几个名字全列会把整行挤崩——截断是版式约束,不是隐藏信息,
 *  完整名单在技能库页面上本来就查得到。 */
export function contributorsText(names: string[]): string {
  const MAX_SHOWN = 3;
  if (names.length <= MAX_SHOWN) return names.join(t("punct.listSeparator"));
  return t("detail.metaContributorsMore", {
    names: names.slice(0, MAX_SHOWN).join(t("punct.listSeparator")),
    count: names.length,
  });
}

export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}
