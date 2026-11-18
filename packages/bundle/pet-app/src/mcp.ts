/**
 * The localhost MCP endpoint for calling Agents. One stateless Streamable HTTP handler
 * serves tool discovery and delegation. The endpoint authenticates with the pet
 * access token carried in the URL or a bearer header.
 *
 * @module @deepseek-ai/dsh-pet-app/mcp
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { parseOffsetInstant } from '@deepseek-ai/dsh-util-time'
import { createMcpHandler, ResourceNotFoundError, Server, type CallToolResult, type McpHttpHandler, type Resource, type Tool } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { parseDelegateInput, requiredString } from './delegate-input.ts'
import { parsePetScheduleId, type RecurringPlan } from './recurring-schedules.ts'
import type { PetWorker } from './worker.ts'
import type { DelegateInput, DelegateOutcome, DelegateScheduleTiming } from './types.ts'

/** Server name shown to connected MCP clients. */
const MCP_SERVER_NAME = 'dsh_pet'

const SUBAGENT_GUIDE: Resource = {
  uri: 'dsh-pet://guides/subagent-management',
  name: 'subagent-management',
  title: 'Subagent creation and management',
  description: 'Full policy for deciding when to delegate, granting access, verifying results, and handling artifacts.',
  mimeType: 'text/markdown',
}

const READ_GUIDE_TOOL: Tool = {
  name: 'read_subagent_guide',
  title: 'Read the DSH subagent guide',
  description: 'Read the full Subagent creation and management guide when the client cannot read MCP resources.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}

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
  title: 'Delegate to a DSH subagent',
  description:
    'Run one independent, scoped assignment and return the execution subagent’s output for your verification. '
    + `Follow the guide at ${SUBAGENT_GUIDE.uri} or call read_subagent_guide.`,
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
        description: 'Give the goal, exact inputs, steps, and constraints. Resolve ambiguity before delegating. The task is forwarded as supplied.',
      },
      acceptanceCriteria: {
        type: 'string',
        description: 'Specify each check, its method, and the expected result. For deliverables that support unit testing, '
          + 'specify the unit tests the calling Agent will write and run.',
      },
      expectedReturn: {
        type: 'string',
        description: 'The output format, required files or evidence, and status or blockers the execution subagent should return.',
      },
      subagentModel: {
        type: 'object',
        description: 'Model for every new subagent in this delegation. Use IDs from list_subagent_models. Omit to use the Pet profile default.',
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

const SCHEDULE_TOOL: Tool = {
  name: 'subagent_schedule',
  title: 'Schedule a DSH subagent assignment',
  description: 'Schedule an independent assignment once or at a fixed interval. Pet runs it in the background '
    + 'and stores each result in Pet history. The call returns when the schedule is saved.',
  inputSchema: {
    ...DELEGATE_TOOL.inputSchema,
    properties: {
      ...DELEGATE_TOOL.inputSchema.properties,
      runAt: { type: 'string', format: 'date-time', description: 'Future RFC 3339 timestamp with Z or a numeric UTC offset.' },
      delaySeconds: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Delay from submission in whole seconds.' },
      everySeconds: {
        type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'Repeat at this fixed interval in seconds. The first run is one interval after submission. For example, 300 means every five minutes.',
      },
      durationSeconds: {
        type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'Elapsed seconds from submission until a recurring plan ends. A start scheduled exactly at the deadline is eligible.',
      },
      maxRuns: {
        type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: 'End the recurring plan after this many dispatches. Skipped occurrences do not count.',
      },
    },
    oneOf: [{ required: ['runAt'] }, { required: ['delaySeconds'] }, { required: ['everySeconds'] }],
    dependentRequired: { durationSeconds: ['everySeconds'], maxRuns: ['everySeconds'] },
  },
  annotations: DELEGATE_TOOL.annotations,
}

const MANAGE_SCHEDULE_TOOL: Tool = {
  name: 'subagent_schedule_manage',
  title: 'Manage a recurring DSH subagent schedule',
  description: 'View a recurring plan and its latest retained result, or pause, resume, or stop its future runs.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      scheduleId: { type: 'string', description: 'Recurring schedule ID returned by subagent_schedule.' },
      action: { type: 'string', enum: ['view', 'pause', 'resume', 'stop'] },
    },
    required: ['scheduleId', 'action'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}

const INSTRUCTIONS =
  'Delegate only independent work with explicit scope and verifiable results. The calling Agent plans, authorizes, '
  + 'and independently verifies the result. The lead subagent forwards the assignment and returns the execution output. '
  + 'When asked to monitor a run, prefer delegating read-only checks with a known status source, check interval, and stop conditions. '
  + 'For independent assignments that Pet should repeat, use subagent_schedule with everySeconds. '
  + `Read the Subagent creation and management guide at ${SUBAGENT_GUIDE.uri} or with read_subagent_guide.`

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
  const lines = [
    `Delegate: ${outcome.id}`,
    `Status: ${outcome.status}`,
    `Stop reason: ${outcome.stopReason}`,
    'Verification: required by the calling Agent',
  ]
  if (outcome.error !== undefined) lines.push(`Error: ${outcome.error}`)
  lines.push('', outcome.text === '' ? '(the execution subagent returned no text)' : outcome.text)
  return lines.join('\n')
}

/** Check tool-specific fields before decoding the shared assignment. */
function delegateInput(args: Record<string, unknown>, schema: Tool['inputSchema']): DelegateInput | string {
  const input = parseDelegateInput(args)
  if (typeof input === 'string') return input
  const fields = schema.properties ?? {}
  const unsupported = Object.keys(args).filter(key => !Object.hasOwn(fields, key))
  return unsupported.length === 0
    ? input
    : `Unsupported delegation arguments: ${unsupported.join(', ')}. Read read_subagent_guide for supported limits.`
}

function scheduleTiming(args: Record<string, unknown>): DelegateScheduleTiming | string {
  const runAt = args['runAt']
  const delaySeconds = args['delaySeconds']
  if ((runAt === undefined) === (delaySeconds === undefined)) return 'Provide exactly one of runAt, delaySeconds, or everySeconds.'
  if (runAt !== undefined) {
    if (typeof runAt === 'string') {
      const parsed = parseOffsetInstant(runAt)
      if (parsed.kind === 'accepted') return { runAt: parsed.epoch }
    }
    return 'runAt must be a valid RFC 3339 timestamp with an explicit UTC offset or Z.'
  }
  return typeof delaySeconds === 'number' && Number.isSafeInteger(delaySeconds) && delaySeconds > 0
    ? { delaySeconds }
    : 'delaySeconds must be a positive safe integer.'
}

function planContent(plan: RecurringPlan) {
  return {
    scheduleId: plan.id,
    agentSession: plan.input.agentSession,
    status: plan.status,
    everySeconds: plan.everySeconds,
    ...plan.status !== 'active' || (plan.endsAt !== undefined && plan.nextRunAt > plan.endsAt)
      ? {} : { nextRunAt: new Date(plan.nextRunAt).toISOString() },
    runCount: plan.runCount,
    ...plan.endsAt === undefined ? {} : { endsAt: new Date(plan.endsAt).toISOString() },
    ...plan.maxRuns === undefined ? {} : { maxRuns: plan.maxRuns },
    ...plan.endReason === undefined ? {} : { endReason: plan.endReason },
    skippedRuns: plan.skippedRuns,
    ...plan.lastSkipReason === undefined ? {} : { lastSkipReason: plan.lastSkipReason },
  }
}

/**
 * Build the MCP handler for delegation and the caller's management guide.
 * A failed or cancelled execution sets the MCP error flag and retains partial output.
 * @param worker - the delegation service.
 * @returns a fetch-shaped MCP handler; call `close()` on teardown.
 */
export function createPetMcpHandler(worker: PetWorker): McpHttpHandler {
  const version = packageVersion()
  const guide = readFileSync(new URL('../assets/subagent-management.md', import.meta.url), 'utf8')
  return createMcpHandler(() => {
    // oxlint-disable-next-line typescript/no-deprecated -- this handler owns its per-request tool list; see createPetMcpHandler.
    const server = new Server({ name: MCP_SERVER_NAME, version }, {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: INSTRUCTIONS,
    })
    server.setRequestHandler('resources/list', () => ({ resources: [SUBAGENT_GUIDE] }))
    server.setRequestHandler('resources/read', ({ params: { uri } }) => {
      if (uri !== SUBAGENT_GUIDE.uri) throw new ResourceNotFoundError(uri)
      return { contents: [{ uri, mimeType: SUBAGENT_GUIDE.mimeType, text: guide }] }
    })
    server.setRequestHandler('tools/list', () => ({
      tools: [LIST_MODELS_TOOL, READ_GUIDE_TOOL, DELEGATE_TOOL, SCHEDULE_TOOL, MANAGE_SCHEDULE_TOOL],
    }))
    server.setRequestHandler('tools/call', async (request, extra): Promise<CallToolResult> => {
      const { name } = request.params
      const args = request.params.arguments ?? {}
      const signal = extra.mcpReq.signal
      try {
        if (name === READ_GUIDE_TOOL.name) {
          return Object.keys(args).length === 0 ? text(guide) : failure('read_subagent_guide takes no arguments.')
        }
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
          const input = delegateInput(args, DELEGATE_TOOL.inputSchema)
          if (typeof input === 'string') return failure(input)
          const outcome = await worker.delegate(input, signal)
          const result = outcomeText(outcome)
          return outcome.status === 'completed' ? text(result) : failure(result)
        }
        if (name === SCHEDULE_TOOL.name) {
          const input = delegateInput(args, SCHEDULE_TOOL.inputSchema)
          if (typeof input === 'string') return failure(input)
          const everySeconds = args['everySeconds']
          const durationSeconds = args['durationSeconds']
          const maxRuns = args['maxRuns']
          if (everySeconds === undefined && (durationSeconds !== undefined || maxRuns !== undefined)) {
            return failure('durationSeconds and maxRuns require a recurring everySeconds schedule.')
          }
          if (everySeconds !== undefined) {
            if (args['runAt'] !== undefined || args['delaySeconds'] !== undefined) {
              return failure('Provide exactly one of runAt, delaySeconds, or everySeconds.')
            }
            if (typeof everySeconds !== 'number') return failure('everySeconds must be a positive whole number.')
            if (durationSeconds !== undefined && typeof durationSeconds !== 'number') {
              return failure('durationSeconds must be a positive whole number.')
            }
            if (maxRuns !== undefined && typeof maxRuns !== 'number') return failure('maxRuns must be a positive whole number.')
            const plan = planContent(await worker.repeat(input, {
              everySeconds, ...durationSeconds === undefined ? {} : { durationSeconds }, ...maxRuns === undefined ? {} : { maxRuns },
            }, signal))
            return { ...text(JSON.stringify(plan)), structuredContent: plan }
          }
          const timing = scheduleTiming(args)
          if (typeof timing === 'string') return failure(timing)
          const receipt = await worker.schedule(input, timing, signal)
          const scheduledAt = new Date(receipt.scheduledAt).toISOString()
          return {
            ...text(`Delegate: ${receipt.id}\nStatus: scheduled\nScheduled start: ${scheduledAt}\nFind the result in Pet history.`),
            structuredContent: { id: receipt.id, status: 'scheduled', scheduledAt },
          }
        }
        if (name === MANAGE_SCHEDULE_TOOL.name) {
          const id = parsePetScheduleId(args['scheduleId'])
          const action = args['action']
          if (id === undefined || Object.keys(args).length !== 2
            || (action !== 'view' && action !== 'pause' && action !== 'resume' && action !== 'stop')) {
            return failure('Provide a recurring scheduleId and one action: view, pause, resume, or stop.')
          }
          const { plan, lastRun, inFlight } = await worker.manageSchedule(id, action, signal)
          const latest = lastRun !== undefined ? {
            id: lastRun.id, status: lastRun.status,
            ...lastRun.scheduledAt === undefined ? {} : { scheduledAt: new Date(lastRun.scheduledAt).toISOString() },
            ...lastRun.result === undefined ? {} : { result: lastRun.result },
            ...lastRun.error === undefined ? {} : { error: lastRun.error },
          } : plan.lastRunId === undefined ? undefined : {
            id: plan.lastRunId, status: inFlight ? 'queued' : 'unavailable',
          }
          const result = { ...planContent(plan), ...latest === undefined ? {} : { lastRun: latest } }
          return { ...text(JSON.stringify(result)), structuredContent: result }
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
