/**
 * The localhost MCP endpoint Codex calls. One stateless Streamable HTTP handler
 * serves a single `subagent_delegate` tool; the endpoint authenticates with the
 * pet access token carried in the URL or a bearer header.
 *
 * @module @deepseek-ai/dsh-pet-app/mcp
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createMcpHandler, Server, type CallToolResult, type McpHttpHandler, type Tool } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import type { PetWorker } from './worker.ts'
import type { DelegateOutcome } from './types.ts'

/** Server name shown to connected MCP clients. */
const MCP_SERVER_NAME = 'dsh_pet'

/** The one tool Codex sees. */
const DELEGATE_TOOL: Tool = {
  name: 'subagent_delegate',
  title: 'Delegate to a DSH subagent worker',
  description:
    'Delegate one concrete task to the resident DeepSeek Harness worker and wait for its result. The worker analyzes the '
    + 'task, runs one or more DSH subagents, checks the result against your acceptance criteria, and returns the expected '
    + 'content. Pass the same codexSession value for every call in one Codex conversation; it is the history grouping key, '
    + 'not a session id. The call blocks until the worker finishes; do not repeat work this call already covers.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      codexSession: {
        type: 'string',
        description: 'Human-readable name of the current Codex conversation, stable across this conversation\'s calls.',
      },
      task: {
        type: 'string',
        description: 'The complete task to delegate, with every fact the subagent needs.',
      },
      acceptanceCriteria: {
        type: 'string',
        description: 'How the worker must judge success before returning the result.',
      },
      expectedReturn: {
        type: 'string',
        description: 'The content, format, and scope the worker should return.',
      },
    },
    required: ['codexSession', 'task', 'acceptanceCriteria', 'expectedReturn'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
}

const INSTRUCTIONS =
  'DeepSeek Harness pet worker: delegate substantial work to the resident worker with `subagent_delegate`. '
  + 'The worker analyzes the task, spawns DSH subagents, verifies the acceptance criteria, and returns the expected '
  + 'content. Pass the same `codexSession` conversation name on every call in this conversation; use a new name only for '
  + 'a different conversation. The call blocks until the worker finishes. The worker may split the task across several '
  + 'subagents, so the result can combine more than one subagent report.'

/** Package version reported to MCP clients. */
function packageVersion(): string {
  const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/** MCP text result. */
function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

/** MCP error text. */
function failure(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }], isError: true }
}

/**
 * Render one delegation outcome as the text Codex receives.
 * @param outcome - the terminal delegation outcome.
 * @returns the tool result text.
 */
export function outcomeText(outcome: DelegateOutcome): string {
  const acceptance = outcome.acceptance === undefined
    ? 'not recorded'
    : outcome.acceptance.accepted ? 'accepted' : 'rejected'
  const lines = [
    `Delegate: ${outcome.id}`,
    `Status: ${outcome.status}`,
    `Acceptance: ${acceptance}`,
  ]
  if (outcome.acceptance !== undefined) lines.push(`Acceptance notes: ${outcome.acceptance.notes}`)
  if (outcome.error !== undefined) lines.push(`Error: ${outcome.error}`)
  lines.push('', outcome.text === '' ? '(the worker returned no text)' : outcome.text)
  return lines.join('\n')
}

/** Read one required string argument, or return a validation failure. */
function requiredString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Build the MCP handler over one worker.
 * @param worker - the delegation service.
 * @returns a fetch-shaped MCP handler; call `close()` on teardown.
 */
export function createPetMcpHandler(worker: PetWorker): McpHttpHandler {
  const version = packageVersion()
  return createMcpHandler(() => {
    // oxlint-disable-next-line typescript/no-deprecated -- this handler owns its per-request tool list; see createPetMcpHandler.
    const server = new Server({ name: MCP_SERVER_NAME, version }, {
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
    })
    server.setRequestHandler('tools/list', () => ({ tools: [DELEGATE_TOOL] }))
    server.setRequestHandler('tools/call', async (request, extra): Promise<CallToolResult> => {
      if (request.params.name !== DELEGATE_TOOL.name) {
        return failure(`unknown tool ${JSON.stringify(request.params.name)}`)
      }
      const args = request.params.arguments ?? {}
      const codexSession = requiredString(args, 'codexSession')
      const task = requiredString(args, 'task')
      const acceptanceCriteria = requiredString(args, 'acceptanceCriteria')
      const expectedReturn = requiredString(args, 'expectedReturn')
      if (codexSession === undefined || task === undefined || acceptanceCriteria === undefined || expectedReturn === undefined) {
        return failure('subagent_delegate requires non-empty codexSession, task, acceptanceCriteria, and expectedReturn strings.')
      }
      try {
        const outcome = await worker.delegate({ codexSession, task, acceptanceCriteria, expectedReturn }, extra.mcpReq.signal)
        const result = text(outcomeText(outcome))
        return outcome.status === 'completed' ? result : { ...result, isError: true }
      } catch (error) {
        return failure(`subagent_delegate failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return server
  }, {
    onerror: (error) => { worker.logError(error) },
  })
}

/**
 * Constant-time token comparison over fixed-width digests.
 * @param expected - the stored access token.
 * @param provided - the token presented by the request.
 * @returns whether the provided token matches.
 */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false
  const left = createHash('sha256').update(expected).digest()
  const right = createHash('sha256').update(provided).digest()
  return timingSafeEqual(left, right)
}

/**
 * Read the token from the authorization header or the query string.
 * @param req - the HTTP request.
 * @returns the presented token, or undefined.
 */
export function requestToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice('Bearer '.length)
  try {
    const url = new URL(req.url ?? '/', 'http://x')
    return url.searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

/** Answer one unauthorized request. */
function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: 'unauthorized: open the pet page URL printed by dsh for the access token' }))
}

/**
 * Mount the MCP endpoint on the DSH web server.
 * @param ctx - context carrying the web server.
 * @param worker - the delegation service.
 * @param path - absolute endpoint path.
 * @param token - required access token.
 * @returns disposers for the route and the MCP handler.
 */
export function mountPetMcp(
  ctx: Context,
  worker: PetWorker,
  path: string,
  token: string,
): { readonly route: () => void; readonly close: () => Promise<void> } {
  const handler = createPetMcpHandler(worker)
  const nodeHandler = toNodeHandler(handler, { onerror: (error) => { worker.logError(error) } })
  const route = ctx.webServer.register({
    kind: 'exact',
    path,
    auth: 'anonymous',
    handler: (req, res) => {
      if (!tokenMatches(token, requestToken(req))) {
        unauthorized(res)
        return
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST, HEAD', 'cache-control': 'no-store' })
        res.end()
        return
      }
      // The adapter's structural request type requires method/url to be
      // present; node:http always sets them on a server request.
      const incoming: NodeIncomingMessageLike = {
        method: req.method ?? 'POST',
        url: req.url ?? '/',
        headers: req.headers,
        [Symbol.asyncIterator]: () => req[Symbol.asyncIterator](),
      }
      void nodeHandler(incoming, res).catch((error: unknown) => {
        worker.logError(error)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'internal MCP error' }))
        } else res.destroy()
      })
    },
  })
  return {
    route,
    close: async () => { await handler.close() },
  }
}
