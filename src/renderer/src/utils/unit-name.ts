/**
 * 完整单位名（issue #3）：单位信息由两部分组成——
 *   第一部分 parentUnitName（一级单位/学校，二级单位的分组）+ 第二部分 name（二级独立单位）。
 * 二者合在一起才是完整单位信息；缺一级（旧配置/回退）时仅显示二级。
 */
export function fullUnitName(u: { name?: string; parentUnitName?: string } | null | undefined): string {
  if (!u) return ''
  const name = u.name ?? ''
  return u.parentUnitName ? `${u.parentUnitName} ${name}`.trim() : name
}
