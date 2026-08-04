import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SharePage } from "./SharePage";
import type { ShareCandidate } from "@/lib/ipc";
import { useCreate } from "@/store/create";
import { useLocalDetail } from "@/store/local-detail";
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
  useCreate.setState({
    phase: "closed",
    form: { dirSlug: "", displayName: "", description: "" },
    error: null,
    createdPath: null,
  });
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
    expect(screen.getByText(/这个名字不能用/)).toBeInTheDocument();
  });

  it("会被 core 静默改名的文件夹名也要拦下,不只是中文", async () => {
    seedIpc([candidate()]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));

    const slug = screen.getByDisplayValue("my-notes");
    // 旧正则放行这个,而 core 的 sanitize 会把它折成 a-b —— 填的和落盘的不是一个东西
    await userEvent.clear(slug);
    await userEvent.type(slug, "a--b");

    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
    expect(screen.getByText(/这个名字不能用/)).toBeInTheDocument();
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

  it("「在浏览器中查看」把审核地址交给系统浏览器打开", async () => {
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

    await userEvent.click(await screen.findByRole("button", { name: "在浏览器中查看" }));

    expect(invoke).toHaveBeenCalledWith("open_library_url", {
      args: { url: "http://gitea/pulls/7" },
    });
  });

  it("打开被拒(非技能库地址)时把原因摆出来,不静默", async () => {
    seedIpc([candidate()]);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "share_candidates") return [candidate()];
      if (cmd === "open_library_url")
        throw { code: "REPO_UNTRUSTED_URL", message: "这个链接不属于公司技能库,已阻止打开" };
      return null;
    });
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));
    useShare.setState({
      phase: "done",
      done: {
        outcome: "shared",
        mode: "reviewRequested",
        commitSha: "abc",
        reviewUrl: "http://evil/pulls/7",
        adopted: false,
        shareName: "my-notes",
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: "在浏览器中查看" }));

    expect(await screen.findByText(/已阻止打开/)).toBeInTheDocument();
  });

  it("收编提示只在 agent 目录的候选上出现", async () => {
    seedIpc([candidate({ inCanonical: false, path: "/home/u/.claude/skills/my-notes" })]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));
    expect(screen.getByText(/移入统一技能目录/)).toBeInTheDocument();
  });

  it("再次分享时远端目录名只读——改了不是改名,是另发一个新技能", async () => {
    // 记账按远端名去重、展示按 local_path 查找(且 find 只取第一条),两把钥匙。
    // 改名会让远端留下无人维护的孤儿,本地多一条记账,界面之后一直显示旧的那条。
    seedIpc([candidate({ shared: { upToDate: false, shareName: "my-notes" } })]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享改动" }));

    // 名称与描述照常可改——那是内容,本来就该能更新
    expect(screen.getByDisplayValue("我的笔记")).toBeInTheDocument();
    expect(screen.getByDisplayValue("记点东西")).toBeInTheDocument();
    // 但远端目录名不再是可编辑的输入框
    expect(screen.queryByDisplayValue("my-notes")).not.toBeInTheDocument();
    expect(screen.getByText("my-notes")).toBeInTheDocument();
    expect(screen.getByText(/这是它在团队库里的名字/)).toBeInTheDocument();
  });

  it("首次分享时远端目录名仍可编辑——那时还没有身份可言", async () => {
    seedIpc([candidate()]);
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));

    expect(screen.getByDisplayValue("my-notes")).toBeInTheDocument();
  });

  it("已分享且没改动:显示「已分享」而不是又一个「分享…」按钮", async () => {
    // 2026-08-03 用户实测的缺陷:分享完按钮纹丝不动,看着像什么都没发生
    seedIpc([candidate({ shared: { upToDate: true, shareName: "my-notes" } })]);
    render(<SharePage />);

    expect(await screen.findByText("已分享")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "分享改动" })).not.toBeInTheDocument();
  });

  it("分享过但本地又改了:给「分享改动」", async () => {
    seedIpc([candidate({ shared: { upToDate: false, shareName: "my-notes" } })]);
    render(<SharePage />);

    expect(await screen.findByRole("button", { name: "分享改动" })).toBeInTheDocument();
  });

  it("点行内名称区按候选的绝对路径打开本地详情", async () => {
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    seedIpc([candidate()]);
    render(<SharePage />);

    await userEvent.click(await screen.findByRole("button", { name: /我的笔记/ }));

    expect(invoke).toHaveBeenCalledWith("skill_local_detail", {
      args: { path: "/home/u/.agents/skills/my-notes" },
    });
  });

  it("「分享…」按钮不会顺带打开详情", async () => {
    useLocalDetail.setState({ target: null, detail: null, error: null, revealError: null });
    seedIpc([candidate()]);
    render(<SharePage />);

    await userEvent.click(await screen.findByRole("button", { name: "分享…" }));

    expect(invoke).not.toHaveBeenCalledWith("skill_local_detail", expect.anything());
  });
});

describe("新建技能向导", () => {
  beforeEach(reset);

  it("入口即使一个候选都没有也在——那正是该新建的时候", async () => {
    render(<SharePage />);
    expect(await screen.findByRole("button", { name: "新建技能" })).toBeInTheDocument();
  });

  it("未登录也能新建:创建只写本地文件,登录是分享那一步的前提", async () => {
    useSession.setState({ status: "signedOut", user: null });
    render(<SharePage />);

    await userEvent.click(await screen.findByRole("button", { name: "新建技能" }));
    // 表单填齐后按钮可点,不因未登录而禁用
    await userEvent.type(screen.getByLabelText(/技能名称/), "周报生成");
    await userEvent.type(screen.getByLabelText(/技能描述/), "每周汇总");
    await userEvent.type(screen.getByLabelText(/文件夹名称/), "weekly-report");
    expect(screen.getByRole("button", { name: "创建" })).toBeEnabled();
  });

  it("文件夹名会被静默改名时禁用创建并说明原因", async () => {
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "新建技能" }));

    await userEvent.type(screen.getByLabelText(/技能名称/), "周报生成");
    await userEvent.type(screen.getByLabelText(/技能描述/), "每周汇总");
    await userEvent.type(screen.getByLabelText(/文件夹名称/), "a--b");

    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(screen.getByText(/这个名字不能用/)).toBeInTheDocument();
  });

  it("创建成功后如实说明哪些工具立刻读得到、哪些要走分享", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_create") {
        return { dirSlug: "weekly-report", path: "/home/u/.agents/skills/weekly-report" };
      }
      if (cmd === "share_candidates") return [];
      return null;
    });
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "新建技能" }));

    await userEvent.type(screen.getByLabelText(/技能名称/), "周报生成");
    await userEvent.type(screen.getByLabelText(/技能描述/), "每周汇总");
    await userEvent.type(screen.getByLabelText(/文件夹名称/), "weekly-report");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("技能已创建")).toBeInTheDocument();
    expect(screen.getByText("/home/u/.agents/skills/weekly-report")).toBeInTheDocument();
    // 不建关联是有意的,界面必须说清后果,不能让用户以为哪都能用
    expect(screen.getByText(/Claude Code 和 Trae 要等它分享到技能库/)).toBeInTheDocument();
  });

  it("「在访达中打开」失败要把原因摆出来,不能点了没反应", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_create") {
        return { dirSlug: "weekly-report", path: "/home/u/.agents/skills/weekly-report" };
      }
      if (cmd === "skill_reveal") {
        throw { code: "FS_REVEAL_FAILED", message: "打不开这个文件夹,请检查它是否还在" };
      }
      if (cmd === "share_candidates") return [];
      return null;
    });
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "新建技能" }));

    await userEvent.type(screen.getByLabelText(/技能名称/), "周报生成");
    await userEvent.type(screen.getByLabelText(/技能描述/), "每周汇总");
    await userEvent.type(screen.getByLabelText(/文件夹名称/), "weekly-report");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    await userEvent.click(await screen.findByRole("button", { name: /打开/ }));

    expect(await screen.findByText(/打不开这个文件夹/)).toBeInTheDocument();
  });

  it("创建失败留在表单并保住已填内容", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_create") {
        throw { code: "CONFLICT_NAME_TAKEN", message: "本地已经有同名的技能文件夹了,换一个名字吧" };
      }
      if (cmd === "share_candidates") return [];
      return null;
    });
    render(<SharePage />);
    await userEvent.click(await screen.findByRole("button", { name: "新建技能" }));

    await userEvent.type(screen.getByLabelText(/技能名称/), "周报生成");
    await userEvent.type(screen.getByLabelText(/技能描述/), "每周汇总");
    await userEvent.type(screen.getByLabelText(/文件夹名称/), "weekly-report");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText(/本地已经有同名的技能文件夹了/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("周报生成")).toBeInTheDocument();
    expect(screen.getByDisplayValue("weekly-report")).toBeInTheDocument();
  });

  it("离开再回到这一页会重新扫描——不是靠组件重挂的巧合,是显式契约", async () => {
    // 新建向导的完成页写着「然后回到这一页分享给团队」。回到这一页看到旧状态
    // 就是自打脸(M4 任务 6c 级别 2)。
    seedIpc([]);
    const { unmount } = render(<SharePage />);
    await screen.findByText(/没有找到可分享的技能/);
    const firstRound = invoke.mock.calls.filter(([cmd]) => cmd === "share_candidates").length;
    expect(firstRound).toBeGreaterThan(0);

    unmount();
    // 这次扫描能看到刚在编辑器里建好的技能
    seedIpc([candidate({ dirName: "just-created", name: "刚建好的" })]);
    render(<SharePage />);

    expect(await screen.findByText("刚建好的")).toBeInTheDocument();
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "share_candidates").length,
    ).toBeGreaterThan(firstRound);
  });
});
