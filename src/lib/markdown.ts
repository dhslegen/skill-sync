/**
 * 渲染正文时去掉 frontmatter。
 *
 * 缓存里存的是 SKILL.md 全文(详情要能离线打开),而 frontmatter 是给机器看的元数据,
 * 直接渲染会在正文顶部露出一段 `name:`/`description:`。
 *
 * v8 任务 10 起从 `DetailPanel` 挪到这里:文件查看器(`FileViewer`)的渲染态也要用它,
 * 而 `DetailPanel` 反过来要引用 `FileViewer`——留在组件文件里就是一个循环依赖。
 */
export function stripFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

/**
 * 这个文件是不是 Markdown(按扩展名)。只有它在查看器里才有「渲染 / 原文」两态
 * ——非 Markdown 文件摆一个切换开关是噪音(设计 Q8)。
 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
