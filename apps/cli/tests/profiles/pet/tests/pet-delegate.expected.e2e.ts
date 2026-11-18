/**
 * The built pet profile exposes the caller guide and forwards each assignment
 * to one execution subagent, with runtime tree limits and durable history.
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
  error?: { code: number; message: string }
  result?: {
    serverInfo?: { name?: string }
    instructions?: string
    tools?: { name: string; inputSchema: object; description: string }[]
    resources?: { uri: string; mimeType: string }[]
    contents?: { uri: string; text: string }[]
    isError?: boolean
    content?: { type?: string; text?: string }[]
    structuredContent?: {
      models?: { provider: string; model: string; name: string }[]
      unavailableProviders?: string[]
      id?: string
      status?: string
      scheduledAt?: string
      scheduleId?: string
      nextRunAt?: string
      endsAt?: string
      runCount?: number
      endReason?: string
      lastRun?: { id: string; status: string; result?: { text: string } }
    }
  }
}

/** The pet snapshot API body, narrowed to the fields this spec reads. */
interface SnapshotBody {
  historyCount: number
  active: { agentSession: string; subagents: unknown[] }[]
}

/** The pet history API body, narrowed to the fields this spec reads. */
interface HistoryBody {
  limit: number
  groups: { agentSession: string; entries: { id: string; status: string; subagentCount: number }[] }[]
}

/** One delegation record, narrowed to the fields this spec reads. */
interface RecordBody {
  agentSession: string
  mainSessionId: string
  status: string
  scheduledAt?: number
  transcript: { text?: string }[]
  subagents: { sessionId: string; parentSessionId: string; startedAt: number; output?: string; transcript: { text?: string }[] }[]
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
    '- id: llm-deepseek',
    '  disabled: true',
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

/** POST once without retry. A modern request includes transport routing headers. */
async function post(mcp: string, message: unknown, label: string, modernMethod?: string): Promise<{ status: number; json?: JsonRpcFrame }> {
  const response = await request(label, mcp, 120_000, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...modernMethod === undefined ? {} : { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': modernMethod },
    },
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

async function startPet(f: ReturnType<typeof fixture>) {
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
  const stop = async (): Promise<void> => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.kill('SIGTERM')
    try {
      await child
    } finally {
      clearTimeout(timer)
    }
  }
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

    return { pageUrl, url, mcp, api, stop, output: () => ({ stdout, stderr }) }
  } catch (error) {
    await stop()
    throw error
  }
}

it.skipIf(!built)('serves the guide and forwards Agent assignments into the shared lead subagent history', async () => {
  const f = fixture()
  let pet: Awaited<ReturnType<typeof startPet>> | undefined
  try {
    pet = await startPet(f)
    const { pageUrl, url, mcp, api } = pet

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
    expect(init.json?.result?.instructions).toContain('The calling Agent plans, authorizes, and independently verifies the result.')
    expect(init.json?.result?.instructions).toContain('When asked to monitor a run, prefer delegating read-only checks')
    expect(init.json?.result?.instructions).toContain('use subagent_schedule with everySeconds')
    const initialized = await post(mcp.href, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'initialized')
    expect(initialized.status).toBe(202)

    const list = await post(mcp.href, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'tools/list')
    expect(list.status).toBe(200)
    expect(list.json?.result?.tools?.map(tool => tool.name)).toEqual([
      'list_subagent_models', 'read_subagent_guide', 'subagent_delegate', 'subagent_schedule', 'subagent_schedule_manage',
    ])
    const delegationTool = list.json?.result?.tools?.find(tool => tool.name === 'subagent_delegate')
    const delegationSchema = delegationTool?.inputSchema
    expect(delegationSchema).toMatchObject({
      properties: { agentSession: { type: 'string' } },
      required: ['agentSession', 'task', 'acceptanceCriteria', 'expectedReturn'],
    })
    expect(delegationSchema).not.toHaveProperty('properties.codexSession')
    expect(delegationSchema).toHaveProperty('properties.acceptanceCriteria.description',
      'Specify each check, its method, and the expected result. For deliverables that support unit testing, '
      + 'specify the unit tests the calling Agent will write and run.')
    expect(pet.output().stdout).toContain('"subagent_delegate", "subagent_schedule", "subagent_schedule_manage"')

    const guideUri = 'dsh-pet://guides/subagent-management'
    expect(delegationTool?.description).toContain(guideUri)
    const resources = await post(mcp.href, { jsonrpc: '2.0', id: 20, method: 'resources/list', params: {} }, 'resources/list')
    expect(resources.json?.result?.resources).toMatchObject([{ uri: guideUri, mimeType: 'text/markdown' }])
    const resource = await post(mcp.href, { jsonrpc: '2.0', id: 21, method: 'resources/read', params: { uri: guideUri } }, 'resources/read')
    const guide = resource.json?.result?.contents?.[0]?.text
    expect(guide).toContain('# Subagent 创建与管理规范')
    expect(guide).toContain('检查间隔、最长等待时间，以及完成、失败、超时的判据')
    expect(guide).toContain('调用方不得并行执行已经委派的同一项工作')
    expect(guide).toContain('由调用方编写并运行约定的单元测试')
    expect(guide).toContain('验收时不得重做已经委派的同一项工作')
    expect(guide).toContain('## 10. 执行顺序')
    const missing = await post(mcp.href, { jsonrpc: '2.0', id: 22, method: 'resources/read', params: { uri: guideUri + '/unknown' } }, 'unknown resource')
    expect(missing.json?.error?.code).toBe(-32602)
    expect(missing.json?.error?.message).toContain('Resource not found')
    const discovered = await post(mcp.href, {
      jsonrpc: '2.0', id: 26, method: 'server/discover', params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }, 'server/discover', 'server/discover')
    expect(discovered.status, discovered.json?.error?.message).toBe(200)
    expect(discovered.json?.result?.instructions).toBe(init.json?.result?.instructions)

    const invoke = async (id: number, name: string, args: Record<string, unknown>): Promise<JsonRpcFrame['result']> => {
      const response = await post(mcp.href, {
        jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
      }, `${name} ${id}`)
      expect(response.status).toBe(200)
      return response.json?.result
    }
    expect((await invoke(23, 'read_subagent_guide', {}))?.content?.[0]?.text).toBe(guide)
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

    const unsupportedPermissions = await invoke(25, 'subagent_delegate', {
      ...argumentsFor('invalid-permissions', 'Use an isolated workspace'), permissions: { writablePaths: [] },
    })
    expect(unsupportedPermissions?.isError).toBe(true)
    expect(unsupportedPermissions?.content?.[0]?.text).toContain('Unsupported delegation arguments: permissions')

    const agentSession = 'pet-e2e-forward'
    const task = 'Return the child marker.\nPreserve  two spaces.'
    const criteria = ['The child output text is exactly PET_CHILD_OK.', 'The child output text is exactly PET_CHILD_OTHER.']
    const records: RecordBody[] = []
    for (const [index, acceptanceCriteria] of criteria.entries()) {
      const call = await post(mcp.href, {
        jsonrpc: '2.0', id: index + 3, method: 'tools/call',
        params: {
          name: 'subagent_delegate',
          arguments: {
            agentSession,
            task,
            acceptanceCriteria,
            expectedReturn: 'Return the child output text.',
          },
        },
      }, `tools/call ${agentSession}`)
      expect(call.status).toBe(200)
      const outcome = call.json?.result?.content?.[0]?.text ?? ''
      expect(outcome).toContain('Status: completed')
      expect(outcome).toContain('Verification: required by the calling Agent')
      expect(outcome.split('\n\n').at(-1)).toBe('PET_CHILD_OK')
      expect(call.json?.result?.isError ?? false, agentSession).toBe(false)
      const record = await recordFor(call.json?.result, acceptanceCriteria)
      records.push(record)
      expect(record.status).toBe('completed')
      expect(record.agentSession).toBe(agentSession)
      expect(record).not.toHaveProperty('acceptance')
      expect(record.transcript[0]?.text).toMatch(/^Agent delegation \S+ from conversation /u)
      expect(record.subagents).toHaveLength(1)
      expect(record.subagents[0]?.parentSessionId).toBe(record.mainSessionId)
      expect(record.subagents[0]?.output).toBe('PET_CHILD_OK')
      const assignment = record.subagents[0]?.transcript.find(entry => entry.text?.startsWith('Agent delegation '))
      expect(assignment?.text).toContain(task)
      expect(assignment?.text).toContain(acceptanceCriteria)
    }
    expect(records[0]?.mainSessionId).toBe(records[1]?.mainSessionId)
    expect(records[0]?.subagents[0]?.sessionId).not.toBe(records[1]?.subagents[0]?.sessionId)

    const snapshot = await request('snapshot', api('/pet/api/snapshot'), 15_000)
    expect(snapshot.status).toBe(200)
    const snapshotBody = JSON.parse(await snapshot.text()) as SnapshotBody
    expect(snapshotBody.active.flatMap(item => item.subagents)).toHaveLength(0)
    expect(snapshotBody.historyCount).toBe(criteria.length)

    const history = await request('history', api('/pet/api/history'), 15_000)
    expect(history.status).toBe(200)
    const historyBody = JSON.parse(await history.text()) as HistoryBody
    expect(historyBody.limit).toBe(4)
    expect(historyBody.groups).toHaveLength(1)
    expect(historyBody.groups[0]?.agentSession).toBe(agentSession)
    expect(historyBody.groups[0]?.entries.map(entry => entry.subagentCount)).toEqual([1, 1])

    const constrained = [
      { session: 'pet-depth-limited', task: 'PET_TRY_NESTED', maxDepth: 1, maxSubagents: 3, created: 1 },
      { session: 'pet-depth-two', task: 'PET_TRY_NESTED', maxDepth: 2, maxSubagents: 2, created: 2, reasoningEffort: 'high' },
      { session: 'pet-count-limited', task: 'PET_TRY_NESTED', maxDepth: 2, maxSubagents: 1, created: 1 },
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
    const executionFailure = await invoke(24, 'subagent_delegate', argumentsFor('pet-execution-failure', 'PET_FORCE_FAILURE'))
    expect(executionFailure?.isError).toBe(true)
    expect(executionFailure?.content?.[0]?.text).toContain('Status: failed')
    expect((await recordFor(executionFailure, 'execution failure')).subagents).toHaveLength(1)

    const cancelledSession = 'pet-cancel-after-start'
    const controller = new AbortController()
    const pending = fetch(mcp, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 27, method: 'tools/call',
        params: { name: 'subagent_delegate', arguments: argumentsFor(cancelledSession, 'PET_WAIT_FOR_CANCEL') },
      }),
      signal: controller.signal,
    }).then(() => false, () => true)
    try {
      await expect.poll(async () => {
        const response = await request('active execution', api('/pet/api/snapshot'), 3_000, {}, 1)
        const state = await response.json() as SnapshotBody
        return state.active.find(item => item.agentSession === cancelledSession)?.subagents.length
      }, { timeout: 8_000 }).toBe(1)
    } finally {
      controller.abort()
    }
    expect(await pending).toBe(true)
    await expect.poll(async () => {
      const response = await request('cancelled execution', api('/pet/api/history'), 3_000, {}, 1)
      const state = await response.json() as HistoryBody
      return state.groups.find(item => item.agentSession === cancelledSession)?.entries[0]?.status
    }, { timeout: 8_000 }).toBe('cancelled')
    const afterCancel = await invoke(28, 'subagent_delegate', argumentsFor(cancelledSession, 'Return the child marker.'))
    expect(afterCancel?.isError ?? false).toBe(false)
    expect(afterCancel?.content?.[0]?.text).toContain('PET_CHILD_OK')
  } catch (error) {
    const { stdout, stderr } = pet?.output() ?? { stdout: '', stderr: '' }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`, { cause: error })
  } finally {
    await pet?.stop()
    rmSync(f.root, { recursive: true, force: true })
  }
}, 300_000)

it.skipIf(!built)('starts a scheduled assignment once after restart without occupying its conversation queue in advance', async () => {
  const f = fixture()
  let pet: Awaited<ReturnType<typeof startPet>> | undefined
  const input = {
    agentSession: 'pet-e2e-scheduled',
    task: 'Return the child marker.',
    acceptanceCriteria: 'Check that the output equals PET_CHILD_OK.',
    expectedReturn: 'Return only the marker.',
  }
  const invoke = (target: URL, name: string, args: Record<string, unknown>) => post(target.href, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }, name)
  const detail = async (instance: Awaited<ReturnType<typeof startPet>>, id: string): Promise<RecordBody> => {
    const response = await request('scheduled detail', instance.api(`/pet/api/delegates/${id}`), 3_000, {}, 1)
    expect(response.status).toBe(200)
    return await response.json() as RecordBody
  }
  try {
    const first = await startPet(f)
    pet = first
    for (const timing of [{},
      { delaySeconds: 0 },
      { everySeconds: 0 },
      { everySeconds: 2, delaySeconds: 1 },
      { delaySeconds: 1, durationSeconds: 5 },
      { everySeconds: 2, durationSeconds: 0 },
      { everySeconds: 2, maxRuns: 1.5 },
      { delaySeconds: 1, runAt: '2099-01-01T00:00:00Z' },
      { runAt: '2099-01-01T00:00:00' },
      { runAt: '2000-01-01T00:00:00Z' },
    ]) {
      const invalid = await invoke(first.mcp, 'subagent_schedule', { ...input, ...timing })
      expect(invalid.json?.result?.isError).toBe(true)
    }
    const scheduled = await invoke(first.mcp, 'subagent_schedule', { ...input, delaySeconds: 10 })
    const receipt = scheduled.json?.result?.structuredContent
    const { id, scheduledAt } = receipt ?? {}
    if (id === undefined || scheduledAt === undefined) throw new Error('missing scheduled receipt')
    expect(receipt?.status).toBe('scheduled')
    const start = Date.parse(scheduledAt)
    const initial = await detail(first, id)
    expect(initial).toMatchObject({ status: 'scheduled', scheduledAt: start, subagents: [] })
    const immediate = await invoke(first.mcp, 'subagent_delegate', input)
    expect(immediate.json?.result?.content?.[0]?.text).toContain('PET_CHILD_OK')
    expect((await detail(first, id)).status).toBe('scheduled')
    await first.stop()
    pet = undefined

    const restarted = await startPet(f)
    pet = restarted
    await expect.poll(async () => (await detail(restarted, id)).status, { timeout: 20_000 }).toBe('completed')
    const finished = await detail(restarted, id)
    expect(finished.mainSessionId).toBe(initial.mainSessionId)
    expect(finished.subagents).toHaveLength(1)
    expect(finished.subagents[0]?.startedAt).toBeGreaterThanOrEqual(start)
    expect(finished.subagents[0]?.output).toBe('PET_CHILD_OK')

    const runAt = new Date(Date.now() + 60_000).toISOString()
    const absolute = await invoke(restarted.mcp, 'subagent_schedule', { ...input, runAt })
    expect(absolute.json?.result?.structuredContent).toMatchObject({ status: 'scheduled', scheduledAt: runAt })
  } finally {
    await pet?.stop()
    rmSync(f.root, { recursive: true, force: true })
  }
}, 300_000)

it.skipIf(!built)('runs and manages a recurring plan through Pet after the creation call returns', async () => {
  const f = fixture()
  let pet: Awaited<ReturnType<typeof startPet>> | undefined
  const input = {
    agentSession: 'pet-e2e-recurring',
    task: 'Return the child marker.',
    acceptanceCriteria: 'Check the marker equals PET_CHILD_OK.',
    expectedReturn: 'Return only the marker.',
    maxSubagents: 1,
    everySeconds: 2,
  }
  const invoke = async (instance: Awaited<ReturnType<typeof startPet>>, name: string, args: Record<string, unknown>) => {
    const result = await post(instance.mcp.href, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    }, name)
    expect(result.status).toBe(200)
    expect(result.json?.result?.isError).not.toBe(true)
    return result.json?.result?.structuredContent
  }
  try {
    const first = await startPet(f)
    pet = first
    const created = await invoke(first, 'subagent_schedule', input)
    const scheduleId = created?.scheduleId
    if (scheduleId === undefined) throw new Error('missing recurring schedule receipt')
    expect(created?.status).toBe('active')
    expect(typeof created?.nextRunAt).toBe('string')
    expect(created).not.toHaveProperty('lastRun')
    const manage = (instance: Awaited<ReturnType<typeof startPet>>, action: string) =>
      invoke(instance, 'subagent_schedule_manage', { scheduleId, action })
    let firstId: string | undefined
    await expect.poll(async () => {
      const current = await manage(first, 'view')
      if (current?.lastRun?.status === 'completed') firstId = current.lastRun.id
      return firstId
    }, { timeout: 16_000 }).toMatch(/^d-/u)
    let nextId: string | undefined
    await expect.poll(async () => {
      const current = await manage(first, 'view')
      if (current?.lastRun?.status === 'completed') nextId = current.lastRun.id
      return nextId !== undefined && nextId !== firstId ? current?.lastRun?.result?.text : undefined
    }, { timeout: 16_000 }).toBe('PET_CHILD_OK')
    const historyResponse = await request('recurring history', first.api('/pet/api/history'), 3_000)
    const history = await historyResponse.json() as { groups: { entries: { id: string; scheduleId?: string }[] }[] }
    expect(history.groups.flatMap(group => group.entries)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstId, scheduleId }),
      expect.objectContaining({ id: nextId, scheduleId }),
    ]))
    expect(await manage(first, 'pause')).toMatchObject({ status: 'paused' })
    await first.stop()
    pet = undefined

    const restarted = await startPet(f)
    pet = restarted
    const restored = await manage(restarted, 'view')
    expect(restored).toMatchObject({ status: 'paused' })
    expect(restored).not.toHaveProperty('nextRunAt')
    const resumed = await manage(restarted, 'resume')
    expect(resumed?.status).toBe('active')
    expect(typeof resumed?.nextRunAt).toBe('string')
    expect(await manage(restarted, 'stop')).toMatchObject({ status: 'stopped' })

    const bounded = await invoke(restarted, 'subagent_schedule', { ...input, durationSeconds: 6, maxRuns: 1 })
    const boundedId = bounded?.scheduleId
    if (boundedId === undefined) throw new Error('missing bounded schedule receipt')
    expect(bounded).toMatchObject({ status: 'active', maxRuns: 1, runCount: 0 })
    expect(typeof bounded?.endsAt).toBe('string')
    await expect.poll(async () => invoke(restarted, 'subagent_schedule_manage', { scheduleId: boundedId, action: 'view' }),
      { timeout: 16_000 }).toMatchObject({
      status: 'ended', endReason: 'max_runs', runCount: 1,
      lastRun: { status: 'completed', result: { text: 'PET_CHILD_OK' } },
    })
  } finally {
    await pet?.stop()
    rmSync(f.root, { recursive: true, force: true })
  }
}, 300_000)
