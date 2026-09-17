import { beforeEach, describe, expect, it, vi } from "vitest";

import { failedLinks, linkedAgents, useInstall } from "./install";
import { useRegistries } from "./registries";
import { useMySkills } from "@/store/my-skills";
import { useOverwrite } from "@/store/overwrite";
import { useUi } from "./ui";
import type { AcquireOutcome, InstallReport } from "@/lib/ipc";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
const listen = vi.fn(async () => () => {});
vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...(a as [])) }));

const AGENTS = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", installed: true, globalSkillsDir: "~/.claude/skills", skillsDir: ".claude-code/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "trae", displayName: "Trae", installed: false, globalSkillsDir: "~/.trae/skills", skillsDir: ".trae/skills", isUniversal: false, needsLink: true, disabled: false },
    { name: "cursor", displayName: "Cursor", installed: true, globalSkillsDir: "~/.agents/skills", skillsDir: ".cursor/skills", isUniversal: true, needsLink: false, disabled: false },
  ],
  canonicalDir: "~/.agents/skills",
};

const report = (over: Partial<InstallReport> = {}): InstallReport => ({
  dirName: "weekly-report",
  canonicalDir: "/home/u/.agents/skills/weekly-report",
  links: [{ dir: "/home/u/.claude/skills", agents: ["claude-code"], result: { status: "linked", mode: "symlink" } }],
  ...over,
});

function reset() {
  invoke.mockReset();
  listen.mockClear();
  useInstall.setState({
    phase: "idle",
    dirSlug: null,
    agents: [],
    selected: new Set(),
    stage: null,
    report: null,
    localKept: false,
    mineKept: null,
    shareResult: null,
    precheck: null,
    error: null,
    installed: new Map(),
    enablingDir: null,
    enableError: null,
  });
  useMySkills.setState({ versionChoice: null, keepError: null });
  useMySkills.setState({ shareTarget: null, list: null });
  useUi.setState({ page: "store" });
}

/** 一次"claude-code 成了、trae 那处没成"的安装结果。错误码取一个 core 真会发的
 *  通用码:早先那个"位置被顶掉"的专用错误码连同"替换掉那个位置"那条路一起在
 *  v6 二期撤销了,在 mock 里继续造它会让人以为那条路还在。 */
const TOOL_DIR_ERROR = {
  code: "FS_TASK",
  message: "这个位置没能启用,请重试",
};
const partiallyFailed = (): InstallReport =>
  report({
    links: [
      { dir: "/home/u/.claude/skills", agents: ["claude-code"], result: { status: "linked", mode: "symlink" } },
      { dir: "/home/u/.trae/skills", agents: ["trae"], result: { status: "failed", error: TOOL_DIR_ERROR } },
    ],
  });

describe("获取流程状态机", () => {
  beforeEach(reset);

  it("点安装先展开勾选,默认只勾已检测到的工具", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? AGENTS : null));

    await useInstall.getState().begin("weekly-report");

    const s = useInstall.getState();
    expect(s.phase).toBe("choosing");
    // 没装的工具不该被默认勾上 —— 勾了也建不成链接,只会在结果里报一堆失败
    expect([...s.selected]).toEqual(["claude-code", "cursor"]);
    // 磁盘还没被碰过
    expect(invoke).not.toHaveBeenCalledWith("skill_install", expect.anything());
  });

  it("设置页关掉的工具不进默认勾选(手动仍可勾)", async () => {
    const withDisabled = {
      ...AGENTS,
      agents: AGENTS.agents.map((a) =>
        a.name === "cursor" ? { ...a, disabled: true } : a,
      ),
    };
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? withDisabled : null));

    await useInstall.getState().begin("weekly-report");

    const s = useInstall.getState();
    expect([...s.selected]).toEqual(["claude-code"]);
    // 列表里 cursor 仍然在——开关只影响默认勾选,不把选项藏起来
    expect(s.agents.map((a) => a.name)).toContain("cursor");
  });

  it("确认后带着勾选的工具去装", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" } satisfies AcquireOutcome;
    });

    await useInstall.getState().begin("weekly-report");
    useInstall.getState().toggleAgent("trae");
    await useInstall.getState().run();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    const sent = call?.[1].args;
    expect(sent.dirSlug).toBe("weekly-report");
    expect([...sent.agentIds].sort()).toEqual(["claude-code", "cursor", "trae"]);
    // 首次调用不带 resolution:让 core 先做预检
    expect(sent.resolution).toBeUndefined();
    expect(useInstall.getState().phase).toBe("done");
  });

  it("core 说需要拍板时,停在冲突态且不重试", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      return {
        outcome: "needsDecision",
        precheck: { status: "locallyModified", installedSha: "aaa1111" },
      } satisfies AcquireOutcome;
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const s = useInstall.getState();
    expect(s.phase).toBe("conflict");
    expect(s.precheck).toEqual({ status: "locallyModified", installedSha: "aaa1111" });
    // 关键:不能自作主张再发一次带 resolution 的请求
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(1);
  });

  it("「这台电脑上已有一份不一样的」同样停在冲突态,让弹窗两选", async () => {
    // 上一版这一档在 core 里叫 `Foreign`、在界面上被说成「不是本应用安装的」。
    // 现在它是 `localDiffers`,照走同一条拍板通道——**不能被当成认不出的形状
    // 落进错误态**,那样用户就没有"用库里的 / 保留本地的"这两条路可选了。
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      return {
        outcome: "needsDecision",
        precheck: { status: "localDiffers", existing: "/home/u/.claude/skills/weekly-report" },
      } satisfies AcquireOutcome;
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const s = useInstall.getState();
    expect(s.phase).toBe("conflict");
    expect(s.precheck).toEqual({
      status: "localDiffers",
      existing: "/home/u/.claude/skills/weekly-report",
    });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(1);
  });

  it("「保留本地的」走 keepLocal:core 什么都没写,落 done 且不报「已启用」", async () => {
    // core 对 `localDiffers` + keepLocal 走的是 `AcquireOutcome::Kept` 出口
    // (磁盘/账/工具启用零变化),`remoteChanged` 恒为 true——"库里那一版与
    // 本地这份不同"正是这一档的定义。
    let calls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      calls += 1;
      return calls === 1
        ? { outcome: "needsDecision", precheck: { status: "localDiffers", existing: "/h/x" } }
        : { outcome: "kept", remoteChanged: true };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().run("keepLocal");

    const s = useInstall.getState();
    expect(s.phase).toBe("done");
    // kind 必须是 localDiffers:装完那一屏靠它挑文案,挑错了就会对这一档说
    // 「未做其他改动」而**不给出路**(见 install.localDiffersKept)
    expect(s.mineKept).toEqual({ remoteChanged: true, kind: "localDiffers" });
    // `report` 留空:这不是一次安装,`DoneFooter` 靠它认出该说哪句话
    expect(s.report).toBeNull();
  });

  it("🔴 「保留本地的」一处工具启用都不改 —— 断言的是行为,不是文案", async () => {
    // # 这条测试是为了一个真发生过的缺陷
    //
    // 这颗按钮的说明曾经写着「只是把它在选中的 AI 工具里启用」——那是把
    // `locallyModified + keepLocal`(那一档**确实**走 `link_only` 补建)的语义
    // 抄给了 `localDiffers`。而 core 对 `LocalDiffers + KeepLocal` 是**早退**
    // (`acquire.rs`:`return Ok(AcquireOutcome::Kept{..})`,**排在 `link_only` 之前**,
    // 注释写明"不补建"),用户读到一句承诺、得到零效果——恰恰命中本期的动机场景
    // (在 `~/.claude/skills` 下自己开发技能的人)。
    //
    // 🔴 **断言的是"一次都不发",不是"文案渲染了"**:一条只断言文案的测试
    // 根本发现不了承诺与行为的背离——上一轮就是这么漏掉的。
    // 承诺那一半在 `ConflictDialog.test.tsx` 里钉,两边注释互指。
    let calls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      if (cmd === "skill_install") {
        calls += 1;
        return calls === 1
          ? { outcome: "needsDecision", precheck: { status: "localDiffers", existing: "/h/x" } }
          : { outcome: "kept", remoteChanged: true };
      }
      return null;
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().run("keepLocal");

    // 行为:这条路一处工具启用都不改
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_set_agents")).toHaveLength(0);
    // 也没有任何"已启用到 X"可报——`report` 是那句文案的唯一数据源
    expect(useInstall.getState().report).toBeNull();
    expect(linkedAgents(useInstall.getState().report)).toEqual([]);
  });

  it("认不出的拍板形状 → 错误态,不是停在「安装中」", async () => {
    // 契约对不上时**必须有落点**。停在 conflict 的话弹窗一个都不弹
    // (`ConflictDialog` 只认那四档),而底部按 conflict 画成"安装中"
    // ——用户既看不到原因,也没有出口。
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      // `alreadyHere` 在 core 里从不退回 needsDecision(它直接装完),
      // 这里拿它当"形状对不上"的样本正合适。
      return { outcome: "needsDecision", precheck: { status: "alreadyHere", body: "/h/x" } };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const s = useInstall.getState();
    expect(s.phase).toBe("error");
    expect(s.error?.message).toContain("没认出");
    expect(s.error?.detail).toBe("alreadyHere");
    // 绝不自作主张重来一次(那等于替用户选了一种处置)
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(1);
  });

  describe("同名的有好几份:转去拍板,拍完自动重来一次", () => {
    const VERSIONS = [
      { path: "/h/.agents/skills/weekly-report", modifiedAt: "2026-08-01T00:00:00Z", files: 2, contentHash: "sha256:a" },
      { path: "/h/.claude/skills/weekly-report", modifiedAt: "2026-08-20T00:00:00Z", files: 3, contentHash: "sha256:b" },
    ];

    /** 第一次 skill_install 报"有好几份",之后一律装成功。 */
    function mockVersionChoiceThenOk() {
      let calls = 0;
      invoke.mockImplementation(async (cmd) => {
        if (cmd === "agents_detected") return AGENTS;
        if (cmd === "installed_list") return [];
        if (cmd === "skill_keep_version")
          return { body: VERSIONS[1].path, trashed: [VERSIONS[0].path], links: [], canonical: { Ok: { kind: "unchanged" } } };
        if (cmd === "skill_install") {
          calls += 1;
          return calls === 1
            ? { outcome: "needsDecision", precheck: { status: "needsVersionChoice", versions: VERSIONS } }
            : { outcome: "installed", report: report(), localKept: false, lock: "written" };
        }
        return [];
      });
    }

    it("打开拍板框、带上 after: \"install\",且不进冲突弹窗", async () => {
      mockVersionChoiceThenOk();

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().run();

      const choice = useMySkills.getState().versionChoice;
      expect(choice?.dirSlug).toBe("weekly-report");
      expect(choice?.after).toBe("install");
      // 🔴 版本清单要取 precheck 带回来的那份:这条路的入口在商店页,
      // `useMySkills.list` 通常还是 null,取那边就是一个零选项的空拍板框。
      expect(choice?.versions).toEqual(VERSIONS);
      // 冲突弹窗接不了这一档(`Resolution` 的两档回答不了"留哪一份")
      expect(useInstall.getState().phase).not.toBe("conflict");
      expect(useInstall.getState().precheck).toBeNull();
    });

    it("落回 idle 而不是卡在「安装中」,且留着重来一次要用的坐标", async () => {
      mockVersionChoiceThenOk();

      await useInstall.getState().begin("weekly-report", "company", "skills/skills");
      await useInstall.getState().run();

      const s = useInstall.getState();
      expect(s.phase).toBe("idle");
      expect(s.dirSlug).toBe("weekly-report");
      expect(s.registryId).toBe("company");
      expect(s.repo).toBe("skills/skills");
      expect([...s.selected]).toEqual(["claude-code", "cursor"]);
    });

    it("拍完板自动重来一次安装(只重来一次)", async () => {
      mockVersionChoiceThenOk();

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().run();
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(1);

      await useMySkills.getState().keepVersion("weekly-report", VERSIONS[1].path);

      // 第二次 skill_install 就是那次自动重来;多于两次说明重来了不止一遍
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(2);
      expect(useInstall.getState().phase).toBe("done");
      expect(useMySkills.getState().versionChoice).toBeNull();
    });

    it("用户关掉拍板框:不重来安装,也不留下任何「进行中」的假象", async () => {
      mockVersionChoiceThenOk();

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().run();
      useMySkills.getState().cancelVersionChoice();

      expect(useMySkills.getState().versionChoice).toBeNull();
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")).toHaveLength(1);
      expect(useInstall.getState().phase).toBe("idle");
    });
  });

  it("用户选了处置才带 resolution 重试", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      calls += 1;
      return calls === 1
        ? { outcome: "needsDecision", precheck: { status: "locallyModified", installedSha: "aaa" } }
        : { outcome: "installed", report: report(), localKept: true, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().run("keepLocal");

    const second = invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")[1];
    expect(second?.[1].args.resolution).toBe("keepLocal");
    expect(useInstall.getState().phase).toBe("done");
    expect(useInstall.getState().localKept).toBe(true);
  });

  // 🔴 这条是「保留并贡献」(改**别人**的技能):v8 任务 4 的「仍然覆盖」只给
  // 「我自己那一版」,顶掉别人的技能的出路是 v8 任务 6 的入口下线。所以这一跳
  // 仍然撞上 core 的覆盖闸,前端如实说一句「库里已经有更新的版本」。
  it("保留并分享:先 keepLocal 落稳,再推改动 —— 库里有新版时如实报错,绝不直推", async () => {
    let installCalls = 0;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      if (cmd === "skill_share_changes")
        return { kind: "needsConfirm", plan: { added: [], modified: ["SKILL.md"], deleted: [] }, overwrite: null };
      installCalls += 1;
      return installCalls === 1
        ? { outcome: "needsDecision", precheck: { status: "locallyModified", installedSha: "aaa" } }
        : { outcome: "installed", report: report(), localKept: true, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().keepLocalAndShare();

    // keepLocal 的重试带了 resolution
    const second = invoke.mock.calls.filter(([cmd]) => cmd === "skill_install")[1];
    expect(second?.[1].args.resolution).toBe("keepLocal");
    // 分享确实发生在保留之后,且**不再**带 forceReview(那个参数已下线)
    const shared = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
    expect(shared?.[1].args.dirSlug).toBe("weekly-report");
    expect(Object.keys(shared?.[1].args as Record<string, unknown>)).not.toContain("forceReview");
    // 保留成功了,只是分享没推出去——不能把整个结果画成失败
    expect(useInstall.getState().shareResult).toMatchObject({
      error: { code: "CONFLICT_REMOTE_CHANGED" },
    });
    expect(useInstall.getState().phase).toBe("done");
  });

  it("保留那一步没成,绝不接着分享", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "skill_share_changes") return { mode: "pushed", commitSha: "n", reviewUrl: null };
      throw { code: "NET_UNREACHABLE", message: "连不上公司技能库,请确认已接入公司内网或 VPN" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().keepLocalAndShare();

    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share_changes")).toBe(false);
    expect(useInstall.getState().shareResult).toBeNull();
  });

  it("保留成功、分享失败:结果不能画成整体失败", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      if (cmd === "skill_share_changes")
        throw { code: "AUTH_REQUIRED", message: "分享前请先登录公司技能库" };
      return { outcome: "installed", report: report(), localKept: true, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().keepLocalAndShare();

    const s = useInstall.getState();
    expect(s.phase).toBe("done");
    expect(s.localKept).toBe(true);
    expect(s.shareResult && "error" in s.shareResult && s.shareResult.error.message).toContain(
      "登录",
    );
  });

  describe("keepLocalAndShareMine(v6 任务 5:「我分享的」冲突弹窗的「以本地为准」)", () => {
    // v8 任务 4:`remoteChanged` 是拍板档不是失败——摆覆盖确认屏,点名覆盖谁
    // 与何时;用户按「仍然覆盖」就带 `overwrite` 重跑同一跳。
    it("remoteChanged 为真时,摆覆盖确认屏而不是写一条失败", async () => {
      useOverwrite.setState({ pending: null, busy: false });
      invoke.mockImplementation(async (cmd) => {
        if (cmd === "agents_detected") return AGENTS;
        if (cmd === "installed_list") return [];
        if (cmd === "skill_share_changes")
          return {
            kind: "needsConfirm",
            plan: { added: [], modified: ["SKILL.md"], deleted: [] },
            overwrite: {
              lastAuthor: "李四",
              lastAt: "2026-09-10T03:04:05Z",
              historyUrl: "http://g/commits/x",
            },
          };
        if (cmd === "skill_install")
          return { outcome: "kept", remoteChanged: true } satisfies AcquireOutcome;
        throw new Error(`unexpected ${cmd}`);
      });

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().keepLocalAndShareMine();

      const shared = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
      expect(shared?.[1].args).toEqual({
        dirSlug: "weekly-report",
        registryId: undefined,
      });
      const pending = useOverwrite.getState().pending;
      expect(pending?.dirSlug).toBe("weekly-report");
      expect(pending?.warning?.lastAuthor).toBe("李四");
      expect(pending?.warning?.historyUrl).toBe("http://g/commits/x");
      // v8 任务 5:清单也要一起带过去——这一屏的主要理由是"库里哪几个文件会没"。
      expect(pending?.plan.modified).toEqual(["SKILL.md"]);
      expect(useInstall.getState().shareResult).toBeNull();
      expect(useInstall.getState().phase).toBe("done");
      expect(useInstall.getState().mineKept).toEqual({ remoteChanged: true, kind: "mine" });
    });

    it("按「仍然覆盖」→ 带 confirmed 重来一次 → 分享成功", async () => {
      useOverwrite.setState({ pending: null, busy: false });
      const seen: unknown[] = [];
      invoke.mockImplementation(async (cmd, payload) => {
        if (cmd === "agents_detected") return AGENTS;
        if (cmd === "installed_list") return [];
        if (cmd === "skill_share_changes") {
          const args = (payload as { args: { confirmed?: boolean } }).args;
          seen.push(args.confirmed);
          return args.confirmed
            ? { kind: "submitted", mode: "pushed", commitSha: "new" }
            : { kind: "needsConfirm", plan: { added: [], modified: ["SKILL.md"], deleted: [] }, overwrite: null };
        }
        if (cmd === "skill_install")
          return { outcome: "kept", remoteChanged: true } satisfies AcquireOutcome;
        throw new Error(`unexpected ${cmd}`);
      });

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().keepLocalAndShareMine();
      await useOverwrite.getState().confirmOverwrite();

      expect(seen).toEqual([undefined, true]);
      expect(useOverwrite.getState().pending).toBeNull();
      expect(useInstall.getState().shareResult).toEqual({ mode: "pushed" });
    });

    it("remoteChanged 为假时照常直推成功(对照组,同样断言完整键集合)", async () => {
      invoke.mockImplementation(async (cmd) => {
        if (cmd === "agents_detected") return AGENTS;
        if (cmd === "installed_list") return [];
        if (cmd === "skill_share_changes")
          return { kind: "submitted", mode: "pushed", commitSha: "new", reviewUrl: null };
        if (cmd === "skill_install")
          return { outcome: "kept", remoteChanged: false } satisfies AcquireOutcome;
        throw new Error(`unexpected ${cmd}`);
      });

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().keepLocalAndShareMine();

      const shared = invoke.mock.calls.find(([cmd]) => cmd === "skill_share_changes");
      expect(shared?.[1].args).toEqual({
        dirSlug: "weekly-report",
        registryId: undefined,
      });
      expect(useInstall.getState().shareResult).toEqual({ mode: "pushed" });
    });

    it("core 什么都没写:report 留空,localKept 不因此变 true", async () => {
      invoke.mockImplementation(async (cmd) => {
        if (cmd === "agents_detected") return AGENTS;
        if (cmd === "installed_list") return [];
        if (cmd === "skill_share_changes")
          return { kind: "submitted", mode: "pushed", commitSha: "new", reviewUrl: null };
        if (cmd === "skill_install")
          return { outcome: "kept", remoteChanged: false } satisfies AcquireOutcome;
        throw new Error(`unexpected ${cmd}`);
      });

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().keepLocalAndShareMine();

      expect(useInstall.getState().report).toBeNull();
      expect(useInstall.getState().localKept).toBe(false);
    });

    it("没有 state.installed 记账(FS_NOT_INSTALLED)→ 改走分享页并预选候选", async () => {
      invoke.mockImplementation(async (cmd) => {
        if (cmd === "agents_detected") return AGENTS;
        if (cmd === "installed_list") return [];
        if (cmd === "share_preview") return "unknown";
        if (cmd === "skill_share_changes")
          throw { code: "FS_NOT_INSTALLED", message: "这个技能还没有安装信息" };
        if (cmd === "skill_install")
          return { outcome: "kept", remoteChanged: true } satisfies AcquireOutcome;
        throw new Error(`unexpected ${cmd}`);
      });

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().keepLocalAndShareMine();

      // 分享页整页已撤(v6 二期):这条路现在落在「我的技能」页 + 分享确认屏
      expect(useUi.getState().page).toBe("mine");
      expect(useMySkills.getState().shareTarget).toEqual({ dirSlug: "weekly-report" });
      // 那条路走完:不该在 install 这边留下一个"分享失败"的假象
      expect(useInstall.getState().shareResult).toBeNull();
    });

    it("又冲突或出错(没走到 kept)时不该继续分享", async () => {
      invoke.mockImplementation(async (cmd) => {
        if (cmd === "agents_detected") return AGENTS;
        if (cmd === "skill_share_changes") return { kind: "submitted", mode: "pushed", commitSha: "n", reviewUrl: null };
        if (cmd === "skill_install")
          return {
            outcome: "needsDecision",
            precheck: { status: "mine", localChanged: true, remoteChanged: true },
          } satisfies AcquireOutcome;
        throw new Error(`unexpected ${cmd}`);
      });

      await useInstall.getState().begin("weekly-report");
      await useInstall.getState().keepLocalAndShareMine();

      expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_share_changes")).toBe(false);
      expect(useInstall.getState().phase).toBe("conflict");
    });
  });

  it("装完刷新已安装列表,卡片状态才跟得上", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list")
        return [
          {
            dirSlug: "weekly-report",
            commitSha: "aaa1111",
            agents: [],
            installedAt: "",
            updatedAt: "",
            localModified: false,
            relation: "installed",
            localPresent: true,
          },
        ];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    expect(useInstall.getState().installed.get("weekly-report")).toEqual({
      commitSha: "aaa1111",
      localModified: false,
    });
  });

  it("每次安装用独立的进度频道,上一次的残余不会串进来", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();
    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const channels = listen.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("装失败给可读错误 + 允许重试", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      throw { code: "NET_UNREACHABLE", message: "连不上公司技能库,请确认已接入公司内网或 VPN" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    const s = useInstall.getState();
    expect(s.phase).toBe("error");
    expect(s.error?.message).toContain("公司内网");
  });

  it("收不到进度事件也不该拦住安装", async () => {
    listen.mockRejectedValueOnce(new Error("no event bus"));
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("weekly-report");
    await useInstall.getState().run();

    expect(useInstall.getState().phase).toBe("done");
  });

  it("从哪个源打开就装回哪个源:registryId 全程带着", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().begin("dept-skill", "custom-1");
    await useInstall.getState().run();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect(call?.[1].args.registryId).toBe("custom-1");
  });

  it("「我的技能」的更新按记账的来源走,不跟着商店当前浏览的源", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "installed_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().beginUpdate("dept-skill", ["claude-code"], "custom-1");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect(call?.[1].args.registryId).toBe("custom-1");
  });

  it("取消回到初始态,不留残余", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "agents_detected" ? AGENTS : null));
    await useInstall.getState().begin("weekly-report");
    useInstall.getState().cancel();

    const s = useInstall.getState();
    expect(s.phase).toBe("idle");
    expect(s.dirSlug).toBeNull();
    expect(s.precheck).toBeNull();
  });

  it("读不到已安装列表时,商店照常可用", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await useInstall.getState().refreshInstalled();
    expect(useInstall.getState().installed.size).toBe(0);
  });
});

describe("结果摘要", () => {
  it("结果文案给显示名,不给内部标识", () => {
    // "已启用到 claude-code、trae" 是给机器看的名字,用户看到的应该是 Claude Code、Trae
    const r = report({
      links: [{ dir: "/a", agents: ["claude-code", "trae"], result: { status: "linked", mode: "symlink" } }],
    });
    expect(linkedAgents(r, AGENTS.agents)).toEqual(["Claude Code", "Trae"]);
    // 认不出来的标识原样保留,不该整项丢掉
    expect(linkedAgents(r, [])).toEqual(["claude-code", "trae"]);
  });

  it("数出建链失败的目录", () => {
    const r = report({
      links: [
        { dir: "/a", agents: ["claude-code"], result: { status: "linked", mode: "symlink" } },
        { dir: "/b", agents: ["trae"], result: { status: "failed", error: { code: "FS_OCCUPIED", message: "位置已被占用" } } },
      ],
    });
    expect(failedLinks(r)).toBe(1);
    // 失败的那个不该出现在"已启用到 …"里
    expect(linkedAgents(r)).toEqual(["claude-code"]);
  });

  it("同一位置(无需建链)不算成功也不算失败", () => {
    const r = report({ links: [{ dir: "/a", agents: ["cursor"], result: { status: "sameLocation" } }] });
    expect(failedLinks(r)).toBe(0);
    expect(linkedAgents(r)).toEqual([]);
  });
});

describe("结果面板里逐条「在工具里启用」(安装当时没成的那些位置)", () => {
  beforeEach(() => {
    reset();
    useInstall.setState({
      phase: "done",
      dirSlug: "weekly-report",
      report: partiallyFailed(),
    });
  });

  /** `skill_set_agents` 的成功回复(结果按 agent 给,不按目录)。 */
  const setAgentsDone = (results: [string, unknown][]) => ({
    outcome: "done",
    homeBody: "/home/u/.agents/skills/weekly-report",
    canonical: { Ok: { kind: "unchanged" } },
    results,
    unlinked: [],
    unlinkFailed: [],
  });

  it("重试发的是这个技能的完整期望名单,不是这一条目录上那几个", async () => {
    // 🔴 `skill_set_agents` 收的是**完整期望态**:只传这一条目录上的 agents,
    // core 会把其余位置全部**停用掉**——重试一处等于关掉别处,那是数据损失。
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return setAgentsDone([["trae", { Ok: { kind: "linked", mode: "symlink" } }]]);
      return [];
    });

    await useInstall.getState().enableInTools("/home/u/.trae/skills");

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_set_agents");
    expect(call?.[1].args).toEqual({
      dirSlug: "weekly-report",
      agents: [...useInstall.getState().selected],
    });
    // 成功的这条并回 report,列表里就不再显示它了
    expect(failedLinks(useInstall.getState().report)).toBe(0);
  });

  it("只并回这一条,其余目录的结局不被覆盖", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return setAgentsDone([["trae", { Ok: { kind: "linked", mode: "symlink" } }]]);
      return [];
    });

    await useInstall.getState().enableInTools("/home/u/.trae/skills");

    const links = useInstall.getState().report?.links ?? [];
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.dir === "/home/u/.claude/skills")?.result.status).toBe("linked");
  });

  it("这一条上的 agent 失败了就仍算失败,错误摆出来", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return setAgentsDone([["trae", { Err: TOOL_DIR_ERROR }]]);
      return [];
    });

    await useInstall.getState().enableInTools("/home/u/.trae/skills");

    expect(useInstall.getState().enableError?.code).toBe(TOOL_DIR_ERROR.code);
    expect(failedLinks(useInstall.getState().report)).toBe(1);
  });

  it("别的目录上的 agent 失败不该算到这一条头上", async () => {
    // 空转防线:若实现忘了按 `entry.agents` 过滤,这条会把 claude-code 的失败
    // 算成 trae 那一行的失败,而 trae 其实成功了。
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return setAgentsDone([
          ["trae", { Ok: { kind: "linked", mode: "symlink" } }],
          ["claude-code", { Err: TOOL_DIR_ERROR }],
        ]);
      return [];
    });

    await useInstall.getState().enableInTools("/home/u/.trae/skills");

    expect(useInstall.getState().enableError).toBeNull();
    expect(failedLinks(useInstall.getState().report)).toBe(0);
  });

  it("core 说有几个版本:如实报出来,不装作重试成功了", async () => {
    // 结果面板没有拍板界面(那在「我的技能」页),所以这里只能把话说清楚。
    // 静默当成功的话,用户会以为配好了,而那个工具其实读不到。
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "skill_set_agents")
        return { outcome: "needsVersionChoice", versions: [] };
      return [];
    });

    await useInstall.getState().enableInTools("/home/u/.trae/skills");

    expect(useInstall.getState().enableError?.code).toBe("FS_NEEDS_VERSION_CHOICE");
    // 报告不该被改写成"成功了"
    expect(failedLinks(useInstall.getState().report)).toBe(1);
  });
});

describe("已装记账的来源坐标(M4 一源多仓)", () => {
  beforeEach(() => {
    invoke.mockReset();
    useInstall.setState({ installed: new Map() });
  });

  it("refreshInstalled 必须把来源坐标一起收进来", async () => {
    // 少了这三个字段,cardState 就拿不到"这是哪个技能库装的",判定会**静默**退回
    // M3 口径:切到同源的另一个技能库时,那边的同名技能被标成「更新」,而点下去是替换。
    // 别的测试都直接 setState 塞 map,走不到这条路——这里是它唯一的护栏。
    invoke.mockResolvedValueOnce([
      {
        dirSlug: "weekly-report",
        commitSha: "aaa1111",
        contentHash: "sha256:mine",
        agents: [],
        installedAt: "",
        updatedAt: "",
        localModified: false,
        // owner 与 repo 取不同值:弄反了要能看出来
        sourceOwner: "design",
        sourceRepo: "design-skills",
        registryId: "company",
        sourceRemoved: false,
        libraryRemoved: false,
        relation: "installed",
        localPresent: true,
        sourceLabel: "design/design-skills",
              links: [],
      },
    ]);

    await useInstall.getState().refreshInstalled();

    const record = useInstall.getState().installed.get("weekly-report");
    expect(record?.registryId).toBe("company");
    expect(record?.sourceOwner).toBe("design");
    expect(record?.sourceRepo).toBe("design-skills");
  });

  // 🔴 这三条测的是同一条规则的三种形状:**只有真正有 `state.installed` 记账的行
  // 才进 installed map**。判据是 `contentHash` 非空(记账基线),`installed_list`
  // 的另外两档都把它留空。对照组(有记账的行照常进)每条都带着——少了它,
  // 把过滤器写成"一个都不收"照样全绿。

  it("refreshInstalled 必须排除没有记账的本地目录(别的工具装的)", async () => {
    // 用户用 npx skills 装过 weekly-report,公司库里也有同名技能(作者是同事)。
    // 这一行 relation 是 installed、本体也在,但**没有 state.installed 记账**。
    // ⚠️ v7.6 起判定入口改成"问磁盘"(见 `lib/update.ts::cardState`),混进 map
    // 不再必然让按钮卡死在禁用态——localHash 与库里不同时反而会显示可点的
    // 「与库里不同」。这条过滤真正要挡的是:一份没有真实来源坐标、
    // contentHash 空串的**假记账**冒充"有记账"去参与 `otherLibrary` 判定——
    // 那类判定仍然会把空坐标/空基线当成"这条记账真实存在"来用,产生与实际
    // 归属不符的展示。
    invoke.mockResolvedValueOnce([
      recordedRow("from-library"),
      { ...row("npx-installed"), relation: "installed", localPresent: true },
    ]);

    await useInstall.getState().refreshInstalled();

    const map = useInstall.getState().installed;
    expect(map.has("from-library")).toBe(true);
    expect(map.has("npx-installed")).toBe(false);
  });

  it("refreshInstalled 必须排除草稿(relation === draft)", async () => {
    invoke.mockResolvedValueOnce([recordedRow("from-library"), { ...row("my-draft"), relation: "draft" }]);

    await useInstall.getState().refreshInstalled();

    const map = useInstall.getState().installed;
    expect(map.has("from-library")).toBe(true);
    expect(map.has("my-draft")).toBe(false);
  });

  it("refreshInstalled 必须排除「库里有、这台电脑没有本体」的行(localPresent === false)", async () => {
    invoke.mockResolvedValueOnce([
      recordedRow("from-library"),
      { ...row("not-here"), relation: "shared", localPresent: false },
    ]);

    await useInstall.getState().refreshInstalled();

    const map = useInstall.getState().installed;
    expect(map.has("from-library")).toBe(true);
    // 这台电脑上什么都没有,"已在电脑上"更是无从谈起
    expect(map.has("not-here")).toBe(false);
  });
});

describe("beginFromPlaza(技能广场安装编排,M9 任务 5)", () => {
  beforeEach(() => {
    reset();
    useRegistries.setState({ list: null, error: null, busy: false, loggedIn: {}, devicePrompt: null });
  });

  it("挂仓失败:不触发获取,直接进错误态", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "plaza_ensure_repo") {
        throw { code: "NET_PLAZA_REPO", message: "无法获取该技能库信息,请稍后重试" };
      }
      return null;
    });

    await useInstall.getState().beginFromPlaza("vercel-labs/skills", "react-best-practices");

    expect(useInstall.getState().phase).toBe("error");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "skill_install")).toBe(false);
  });

  it("挂仓成功后,确认安装带 registryId:plaza + 挂仓返回的寻址键", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "plaza_ensure_repo") {
        return {
          key: "vercel-labs/skills",
          owner: "vercel-labs",
          repo: "skills",
          branch: "main",
          name: null,
          primary: false,
          locked: false,
        };
      }
      if (cmd === "installed_list") return [];
      if (cmd === "registry_list") return [];
      return { outcome: "installed", report: report(), localKept: false, lock: "written" };
    });

    await useInstall.getState().beginFromPlaza("vercel-labs/skills", "react-best-practices");
    expect(useInstall.getState().phase).toBe("choosing");
    await useInstall.getState().run();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_install");
    expect(call?.[1].args.dirSlug).toBe("react-best-practices");
    expect(call?.[1].args.registryId).toBe("plaza");
    expect(call?.[1].args.repo).toBe("vercel-labs/skills");
    expect(useInstall.getState().phase).toBe("done");
  });

  it("挂仓成功后刷新技能库来源列表:切换器的已挂仓子条目才会出现(§2.4 徽标口径)", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "agents_detected") return AGENTS;
      if (cmd === "plaza_ensure_repo") {
        return {
          key: "vercel-labs/skills",
          owner: "vercel-labs",
          repo: "skills",
          branch: "main",
          name: null,
          primary: false,
          locked: false,
        };
      }
      if (cmd === "registry_list") {
        return [
          {
            id: "plaza",
            name: "技能广场",
            kind: "github",
            baseUrl: "https://github.com",
            builtin: false,
            repo: null,
            repos: [
              {
                key: "vercel-labs/skills",
                owner: "vercel-labs",
                repo: "skills",
                branch: "main",
                name: null,
                primary: false,
                locked: false,
              },
            ],
          },
        ];
      }
      return null;
    });

    await useInstall.getState().beginFromPlaza("vercel-labs/skills", "react-best-practices");

    await vi.waitFor(() => {
      expect(useRegistries.getState().list?.[0]?.repos).toHaveLength(1);
    });
  });

  it("挂仓探测还没回来那一刻,已经清掉上一次安装残留的 agents/selected(M9 终审修复)", () => {
    // 模拟上一次安装(哪怕是别的技能)残留下来的勾选状态——beginFromPlaza 之前
    // 这个 store 是同一个单例,不会自动清空。
    useInstall.setState({
      agents: [
        { name: "trae", displayName: "Trae", installed: true, globalSkillsDir: "~/.trae/skills", skillsDir: ".trae/skills", isUniversal: false, needsLink: true, disabled: false },
      ],
      selected: new Set(["trae"]),
    });
    // 挂住不 resolve:只关心 beginFromPlaza 第一个 set() 那一刻(任何 await 之前)
    // 的同步状态,不该等 agentsDetected/plazaEnsureRepo 回来才清空——晚清等于
    // 用户在这段等待期间看到一份不属于这次安装的 agent 列表,还可能是可点的。
    invoke.mockImplementation(() => new Promise(() => {}));

    void useInstall.getState().beginFromPlaza("vercel-labs/skills", "react-best-practices");

    expect(useInstall.getState().agents).toEqual([]);
    expect(useInstall.getState().selected.size).toBe(0);
    expect(useInstall.getState().repo).toBeNull();
    expect(useInstall.getState().phase).toBe("choosing");
  });
});

/// 真正有 `state.installed` 记账的一行:`contentHash` 有值(记账基线),来源坐标齐全。
/// 上面三条排除测试的对照组都用它。
function recordedRow(dirSlug: string) {
  return {
    ...row(dirSlug),
    commitSha: "aaa1111",
    contentHash: "sha256:recorded",
    registryId: "company",
    sourceOwner: "skills",
    sourceRepo: "skills",
  };
}

function row(dirSlug: string) {
  return {
        dirSlug,
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
        relation: "installed" as const,
        localPresent: true,
        sourceLabel: null,
              links: [],
  };
}
