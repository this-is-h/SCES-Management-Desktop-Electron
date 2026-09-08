#!/usr/bin/env node
/**
 * 生成自动更新元数据 latest.json（Vercel 静态托管，随 SCES-Server 一起维护）。
 *
 * 职责：
 *   读取仓库根 package.json 的 version + deploy/profile.json 的 profileId，
 *   写 dist-update/latest.json（跨仓推送由 release.yml 负责：克隆 SCES-Server，
 *   覆盖 public/updates/latest.json 后 push main，触发 Vercel 自动部署）。
 *
 * 输出：dist-update/latest.json
 *   { version, profileId, notes, downloadUrl, mandatory, publishedAt }
 *
 * 用法：
 *   node scripts/gen-update-manifest.mjs [version] [notes]
 *   环境变量 UPDATE_MANIFEST_OUT 可覆盖输出目录。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(ROOT, 'package.json')
const DEPLOY_PROFILE = join(ROOT, 'deploy', 'profile.json')
const OUT_FILE = join(process.env.UPDATE_MANIFEST_OUT ?? join(ROOT, 'dist-update'), 'latest.json')

const argv = process.argv.slice(2)

/** 下载页地址：SCES-Web-Vercel 部署域下的 /download。 */
const DEFAULT_DOWNLOAD_URL = process.env.UPDATE_DOWNLOAD_URL ?? 'https://dms.thisish.cn/download'

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
const version = argv[0] ?? pkg.version ?? '0.0.0'
const notes = argv[1] ?? ''
const profile = JSON.parse(readFileSync(DEPLOY_PROFILE, 'utf8'))

const manifest = {
  version,
  profileId: profile.profileId ?? null,
  notes,
  downloadUrl: DEFAULT_DOWNLOAD_URL,
  mandatory: false,
  publishedAt: Math.floor(Date.now() / 1000)
}

mkdirSync(dirname(OUT_FILE), { recursive: true })
writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[gen-update-manifest] wrote ${OUT_FILE}`)
console.log(`  version=${version} profileId=${manifest.profileId} downloadUrl=${DEFAULT_DOWNLOAD_URL}`)