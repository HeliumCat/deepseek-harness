/**
 * The pet profile end to end through the built CLI: `subagent_delegate`
 * MCP call drives the worker main agent through one subagent delegation and one
 * acceptance verdict, and the pet history APIs expose the settled record.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const bin = join(repoRoot, 'apps/cli/lib/bin.js')
const built = existsSync(bin) && existsSync(join(repoRoot, 'packages/bundle/pet-app/lib/index.js'))
const mockUrl = new URL('./fixtures/pet-mock-llm.mjs', import.meta.url).href

/** One JSON-RPC response frame, narrowed to the fields this spec reads. */
interface JsonRpcFrame {
  result?: {
    serverInfo?: { name?: string }
    instructions?: string
    tools?: { name: string; inputSchema: object }[]
    isError?: boolean
    content?: { type?: string; text?: string }[]
    structuredContent?: { models: { provider: string; model: string; name: string }[]; unavailableProviders: string[] }
  }
}

/** The pet snapshot API body, narrowed to the fields this spec reads. */
interface SnapshotBody {
  historyCount: number
  active: { subagents: unknown[] }[]
}

/** The pet history API body, narrowed to the fields this spec reads. */
interface HistoryBody {
  limit: number
  groups: { agentSession: string; entries: { id: string; accepted: boolean }[] }[]
}

/** One delegation record, narrowed to the fields this spec reads. */
interface RecordBody {
  agentSession: string
  status: string
  transcript: { text?: string }[]
  subagents: { sessionId: string; parentSessionId: string; output?: string; transcript: { text?: string }[] }[]
  acceptance?: { accepted: boolean }
}

/** Temp patch overriding the pet worker to a keyless, viewerless local run. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pet-e2e-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const flat = (value: string): string => value.replaceAll('\\', '/')
  const patch = join(root, 'pet.patch.yml')
  writeFileSync(patch, [
    '- id: agent-default-model',
    '  config:',
    '    provider: cli-mock',
    '    model: cli-mock',
    '',
    '- insert:',
    '    - id: pet-mock-llm',
    `      name: ${JSON.stringify(mockUrl)}`,
    '',
    '- id: pet-worker',
    '  config:',
    `    workspace: ${JSON.stringify(flat(root))}`,
    `    historyRoot: ${JSON.stringify(flat(join(home, 'pet', 'history')))}`,
    '    historyLimit: 4',
    '    presetId: pet-worker',
    '    mcpPath: /pet/mcp',
    '    pagePath: /pet',
    `    tokenFile: ${JSON.stringify(flat(join(home, 'pet', 'token')))}`,
    '    windowMode: none',
    '',
  ].join('\n'))
  return { root, home, patch }
}

/** Extract the JSON-RPC body from an MCP response, SSE or plain JSON. */
function extractBody(text: string, contentType: string): string {
  if (!contentType.includes('text/event-stream')) return text
  return text.split('\n').filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim()).filter(line => line !== '').join('\n')
}

/** POST one legacy Streamable HTTP MCP message. */
async function post(mcp: string, message: unknown, label: string): Promise<{ status: number; json?: JsonRpcFrame }> {
  const response = await request(label, mcp, 120_000, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(message),
  }, 1)
  const body = extractBody(await response.text(), response.headers.get('content-type') ?? '')
  return {
    status: response.status,
    ...body.trim() === '' ? {} : { json: JSON.parse(body) as JsonRpcFrame },
  }
}

/**
 * Run one fetch with a fresh timeout signal per attempt. GET retries absorb a
 * stalled loopback keep-alive connection; POSTs never retry because a second
 * `subagent_delegate` call would run the delegation twice.
 */
async function request(
  label: string,
  target: string | URL,
  timeoutMs: number,
  init: RequestInit = {},
  attempts = 3,
): Promise<Response> {
  const started = Date.now()
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      last = error
      if (attempt < attempts) await new Promise((resolve) => { setTimeout(resolve, 250 * attempt) })
    }
  }
  throw new Error(`fetch ${label} failed after ${Date.now() - started} ms: ${target}`, { cause: last })
}

it.skipIf(!built)('reports accepted and rejected Agent delegations and retains their grouped history', async () => {
  const f = fixture()
  const child = execa(process.execPath, [bin, '--profile', 'pet', '--patch', f.patch, '--no-open', '--port', '0'], {
    cwd: f.root,
    env: {
      ...process.env,
      DSH_HOME: f.home,
      DSH_AGENTS_HOME: join(f.root, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'keyless-pet-e2e',
      NODE_NO_WARNINGS: '1',
    },
    reject: false,
    timeout: 180_000,
    killSignal: 'SIGKILL',
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (text: string) => { stdout += text })
  child.stderr?.setEncoding('utf8').on('data', (text: string) => { stderr += text })
  let exited = false
  void child.then(() => { exited = true })
  try {
    await expect.poll(() => {
      if (exited) throw new Error(`pet process exited early\n${stdout}\n${stderr}`)
      return /dsh pet: pet page (http:\/\/[^\s]+)/u.exec(stdout)?.[1] ?? ''
    }, { timeout: 150_000 }).toMatch(/^http:/u)
    const published = /dsh pet: pet page (http:\/\/[^\s]+)/u.exec(stdout)
    const pageUrl = published?.[1]
    if (pageUrl === undefined) throw new Error('missing pet page URL')
    const url = new URL(pageUrl)
    const token = url.searchParams.get('token')
    expect(token).toBeTruthy()
    if (token === null) throw new Error('missing pet access token')
    const mcp = new URL('/pet/mcp', url)
    mcp.search = url.search
    const api = (path: string): URL => new URL(`${path}?token=${token}`, url)

    const page = await request('pet page', pageUrl, 15_000)
    expect(page.status).toBe(200)
    const pageText = await page.text()
    expect(pageText).toContain('<html')
    // The page URL has no trailing slash; asset references must resolve under
    // the mounted prefix or the pet renders with no styles and no script.
    expect(pageText).toContain('/pet/assets/pet.css')
    const css = await request('pet css', new URL('/pet/assets/pet.css', url), 15_000)
    expect(css.status).toBe(200)
    expect((await css.text()).length).toBeGreaterThan(1000)

    const unauthorized = await request('unauthorized snapshot', new URL('/pet/api/snapshot', url), 15_000)
    expect(unauthorized.status).toBe(401)

    const init = await post(mcp.href, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'pet-e2e', version: '0.0.1' },
      },
    }, 'initialize')
    expect(init.status).toBe(200)
    expect(init.json?.result?.serverInfo?.name).toBe('dsh_pet')
    expect(init.json?.result?.instructions).toContain('Use `subagent_delegate` for substantial work you can hand off with clear acceptance criteria.')
    const initialized = await post(mcp.href, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'initialized')
    expect(initialized.status).toBe(202)

    const list = await post(mcp.href, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'tools/list')
    expect(list.status).toBe(200)
    expect(list.json?.result?.tools?.map(tool => tool.name)).toEqual(['list_subagent_models', 'subagent_delegate'])
    const delegationSchema = list.json?.result?.tools?.[1]?.inputSchema
    expect(delegationSchema).toMatchObject({
      properties: { agentSession: { type: 'string' } },
      required: ['agentSession', 'task', 'acceptanceCriteria', 'expectedReturn'],
    })
    expect(delegationSchema).not.toHaveProperty('properties.codexSession')
    expect(stdout).toContain('enabled_tools = ["list_subagent_models", "subagent_delegate"]')

    const invoke = async (id: number, name: string, args: Record<string, unknown>): Promise<JsonRpcFrame['result']> => {
      const response = await post(mcp.href, {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
      }, `${name} ${id}`)
      expect(response.status).toBe(200)
      return response.json?.result
    }
    const catalog = await invoke(5, 'list_subagent_models', { provider: 'pet-child-mock' })
    const childModel = { provider: 'pet-child-mock', model: 'pet-selected' }
    expect(catalog?.structuredContent?.models).toContainEqual({ ...childModel, name: 'Pet test model' })
    const modelInfo = await invoke(7, 'list_subagent_models', childModel)
    expect(modelInfo?.structuredContent).toEqual({
      models: [{
        ...childModel, name: 'Pet test model',
        reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' },
      }],
      unavailableProviders: [],
    })
    const modelWithoutEffort = { ...childModel, model: 'pet-no-effort' }
    const noEffortInfo = await invoke(8, 'list_subagent_models', modelWithoutEffort)
    expect(noEffortInfo?.structuredContent?.models).toEqual([{ ...modelWithoutEffort, name: 'Pet test model', reasoning: null }])
    const missingProvider = await invoke(9, 'list_subagent_models', { model: childModel.model })
    expect(missingProvider?.isError).toBe(true)
    expect(missingProvider?.content?.[0]?.text).toContain('model requires provider')
    const argumentsFor = (agentSession: string, task: string): Record<string, unknown> => ({
      agentSession, task, acceptanceCriteria: 'Use the selected model.', expectedReturn: 'Return the child output.',
    })
    const recordFor = async (result: JsonRpcFrame['result'], label: string): Promise<RecordBody> => {
      const id = /^Delegate: (\S+)/u.exec(result?.content?.[0]?.text ?? '')?.[1]
      if (id === undefined) throw new Error(`missing delegate ID for ${label}`)
      const response = await request(label, api(`/pet/api/delegates/${encodeURIComponent(id)}`), 15_000)
      expect(response.status).toBe(200)
      const record = await response.json() as RecordBody
      return record
    }
    const invalid = await invoke(6, 'subagent_delegate', { ...argumentsFor('invalid', 'invalid limit'), maxSubagents: 1.5 })
    expect(invalid?.isError).toBe(true)
    expect(invalid?.content?.[0]?.text).toContain('maxSubagents must be a positive safe integer')
    const legacy = await invoke(17, 'subagent_delegate', {
      codexSession: 'pet-e2e-legacy', task: 'Run a subagent.',
      acceptanceCriteria: 'A subagent returns a result.', expectedReturn: 'Return the child output.',
    })
    expect(legacy?.isError).toBe(true)
    expect(legacy?.content?.[0]?.text).toContain('requires non-empty agentSession')

    const delegations = [
      { agentSession: 'pet-e2e-accepted', expectedChildOutput: 'PET_CHILD_OK', accepted: true },
      { agentSession: 'pet-e2e-rejected', expectedChildOutput: 'PET_CHILD_OTHER', accepted: false },
    ]
    for (const [index, { agentSession, expectedChildOutput, accepted }] of delegations.entries()) {
      const call = await post(mcp.href, {
        jsonrpc: '2.0', id: index + 3, method: 'tools/call',
        params: {
          name: 'subagent_delegate',
          arguments: {
            agentSession,
            task: 'Run a subagent and return its output.',
            acceptanceCriteria: `The child output text is exactly ${expectedChildOutput}.`,
            expectedReturn: 'Return the child output text.',
          },
        },
      }, `tools/call ${agentSession}`)
      expect(call.status).toBe(200)
      const outcome = call.json?.result?.content?.[0]?.text ?? ''
      expect(outcome).toContain('Status: completed')
      expect(outcome).toContain(`Acceptance: ${accepted ? 'accepted' : 'rejected'}`)
      expect(outcome).toContain('PET_CHILD_OK')
      expect(outcome).toContain('PET_RESULT_OK')
      if (!accepted) expect(outcome).toContain('Acceptance notes: The criterion expected PET_CHILD_OTHER. The child returned PET_CHILD_OK.')
      expect(call.json?.result?.isError ?? false, agentSession).toBe(!accepted)
    }

    const snapshot = await request('snapshot', api('/pet/api/snapshot'), 15_000)
    expect(snapshot.status).toBe(200)
    const snapshotBody = JSON.parse(await snapshot.text()) as SnapshotBody
    expect(snapshotBody.active.flatMap(item => item.subagents)).toHaveLength(0)
    expect(snapshotBody.historyCount).toBe(delegations.length)

    const history = await request('history', api('/pet/api/history'), 15_000)
    expect(history.status).toBe(200)
    const historyBody = JSON.parse(await history.text()) as HistoryBody
    expect(historyBody.limit).toBe(4)
    expect(historyBody.groups).toHaveLength(delegations.length)
    for (const { agentSession, accepted } of delegations) {
      const group = historyBody.groups.find(candidate => candidate.agentSession === agentSession)
      expect(group?.entries).toHaveLength(1)
      const entry = group?.entries[0]
      if (entry === undefined) throw new Error(`history has no entry for ${agentSession}`)
      expect(entry.accepted).toBe(accepted)

      const detail = await request('delegate detail', api(`/pet/api/delegates/${encodeURIComponent(entry.id)}`), 15_000)
      expect(detail.status).toBe(200)
      const record = JSON.parse(await detail.text()) as RecordBody
      expect(record.status).toBe('completed')
      expect(record.agentSession).toBe(agentSession)
      expect(record).not.toHaveProperty('codexSession')
      expect(record.transcript[0]?.text).toMatch(/^Agent delegation \S+ from conversation /u)
      expect(record.subagents).toHaveLength(1)
      const [subagent] = record.subagents
      if (subagent === undefined) throw new Error('record has no subagent')
      expect(subagent.output).toBe('PET_CHILD_OK')
      expect(subagent.transcript.length).toBeGreaterThan(0)
      expect(record.acceptance?.accepted).toBe(accepted)
    }

    const constrained = [
      { session: 'pet-depth-limited', task: 'PET_TRY_NESTED', maxDepth: 1, maxSubagents: 3, created: 1 },
      { session: 'pet-depth-two', task: 'PET_TRY_NESTED', maxDepth: 2, maxSubagents: 2, created: 2, reasoningEffort: 'high' },
      { session: 'pet-count-limited', task: 'PET_TRY_NESTED PET_TRY_SIBLINGS', maxDepth: 2, maxSubagents: 1, created: 1 },
    ]
    for (const [index, { session, task, maxDepth, maxSubagents, created, reasoningEffort }] of constrained.entries()) {
      const result = await invoke(10 + index, 'subagent_delegate', {
        ...argumentsFor(session, task), subagentModel: childModel, maxDepth, maxSubagents,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      })
      expect(result?.isError ?? false, result?.content?.[0]?.text).toBe(false)
      const record = await recordFor(result, session)
      expect(record.status).toBe('completed')
      expect(record.subagents).toHaveLength(created)
      expect(record.subagents.map(child => child.output)).toEqual(Array.from(
        { length: created }, () => `pet-child-mock/pet-selected ${reasoningEffort ?? 'max'} PET_SELECTED`,
      ))
      const [child, grandchild] = record.subagents
      if (child === undefined) throw new Error(`missing child for ${session}`)
      if (session === 'pet-depth-limited') {
        expect(child.transcript.map(entry => entry.text).join('\n')).toContain('subagent depth 2 exceeds maxDepth 1')
      } else if (session === 'pet-depth-two') {
        expect(grandchild?.parentSessionId).toBe(child.sessionId)
      } else {
        expect(record.transcript.map(entry => entry.text).join('\n')).toContain('subagent creation limit (1) reached')
        expect(child.transcript.map(entry => entry.text).join('\n')).toContain('subagent creation limit (1) reached')
      }
    }
    const unknown = await invoke(13, 'subagent_delegate', {
      ...argumentsFor('invalid-model', 'unknown model'), subagentModel: { ...childModel, model: 'unlisted' },
    })
    expect(unknown?.isError).toBe(true)
    expect(unknown?.content?.[0]?.text).toContain('child model "pet-child-mock/unlisted" is not advertised')

    const unsupportedEffort = await invoke(14, 'subagent_delegate', {
      ...argumentsFor('invalid-effort', 'unknown effort'), subagentModel: childModel, reasoningEffort: 'ultra',
    })
    expect(unsupportedEffort?.isError).toBe(true)
    expect(unsupportedEffort?.content?.[0]?.text).toContain('reasoning effort "ultra" is unavailable')
    expect((await recordFor(unsupportedEffort, 'unsupported effort')).subagents).toHaveLength(0)
    const missingMax = await invoke(15, 'subagent_delegate', {
      ...argumentsFor('unsupported-default', 'model without max'), subagentModel: { ...childModel, model: 'pet-high-only' },
    })
    expect(missingMax?.isError).toBe(true)
    expect(missingMax?.content?.[0]?.text).toContain('reasoning effort "max" is unavailable')

    const noEffort = await invoke(16, 'subagent_delegate', {
      ...argumentsFor('no-effort', 'Use a model without configurable reasoning'), subagentModel: modelWithoutEffort,
    })
    expect(noEffort?.isError ?? false).toBe(false)
    expect((await recordFor(noEffort, 'model without efforts')).subagents.map(child => child.output))
      .toEqual(['pet-child-mock/pet-no-effort none PET_SELECTED'])
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`, { cause: error })
  } finally {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.kill('SIGTERM')
    await child
    clearTimeout(timer)
    rmSync(f.root, { recursive: true, force: true })
  }
}, 300_000)
