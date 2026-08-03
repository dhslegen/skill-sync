import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useDesktopChrome } from "./useDesktopChrome";
import { useAppearance } from "@/store/appearance";
import { useLocalDetail } from "@/store/local-detail";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function Harness() {
  useDesktopChrome();
  return <input id="store-search" data-testid="search" />;
}

describe("桌面快捷键", () => {
  beforeEach(() => {
    useUi.setState({ page: "store", paletteOpen: false, composing: false });
    useStoreIndex.setState({ detailSlug: null, detail: null });
  });

  it("Cmd/Ctrl+K 开关命令面板", async () => {
    render(<Harness />);
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(useUi.getState().paletteOpen).toBe(true);
    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it("Cmd/Ctrl+1..4 切页", async () => {
    render(<Harness />);
    await userEvent.keyboard("{Control>}3{/Control}");
    expect(useUi.getState().page).toBe("share");
    await userEvent.keyboard("{Control>}1{/Control}");
    expect(useUi.getState().page).toBe("store");
  });

  it("Esc 先关命令面板,再关详情面板", async () => {
    render(<Harness />);
    useUi.setState({ paletteOpen: true });
    useStoreIndex.setState({ detailSlug: "weekly-report" });

    await userEvent.keyboard("{Escape}");
    expect(useUi.getState().paletteOpen).toBe(false);
    // 一次 Esc 只关一层,详情还开着
    expect(useStoreIndex.getState().detailSlug).toBe("weekly-report");

    await userEvent.keyboard("{Escape}");
    expect(useStoreIndex.getState().detailSlug).toBeNull();
  });

  it("Esc 关本地详情面板(我的技能/分享页打开的那种)", async () => {
    render(<Harness />);
    useLocalDetail.setState({ target: { dirSlug: "weekly-report" }, detail: null, error: null, revealError: null });
    useStoreIndex.setState({ detailSlug: "weekly-report" });

    await userEvent.keyboard("{Escape}");
    // 一次 Esc 只关一层:本地详情先关,商店详情还开着
    expect(useLocalDetail.getState().target).toBeNull();
    expect(useStoreIndex.getState().detailSlug).toBe("weekly-report");

    await userEvent.keyboard("{Escape}");
    expect(useStoreIndex.getState().detailSlug).toBeNull();
  });

  it("IME 组合输入期间所有快捷键让路", async () => {
    render(<Harness />);
    // 拼音候选窗开着时,keydown 里的键不是用户想按的键:
    // Cmd+K 不该开面板、Esc 不该关面板(那一下是取消候选)
    useUi.setState({ composing: true, paletteOpen: true });

    await userEvent.keyboard("{Meta>}k{/Meta}");
    expect(useUi.getState().paletteOpen).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(useUi.getState().paletteOpen).toBe(true);

    await userEvent.keyboard("{Control>}2{/Control}");
    expect(useUi.getState().page).toBe("store");
  });

  it("/ 聚焦搜索框", async () => {
    const { getByTestId } = render(<Harness />);
    await userEvent.keyboard("/");
    expect(getByTestId("search")).toHaveFocus();
  });

  it("已经在输入框里打字时,/ 是普通字符不抢焦点", async () => {
    const { getByTestId } = render(<Harness />);
    const input = getByTestId("search");
    input.focus();
    await userEvent.keyboard("a/b");
    expect((input as HTMLInputElement).value).toBe("a/b");
  });

  it("Cmd+U 切换主题", async () => {
    render(<Harness />);
    useAppearance.setState({ mode: "light", prefersDark: false });
    await userEvent.keyboard("{Meta>}u{/Meta}");
    expect(useAppearance.getState().mode).toBe("dark");
  });
});
