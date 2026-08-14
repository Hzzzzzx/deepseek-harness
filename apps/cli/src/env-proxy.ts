/**
 * Environment-proxy bootstrap: make the process-wide `fetch` honor
 * `http_proxy`/`https_proxy`/`no_proxy` without requiring the launcher to
 * pass `--use-env-proxy` / `NODE_USE_ENV_PROXY=1`.
 *
 * Node only evaluates its own env-proxy switch at process startup, so a
 * server started from a launcher that did not export the flag (a GUI, an old
 * terminal, a detached session) silently serves direct connections even when
 * the proxy variables are present — for providers whose endpoints require a
 * proxy this surfaces only at request time as an opaque `fetch failed`.
 *
 * Node's bundled undici resolves the global fetch dispatcher through
 * `Symbol.for('undici.globalDispatcher.1')` on every request, so installing
 * an `EnvHttpProxyAgent` there before the first fetch gives the process the
 * same semantics as the startup switch, from userland. When the launcher did
 * enable the startup switch, or no proxy variables exist at all, this module
 * installs nothing and the platform behavior stands.
 *
 * Import for side effects, first in the entry module, before any import that
 * could touch the network.
 * @module @deepseek-ai/dsh/bin
 */

import { EnvHttpProxyAgent } from 'undici'

/** Proxy variables the platform switch would honor; presence gates the patch. */
const PROXY_ENV_NAMES = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'] as const

const launcherEnabledEnvProxy = process.env.NODE_USE_ENV_PROXY !== undefined
  && process.env.NODE_USE_ENV_PROXY !== ''
  && process.env.NODE_USE_ENV_PROXY !== '0'
const hasProxyEnv = PROXY_ENV_NAMES.some((name) => {
  const value = process.env[name]
  return value !== undefined && value !== ''
})

if (!launcherEnabledEnvProxy && hasProxyEnv) {
  ;(globalThis as Record<symbol, unknown>)[Symbol.for('undici.globalDispatcher.1')] =
    new EnvHttpProxyAgent()
}
