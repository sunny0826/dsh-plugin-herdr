// scripts/gen-types.mjs
// 从 herdr api schema --json 生成 src/client/types.ts（M0 最小子集）。
// 用法：node scripts/gen-types.mjs [--live]   （--live 时直接跑 herdr api schema，否则用 fixtures 快照）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'src/client/types.ts')

// ---------- 输入 ----------
let schema, sourceNote
if (process.argv.includes('--live')) {
  const raw = execFileSync('herdr', ['api', 'schema', '--json'], { encoding: 'utf8' })
  schema = JSON.parse(raw)
  sourceNote = 'live herdr api schema'
} else {
  schema = JSON.parse(readFileSync(join(root, 'test/fixtures/herdr-api.schema.json'), 'utf8'))
  sourceNote = 'test/fixtures/herdr-api.schema.json'
}

// ---------- 目标方法子集（M0） ----------
const METHODS = [
  'session.snapshot', 'agent.list', 'agent.wait', 'agent.get', 'agent.explain',
  'pane.split', 'pane.send_text', 'pane.send_keys', 'pane.wait_for_output',
  'pane.read', 'pane.report_agent', 'pane.report_metadata', 'pane.clear_agent_authority',
  'workspace.create', 'events.subscribe', 'events.wait', 'layout.export', 'layout.apply',
  'notification.show', 'agent.prompt', 'agent.send_keys',
]

// ---------- JSON Schema → TS ----------
const defs = schema.schemas.request.$defs
const refName = (ref) => ref.split('/').pop()

// 需要具名导出的共享 $defs（enum → type；object → interface），按引用收集
const named = new Map() // name -> def
const collect = (node) => {
  if (!node || typeof node !== 'object') return
  if (node.$ref) {
    const name = refName(node.$ref)
    if (!named.has(name) && defs[name]) {
      named.set(name, defs[name])
      collect(defs[name])
    }
    return
  }
  for (const key of ['properties', 'items', 'additionalProperties']) {
    if (node[key] && typeof node[key] === 'object') {
      if (key === 'properties') for (const v of Object.values(node[key])) collect(v)
      else collect(node[key])
    }
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(node[key])) for (const v of node[key]) collect(v)
  }
}
const methodsDefs = {} // method -> def name
for (const variant of schema.schemas.request.oneOf) {
  const m = variant.properties.method.const
  if (!METHODS.includes(m)) continue
  const pname = variant.properties.params.$ref.split('/').pop()
  methodsDefs[m] = pname
  if (defs[pname]) {
    const d = defs[pname]
    const renderable = d.enum || d.oneOf || d.anyOf || (d.properties && Object.keys(d.properties).length > 0) || d.type === 'object'
    if (renderable && !named.has(pname)) named.set(pname, d)
    collect(d)
  }
}

const typeMap = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean' }

function tsType(node, depth = 0) {
  if (!node || typeof node !== 'object') return 'unknown'
  if (node.$ref) return refName(node.$ref)
  if (node.const !== undefined) return JSON.stringify(node.const)
  if (node.enum && node.enum.length > 0) {
    return node.enum.map(v => JSON.stringify(v)).join(' | ')
  }
  const oneOf = node.oneOf ?? node.anyOf
  if (Array.isArray(oneOf)) {
    return [...new Set(oneOf.map(x => tsType(x, depth + 1)))].join(' | ')
  }
  const types = Array.isArray(node.type) ? node.type : [node.type ?? 'unknown']
  const nullable = types.includes('null')
  const base = types.filter(t => t !== 'null')
  let out = 'unknown'
  if (base.includes('object') || base.length === 0 && nullable) {
    const addl = node.additionalProperties
    if (node.properties) {
      const props = Object.entries(node.properties).map(([k, v]) => {
        const req = Array.isArray(node.required) && node.required.includes(k)
        return '  ' + k + (req ? '' : '?') + ': ' + tsType(v, depth + 1)
      })
      if (addl && typeof addl === 'object' && Object.keys(addl).length > 0) {
        props.push('  [key: string]: ' + tsType(addl, depth + 1))
      }
      out = '{\n' + props.join('\n') + '\n' + '  '.repeat(Math.max(0, depth)) + '}'
    } else if (addl && typeof addl === 'object' && Object.keys(addl).length > 0) {
      out = '{ [key: string]: ' + tsType(addl, depth + 1) + ' }'
    } else {
      out = 'Record<string, unknown>'
    }
  } else if (base.includes('array')) {
    out = node.items ? tsType(node.items, depth + 1) + '[]' : 'unknown[]'
  } else if (base.length === 1 && typeMap[base[0]]) {
    out = typeMap[base[0]]
  }
  return nullable ? out + ' | null' : out
}

function renderNamed(name, def) {
  if (def.enum) {
    return 'export type ' + name + ' = ' + def.enum.map(v => JSON.stringify(v)).join(' | ')
  }
  if (def.oneOf || def.anyOf) {
    const parts = [...new Set((def.oneOf ?? def.anyOf).map(x => tsType(x)))]
    return 'export type ' + name + ' = ' + parts.join(' | ')
  }
  // object interface
  const props = Object.entries(def.properties ?? {}).map(([k, v]) => {
    const req = Array.isArray(def.required) && def.required.includes(k)
    return '  ' + k + (req ? '' : '?') + ': ' + tsType(v)
  })
  const addl = def.additionalProperties
  if (addl && typeof addl === 'object' && Object.keys(addl).length > 0) {
    props.push('  [key: string]: ' + tsType(addl))
  }
  if (props.length === 0) return 'export interface ' + name + ' {}'
  return 'export interface ' + name + ' {\n' + props.join('\n') + '\n}'
}

// ---------- 输出 ----------
const lines = []
lines.push('/**')
lines.push(' * Generated from herdr api schema (' + sourceNote + ').')
lines.push(' * Source: protocol ' + schema.protocol + ', schema_version ' + schema.schema_version)
lines.push(' * Generated by scripts/gen-types.mjs — DO NOT EDIT BY HAND.')
lines.push(' * Subset (M0): ' + METHODS.join(', '))
lines.push(' */')
lines.push('')
lines.push('// ---------- 共享类型（按引用收集） ----------')
for (const [name, def] of named) {
  lines.push(renderNamed(name, def))
  lines.push('')
}
lines.push('// ---------- 方法参数 ----------')
for (const [m, pname] of Object.entries(methodsDefs)) {
  const def = defs[pname]
  if (named.has(pname)) {
    lines.push('// ' + m + ' -> ' + pname + '（已在上方共享类型中声明）')
  } else if (def && (def.properties || def.oneOf || def.anyOf)) {
    lines.push(renderNamed(pname, def))
    lines.push('')
  } else {
    lines.push('// ' + m + ' -> ' + pname + '（无参数或由共享类型覆盖）')
  }
}
lines.push('// ---------- 请求映射 ----------')
lines.push('export interface HerdrRequestMap {')
for (const m of Object.keys(methodsDefs)) {
  lines.push("  '" + m + "': { method: '" + m + "'; params: " + methodsDefs[m] + ' }')
}
lines.push('}')
lines.push('')
lines.push('export type HerdrMethod = keyof HerdrRequestMap')

writeFileSync(OUT, lines.join('\n') + '\n')
console.log('wrote', OUT, '| methods:', Object.keys(methodsDefs).length, '| shared types:', named.size)
