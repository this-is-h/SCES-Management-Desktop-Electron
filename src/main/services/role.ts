/**
 * 角色与数据范围服务:当前账号角色、可确认层级、scope 过滤边界。
 * 授权文件接入后(M-O1/M-O1B),角色与数据范围由激活写入(account.role / activation.scope)。
 * scope 是安全边界,所有列表/统计查询必须据此在主进程过滤(dual-mode/12 §5.4)。
 */
import type { AuditRole } from '@sces/shared'
import type { LicenseScope } from './settings'
import { getActiveAccount } from './accounts'
import { writeAudit } from './audit'
import { getSetting } from './settings'

/** 当前账号角色(授权过期只读不影响读取)。 */
export function currentRole(): AuditRole {
  return getActiveAccount()?.role ?? 'level1'
}

/**
 * 当前数据范围:level3 同时限年级(scope.grade)+班级(scope.class)、level2 限年级(scope.grade)、level1 全单位(空)。
 * 读激活信息;未激活或一级返回空对象(不过滤)。
 */
export function currentScope(): LicenseScope {
  return getSetting('activation')?.scope ?? {}
}

/** 当前角色可确认的层级：level3 → 3（班级）/ level2 → 2（年级）/ level1 → 1（校级）。 */
export function confirmLevelForRole(role: AuditRole): 1 | 2 | 3 {
  if (role === 'level3') return 3
  if (role === 'level2') return 2
  return 1
}

/** 角色中文名(错误文案用)。 */
function roleLabel(role: AuditRole): string {
  if (role === 'level3') return '班级管理员'
  if (role === 'level2') return '年级管理员'
  return '单位管理员'
}

/**
 * 仅一级可执行(创建批次、撤销确认等)。越权:落审计 + 抛错(dual-mode/12 §5.4)。
 * 与渲染层隐藏无关——这是主进程的硬边界,IPC 直调也拦得住。
 */
export function assertLevel1(action: string): void {
  const role = currentRole()
  if (role === 'level1') return
  writeAudit({
    operator: role,
    role,
    scope: 'unit',
    action: `denied.${action}`,
    detail: { reason: 'requires-level1' }
  })
  throw new Error(`${roleLabel(role)}无权执行此操作,仅单位管理员(一级)可操作`)
}

/**
 * 学生数据范围 SQL 谓词(安全边界):level3 限本班、level2 限本年级、level1 不过滤。
 * `cols` 传各查询中 student 的 grade / class 列引用(如 's.grade' / 's.class_name')。
 */
export function studentScopeSql(cols: { grade: string; class: string }): {
  clause: string
  params: string[]
} {
  const role = currentRole()
  const scope = currentScope()
  if (role === 'level3' && scope.class && scope.grade) {
    return {
      clause: ` AND ${cols.class} = ? AND ${cols.grade} = ?`,
      params: [scope.class, scope.grade]
    }
  }
  if (role === 'level3') return { clause: ' AND 1 = 0', params: [] }
  if (role === 'level2' && scope.grade)
    return { clause: ` AND ${cols.grade} = ?`, params: [scope.grade] }
  return { clause: '', params: [] }
}

/**
 * 数据范围门禁（§5.4/§6）：二三级只能处理「本班/本年级」学生；越权返回拒绝原因，在范围内或一级返回 null。
 * 导入 .dyf 的越权数据必须拒绝，否则落库后被列表/统计/导出的 scope 过滤，
 * 造成「排名算出 N 人、页面与导出 0 人」的存储/展示/导出不一致。
 */
export function outOfScopeReason(student: { grade?: unknown; className?: unknown }): string | null {
  const role = currentRole()
  const scope = currentScope()
  if (role === 'level3' && (!scope.class || !scope.grade)) {
    return '本账号授权范围缺少年级或班级信息，请重新导入包含完整范围的授权文件'
  }
  if (role === 'level3' && scope.class && scope.grade) {
    const cls = String(student.className ?? '').trim()
    const grade = String(student.grade ?? '').trim()
    if (grade !== scope.grade)
      return `该学生年级「${grade || '未知'}」不在本账号授权范围（年级 ${scope.grade}）内，无法导入`
    if (cls !== scope.class)
      return `该学生班级「${cls || '未知'}」不在本账号授权范围（班级 ${scope.class}）内，无法导入`
  }
  if (role === 'level2' && scope.grade) {
    const grade = String(student.grade ?? '').trim()
    if (grade !== scope.grade)
      return `该学生年级「${grade || '未知'}」不在本账号授权范围（年级 ${scope.grade}）内，无法导入`
  }
  return null
}
