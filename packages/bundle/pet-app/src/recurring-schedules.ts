/** Persistent, fixed-rate plans that submit individual Pet delegations. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { parseDelegateInput } from './delegate-input.ts'
import { newDelegateId } from './history.ts'
import type { DelegateInput, PetScheduleAction, PetScheduleId, RecurringScheduleTiming } from './types.ts'

/** Last millisecond representable as a four-digit RFC 3339 year. */
const LAST_INSTANT = 253_402_300_799_999

type ScheduleStatus = 'active' | 'paused' | 'stopped' | 'ended'
type SkipReason = 'busy' | 'missed'
type EndReason = 'duration' | 'max_runs'

/** One durable plan and its position in a fixed-rate series. */
export interface RecurringPlan {
  /** Plan identity. */
  readonly id: PetScheduleId
  /** Assignment and execution options used for each run. */
  readonly input: DelegateInput
  /** Workspace captured at submission. */
  readonly workspace: string
  /** Interval between planned starts in whole seconds. */
  readonly everySeconds: number
  /** Whether the plan may submit new runs. */
  readonly status: ScheduleStatus
  /** Earliest unprocessed start instant, retained during a pause. */
  readonly nextRunAt: number
  /** Inclusive deadline for planned starts. */
  readonly endsAt?: number
  /** Upper limit on accepted delegations. */
  readonly maxRuns?: number
  /** Number of delegations accepted, including queued and failed runs. */
  readonly runCount: number
  /** Automatic end condition that was reached. */
  readonly endReason?: EndReason
  /** Identity of the latest accepted delegation. */
  readonly lastRunId?: string
  /** Total elapsed or busy occurrences skipped by the scheduler. */
  readonly skippedRuns: number
  /** Reason for the most recent skip. */
  readonly lastSkipReason?: SkipReason
}

interface Occurrence {
  readonly id: string
  readonly scheduledAt: number
}

interface ScheduleOptions {
  readonly root: string
  readonly logError: (error: unknown) => void
  readonly run: (plan: RecurringPlan, occurrence: Occurrence) => Promise<void>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function intervalSeconds(value: unknown): value is number {
  return positiveInteger(value) && value * 1_000 <= LAST_INSTANT
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return value === 0 || positiveInteger(value)
}

function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= LAST_INSTANT
}

/**
 * Decode an ID supplied by an MCP client or a persisted plan.
 * @param value - untrusted schedule ID.
 * @returns a validated plan ID, or undefined.
 */
export function parsePetScheduleId(value: unknown): PetScheduleId | undefined {
  return typeof value === 'string' && /^ps-[a-f0-9-]{36}$/u.test(value) ? brandString<PetScheduleId>(value) : undefined
}

function decodePlan(value: unknown): RecurringPlan {
  if (!object(value)) throw new Error('Invalid Pet recurring schedule record.')
  const { input, workspace, everySeconds, status, nextRunAt, lastRunId, skippedRuns, lastSkipReason } = value
  const { endsAt, maxRuns, runCount = 0, endReason } = value
  const id = parsePetScheduleId(value['id'])
  if (id === undefined || !object(input) || typeof workspace !== 'string' || !isAbsolute(workspace)
    || !intervalSeconds(everySeconds) || !epoch(nextRunAt)
    || (status !== 'active' && status !== 'paused' && status !== 'stopped' && status !== 'ended')
    || (endsAt !== undefined && !epoch(endsAt)) || (maxRuns !== undefined && !positiveInteger(maxRuns))
    || !nonNegativeInteger(runCount) || (maxRuns !== undefined && runCount > maxRuns)
    || (maxRuns !== undefined && runCount === maxRuns && endReason !== 'max_runs')
    || (endReason !== undefined && endReason !== 'duration' && endReason !== 'max_runs')
    || ((status === 'ended') !== (endReason !== undefined))
    || (endReason === 'duration' && endsAt === undefined) || (endReason === 'max_runs' && runCount !== maxRuns)
    || (lastRunId !== undefined && (typeof lastRunId !== 'string' || !/^d-[a-z0-9-]+$/u.test(lastRunId)))
    || (lastSkipReason !== undefined && lastSkipReason !== 'busy' && lastSkipReason !== 'missed')
    || !nonNegativeInteger(skippedRuns)) {
    throw new Error('Invalid Pet recurring schedule fields.')
  }
  const assignment = parseDelegateInput(input)
  if (typeof assignment === 'string') throw new Error(`Invalid assignment for Pet schedule "${id}": ${assignment}`)
  return {
    id, input: assignment, workspace, everySeconds, status, nextRunAt, skippedRuns, runCount,
    ...endsAt === undefined ? {} : { endsAt },
    ...maxRuns === undefined ? {} : { maxRuns },
    ...endReason === undefined ? {} : { endReason },
    ...lastRunId === undefined ? {} : { lastRunId },
    ...lastSkipReason === undefined ? {} : { lastSkipReason },
  }
}

function following(plan: RecurringPlan, now: number): { next: number; due: number } {
  const interval = plan.everySeconds * 1_000
  const due = Math.max(0, Math.floor((now - plan.nextRunAt) / interval) + 1)
  return { next: plan.nextRunAt + due * interval, due }
}

function ended(plan: RecurringPlan, endReason: EndReason): RecurringPlan {
  return { ...plan, status: 'ended', endReason }
}

/** Commits a plan's next start before handing the occurrence to the worker. */
export class RecurringSchedules {
  private plans = new Map<PetScheduleId, RecurringPlan>()
  private readonly running = new Set<PetScheduleId>()
  private readonly path: string
  private readonly releaseLease = Promise.withResolvers<void>()
  private lease: Promise<void> | undefined
  private writes: Promise<void> = Promise.resolve()
  private ready = false
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param options - persistent store, execution callback, and diagnostics.
   */
  constructor(private readonly options: ScheduleOptions) {
    this.path = join(options.root, 'recurring-schedules.json')
  }

  /**
   * Read persisted plans before the worker publishes its routes.
   * @returns after validating the entire store.
   */
  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const opened = Promise.withResolvers<void>()
    this.lease = withFileLock(this.path, async () => {
      await this.load()
      opened.resolve()
      await this.releaseLease.promise
    }, { waitMs: 0 })
    void this.lease.catch(opened.reject)
    await opened.promise
  }

  private async load(): Promise<void> {
    let contents: string
    try {
      contents = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const saved: unknown = JSON.parse(contents)
    if (!object(saved) || saved['version'] !== 1 || !Array.isArray(saved['plans'])) {
      throw new Error('Invalid Pet recurring schedule store.')
    }
    const plans = new Map<PetScheduleId, RecurringPlan>()
    for (const row of saved['plans']) {
      const plan = decodePlan(row)
      if (plans.has(plan.id)) throw new Error(`Duplicate Pet schedule "${plan.id}".`)
      plans.set(plan.id, plan)
    }
    this.plans = plans
  }

  /** Start the timer after worker readiness, skipping starts missed while offline. */
  start(): void {
    if (this.ready || this.closed) return
    this.ready = true
    this.tick(true)
  }

  /** Stop scheduling new work before the worker drains already accepted delegations. */
  stop(): void {
    this.closed = true
    clearTimeout(this.timer)
  }

  /**
   * Release the store lease after the worker drains its history writes.
   * @returns when in-progress schedule writes settle and the lock is released.
   */
  async close(): Promise<void> {
    this.stop()
    await this.writes
    this.releaseLease.resolve()
    await this.lease
  }

  /**
   * Save an active plan with its first occurrence one interval from admission.
   * @param input - validated assignment.
   * @param workspace - absolute workspace captured at submission.
   * @param timing - fixed interval and optional end conditions.
   * @param signal - cancellation before admission.
   * @returns the committed plan.
   */
  async create(input: DelegateInput, workspace: string, timing: RecurringScheduleTiming, signal?: AbortSignal): Promise<RecurringPlan> {
    const plan = await this.serialize(async () => {
      signal?.throwIfAborted()
      const { everySeconds, durationSeconds, maxRuns } = timing
      const now = Date.now()
      const nextRunAt = now + everySeconds * 1_000
      if (!intervalSeconds(everySeconds) || !epoch(nextRunAt)) {
        throw new ToolArgsError(['everySeconds must give a representable future start time.'])
      }
      const endsAt = durationSeconds === undefined ? undefined : now + durationSeconds * 1_000
      if (durationSeconds !== undefined && (!intervalSeconds(durationSeconds) || !epoch(endsAt))) {
        throw new ToolArgsError(['durationSeconds must give a representable future deadline.'])
      }
      if (maxRuns !== undefined && !positiveInteger(maxRuns)) {
        throw new ToolArgsError(['maxRuns must be a positive safe integer.'])
      }
      const id = brandString<PetScheduleId>(`ps-${randomUUID()}`)
      const created: RecurringPlan = {
        id, input, workspace, everySeconds, nextRunAt, status: 'active', runCount: 0, skippedRuns: 0,
        ...endsAt === undefined ? {} : { endsAt }, ...maxRuns === undefined ? {} : { maxRuns },
      }
      await this.commit(new Map(this.plans).set(id, created))
      return created
    })
    this.arm()
    return plan
  }

  /**
   * Inspect or change future occurrences of a plan. Accepted runs finish independently.
   * @param id - plan ID.
   * @param action - lifecycle operation.
   * @param signal - cancellation before admission.
   * @returns the plan after the operation.
   */
  async manage(id: PetScheduleId, action: PetScheduleAction, signal?: AbortSignal): Promise<RecurringPlan> {
    const plan = await this.serialize(async () => {
      signal?.throwIfAborted()
      const existing = this.plans.get(id)
      if (existing === undefined) throw new ToolArgsError([`Unknown Pet schedule "${id}".`])
      if (action === 'view') return existing
      if (existing.status === 'stopped' || existing.status === 'ended') {
        if (action === 'stop') return existing
        throw new ToolArgsError([`This Pet schedule has already ${existing.status}.`])
      }
      const status = action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'stopped'
      if (status === existing.status) return existing
      const now = Date.now()
      if (status === 'active' && existing.endsAt !== undefined && existing.endsAt <= now) {
        throw new ToolArgsError(['This Pet schedule has reached its deadline.'])
      }
      const next = status === 'active' ? following(existing, now).next : existing.nextRunAt
      if (!epoch(next)) throw new ToolArgsError(['This Pet schedule has no representable future occurrence.'])
      const changed: RecurringPlan = { ...existing, status, nextRunAt: next }
      await this.commit(new Map(this.plans).set(id, changed))
      return changed
    })
    if (action !== 'view') this.arm()
    return plan
  }

  /**
   * Check whether a plan has an accepted occurrence awaiting settlement.
   * @param id - plan ID.
   * @returns whether it is queued or running.
   */
  inFlight(id: PetScheduleId): boolean {
    return this.running.has(id)
  }

  private tick(recovering = false): void {
    void this.serialize(async () => {
      const now = Date.now()
      const updated = new Map(this.plans)
      const accepted: { plan: RecurringPlan; occurrence: Occurrence }[] = []
      let changed = false
      for (const plan of this.plans.values()) {
        if (plan.status !== 'active' && plan.status !== 'paused') continue
        const expired = plan.endsAt !== undefined && plan.endsAt <= now
        const cutoff = Math.min(now, plan.endsAt ?? now)
        if (plan.status === 'paused' || plan.nextRunAt > cutoff) {
          if (expired) {
            updated.set(plan.id, ended(plan, 'duration'))
            changed = true
          }
          continue
        }
        const { next, due } = following(plan, cutoff)
        const advanced: RecurringPlan = epoch(next) ? { ...plan, nextRunAt: next } : { ...plan, status: 'stopped' }
        const missed = recovering || now - plan.nextRunAt >= plan.everySeconds * 1_000
        const reason = missed ? 'missed' : this.running.has(plan.id) ? 'busy' : undefined
        changed = true
        if (reason !== undefined) {
          const skipped: RecurringPlan = { ...advanced, skippedRuns: plan.skippedRuns + due, lastSkipReason: reason }
          updated.set(plan.id, expired ? ended(skipped, 'duration') : skipped)
          continue
        }
        const occurrence = { id: newDelegateId(now), scheduledAt: plan.nextRunAt }
        const admitted = { ...advanced, lastRunId: occurrence.id, runCount: plan.runCount + 1 }
        const endReason = admitted.runCount === plan.maxRuns ? 'max_runs' : expired ? 'duration' : undefined
        updated.set(plan.id, endReason === undefined ? admitted : ended(admitted, endReason))
        accepted.push({ plan, occurrence })
      }
      if (changed) await this.commit(updated)
      if (this.closed) return
      for (const { plan, occurrence } of accepted) {
        this.running.add(plan.id)
        void this.options.run(plan, occurrence)
          .catch(this.options.logError)
          .finally(() => { this.running.delete(plan.id) })
      }
    }).then(() => { this.arm() }, (error: unknown) => {
      if (this.closed) return
      this.options.logError(error)
      this.arm(true, recovering)
    })
  }

  private arm(retry = false, recovering = false): void {
    clearTimeout(this.timer)
    if (!this.ready || this.closed) return
    const now = Date.now()
    let next = Number.POSITIVE_INFINITY
    for (const plan of this.plans.values()) {
      if (plan.status !== 'active' && plan.status !== 'paused') continue
      const deadline = plan.endsAt ?? Number.POSITIVE_INFINITY
      const wake = plan.status === 'active' ? Math.min(plan.nextRunAt, deadline) : deadline
      const due = retry && wake <= now ? following(plan, now).next : wake
      next = Math.min(next, due)
    }
    if (!Number.isFinite(next)) return
    const delay = Math.max(0, Math.min(next - now, MAX_TIMER_DELAY_MS))
    this.timer = setTimeout(() => { this.tick(recovering) }, delay)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.then(() => {
      if (this.closed) throw new Error('Pet recurring schedules are closing.')
      return operation()
    })
    this.writes = next.then(() => undefined, () => undefined)
    return next
  }

  private async commit(plans: Map<PetScheduleId, RecurringPlan>): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, plans: [...plans.values()] })}\n`, {
      mode: 0o600, dirMode: 0o700,
    })
    this.plans = plans
  }
}
