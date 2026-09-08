# sces-management — 管理端（Electron 桌面应用）

学生综合素质测评管理系统（SCES）· 管理端。当前为**离线优先**实现（本地 sqlite 权威、授权文件激活），**在线化进行中**：`src/main/gateway/online.ts` 已具备服务端对接骨架（授权码、HTTP 上报、状态同步），服务端（`../sces-server`，M5）建成后逐步接管。

## 仓库关系

| 依赖 | 获取方式 | 用途 |
|---|---|---|
| `@sces/shared` | git 依赖（本地开发 `file:../sces-shared`） | 数据模型、加密、计算引擎、状态机、校验规则 |
| `@sces/contracts` | git 依赖（本地开发 `file:../sces-server/contracts`） | 契约种子（`sync-seed-templates` 镜像到 `resources/templates`） |
| `sces-web`（远端） | release CI 跨仓推送 | `public/updates/latest.json` 自动更新元数据 |
| `sces-server`（远端） | M5 服务端 | 在线 API（契约见 `@sces/contracts`） |

## 常用命令（仓库根）

```sh
pnpm install            # 安装依赖（含 file: 本地依赖软链）
pnpm dev                # electron-vite 开发模式
pnpm typecheck          # 类型检查（node + web）
pnpm lint               # ESLint
pnpm build              # 种子同步 + profile 校验 + 构建 + 类型检查
pnpm build:win          # Windows 安装包（electron-builder）
pnpm gen:update-manifest  # 生成 dist-update/latest.json
```

## 开发约定

- 提交规范 / 分支模型 / CI 门禁见 `CONTRIBUTING.md`；
- 发布档一律改 `deploy/profile.json`（单一真源），构建期注入；
- 服务端契约改动先改 `sces-server/contracts`，再 `pnpm sync:seed-templates` 同步种子。

> 离线授权链路（授权文件、签发、机器码）随产品转向在线版将逐步退役，模块级下线由 M5 在线化重构按"每提交一模块"推进，不在此次仓库拆分中删代码。