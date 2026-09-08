/**
 * 学号冲突处理 + 错误处理（架构 §7）。
 *
 * - 冲突（§7.2-3）：同一学号出现不同姓名（两个候选者），由管理端从候选者中指定
 *   “正确学生”，只能设置一次：写入 id_conflict_locked=1 并落审计，不可修改、不可撤销；
 *   锁定后任何同学号不同姓名的导入直接拒绝（shared checkImport）。
 * - 错误处理（§7.2-4）：学号唯一但姓名与已录入记录不符（输错/改名/录入错误），
 *   允许修正一次：写入 name_corrected=1，修正前后姓名均记录审计；修正后导入旧姓名被拒绝。
 */
import type { ImportPayload, Student } from '@sces/shared'
import { getDb } from '../db'
import { assertBatchNotExported, getBatch } from './batch'
import { getTemplate } from './config-template'
import { writeAudit } from './audit'
import { assertWritable } from './license'
import { currentRole, currentScope } from './role'
import { touchScoresChanged } from './ranking'
import { collectEvidenceDirs, removeEvidenceDirs } from './evidence'
import { assertImportable, findStudentRow, importAcceptedPayload } from './import'
import type { ConflictResolveResult, PendingConflict } from '../../preload/types'
import { writeTimelineEvent } from './timeline'

/** 待处理冲突列表（按暂存时间倒序）。 */
export function listConflicts(batchId: string): PendingConflict[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id AS conflictId, batch_id AS batchId, student_id AS studentId,
              existing_name AS existingName, incoming_name AS incomingName,
              file_name AS fileName, created_at AS createdAt
       FROM import_conflict WHERE batch_id = ? ORDER BY created_at DESC`
    )
    .all(batchId) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    conflictId: r.conflictId as number,
    batchId: r.batchId as string,
    studentId: r.studentId as string,
    existingName: r.existingName as string,
    incomingName: r.incomingName as string,
    fileName: r.fileName as string,
    createdAt: r.createdAt as number
  }))
}

/**
 * 处理冲突：指定“正确学生”（只能设置一次）。
 * - existing：以已有记录为准 → 锁定现有学号（id_conflict_locked=1），新导入文件拒绝；
 * - incoming：以新导入为准 → 修正姓名 + 锁定（name_corrected=1 / id_conflict_locked=1），
 *   清理旧申请（保持学生×批次唯一）后导入暂存的申请 payload。
 */
export function resolveConflict(
  batchId: string,
  conflictId: number,
  choice: 'existing' | 'incoming'
): ConflictResolveResult {
  assertWritable()
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  // 整班导出后本端锁定：冲突处理同样不可再操作（决策 #17）
  assertBatchNotExported(batch)
  const db = getDb()
  const conflict = db
    .prepare('SELECT * FROM import_conflict WHERE id = ? AND batch_id = ?')
    .get(conflictId, batchId) as Record<string, unknown> | undefined
  if (!conflict) throw new Error('冲突记录不存在或已处理')

  const student = findStudentRow(batchId, conflict.studentId as string)
  if (!student) throw new Error('冲突对应的学生记录不存在')
  if (student.idConflictLocked) throw new Error('该学号已锁定，无法再次处理冲突')

  const role = currentRole()
  const baseDetail = {
    studentId: conflict.studentId,
    existingName: student.name,
    incomingName: conflict.incomingName,
    fileName: conflict.fileName
  }

  // 以现有记录为准：锁定即可（新导入文件不落库）
  if (choice === 'existing') {
    lockStudent(student)
    writeAudit({
      batchId,
      operator: 'local-admin',
      role,
      scope: 'unit',
      action: 'conflict.resolve.existing',
      target: conflict.studentId as string,
      detail: { ...baseDetail, lockedName: student.name }
    })
    db.prepare('DELETE FROM import_conflict WHERE id = ?').run(conflictId)
    return { decision: 'rejected', reason: '已锁定现有记录，新导入文件已拒绝' }
  }

  // 以新导入为准：修正姓名 + 锁定 + 导入
  if (student.nameCorrected) throw new Error('该学号姓名已修正过，无法再次以新导入为准')

  assertImportable(batch)
  const template = batch.configTemplateId ? getTemplate(batch.configTemplateId) : null
  if (!template) throw new Error('批次配置模板缺失，无法导入申请内容')

  const payload = JSON.parse(conflict.payload as string) as ImportPayload
  const existingApply = getApplyStatus(batchId, student.id!)
  if (existingApply && (existingApply === 'reviewing' || existingApply === 'confirmed')) {
    throw new Error('该学号已有审核中/已确认的申请，无法以新导入为准，请先撤销确认')
  }

  let orphanEvidenceRelDirs: string[] = []
  const tx = db.transaction(() => {
    // 1. 修正姓名 + 锁定（仅一次）
    db.prepare(
      `UPDATE student SET name = ?, id_conflict_locked = 1, name_corrected = 1 WHERE id = ?`
    ).run(conflict.incomingName, student.id)
    // 2. 清理旧申请（明细/版本/申请行），保持“学生×批次唯一”不变量；
    //    返回被删申请的孤儿证据目录（事务提交后清理，避免误删新导入证据）
    orphanEvidenceRelDirs = clearApplies(batchId, student.id!)
    // 3. 导入暂存 payload（学生已存在且姓名一致 → accept 路径）
    importAcceptedPayload(batch, template, payload, conflict.fileHash as string)
    // 4. 删除冲突记录
    db.prepare('DELETE FROM import_conflict WHERE id = ?').run(conflictId)
  })
  tx()
  removeEvidenceDirs(orphanEvidenceRelDirs)
  touchScoresChanged(batchId)

  writeAudit({
    batchId,
    operator: 'local-admin',
    role,
    scope: 'unit',
    action: 'conflict.resolve.incoming',
    target: conflict.studentId as string,
    detail: {
      ...baseDetail,
      beforeName: student.name,
      afterName: conflict.incomingName,
      applyId: payload.applyId,
      revision: payload.revision
    }
  })
  return { decision: 'imported', reason: '已以新导入为准导入申请', applyId: payload.applyId }
}

/**
 * 错误处理：修正学生姓名（学号唯一、无冲突场景，§7.2-4）。
 * 仅允许修正一次（name_corrected=1），修正前后姓名均记录审计；
 * 修正后该学号+新姓名成为正确记录并锁定（再导入旧姓名被 checkImport 拒绝）。
 */
export function correctName(batchId: string, studentId: string, newName: string): void {
  assertWritable()
  const name = String(newName ?? '').trim()
  if (!name) throw new Error('姓名不能为空')
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  assertBatchNotExported(batch)
  const student = findStudentRow(batchId, studentId)
  if (!student) throw new Error('学生不存在')
  if (student.nameCorrected) throw new Error('该学号姓名已修正过，仅允许修正一次')
  if (student.idConflictLocked && student.name !== name) {
    throw new Error('该学号已锁定，姓名不可修改')
  }
  if (student.name === name) throw new Error('姓名未变化')

  const db = getDb()
  const applyRow = db
    .prepare('SELECT apply_id AS applyId FROM apply WHERE batch_id = ? AND student_id = ?')
    .get(batchId, student.id) as { applyId: string } | undefined
  const tx = db.transaction(() => {
    db.prepare(`UPDATE student SET name = ?, name_corrected = 1 WHERE id = ?`).run(name, student.id)
    if (applyRow) {
      writeTimelineEvent({
        batchId,
        applyId: applyRow.applyId,
        actorType: 'admin',
        role: currentRole(),
        scope: { ...currentScope() },
        action: 'admin.modified',
        detail: { changes: [{ field: 'student.name', before: student.name, after: name }] }
      })
    }
  })
  tx()
  writeAudit({
    batchId,
    operator: 'local-admin',
    role: currentRole(),
    scope: 'unit',
    action: 'student.name.correct',
    target: studentId,
    detail: { studentId, beforeName: student.name, afterName: name }
  })
}

/** 锁定学号（冲突处理共用，仅一次）。 */
function lockStudent(student: Student): void {
  getDb().prepare(`UPDATE student SET id_conflict_locked = 1 WHERE id = ?`).run(student.id)
}

/** 查询该学生的申请状态（无返回 undefined）。 */
function getApplyStatus(batchId: string, studentDbId: number): string | undefined {
  const row = getDb()
    .prepare(`SELECT status FROM apply WHERE batch_id = ? AND student_id = ? LIMIT 1`)
    .get(batchId, studentDbId) as { status: string } | undefined
  return row?.status
}

/**
 * 删除学生的全部申请（明细 → 版本 → 申请行），并返回被删申请的孤儿证据目录
 * （事务提交成功后由调用方清理，避免删除前误删正在使用的新证据）。
 */
function clearApplies(batchId: string, studentDbId: number): string[] {
  const db = getDb()
  const applies = db
    .prepare(`SELECT apply_id AS applyId FROM apply WHERE batch_id = ? AND student_id = ?`)
    .all(batchId, studentDbId) as Array<{ applyId: string }>
  const orphanEvidenceFiles: string[] = []
  for (const a of applies) {
    const scoreRows = db
      .prepare('SELECT evidence_files AS evidenceFiles FROM dyf_score WHERE apply_id = ?')
      .all(a.applyId) as Array<{ evidenceFiles: string | null }>
    const applyRow = db
      .prepare('SELECT confirm_slip AS confirmSlip FROM apply WHERE apply_id = ?')
      .get(a.applyId) as { confirmSlip: string | null } | undefined
    for (const row of scoreRows) {
      const files = JSON.parse(row.evidenceFiles ?? '[]') as string[]
      for (const f of files) orphanEvidenceFiles.push(f)
    }
    if (applyRow?.confirmSlip) orphanEvidenceFiles.push(applyRow.confirmSlip)
    db.prepare('DELETE FROM timeline_event WHERE apply_id = ?').run(a.applyId)
    db.prepare(`DELETE FROM dyf_score WHERE apply_id = ?`).run(a.applyId)
    db.prepare(`DELETE FROM apply_revision WHERE apply_id = ?`).run(a.applyId)
    db.prepare(`DELETE FROM apply WHERE apply_id = ?`).run(a.applyId)
  }
  return collectEvidenceDirs(orphanEvidenceFiles)
}
