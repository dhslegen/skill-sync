import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 渲染 SKILL.md。
 *
 * 技能内容来自技能库,属**不可信输入**:react-markdown 默认不渲染裸 HTML,
 * 这里也刻意不引 rehype-raw——否则一份 SKILL.md 就能往界面里塞任意标记。
 * remark-gfm 只是在 CommonMark 之上多认几种**语法**(表格 / 删除线 / 任务列表 /
 * 自动链接 / 脚注),不产出 HTML 节点、不改变"技能内容是不可信输入"这条前提
 * ——上面这条安全约束依然只由 react-markdown 本身的默认行为兜底。
 *
 * 链接一律交给系统浏览器,且只放行 http/https。webview 内部导航会把整个应用
 * 顶掉换成外部页面,那是桌面应用里最难恢复的一种状态。
 * GFM 的自动链接会把裸 URL 转成 `<a>`,这条规则同样适用——`mailto:` 与脚注锚点
 * 会变成点了没反应的死链,方向偏保守(不会把应用导航出去),可接受。
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//i.test(href)) void openUrl(href).catch(() => {});
              }}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="md-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
