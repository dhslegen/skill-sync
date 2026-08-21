import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { t } from "@/i18n";
import { useChangelog } from "@/store/changelog";
import type { ReleaseNote } from "@/lib/ipc";

/**
 * 刚升级完那一次,在商店页顶部摆一张可关闭的卡片,说清这一版改了什么。
 *
 * # 为什么是卡片不是弹窗(2026-08-21 用户拍板前的推荐,已采纳)
 *
 * 这个应用处理"有事发生了"一直是非阻塞的(自更新备好 = 左下角 pill,
 * 安装结果 = 面板),**模态被留给"必须由用户拍板否则没法继续"的场合**
 * (冲突三选、移除双确认)。更新日志不属于那一类:不看也能照常用。
 * 破这条规矩的代价是用户开始把模态当噪音,等真需要他拍板时也顺手点掉。
 *
 * "不会错过"靠的不是模态,是**关掉才记已看过**(见 `store/changelog.ts`):
 * 没点就退出,下次启动还在。
 *
 * 挂在商店页是因为 `store/ui.ts` 的 `page` 默认恒为 `store` 且**不持久化**
 * ——每次启动必定落在这一页,不存在"用户落在别的页就永远错过"的漏洞。
 * 这条前提要是变了(比如将来记住上次停留的页),这张卡片就得跟着搬家。
 */
export function ChangelogCard() {
  const pending = useChangelog((s) => s.pending);
  const current = useChangelog((s) => s.current);
  const dismissed = useChangelog((s) => s.dismissed);
  const load = useChangelog((s) => s.load);
  const dismiss = useChangelog((s) => s.dismiss);

  useEffect(() => {
    void load();
  }, [load]);

  if (dismissed || pending.length === 0) return null;

  const [head, ...missed] = pending;

  return (
    <div className="mb-3 rounded-card border border-border border-l-[3px] border-l-[var(--accent)] bg-surface-1 px-3.5 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-[550]">
            {t("changelog.updatedTo", { version: current || head.versions[0] })}
          </div>
          {head.theme && <div className="mt-0.5 text-[12px] text-text-2">{head.theme}</div>}
        </div>
        <button
          type="button"
          aria-label={t("changelog.dismiss")}
          onClick={() => void dismiss()}
          className="flex size-6 shrink-0 items-center justify-center rounded-ctl text-text-3 hover:bg-surface-2 hover:text-text"
        >
          <Icon icon={X} size={14} />
        </button>
      </div>

      {/* 🔴 正文必须限高:真机自查发现 0.4.0 那一段(六条要点 + 两段说明)让卡片
          吃掉了首屏近一半,技能卡片被挤到看不见——而"打扰最低"正是选卡片而不是
          弹窗的理由,不限高等于自己把这个理由作废。信息一条不少,超出的滚动看。
          设计里只为"跨版本"做了折叠,漏掉了"单段本身就很长"这一档。 */}
      <div
        data-testid="changelog-body"
        className="mt-2 max-h-[168px] overflow-y-auto pr-1 text-[12.5px]"
      >
        <Markdown source={head.body} />
      </div>

      {/* 跨版本时漏看的那几段收成一行。内网发版很密,一口气跨好几版是常态,
          全展开会把首屏整个吃掉——信息一条不少,只是默认收起。 */}
      {missed.map((note) => (
        <MissedVersion key={note.versions.join("/")} note={note} />
      ))}
    </div>
  );
}

function MissedVersion({ note }: { note: ReleaseNote }) {
  const [open, setOpen] = useState(false);
  const label = t("changelog.alsoMissed", { version: note.versions.join(" / ") });

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[12px] text-text-2 hover:text-text"
      >
        {/* 图标一律 Lucide(UI 规范硬规则)。原先用的是 ▸/▾ 字符 —— 真机自查一眼看出
            它与全站图标不是一套:字重、基线、大小都对不上,还随字体变。 */}
        <Icon icon={open ? ChevronDown : ChevronRight} size={13} className="shrink-0" />
        <span>
          {label}
          {note.theme && <span className="text-text-3">:{note.theme}</span>}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 text-[12.5px]">
          <Markdown source={note.body} />
        </div>
      )}
    </div>
  );
}
