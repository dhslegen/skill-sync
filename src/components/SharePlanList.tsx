import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { FileViewer, type FileViewerBody } from "@/components/FileViewer";
import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { skillLocalFileRead, type LocalSkillTarget, type SharePlan } from "@/lib/ipc";

/**
 * 「这次分享会让技能库有哪些变化」的清单(v8 任务 5 / 决策 D6、D9)。
 *
 * # 为什么单独一个组件
 *
 * 两个宿主要摆同一份清单:「可分享到」区的确认屏(`ShareConfirm`)与「分享改动」
 * 那条路的确认屏(`ShareOverwriteDialog`)。抄成两份必然漂移,而这份清单的
 * **删除**那一栏是用户唯一一次看到"库里哪几个文件会没"的机会——两处说法不一致
 * 就是对用户撒谎。判据在 core(`share::plan_changes`),这里只负责把它摆出来。
 *
 * # 删除那一栏刻意最显眼
 *
 * 新增与修改是"我的东西进库",删除是"库里的东西没了",后者不可由本人单方面
 * 无声完成——铁律「绝不静默删除用户文件」对服务端同样适用。所以它单独一句话
 * 交代后果,而不是与另外两栏并排成三个同色小标题。
 *
 * 空清单的那一栏整条不摆(不写「删除:无」)。
 *
 * # 文件多时清单本身要能滚(终审 I-3)
 *
 * 首次分享一个文件多的技能,这份清单会把「确认 / 取消」两颗按钮顶出视口——用户
 * 看得到清单、却按不到确认,而这一屏是分享的唯一出口。照 `ChangelogCard` 的既有
 * 做法限高 + 内部滚动:信息一条不少,超出的滚着看。
 *
 * 🔴 **限高的是三栏文件名,不是整块**:那句「这 N 个文件会从技能库里删掉」
 * (`share.planDeleteHint`)必须一直在视野里——它是删除这件事唯一的后果交代,
 * 滚进溢出区就等于没说。
 *
 * # 就地展开(v8 任务 10 / 设计 Q10、Q16、Q20)
 *
 * 点清单里的任何一个文件就在原位展开看内容——**展开能力放在这个组件身上**,
 * 而不是两个宿主各接一份:两屏"同一份清单、同一种看法"是 Q16 的原话,拆开写
 * 就会出现"这一屏能看差异、那一屏只能看文件名"。三类各有各的来源:
 * - 新增 → 本地盘按需读(`skill_local_file_read`;清单里刻意不带正文,顾问②);
 * - 修改 → 清单自带的差异;「全文」那一态同样按需读本地(本地就是新的那一版);
 * - 删除 → 清单自带的**库里那一版**(本地根本没有它)。
 *
 * `localTarget` 由宿主给:它必须与 core 算这份清单时定位本体的方式一致,
 * 否则"看到的新内容"与"要推的新内容"可能是两个文件夹里的东西。
 * 宿主还要按"哪个技能的哪一份清单"给这个组件 `key`——清单重算过(stale)之后,
 * 上一份展开的内容就是过期的,不能留在屏上。
 */
export function SharePlanList({ plan, localTarget }: { plan: SharePlan; localTarget: LocalSkillTarget }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const readLocal = (path: string) => () => skillLocalFileRead(localTarget, path);

  const added: Entry[] = plan.added.map((f) => ({
    path: f.path,
    body:
      f.body.kind === "binary"
        ? { kind: "content", content: { kind: "binary" } }
        : { kind: "read", read: readLocal(f.path) },
  }));
  const modified: Entry[] = plan.modified.map((f) => ({
    path: f.path,
    body: { kind: "diff", diff: f.diff, readFull: readLocal(f.path) },
  }));
  const deleted: Entry[] = plan.deleted.map((f) => ({
    path: f.path,
    body: { kind: "content", content: f.body },
  }));

  return (
    <div className="mt-3 rounded-card border border-border bg-surface-2 px-2.5 py-2">
      <p className="text-[11.5px] text-text-3">{t("share.planTitle")}</p>
      {/* 展开之后一段差异就不止几行了,滚动盒跟着放高;删除后果那一句仍在盒外 */}
      <div
        data-testid="share-plan-files"
        className={open.size > 0 ? "max-h-[340px] overflow-y-auto pr-1" : "max-h-[168px] overflow-y-auto pr-1"}
      >
        <Group group="added" label={t("share.planAdded")} files={added} open={open} onToggle={toggle} />
        <Group group="modified" label={t("share.planModified")} files={modified} open={open} onToggle={toggle} />
        <Group group="deleted" label={t("share.planDeleted")} files={deleted} open={open} onToggle={toggle} danger />
      </div>
      {plan.deleted.length > 0 && (
        <p className="mt-1.5 text-[12px] leading-[1.6] text-[#c0392b] dark:text-[#e0705f]">
          {t("share.planDeleteHint", { count: String(plan.deleted.length) })}
        </p>
      )}
    </div>
  );
}

interface Entry {
  path: string;
  body: FileViewerBody;
}

function Group({
  group,
  label,
  files,
  open,
  onToggle,
  danger = false,
}: {
  group: string;
  label: string;
  files: Entry[];
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  danger?: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p
        className={[
          "text-[11.5px] font-medium",
          danger ? "text-[#c0392b] dark:text-[#e0705f]" : "text-text-2",
        ].join(" ")}
      >
        {label}
        {t("punct.labelSeparator")}
        {files.length}
      </p>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {files.map((f) => {
          // 同一个路径可能同时出现在两组里吗?core 的差集不会,但 id 带上组名不花钱
          const id = `${group}:${f.path}`;
          const expanded = open.has(id);
          return (
            <li key={f.path}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => onToggle(id)}
                className="flex w-full items-start gap-1 rounded-[4px] text-left text-text-2 hover:text-text"
              >
                <span className="mt-[3px] shrink-0 text-text-3">
                  <Icon icon={expanded ? ChevronDown : ChevronRight} size={12} />
                </span>
                <span className="min-w-0 break-all font-mono text-[11.5px]">{f.path}</span>
              </button>
              {expanded && (
                <div className="mb-1.5 mt-1 pl-4">
                  {/* 按文件重挂:加载态与失败态只属于这一个文件 */}
                  <FileViewer key={id} path={f.path} body={f.body} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
