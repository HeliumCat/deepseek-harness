/**
 * Capped delegation history. The index is one atomic JSON file; each record's
 * full transcript is a separate file so the retention cap can evict it without
 * rewriting the other records. The newest `limit` delegations are retained and
 * grouped by the caller-supplied Codex conversation name.
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
  /** Maximum retained delegations. */
  readonly limit: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is DelegateStatus {
  return value === 'queued' || value === 'running' || value === 'completed'
    || value === 'failed' || value === 'cancelled'
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
  if (typeof value.id !== 'string' || typeof value.codexSession !== 'string') return false
  if (typeof value.task !== 'string' || typeof value.acceptanceCriteria !== 'string') return false
  if (typeof value.expectedReturn !== 'string' || typeof value.dispatchedAt !== 'number') return false
  if (!isStatus(value.status) || typeof value.mainSessionId !== 'string') return false
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
   * Read the index and repair entries whose worker stopped mid-delegation.
   * @returns after the index is usable.
   */
  async open(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A damaged index is moved aside rather than preventing the worker from serving new delegations.
      await writeFileAtomic(`${this.options.root}/index.corrupt-${Date.now().toString(36)}.json`, raw, { mode: 0o600, dirMode: 0o700 })
      await rm(this.indexPath, { force: true })
      return
    }
    if (!Array.isArray(parsed)) return
    this.index = parsed.filter((entry): entry is HistoryEntry => isObject(entry)
      && typeof entry.id === 'string' && typeof entry.codexSession === 'string'
      && typeof entry.dispatchedAt === 'number' && isStatus(entry.status)
      && typeof entry.taskPreview === 'string' && typeof entry.subagentCount === 'number')
    await this.repairInterrupted()
  }

  private async repairInterrupted(): Promise<void> {
    let changed = false
    const repaired: HistoryEntry[] = []
    for (const entry of this.index) {
      if (entry.status !== 'running' && entry.status !== 'queued') {
        repaired.push(entry)
        continue
      }
      const completedAt = Date.now()
      const record = await this.load(entry.id)
      if (record !== undefined) {
        record.status = 'failed'
        record.completedAt = completedAt
        record.error = 'The pet worker stopped before this delegation completed.'
        await this.storeRecord(record)
      }
      repaired.push({ ...entry, status: 'failed', completedAt })
      changed = true
    }
    if (changed) {
      this.index = repaired
      await this.writeIndex()
    }
  }

  /**
   * Mint a record identity and append its index row before the worker runs.
   * @param record - the new running record.
   * @returns after the index and initial record file are durable.
   */
  async begin(record: DelegateRecord): Promise<void> {
    this.index.push(this.entryOf(record))
    await this.storeRecord(record)
    await this.writeIndex()
    await this.prune()
  }

  /**
   * Persist the current state of one delegation and refresh its index row.
   * @param record - the record to write.
   * @returns after the record and index are durable.
   */
  async save(record: DelegateRecord): Promise<void> {
    const entry = this.entryOf(record)
    const at = this.index.findIndex(candidate => candidate.id === record.id)
    if (at === -1) this.index.push(entry)
    else this.index[at] = entry
    await this.storeRecord(record)
    await this.writeIndex()
    await this.prune()
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
   * Records grouped by Codex conversation, newest group first.
   * @returns the grouped retained history.
   */
  groups(): HistoryGroup[] {
    const groups = new Map<string, HistoryEntry[]>()
    for (const entry of this.entries()) {
      const list = groups.get(entry.codexSession)
      if (list === undefined) groups.set(entry.codexSession, [entry])
      else list.push(entry)
    }
    return [...groups.entries()]
      .map(([codexSession, entries]) => ({
        codexSession,
        count: entries.length,
        latestAt: entries[0]?.dispatchedAt ?? 0,
        entries,
      }))
      .sort((left, right) => right.latestAt - left.latestAt)
  }

  private entryOf(record: DelegateRecord): HistoryEntry {
    return {
      id: record.id,
      codexSession: record.codexSession,
      dispatchedAt: record.dispatchedAt,
      ...record.completedAt === undefined ? {} : { completedAt: record.completedAt },
      status: record.status,
      taskPreview: taskPreview(record.task),
      subagentCount: record.subagents.length,
      ...record.acceptance === undefined ? {} : { accepted: record.acceptance.accepted },
    }
  }

  private async storeRecord(record: DelegateRecord): Promise<void> {
    await this.enqueue(async () => {
      await writeFileAtomic(this.recordPath(record.id), `${JSON.stringify(record, undefined, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  private async writeIndex(): Promise<void> {
    const snapshot = this.index
    await this.enqueue(async () => {
      await writeFileAtomic(this.indexPath, `${JSON.stringify(snapshot, undefined, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  private async prune(): Promise<void> {
    const removed: string[] = []
    while (this.index.length > this.options.limit) {
      const oldest = [...this.index]
        .filter(entry => entry.status !== 'running' && entry.status !== 'queued')
        .sort((left, right) => left.dispatchedAt - right.dispatchedAt)[0]
      if (oldest === undefined) break
      this.index = this.index.filter(entry => entry.id !== oldest.id)
      removed.push(oldest.id)
    }
    if (removed.length === 0) return
    await this.writeIndex()
    for (const id of removed) await rm(this.recordPath(id), { force: true })
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
