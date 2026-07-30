import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";

/**
 * 渲染 SKILL.md。
 *
 * 技能内容来自技能库,属**不可信输入**:react-markdown 默认不渲染裸 HTML,
 * 这里也刻意不引 rehype-raw——否则一份 SKILL.md 就能往界面里塞任意标记。
 *
 * 链接一律交给系统浏览器,且只放行 http/https。webview 内部导航会把整个应用
 * 顶掉换成外部页面,那是桌面应用里最难恢复的一种状态。
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      <ReactMarkdown
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
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
