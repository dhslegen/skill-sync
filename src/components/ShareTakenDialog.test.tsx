import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareTakenDialog } from "./ShareTakenDialog";
import { useSession } from "@/store/session";
import { useShare } from "@/store/share";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function reset() {
  useShare.setState({
    phase: "idle",
    form: { shareName: "my-notes", displayName: "我的笔记", description: "d" },
  });
  useSession.setState({
    status: "signedIn",
    user: { login: "zhang-san", displayName: "", avatarUrl: "" },
  });
}

describe("名称被占用弹窗", () => {
  beforeEach(reset);

  it("不在占用态时不渲染", () => {
    render(<ShareTakenDialog />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("三个选项都在;默认焦点在「换个名称」—— 回车绝不等于覆盖别人的", () => {
    useShare.setState({ phase: "taken" });
    render(<ShareTakenDialog />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /换个名称分享/ })).toHaveFocus();
    expect(screen.getByRole("button", { name: /看看对方的版本/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /用我的版本覆盖/ })).toBeInTheDocument();
    // 改名建议带上用户名,给一个现成可用的候选
    expect(screen.getByText(/my-notes-zhang-san/)).toBeInTheDocument();
  });

  it("选覆盖 → 带 overwrite 重试", async () => {
    const submit = vi.fn();
    useShare.setState({ phase: "taken", submit });
    render(<ShareTakenDialog />);

    await userEvent.click(screen.getByRole("button", { name: /用我的版本覆盖/ }));
    expect(submit).toHaveBeenCalledWith(true);
  });

  it("选改名 → 回到表单", async () => {
    useShare.setState({ phase: "taken" });
    render(<ShareTakenDialog />);

    await userEvent.click(screen.getByRole("button", { name: /换个名称分享/ }));
    expect(useShare.getState().phase).toBe("form");
  });

  it("Esc 回表单,不留在弹窗里", async () => {
    useShare.setState({ phase: "taken" });
    render(<ShareTakenDialog />);

    await userEvent.keyboard("{Escape}");
    expect(useShare.getState().phase).toBe("form");
  });
});