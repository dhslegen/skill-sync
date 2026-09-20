import { t } from "@/i18n";
import type { SharePlan } from "@/lib/ipc";

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
 */
export function SharePlanList({ plan }: { plan: SharePlan }) {
  return (
    <div className="mt-3 rounded-card border border-border bg-surface-2 px-2.5 py-2">
      <p className="text-[11.5px] text-text-3">{t("share.planTitle")}</p>
      <div data-testid="share-plan-files" className="max-h-[168px] overflow-y-auto pr-1">
        {/* v8 任务 8 起每一项带内容标记(diff / 二进制 / 超限);这一版仍只摆
            文件名——**点开看内容是任务 10 的事**,那时这三行各自换成查看器宿主。 */}
        <Group label={t("share.planAdded")} files={plan.added.map((f) => f.path)} />
        <Group label={t("share.planModified")} files={plan.modified.map((f) => f.path)} />
        <Group label={t("share.planDeleted")} files={plan.deleted.map((f) => f.path)} danger />
      </div>
      {plan.deleted.length > 0 && (
        <p className="mt-1.5 text-[12px] leading-[1.6] text-[#c0392b] dark:text-[#e0705f]">
          {t("share.planDeleteHint", { count: String(plan.deleted.length) })}
        </p>
      )}
    </div>
  );
}

function Group({ label, files, danger = false }: { label: string; files: string[]; danger?: boolean }) {
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
        {files.map((f) => (
          <li key={f} className="break-all font-mono text-[11.5px] text-text-2">
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
