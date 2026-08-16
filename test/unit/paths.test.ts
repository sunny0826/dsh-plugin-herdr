// 项目目录过滤路径匹配（src/paths.ts）单测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { isPathWithin, isPathWithinProject } from '../../src/paths.ts'

// 纯逻辑分支：注入恒等 realpath，跳过文件系统，只测字符串/前缀/大小写语义。
const id = (x: string) => x

// ---------------------------------------------------------------------------
// 空值语义
// ---------------------------------------------------------------------------

test('T02: null / undefined / 空串 → false', () => {
  assert.equal(isPathWithinProject('/a/b', null), false)
  assert.equal(isPathWithinProject('/a/b', undefined), false)
  assert.equal(isPathWithinProject('/a/b', ''), false)
  assert.equal(isPathWithin('/a/b', null, { realpath: id }), false)
  assert.equal(isPathWithin('/a/b', undefined, { realpath: id }), false)
  assert.equal(isPathWithin('/a/b', '', { realpath: id }), false)
})

// ---------------------------------------------------------------------------
// 精确相等与空 root 边界
// ---------------------------------------------------------------------------

test('T02: p === root 精确相等 → true', () => {
  assert.equal(isPathWithinProject('/a/b', '/a/b'), true)
  assert.equal(isPathWithin('/a/b', '/a/b', { realpath: id }), true)
})

test('T02: 空 root + 非空 p → false（空 root 非有效项目根）', () => {
  assert.equal(isPathWithin('', '/x', { realpath: id }), false)
  assert.equal(isPathWithin('', 'x', { realpath: id }), false)
  // p 为空的入口拦截优先：'' root + '' p 也是 false
  assert.equal(isPathWithin('', '', { realpath: id }), false)
})

// ---------------------------------------------------------------------------
// 前缀边界
// ---------------------------------------------------------------------------

test('T02: 前缀边界 /a/b 不算 /a/bc 的祖先 → false', () => {
  assert.equal(isPathWithin('/a/b', '/a/bc', { realpath: id }), false)
  assert.equal(isPathWithin('/a/b', '/a/bc/d', { realpath: id }), false)
})

test('T02: 真实子路径 /a/b/c → true', () => {
  assert.equal(isPathWithin('/a/b', '/a/b/c', { realpath: id }), true)
})

// ---------------------------------------------------------------------------
// 相对 / 绝对混合
// ---------------------------------------------------------------------------

test('T02: 相对 p 按原值比较 → 对绝对 root 恒 false', () => {
  assert.equal(isPathWithin('/a/b', 'x/y', { realpath: id }), false)
  assert.equal(isPathWithin('/a/b', './x', { realpath: id }), false)
  assert.equal(isPathWithin('/a/b', '../x', { realpath: id }), false)
})

// ---------------------------------------------------------------------------
// realpath 归一（真实文件系统；符号链接指向项目内/外/断裂）
// ---------------------------------------------------------------------------

test('T02: realpath 归一——链接指向项目内 → true、指向项目外 → false、断裂 → 回退原值', () => {
  // 项目根 + 项目外根（都用 realpath 归一后的规范路径作基准，规避 macOS /tmp→/private/tmp）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-paths-'))
  const outsideTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'))
  // 先建目录再取 realpath 范式（规避 macOS /tmp→/private/tmp）
  const root = path.join(tmp, 'proj')
  const outsideRoot = path.join(outsideTmp, 'other')
  fs.mkdirSync(root)
  fs.mkdirSync(outsideRoot)
  const rootN = fs.realpathSync(root)
  const outsideRootN = fs.realpathSync(outsideRoot)
  const cleanup = () => {
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.rmSync(outsideTmp, { recursive: true, force: true })
  }
  try {
    // 后续一律用规范路径 rootN / outsideRootN 作基准，realpath 稳定、断裂回退也落在根内
    const realDir = path.join(rootN, 'real')
    fs.mkdirSync(realDir)
    const inLink = path.join(rootN, 'inLink')
    fs.symlinkSync(realDir, inLink, 'dir')

    // 指向项目外的链接
    const outLink = path.join(rootN, 'outLink')
    fs.symlinkSync(outsideRootN, outLink, 'dir')

    // 断裂链接（目标不存在）
    const broken = path.join(rootN, 'broken')
    fs.symlinkSync(path.join(rootN, 'does-not-exist'), broken, 'dir')

    // 直接目录：项目内 true / 项目外 false
    assert.equal(isPathWithinProject(rootN, realDir), true)
    assert.equal(isPathWithinProject(rootN, outsideRootN), false)

    // 符号链接经 realpath 解析：指向项目内 → true
    assert.equal(isPathWithinProject(rootN, inLink), true)
    // 指向项目外 → 解析后为项目外 → false（避免“名字在根内”误判）
    assert.equal(isPathWithinProject(rootN, outLink), false)
    // 断裂链接：realpath 失败回退原值（原值在根内）→ true
    assert.equal(isPathWithinProject(rootN, broken), true)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// win32 分支（注入 sep / caseInsensitive 模拟）
// ---------------------------------------------------------------------------

test('T02: win32 分支——caseInsensitive + 反斜杠分隔符', () => {
  const win = { sep: '\\' as const, realpath: id }
  // 大小写不敏感：C:\Proj 与 c:\proj\src 视为项目内
  assert.equal(isPathWithin('C:\\Proj', 'c:\\proj\\src', { ...win, caseInsensitive: true }), true)
  // 精确相等（大小写不同）→ true
  assert.equal(isPathWithin('C:\\Proj', 'c:\\proj', { ...win, caseInsensitive: true }), true)
  // 大小写敏感（默认非 win32 语义）→ false
  assert.equal(isPathWithin('C:\\Proj', 'c:\\proj\\src', { ...win, caseInsensitive: false }), false)
})

test('T02: 默认包装 isPathWithinProject 在非 win32（本机 macOS）下大小写敏感', () => {
  // /tmp 与 /TMP 不同；两处 realpath 均失败回退原值
  assert.equal(isPathWithin('/a/b', '/A/B', { realpath: id }), false)
})
