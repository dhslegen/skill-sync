import { Command } from "cmdk";
import { RefreshCw, Search, SunMoon } from "lucide-react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { useAppearance } from "@/store/appearance";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

/**
 * 命令面板(Cmd/Ctrl+K)。用 cmdk 的原语而不是它的 Dialog:
 * 遮罩与键盘处理都要自己管,才能保证 IME 组合期间 Esc 不会把面板关掉
 * ——输入法用 Esc 取消候选,那一下不该穿透到应用。
 */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const { index, openDetail, load } = useStoreIndex();
  const toggleTheme = useAppearance((s) => s.toggleTheme);

  if (!open) return null;

  const close = () => setOpen(false);

  return (
    <div
      className="fixed inset-0 z-60 grid place-items-start justify-center bg-[rgba(15,14,12,.3)] pt-[15vh] backdrop-blur-[3px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <Command
        label={t("palette.placeholder")}
        className="w-[520px] overflow-hidden rounded-pop border border-border-strong bg-surface-1 shadow-[var(--shadow-pop)]"
      >
        <Command.Input
          autoFocus
          placeholder={t("palette.placeholder")}
          className="w-full border-0 border-b border-border bg-transparent px-4 py-[13px] font-[inherit] text-[14px] text-text outline-none placeholder:text-text-3"
        />
        <Command.List className="max-h-[300px] overflow-y-auto p-1.5">
          <Command.Empty className="px-2.5 py-3 text-[12.5px] text-text-3">
            {t("palette.empty")}
          </Command.Empty>

          {index && index.skills.length > 0 && (
            <Command.Group
              heading={t("palette.groupSkills")}
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-0.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-text-3"
            >
              {index.skills.map((skill) => (
                <Item
                  key={skill.dirSlug}
                  value={`${skill.name} ${skill.dirSlug} ${skill.description}`}
                  icon={Search}
                  onSelect={() => {
                    close();
                    void openDetail(skill.dirSlug);
                  }}
                >
                  {skill.name}
                </Item>
              ))}
            </Command.Group>
          )}

          <Command.Group
            heading={t("palette.groupActions")}
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-0.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-text-3"
          >
            <Item
              value={t("palette.actionRefresh")}
              icon={RefreshCw}
              onSelect={() => {
                close();
                void load(true);
              }}
            >
              {t("palette.actionRefresh")}
            </Item>
            <Item
              value={t("palette.actionToggleTheme")}
              icon={SunMoon}
              onSelect={() => {
                close();
                toggleTheme();
              }}
            >
              {t("palette.actionToggleTheme")}
            </Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function Item({
  value,
  icon,
  onSelect,
  children,
}: {
  value: string;
  icon: typeof Search;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2.5 rounded-ctl px-2.5 py-[7px] text-[13px] text-text-2 data-[selected=true]:bg-surface-3 data-[selected=true]:text-text"
    >
      <Icon icon={icon} />
      {children}
    </Command.Item>
  );
}
