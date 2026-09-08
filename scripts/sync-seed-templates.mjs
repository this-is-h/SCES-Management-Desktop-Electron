#!/usr/bin/env node
/**
 * 受控同步脚本：将契约种子（server/contracts/seed）拷贝到管理端资源目录
 * （management/desktop/resources/templates），落地决策 #38——
 * 契约种子为单位配置**唯一权威**，管理端不再内置独立格式的模板，只镜像契约产物。
 *
 * 背景：管理端启动时 seedTemplates() 从 resources/templates/ 读内置配置种子填充
 * config_template 表（无服务端下发时的默认配置）。这些文件必须与契约种子逐字节一致，
 * 否则管理端消费的配置会与 UnitConfig schema 漂移。
 *
 * 规则：
 * - 只同步 SYNC_FILES 列出的种子（管理端 SEED_TEMPLATE_FILES 实际加载的那几份）；
 * - 逐字节拷贝，不改内容（契约种子是 verify 逐字节把关的生成物，勿在中途变形）；
 * - 同步前清理目标目录里的历史遗留（旧格式模板，如 test-template.json）；
 * - `--check` 模式：不写文件，校验目标是否与契约种子一致（CI 用），不一致退出码 1。
 *
 * 用法：
 *   node scripts/sync-seed-templates.mjs          # 同步
 *   node scripts/sync-seed-templates.mjs --check  # 校验
 */
import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 契约种子经 @sces/contracts 包（git 依赖）引入，见根 package.json devDependencies；
// 本地开发用 ../SCES-Server/contracts 的 file: 依赖（pnpm 软链到 node_modules）。
const SRC = path.join(ROOT, 'node_modules', '@sces', 'contracts', 'seed')
const DST = path.join(ROOT, 'resources', 'templates')

/** 需同步到管理端的契约种子（与 management db/index.ts 的 SEED_TEMPLATE_FILES 对应）。 */
const SYNC_FILES = ['lixing-shuyuan.json', 'test-1.json']

const CHECK = process.argv.includes('--check')

/** 归一化换行，避免 CRLF/LF 差异影响比对。 */
function normalize(text) {
  return text.replace(/\r\n/g, '\n')
}

async function main() {
  if (!existsSync(SRC)) {
    throw new Error(`契约种子目录不存在：${SRC}，请确认 server/contracts 已初始化`)
  }
  for (const file of SYNC_FILES) {
    if (!existsSync(path.join(SRC, file))) {
      throw new Error(`契约种子缺失：${file}（应由 server/contracts build:seeds 生成）`)
    }
  }

  if (CHECK) {
    if (!existsSync(DST)) {
      console.error(`[sync-seed-templates] 校验失败：目标目录不存在 ${DST}`)
      process.exit(1)
    }
    const mismatches = []
    for (const file of SYNC_FILES) {
      const dstFile = path.join(DST, file)
      if (!existsSync(dstFile)) {
        mismatches.push(`缺少文件：${file}`)
        continue
      }
      const srcText = normalize(await readFile(path.join(SRC, file), 'utf8'))
      const dstText = normalize(await readFile(dstFile, 'utf8'))
      if (srcText !== dstText) mismatches.push(`内容不一致：${file}`)
    }
    // 目标目录不得残留非同步项（旧格式模板）
    const present = (await readdir(DST)).filter((f) => f.endsWith('.json'))
    for (const f of present) {
      if (!SYNC_FILES.includes(f)) mismatches.push(`多余文件（应删除）：${f}`)
    }
    if (mismatches.length > 0) {
      console.error('[sync-seed-templates] 校验失败，管理端模板资源与契约种子不一致：')
      for (const m of mismatches) console.error(`  - ${m}`)
      console.error('[sync-seed-templates] 请运行 node scripts/sync-seed-templates.mjs 重新同步')
      process.exit(1)
    }
    console.log(`[sync-seed-templates] 校验通过：${SYNC_FILES.length} 份种子与契约一致`)
    return
  }

  // 同步模式：清理目标目录里的历史遗留 json，再逐字节拷贝需同步的种子
  await mkdir(DST, { recursive: true })
  const present = (await readdir(DST)).filter((f) => f.endsWith('.json'))
  for (const f of present) {
    if (!SYNC_FILES.includes(f)) {
      await rm(path.join(DST, f))
      console.log(`[sync-seed-templates] 移除历史遗留：${f}`)
    }
  }
  for (const file of SYNC_FILES) {
    const content = await readFile(path.join(SRC, file), 'utf8')
    await writeFile(path.join(DST, file), content, 'utf8')
  }
  console.log(`[sync-seed-templates] 同步完成：${SYNC_FILES.length} 份种子 → ${DST}`)
}

main().catch((error) => {
  console.error(`[sync-seed-templates] 失败：${error.message}`)
  process.exit(1)
})
