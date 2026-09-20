import type { AddedFile, DeletedFile, ModifiedFile, SharePlan } from "@/lib/ipc";

/**
 * 测试用的分享清单构造器(v8 任务 8)。
 *
 * 清单三档自这一期起每一项都带内容标记(新增只有标记、修改带 hunk、
 * 删除带库里那一版的正文),而**绝大多数既有用例只关心"有哪些文件"**
 * ——它们测的是确认屏的渲染与两轮凭据的传递,不是 diff 本身。
 *
 * 🔴 **这里给的是"最普通的那一档"**:文本、有内容、没超限。要测二进制、
 * 超限、只有行尾不同这几档的用例,请**自己写出那个字面量**——把它们也藏进
 * 构造器里,读用例的人就看不出这条用例到底在测哪一档了。
 */
export const addedFile = (path: string): AddedFile => ({ path, body: { kind: "text" } });

export const modifiedFile = (path: string): ModifiedFile => ({
  path,
  diff: { kind: "hunks", hunks: [], hiddenHunks: 0 },
});

export const deletedFile = (path: string): DeletedFile => ({
  path,
  body: { kind: "text", text: "库里那一版的内容" },
});

/** 按三组路径拼一份清单。 */
export const planOf = (files: {
  added?: string[];
  modified?: string[];
  deleted?: string[];
}): SharePlan => ({
  added: (files.added ?? []).map(addedFile),
  modified: (files.modified ?? []).map(modifiedFile),
  deleted: (files.deleted ?? []).map(deletedFile),
});
