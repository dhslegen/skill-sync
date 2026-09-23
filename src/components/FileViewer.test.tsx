import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FileViewer } from "./FileViewer";
import { t } from "@/i18n";
import type { DiffHunk, FileContent } from "@/lib/ipc";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const MODE_GROUP = () => t("viewer.modeLabel");

describe("文件查看器:原文 / 渲染两态(v8 任务 10 / Q8)", () => {
  it("Markdown 默认是渲染态,并且有切换开关;切到原文看到的是源文本", async () => {
    render(
      <FileViewer
        path="docs/说明.md"
        body={{ kind: "content", content: { kind: "text", text: "# 大标题\n\n正文一段" } }}
      />,
    );
    // 渲染态:# 变成了标题,而不是一行字面的 "# 大标题"
    expect(screen.getByRole("heading", { name: "大标题" })).toBeInTheDocument();
    expect(screen.queryByText("# 大标题")).toBeNull();
    const group = screen.getByRole("group", { name: MODE_GROUP() });
    expect(group).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: t("viewer.modeRaw") }));
    expect(screen.getByText("# 大标题")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "大标题" })).toBeNull();
  });

  it("🔴 非 Markdown 不摆那个没意义的开关,直接是原文", () => {
    render(
      <FileViewer
        path="scripts/collect.py"
        body={{ kind: "content", content: { kind: "text", text: "# 注释\nprint(1)" } }}
      />,
    );
    // 正面断言开关**不存在**,而不是"看不见某个按钮"
    expect(screen.queryByRole("group", { name: MODE_GROUP() })).toBeNull();
    expect(screen.queryByRole("button", { name: t("viewer.modeRendered") })).toBeNull();
    expect(screen.getByText("# 注释")).toBeInTheDocument();
    expect(screen.getByText("print(1)")).toBeInTheDocument();
  });
});

/** 一处改动:新文件第 10 行起,上下各 3 行上下文(core 按 git -U3 口径给好的)。 */
const HUNK: DiffHunk = {
  oldStart: 7,
  oldLines: 7,
  newStart: 7,
  newLines: 7,
  lines: [
    { op: "context", text: "第 7 行" },
    { op: "context", text: "第 8 行" },
    { op: "context", text: "第 9 行" },
    { op: "delete", text: "旧的第 10 行" },
    { op: "insert", text: "新的第 10 行" },
    { op: "context", text: "第 11 行" },
    { op: "context", text: "第 12 行" },
    { op: "context", text: "第 13 行" },
  ],
};

const fullNew = Array.from({ length: 20 }, (_, i) =>
  i === 9 ? "新的第 10 行" : `第 ${i + 1} 行`,
).join("\n");

describe("文件查看器:差异态(Q1 / Q2 / Q9)", () => {
  it("默认折叠成改动处上下各 3 行;切到全文才看得到离改动远的那几行", async () => {
    const readFull = vi.fn(async (): Promise<FileContent> => ({ kind: "text", text: fullNew }));
    render(
      <FileViewer
        path="notes.txt"
        body={{ kind: "diff", diff: { kind: "hunks", hunks: [HUNK], hiddenHunks: 0 }, readFull }}
      />,
    );
    expect(screen.getByText("旧的第 10 行")).toBeInTheDocument();
    expect(screen.getByText("新的第 10 行")).toBeInTheDocument();
    expect(screen.getByText("第 7 行")).toBeInTheDocument();
    // 折叠:离改动超过 3 行的内容不在屏上
    expect(screen.queryByText("第 1 行")).toBeNull();
    expect(screen.queryByText("第 20 行")).toBeNull();
    // 按需读:还没切到全文就一次都不读
    expect(readFull).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: t("viewer.modeFull") }));
    expect(await screen.findByText("第 1 行")).toBeInTheDocument();
    expect(screen.getByText("第 20 行")).toBeInTheDocument();
    expect(readFull).toHaveBeenCalledTimes(1);
  });

  it("hiddenHunks > 0 时说清还有几处没显示", () => {
    render(
      <FileViewer
        path="notes.txt"
        body={{
          kind: "diff",
          diff: { kind: "hunks", hunks: [HUNK], hiddenHunks: 12 },
          readFull: async () => ({ kind: "text", text: "" }),
        }}
      />,
    );
    expect(screen.getByText("还有 12 处改动没有显示。")).toBeInTheDocument();
  });

  it("没有被藏起来的改动时不摆那句话", () => {
    render(
      <FileViewer
        path="notes.txt"
        body={{
          kind: "diff",
          diff: { kind: "hunks", hunks: [HUNK], hiddenHunks: 0 },
          readFull: async () => ({ kind: "text", text: "" }),
        }}
      />,
    );
    expect(screen.queryByText(/处改动没有显示/)).toBeNull();
  });
});

describe("文件查看器:看不了内容的四档说明(断言文案本身)", () => {
  it("🔴 二进制:只说不是文本格式,不编造它是图片或压缩包", () => {
    const { container } = render(
      <FileViewer path="logo.png" body={{ kind: "content", content: { kind: "binary" } }} />,
    );
    expect(screen.getByText("这不是文本格式,看不了内容。")).toBeInTheDocument();
    // UTF-16 文本也落在这一档——说"图片/压缩包"就是在编造事实
    expect(container.textContent).not.toMatch(/图片|压缩包/);
  });

  it("二进制那句在差异态里也是同一句", () => {
    render(
      <FileViewer
        path="logo.png"
        body={{ kind: "diff", diff: { kind: "binary" }, readFull: async () => ({ kind: "binary" }) }}
      />,
    );
    expect(screen.getByText("这不是文本格式,看不了内容。")).toBeInTheDocument();
  });

  it("超限:说清是大小超了,带实际大小", () => {
    render(
      <FileViewer
        path="big.md"
        body={{
          kind: "content",
          content: { kind: "tooLarge", limit: "bytes", bytes: 300 * 1024, lines: 40 },
        }}
      />,
    );
    expect(
      screen.getByText("这个文件有 300.0 KB,超过了 256 KB 的显示上限,看不了内容。"),
    ).toBeInTheDocument();
  });

  it("超限:单个版本说清是行数超了,带实际行数", () => {
    render(
      <FileViewer
        path="long.txt"
        body={{
          kind: "content",
          content: { kind: "tooLarge", limit: "lines", bytes: 9000, lines: 3500 },
        }}
      />,
    );
    expect(
      screen.getByText("这个文件有 3500 行,超过了 2000 行的显示上限,看不了内容。"),
    ).toBeInTheDocument();
  });

  // 🔴 定向复审 M-4:差异那一档的数字是**两版各自的最大值**,可能来自不同的两侧。
  // 用户把库里 300 KB 的文件删减成 1 KB 时,说「这个文件有 300 KB」是假话;`both`
  // 档还会把旧版的大小和新版的行数拼成一句。所以差异这一档不说数字、不点名哪一版。
  it("超限(差异):只说改动前后有一版超了,不报一个可能属于另一版的数字", () => {
    render(
      <FileViewer
        path="long.txt"
        body={{
          kind: "diff",
          diff: { kind: "tooLarge", limit: "lines", bytes: 9000, lines: 3500 },
          readFull: async () => ({ kind: "text", text: "" }),
        }}
      />,
    );
    expect(screen.getByText(t("viewer.diffTooLargeLines"))).toBeInTheDocument();
    expect(screen.queryByText(/3500/)).toBeNull();
  });

  it("超限(差异)两条都超:不把旧版的大小与新版的行数拼成一句", () => {
    render(
      <FileViewer
        path="huge.txt"
        body={{
          kind: "diff",
          diff: { kind: "tooLarge", limit: "both", bytes: 300 * 1024, lines: 3500 },
          readFull: async () => ({ kind: "text", text: "" }),
        }}
      />,
    );
    expect(screen.getByText(t("viewer.diffTooLargeBoth"))).toBeInTheDocument();
    expect(screen.queryByText(/300\.0 KB|3500/)).toBeNull();
  });

  it("超限:两条都超时两个数都说", () => {
    render(
      <FileViewer
        path="huge.txt"
        body={{
          kind: "content",
          content: { kind: "tooLarge", limit: "both", bytes: 2 * 1024 * 1024, lines: 9000 },
        }}
      />,
    );
    expect(
      screen.getByText(
        "这个文件有 2.0 MB、9000 行,超过了 256 KB 与 2000 行的显示上限,看不了内容。",
      ),
    ).toBeInTheDocument();
  });

  it("只有行尾不同:明说,不摆一屏假改动", () => {
    render(
      <FileViewer
        path="SKILL.md"
        body={{
          kind: "diff",
          diff: { kind: "lineEndingsOnly" },
          readFull: async () => ({ kind: "text", text: "" }),
        }}
      />,
    );
    expect(screen.getByText("两份内容只有行尾的换行符不同。")).toBeInTheDocument();
  });

  it("来源看不了:明说是这个来源的事", () => {
    render(<FileViewer path="SKILL.md" body={{ kind: "content", content: { kind: "unavailable" } }} />);
    expect(screen.getByText("这个来源看不了文件内容。")).toBeInTheDocument();
  });
});

describe("文件查看器:按需读取的加载与失败", () => {
  it("读取中说的是这一个文件;读到了就换成内容", async () => {
    let resolve!: (c: FileContent) => void;
    const read = vi.fn(
      () =>
        new Promise<FileContent>((r) => {
          resolve = r;
        }),
    );
    render(<FileViewer path="a.txt" body={{ kind: "read", read }} />);
    expect(screen.getByText("正在读取「a.txt」…")).toBeInTheDocument();
    resolve({ kind: "text", text: "你好" });
    expect(await screen.findByText("你好")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("🔴 读取失败时点名这一个文件,并带上原因", async () => {
    const read = vi.fn(async (): Promise<FileContent> => {
      throw { code: "FS_READ", message: "磁盘读不出来" };
    });
    render(<FileViewer path="templates/dept.md" body={{ kind: "read", read }} />);
    expect(await screen.findByText(/读取「templates\/dept\.md」失败/)).toBeInTheDocument();
    expect(screen.getByText(/磁盘读不出来/)).toBeInTheDocument();
  });

  it("空文件如实说是空的,而不是一片空白", async () => {
    render(<FileViewer path="empty.txt" body={{ kind: "content", content: { kind: "text", text: "" } }} />);
    await waitFor(() => expect(screen.getByText("这个文件是空的。")).toBeInTheDocument());
  });
});
