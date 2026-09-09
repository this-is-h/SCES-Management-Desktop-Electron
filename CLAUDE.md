# SCES-Management-Desktop-Electron — 管理端

学生综合素质测评管理系统（SCES）· 管理端（Electron + Vue 3 + Nuxt UI + better-sqlite3）。
**在线版**：本地 SQLCipher 库为分数/证明材料权威（服务端不存载荷），激活/授权/批次/状态经服务端（SCES-Server / SCES-Server-Vercel）同步；离线授权链（授权文件、机器码、委派、时钟守卫）已移除。

## 开发规范（必读，新会话遵守）

本仓库采用**简化版 Git Flow** 与 **Conventional Commits（约定式提交）**，由 husky 钩子与 CI 强制落地。详情见 `CONTRIBUTING.md`。

### 分支模型

- 长期分支：`main`（生产，仅发布，禁直推）、`develop`（日常开发，默认分支，PR 指向这里）
- 短期分支：`feature/*`、`bugfix/*`、`hotfix/*`、`chore/*`、`release/*`（从 develop 创建，完成 PR 合并回 develop；hotfix 从 main 创建，合并回 main 与 develop）
- 分支名必须以前缀开头（CI 校验）；`main`/`develop` 开启保护（个人账号仓库暂无法强制，需自觉遵守）

### 提交规范（commit-msg 钩子强制）

格式：`<type>(<scope>): <subject>`

- `type` 必填：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `build` `ci` `revert`
- `scope` 可选、小写（本仓：main/preload/renderer/ipc/db/services/gateway/scripts/deploy/resources/build/docs/ci/deps）
- `subject` 必填：祈使句、首字母小写、**≤50 字符**、句尾无句号；header ≤72
- 违规提交会被 commitlint 直接拒绝（示例：`fix(services): 修正批次上报重试`）

### 提交纪律

- 每提交解决一个问题；单次 ≤300 行；提交前自测（`pnpm typecheck` + 相关验证）

### 钩子与 CI 门禁

- `pre-commit`：`lint-staged`（eslint --fix + prettier）+ 全仓 `pnpm typecheck`（node + web 两套）；`commit-msg`：commitlint
- CI：编译 + Lint + 类型 + `pnpm audit`(high) + gitleaks + 分支名
- 发布：tag 触发 release.yml（Windows）：构建安装包 → 生成 `dist-update/latest.json` → **跨仓推送**到 SCES-Server 的 `updates/latest.json` → 上传 GitHub Release
- 跨仓推送与私有依赖拉取依赖仓库 secret `SCES_CI_TOKEN`（fine-grained PAT）

## 仓库结构（已随拆分拍平到仓库根）

| 路径                   | 职责                                                           |
| ---------------------- | -------------------------------------------------------------- |
| `src/main/`            | 主进程：db / services / gateway（dual-mode）/ ipc              |
| `src/preload/`         | 暴露给渲染层的类型安全 API                                     |
| `src/renderer/`        | Vue 渲染层（@nuxt/ui）                                         |
| `resources/templates/` | 契约种子镜像（`scripts/sync-seed-templates.mjs` 同步，勿手改） |
| `deploy/profile.json`  | 发布档单一真源（构建期注入：mode/serverUrl/updateUrl）         |
| `scripts/`             | 构建/校验脚本                                                  |
| `docs/`                | desktop-auto-update 等随仓文档                                 |

## 仓库依赖

| 依赖           | 获取方式                                                                                  | 用途                                   |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| `@sces/shared` | git 依赖（SCES-Shared.git#semver）                                                        | 数据模型、加密、计算引擎、状态机、校验 |
| 契约种子       | `sync-seed-templates`（源：`../SCES-Server/contracts/seed` 或 env `SCES_CONTRACTS_SEED`） | resources/templates 镜像               |

## 开发要点

- `pnpm build` 前置门禁：`sync-seed-templates`（契约种子逐字节一致）+ `build-profile --apply`（发布档校验）；
- `@sces/shared` 以 TS 源码打包进 bundle（electron.vite.config.ts `externalizeDeps.exclude`），原生依赖保持 externalize；
- 发布档一律改 `deploy/profile.json`（单一真源），服务端 API 地址与更新源（`https://sces.thisish.cn/updates/latest.json`）构建期注入；
- 授权/批次/申请状态经 gateway online 上报；申请密钥本地持有（解密历史 .dyf），公钥随激活上报。

## 命令（仓库根）

```sh
pnpm install
pnpm dev                 # electron-vite 开发模式
pnpm typecheck           # 类型检查（node + web）
pnpm lint                # ESLint
pnpm build               # 种子同步 + profile 校验 + 构建 + 类型检查
pnpm build:win           # Windows 安装包
pnpm gen:update-manifest # 生成 dist-update/latest.json
```
