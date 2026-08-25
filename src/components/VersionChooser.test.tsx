import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VersionChooser } from "./VersionChooser";
import type { SkillVersion } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const VERSIONS: SkillVersion[] = [
  { path: "/h/.claude/skills/weekly-report", modifiedAt: "2026-08-20T00:00:00.000Z", files: 3, contentHash: "a" },
  { path: "/h/.trae/skills/weekly-report", modifiedAt: "2026-08-22T00:00:00.000Z", files: 5, contentHash: "b" },
];

function openWith(versions = VERSIONS) {
  useMySkills.setState({
    versionChoice: { dirSlug: "weekly-report", versions },
    keepBusy: false,
    keepError: null,
  });
  return render(<VersionChooser />);
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "skill_keep_version")
      return { body: "/a", trashed: [], links: [], canonical: { Ok: { kind: "unchanged" } } };
    if (cmd === "installed_list") return [];
    return { agents: [], canonicalDir: "" };
  });
  useMySkills.setState({ versionChoice: null, keepBusy: false, keepError: null, list: null });
});

describe("VersionChooser", () => {
  it("没有待拍板时什么都不渲染", () => {
    const { container } = render(<VersionChooser />);
    expect(container).toBeEmptyDOMElement();
  });

  it("每一份都摆出位置、最后修改时间、文件数 —— 用户要看着这三样才选得下去", () => {
    openWith();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("/h/.claude/skills/weekly-report")).toBeInTheDocument();
    expect(screen.getByText("/h/.trae/skills/weekly-report")).toBeInTheDocument();
    // 文件数两份不同,正面断言两个数字都在
    expect(screen.getByText(/3 个文件/)).toBeInTheDocument();
    expect(screen.getByText(/5 个文件/)).toBeInTheDocument();
    expect(screen.getAllByText(/最后修改/)).toHaveLength(2);
    // N 份就是 N 个「保留这一份」
    expect(screen.getAllByRole("button", { name: "保留这一份" })).toHaveLength(2);
  });

  it("点某一份的「保留这一份」→ 把那一份的位置传给 core", async () => {
    openWith();

    await userEvent.click(screen.getAllByRole("button", { name: "保留这一份" })[1]);

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_keep_version");
    expect(call?.[1].args).toEqual({
      dirSlug: "weekly-report",
      keepPath: "/h/.trae/skills/weekly-report",
    });
  });

  it("文案说清其余的去了废纸篓 —— 可逆是这一屏敢只问一次的前提", () => {
    openWith();
    expect(screen.getByText(/废纸篓/)).toBeInTheDocument();
    // 「链接」是这一期撤掉的词,不该出现在用户面前
    expect(screen.getByRole("dialog").textContent).not.toContain("链接");
    expect(screen.getByRole("dialog").textContent).not.toContain("关联");
  });

  it("默认焦点在取消上 —— 这一屏会动磁盘,回车不该等于随便选一个", () => {
    openWith();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("Esc 关闭,且不发任何请求", async () => {
    openWith();
    await userEvent.keyboard("{Escape}");
    expect(useMySkills.getState().versionChoice).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("skill_keep_version", expect.anything());
  });

  it("点「取消」同样不动磁盘", async () => {
    openWith();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useMySkills.getState().versionChoice).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("skill_keep_version", expect.anything());
  });

  it("失败时错误摆在弹窗里,弹窗不关 —— 关掉就等于失败被静默吞掉", () => {
    useMySkills.setState({
      versionChoice: { dirSlug: "weekly-report", versions: VERSIONS },
      keepError: { code: "FS_BAD_VERSION_CHOICE", message: "这个位置不在候选里" },
    });
    render(<VersionChooser />);
    expect(screen.getByText("这个位置不在候选里")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("落地期间按钮禁用,防连点", () => {
    useMySkills.setState({
      versionChoice: { dirSlug: "weekly-report", versions: VERSIONS },
      keepBusy: true,
    });
    render(<VersionChooser />);
    for (const b of screen.getAllByRole("button", { name: "保留这一份" })) {
      expect(b).toBeDisabled();
    }
  });

  it("aria:是模态对话框,并由标题命名", () => {
    openWith();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "version-title");
    expect(document.getElementById("version-title")?.textContent).toBe("选择保留哪一份");
  });
});
