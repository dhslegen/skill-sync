/**
 * 技能文件夹名(slug)的口径,前端侧。
 *
 * 判据是 Rust 的 `sanitize_name` **不动点**:填什么就得到什么。用户在表单里亲手填的
 * 名字被悄悄改成别的,是这个项目最忌讳的一类行为——所以放行条件不是"看起来像 kebab",
 * 而是"清洗它等于它自己"。
 *
 * 这里与 core 的 `create::usable_slug` 是同一把尺子,两侧各有一条测试断言与
 * `fixtures/slug-samples.json` 一致(那份 fixture 是唯一真相)。
 *
 * 曾经的实现是 `/^[a-z0-9][a-z0-9._-]*$/`,它**已经不准**:放行 `a--b`(清洗后折成
 * `a-b`)、`trail-`(尾部横线被 trim 成 `trail`)、超 255 字符(截断)。
 */

/** `sanitize_name` 的截断上限,与 core/skills.rs 的 `MAX_NAME_LEN` 对齐。 */
const MAX_NAME_LEN = 255;

/** 清洗后信息全丢时的哨兵值。它自己不能当名字用,否则两个技能会撞进同一目录。 */
const UNNAMED = "unnamed-skill";

export function validSlug(s: string): boolean {
  if (s === "" || s === UNNAMED || s.length > MAX_NAME_LEN) return false;
  // 白名单外的字符都会被替换成短横线
  if (!/^[a-z0-9._-]+$/.test(s)) return false;
  // 短横线本身不在白名单里,连续的会被折成一个
  if (s.includes("--")) return false;
  // 首尾的点与短横线会被 trim 掉
  if (/^[.-]/.test(s) || /[.-]$/.test(s)) return false;
  return true;
}
