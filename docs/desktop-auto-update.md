# GitHub Actions 发布自动更新 — 配置说明

发布流程：打 `v*` tag 或手动 dispatch → GitHub Actions 构建 Windows 安装包 →
上传到 GitHub Release → 生成 `latest.json` 提交到 `web/public/updates/`（Vercel git 集成自动部署到同一域名）。

## 需要的 Secrets（仓库 Settings → Secrets and variables → Actions）

| Secret                 | 用途                                                                                                   | 是否必填        |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | --------------- |
| 无                     | 若 web 预览版走 Vercel **Git 集成**（推荐），latest.json 提交后 Vercel 自动部署，**无需 VERCEL_TOKEN** | —               |
| `VERCEL_TOKEN`（可选） | 若改用 `vercel deploy` CLI 直接部署，需 `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID`                          | 仅用 CLI 部署时 |

> 说明：当前 workflow 采用「提交 latest.json 到 web/ → Vercel git 集成自动部署」，
> 复用现有 web 预览版项目与未备案域名，**零新增密钥**。安装包本体存 GitHub Release
> （长期存档），下载页给 GitHub 直链 + 国内加速镜像（ghproxy）两个兜底链接。

## 配置点（发布前检查）

1. **`deploy/profile.json` → `management.updateUrl`**：管理端主进程 `updater.ts` 拉取的检查地址。

   当前值：`https://dms.thisish.cn/updates/latest.json`（已配置，无需改）。

2. **`web/public/download.html`**：下载页里 `ghUrl` / `mirrorPrefix` 两常量，改为真实仓库

   `https://github.com/this-is-h/SCES-Management-Desktop-Electron`（当前已是）。

3. **版本号**：`management/desktop/package.json` 的 `version`（当前 `0.1.0`）与 git tag 保持一致（CI 生成 latest.json 时读取它）。

## 本地生成元数据（不改仓库也能预览）

```sh
node scripts/gen-update-manifest.mjs            # 用 desktop/package.json 的 version
node scripts/gen-update-manifest.mjs 0.3.0      # 指定版本
```

## 验证发布链路

1. 打 tag：`git tag v0.2.0 && git push origin v0.2.0`
2. Actions 跑完：GitHub Release 出现 `学生综合素质测评管理系统-0.2.0-setup.exe`
3. `https://<你的Vercel域名>/updates/latest.json` 返回最新版本
4. `https://<你的Vercel域名>/download` 打开下载页，两个链接均可点

- 启动延迟 ~15s + 24h 节流自动检查（仅打包态）；失败静默，不影响主流程。
- **侧边栏底部版本按钮**（账号切换之上）：显示当前版本号（如 `v0.1.0`）；点击手动检查更新。
  自动检查发现新版时（弹窗可能被忽略），该按钮变为绿色并显示下载图标 + `新版 X` 徽标提示，
  点击即跳转下载页。收缩态下仅显示图标，展开态显示完整标签。
- 设置 → 通用 → 更新：手动触发检查；发现新版弹提示并引导去下载页手动安装（不自动覆盖安装包）。
- 网络失败/无更新通道返回 null，不打扰用户。
