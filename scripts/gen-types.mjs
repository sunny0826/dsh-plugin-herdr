// scripts/gen-types.mjs
// 从 herdr api schema --json 生成 src/client/types.ts。
// 覆盖：请求参数（M0 子集）+ 响应结果分支 + 错误体 + 事件/订阅事件。
// 用法：
//   node scripts/gen-types.mjs           用 fixture 生成并写回
//   node scripts/gen-types.mjs --live    直接跑 herdr api schema（本地已安装 herdr）
//   node scripts/gen-types.mjs --check   校验已提交的 types.ts 与 fixture 无漂移（退出码 1 表示漂移）
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
  'notification.show', 'agent.prompt', 'agent.send_keys', 'agent.start',
]

// ---------- 方法 → 响应分支映射（CA-004） ----------
// ResponseResult 是带 type const 的 oneOf（57 个分支），schema 未编码 method→result 映射，
// 这里维护策展映射并在生成时校验分支存在（不存在即 fixture 漂移，直接报错）。
// 已按真实 herdr 0.8.0 / protocol 19 实测校准（docs/env-findings 与本地 socket 探针）：
//   agent.wait → agent_info（CLI 与 raw socket 均返回 agent_info，而非 wait_matched）
//   pane.split → pane_info；pane.read → pane_read；agent.prompt → agent_prompted；
//   workspace.create → workspace_created；layout.export → layout_export；
//   events.wait → wait_matched（events.wait 等待事件匹配）
const RESULT_BRANCHES = {
  'session.snapshot': 'session_snapshot',
  'agent.list': 'agent_list',
  'agent.get': 'agent_view',
  'agent.wait': 'agent_info',
  'agent.explain': 'agent_explain',
  'agent.prompt': 'agent_prompted',
  'agent.send_keys': 'ok',
  'agent.start': 'agent_started',
  'pane.split': 'pane_info',
  'pane.send_text': 'ok',
  'pane.send_keys': 'ok',
  'pane.read': 'pane_read',
  'pane.wait_for_output': 'output_matched',
  'pane.report_agent': 'ok',
  'pane.report_metadata': 'ok',
  'pane.clear_agent_authority': 'ok',
  'workspace.create': 'workspace_created',
  'events.subscribe': 'subscription_started',
  'events.wait': 'wait_matched',
  'layout.export': 'layout_export',
  'layout.apply': 'layout_apply',
  'notification.show': 'notification_show',
}

// ---------- JSON Schema → TS ----------
const defs = schema.schemas.request.$defs
const refName = (ref) => ref.split('/').pop()

/** 所有域（request/response/event/subscription_event/error）的 $defs，供名称冲突检查。 */
const allDefs = {}
for (const key of ['request', 'success_response', 'event', 'subscription_event', 'error_response']) {
  Object.assign(allDefs, schema.schemas[key].$defs)
}

// 需要具名导出的共享 $defs（enum → type；object → interface），按引用收集
const named = new Map() // name -> def
const collect = (node) => {
  if (!node || typeof node !== 'object') return
  if (node.$ref) {
    const name = refName(node.$ref)
    if (!named.has(name) && allDefs[name]) {
      named.set(name, allDefs[name])
      collect(allDefs[name])
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

const methodsDefs = {} // method -> params def name
for (const variant of schema.schemas.request.oneOf) {
  const m = variant.properties.method.const
  if (!METHODS.includes(m)) continue
  const pname = variant.properties.params.$ref.split('/').pop()
  methodsDefs[m] = pname
  if (allDefs[pname]) {
    const d = allDefs[pname]
    const renderable = d.enum || d.oneOf || d.anyOf || (d.properties && Object.keys(d.properties).length > 0) || d.type === 'object'
    if (renderable && !named.has(pname)) named.set(pname, d)
    collect(d)
  }
}

// 响应分支：method -> { const, branchNode }
const responseOneOf = schema.schemas.success_response.$defs.ResponseResult.oneOf
const branchByConst = new Map(responseOneOf.map(b => [b.properties?.type?.const, b]))
const resultBranches = {} // method -> { const, node, typeName }
for (const [m, c] of Object.entries(RESULT_BRANCHES)) {
  const node = branchByConst.get(c)
  if (!node) {
    throw new Error(`gen-types: response branch '${c}' for '${m}' not found in fixture (protocol drift?)`)
  }
  const pascal = c.replace(/(^|_)(\w)/g, (_, __, ch) => ch.toUpperCase())
  let typeName = pascal + 'Result'
  if (allDefs[typeName] || named.has(typeName)) typeName = pascal + 'BranchResult'
  resultBranches[m] = { const: c, node, typeName }
  collect(node)
}

// 错误体（error_response.$defs.ErrorBody）
const errorBody = schema.schemas.error_response.$defs.ErrorBody
collect(errorBody)

// 事件（event.$defs）与订阅事件（subscription_event.$defs）
const eventDefs = schema.schemas.event.$defs
const subEventDefs = schema.schemas.subscription_event.$defs
collect(eventDefs.EventKind)
collect(eventDefs.EventData)
collect(subEventDefs.SubscriptionEventKind)
collect(subEventDefs.SubscriptionEventData)

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
lines.push(' * Sections: params / result branches / error / event / subscription event')
lines.push(' */')
lines.push('')
lines.push('// ---------- 共享类型（按引用收集） ----------')
for (const [name, def] of named) {
  lines.push(renderNamed(name, def))
  lines.push('')
}
lines.push('// ---------- 方法参数 ----------')
for (const [m, pname] of Object.entries(methodsDefs)) {
  const def = allDefs[pname]
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
lines.push('')
lines.push('// ---------- 响应结果分支（CA-004） ----------')
const emittedBranches = new Set()
for (const [m, { const: c, typeName }] of Object.entries(resultBranches)) {
  lines.push('// ' + m + ' -> ' + c)
  if (!emittedBranches.has(c)) {
    emittedBranches.add(c)
    lines.push(renderNamed(typeName, branchByConst.get(c)))
    lines.push('')
  }
}
lines.push('export interface HerdrResultMap {')
for (const [m, { typeName }] of Object.entries(resultBranches)) {
  lines.push("  '" + m + "': " + typeName)
}
lines.push('}')
lines.push('')
lines.push('// ---------- 错误体（CA-004） ----------')
lines.push(renderNamed('HerdrErrorBody', errorBody))
lines.push('')
lines.push('// ---------- 事件（CA-004） ----------')
lines.push(renderNamed('HerdrEventKind', eventDefs.EventKind))
lines.push('')
lines.push(renderNamed('HerdrEventData', eventDefs.EventData))
lines.push('')
lines.push('export interface HerdrEvent {')
lines.push('  event: HerdrEventKind')
lines.push('  data: HerdrEventData')
lines.push('}')
lines.push('')
lines.push('// ---------- 订阅事件（CA-004） ----------')
lines.push(renderNamed('HerdrSubscriptionEventKind', subEventDefs.SubscriptionEventKind))
lines.push('')
lines.push(renderNamed('HerdrSubscriptionEventData', subEventDefs.SubscriptionEventData))
lines.push('')
lines.push('export interface HerdrSubscriptionEvent {')
lines.push('  event: HerdrSubscriptionEventKind')
lines.push('  data: HerdrSubscriptionEventData')
lines.push('}')

const content = lines.join('\n') + '\n'

// ---------- 落盘 / 校验 ----------
if (process.argv.includes('--check')) {
  let current
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    current = ''
  }
  if (current === content) {
    console.log('gen-types: src/client/types.ts is up to date (no drift)')
    process.exit(0)
  }
  console.error('gen-types: DRIFT — src/client/types.ts is stale (fixture changed?). Run: node scripts/gen-types.mjs')
  process.exit(1)
}

writeFileSync(OUT, content)
console.log('wrote', OUT, '| methods:', Object.keys(methodsDefs).length, '| result branches:', Object.keys(resultBranches).length, '| shared types:', named.size)
