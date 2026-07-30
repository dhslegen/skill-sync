import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { t } from "@/i18n";
import { useUi } from "@/store/ui";

/**
 * 搜索框。
 *
 * 关键行为是 **IME 组合输入**(UI 规范 §6.4):拼音输入法在候选未上屏时也会触发 React 的
 * onChange,值是半截拼音("zhoub")。拿它去过滤会让列表在打字过程中反复变空,
 * 用户以为搜不到东西。因此组合期间只更新本地草稿,`compositionend` 才向上派发一次。
 * 同时把组合状态记进 ui store——全局快捷键在这期间必须让路。
 */
export function SearchBox({
  value,
  onChange,
  kbdHint,
}: {
  value: string;
  onChange: (value: string) => void;
  kbdHint?: string;
}) {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);
  const setComposing = useUi((s) => s.setComposing);
  const inputRef = useRef<HTMLInputElement>(null);

  // 外部清空(如命令面板里跳转)时同步草稿,组合中不打断用户
  useEffect(() => {
    if (!composingRef.current) setDraft(value);
  }, [value]);

  return (
    <label className="ml-3 flex h-7 w-[320px] items-center gap-[7px] rounded-ctl border border-border bg-surface-1 px-2 text-text-3 focus-within:border-border-strong hover:border-border-strong">
      <Icon icon={Search} />
      <input
        ref={inputRef}
        value={draft}
        placeholder={t("toolbar.search")}
        aria-label={t("toolbar.search")}
        id="store-search"
        data-testid="store-search"
        className="min-w-0 flex-1 border-0 bg-transparent font-[inherit] text-text outline-none placeholder:text-text-3"
        onCompositionStart={() => {
          composingRef.current = true;
          setComposing(true);
        }}
        onCompositionEnd={(e) => {
          composingRef.current = false;
          setComposing(false);
          const next = e.currentTarget.value;
          setDraft(next);
          onChange(next);
        }}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (!composingRef.current) onChange(next);
        }}
      />
      {kbdHint && (
        <kbd className="rounded-[4px] border border-b-[1.5px] border-border bg-surface-2 px-1 text-[10.5px] leading-[15px] text-text-3">
          {kbdHint}
        </kbd>
      )}
    </label>
  );
}
