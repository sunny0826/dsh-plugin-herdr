/**
 * CA-007：HTTP 控制面（/herdr-status、/herdr-session-pane、/herdr-start）的
 * 可信本地上下文守卫。
 *
 * 威胁模型：DSH web server 绑定 localhost，任何可访问该端口的进程/浏览器页面
 * 都能打控制面。本守卫把请求限定为"可信本地上下文"：
 * - 严格方法校验（requireMethod，405 + Allow）；
 * - Host allowlist（仅 localhost/127.0.0.1/::1）——抵御 DNS rebinding（外部域名
 *   解析到 127.0.0.1 时 Host 不是本地名，直接拒绝）；
 * - Origin 同源校验（有 Origin 时必须与 Host 一致）——跨站浏览器请求（CSRF）拒绝；
 * - Sec-Fetch-Site: cross-site 拒绝——现代浏览器兜底（含无 Origin 的 <img> GET）。
 *
 * 无 Origin/Sec-Fetch-Site 的请求（curl、本机工具、同源 GET）放行——本机进程
 * 本就拥有该用户权限，属于可信本地上下文。
 */

/** Node IncomingMessage 的最小子集（webServer handler 入参）。 */
export interface GuardedRequest {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}

export interface GuardResult {
  ok: boolean
  /** 拒绝时的 HTTP 状态码（400/403/405）。 */
  status: number
  message: string
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 从 Host 头解析主机名（剥端口与 IPv6 括号）。 */
export function hostnameOfHost(host: string | undefined): string | undefined {
  if (!host) return undefined
  let h = host.trim()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    if (end >= 0) return h.slice(1, end).toLowerCase()
  }
  const colon = h.indexOf(':')
  if (colon >= 0) {
    // host:port 或裸 IPv6（如 ::1）。端口部分必须全数字才剥离，否则整体视为 IPv6 主机名
    const port = h.slice(colon + 1)
    if (/^\d+$/.test(port)) h = h.slice(0, colon)
  }
  return h.toLowerCase()
}

/** 可信本地上下文校验（方法校验之外的宿主/来源边界）。 */
export function guardLocalRequest(req: GuardedRequest): GuardResult {
  const headers = req.headers ?? {}
  const get = (name: string): string | undefined => {
    const v = headers[name.toLowerCase()]
    return Array.isArray(v) ? v[0] : v
  }
  const host = hostnameOfHost(get('host'))
  if (!host) return { ok: false, status: 400, message: 'missing Host header' }
  if (!LOCAL_HOSTNAMES.has(host)) {
    return { ok: false, status: 403, message: `untrusted Host: ${host} (control surface is localhost-only)` }
  }
  const origin = get('origin')
  if (origin) {
    let originHost: string | undefined
    try {
      originHost = hostnameOfHost(new URL(origin).host)
    } catch {
      return { ok: false, status: 400, message: 'malformed Origin header' }
    }
    if (originHost !== host) {
      return { ok: false, status: 403, message: 'cross-origin request rejected (Origin != Host)' }
    }
  }
  const secFetchSite = get('sec-fetch-site')
  if (secFetchSite === 'cross-site') {
    return { ok: false, status: 403, message: 'cross-site request rejected (Sec-Fetch-Site)' }
  }
  return { ok: true, status: 200, message: 'ok' }
}

/** 严格方法校验：不匹配返回 405（调用方附 Allow 头）。 */
export function requireMethod(req: GuardedRequest, allowed: string): GuardResult {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === allowed.toUpperCase()) return { ok: true, status: 200, message: 'ok' }
  return { ok: false, status: 405, message: `method ${method} not allowed (use ${allowed.toUpperCase()})` }
}
