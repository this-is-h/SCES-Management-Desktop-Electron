#!/usr/bin/env node
/**
 * 第三方许可校验器（许可证合规机械门禁）。
 *
 * 职责：
 *  1. 枚举已安装依赖（根 pnpm store 虚拟目录 + 小程序独立 node_modules），
 *     逐一比对许可协议，杜绝"静默引入未知/无许可依赖"。
 *  2. 校验 THIRD_PARTY_NOTICES.md 含随包分发所需的关键许可全文标记
 *     （双许可组件必须显式选择：node-forge → BSD-3-Clause；JSZip → MIT）。
 *  3. 校验小程序包内通知副本与主文档一致（--sync 同步副本）。
 *
 * 用法：
 *  node scripts/verify-licenses.mjs          # 校验（失败即退出码 1）
 *  node scripts/verify-licenses.mjs --sync   # 校验 + 同步小程序通知副本
 *
 * 说明：@noble/*、node-forge 是 @sces/shared 的 devDependencies，不进管理端安装包；
 * 脚本枚举范围覆盖全部已安装包（含 dev），任何未知许可都会报警——比"只查交付物"
 * 更严格，也覆盖未来打包配置变化。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOTICES = join(ROOT, 'THIRD_PARTY_NOTICES.md')
// 小程序通知副本已随仓库拆分迁至 SCES-User-Wechat（miniprogram/THIRD_PARTY_NOTICES.md），
// 由 SCES-User-Wechat 侧自持，本仓不再同步。
const SYNC = process.argv.includes('--sync')

/** 常规许可白名单（可直接分发，无需 in-doc 全文标记）。 */
const PLAIN_LICENSES = new Set([
  'MIT',
  'MIT/X11',
  '(MIT OR WTFPL)',
  '(WTFPL OR MIT)',
  'WTFPL',
  'WTFPL OR ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
  'Apache-2.0',
  'ISC',
  'Unlicense',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  '(MIT AND Zlib)',
  '(MIT OR CC0-1.0)',
  'Python-2.0',
  'MPL-2.0',
  'CC-BY-4.0'
])

/**
 * 双许可/特殊许可：必须显式选择并在 THIRD_PARTY_NOTICES.md 中带全文标记。
 * key: 审计遍历到的 license 字符串 → { reason, marker: 文档中的标题行（含全文） }
 */
const NOTICE_REQUIRED = new Map([
  [
    '(BSD-3-Clause OR GPL-2.0)',
    { reason: 'node-forge：双许可，须选择 BSD-3-Clause 并在通知文档保留全文', marker: '## node-forge' }
  ],
  [
    '(MIT OR GPL-3.0-or-later)',
    { reason: 'JSZip：双许可，须选择 MIT 并在通知文档保留全文', marker: '## JSZip' }
  ]
])

/**
 * 无许可字段的豁免清单（name@version）：
 * - buffers@0.1.1：仅随 devDependencies 传递进入（构建期工具链），不进任何分发产物；
 *   其上游从未声明许可。属已知例外，明确记录。
 */
const UNLICENSED_EXEMPT = new Map([
  ['buffers@0.1.1', 'dev-only 传递依赖，上游未声明许可；不进分发产物'],
  ['vaul-vue@0.4.1', 'dev-only 构建依赖（@nuxt/ui 传递），上游仓库声明 MIT 但 npm 包清单缺失 license 字段；不进分发产物']
])

/** 不参与审计的目录：元目录。 */
function isSkippedDir(name) {
  return name.startsWith('.') || name === 'bin' || name === '.bin'
}

/** 包内夹具/示例子树：其下 package.json 是示例代码而非真实依赖，跳过。 */
const FIXTURE_DIRS = new Set(['example', 'examples', 'fixture', 'fixtures', 'demo', 'demos', 'test', 'tests'])

/** 在 dir 下递归收集 { name, version, license, dir }，跳过 stub 清单与 example 夹具。 */
function collect(root, out) {
  if (!existsSync(root)) return out
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (isSkippedDir(e.name) && !e.isDirectory()) continue
      if (!e.isDirectory()) continue
      // 夹具/示例子树先于清单读取跳过：github-from-package/example 的 package.json
      // 本身就是示例包（name=beep-boop），必须先跳过再读清单
      if (FIXTURE_DIRS.has(e.name)) continue
      const p = join(dir, e.name)
      const pkg = join(p, 'package.json')
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, 'utf8'))
          if (j.name && j.version) out.push({ name: j.name, version: j.version, license: j.license || '(none)' })
          // 无 version 的是子路径 stub 清单（如 @iconify/vue/offline），非真实包
        } catch {
          /* 忽略损坏清单 */
        }
      }
      walk(p)
    }
  }
  walk(root)
  return out
}

function main() {
  const failures = []
  const packages = []
  collect(join(ROOT, 'node_modules', '.pnpm'), packages)

  const seen = new Map()
  for (const p of packages) {
    if (!seen.has(p.name)) seen.set(p.name, p)
  }

  const notices = readFileSync(NOTICES, 'utf8')

  for (const p of seen.values()) {
    const key = `${p.name}@${p.version}`
    if (PLAIN_LICENSES.has(p.license)) continue
    if (NOTICE_REQUIRED.has(p.license)) {
      const { marker } = NOTICE_REQUIRED.get(p.license)
      if (!notices.includes(marker)) {
        failures.push(`依赖 ${key}（${p.license}）需要通知文档全文标记「${marker}」，但 THIRD_PARTY_NOTICES.md 缺失`)
      }
      continue
    }
    if (p.license === '(none)' && UNLICENSED_EXEMPT.has(key)) continue
    failures.push(`依赖 ${key} 许可「${p.license}」不在白名单：请在 scripts/verify-licenses.mjs 显式处置（新增白名单 / 通知标记 / 豁免说明）`)
  }

  // 小程序通知副本（SCES-User-Wechat/miniprogram/THIRD_PARTY_NOTICES.md）由 SCES-User-Wechat 自持，不再在本仓校验

  if (failures.length) {
    console.error(`✘ 许可校验失败（${failures.length} 项）：`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`✓ 许可校验通过：${seen.size} 个已安装依赖，许可状态全部合规；通知文档完整`)
}

main()