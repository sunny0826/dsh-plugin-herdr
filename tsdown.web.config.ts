import { defineConfig } from 'tsdown'

// Web 客户端 bundle：浏览器平台，JSX，外部化 react / dsh client 依赖
// （运行时由 web shell 的 ClientModuleLoader 解析，见 dsh-client-modules）。
// banner/footer 生成 __ModuleLoader__.load 注册包装（factory 单参 require，返回 exports）。
const MODULE_LOADER_ID = 'dsh-plugin-herdr'

export default defineConfig({
  entry: ['src/client.tsx'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  dts: true,
  clean: false,
  banner: () => `window.__ModuleLoader__.load({
  id: "${MODULE_LOADER_ID}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`,
  footer: () => `
    return module.exports;
  }
});
`,
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/cordis',
  ],
})
