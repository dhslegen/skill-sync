import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Wizard } from "./Wizard";
import type { StoreIndexView } from "@/lib/ipc";
import { useSession } from "@/store/session";
import { useStoreIndex } from "@/store/store-index";
import { useUi } from "@/store/ui";
import { useWizard } from "@/store/wizard";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const AGENT = {
  name: "claude-code",
  displayName: "Claude Code",
  installed: true,
  globalSkillsDir: "~/.claude/skills",
  isUniversal: false,
  needsLink: true,
  disabled: false,
};

const index = (curated: string[]): StoreIndexView => ({
  registryId: "company",
  owner: "skills",
  repo: "skills",
  branch: "main",
  commitSha: "aaa",
  committedAt: "",
  fetchedAt: 0,
  skipped: [],
  fromCache: false,
  offline: false,
  curated,
  skills: [
    { name: "周报生成", dirSlug: "weekly-report", description: "周报", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:a" },
    { name: "合同审查助手", dirSlug: "contract-review", description: "合同", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:b" },
  ],
});

function reset() {
  invoke.mockReset();
  localStorage.clear();
  useWizard.setState({
    open: true,
    step: "agents",
    agents: [AGENT],
    selected: new Set(),
    seeded: false,
    installing: false,
    results: null,
    error: null,
  });
  useSession.setState({ status: "signedOut", user: null });
  useStoreIndex.setState({ index: null, status: "idle" });
  useUi.setState({ page: "store" });
}

describe("首次启动向导", () => {
  beforeEach(reset);

  it("关闭时不渲染", () => {
    useWizard.setState({ open: false });
    render(<Wizard />);
    expect(screen.queryByText("欢迎使用 SkillSync")).not.toBeInTheDocument();
  });

  it("第一步:列出检测到的工具显示名与目录", () => {
    render(<Wizard />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("~/.claude/skills")).toBeInTheDocument();
    expect(screen.queryByText(/claude-code/)).not.toBeInTheDocument();
  });

  it("一个工具都没检测到:说明技能仍会保存,不是死路", async () => {
    useWizard.setState({ agents: [] });
    render(<Wizard />);
    expect(screen.getByText(/没有检测到已安装的 AI 工具/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(useWizard.getState().step).toBe("signIn");
  });

  it("第二步:未登录给「登录」与「先跳过」两条路", async () => {
    useWizard.setState({ step: "signIn" });
    render(<Wizard />);

    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "先跳过" }));
    expect(useWizard.getState().step).toBe("curated");
  });

  it("第二步:已登录显示身份,继续即可", () => {
    useSession.setState({
      status: "signedIn",
      user: { login: "zhang-san", displayName: "张三", avatarUrl: "" },
    });
    useWizard.setState({ step: "signIn" });
    render(<Wizard />);
    expect(screen.getByText(/已登录:张三/)).toBeInTheDocument();
  });

  it("第三步:精选默认全选;一键安装带上勾选与已检测工具", async () => {
    useStoreIndex.setState({ index: index(["weekly-report", "contract-review"]), status: "ready" });
    useWizard.setState({ step: "curated" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_install_batch")
        return [
          { dirSlug: "weekly-report", outcome: "installed", report: { dirName: "weekly-report", canonicalDir: "/c", links: [] } },
          { dirSlug: "contract-review", outcome: "installed", report: { dirName: "contract-review", canonicalDir: "/c", links: [] } },
        ];
      if (cmd === "installed_list") return [];
      return null;
    });
    render(<Wizard />);

    expect(screen.getByText("周报生成")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "装上所选技能" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install_batch");
    expect([...call![1].args.dirSlugs].sort()).toEqual(["contract-review", "weekly-report"]);
    expect(call![1].args.agentIds).toEqual(["claude-code"]);
  });

  it("第三步:结果逐条展示,跳过的把原因说出来", () => {
    useStoreIndex.setState({ index: index(["weekly-report", "contract-review"]), status: "ready" });
    useWizard.setState({
      step: "curated",
      results: [
        { dirSlug: "weekly-report", outcome: "installed", report: { dirName: "weekly-report", canonicalDir: "/c", links: [] } },
        { dirSlug: "contract-review", outcome: "skipped", reason: "已安装,且是最新版本" },
      ],
    });
    render(<Wizard />);

    expect(screen.getByText("已启用")).toBeInTheDocument();
    expect(screen.getByText(/已安装,且是最新版本/)).toBeInTheDocument();
    // 结果里也是展示名,不是目录名
    expect(screen.getByText("周报生成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始使用" })).toBeInTheDocument();
  });

  it("库里没有精选清单:引导去商店,不编一个假清单", async () => {
    useStoreIndex.setState({ index: index([]), status: "ready" });
    useWizard.setState({ step: "curated" });
    render(<Wizard />);

    expect(screen.getByText(/还没有设置精选清单/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "去技能商店" }));

    expect(useWizard.getState().open).toBe(false);
    expect(useUi.getState().page).toBe("store");
    expect(localStorage.getItem("skillsync.wizardDone")).toBe("1");
  });

  it("「稍后再说」直接完成,不再纠缠", async () => {
    render(<Wizard />);
    await userEvent.click(screen.getByRole("button", { name: "稍后再说" }));
    expect(useWizard.getState().open).toBe(false);
    expect(localStorage.getItem("skillsync.wizardDone")).toBe("1");
  });
});