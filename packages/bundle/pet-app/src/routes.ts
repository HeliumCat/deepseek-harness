/**
 * The pet page and its JSON API. The page is a self-contained static document;
 * the API is read-only and token-gated. Everything sits under a single prefix
 * route so the exact MCP route can share the `/pet` namespace.
 *
 * @module @deepseek-ai/dsh-pet-app/routes
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { requestToken, tokenMatches } from './mcp.ts'
import type { PetWorker } from './worker.ts'

/** Page and API paths. */
export interface PetRoutesOptions {
  /** Absolute page path without a trailing slash, such as `/pet`. */
  readonly pagePath: string
  /** Required access token. */
  readonly token: string
}

const ASSETS = new Map<string, string>([
  ['pet.css', 'text/css; charset=utf-8'],
  ['pet.js', 'text/javascript; charset=utf-8'],
  ['pet.html', 'text/html; charset=utf-8'],
])

function assetPath(name: string): string {
  return fileURLToPath(new URL(`../assets/${name}`, import.meta.url))
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: 'unauthorized' })
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'not found' })
}

async function sendAsset(res: ServerResponse, name: string): Promise<void> {
  const type = ASSETS.get(name)
  if (type === undefined) {
    notFound(res)
    return
  }
  const body = await readFile(assetPath(name))
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': String(body.byteLength) })
  res.end(body)
}

/**
 * Register the pet page and API routes.
 * @param ctx - context carrying the web server.
 * @param worker - the delegation service.
 * @param options - page path and access token.
 * @returns the route disposer.
 */
export function mountPetRoutes(ctx: Context, worker: PetWorker, options: PetRoutesOptions): () => void {
  const prefix = options.pagePath
  return ctx.webServer.register({
    kind: 'prefix',
    path: prefix,
    auth: 'anonymous',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://x')
        const pathname = url.pathname
        if (pathname === prefix || pathname === `${prefix}/`) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
            res.end()
            return
          }
          // The page URL has no trailing slash (`/pet?token=…`), so relative
          // asset URLs would resolve above the mounted prefix. Rewrite them
          // onto the configurable prefix instead of relying on the URL form.
          const html = (await readFile(assetPath('pet.html'), 'utf8')).replaceAll('./assets/', `${prefix}/assets/`)
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': String(Buffer.byteLength(html)),
          })
          res.end(req.method === 'HEAD' ? undefined : html)
          return
        }
        const assetPrefix = `${prefix}/assets/`
        if (pathname.startsWith(assetPrefix)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
            res.end()
            return
          }
          await sendAsset(res, pathname.slice(assetPrefix.length))
          return
        }
        const apiPrefix = `${prefix}/api/`
        if (!pathname.startsWith(apiPrefix)) {
          notFound(res)
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (!tokenMatches(options.token, requestToken(req))) {
          unauthorized(res)
          return
        }
        const endpoint = pathname.slice(apiPrefix.length)
        if (endpoint === 'snapshot') {
          sendJson(res, 200, worker.snapshot())
          return
        }
        if (endpoint === 'history') {
          sendJson(res, 200, {
            groups: worker.historyGroups(),
            limit: worker.historyLimit,
            count: worker.historyCount,
          })
          return
        }
        const delegatePrefix = 'delegates/'
        if (endpoint.startsWith(delegatePrefix)) {
          const id = decodeURIComponent(endpoint.slice(delegatePrefix.length))
          if (!/^d-[a-z0-9-]+$/u.test(id)) {
            notFound(res)
            return
          }
          const detail = await worker.detail(id)
          if (detail === undefined) notFound(res)
          else sendJson(res, 200, detail)
          return
        }
        notFound(res)
      })().catch((error: unknown) => {
        worker.logError(error)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
        else res.destroy()
      })
    },
  })
}
