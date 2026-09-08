import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'
// 模式真源：deploy/profile.json（由 scripts/build-profile.mjs 生成，进 git）。
// tsconfig.node.json 继承的 @electron-toolkit/tsconfig 已开启 resolveJsonModule，
// 故此处可直接 JSON import，无需 readFileSync + JSON.parse。
import profile from './deploy/profile.json'
import pkg from './package.json'

// 构建期断言：profile 与模式自相矛盾时，宁可构建失败，也不静默带病发布。
// offline 档必须 serverUrl === null；online 档必须 serverUrl 非 null。
if (profile.mode === 'offline' && profile.management.serverUrl !== null) {
  throw new Error(
    `profile.json 模式为 offline，但 management.serverUrl 非 null（${profile.management.serverUrl}）。` +
      '离线档不得携带服务端地址，请检查 deploy/profile.json。'
  )
}
if (profile.mode === 'online' && profile.management.serverUrl === null) {
  throw new Error(
    'profile.json 模式为 online，但 management.serverUrl 为 null。' +
      '在线档必须配置服务端地址，请检查 deploy/profile.json。'
  )
}

export default defineConfig({
  main: {
    // 双模式注入：一律来自 deploy/profile.json（唯一真源），不再是 process.env。
    // 常量在构建期被 Rollup 折叠，离线档里 online.ts 整块会被摇掉，安装包不含服务端地址。
    define: {
      __DMS_MODE__: JSON.stringify(profile.mode),
      __DMS_PROFILE_ID__: JSON.stringify(profile.profileId),
      // offline 下为空串：任何误用都会立刻在 dev 里暴露，而不是静默打到 example.com
      __DMS_SERVER_URL__: JSON.stringify(profile.management.serverUrl ?? ''),
      __DMS_LICENSE_VERIFY_KEYS__: JSON.stringify(profile.management.licenseVerifyKeys ?? []),
      __DMS_CLOCK_GUARD__: JSON.stringify(
        profile.management.clockGuard ?? { enabled: false, toleranceMs: 0 }
      ),
      // 自动更新检查源（deploy/profile.json 单一真源；offline 可 null→空串→无更新通道）
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
      __DMS_PROFILE_ID__: JSON.stringify(profile.profileId),
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
      // 离线可用（不依赖 Iconify API，符合管理端离线优先与 CSP 约束）。
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
