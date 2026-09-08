# 贡献指南（sces-management · 管理端）

本仓库采用**简化版 Git Flow** 与 **Conventional Commits（约定式提交）**，全部由钩子与 CI 强制落地。

## 分支模型

| 分支 | 生命周期 | 用途 |
|---|---|---|
| `main` | 永久 | 生产分支，仅存放已发布稳定版本；**禁止直接提交/推送**，只接受 develop→main 的发布合并 |
| `develop` | 永久 | 日常开发主分支（默认分支），所有 PR 指向这里 |
| `feature/*` / `bugfix/*` / `chore/*` | 短期 | 功能 / 缺陷 / 杂务，从 develop 创建，完成后 PR 合并回 develop |
| `hotfix/*` | 短期 | 紧急修复，从 main 创建，完成后合并回 main 与 develop |
| `release/*` | 短期 | 发布准备 |

规则：分支名必须符合前缀（CI 拒绝违规分支）；`develop`/`main` 开启保护（强制 PR + 状态检查；`main` 禁止直推）。

## 提交规范（commit-msg 钩子强制）

格式：`<type>(<scope>): <subject>`

- `type` 必填：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `build` `ci` `revert`
- `scope` 可选，小写：本仓常用 `main` `preload` `renderer` `ipc` `db` `services` `gateway` `scripts` `deploy` `resources` `build` `docs` `ci` `deps`
- `subject` 必填：一般现在时 + 祈使句；首字母小写；≤50 字符；句尾无句号
- header ≤72 字符；需要详述时在空行后写正文（原因/方案/影响）

示例：`feat(services): 添加批次状态上报重试`、`fix(renderer): 修正总体情况分页溢出`

配套纪律（评审把关）：每提交单一问题；单次 ≤300 行；提交前 `pnpm typecheck` + 相关自测。

## Pre-commit 钩子

- `commit-msg`：commitlint 校验消息格式，不合规直接拒绝提交。
- `pre-commit`：`lint-staged`（eslint --fix + prettier --write 仅处理暂存文件）+ 全仓 `pnpm typecheck`（node + web 两套）。

## CI 门禁（不通过无法合并）

| 门禁 | 工具 | 阈值 |
|---|---|---|
| 编译 | `pnpm build`（electron-vite + seed 同步 + 文档/许可校验） | 失败即红 |
| 类型 | `tsc` + `vue-tsc` | 0 error |
| Lint | ESLint | 0 error |
| 供应链 | `pnpm audit` | high 及以上阻断 |
| 密钥泄漏 | gitleaks（Actions） | 发现即红 |
| 分支名 | CI 脚本 | 前缀违规即红 |

> 单元测试门禁：本仓库暂未建测试套件；纳入后按团队基线补 vitest + 覆盖率 ≥80% 门禁（见 sces-shared 的落地形态）。

## 发布流程

1. `develop` 成熟 → 合并 `main` 并打 `vX.Y.Z` tag；
2. `release.yml`（tag 触发，Windows runner）：`pnpm build` → electron-builder 出安装包（`DMS_PROFILE_ID` 取自 `deploy/profile.json`）→ 生成 `dist-update/latest.json` → **跨仓推送**到 `this-is-h/sces-web` 的 `public/updates/latest.json`（触发 Vercel 自动部署）→ 上传安装包到 GitHub Release；
3. 跨仓推送与私有依赖拉取需要仓库级 Actions secret `SCES_CI_TOKEN`（fine-grained PAT：sces-web `Contents:write` + sces-shared/sces-server `Contents:read`）。

## 关键文件

- `deploy/profile.json`：发布档单一真源（服务端 API 地址、logo 档标识、更新源），构建期由 electron.vite 注入；
- `scripts/build-profile.mjs`：发布档 schema + 模式一致性校验（构建前置门禁）；
- `scripts/sync-seed-templates.mjs`：从 `@sces/contracts` 包镜像契约种子到 `resources/templates`（逐字节一致，`--check` 供 CI）。