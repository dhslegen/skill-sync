import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SharePage } from "./SharePage";
import type { ShareCandidate } from "@/lib/ipc";
import { useSession } from "@/store/session";
import { useShare } from "@/store/share";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const candidate = (over: Partial<ShareCandidate> = {}): ShareCandidate => ({
  dirName: "my-notes",
  path: "/home/u/.agents/skills/my-notes",
  inCanonical: true,
  origin: { kind: "local" },
  name: "我的笔记",
  description: "记点东西",
  problem: null,
  shared: null,
  dirNameUsable: true,
  ...over,
});

function seedIpc(list: ShareCandidate[]) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "share_candidates") return list;
    return null;
  });
}

function reset() {
  invoke.mockReset();
  seedIpc([]);
  useShare.setState({
    candidates: null,
    scanError: null,
    scanning: false,
    phase: "idle",
    target: null,
    form: { shareName: "", displayName: "", description: "" },
    staleNotice: false,
    shareError: null,
    done: null,
  });
  useSession.setState({ status: "signedIn", user: { login: "zhang-san", displayName: "", avatarUrl: "" } });
}

describe("分享页", () => {
  beforeEach(reset);

  it("空列表说明会自动出现,不引导去商店", async () => {
    render(<SharePage />);
    expect(await screen.findByText(/没有找到可分享的技能/)).toBeInTheDocument();
  });

  it("扫描失败显示错误与重试,绝不显示空状态文案", async () => {
    invoke.mockImplementation(async () => {
      throw { code: "FS_TASK", message: "扫描本地技能失败,请重试" };
    });
    render(<SharePage />);

    expect(await screen.findByText(/扫描本地技能失败/)).toBeInTheDocument();
    expect(screen.queryByText(/没有找到可分享的技能/)).not.toBeInTheDocument();
  });

  it("行里是显示名与来源标签,npx 来源把原始出处说出来", async () => {
    seedIpc([
      candidate(),
      candidate({
        dirName: "email-polish",
        path: "/p2",
        name: "邮件润色",
        origin: { kind: "npxSkills", source: "acme/skills" },
      }),
    ]);
    render(<SharePage />);

    expect(await screen.findByText("我的笔记")).toBeInTheDocument();
    expect(screen.getByText("本地创建")).toBeInTheDocument();
    expect(screen.getByText(/acme\/skills/)).toBeInTheDocument();
  });

  it("SKILL.md 不合规的候选带「信息待补齐」徽标", async () => {
    seedIpc([candidate({ name: null, problem: "缺少必填项:description" })]);
    render(<SharePage />);
    const badge = await screen.findByText("信息待补齐");
    expect(badge.getAttribute("title")).toContain("description");
  });

  it("未登录时分享按钮禁用并提示先登录", async () => {
    useSession.setState({ status: "signedOut", user: null });
    seedIpc([candidate()]);
    render(<SharePage />);

    expect(await screen.findByText(/分享前请先登录/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分享…" })).toBeDisabled();
  });

  it("点「分享…」展开表单并预填", async () => {
    seedIpc([candidate()]);
    render(<SharePage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));

    expect(screen.getByDisplayValue("我的笔记")).toBeInTheDocument();
    expect(screen.getByDisplayValue("记点东西")).toBeInTheDocument();
    expect(screen.getByDisplayValue("my-notes")).toBeInTheDocument();
    // 展开只是展开,不发任何提交
    expect(invoke).not.toHaveBeenCalledWith("skill_share", expect.anything());
  });

  it("文件夹名不合法:确认按钮禁用并给出原因", async () => {
    seedIpc([candidate()]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));

    const slug = screen.getByDisplayValue("my-notes");
    await userEvent.clear(slug);
    await userEvent.type(slug, "周报");

    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
    expect(screen.getByText("只能用英文小写字母、数字和短横线")).toBeInTheDocument();
  });

  it("描述为空:确认按钮禁用 —— core 会拒,但不该让用户白跑一趟", async () => {
    seedIpc([candidate({ description: null, problem: "缺少必填项:description" })]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));

    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
  });

  it("走了评审的结果把审核地址亮出来", async () => {
    seedIpc([candidate()]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));
    useShare.setState({
      phase: "done",
      done: {
        outcome: "shared",
        mode: "reviewRequested",
        commitSha: "abc",
        reviewUrl: "http://gitea/pulls/7",
        adopted: false,
        shareName: "my-notes",
      },
    });

    expect(await screen.findByText(/已提交审核/)).toBeInTheDocument();
    expect(screen.getByText(/pulls\/7/)).toBeInTheDocument();
  });

  it("收编提示只在 agent 目录的候选上出现", async () => {
    seedIpc([candidate({ inCanonical: false, path: "/home/u/.claude/skills/my-notes" })]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));
    expect(screen.getByText(/移入统一技能目录/)).toBeInTheDocument();
  });
});