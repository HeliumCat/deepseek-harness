/** Fixed-rate Pet scheduling across busy runs, pauses, and restart. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RecurringSchedules } from '../src/recurring-schedules.ts'

const addedAt = Date.parse('2026-11-18T00:00:00Z')
const intervalMs = 1_000
const input = {
  agentSession: 'clock',
  task: 'Read the current clock.',
  acceptanceCriteria: 'Verify the sampled time.',
  expectedReturn: 'Return one timestamp.',
}

it('skips a busy occurrence and keeps fixed-rate alignment after a pause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-recurring-'))
  const pending = Promise.withResolvers<undefined>()
  const run = vi.fn(() => pending.promise)
  const schedules = new RecurringSchedules({ root, run, logError: vi.fn() })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(addedAt)
  try {
    await schedules.open()
    const plan = await schedules.create(input, root, { everySeconds: 1 })
    schedules.start()
    await schedules.manage(plan.id, 'view')
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(intervalMs)
    const first = await schedules.manage(plan.id, 'view')
    expect(first.nextRunAt).toBe(addedAt + 2 * intervalMs)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]).toEqual([plan, { id: first.lastRunId, scheduledAt: addedAt + intervalMs }])

    await vi.advanceTimersByTimeAsync(intervalMs)
    expect(await schedules.manage(plan.id, 'view')).toMatchObject({ skippedRuns: 1, lastSkipReason: 'busy' })
    expect(run).toHaveBeenCalledOnce()
    pending.resolve(undefined)
    await schedules.manage(plan.id, 'pause')
    await vi.advanceTimersByTimeAsync(3.5 * intervalMs)
    expect(run).toHaveBeenCalledOnce()
    const resumed = await schedules.manage(plan.id, 'resume')
    expect(resumed.nextRunAt).toBe(addedAt + 6 * intervalMs)
    await vi.advanceTimersByTimeAsync(0.5 * intervalMs)
    expect(await schedules.manage(plan.id, 'view')).not.toHaveProperty('lastRunId', first.lastRunId)
    expect(run).toHaveBeenCalledTimes(2)
    expect(await schedules.manage(plan.id, 'stop')).toMatchObject({ status: 'stopped' })
    await vi.advanceTimersByTimeAsync(2 * intervalMs)
    expect(run).toHaveBeenCalledTimes(2)
    await expect(schedules.manage(plan.id, 'resume')).rejects.toThrow('stopped')
  } finally {
    pending.resolve(undefined)
    vi.useRealTimers()
    await schedules.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('restores a plan without running its offline occurrences or opening the store twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-recurring-restart-'))
  const run = vi.fn(async () => {})
  const options = { root, run, logError: vi.fn() }
  const first = new RecurringSchedules(options)
  const second = new RecurringSchedules(options)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(addedAt)
  try {
    await first.open()
    const plan = await first.create(input, root, { everySeconds: 1 })
    const contender = new RecurringSchedules(options)
    await expect(contender.open()).rejects.toMatchObject({ code: 'FILE_LOCK_TIMEOUT' })
    await first.close()

    vi.setSystemTime(addedAt + 3.5 * intervalMs)
    await second.open()
    second.start()
    expect(await second.manage(plan.id, 'view')).toMatchObject({
      status: 'active', nextRunAt: addedAt + 4 * intervalMs, skippedRuns: 3, lastSkipReason: 'missed',
    })
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0.5 * intervalMs)
    expect((await second.manage(plan.id, 'view')).lastRunId).toMatch(/^d-/u)
    expect(run).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    await first.close()
    await second.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('accepts a start at the duration deadline and expires paused plans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-recurring-deadline-'))
  const run = vi.fn(async () => {})
  const schedules = new RecurringSchedules({ root, run, logError: vi.fn() })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(addedAt)
  try {
    await schedules.open()
    const active = await schedules.create(input, root, { everySeconds: 1, durationSeconds: 2 })
    const paused = await schedules.create(input, root, { everySeconds: 1, durationSeconds: 1 })
    await schedules.manage(paused.id, 'pause')
    schedules.start()
    await schedules.manage(active.id, 'view')

    await vi.advanceTimersByTimeAsync(intervalMs)
    expect(await schedules.manage(active.id, 'view')).toMatchObject({ status: 'active', runCount: 1 })
    expect(await schedules.manage(paused.id, 'view')).toMatchObject({ status: 'ended', endReason: 'duration', runCount: 0 })
    await vi.advanceTimersByTimeAsync(intervalMs)
    const finished = await schedules.manage(active.id, 'view')
    expect(finished).toMatchObject({
      status: 'ended', endReason: 'duration', runCount: 2, endsAt: addedAt + 2 * intervalMs,
    })
    expect(run.mock.calls[1]).toEqual([
      expect.objectContaining({ id: active.id }), { id: finished.lastRunId, scheduledAt: active.endsAt },
    ])

    await vi.advanceTimersByTimeAsync(intervalMs)
    await expect(schedules.manage(active.id, 'resume')).rejects.toThrow('ended')
    expect(run).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
    await schedules.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves the dispatch count across restart and stops at maxRuns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-recurring-run-limit-'))
  const pending = Promise.withResolvers<undefined>()
  const run = vi.fn(() => pending.promise)
  const options = { root, run, logError: vi.fn() }
  const first = new RecurringSchedules(options)
  const restarted = new RecurringSchedules(options)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(addedAt)
  try {
    await first.open()
    const plan = await first.create(input, root, { everySeconds: 1, maxRuns: 2 })
    first.start()
    await first.manage(plan.id, 'view')
    await vi.advanceTimersByTimeAsync(intervalMs)
    expect(await first.manage(plan.id, 'view')).toMatchObject({ runCount: 1 })
    await vi.advanceTimersByTimeAsync(intervalMs)
    expect(await first.manage(plan.id, 'view')).toMatchObject({ runCount: 1, skippedRuns: 1, lastSkipReason: 'busy' })
    pending.resolve(undefined)
    await first.close()

    await restarted.open()
    restarted.start()
    expect(await restarted.manage(plan.id, 'view')).toMatchObject({ status: 'active', runCount: 1, maxRuns: 2 })
    await vi.advanceTimersByTimeAsync(intervalMs)
    expect(await restarted.manage(plan.id, 'view')).toMatchObject({ status: 'ended', endReason: 'max_runs', runCount: 2 })
    await vi.advanceTimersByTimeAsync(2 * intervalMs)
    expect(run).toHaveBeenCalledTimes(2)
  } finally {
    pending.resolve(undefined)
    vi.useRealTimers()
    await first.close()
    await restarted.close()
    await rm(root, { recursive: true, force: true })
  }
})
