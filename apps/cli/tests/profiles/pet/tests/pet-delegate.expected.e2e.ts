/**
 * The pet profile end to end through the built CLI: Codex's `subagent_delegate`
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
    tools?: { name: string }[]
    isError?: boolean
    content?: { type?: string; text?: string }[]
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
  groups: { codexSession: string; entries: { id: string; accepted: boolean }[] }[]
}

/** One delegation record, narrowed to the fields this spec reads. */
interface RecordBody {
  status: string
  subagents: { transcript: unknown[] }[]
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

it.skipIf(!built)('serves Codex MCP delegation, the acceptance verdict, and grouped history', async () => {
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
    const initialized = await post(mcp.href, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'initialized')
    expect(initialized.status).toBe(202)

    const list = await post(mcp.href, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, 'tools/list')
    expect(list.status).toBe(200)
    expect(list.json?.result?.tools?.some(tool => tool.name === 'subagent_delegate')).toBe(true)

    const call = await post(mcp.href, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'subagent_delegate',
        arguments: {
          codexSession: 'pet-e2e-session',
          task: 'Prove the pet end-to-end round trip.',
          acceptanceCriteria: 'The child output text is exactly PET_CHILD_OK.',
          expectedReturn: 'Return the child output text.',
        },
      },
    }, 'tools/call')
    expect(call.status).toBe(200)
    expect(call.json?.result?.isError).not.toBe(true)
    const outcome = call.json?.result?.content?.[0]?.text ?? ''
    expect(outcome).toContain('Status: completed')
    expect(outcome).toContain('Acceptance: accepted')
    expect(outcome).toContain('PET_CHILD_OK')
    expect(outcome).toContain('PET_RESULT_OK')

    const snapshot = await request('snapshot', api('/pet/api/snapshot'), 15_000)
    expect(snapshot.status).toBe(200)
    const snapshotBody = JSON.parse(await snapshot.text()) as SnapshotBody
    expect(snapshotBody.active.flatMap(item => item.subagents)).toHaveLength(0)
    expect(snapshotBody.historyCount).toBe(1)

    const history = await request('history', api('/pet/api/history'), 15_000)
    expect(history.status).toBe(200)
    const historyBody = JSON.parse(await history.text()) as HistoryBody
    expect(historyBody.limit).toBe(4)
    expect(historyBody.groups).toHaveLength(1)
    const [group] = historyBody.groups
    if (group === undefined) throw new Error('history has no group')
    expect(group.codexSession).toBe('pet-e2e-session')
    const [entry] = group.entries
    if (entry === undefined) throw new Error('history group has no entry')
    expect(entry.accepted).toBe(true)

    const detail = await request('delegate detail', api(`/pet/api/delegates/${encodeURIComponent(entry.id)}`), 15_000)
    expect(detail.status).toBe(200)
    const record = JSON.parse(await detail.text()) as RecordBody
    expect(record.status).toBe('completed')
    expect(record.subagents).toHaveLength(1)
    const [subagent] = record.subagents
    if (subagent === undefined) throw new Error('record has no subagent')
    expect(subagent.transcript.length).toBeGreaterThan(0)
    expect(record.acceptance?.accepted).toBe(true)
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
