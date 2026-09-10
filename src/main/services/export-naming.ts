/**
 * 导出文件统一命名（公示表格 .xlsx；层级前缀由当前账号决定）。
 * 层级前缀按当前账号：一级=单位、二级=单位+年级、三级=单位+年级+班级。
 * 二处导出此前各自拼名（表格按数据维度带专业/班级、数据文件按 scope 缺年级），命名不一致，
 * 现收敛到本模块，前缀 + 学期 + 用途后缀。
 */
import { getUnit } from './unit'
import { currentRole, currentScope } from './role'

/** 当前账号的导出层级前缀（单位 / 单位+年级 / 单位+年级+班级）。 */
export function exportScopePrefix(): string {
  const unit = getUnit()
  const unitName = unit ? [unit.parentUnitName, unit.name].filter(Boolean).join(' ') : ''
  const role = currentRole()
  const scope = currentScope()
  const bits: string[] = []
  if (unitName) bits.push(unitName)
  if (role === 'level2') {
    if (scope.grade) bits.push(`${scope.grade}级`)
  } else if (role === 'level3') {
    if (scope.grade) bits.push(`${scope.grade}级`)
    if (scope.class) bits.push(scope.class)
  }
  return bits.join(' ')
}

/** 生成导出文件名（不含扩展名）：层级前缀 + 学期 + 用途后缀。 */
export function buildExportName(
  batch: { year: number; semester: number },
  purpose: '德育分核算' | '德育分数据'
): string {
  const name = [exportScopePrefix(), `${batch.year}学年第${batch.semester}学期`, purpose]
    .filter(Boolean)
    .join(' ')
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || purpose
}
