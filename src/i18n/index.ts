// 用户可见文案统一走 i18n 资源(架构铁律 6),严禁在组件里写死中文文案。
// M1 仅 zh-CN 一种语言,保持最小实现;后续扩语言时在此挂语言切换。
import zhCN from "./zh-CN.json";

type MessageKey = keyof typeof zhCN;

const messages: Record<MessageKey, string> = zhCN;

export type MessageParams = Record<string, string | number>;

/**
 * 取文案。`{name}` 占位符按 params 替换;缺的占位符原样保留(开发期显眼暴露)。
 * key 不存在时返回 key 本身,不抛错阻断渲染。
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const raw: string = messages[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export type { MessageKey };
