import { LayoutGrid, Check, Share2, Settings, LogIn } from "lucide-react";

import { Icon } from "@/components/Icon";
import { UpdatePill } from "@/components/UpdatePill";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { skillGlyph } from "@/lib/tint";
import { updateCount, useMySkills } from "@/store/my-skills";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi, type PageId } from "@/store/ui";

const NAV: { group: MessageKey; items: { id: PageId; label: MessageKey; icon: typeof LayoutGrid }[] }[] = [
  {
    group: "nav.groupSkills",
    items: [
      { id: "store", label: "nav.store", icon: LayoutGrid },
      { id: "mine", label: "nav.mine", icon: Check },
      { id: "share", label: "nav.share", icon: Share2 },
    ],
  },
  {
    group: "nav.groupApp",
    items: [{ id: "settings", label: "nav.settings", icon: Settings }],
  },
];

/** 窄侧边栏(208px)。macOS 顶部留出红绿灯位——brand 的上边距就是那 52px。 */
export function Sidebar({ version }: { version: string }) {
  const page = useUi((s) => s.page);
  const setPage = useUi((s) => s.setPage);
  // 「我的技能」角标:与页内逐条徽标同一份判定(updateCount 内部走 hasUpdate),
  // 免得出现"角标说 3、点进去只有 1"
  const list = useMySkills((s) => s.list);
  const index = useStoreIndex((s) => s.index);
  const updates = updateCount(list, index);

  return (
    <aside className="flex flex-col border-r border-border bg-[var(--sidebar-bg)] px-2 pb-2.5 backdrop-blur-[20px]">
      <div className="mb-3.5 mt-[52px] flex items-center gap-2 px-2.5">
        <span className="grid size-[22px] place-items-center rounded-[6px] bg-accent text-white">
          {/* 品牌标记:同步双箭头。这是唯一手写的 svg,Lucide 里没有同形状的 */}
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2" />
            <polyline points="21 3 21 9 15 9" />
            <polyline points="3 21 3 15 9 15" />
          </svg>
        </span>
        <b className="text-[13.5px] font-semibold tracking-[-0.01em]">{t("app.name")}</b>
        <small className="ml-auto font-mono text-[10px] text-text-3">v{version}</small>
      </div>

      {NAV.map((section) => (
        <div key={section.group}>
          <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium tracking-[0.04em] text-text-3">
            {t(section.group)}
          </div>
          {section.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setPage(item.id)}
              aria-current={page === item.id ? "page" : undefined}
              className={cn(
                "mb-px flex w-full items-center gap-[9px] rounded-ctl px-2.5 py-1.5 text-left font-[450]",
                page === item.id
                  ? "bg-accent-soft font-[550] text-accent"
                  : "text-text-2 hover:bg-surface-3 hover:text-text",
              )}
            >
              <Icon icon={item.icon} />
              {t(item.label)}
              {item.id === "mine" && updates > 0 ? (
                <span
                  data-testid="nav-badge"
                  className="ml-auto min-w-[17px] rounded-full bg-accent px-1 text-center font-mono text-[10px] leading-[17px] text-white"
                >
                  {updates}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ))}

      <div className="mt-auto">
        <UpdatePill />
        <div className="border-t border-border pt-2.5">
          <AccountRow />
        </div>
      </div>
    </aside>
  );
}

/**
 * 账号行。技能库公开可匿名读,所以未登录也能一直逛商店——这一行是入口,不是关卡。
 * 完整登录页不在本任务范围。
 */
function AccountRow() {
  const { status, user, signIn } = useSession();

  if (status === "signedIn" && user) {
    return (
      <div className="flex items-center gap-2 rounded-ctl px-2.5 py-[5px] hover:bg-surface-3">
        <span className="grid size-[22px] place-items-center rounded-full border border-border-strong bg-surface-3 text-[10.5px] font-semibold text-text-2">
          {skillGlyph(user.displayName)}
        </span>
        <span className="min-w-0 leading-[1.25]">
          <span className="block truncate text-[12.5px] font-medium">{user.displayName}</span>
          <small className="text-[11px] text-text-3">{t("account.connectedTo")}</small>
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={signIn}
      disabled={status === "signingIn"}
      className="flex w-full items-center gap-2 rounded-ctl px-2.5 py-[5px] text-left text-text-2 hover:bg-surface-3 hover:text-text"
    >
      <span className="grid size-[22px] place-items-center rounded-full border border-border-strong bg-surface-3 text-text-3">
        <Icon icon={LogIn} size={12} />
      </span>
      <span className="min-w-0 leading-[1.25]">
        <span className="block text-[12.5px] font-medium">
          {status === "signingIn" ? t("account.signingIn") : t("account.signIn")}
        </span>
        <small className="text-[11px] text-text-3">{t("account.signInHint")}</small>
      </span>
    </button>
  );
}
