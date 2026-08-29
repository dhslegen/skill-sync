import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareConfirm } from "./ShareConfirm";
import type { InstalledSkillView, Section, ShareBlock } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { useShare } from "@/store/share";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const BODY = "/h/.claude/skills/weekly-report";

/** core::ownership::section(relation) 的镜像(v7 任务 4 修复轮 1 I2 同款处置):
 *  section 不能是与 relation 无关的独立常量,否则 view({relation:"x"}) 会静默
 *  构造出生产上不可能出现的组合(本文件 113 行就有一处 relation:"shared" 却没有
 *  同步 section 的既有用例)。 */
function sectionOfRelation(relation: InstalledSkillView["relation"]): Section {
  switch (relation) {
    case "shared":
      return "sharedTo";
    case "draft":
      return "shareable";
    default:
      return "installedFrom";
  }
}

const view = (over: Partial<InstalledSkillView> = {}): InstalledSkillView => ({
  dirSlug: "weekly-report",
  commitSha: "",
  contentHash: "",
  agents: [],
  installedAt: "",
  updatedAt: "",
  localModified: false,
  sourceOwner: "",
  sourceRepo: "",
  registryId: "",
  sourceRemoved: false,
  libraryRemoved: false,
  relation: "draft",
  localPresent: true,
  sourceLabel: null,
  body: BODY,
  localHash: "sha256:local",
  tools: [],
  versions: [],
  shareBlocked: null,
  section: sectionOfRelation(over.relation ?? "draft"),
  review: null,
  ...over,
});

function openWith(skill = view()) {
  useMySkills.setState({
    list: [skill],
    shareTarget: { dirSlug: skill.dirSlug },
    shareBusy: null,
    shareError: null,
  });
  return render(<ShareConfirm />);
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "skill_local_detail")
      return {
        name: "周报生成",
        dirSlug: "weekly-report",
        description: "每周汇总本周工作",
        path: BODY,
        skillMd: "",
        files: [],
        hasScripts: false,
      };
    if (cmd === "skill_share") return { outcome: "shared", mode: "pushed", url: null };
    if (cmd === "installed_list") return [];
    return { agents: [], canonicalDir: "" };
  });
  useMySkills.setState({ list: null, shareTarget: null, shareBusy: null, shareError: null });
  useShare.setState({ targetRepo: null, preview: "unknown" });
});

describe("🔴 零编辑:这一屏没有任何输入框", () => {
  it("一个 input / textarea 都没有", async () => {
    // 这是这一屏存在的全部意义(v6 二期 A-1)。上一版是张表单,能改名称、描述、
    // 文件夹名,还会替用户"补齐" frontmatter——改出来的东西很可能反而不合标准。
    const { container } = openWith();
    await screen.findByText("周报生成");

    expect(container.querySelectorAll("input,textarea")).toHaveLength(0);
  });

  it("也没有伪装成只读输入框的东西", async () => {
    const { container } = openWith();
    await screen.findByText("周报生成");
    expect(container.querySelector("input[readonly]")).toBeNull();
  });
});

describe("摆出来的信息", () => {
  it("名称 / 描述 / 文件夹名 / 目标库 四样都在", async () => {
    useShare.setState({ preview: "directPush" });
    openWith();

    expect(await screen.findByText("周报生成")).toBeInTheDocument();
    expect(screen.getByText("每周汇总本周工作")).toBeInTheDocument();
    expect(screen.getByText("weekly-report")).toBeInTheDocument();
    expect(screen.getByText("公司技能库")).toBeInTheDocument();
    // 权限预告
    expect(screen.getByText("你的改动会直接生效。")).toBeInTheDocument();
  });

  it("🔴 名称与描述按本体路径现读,不按目录名", async () => {
    // 本体很可能不住在统一目录里(那正是 v6 二期的起因),按 dirSlug 会读到别处。
    openWith();
    await screen.findByText("周报生成");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_local_detail");
    expect(call?.[1].args).toEqual({ path: BODY });
  });

  it("账上有来源坐标时,目标库显示那个库而不是默认库", async () => {
    openWith(view({ sourceOwner: "design", sourceRepo: "skills", relation: "shared" }));
    await screen.findByText("周报生成");
    expect(screen.getByText("design/skills")).toBeInTheDocument();
    expect(screen.queryByText("公司技能库")).toBeNull();
  });

  it("路径预告探不到就整条不显示 —— 不假装知道", async () => {
    useShare.setState({ preview: "unknown" });
    openWith();
    await screen.findByText("周报生成");
    for (const s of ["直接生效", "需要管理员审核", "写入权限"]) {
      expect(screen.queryByText(new RegExp(s))).toBeNull();
    }
  });

  it("SKILL.md 读不出来时不摆名称描述那两行,但确认屏照常开着", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_local_detail") throw { code: "FS_READ", message: "读不出来" };
      return null;
    });
    openWith();
    // 文件夹名那一行来自 list,不依赖现读,所以它一定在
    expect(await screen.findByText("weekly-report")).toBeInTheDocument();
    expect(screen.queryByText("周报生成")).toBeNull();
  });
});

describe("不合格时:不让分享,但给出路", () => {
  const blocks: [ShareBlock, RegExp][] = [
    ["nameMissing", /补上 name/],
    ["nameMismatch", /与文件夹名不一致/],
    ["nameFormat", /name 只能用/],
    ["dirFormat", /文件夹名只能用/],
    ["descriptionMissing", /补上 description/],
    ["descriptionTooLong", /太长了/],
    ["skillMdUnreadable", /读不出来或格式不对/],
  ];

  it.each(blocks)("%s 有一句说清哪不合格的人话", async (block, pattern) => {
    openWith(view({ shareBlocked: block }));
    await screen.findByText("weekly-report");
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  it("分享按钮禁用,且「打开文件夹」是那条出路", async () => {
    // 不给出路才是死路——用户自己改好文件夹名或 SKILL.md 就能分享了。
    openWith(view({ shareBlocked: "dirFormat" }));
    await screen.findByText("weekly-report");

    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "打开文件夹" }));

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_reveal");
    expect(call?.[1].args).toEqual({ path: BODY });
  });

  it("合格时按钮可点,也不摆「打开文件夹」那条出路(上一条的对照组)", async () => {
    openWith(view({ shareBlocked: null }));
    await screen.findByText("周报生成");
    expect(screen.getByRole("button", { name: "分享" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "打开文件夹" })).toBeNull();
  });
});

describe("确认与取消", () => {
  it("点「分享」→ skill_share,带 dirSlug", async () => {
    openWith();
    await screen.findByText("周报生成");

    await userEvent.click(screen.getByRole("button", { name: "分享" }));

    await vi.waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
      expect(call?.[1].args).toMatchObject({ dirSlug: "weekly-report" });
    });
  });

  it("零编辑意味着请求体里没有名称/描述/文件夹名可传", async () => {
    openWith();
    await screen.findByText("周报生成");
    await userEvent.click(screen.getByRole("button", { name: "分享" }));

    await vi.waitFor(() => {
      const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
      expect(call).toBeDefined();
      for (const k of ["shareName", "displayName", "description", "overwrite"]) {
        expect(call?.[1].args).not.toHaveProperty(k);
      }
    });
  });

  it("失败时错误摆在屏上,屏不关", async () => {
    useMySkills.setState({
      list: [view()],
      shareTarget: { dirSlug: "weekly-report" },
      shareError: { code: "REPO_NAME_TAKEN", message: "库里已经有同名技能了" },
    });
    render(<ShareConfirm />);
    expect(await screen.findByText(/库里已经有同名技能了/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Esc 关闭,不发任何请求", async () => {
    openWith();
    await screen.findByText("周报生成");
    await userEvent.keyboard("{Escape}");
    expect(useMySkills.getState().shareTarget).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("skill_share", expect.anything());
  });

  it("默认焦点在取消上", async () => {
    openWith();
    await screen.findByText("周报生成");
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });

  it("aria:模态对话框且由标题命名", async () => {
    openWith();
    await screen.findByText("周报生成");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "share-title");
  });

  it("没有目标时什么都不渲染", () => {
    const { container } = render(<ShareConfirm />);
    expect(container).toBeEmptyDOMElement();
  });
});
