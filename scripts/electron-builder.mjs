#!/usr/bin/env node
/**
 * electron-builder 包装器：从 deploy/profile.json（单一真源）读取 profileId，
 * 注入 DMS_PROFILE_ID 环境变量后调用 electron-builder，使 nsis.artifactName 的
 * ${env.DMS_PROFILE_ID} 宏解析为当前发布档（如 online-2026s1）。
 *
 * 用法（仓库根目录下执行）：
 *   node scripts/electron-builder.mjs --win [其他 electron-builder 参数]
 *
 * 退出码：透传 electron-builder 的退出码（0 成功；非 0 失败即拦截发布）。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_PATH = join(ROOT, 'deploy', 'profile.json')

let profileId
try {
  const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'))
  if (!profile.profileId) throw new Error('profile.json 缺少 profileId')
  profileId = profile.profileId
} catch (e) {
  console.error(`[electron-builder] 读取发布档失败：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const result = spawnSync('pnpm', ['exec', 'electron-builder', ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DMS_PROFILE_ID: profileId }
})

const status = result.status ?? (result.error ? 1 : 0)
if (status !== 0) {
  console.error(`[electron-builder] 构建失败（exit ${status}）：${result.error?.message ?? ''}`)
}
process.exit(status)