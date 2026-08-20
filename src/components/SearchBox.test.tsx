import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SearchBox } from "./SearchBox";
import { useUi } from "@/store/ui";

describe("SearchBox 的 IME 组合输入", () => {
  beforeEach(() => {
    useUi.setState({ composing: false });
  });

  it("组合输入期间不向上派发,避免拿半截拼音去搜", () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByTestId("store-search");

    fireEvent.compositionStart(input);
    // 拼音输入法在候选未上屏时也会触发 change,值是 "zhoub" 这样的半成品
    fireEvent.change(input, { target: { value: "zh" } });
    fireEvent.change(input, { target: { value: "zhoub" } });

    expect(onChange).not.toHaveBeenCalled();
    // 但输入框自己要显示用户正在打的内容,否则看着像卡住了
    expect((input as HTMLInputElement).value).toBe("zhoub");
  });

  it("候选上屏时派发一次最终值", () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByTestId("store-search");

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "zhoub" } });
    fireEvent.compositionEnd(input, { target: { value: "周报" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("周报");
  });

  it("非组合输入(英文/退格)照常逐字派发", () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByTestId("store-search");

    fireEvent.change(input, { target: { value: "w" } });
    fireEvent.change(input, { target: { value: "we" } });

    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["w", "we"]);
  });

  it("把组合状态记进 ui store,好让全局快捷键让路", () => {
    render(<SearchBox value="" onChange={() => {}} />);
    const input = screen.getByTestId("store-search");

    fireEvent.compositionStart(input);
    expect(useUi.getState().composing).toBe(true);
    fireEvent.compositionEnd(input, { target: { value: "周报" } });
    expect(useUi.getState().composing).toBe(false);
  });

  it("组合输入中按回车是选词上屏,不是提交搜索", () => {
    const onSubmit = vi.fn();
    render(<SearchBox value="" onChange={() => {}} onSubmit={onSubmit} />);
    const input = screen.getByTestId("store-search");

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "zhoub" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("🔴 WebKit 的事件顺序:compositionend 先到、确认键的 keydown 后到,也不能触发", () => {
    // macOS 的 Tauri webview 是 WKWebView,候选上屏那一下 compositionend **先**发,
    // 确认键的 keydown **后**到——那时 composing 标志与 isComposing 都已是 false,
    // 只有 keyCode 229 还认得出这是 IME 处理中的按键。jsdom 不会自己复现这个顺序,
    // 所以这里显式摆出来钉住第三道守卫。
    const onSubmit = vi.fn();
    render(<SearchBox value="" onChange={() => {}} onSubmit={onSubmit} />);
    const input = screen.getByTestId("store-search");

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "zhoub" } });
    fireEvent.compositionEnd(input, { target: { value: "周报" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("普通回车提交当前输入的值", () => {
    const onSubmit = vi.fn();
    render(<SearchBox value="" onChange={() => {}} onSubmit={onSubmit} />);
    const input = screen.getByTestId("store-search");

    fireEvent.change(input, { target: { value: "react" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("react");
  });

  it("回车之外的按键不提交", () => {
    const onSubmit = vi.fn();
    render(<SearchBox value="" onChange={() => {}} onSubmit={onSubmit} />);
    const input = screen.getByTestId("store-search");

    fireEvent.change(input, { target: { value: "react" } });
    fireEvent.keyDown(input, { key: "a" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("不传 onSubmit(公司技能库那一档)时回车没有任何副作用", () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByTestId("store-search");

    fireEvent.change(input, { target: { value: "周报" } });
    onChange.mockClear();
    expect(() => fireEvent.keyDown(input, { key: "Enter" })).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("外部改 value 时同步显示(命令面板跳转等场景)", () => {
    const { rerender } = render(<SearchBox value="旧" onChange={() => {}} />);
    rerender(<SearchBox value="新" onChange={() => {}} />);
    expect((screen.getByTestId("store-search") as HTMLInputElement).value).toBe("新");
  });
});
