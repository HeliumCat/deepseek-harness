/** History retention, grouping, and interrupted-run repair. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '../src/history.ts'
import type { DelegateRecord } from '../src/types.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-history-'))
  roots.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true })
})

function record(id: string, dispatchedAt: number, agentSession = 'agent one'): DelegateRecord {
  return {
    id,
    agentSession,
    task: `task ${id}\nsecond line`,
    acceptanceCriteria: 'tests pass',
    expectedReturn: 'summary',
    dispatchedAt,
    status: 'running',
    mainSessionId: `pet-${id}`,
    workspace: 'C:\\work',
    transcript: [],
    subagents: [],
  }
}

describe('delegate history', () => {
  it('retains and groups records by Agent conversation', async () => {
    const store = new HistoryStore({ root: await root(), limit: 1000 })
    await store.open()
    const one = record('d-one', 1)
    one.status = 'completed'
    const two = record('d-two', 2, 'agent two')
    two.status = 'failed'
    await store.begin(one)
    await store.begin(two)
    await store.save(one)
    await store.save(two)
    expect(store.size).toBe(2)
    const groups = store.groups()
    expect(groups.map(group => group.agentSession)).toEqual(['agent two', 'agent one'])
    expect(groups[1]?.entries[0]?.taskPreview).toBe('task d-one')
    await expect(store.load('d-one')).resolves.toMatchObject({ agentSession: 'agent one', status: 'completed' })
  })

  it('omits records that use the old conversation field', async () => {
    const directory = await root()
    const { agentSession, ...legacy } = record('d-old', 1)
    const records = join(directory, 'records')
    await mkdir(records)
    const legacyPath = join(records, 'd-old.json')
    const legacyDetail = JSON.stringify({
      ...legacy, status: 'completed', codexSession: agentSession,
    })
    await writeFile(legacyPath, legacyDetail)
    await writeFile(join(directory, 'index.json'), JSON.stringify([{
      id: legacy.id, codexSession: agentSession, dispatchedAt: legacy.dispatchedAt,
      status: 'completed', taskPreview: 'legacy task', subagentCount: 0,
    }]))

    const store = new HistoryStore({ root: directory, limit: 10 })
    await store.open()
    const current = record('d-new', 2, agentSession)
    await store.begin(current)
    current.status = 'completed'
    await store.save(current)

    const reopened = new HistoryStore({ root: directory, limit: 10 })
    await reopened.open()
    expect(reopened.groups()).toMatchObject([{
      agentSession, count: 1, entries: [{ id: current.id, agentSession }],
    }])
    await expect(reopened.load(legacy.id)).resolves.toBeUndefined()
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe(legacyDetail)
  })

  it('evicts the oldest completed record when the cap is exceeded', async () => {
    const directory = await root()
    const store = new HistoryStore({ root: directory, limit: 2 })
    await store.open()
    for (const [id, at] of [['d-a', 1], ['d-b', 2], ['d-c', 3]] as const) {
      const entry = record(id, at)
      await store.begin(entry)
      entry.status = 'completed'
      await store.save(entry)
    }
    expect(store.size).toBe(2)
    expect(store.entries().map(entry => entry.id)).toEqual(['d-c', 'd-b'])
    await expect(store.load('d-a')).resolves.toBeUndefined()
    const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as unknown[]
    expect(index).toHaveLength(2)
  })

  it('keeps a running record instead of evicting it for the cap', async () => {
    const store = new HistoryStore({ root: await root(), limit: 1 })
    await store.open()
    const running = record('d-run', 2)
    const done = record('d-done', 1)
    await store.begin(running)
    await store.begin(done)
    done.status = 'completed'
    await store.save(done)
    expect(store.size).toBe(1)
    expect(store.entries()[0]).toMatchObject({ id: 'd-run', status: 'running' })
  })

  it('repairs a running record left by a previous process', async () => {
    const directory = await root()
    const first = new HistoryStore({ root: directory, limit: 10 })
    await first.open()
    await first.begin(record('d-lost', 1))
    const second = new HistoryStore({ root: directory, limit: 10 })
    await second.open()
    expect(second.entries()[0]).toMatchObject({ id: 'd-lost', status: 'failed' })
    await expect(second.load('d-lost')).resolves.toMatchObject({
      status: 'failed',
      error: 'The pet worker stopped before this delegation completed.',
    })
  })

  it('restores scheduled work and leaves started work interrupted', async () => {
    const directory = await root()
    const first = new HistoryStore({ root: directory, limit: 1 })
    const pending = { ...record('d-planned', 1), status: 'scheduled' as const, scheduledAt: 2_000 }
    const started = { ...record('d-started', 2), status: 'scheduled' as const, scheduledAt: 1_000 }
    await first.open()
    await Promise.all([first.begin(pending), first.begin(started)])
    // An interrupted write can leave the detail one transition ahead of the index.
    await writeFile(join(directory, 'records', 'd-started.json'), JSON.stringify({ ...started, status: 'running' }))
    const reopened = new HistoryStore({ root: directory, limit: 1 })
    await expect(reopened.open()).resolves.toEqual([pending])
    expect(reopened.entries()).toMatchObject([
      { id: 'd-started', status: 'failed', scheduledAt: 1_000 },
      { id: 'd-planned', status: 'scheduled', scheduledAt: 2_000 },
    ])
  })

  it('retains the latest result alongside pending scheduled work', async () => {
    const store = new HistoryStore({ root: await root(), limit: 1 })
    await store.open()
    await store.begin({ ...record('d-future', 2), status: 'scheduled', scheduledAt: 3_000 })
    const finished = { ...record('d-finished', 1), status: 'completed' as const, scheduledAt: 1_000, completedAt: 1_001 }
    await store.save(finished)
    expect(store.entries().map(entry => entry.id)).toEqual(['d-future', 'd-finished'])
    await expect(store.load(finished.id)).resolves.toMatchObject({ status: 'completed' })
  })
})
