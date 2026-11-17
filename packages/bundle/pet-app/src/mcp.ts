/**
 * The localhost MCP endpoint for calling Agents. One stateless Streamable HTTP handler
 * serves tool discovery and delegation. The endpoint authenticates with the pet
 * access token carried in the URL or a bearer header.
 *
 * @module @deepseek-ai/dsh-pet-app/mcp
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createMcpHandler, Server, type CallToolResult, type McpHttpHandler, type Tool } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import type { PetWorker } from './worker.ts'
import type { DelegateInput, DelegateOutcome } from './types.ts'

/** Server name shown to connected MCP clients. */
const MCP_SERVER_NAME = 'dsh_pet'

const LIST_MODELS_TOOL: Tool = {
  name: 'list_subagent_models',
  title: 'List DSH subagent models',
  description: 'List subagent models or inspect one model’s reasoning efforts and adapter default.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      provider: { type: 'string', minLength: 1, description: 'Provider ID. Omit to list models from all registered providers.' },
      model: { type: 'string', minLength: 1, description: 'Exact model ID. Requires provider. Include to get supported efforts and the adapter default.' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}

const DELEGATE_TOOL: Tool = {
  name: 'subagent_delegate',
  title: 'Delegate to DSH subagents',
  description:
    'Delegate one concrete task to the resident DeepSeek Harness worker and wait for its result. The worker analyzes the '
    + 'task, runs one or more DSH subagents, checks the result against your acceptance criteria, and returns the expected '
    + 'content.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      agentSession: {
        type: 'string',
        minLength: 1,
        description: 'Name for the calling Agent’s conversation. Reuse it within this conversation and choose a distinct name for any other conversation.',
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
      subagentModel: {
        type: 'object',
        description: 'Model for every new subagent in this delegation. Use IDs from list_subagent_models. Omit for normal DSH model selection.',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', minLength: 1, description: 'Provider ID.' },
          model: { type: 'string', minLength: 1, description: 'Model ID within that provider.' },
        },
        required: ['provider', 'model'],
      },
      reasoningEffort: {
        type: 'string', minLength: 1,
        description: 'Effort ID for new subagents. Use an advertised ID. Omit for max on models with selectable efforts.',
      },
      maxDepth: {
        type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'Maximum descendant depth. Direct children are depth 1. Omit to use the DSH depth setting.',
      },
      maxSubagents: {
        type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'Maximum cumulative subagent creations across all depths for this delegation, including completed runs. Omit for no cumulative cap.',
      },
    },
    required: ['agentSession', 'task', 'acceptanceCriteria', 'expectedReturn'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
}

const INSTRUCTIONS =
  'Use `subagent_delegate` for substantial work you can hand off with clear acceptance criteria. '
  + 'If choosing a specific subagent model or reasoning effort, use `list_subagent_models` to get the available IDs first.'

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
 * Render one delegation outcome as the text the calling Agent receives.
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

/** Parse MCP delegation arguments before starting any work. */
function delegateInput(args: Record<string, unknown>): DelegateInput | string {
  const agentSession = requiredString(args, 'agentSession')
  const task = requiredString(args, 'task')
  const acceptanceCriteria = requiredString(args, 'acceptanceCriteria')
  const expectedReturn = requiredString(args, 'expectedReturn')
  if (agentSession === undefined || task === undefined || acceptanceCriteria === undefined || expectedReturn === undefined) {
    return 'subagent_delegate requires non-empty agentSession, task, acceptanceCriteria, and expectedReturn strings.'
  }
  const model = args['subagentModel']
  let subagentModel: DelegateInput['subagentModel']
  if (model !== undefined) {
    if (typeof model !== 'object' || model === null || Array.isArray(model) || Object.keys(model).length !== 2
      || !('provider' in model) || typeof model.provider !== 'string' || model.provider.trim() === ''
      || !('model' in model) || typeof model.model !== 'string' || model.model.trim() === '') {
      return 'subagentModel requires non-empty provider and model strings from list_subagent_models.'
    }
    subagentModel = { provider: model.provider.trim(), model: model.model.trim() }
  }
  const reasoningEffort = requiredString(args, 'reasoningEffort')?.trim()
  if (reasoningEffort === undefined && args['reasoningEffort'] !== undefined) {
    return 'reasoningEffort must be a non-empty effort ID from list_subagent_models.'
  }
  const maxDepth = args['maxDepth']
  const maxSubagents = args['maxSubagents']
  if (maxDepth !== undefined && (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth < 1)) {
    return 'maxDepth must be a positive safe integer.'
  }
  if (maxSubagents !== undefined && (typeof maxSubagents !== 'number' || !Number.isSafeInteger(maxSubagents) || maxSubagents < 1)) {
    return 'maxSubagents must be a positive safe integer.'
  }
  return {
    agentSession, task, acceptanceCriteria, expectedReturn,
    ...subagentModel === undefined ? {} : { subagentModel },
    ...reasoningEffort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(reasoningEffort) },
    ...maxDepth === undefined ? {} : { maxDepth },
    ...maxSubagents === undefined ? {} : { maxSubagents },
  }
}

/**
 * Build the MCP handler over one worker. A failed, cancelled, or rejected delegation
 * sets the MCP error flag and retains the delegation result text.
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
    server.setRequestHandler('tools/list', () => ({ tools: [LIST_MODELS_TOOL, DELEGATE_TOOL] }))
    server.setRequestHandler('tools/call', async (request, extra): Promise<CallToolResult> => {
      const { name } = request.params
      const args = request.params.arguments ?? {}
      const signal = extra.mcpReq.signal
      try {
        if (name === LIST_MODELS_TOOL.name) {
          const provider = requiredString(args, 'provider')?.trim()
          const model = requiredString(args, 'model')?.trim()
          if (provider === undefined && args['provider'] !== undefined) return failure('provider must be a non-empty string.')
          if (model === undefined && args['model'] !== undefined) return failure('model must be a non-empty string.')
          const catalog = await worker.listSubagentModels({
            ...provider === undefined ? {} : { provider },
            ...model === undefined ? {} : { model },
          }, signal)
          return { ...text(JSON.stringify(catalog)), structuredContent: { ...catalog } }
        }
        if (name === DELEGATE_TOOL.name) {
          const input = delegateInput(args)
          if (typeof input === 'string') return failure(input)
          const outcome = await worker.delegate(input, signal)
          const result = outcomeText(outcome)
          return outcome.status !== 'completed' || outcome.acceptance?.accepted === false ? failure(result) : text(result)
        }
        return failure(`unknown tool ${JSON.stringify(name)}`)
      } catch (error) {
        return failure(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
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
