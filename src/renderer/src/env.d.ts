/// <reference types="vite/client" />

/**
 * 自动更新检查源（electron.vite.config.ts define）。来源 deploy/profile.json.management.updateUrl。
 * 为 latest.json 的完整地址；offline 未配置时为空串（无更新通道，仅打包态检查）。
 * 说明：tsconfig.web.json 会编译 src/preload/types.ts 及其引入的 main/services/updater.ts，
 * 而该文件引用了此全局常量，故在此重复声明供 web 编译单元解析。
 */
declare const __DMS_UPDATE_URL__: string

/** 桌面端版本号（electron.vite.config.ts 构建期注入，同步可用）。 */
declare const __DMS_VERSION__: string