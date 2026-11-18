/**
 * Capped delegation history. The index is one atomic JSON file; each record's
 * full transcript is a separate file so the retention cap can evict it without
 * rewriting the other records. Pending scheduled delegations are retained
 * outside the history limit. Records are grouped by Agent conversation.
 *
 * @module @deepseek-ai/dsh-pet-app/history
 */

import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {
  DelegateRecord,
  DelegateStatus,
  HistoryEntry,
  HistoryGroup,
  ScheduledDelegateRecord,
  SubagentRecord,
  TranscriptEntry,
} from './types.ts'

const INDEX_FILE = 'index.json'
const RECORDS_DIR = 'records'
const TASK_PREVIEW_LENGTH = 160

/** History root and retention cap. */
export interface HistoryStoreOptions {
  /** Absolute directory holding the index and record files. */
  readonly root: string
  /** History limit excluding pending scheduled delegations. */
  readonly limit: number
  /** Report a failed deletion after the index has already evicted a record. */
  readonly logCleanupError?: (error: unknown) => void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is DelegateStatus {
  return value === 'scheduled' || value === 'queued' || value === 'running' || value === 'completed'
    || value === 'failed' || value === 'cancelled'
}

function isPending(status: DelegateStatus): boolean {
  return status === 'scheduled' || status === 'queued' || status === 'running'
}

function hasValidSchedule(value: Record<string, unknown>): boolean {
  if (value.scheduleId !== undefined && typeof value.scheduleId !== 'string') return false
  const time = value.scheduledAt
  return time === undefined
    ? value.status !== 'scheduled'
    : typeof time === 'number' && Number.isSafeInteger(time) && Number.isFinite(new Date(time).getTime())
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!isObject(value) || typeof value.kind !== 'string' || typeof value.at !== 'number') return false
  switch (value.kind) {
    case 'user':
      return typeof value.text === 'string'
    case 'assistant':
      return typeof value.text === 'string' && typeof value.reasoning === 'string' && Array.isArray(value.tools)
    case 'tool':
      return typeof value.callId === 'string' && (value.name === undefined || typeof value.name === 'string')
        && typeof value.text === 'string' && typeof value.isError === 'boolean'
    case 'status':
      return typeof value.label === 'string'
    default:
      return false
  }
}

function isSubagent(value: unknown): value is SubagentRecord {
  return isObject(value)
    && typeof value.runId === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.parentSessionId === 'string'
    && typeof value.name === 'string'
    && typeof value.label === 'string'
    && typeof value.icon === 'string'
    && typeof value.color === 'string'
    && typeof value.startedAt === 'number'
    && typeof value.status === 'string'
    && Array.isArray(value.transcript)
    && value.transcript.every(isTranscriptEntry)
}

function isRecord(value: unknown): value is DelegateRecord {
  if (!isObject(value)) return false
  if (typeof value.id !== 'string' || typeof value.agentSession !== 'string') return false
  if (typeof value.task !== 'string' || typeof value.acceptanceCriteria !== 'string') return false
  if (typeof value.expectedReturn !== 'string' || typeof value.dispatchedAt !== 'number') return false
  if (!isStatus(value.status) || !hasValidSchedule(value) || typeof value.mainSessionId !== 'string') return false
  if (typeof value.workspace !== 'string' || !Array.isArray(value.transcript)) return false
  if (value.transcript.length > 0 && !value.transcript.every(isTranscriptEntry)) return false
  if (!Array.isArray(value.subagents) || !value.subagents.every(isSubagent)) return false
  return true
}

function taskPreview(task: string): string {
  const firstLine = task.trim().split(/\r?\n/u)[0] ?? ''
  return firstLine.length <= TASK_PREVIEW_LENGTH ? firstLine : `${firstLine.slice(0, TASK_PREVIEW_LENGTH - 1)}…`
}

/** Append-only-in-practice index over individually stored records. */
export class HistoryStore {
  private readonly options: HistoryStoreOptions
  private index: HistoryEntry[] = []
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param options - history root and retention cap.
   */
  constructor(options: HistoryStoreOptions) {
    this.options = options
  }

  /** Number of retained delegations. */
  get size(): number {
    return this.index.length
  }

  /** Configured retention cap. */
  get limit(): number {
    return this.options.limit
  }

  private get indexPath(): string {
    return join(this.options.root, INDEX_FILE)
  }

  private recordPath(id: string): string {
    return join(this.options.root, RECORDS_DIR, `${id}.json`)
  }

  /**
   * Read the index and reconcile pending entries with their persisted details.
   * @returns Pending one-time delegations to restore.
   */
  async open(): Promise<readonly ScheduledDelegateRecord[]> {
    let raw: string
    try {
      raw = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A damaged index is moved aside rather than preventing the worker from serving new delegations.
      await writeFileAtomic(`${this.options.root}/index.corrupt-${Date.now().toString(36)}.json`, raw, { mode: 0o600, dirMode: 0o700 })
      await rm(this.indexPath, { force: true })
      return []
    }
    if (!Array.isArray(parsed)) return []
    this.index = parsed.filter((entry): entry is HistoryEntry => isObject(entry)
      && typeof entry.id === 'string' && typeof entry.agentSession === 'string'
      && typeof entry.dispatchedAt === 'number' && isStatus(entry.status) && hasValidSchedule(entry)
      && typeof entry.taskPreview === 'string' && typeof entry.subagentCount === 'number')
    return this.repairPending()
  }

  private async repairPending(): Promise<readonly ScheduledDelegateRecord[]> {
    const scheduled: ScheduledDelegateRecord[] = []
    let changed = false
    const repaired: HistoryEntry[] = []
    for (const entry of this.index) {
      if (!isPending(entry.status)) {
        repaired.push(entry)
        continue
      }
      const record = await this.load(entry.id)
      if (entry.status === 'scheduled' && record?.status === 'scheduled' && record.scheduledAt !== undefined) {
        scheduled.push({ ...record, scheduledAt: record.scheduledAt })
        repaired.push(entry)
        continue
      }
      changed = true
      if (record !== undefined && !isPending(record.status)) {
        repaired.push(this.entryOf(record))
        continue
      }
      const completedAt = Date.now()
      if (record !== undefined) {
        record.status = 'failed'
        record.completedAt = completedAt
        record.error = 'The pet worker stopped before this delegation completed.'
        await this.writeRecord(record.id, JSON.stringify(record, undefined, 2))
      }
      repaired.push({ ...entry, status: 'failed', completedAt })
    }
    if (changed) {
      await this.writeIndex(repaired)
      this.index = repaired
    }
    return scheduled
  }

  /**
   * Save the initial indexed record for a new delegation.
   * @param record - the new delegation record.
   * @returns after the index and initial record file are durable.
   */
  begin(record: DelegateRecord): Promise<void> {
    return this.save(record)
  }

  /**
   * Persist the current state of one delegation and refresh its index row.
   * @param record - the record to write.
   * @returns after the record and index are durable.
   */
  async save(record: DelegateRecord): Promise<void> {
    const entry = this.entryOf(record)
    const contents = JSON.stringify(record, undefined, 2)
    await this.enqueue(async () => {
      const next = [...this.index.filter(candidate => candidate.id !== entry.id), entry]
      const capped = next.filter(candidate => candidate.scheduledAt === undefined || !isPending(candidate.status))
      const evicted = new Set(next.filter(candidate => !isPending(candidate.status))
        .sort((left, right) => (left.completedAt ?? left.dispatchedAt) - (right.completedAt ?? right.dispatchedAt))
        .slice(0, Math.max(0, capped.length - this.options.limit))
        .map(candidate => candidate.id))
      const retained = next.filter(candidate => !evicted.has(candidate.id))
      await this.writeRecord(entry.id, contents)
      await this.writeIndex(retained)
      this.index = retained
      for (const id of evicted) {
        try {
          await rm(this.recordPath(id), { force: true })
        } catch (error) {
          this.options.logCleanupError?.(error)
        }
      }
    })
  }

  /**
   * Drain the history writes admitted before shutdown.
   * @returns A promise that settles after the writes have finished.
   */
  whenIdle(): Promise<void> {
    return this.writeChain
  }

  /**
   * Read one record's full detail.
   * @param id - record identity.
   * @returns the record, or undefined when it was evicted or never existed.
   */
  async load(id: string): Promise<DelegateRecord | undefined> {
    let raw: string
    try {
      raw = await readFile(this.recordPath(id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
    return isRecord(parsed) ? parsed : undefined
  }

  /**
   * Index rows, newest first.
   * @returns the retained index rows.
   */
  entries(): readonly HistoryEntry[] {
    return [...this.index].sort((left, right) => right.dispatchedAt - left.dispatchedAt)
  }

  /**
   * Records grouped by Agent conversation, newest group first.
   * @returns the grouped retained history.
   */
  groups(): HistoryGroup[] {
    const groups = new Map<string, HistoryEntry[]>()
    for (const entry of this.entries()) {
      const list = groups.get(entry.agentSession)
      if (list === undefined) groups.set(entry.agentSession, [entry])
      else list.push(entry)
    }
    return [...groups.entries()]
      .map(([agentSession, entries]) => ({
        agentSession,
        count: entries.length,
        latestAt: entries[0]?.dispatchedAt ?? 0,
        entries,
      }))
      .sort((left, right) => right.latestAt - left.latestAt)
  }

  private entryOf(record: DelegateRecord): HistoryEntry {
    return {
      id: record.id,
      agentSession: record.agentSession,
      dispatchedAt: record.dispatchedAt,
      ...record.scheduledAt === undefined ? {} : { scheduledAt: record.scheduledAt },
      ...record.scheduleId === undefined ? {} : { scheduleId: record.scheduleId },
      ...record.completedAt === undefined ? {} : { completedAt: record.completedAt },
      status: record.status,
      taskPreview: taskPreview(record.task),
      subagentCount: record.subagents.length,
    }
  }

  private async writeRecord(id: string, contents: string): Promise<void> {
    await writeFileAtomic(this.recordPath(id), `${contents}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private async writeIndex(entries: readonly HistoryEntry[]): Promise<void> {
    await writeFileAtomic(this.indexPath, `${JSON.stringify(entries, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(operation, operation)
    this.writeChain = next.catch(() => undefined)
    return next
  }
}

/**
 * One fresh record identity.
 * @param now - epoch milliseconds used in the identity.
 * @returns the new record id.
 */
export function newDelegateId(now = Date.now()): string {
  return `d-${now.toString(36)}-${randomBytes(3).toString('hex')}`
}
