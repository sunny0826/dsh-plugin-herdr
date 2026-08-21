#!/usr/bin/env node
/**
 * 启动一个全新、空白、仅带本插件的 DSH 实例。
 * - 隔离的 DSH_HOME = <repo>/.dsh-blank
 * - 单个 profile: blank，bundles 仅含 dsh-base + dsh-web-app + 本插件
 * - 每次启动前自动 pnpm build + 重建 profile 依赖
 */
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const blankHome = resolve(repoRoot, '.dsh-blank')
const profileName = 'blank'
const profileDir = join(blankHome, 'profiles', profileName)
const DSH_CLI = resolve(process.env.HOME ?? '', 'codes/deepseek-harness/apps/cli/lib/bin.js')
const DSH_SRC = resolve(process.env.HOME ?? '', 'codes/deepseek-harness/apps/cli/src/bin.ts')

const reset = process.argv.includes('--reset')

function log(msg) {
  console.log(`[blank-dsh] ${msg}`)
}

function ensureProfile() {
  if (reset && existsSync(blankHome)) {
    log(`重置 ${blankHome}`)
    rmSync(blankHome, { recursive: true, force: true })
  }
  mkdirSync(profileDir, { recursive: true })

  // package.json —— 仅本插件
  const pkg = {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {
      'dsh-plugin-herdr': `link:${repoRoot}`,
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-herdr'],
      },
    },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  writeFileSync(
    join(profileDir, 'pnpm-workspace.yaml'),
    `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n`,
  )
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    `# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n`,
  )
  // 空的 cordis.yml 由框架生成，这里不创建
}

function buildPlugin() {
  log('构建插件 pnpm build ...')
  execSync('pnpm build', { cwd: repoRoot, stdio: 'inherit' })
}

function installProfile() {
  log(`安装 profile 依赖 ${profileDir}`)
  // 使用 pnpm 安装 profile 依赖（hoisted 需 pnpm）
  execSync('pnpm install --no-frozen-lockfile', { cwd: profileDir, stdio: 'inherit' })
}

function launch() {
  const cli = existsSync(DSH_CLI) ? DSH_CLI : existsSync(DSH_SRC) ? DSH_SRC : null
  if (!cli) {
    console.error('[blank-dsh] 找不到 dsh CLI，请确认 ~/codes/deepseek-harness 已克隆且已构建')
    console.error('  期望:', DSH_CLI)
    process.exit(1)
  }
  // 端口：主 profile 已占 3080，空白实例用 3081 避免 EADDRINUSE；用户可通过 --port 覆盖
  const portArg = (() => {
    const idx = process.argv.indexOf('--port')
    if (idx !== -1 && process.argv[idx + 1]) return ['--port', process.argv[idx + 1]]
    return ['--port', '3081']
  })()
  const isSrc = cli.endsWith('src/bin.ts')
  const args = isSrc
    ? ['--import', 'tsx/esm', cli, '--profile', profileName, ...portArg]
    : [cli, '--profile', profileName, ...portArg]
  const nodeBin = process.execPath

  log(`DSH_HOME=${blankHome}`)
  log(`profile=${profileName}  bundles=[dsh-base, dsh-web-app, dsh-plugin-herdr]`)
  log(`启动: ${isSrc ? `node ${args.join(' ')}` : `node ${args.join(' ')}`}`)
  log('按 Ctrl+C 停止，数据保留在 .dsh-blank/ 中，--reset 可清空重来')

  const child = spawn(nodeBin, args, {
    cwd: repoRoot,
    env: { ...process.env, DSH_HOME: blankHome },
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    log(`dsh 已退出 code=${code}`)
    process.exit(code ?? 0)
  })
}

ensureProfile()
buildPlugin()
installProfile()
launch()
