import { beforeEach, describe, expect, it, vi } from "vitest";

import { useShare, validShareName } from "./share";
import { useStoreIndex } from "@/store/store-index";
import type { ShareCandidate } from "@/lib/ipc";

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

const SHARED_OK = {
  outcome: "shared",
  mode: "pushed",
  commitSha: "newsha",
  reviewUrl: null,
  adopted: false,
  shareName: "my-notes",
};

function reset() {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "share_candidates") return [];
    return null;
  });
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
    targetRepo: null,
    preview: "unknown",
  });
}

describe("分享名称校验", () => {
  it("与 core 的 sanitize 同一口径", () => {
    expect(validShareName("my-notes")).toBe(true);
    expect(validShareName("周报")).toBe(false);
    expect(validShareName("My-Notes")).toBe(false);
    expect(validShareName("")).toBe(false);
    expect(validShareName("unnamed-skill")).toBe(false);
  });
});

describe("分享流程状态机", () => {
  beforeEach(reset);

  it("begin 预填表单;目录名可用时直接作为分享名", () => {
    useShare.getState().begin(candidate());
    const s = useShare.getState();
    expect(s.phase).toBe("form");
    expect(s.form).toEqual({
      shareName: "my-notes",
      displayName: "我的笔记",
      description: "记点东西",
    });
  });

  it("中文目录名不预填分享名 —— 逼用户起英文名,而不是替他猜", () => {
    useShare.getState().begin(candidate({ dirName: "周报生成器", dirNameUsable: false }));
    expect(useShare.getState().form.shareName).toBe("");
  });

  it("再推沿用上次的远端名", () => {
    useShare.getState().begin(
      candidate({ shared: { upToDate: false, shareName: "notes-zhang" } }),
    );
    expect(useShare.getState().form.shareName).toBe("notes-zhang");
  });

  it("首次提交不带 overwrite;表单值没改就不传,core 才不会动 SKILL.md", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share") return SHARED_OK;
      if (cmd === "share_candidates") return [];
      return null;
    });
    useShare.getState().begin(candidate());
    await useShare.getState().submit();

    const call = invoke.mock.calls.find(([cmd]) => cmd === "skill_share");
    const sent = call?.[1].args;
    expect(sent.overwrite).toBe(false);
    expect(sent.displayName).toBeUndefined();
    expect(sent.description).toBeUndefined();
    expect(sent.origin).toBe("local");
    expect(useShare.getState().phase).toBe("done");
  });

  it("表单改过的字段才传给 core", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "skill_share" ? SHARED_OK : [],
    );
    useShare.getState().begin(candidate());
    useShare.getState().setForm({ description: "补上的描述" });
    await useShare.getState().submit();

    const sent = invoke.mock.calls.find(([cmd]) => cmd === "skill_share")?.[1].args;
    expect(sent.displayName).toBeUndefined();
    expect(sent.description).toBe("补上的描述");
  });

  it("同名被占:停在三选弹窗,不自作主张覆盖", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "skill_share"
        ? { outcome: "needsDecision", precheck: { status: "taken" } }
        : [],
    );
    useShare.getState().begin(candidate());
    await useShare.getState().submit();

    expect(useShare.getState().phase).toBe("taken");
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "skill_share")).toHaveLength(1);
  });

  it("弹窗里选覆盖才带 overwrite 重试", async () => {
    let calls = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "skill_share") return [];
      calls += 1;
      return calls === 1
        ? { outcome: "needsDecision", precheck: { status: "taken" } }
        : SHARED_OK;
    });
    useShare.getState().begin(candidate());
    await useShare.getState().submit();
    await useShare.getState().submit(true);

    const second = invoke.mock.calls.filter(([cmd]) => cmd === "skill_share")[1];
    expect(second?.[1].args.overwrite).toBe(true);
    expect(useShare.getState().phase).toBe("done");
  });

  it("提交瞬间被人抢先(CONFLICT_STALE)→ 回到表单并提示重新确认", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share")
        throw { code: "CONFLICT_STALE", message: "这个技能在你操作期间被其他人改过了,请重新确认后再提交" };
      return [];
    });
    useShare.getState().begin(candidate());
    await useShare.getState().submit();

    const s = useShare.getState();
    expect(s.phase).toBe("form");
    expect(s.staleNotice).toBe(true);
    expect(s.shareError).toBeNull();
  });

  it("其他失败:留在表单并给可读错误", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share")
        throw { code: "AUTH_REQUIRED", message: "分享前请先登录公司技能库" };
      return [];
    });
    useShare.getState().begin(candidate());
    await useShare.getState().submit();

    const s = useShare.getState();
    expect(s.phase).toBe("form");
    expect(s.shareError?.message).toContain("登录");
  });

  it("分享成功后重新扫描,列表状态才跟得上", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "skill_share") return SHARED_OK;
      if (cmd === "share_candidates")
        return [candidate({ shared: { upToDate: true, shareName: "my-notes" } })];
      return null;
    });
    useShare.getState().begin(candidate());
    await useShare.getState().submit();

    expect(useShare.getState().candidates?.[0].shared?.upToDate).toBe(true);
  });

  it("分享成功后还要刷新商店索引与已装记账,不只刷本页", async () => {
    // 2026-08-03 用户实测:分享完界面到处都是旧的——新技能在商店里看不到,
    // 卡片状态机也没跟上。三处一起刷才算刷完。
    const cmds: string[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd === "skill_share") return SHARED_OK;
      if (cmd === "share_candidates") return [];
      if (cmd === "store_index") return null;
      if (cmd === "installed_list") return [];
      return null;
    });
    useShare.getState().begin(candidate());
    await useShare.getState().submit();
    await vi.waitFor(() => {
      expect(cmds).toContain("store_index");
      expect(cmds).toContain("installed_list");
    });
    // 必须是强制刷新:不带 force 会命中缓存,刚分享的技能仍然看不见
    const call = invoke.mock.calls.find(([c]) => c === "store_index");
    expect(call![1].args.force).toBe(true);
  });

  it("「看看对方的版本」打开商店详情", () => {
    const openDetail = vi.fn(async () => {});
    useStoreIndex.setState({ openDetail });
    useShare.getState().begin(candidate());
    useShare.setState({ phase: "taken" });

    useShare.getState().viewTheirs();

    expect(openDetail).toHaveBeenCalledWith("my-notes");
    expect(useShare.getState().phase).toBe("form");
  });

  it("扫描失败保留上次列表并报错", async () => {
    useShare.setState({ candidates: [candidate()] });
    invoke.mockRejectedValue({ code: "FS_TASK", message: "扫描本地技能失败,请重试" });

    await useShare.getState().load();

    const s = useShare.getState();
    expect(s.scanError?.message).toContain("失败");
    expect(s.candidates).toHaveLength(1);
  });
});
describe("分享路径预告与目标库(M4 任务 2)", () => {
  beforeEach(reset);

  it("load 顺带探一次路径,主库时不带 repo 参数", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "share_candidates") return [];
      if (cmd === "share_preview") return "reviewInRepo";
      return null;
    });

    await useShare.getState().load();

    expect(invoke).toHaveBeenCalledWith("share_preview", { args: {} });
    expect(useShare.getState().preview).toBe("reviewInRepo");
  });

  it("切目标库:带上仓库键重探,并先清掉上一个库的预告", async () => {
    useShare.setState({ preview: "directPush" });
    let resolvePreview!: (v: unknown) => void;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "share_preview")
        return new Promise((resolve) => {
          resolvePreview = resolve;
        });
      return null;
    });

    const done = useShare.getState().setTargetRepo("design/design-skills");
    // 还没拿到新结果时,绝不能挂着主库的"直接生效"
    expect(useShare.getState().preview).toBe("unknown");
    expect(useShare.getState().targetRepo).toBe("design/design-skills");

    resolvePreview("reviewViaCopy");
    await done;
    expect(invoke).toHaveBeenCalledWith("share_preview", {
      args: { repo: "design/design-skills" },
    });
    expect(useShare.getState().preview).toBe("reviewViaCopy");
  });

  it("预告失败不亮错误、不拦分享:只是没有预告", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "share_candidates") return [];
      if (cmd === "share_preview") throw { code: "NET_UNREACHABLE", message: "连不上" };
      return null;
    });

    await useShare.getState().load();

    const s = useShare.getState();
    expect(s.preview).toBe("unknown");
    expect(s.scanError).toBeNull();
    expect(s.shareError).toBeNull();
    // 候选照常拿到,表单流程一步不受影响
    expect(s.candidates).toEqual([]);
  });

  it("提交时把目标库原样带上,缺省会推到主库", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "share_candidates") return [];
      if (cmd === "share_preview") return "unknown";
      if (cmd === "skill_share")
        return { outcome: "shared", mode: "pushed", commitSha: "a", reviewUrl: null, adopted: false, shareName: "my-notes" };
      return null;
    });
    useShare.setState({ targetRepo: "design/design-skills" });
    useShare.getState().begin(candidate());

    await useShare.getState().submit();

    const sent = invoke.mock.calls.find(([cmd]) => cmd === "skill_share")?.[1].args;
    expect(sent.repo).toBe("design/design-skills");
  });

  it("等待期间又切了库:迟到的结果不冒充当前库", async () => {
    const pending: ((v: unknown) => void)[] = [];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "share_preview") return new Promise((resolve) => pending.push(resolve));
      return null;
    });

    const first = useShare.getState().setTargetRepo("a/one");
    const second = useShare.getState().setTargetRepo("b/two");
    // 先回来的是第一个库的结果
    pending[0]("directPush");
    pending[1]("reviewViaCopy");
    await Promise.all([first, second]);

    expect(useShare.getState().targetRepo).toBe("b/two");
    expect(useShare.getState().preview).toBe("reviewViaCopy");
  });
});
