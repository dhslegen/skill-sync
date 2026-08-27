import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictDialog } from "./ConflictDialog";
import { useInstall } from "@/store/install";
import { useStoreIndex } from "@/store/store-index";
import type { Precheck } from "@/lib/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function conflict(precheck: Parameters<typeof useInstall.setState>[0] extends never ? never : unknown) {
  useInstall.setState({
    phase: "conflict",
    dirSlug: "weekly-report",
    precheck: precheck as never,
  });
}

describe("冲突对话框", () => {
  beforeEach(() => {
    useInstall.setState({ phase: "idle", dirSlug: null, precheck: null });
  });

  it("没有冲突时不渲染", () => {
    render(<ConflictDialog />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("用户改过本体:三个选项都在,且说清各自后果", () => {
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("你修改过这个技能")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保留并分享我的改动/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /只保留,暂不分享/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /用团队库的版本覆盖/ })).toBeInTheDocument();
    // 🔴 破坏性那一项必须写明**后果与能不能挽回**,而且必须是真话(终审 C-2)。
    // 这条断言此前查的是「无法找回」——**它把一句假话钉住了**:core 的
    // `Installer::install` 走 `fsops::trash_tree`,旧本体进的是系统废纸篓。
    // 说"找不回来"会让用户要么不敢点一个安全的动作,要么后悔时根本不去翻废纸篓
    // ——本期最大的产品承诺(拿走用户数据的动作都可逆)在最需要它的那一屏上
    // 被应用自己否认。
    expect(screen.getByText(/替换掉/)).toBeInTheDocument();
    expect(screen.getByText(/废纸篓,可以从那里找回/)).toBeInTheDocument();
    expect(screen.queryByText(/无法找回|找不回/)).toBeNull();
  });

  it("默认焦点落在「保留并分享」上 —— 用户拍板的默认项,且回车不会误覆盖", () => {
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByRole("button", { name: /保留并分享我的改动/ })).toHaveFocus();
  });

  it("「只保留」选项指路到之后可以分享的入口", () => {
    // 任务 11 之前这里写的是"分享功能开放后"——通道落地了,文案也要跟着指路,
    // 不能让用户保留了改动却不知道下一步去哪。
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByText(/「我的技能」/)).toBeInTheDocument();
  });

  it("选「只保留」→ 带 keepLocal 重试,不发分享", async () => {
    const run = vi.fn();
    const keepLocalAndShare = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ run, keepLocalAndShare });
    render(<ConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: /只保留,暂不分享/ }));
    expect(run).toHaveBeenCalledWith("keepLocal");
    expect(keepLocalAndShare).not.toHaveBeenCalled();
  });

  it("选「保留并分享」→ 走 keepLocalAndShare", async () => {
    const keepLocalAndShare = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ keepLocalAndShare });
    render(<ConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: /保留并分享我的改动/ }));
    expect(keepLocalAndShare).toHaveBeenCalled();
  });

  it("选覆盖 → 带 overwrite 重试", async () => {
    const run = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ run });
    render(<ConflictDialog />);

    await userEvent.click(screen.getByRole("button", { name: /用团队库的版本覆盖/ }));
    expect(run).toHaveBeenCalledWith("overwrite");
  });

  it("说的是技能的展示名,不是内部目录名", () => {
    // 用户认得的是"周报生成";弹给他一个 weekly-report,就是把机器用的标识摆到脸上
    useStoreIndex.setState({
      index: {
        registryId: "company", owner: "skills", repo: "skills", branch: "main",
        commitSha: "a", committedAt: "", fetchedAt: 0, skipped: [], fromCache: false, offline: false, curated: [],
        skills: [{ name: "周报生成", dirSlug: "weekly-report", description: "", path: "", hasScripts: false, fileCount: 1, contentHash: "sha256:a", tags: [], author: null }],
      },
    });
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByText(/「周报生成」/)).toBeInTheDocument();
    expect(screen.queryByText(/weekly-report/)).not.toBeInTheDocument();
  });

  it("查不到展示名时退回目录名,而不是留空", () => {
    useStoreIndex.setState({ index: null });
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    render(<ConflictDialog />);
    expect(screen.getByText(/「weekly-report」/)).toBeInTheDocument();
  });

  it("同名异库:说清它现在从哪来,只给替换与取消,默认焦点在取消", () => {
    // 它**是**本应用装的,所以既不能套"改过本体"的三选(没有改动可保留),
    // 也不能套外来目录那句"不是本应用安装的"——那是假话。
    conflict({
      status: "otherLibrary",
      installedSha: "zzz9999",
      sourceOwner: "design",
      sourceRepo: "design-skills",
    });
    render(<ConflictDialog />);

    expect(screen.getByText(/design\/design-skills/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /保留我的改动/ })).not.toBeInTheDocument();
    // 不能落进外来目录那一档的文案
    expect(screen.queryByText(/不是本应用安装的|不是这个应用安装的/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /替换/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    // 终审 C-2:替换掉的那一份进废纸篓,说「无法找回」是假话
    expect(screen.getByText(/废纸篓,可以从那里找回/)).toBeInTheDocument();
    // 复审 Cr-1:正文末句此前写着「找不回来」,与两行之下的 hint 自相矛盾——
    // 负向断言只查「无法找回」抓不住这个变体,所以它活过了 C-2。正文单独钉一句。
    expect(screen.getByText(/原来的内容会移到废纸篓/)).toBeInTheDocument();
    expect(screen.queryByText(/无法找回|找不回/)).toBeNull();
  });

  describe("这是我分享的技能(v6 任务 5 的完整变体)", () => {
    it("远端变过:只有两个按钮,没有「保留并贡献」;默认焦点在「以本地为准」上", () => {
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      render(<ConflictDialog />);

      expect(screen.getByText(/库里有新版/)).toBeInTheDocument();
      expect(screen.queryByText(/不是本应用安装的|不是这个应用安装的/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /保留并贡献/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以本地为准,分享更新/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以库为准,丢弃本地改动/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以本地为准,分享更新/ })).toHaveFocus();
    });

    it("远端没变过:标题/正文不说「库里有新版」这句假话", () => {
      // core 只在 local_changed 为真时才会走到这个弹窗,remoteChanged 才是
      // 到这里唯一还不确定的事——为假时不能沿用"库里有新版"这句话。
      conflict({ status: "mine", localChanged: true, remoteChanged: false });
      render(<ConflictDialog />);

      expect(screen.queryByText(/库里有新版/)).not.toBeInTheDocument();
      expect(screen.queryByText(/同事通过审核改的/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以本地为准,分享更新/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /以库为准,丢弃本地改动/ })).toBeInTheDocument();
    });

    it("点「以本地为准」→ 走 keepLocalAndShareMine,不是 keepLocalAndShare", async () => {
      const keepLocalAndShareMine = vi.fn();
      const keepLocalAndShare = vi.fn();
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      useInstall.setState({ keepLocalAndShareMine, keepLocalAndShare });
      render(<ConflictDialog />);

      await userEvent.click(screen.getByRole("button", { name: /以本地为准,分享更新/ }));
      expect(keepLocalAndShareMine).toHaveBeenCalled();
      expect(keepLocalAndShare).not.toHaveBeenCalled();
    });

    it("点「以库为准」第一下就生效 —— 二次确认已撤销(终审 C-2)", async () => {
      // 🔴 它当初存在的唯一理由是"本地改动无法找回",而 `Installer::install`
      // 走 `fsops::trash_tree`:旧本体进系统废纸篓,**可以找回**。同一条推理
      // 已经让 `RemoveDialog` 撤掉双确认(移除删的同样是整个本体、同样不"无损")。
      // 留着就是两套尺子。另一道护栏没动:默认焦点仍在无损项上,回车不会覆盖。
      const run = vi.fn();
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      useInstall.setState({ run });
      render(<ConflictDialog />);

      await userEvent.click(screen.getByRole("button", { name: /以库为准,丢弃本地改动/ }));
      expect(run).toHaveBeenCalledWith("overwrite");
    });

    it("默认焦点落在无损那一项上 —— 撤了二次确认之后它是唯一的手滑护栏", () => {
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      render(<ConflictDialog />);
      expect(screen.getByRole("button", { name: /以本地为准,分享更新/ })).toHaveFocus();
    });

    it("「以库为准」的说明常驻,而且说的是可逆(不是「无法找回」)", () => {
      conflict({ status: "mine", localChanged: true, remoteChanged: true });
      render(<ConflictDialog />);
      // 常驻:不必先点一下"武装"才看得见。不敢点的人在**点之前**就该看见能找回。
      expect(screen.getByText(/废纸篓,可以从那里找回/)).toBeInTheDocument();
      expect(screen.queryByText(/无法找回|找不回/)).toBeNull();
    });
  });

  describe("这台电脑上已有一份不一样的(v6 二期取代「外来目录」那一档)", () => {
    const differs = { status: "localDiffers", existing: "/home/u/.claude/skills/weekly-report" };

    it("说的是「已有一份不同的」,绝不说「不是本应用安装的」", () => {
      // 🔴 这是这一期的起因:用户在自己电脑上写的技能,被 app 说成外人。
      // 上一版对认不出的形状会落进那句话的兜底分支,现在这一档有自己的说法。
      conflict(differs);
      render(<ConflictDialog />);

      expect(screen.getByText("这台电脑上已有一份不同的「weekly-report」")).toBeInTheDocument();
      expect(screen.queryByText(/不是本应用安装的|不是这个应用安装的|不是通过本应用安装的/)).not.toBeInTheDocument();
    });

    it("把那份东西在哪说出来 —— 不然用户不知道说的是哪个文件夹", () => {
      conflict(differs);
      render(<ConflictDialog />);
      expect(screen.getByText(/\/home\/u\/\.claude\/skills\/weekly-report/)).toBeInTheDocument();
    });

    it("两个按钮,默认焦点在「保留本地的」上 —— 回车不动用户的文件", () => {
      conflict(differs);
      render(<ConflictDialog />);

      expect(screen.getByRole("button", { name: /保留本地的/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /用库里的/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /保留本地的/ })).toHaveFocus();
      expect(screen.getByRole("button", { name: "取消" })).not.toHaveFocus();
    });

    it("🔴 「保留本地的」的说明不得承诺「会启用到工具」 —— core 那条路一处都不改", () => {
      // 承诺侧的另一半(行为侧在 `install.test.ts`:`skill_set_agents` 发出 0 次)。
      // 这句话曾经写着「只是把它在选中的 AI 工具里启用」,而 core 对
      // `LocalDiffers + KeepLocal` 是早退、**排在 `link_only` 之前**,什么都不做
      // ——用户读到承诺、得到零效果。**正面断言"说了不改"与"给了出路"**,
      // 不用"断言某句话不存在"那种分不清"改了措辞"和"整段没了"的写法。
      conflict(differs);
      render(<ConflictDialog />);

      const hint = screen.getByText(/不改动任何工具的启用状态/);
      expect(hint).toBeInTheDocument();
      // 出路:告诉他去哪儿才能让工具用上它(core 注释指的 `converge::set_agents`
      // 那条路,界面上就是「我的技能」里的那组勾)
      expect(hint.textContent).toMatch(/我的技能/);
    });

    it("正文不写死「公司技能库」 —— 广场技能不来自那儿", () => {
      // 广场(GitHub)来源的技能同样会走到这一档,说"内容与公司技能库里的这一版
      // 不一样"是错的库名。中性说法对两种来源都成立。
      conflict(differs);
      render(<ConflictDialog />);

      const body = screen.getByRole("alertdialog").querySelectorAll("p")[0];
      expect(body?.textContent).toMatch(/你正要获取的这一版/);
      expect(body?.textContent).not.toMatch(/公司技能库|团队库/);
    });

    it("「用库里的」说的是「移到废纸篓,可以找回」,不是「无法找回」", () => {
      // core 的 `Installer::install` 把旧本体送进系统废纸篓(`fsops::trash_tree`),
      // 所以照抄旧那句「原有内容无法找回」在今天是**假话**。
      conflict(differs);
      render(<ConflictDialog />);

      expect(screen.getByText(/移到废纸篓/)).toBeInTheDocument();
      expect(screen.getByText(/可以.*找回/)).toBeInTheDocument();
      expect(screen.queryByText(/无法找回|找不回/)).not.toBeInTheDocument();
    });

    it("点「保留本地的」→ run(\"keepLocal\");点「用库里的」→ run(\"overwrite\")", async () => {
      const run = vi.fn();
      conflict(differs);
      useInstall.setState({ run });
      render(<ConflictDialog />);

      await userEvent.click(screen.getByRole("button", { name: /保留本地的/ }));
      expect(run).toHaveBeenCalledWith("keepLocal");

      // 两条路都无损,所以**没有二次确认**(与 `RemoveDialog` 撤掉双确认同一个
      // 理由:可逆比追问管用)。这里正面钉住"第一下就生效"。
      await userEvent.click(screen.getByRole("button", { name: /用库里的/ }));
      expect(run).toHaveBeenCalledWith("overwrite");
    });

    it("「内容与库里相同」那一档根本不该弹这个窗", () => {
      // core 的 `acquire::acquire` 里 `needs_decision` 不含 `AlreadyHere`,
      // 它直接走 `link_only` 装完(记账 + 启用,本体一个字节不写)。真要是哪天
      // 有人让它退回 needsDecision,用户该看到的是错误态(见 install.test.ts
      // 的"认不出的拍板形状"一条),而不是一个不弹的弹窗或一句假话。
      conflict({ status: "alreadyHere", body: "/home/u/.claude/skills/weekly-report" });
      render(<ConflictDialog />);

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("Precheck 的档位集合就是这八个 —— 加一档必须先来这里过一眼", () => {
      // ⚠️ 这条真正的检查由 `pnpm build:web`(tsc)执行,**vitest 本身不做类型检查**。
      //
      // 它挡的是这一期最核心的一次回退:把撤销掉的那个"这不是本应用装的"档
      // 加回 `Precheck`。加回来之后,弹窗的兜底分支就又有理由说那句假话了。
      // 判据写成**双向的集合相等**(既不许多、也不许少),而不是点名某个字面量
      // ——点名只挡得住一个,集合相等挡得住任何一次悄悄扩档。
      const KNOWN = [
        "fresh",
        "alreadyHere",
        "localDiffers",
        "needsVersionChoice",
        "managed",
        "locallyModified",
        "otherLibrary",
        "mine",
      ] as const;
      type Unlisted = Exclude<Precheck["status"], (typeof KNOWN)[number]>;
      type Ghost = Exclude<(typeof KNOWN)[number], Precheck["status"]>;
      const noUnlisted: [Unlisted] extends [never] ? true : false = true;
      const noGhost: [Ghost] extends [never] ? true : false = true;
      expect(noUnlisted && noGhost).toBe(true);
      // 顺带把"八个"钉成真话,并让 KNOWN 在运行时也有读者(eslint 要求)
      expect(KNOWN).toHaveLength(8);
      expect(new Set(KNOWN).size).toBe(KNOWN.length);
    });
  });

  it("Esc 取消,不留在半路", async () => {
    const cancel = vi.fn();
    conflict({ status: "locallyModified", installedSha: "aaa1111" });
    useInstall.setState({ cancel });
    render(<ConflictDialog />);

    await userEvent.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalled();
  });
});
