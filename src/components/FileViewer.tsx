import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/Markdown";
import { t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { isAppError, type DiffHunk, type FileContent, type FileDiff, type SizeLimit } from "@/lib/ipc";
import { isMarkdownPath, stripFrontmatter } from "@/lib/markdown";

/**
 * 查看器要显示的东西(v8 任务 10 / 设计 Q5:三处宿主共用这一个组件)。
 *
 * - `content`:内容已经在手上(删除文件的库里那一版、二进制标记、宿主提前判定的「看不了」);
 * - `read`:内容按需读——**挂载时**读一次(详情页点开的文件、确认屏里新增的文件);
 * - `diff`:两版之间的差异(确认屏里修改的文件)。`readFull` 是「全文」那一态的按需读,
 *   用户不切过去就一次都不读(设计 Q3「点开哪个拉哪个,不预取」)。
 *
 * 🔴 **这个组件不发 IPC**:取数函数由宿主带进来,宿主知道"这个文件从哪来"
 * (本地盘 / 技能库那一版 / 广场快照),查看器只管"怎么摆"。
 */
export type FileViewerBody =
  | { kind: "content"; content: FileContent }
  | { kind: "read"; read: () => Promise<FileContent> }
  | { kind: "diff"; diff: FileDiff; readFull: () => Promise<FileContent> };

type Mode = "diff" | "rendered" | "raw";

type Load =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; content: FileContent }
  | { status: "error"; message: string };

/**
 * 共用的文件查看器:**原文 / 渲染 / 差异**三态。
 *
 * # 🔴 宿主必须按"哪个技能的哪个文件"给它 `key`
 *
 * 加载态与失败态都活在这个实例里。换了文件还复用同一个实例的话,上一个文件的
 * "读取失败"就会挂在下一个文件上(v7 任务 6 的"跨技能状态泄漏"同一个病)。
 * 取数函数也只在挂载时取一次(`useState` 惰性初值),所以同一个 key 下它不会变。
 *
 * # 默认态
 *
 * 有差异就先看差异(用户点开的理由就是"改了什么");否则 Markdown 默认渲染(设计 Q8),
 * 其余直接原文。🔴 **只有 Markdown 才出「渲染 / 原文」开关**——非 Markdown 摆一个
 * 切换开关是噪音。差异态的「全文」(设计 Q2「只看新内容」)是另一回事:core 只给了
 * 改动处上下各 3 行,想看整份就得按需读新的那一版,所以差异那一档总有开关。
 */
export function FileViewer({ path, body }: { path: string; body: FileViewerBody }) {
  const md = isMarkdownPath(path);
  const hasHunks = body.kind === "diff" && body.diff.kind === "hunks";
  const modes: Mode[] = hasHunks
    ? ["diff", ...(md ? (["rendered"] as const) : []), "raw"]
    : body.kind === "diff"
      ? []
      : md
        ? ["rendered", "raw"]
        : [];
  const [mode, setMode] = useState<Mode>(body.kind === "diff" ? "diff" : md ? "rendered" : "raw");
  // 惰性初值:只认挂载那一刻的取数函数(宿主每次渲染都会造一个新闭包)
  const [reader] = useState<(() => Promise<FileContent>) | null>(() =>
    body.kind === "read" ? body.read : body.kind === "diff" ? body.readFull : null,
  );
  const active = body.kind === "read" || (hasHunks && mode !== "diff");
  const load = useLazyContent(active, reader);

  return (
    <div>
      {modes.length > 0 && (
        <div
          role="group"
          aria-label={t("viewer.modeLabel")}
          className="mb-2 inline-flex gap-px rounded-ctl border border-border p-px"
        >
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-[5px] px-2 py-[2px] text-[11.5px] font-medium",
                mode === m ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-3 hover:text-text",
              )}
            >
              {t(modeLabel(m, body.kind === "diff"))}
            </button>
          ))}
        </div>
      )}

      {body.kind === "diff" && mode === "diff" ? (
        <DiffView diff={body.diff} />
      ) : body.kind === "content" ? (
        <ContentView content={body.content} rendered={mode === "rendered"} />
      ) : (
        <LoadedView path={path} load={load} rendered={mode === "rendered"} />
      )}
    </div>
  );
}

function modeLabel(mode: Mode, inDiff: boolean): MessageKey {
  switch (mode) {
    case "diff":
      return "viewer.modeDiff";
    case "rendered":
      return "viewer.modeRendered";
    case "raw":
      // 差异态里这一档是「新的那一版的全文」,叫「原文」会让人以为是改之前那一版
      return inDiff ? "viewer.modeFull" : "viewer.modeRaw";
  }
}

/**
 * `active` 第一次为真时读一次,之后结果留在实例里(来回切换不重读)。
 *
 * 用 ref 记"已经开始读了"而不是看 `status`:把 `status` 放进依赖的话,置成
 * `loading` 那一下就会触发 effect 清理,把正在飞的那次请求当成过期丢掉。
 * 卸载后才回来的结果不需要拦:实例按文件 key,卸载了就不会再渲染它。
 */
function useLazyContent(active: boolean, reader: (() => Promise<FileContent>) | null): Load {
  const [load, setLoad] = useState<Load>({ status: "idle" });
  const started = useRef(false);
  useEffect(() => {
    if (!active || !reader || started.current) return;
    started.current = true;
    setLoad({ status: "loading" });
    reader().then(
      (content) => setLoad({ status: "ready", content }),
      (raw: unknown) =>
        setLoad({ status: "error", message: isAppError(raw) ? raw.message : t("error.generic") }),
    );
  }, [active, reader]);
  return load;
}

function LoadedView({ path, load, rendered }: { path: string; load: Load; rendered: boolean }) {
  if (load.status === "ready") return <ContentView content={load.content} rendered={rendered} />;
  if (load.status === "error") {
    // 🔴 点名**这一个文件**:同一屏上可能展开着好几个文件,只说"读取失败"
    // 用户分不出是哪一个。
    return (
      <p className="text-[12px] leading-[1.6] text-[#c0392b] dark:text-[#e0705f]">
        {t("viewer.readFailed", { file: path })}
        {t("punct.labelSeparator")}
        {load.message}
      </p>
    );
  }
  return <Note>{t("viewer.loading", { file: path })}</Note>;
}

function ContentView({ content, rendered }: { content: FileContent; rendered: boolean }) {
  switch (content.kind) {
    case "text":
      if (content.text.trim() === "") return <Note>{t("viewer.empty")}</Note>;
      return rendered ? (
        <Markdown source={stripFrontmatter(content.text)} />
      ) : (
        <RawLines text={content.text} />
      );
    case "binary":
      return <Note>{t("viewer.binary")}</Note>;
    case "tooLarge":
      return <Note>{tooLargeText(content.limit, content.bytes, content.lines)}</Note>;
    case "unavailable":
      return <Note>{t("viewer.unavailable")}</Note>;
  }
}

function DiffView({ diff }: { diff: FileDiff }) {
  switch (diff.kind) {
    case "hunks":
      return (
        <>
          {/* `hunks` 在 core 里恒非空:归一化后相同走 `lineEndingsOnly`,不同则至少一处 */}
          <div className="overflow-hidden rounded-card border border-border font-mono text-[11.5px] leading-[1.6]">
            {diff.hunks.map((hunk, i) => (
              <HunkRows key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} separated={i > 0} />
            ))}
          </div>
          {diff.hiddenHunks > 0 && (
            <p className="mt-1.5 text-[12px] leading-[1.6] text-text-3">
              {t("viewer.hiddenHunks", { count: diff.hiddenHunks })}
            </p>
          )}
        </>
      );
    case "lineEndingsOnly":
      return <Note>{t("viewer.lineEndingsOnly")}</Note>;
    case "binary":
      return <Note>{t("viewer.binary")}</Note>;
    case "tooLarge":
      return <Note>{diffTooLargeText(diff.limit)}</Note>;
  }
}

/**
 * 一处改动。两列行号(旧 / 新)+ 前缀符号 + 正文。加减行只换底色,另有 +/- 前缀,
 * 不单靠颜色区分(色弱用户同样读得出来)。处与处之间画一条「…」分隔,表示中间
 * 有没改动的内容被折叠掉了(设计 Q9:只给上下各 3 行)。
 */
function HunkRows({ hunk, separated }: { hunk: DiffHunk; separated: boolean }) {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  const rows = hunk.lines.map((line, i) => {
    const oldShown = line.op === "insert" ? "" : String(oldNo++);
    const newShown = line.op === "delete" ? "" : String(newNo++);
    return (
      <div
        key={i}
        className={cn(
          "flex",
          line.op === "insert" && "bg-diff-add",
          line.op === "delete" && "bg-diff-del",
        )}
      >
        <LineNo>{oldShown}</LineNo>
        <LineNo>{newShown}</LineNo>
        <span aria-hidden className="w-[1.4em] shrink-0 select-none text-center text-text-3">
          {line.op === "insert" ? "+" : line.op === "delete" ? "-" : " "}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 text-text">
          {line.text || " "}
        </span>
      </div>
    );
  });
  return (
    <>
      {separated && (
        <div aria-hidden className="border-y border-border bg-surface-2 px-2 text-text-3">
          …
        </div>
      )}
      {rows}
    </>
  );
}

function RawLines({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  // 末尾那个换行符不算新的一行(与 core `count_lines` 同一口径)
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return (
    <div className="overflow-hidden rounded-card border border-border font-mono text-[11.5px] leading-[1.6]">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <LineNo>{String(i + 1)}</LineNo>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all px-2 text-text">
            {line || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function LineNo({ children }: { children: string }) {
  return (
    <span className="w-[3.2em] shrink-0 select-none bg-surface-2 pr-1.5 text-right text-text-3">
      {children}
    </span>
  );
}

function Note({ children }: { children: string }) {
  return <p className="text-[12px] leading-[1.6] text-text-3">{children}</p>;
}

/**
 * 差异那一档的超限说法(定向复审 M-4)。**不带数字**:core 给的 `bytes`/`lines`
 * 是两版各自的最大值,可能一个来自旧版、一个来自新版——说「这个文件有 300 KB」
 * 对一个删减到 1 KB 的文件是假话,`both` 档还会把旧版的大小和新版的行数拼成一句。
 * 只说"改动前后有一版超过了",哪一版不点名,这句话才是真的。
 */
function diffTooLargeText(limit: SizeLimit): string {
  switch (limit) {
    case "bytes":
      return t("viewer.diffTooLargeBytes");
    case "lines":
      return t("viewer.diffTooLargeLines");
    case "both":
      return t("viewer.diffTooLargeBoth");
  }
}

/** 说清是**哪条**超了,并带上实测值(设计 Q4 / Q12)。只用于**单个版本**的内容。 */
function tooLargeText(limit: SizeLimit, bytes: number, lines: number): string {
  const size = formatBytes(bytes);
  switch (limit) {
    case "bytes":
      return t("viewer.tooLargeBytes", { size });
    case "lines":
      return t("viewer.tooLargeLines", { lines });
    case "both":
      return t("viewer.tooLargeBoth", { size, lines });
  }
}
