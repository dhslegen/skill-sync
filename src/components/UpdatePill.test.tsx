import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdatePill } from "./UpdatePill";
import { useUpdatePrompt } from "@/store/update-prompt";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useUpdatePrompt.setState({ readyVersion: null, dismissed: false });
}

describe("左下角更新提示 pill", () => {
  beforeEach(reset);

  it("没有待重启的新版:什么都不渲染", () => {
    const { container } = render(<UpdatePill />);
    expect(container).toBeEmptyDOMElement();
  });

  it("新版就绪:亮出版本号与两个动作", () => {
    useUpdatePrompt.setState({ readyVersion: "0.3.0" });
    render(<UpdatePill />);

    expect(screen.getByText(/0\.3\.0/)).toBeInTheDocument();
    expect(screen.getByText(/已就绪/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /立即重启/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /暂不重启/ })).toBeInTheDocument();
  });

  it("点「立即重启」走重启通道", () => {
    useUpdatePrompt.setState({ readyVersion: "0.3.0" });
    render(<UpdatePill />);

    fireEvent.click(screen.getByRole("button", { name: /立即重启/ }));
    expect(invoke).toHaveBeenCalledWith("app_restart", undefined);
  });

  it("点「暂不重启」收起,本次会话不再出现", () => {
    useUpdatePrompt.setState({ readyVersion: "0.3.0" });
    const { container } = render(<UpdatePill />);

    fireEvent.click(screen.getByRole("button", { name: /暂不重启/ }));
    expect(container).toBeEmptyDOMElement();
    expect(useUpdatePrompt.getState().dismissed).toBe(true);
  });
});
