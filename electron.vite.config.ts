import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
// 配置真源：deploy/profile.json（进 git）。在线版唯一交付形态。
// tsconfig.node.json 继承的 @electron-toolkit/tsconfig 已开启 resolveJsonModule，
// 故此处可直接 JSON import，无需 readFileSync + JSON.parse。
import profile from './deploy/profile.json'
import pkg from './package.json'

// 构建期断言：profile 与在线形态相悖时宁可构建失败，也不静默带病发布。
if (typeof profile.management.serverUrl !== 'string' || profile.management.serverUrl === '') {
  throw new Error(
    'profile.json 缺少 management.serverUrl：在线版必须配置服务端地址，请检查 deploy/profile.json。'
  )
}

export default defineConfig({
  main: {
    // 构建期注入（deploy/profile.json 唯一真源），常量在构建期被 Rollup 折叠。
    define: {
      __DMS_PROFILE_ID__: JSON.stringify(profile.profileId),
      __DMS_SERVER_URL__: JSON.stringify(profile.management.serverUrl),
      // 自动更新检查源（deploy/profile.json 单一真源）
      __DMS_UPDATE_URL__: JSON.stringify(profile.management.updateUrl ?? '')
    },
    build: {
      // @sces/shared 以 TS 源码形式被 workspace 引用，需打包进 bundle；
      // better-sqlite3 等原生依赖保持 externalize（运行时从 node_modules 加载）。
      externalizeDeps: { exclude: ['@sces/shared'] }
    }
  },
  preload: {},
  renderer: {
    // 渲染层同样注入构建期常量（AppLayout 引用 __DMS_VERSION__；缺失会在运行时 ReferenceError 白屏）
    define: {
      __DMS_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
      __DMS_UPDATE_URL__: JSON.stringify(profile.management.updateUrl ?? '')
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue(),
      // electron-vite 的 renderer root 指向 src/renderer，ui() 默认按 Vite root 生成
      // .nuxt-ui 主题模板（会落到 src/renderer/node_modules 内，Tailwind 扫不到，导致
      // bg-default / ring-default 等主题类缺失）。必须用 root 指向项目根。
      // 管理端无 vue-router，关闭 Nuxt UI 路由集成。
      // icon.clientBundle.scan：扫描源码中的 i-lucide-* 用法并内联图标数据，
      // 避免运行时依赖 Iconify API（CSP default-src 'self' 约束）。
      ui({
        root: __dirname,
        router: false,
        // 配色与 dashboard-vue 模板一致（见其 vite.config.ts）：primary=green, neutral=zinc
        ui: {
          colors: {
            primary: 'green',
            neutral: 'zinc'
          }
        },
        icon: {
          clientBundle: {
            scan: true
          }
        }
      })
    ]
  }
})
