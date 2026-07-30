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

  it("外部改 value 时同步显示(命令面板跳转等场景)", () => {
    const { rerender } = render(<SearchBox value="旧" onChange={() => {}} />);
    rerender(<SearchBox value="新" onChange={() => {}} />);
    expect((screen.getByTestId("store-search") as HTMLInputElement).value).toBe("新");
  });
});
