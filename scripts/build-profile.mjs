#!/usr/bin/env node
/**
 * 发布档校验脚本：读取 deploy/profile.json（单一直源），校验 schema 与模式一致性。
 *
 * 背景：管理模式不是环境变量，而是提交进仓库的发布决策；electron.vite.config.ts
 * 在编译期直接 import deploy/profile.json 做 define 注入（见该文件）。
 *
 * 职责边界（保持单一职责）：
 *   输入：deploy/profile.json + deploy/profile.schema.json
 *   输出：无（纯校验；--check 供 CI 比对，--apply 供构建链调用）
 *   不负责：编译、打包、学生端注入（学生端 runtime/active 注入脚本已随仓库拆分
 *   移至 sces-user，在线化（M5）后由服务端下发配置替代）
 *
 * 用法：
 *   node scripts/build-profile.mjs --apply   # 校验（构建链前置门禁）
 *   node scripts/build-profile.mjs --check   # 校验（CI，不写文件）
 *
 * 模式规则（在线版方向）：
 *   - online：management.serverUrl 必须为 https URL（dev 允许 http://127.0.0.1）；
 *   - management.updateUrl 可选但必须是 https（到位后自动更新通道才有意义）。
 *   - 离线授权链（licenseVerifyKeys / offlineUnits / localVault 密钥材料）不再校验：
 *     离线交付已停止维护，相关设施随迁移退役；如 profile 仍含这些字段则仅做 schema 校验。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEPLOY = join(ROOT, 'deploy')
const PROFILE_PATH = join(DEPLOY, 'profile.json')
const SCHEMA_PATH = join(DEPLOY, 'profile.schema.json')

const argv = process.argv.slice(2)
const DO_APPLY = argv.includes('--apply')
const DO_CHECK = argv.includes('--check')

// ---------------------------------------------------------------------------
// 轻量 JSON-Schema 校验器（支持本 schema 用到的子集，刻意不引入 ajv）
// ---------------------------------------------------------------------------

function typeName(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function typeMatches(schemaTypes, v) {
  const list = Array.isArray(schemaTypes) ? schemaTypes : [schemaTypes]
  return list.some((t) => {
    if (t === 'null') return v === null
    if (t === 'array') return Array.isArray(v)
    if (t === 'integer') return typeof v === 'number' && Number.isInteger(v)
    return typeof v === t
  })
}

function validateNode(schema, value, pathStr, root, errors) {
  if (schema.$ref) {
    const key = schema.$ref.replace(/^#\/\$defs\//, '')
    const def = root.$defs && root.$defs[key]
    if (!def) throw new Error(`schema 内 $ref 无法解析：${schema.$ref}`)
    return validateNode(def, value, pathStr, root, errors)
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${pathStr}: 期望类型 ${JSON.stringify(schema.type)}，实际 ${typeName(value)}`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathStr}: 值不在枚举内 ${JSON.stringify(schema.enum)}`)
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const props = schema.properties || {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${pathStr}.${key}: 不允许的附加属性`)
      }
    }
    for (const key of Object.keys(props)) {
      if (key in value) validateNode(props[key], value[key], `${pathStr}.${key}`, root, errors)
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateNode(schema.items, item, `${pathStr}[${i}]`, root, errors))
  }
  if (schema.required) {
    for (const key of schema.required) {
      if (typeof value !== 'object' || value === null || !(key in value)) {
        errors.push(`${pathStr}: 缺少必填字段 ${key}`)
      }
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${pathStr}: 长度小于 ${schema.minLength}`)
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${pathStr}: 小于最小值 ${schema.minimum}`)
    if (schema.maximum != null && value > schema.maximum) errors.push(`${pathStr}: 大于最大值 ${schema.maximum}`)
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const profile = JSON.parse(await readFile(PROFILE_PATH, 'utf8'))
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'))
  const errors = []
  validateNode(schema, profile, '$', schema, errors)

  const mode = profile.mode
  if (mode === 'online') {
    const url = profile.management?.serverUrl
    const ok =
      typeof url === 'string' &&
      (url.startsWith('https://') ||
        url.startsWith('http://127.0.0.1') ||
        url.startsWith('http://localhost'))
    if (!ok) errors.push('online 模式：management.serverUrl 必须为 https URL（dev 允许 http://127.0.0.1）')
    const update = profile.management?.updateUrl
    if (update != null && typeof update !== 'string') {
      errors.push('management.updateUrl 必须为字符串或 null')
    }
  } else if (mode === 'offline') {
    // 离线档不再作为交付目标：仅提示，不做 licenseVerifyKeys/offlineUnits 强制校验
    console.warn('[build-profile] 注意：profile.mode=offline，离线交付已停止维护，构建将按 history 兼容处理')
  } else {
    errors.push(`mode 非法：${mode}`)
  }

  if (errors.length > 0) {
    console.error('[build-profile] 发布档校验失败：')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  const action = DO_APPLY ? 'apply' : DO_CHECK ? 'check' : 'validate'
  console.log(`[build-profile] 校验通过（${action}）：profileId=${profile.profileId} mode=${profile.mode}`)
}

main().catch((error) => {
  console.error(`[build-profile] 失败：${error.message}`)
  process.exit(1)
})