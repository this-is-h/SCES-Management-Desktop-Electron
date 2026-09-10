/**
 * 德育分总体情况流式导出为 .xlsx。
 * ExcelJS 使用 MIT 协议；WorkbookWriter 分页取数并直接写临时文件，避免全表与完整工作簿缓冲常驻内存。
 */
import ExcelJS from 'exceljs'
import type { Alignment, Borders } from 'exceljs'
import { existsSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { getUnit } from './unit'
import { getBatch } from './batch'
import { getScoreTable, getScoreTableDimensions } from './overview'
import { buildExportName } from './export-naming'

export interface ExportTableOptions {
  search?: string
  classes?: string[]
  /** 要导出的项目类别（空 = 仅基本信息，与页面“全不选”一致）。 */
  categories?: string[]
}

interface ExportPlan {
  title: string
  fileName: string
  itemCols: Array<{ itemCode: string; category: string; description: string }>
  totalRows: number
}

const BORDER: Partial<Borders> = {
  top: { style: 'thin' },
  right: { style: 'thin' },
  bottom: { style: 'thin' },
  left: { style: 'thin' }
}
const CENTER: Partial<Alignment> = { horizontal: 'center', vertical: 'middle' }
const BASE_HEADERS = ['序号', '学号', '姓名', '班级', '总分', '班排', '专排']
const BASE_WIDTHS = [6, 14, 10, 16, 8, 6, 6]
const EXPORT_PAGE_SIZE = 500

function buildExportPlan(batchId: string, options: ExportTableOptions): ExportPlan {
  const batch = getBatch(batchId)
  if (!batch) throw new Error('批次不存在')
  if (!batch.rankedAt || (batch.scoresChangedAt && batch.rankedAt < batch.scoresChangedAt)) {
    throw new Error('排名尚未计算或已经过期，请先按最新数据重新计算排名再导出表格')
  }

  const firstPage = getScoreTable(batchId, {
    search: options.search,
    classes: options.classes,
    limit: 1
  })
  const dimensions = getScoreTableDimensions(batchId, options)
  const selected = new Set(options.categories ?? [])
  const itemCols = firstPage.columns.filter((column) => selected.has(column.category))
  const unit = getUnit()
  const unitName = unit ? [unit.parentUnitName, unit.name].filter(Boolean).join(' ') : ''
  const gradeLabel = dimensions.grade ? `${dimensions.grade}级` : ''
  const title = [
    unitName,
    gradeLabel,
    dimensions.major,
    dimensions.className,
    `${batch.year}学年第${batch.semester}学期`,
    '德育分核算'
  ]
    .filter(Boolean)
    .join(' ')
  // 文件名按当前账号层级统一命名；表内大标题保留数据维度（专业/班级）供展示。
  const fileName = `${buildExportName(batch, '德育分核算')}.xlsx`
  return { title, fileName, itemCols, totalRows: dimensions.total }
}

/** 保存对话框显示前获取建议文件名；只做轻量查询，不生成工作簿。 */
export function getScoreTableXlsxFileName(
  batchId: string,
  options: ExportTableOptions = {}
): string {
  return buildExportPlan(batchId, options).fileName
}

/** 分页读取成绩并流式写入目标文件；完成前不会覆盖用户已有文件。 */
export async function writeScoreTableXlsx(
  batchId: string,
  targetPath: string,
  options: ExportTableOptions = {}
): Promise<void> {
  const plan = buildExportPlan(batchId, options)
  const totalCols = BASE_HEADERS.length + plan.itemCols.length
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.part`)
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: temporaryPath,
    useStyles: true,
    useSharedStrings: false
  })

  try {
    const worksheet = workbook.addWorksheet('德育分核算', {
      views: [{ state: 'frozen', ySplit: 3 }]
    })
    worksheet.columns = [
      ...BASE_WIDTHS.map((width) => ({ width })),
      ...plan.itemCols.map(() => ({ width: 7 }))
    ]

    const titleRow = worksheet.addRow([
      plan.title,
      ...Array(Math.max(0, totalCols - 1)).fill('')
    ])
    worksheet.mergeCells(1, 1, 1, totalCols)
    titleRow.getCell(1).font = { bold: true, size: 16 }
    titleRow.getCell(1).alignment = CENTER
    titleRow.getCell(1).border = BORDER
    titleRow.commit()

    const groupRow = worksheet.addRow([...BASE_HEADERS, ...plan.itemCols.map(() => '')])
    groupRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true }
      cell.alignment = CENTER
      cell.border = BORDER
    })
    worksheet.mergeCells(2, 1, 2, BASE_HEADERS.length)
    let col = BASE_HEADERS.length + 1
    let index = 0
    while (index < plan.itemCols.length) {
      const category = plan.itemCols[index].category
      let end = index
      while (end < plan.itemCols.length && plan.itemCols[end].category === category) end++
      if (end - index > 1) worksheet.mergeCells(2, col, 2, col + end - index - 1)
      const label = groupRow.getCell(col)
      label.value = category
      label.font = { bold: true }
      label.alignment = CENTER
      label.border = BORDER
      col += end - index
      index = end
    }
    groupRow.commit()

    const leafRow = worksheet.addRow([
      ...BASE_HEADERS,
      ...plan.itemCols.map((item) => item.itemCode)
    ])
    leafRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true }
      cell.alignment = CENTER
      cell.border = BORDER
    })
    leafRow.commit()

    for (let offset = 0; offset < plan.totalRows; offset += EXPORT_PAGE_SIZE) {
      const page = getScoreTable(batchId, {
        search: options.search,
        classes: options.classes,
        limit: EXPORT_PAGE_SIZE,
        offset
      })
      for (let rowIndex = 0; rowIndex < page.rows.length; rowIndex++) {
        const row = page.rows[rowIndex]
        const dataRow = worksheet.addRow([
          offset + rowIndex + 1,
          row.studentId,
          row.name,
          row.className ?? '',
          row.dyfTotal,
          row.rankClass ?? '',
          row.rankMajor ?? '',
          ...plan.itemCols.map((item) => row.scores[item.itemCode] || '')
        ])
        dataRow.eachCell({ includeEmpty: true }, (cell) => {
          cell.alignment = CENTER
          cell.border = BORDER
        })
        dataRow.commit()
      }
    }

    worksheet.commit()
    await workbook.commit()
    if (existsSync(targetPath)) rmSync(targetPath, { force: true })
    renameSync(temporaryPath, targetPath)
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
    throw error
  }
}
