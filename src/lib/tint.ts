// 技能图标:首字符 + 由名字算出的低饱和底色(UI 规范 §2.2,GitHub 组织头像式)。
// 全站禁 emoji、也没有远端图标资源,这是唯一的视觉识别手段。

/**
 * 取展示用首字符。中文取首字,拉丁字母大写。
 * 空名字给一个中性占位符而不是空白方块。
 */
export function skillGlyph(name: string): string {
  const first = Array.from(name.trim())[0];
  if (!first) return "·";
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

/**
 * 名字 → 色相(0-359)。同一个技能永远同色,换机器也一样(不依赖随机数)。
 * 具体的饱和度/亮度交给 CSS(`.skill-tint`),深浅主题各有一档,内联样式办不到。
 */
export function skillHue(name: string): number {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + ch.codePointAt(0)!) % 360_000;
  }
  return hash % 360;
}
