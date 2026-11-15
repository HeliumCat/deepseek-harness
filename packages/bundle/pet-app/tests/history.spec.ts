/** History retention, grouping, and interrupted-run repair. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

function record(id: string, dispatchedAt: number, codexSession = 'codex one'): DelegateRecord {
  return {
    id,
    codexSession,
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
  it('retains and groups records by Codex conversation', async () => {
    const store = new HistoryStore({ root: await root(), limit: 1000 })
    await store.open()
    const one = record('d-one', 1)
    one.status = 'completed'
    one.acceptance = { accepted: true, notes: 'ok', at: 2 }
    const two = record('d-two', 2, 'codex two')
    two.status = 'failed'
    await store.begin(one)
    await store.begin(two)
    await store.save(one)
    await store.save(two)
    expect(store.size).toBe(2)
    const groups = store.groups()
    expect(groups.map(group => group.codexSession)).toEqual(['codex two', 'codex one'])
    expect(groups[1]?.entries[0]?.taskPreview).toBe('task d-one')
    expect(groups[1]?.entries[0]?.accepted).toBe(true)
    await expect(store.load('d-one')).resolves.toMatchObject({ codexSession: 'codex one', status: 'completed' })
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
})
