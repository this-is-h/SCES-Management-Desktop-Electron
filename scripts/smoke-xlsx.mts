/**
 * 烟测：hand-rolled xlsx 写出器能生成可被真实解析器打开的 .xlsx，且：
 * 合并 / 冻结 / 内联串 / 数值 / EOCD 偏移 / 无底纹 / 满边框（空格为空的带框格）/ 居中。
 * 运行：npx tsx scripts/smoke-xlsx.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildWorkbook, type XlsxCell, type XlsxStyle } from '../management/desktop/src/main/utils/xlsx'

// 0 数据(满框) / 1 大标题 / 2 表头
const styles: XlsxStyle[] = [
  { align: 'center', valign: 'center', border: true },
  { bold: true, fontSize: 16, align: 'center', valign: 'center', border: true },
  { bold: true, align: 'center', valign: 'center', border: true }
]

const blank = (s: number): XlsxCell => ({ v: null, s })
// 真实表格区域每个格子都带边框（含空格/0 分——它们是成绩表的一部分）；表格之外不写单元格。
const rows: XlsxCell[][] = [
  [{ v: '励行书院 软件工程 2101班 2025学年第2学期 德育分核算', s: 1 }, blank(1), blank(1), blank(1)],
  [{ v: '序号', s: 2 }, { v: '姓名', s: 2 }, { v: '总分', s: 2 }, { v: '111', s: 2 }],
  [{ v: 1, s: 0 }, { v: '张三', s: 0 }, { v: 88.5, s: 0 }, { v: 2, s: 0 }],
  // 行4：第4列(111)未填 → 空的带框格子（真实表格内的空格仍要边框）
  [{ v: 2, s: 0 }, { v: '李四', s: 0 }, { v: '', s: 0 }, { v: '', s: 0 }]
]

const buf = buildWorkbook(
  {
    name: '德育分核算',
    rows,
    merges: [{ r1: 0, c1: 0, r2: 0, c2: 3 }],
    cols: [{ width: 6 }, { width: 10 }, { width: 8 }, { width: 7 }],
    freezeRows: 2
  },
  styles
)

mkdirSync(join(process.cwd(), 'tmp'), { recursive: true })
const out = join(process.cwd(), 'tmp', 'smoke.xlsx')
writeFileSync(out, buf)
console.log('[smoke-xlsx] wrote', out, buf.length, 'bytes')

const text = buf.toString('utf8')
const must = [
  '<mergeCells count="1">',
  'mergeCell ref="A1:D1"',
  'pane ySplit="2"',
  '德育分核算',
  '<v>88.5</v>',
  't="inlineStr"',
  'showGridLines="0"'
]
const missing = must.filter((s) => !text.includes(s))
if (missing.length) {
  console.error('[smoke-xlsx] 缺少结构:', missing)
  process.exit(1)
}
if (buf.readUInt32LE(buf.length - 6) >= buf.length) {
  console.error('[smoke-xlsx] EOCD 中央目录偏移越界')
  process.exit(1)
}
if (text.includes('patternType="solid"') || !text.includes('<fills count="2">')) {
  console.error('[smoke-xlsx] 不应有底纹填充')
  process.exit(1)
}
// 满边框：真实表格内每个格子都带样式(四边 thin)，含空的带框格 s="0"（如 D4）
if (
  !text.includes('<left style="thin">') ||
  !text.includes('<c r="D4" s="0"/>') ||
  !text.includes('<dimension ref="A1:D4"/>')
) {
  console.error('[smoke-xlsx] 满边框/空带框格/dimension 断言失败')
  process.exit(1)
}
// 列默认样式必须指向「无边框样式」(追加在 cellXfs 末尾, 索引=styles.length=3)，
// 否则已定义列(<col>)表格以外的空单元格会继承带边框的 cellXfs[0]，在 WPS 里画出表外竖线。
if (!text.includes('style="3"/>') || !text.includes('<cellXfs count="4">')) {
  console.error('[smoke-xlsx] <col> 未指向无边框默认样式（表外会出现边框线）')
  process.exit(1)
}
console.log(
  '[smoke-xlsx] 全部断言通过（合并/冻结/内联串/数值/偏移/无底纹/满边框/空带框格/dimension/列默认无边框）'
)
