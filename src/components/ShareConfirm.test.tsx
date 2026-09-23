import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareConfirm } from "./ShareConfirm";
import type { InstalledSkillView, Section, ShareBlock } from "@/lib/ipc";
import { useMySkills } from "@/store/my-skills";
import { shareTargetKey, useShare } from "@/store/share";
import { t } from "@/i18n";
import { planOf } from "@/test/share-plan";

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
  libraryUrl: null,
  canonicalReaders: null,
  ...over,
});

/**
 * `sharePreview` 的缺省值:确认屏在**预览轮回来之前**按钮是禁用的(v8 任务 5)
 * ——那一刻界面还答不出"会删掉哪些文件",而这一屏存在的理由就是先摆出那件事。
 * 这些用例测的是别的命题,所以给一份已经到手的清单。
 */
type Preview = ReturnType<typeof useMySkills.getState>["sharePreview"];
const PLAN = planOf({ modified: ["SKILL.md"] });

function openWith(
  skill = view(),
  sharePreview: Preview = {
    dirSlug: "weekly-report",
    plan: PLAN,
    overwrite: null,
    confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan" },
    stale: false,
    staleReason: null,
  },
) {
  useMySkills.setState({
    list: [skill],
    shareTarget: { dirSlug: skill.dirSlug },
    sharePreview,
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
  useMySkills.setState({
    list: null,
    shareTarget: null,
    sharePreview: null,
    shareBusy: null,
    shareError: null,
  });
  useShare.setState({ targetRepo: null, preview: "unknown", previews: {} });
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
    // 🔴 终审 I-4 起权限按**这一行自己的库坐标**探,所以这里喂 IPC 而不是直接
    // 往 store 里塞一份全局结果——那条路已经不是生产代码走的那条了。
    useShare.setState({ previews: { [shareTargetKey(undefined, undefined)]: "directPush" } });
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

  it("🔴 终审 C-1:「可分享到」区哪怕带着(它自己外部来源的)坐标,目标库仍显示公司技能库", async () => {
    // 典型场景:从广场/GitHub 装来、还没分享过的技能——section 是 shareable,
    // sourceOwner/sourceRepo/registryId 记的是它自己的外部来源,不是公司库。
    // 与上一条(relation:"shared"/section:"sharedTo")的对照组:同样带着坐标,
    // 这里必须显示公司库而不是那个坐标——这一屏的标题恒是「分享到公司技能库」,
    // 显示的目标必须与之一致,也必须与实际提交的目标一致(见 my-skills.test.ts
    // 对 confirmShare 本身的同款用例)。
    openWith(
      view({
        relation: "draft",
        registryId: "plaza",
        sourceOwner: "vercel-labs",
        sourceRepo: "agent-skills",
      }),
    );
    await screen.findByText("weekly-report");
    expect(screen.getByText("公司技能库")).toBeInTheDocument();
    expect(screen.queryByText("vercel-labs/agent-skills")).toBeNull();
  });

  it("路径预告探不到就整条不显示 —— 不假装知道", async () => {
    useShare.setState({ previews: {} });
    openWith();
    await screen.findByText("周报生成");
    for (const s of ["直接生效", "写入权限"]) {
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
      for (const k of ["shareName", "displayName", "description", "overwrite", "sourcePath"]) {
        expect(call?.[1].args).not.toHaveProperty(k);
      }
    });
  });

  it("失败时错误摆在屏上,屏不关", async () => {
    useMySkills.setState({
      list: [view()],
      shareTarget: { dirSlug: "weekly-report" },
      // 终审复审轮 1,C-A:`shareError` 现在带归属(与 `shareDone` 对称),
      // dirSlug 必须与 shareTarget 相同,否则这一屏按设计就不该显示它。
      shareError: {
        dirSlug: "weekly-report",
        error: { code: "REPO_NAME_TAKEN", message: "库里已经有同名技能了" },
        flow: "share",
      },
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

describe("改动清单(v8 任务 5 / D5、D6、D9)", () => {
  it("🔴 清单还没到之前不许提交——那一刻界面还答不出会删掉哪些文件", async () => {
    openWith(view(), null);
    await screen.findByText("周报生成");
    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
    expect(screen.getByText("正在看技能库里现在是什么样…")).toBeInTheDocument();
  });

  it("🔴 会从技能库里删掉的文件必须逐个列出来,并说清后果", async () => {
    openWith(view(), {
      dirSlug: "weekly-report",
      plan: planOf({ added: ["新写的.md"], modified: ["SKILL.md"], deleted: ["踩过的坑.md"] }),
      overwrite: null,
      confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan" },
      stale: false,
      staleReason: null,
    });
    await screen.findByText("周报生成");
    expect(screen.getByText("踩过的坑.md")).toBeInTheDocument();
    expect(screen.getByText("新写的.md")).toBeInTheDocument();
    expect(screen.getByText(/这 1 个文件会从技能库里删掉/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分享" })).toBeEnabled();
  });

  it("🔴 D9:库里被别人改过时,覆盖警告与清单在**同一屏**上,不另开一个框", async () => {
    openWith(view(), {
      dirSlug: "weekly-report",
      plan: planOf({ modified: ["SKILL.md"] }),
      overwrite: {
        lastAuthor: "李四",
        lastAt: "2026-09-10T03:04:05Z",
        historyUrl: "http://g/commits/x",
      },
      confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan" },
      stale: false,
      staleReason: null,
    });
    await screen.findByText("周报生成");
    expect(screen.getByText(/李四/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在技能库里查看历史" })).toBeInTheDocument();
    // 同一个 dialog 里既有警告又有清单
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
  });

  it("🔴 库里已经与本地一致:如实说出来,且不许提交(按下去就是一笔空提交)", async () => {
    openWith(view(), { dirSlug: "weekly-report", inSync: true });
    await screen.findByText("周报生成");
    expect(screen.getByText(/已经和你本地的一样了/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
  });

  it("换技能时不把上一个技能的删除清单摆给他看(归属过滤)", async () => {
    openWith(view(), {
      dirSlug: "another-skill",
      plan: planOf({ deleted: ["别的技能的.md"] }),
      overwrite: null,
      confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan" },
      stale: false,
      staleReason: null,
    });
    await screen.findByText("周报生成");
    expect(screen.queryByText("别的技能的.md")).toBeNull();
    expect(screen.getByRole("button", { name: "分享" })).toBeDisabled();
  });

  it("🔴 终审 C-1:重算过的清单要如实说一句,不静默替换", async () => {
    openWith(view(), {
      dirSlug: "weekly-report",
      plan: planOf({ deleted: ["同事刚加的.md"] }),
      overwrite: null,
      confirm: { remoteRev: "sha256:second", planRev: "sha256:plan2" },
      stale: true,
      staleReason: "remoteChanged",
    });
    await screen.findByText("周报生成");
    expect(screen.getByText(t("share.planChanged"))).toBeInTheDocument();
    expect(screen.getByText("同事刚加的.md")).toBeInTheDocument();
  });

  it("🔴 v8 任务 8:变的是**本地**那一头时说另一句话,不冤枉同事", async () => {
    openWith(view(), {
      dirSlug: "weekly-report",
      plan: planOf({ added: ["刚写的.md"] }),
      overwrite: null,
      confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan2" },
      stale: true,
      staleReason: "localChanged",
    });
    await screen.findByText("周报生成");
    // 断言的是**那句话本身**:两种原因共用一句的话,这里会摆出"技能库里…又变了"
    // ——而库里一个字都没动,是他自己的编辑器改的。
    expect(screen.getByText(t("share.planChangedLocally"))).toBeInTheDocument();
    expect(screen.queryByText(t("share.planChanged"))).toBeNull();
  });

  it("寻常的预览轮不摆那句话(否则每次分享都在报一个不存在的警)", async () => {
    openWith();
    await screen.findByText("周报生成");
    expect(screen.queryByText(t("share.planChanged"))).toBeNull();
  });

  it("🔴 终审 I-1:覆盖档的按钮写「仍然覆盖」且是红色,与姊妹弹窗同一个说法", async () => {
    openWith(view(), {
      dirSlug: "weekly-report",
      plan: planOf({ modified: ["SKILL.md"] }),
      overwrite: { lastAuthor: "李四", lastAt: null, historyUrl: null },
      confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan" },
      stale: false,
      staleReason: null,
    });
    await screen.findByText("周报生成");
    const go = screen.getByRole("button", { name: t("overwrite.confirm") });
    // 视觉也要跟着语义走:强调色的「分享」会让人以为自己在做一件无害的事
    expect(go.className).toContain("#c0392b");
    expect(screen.queryByRole("button", { name: t("mine.share") })).toBeNull();
  });

  it("没人被顶掉时仍然是普通的「分享」(否则每次分享都在吓唬人)", async () => {
    openWith();
    await screen.findByText("周报生成");
    const go = screen.getByRole("button", { name: t("mine.share") });
    expect(go.className).toContain("bg-accent");
  });

  it("🔴 终审 I-3:文件多时清单自己滚,别把确认/取消顶出视口", async () => {
    openWith(view(), {
      dirSlug: "weekly-report",
      plan: planOf({ added: Array.from({ length: 40 }, (_, i) => `f${i}.md`) }),
      overwrite: null,
      confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan" },
      stale: false,
      staleReason: null,
    });
    await screen.findByText("周报生成");
    const box = screen.getByTestId("share-plan-files");
    expect(box.className).toMatch(/max-h-\[\d+px\]/);
    expect(box.className).toContain("overflow-y-auto");
    // 两颗按钮仍在(它们不在滚动盒里)
    expect(screen.getByRole("button", { name: t("conflict.cancel") })).toBeInTheDocument();
  });
});

describe("🔴 v8 任务 10 / Q20:清单里的文件就地展开看内容", () => {
  const PLAN_WITH_CONTENT = {
    added: [{ path: "新写的.md", body: { kind: "text" as const } }],
    modified: [
      {
        path: "SKILL.md",
        diff: {
          kind: "hunks" as const,
          hiddenHunks: 0,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [
                { op: "delete" as const, text: "旧的一句" },
                { op: "insert" as const, text: "改过的一句" },
              ],
            },
          ],
        },
      },
    ],
    deleted: [{ path: "踩过的坑.txt", body: { kind: "text" as const, text: "库里那一版的坑" } }],
  };

  function openWithContent() {
    openWith(view(), {
      dirSlug: "weekly-report",
      plan: PLAN_WITH_CONTENT,
      overwrite: null,
      confirm: { remoteRev: "sha256:seen", planRev: "sha256:plan" },
      stale: false,
      staleReason: null,
    });
  }

  it("新增文件点开才按需读本地盘,读的是这个技能本体下的这一个文件", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_local_file_read") return { kind: "text", text: "新写的正文" };
      if (cmd === "skill_local_detail")
        return { name: "周报生成", dirSlug: "weekly-report", description: "", path: BODY, skillMd: "", files: [], hasScripts: false };
      return { agents: [], canonicalDir: "" };
    });
    openWithContent();
    await screen.findByText("周报生成");
    // 没点之前一次都不读(按需读,不是预取)
    expect(invoke.mock.calls.filter(([c]) => c === "skill_local_file_read")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /新写的\.md/ }));
    await userEvent.click(await screen.findByRole("button", { name: t("viewer.modeRaw") }));
    expect(await screen.findByText("新写的正文")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("skill_local_file_read", {
      args: { path: BODY, file: "新写的.md" },
    });
  });

  it("修改的文件展开是差异,删除的文件展开是库里那一版的内容", async () => {
    openWithContent();
    await screen.findByText("周报生成");
    expect(screen.queryByText("改过的一句")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /SKILL\.md/ }));
    expect(screen.getByText("旧的一句")).toBeInTheDocument();
    expect(screen.getByText("改过的一句")).toBeInTheDocument();

    expect(screen.queryByText("库里那一版的坑")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /踩过的坑\.txt/ }));
    expect(screen.getByText("库里那一版的坑")).toBeInTheDocument();
  });

  it("再点一次收起", async () => {
    openWithContent();
    await screen.findByText("周报生成");
    const row = screen.getByRole("button", { name: /SKILL\.md/ });
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("改过的一句")).toBeNull();
  });
});
