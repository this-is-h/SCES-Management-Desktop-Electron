# SCES-Management-Desktop-Electron — 管理端（Electron 桌面应用）

学生综合素质测评管理系统（SCES）· 管理端。**在线版**：本地 SQLCipher 库为分数/证明材料权威（服务端不存载荷），激活/授权/批次/状态经服务端（`../SCES-Server` / SCES-Server-Vercel）同步；`.dyf` 学生材料仍以加密文件导入（数据面文件交付）。离线授权链（授权文件、机器码、委派）已移除。

## 仓库关系

| 依赖                     | 获取方式                                             | 用途                                                           |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| `@sces/shared`           | git 依赖（本地开发 `file:../SCES-Shared`）           | 数据模型、加密、计算引擎、状态机、校验规则                     |
| `@sces/contracts`        | git 依赖（本地开发 `file:../SCES-Server/contracts`） | 契约种子（`sync-seed-templates` 镜像到 `resources/templates`） |
| `SCES-Web-Vercel（远端） | release CI 跨仓推送                                  | `public/updates/latest.json` 自动更新元数据                    |
| `SCES-Server（远端）     | M5 服务端                                            | 在线 API（契约见 `@sces/contracts`）                           |

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
- 服务端契约改动先改 `SCES-Server`/contracts`，再 `pnpm sync:seed-templates` 同步种子。
