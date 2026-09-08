# sces-management — 管理端开发

## 项目概述

学生综合素质测评管理系统（SCES）管理端，Electron + Vue 3 + Nuxt UI + better-sqlite3。
当前离线优先，在线化（对接 sces-server，M5）进行中：`gateway/online.ts` 为在线网关骨架。

## 仓库结构（已随拆分拍平到仓库根）

| 路径 | 职责 |
|---|---|
| `src/main/` | 主进程：db / services（批次、申请、导出、上报、授权）/ gateway（dual-mode）/ ipc |
| `src/preload/` | 暴露给渲染层的类型安全 API |
| `src/renderer/` | Vue 渲染层（@nuxt/ui，无 vue-router） |
| `resources/templates/` | 契约种子镜像（由 `scripts/sync-seed-templates.mjs` 同步，勿手改） |
| `deploy/profile.json` | 发布档单一真源（构建期注入） |
| `scripts/` | 构建/校验脚本（build-profile / electron-builder / gen-update-manifest / sync-seed-templates / verify-licenses / smoke-xlsx） |

## 开发要点

- `pnpm build` 前置门禁：`sync-seed-templates`（契约种子逐字节一致）+ `build-profile --apply`（发布档校验）；
- `@sces/shared` 以 TS 源码打包进 bundle（electron.vite.config.ts `externalizeDeps.exclude`），
  原生依赖（better-sqlite3 等）保持 externalize；
- `pnpm dev` 前确认 `deploy/profile.json` 为 `online` 档（服务端未建成时 API 调用会失败，属预期）。

## 里程碑

- M5：在线化接入 sces-server（授权、配置下发、批次下发、状态同步）；离线链路按模块下线。
- 详见 `../sces-server/docs/server-plan.md` 与 sces-server 契约基线。