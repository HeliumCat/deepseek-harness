/**
 * The pet application bundle's frontend: one resident worker, one localhost MCP
 * endpoint, one token-gated pet page, and one transparent Electron viewer.
 *
 * @module @deepseek-ai/dsh-pet-app
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { mountPetMcp } from './mcp.ts'
import { mountPetRoutes } from './routes.ts'
import { ensurePetToken, petUrls } from './token.ts'
import { openPetWindow, type PetWindowHandle, type WindowMode } from './window.ts'
import { PetWorker } from './worker.ts'

/** Cordis plugin identity. */
export const name = 'pet-app'

/** Services the worker, MCP endpoint, and pet page require. */
export const inject = [
  'webServer',
  'agents',
  'agentPresets',
  'agentDefaultModel',
  'sessions',
  'sessionPersistence',
  'subagents',
]

/** Pet worker configuration, changeable from the profile patch. */
export interface Config {
  /** Absolute directory worker sessions run in. */
  workspace: string
  /** Absolute directory holding the capped history. */
  historyRoot: string
  /** Maximum retained delegations. @default 1000 */
  historyLimit: number
  /** Agent preset mounted for the worker main agent. @default 'pet-worker' */
  presetId: string
  /** Absolute MCP endpoint path. @default '/pet/mcp' */
  mcpPath: string
  /** Absolute pet page path. @default '/pet' */
  pagePath: string
  /** Absolute file storing the pet access token. */
  tokenFile: string
  /** Viewer opened after readiness. @default 'auto' */
  windowMode: WindowMode
  /** Explicit Electron executable or package directory; otherwise auto-resolved. */
  electronPath?: string
}

/** Schemastery configuration for the profile row. */
export const Config: Schema<Config> = Schema.object({
  workspace: Schema.string().required(),
  historyRoot: Schema.string().required(),
  historyLimit: Schema.natural().min(1).max(100_000).default(1000),
  presetId: Schema.string().min(1).default('pet-worker'),
  mcpPath: Schema.string().min(1).default('/pet/mcp'),
  pagePath: Schema.string().min(1).default('/pet'),
  tokenFile: Schema.string().required(),
  windowMode: Schema.union([
    Schema.const('auto' as const),
    Schema.const('electron' as const),
    Schema.const('browser' as const),
    Schema.const('none' as const),
  ]).default('auto'),
  electronPath: Schema.string(),
})

/** Validate an absolute directory setting. */
function requireAbsolute(field: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`pet-app: config.${field} must be an absolute path, got ${JSON.stringify(value)}`)
  return value
}

/** Validate an absolute route path. */
function requireRoutePath(field: string, value: string): string {
  if (!value.startsWith('/') || value === '/' || value.endsWith('/')) {
    throw new Error(`pet-app: config.${field} must be an absolute path without a trailing slash, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Codex's TOML entry for this endpoint. */
function codexSnippet(mcpUrl: string): string {
  return [
    '[mcp_servers.dsh_pet]',
    `url = ${JSON.stringify(mcpUrl)}`,
    'startup_timeout_sec = 120',
    'tool_timeout_sec = 3600',
    'enabled_tools = ["subagent_delegate"]',
  ].join('\n')
}

/**
 * Mount the worker, the pet page, the MCP endpoint, and the viewer.
 * @param ctx - context carrying the web server and agent services.
 * @param config - validated profile configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const workspace = requireAbsolute('workspace', config.workspace)
  const historyRoot = requireAbsolute('historyRoot', config.historyRoot)
  const tokenFile = requireAbsolute('tokenFile', config.tokenFile)
  const mcpPath = requireRoutePath('mcpPath', config.mcpPath)
  const pagePath = requireRoutePath('pagePath', config.pagePath)
  if (mcpPath === pagePath) throw new Error('pet-app: config.mcpPath and config.pagePath must differ')
  const token = await ensurePetToken(tokenFile)
  const urls = petUrls(ctx.webServer.getOrigin(), pagePath, mcpPath, token)
  const worker = new PetWorker(ctx, {
    workspace,
    historyRoot,
    historyLimit: config.historyLimit,
    presetId: config.presetId,
    mcpUrl: urls.mcp,
    pageUrl: urls.page,
  })
  await worker.start()
  ctx.provide('petWorker', worker)
  const routes = mountPetRoutes(ctx, worker, { pagePath, token })
  const mcp = mountPetMcp(ctx, worker, mcpPath, token)
  let viewer: PetWindowHandle | undefined
  let disposed = false

  console.log(`dsh pet: pet page ${urls.page}`)
  console.log(`dsh pet: MCP endpoint ${urls.mcp}`)
  console.log('dsh pet: add this Codex MCP server entry:')
  console.log(codexSnippet(urls.mcp))

  const launch = (): void => {
    if (disposed) return
    void openPetWindow({
      pageUrl: urls.page,
      mode: config.windowMode,
      ...config.electronPath === undefined ? {} : { electronPath: config.electronPath },
      log: (message) => { worker.logError(new Error(message)) },
    }).then((handle) => {
      if (disposed) void handle.close()
      else viewer = handle
    }).catch((error: unknown) => { worker.logError(error) })
  }
  const ready = ctx.get('appReady')
  if (ready === undefined) launch()
  else ctx.effect(() => ready.onReady(launch), 'pet-app: launch pet window on readiness')

  ctx.effect(() => async () => {
    disposed = true
    await viewer?.close()
    routes()
    mcp.route()
    await mcp.close()
    await worker.dispose()
  }, 'pet-app: lifetime')
}
