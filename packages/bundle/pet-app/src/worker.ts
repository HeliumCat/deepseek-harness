/**
 * The worker that turns one Codex MCP delegation into one durable worker
 * conversation and its subagent tree. The worker main agent analyzes the
 * delegation and spawns subagents; this service records the delegate envelope,
 * the live subagent set, the normalized transcripts, the acceptance verdict,
 * and the returned text into the capped history.
 *
 * @module @deepseek-ai/dsh-pet-app/worker
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentOptions, type AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { HistoryStore, newDelegateId } from './history.ts'
import { finalAssistantText, textOf, TranscriptBuilder } from './transcript.ts'
import type {
  AcceptanceVerdict,
  ActiveDelegateSnapshot,
  ActiveSubagentSnapshot,
  DelegateDetail,
  DelegateInput,
  DelegateOutcome,
  DelegateRecord,
  HistoryGroup,
  PetSnapshot,
  SubagentRecord,
  SubagentStatus,
  TranscriptEntry,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The pet worker all delegation routes and the acceptance tool read. */
    petWorker: PetWorker
  }
}

/** Display palette assigned to child runs in announcement order. */
const ICONS: readonly { readonly glyph: string; readonly color: string }[] = [
  { glyph: '🐳', color: '#4f8cff' },
  { glyph: '🦊', color: '#ff8a4c' },
  { glyph: '🐼', color: '#6b7280' },
  { glyph: '🐸', color: '#3fb950' },
  { glyph: '🐙', color: '#c084fc' },
  { glyph: '🐝', color: '#e3b341' },
  { glyph: '🦉', color: '#8b5cf6' },
  { glyph: '🐧', color: '#38bdf8' },
  { glyph: '🦄', color: '#f472b6' },
  { glyph: '🐯', color: '#f59e0b' },
  { glyph: '🐨', color: '#94a3b8' },
  { glyph: '🦖', color: '#22c55e' },
]

/** Stable provider option fields used by every worker session. */
export interface PetWorkerOptions {
  /** Absolute directory new worker sessions run in. */
  readonly workspace: string
  /** History directory. */
  readonly historyRoot: string
  /** Maximum retained delegations. */
  readonly historyLimit: number
  /** Agent preset mounted for the worker main agent. */
  readonly presetId: string
  /** MCP endpoint advertised to Codex, including its access token. */
  readonly mcpUrl: string
  /** Pet page URL advertised to the desktop window and history page. */
  readonly pageUrl: string
}

/** One live delegation's tracking state. */
interface ActiveDelegation {
  readonly record: DelegateRecord
  readonly builder: TranscriptBuilder
}

/** One session whose events belong to a tracked record. */
interface TrackedSession {
  readonly delegation: ActiveDelegation
  readonly subagent?: SubagentRecord
}

/**
 * Resolve a worker session id from a human-readable Codex conversation name.
 * @param codexSession - the caller-supplied Codex conversation name.
 * @returns the deterministic worker Session id.
 */
export function workerSessionId(codexSession: string): SessionId {
  const digest = createHash('sha256').update(codexSession).digest('hex')
  return brandString<SessionId>(`pet-${digest.slice(0, 32)}`)
}

/** One display glyph and color derived from a stable seed. */
function iconFor(seed: string): { readonly glyph: string; readonly color: string } {
  const digest = createHash('sha256').update(seed).digest()
  const index = (digest[0] ?? 0) % ICONS.length
  return ICONS[index] ?? ICONS[0] ?? { glyph: '🐳', color: '#4f8cff' }
}

/** Map a subagent stop reason onto the display vocabulary. */
function subagentStatus(stopReason: string): SubagentStatus {
  switch (stopReason) {
    case 'completed':
    case 'aborted':
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return stopReason
    default:
      return 'unknown'
  }
}

/** One-line description of a turn end, used as the reported stop reason. */
function turnReason(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed':
    case 'aborted':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
    case 'forked':
      return reason.kind
    case 'error':
      return `${reason.error.code}: ${reason.error.message}`
    default:
      return 'unknown'
  }
}

/** First non-empty line of a task prompt, bounded for the pet label. */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/u).find(candidate => candidate.trim() !== '') ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/**
 * The delegation worker. One instance owns every worker Agent, the live pet
 * snapshot, and the capped history store.
 */
export class PetWorker {
  private readonly ctx: Context
  private readonly options: PetWorkerOptions
  private readonly history: HistoryStore
  private readonly handles = new Map<SessionId, AgentHandle>()
  private readonly active = new Map<string, ActiveDelegation>()
  private readonly activeBySession = new Map<SessionId, ActiveDelegation>()
  private readonly tracked = new Map<SessionId, TrackedSession>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly turnWaiters = new Map<SessionId, {
    readonly afterSeq: number
    started: boolean
    readonly resolve: (reason: TurnEndReason) => void
  }>()
  private readonly disposers: (() => void)[] = []
  private closed = false

  /**
   * @param ctx - profiling context carrying agents, presets, sessions, and the subagent runtime.
   * @param options - workspace, history, and advertised endpoint values.
   */
  constructor(ctx: Context, options: PetWorkerOptions) {
    this.ctx = ctx
    this.options = options
    this.history = new HistoryStore({ root: options.historyRoot, limit: options.historyLimit })
  }

  /** Retained record count. */
  get historyCount(): number {
    return this.history.size
  }

  /** Configured retention cap. */
  get historyLimit(): number {
    return this.options.historyLimit
  }

  /**
   * Report an infrastructure failure through the context logger.
   * @param error - thrown or rejected value.
   */
  logError(error: unknown): void {
    this.ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
  }

  /**
   * Prepare the workspace, open the history, and subscribe to live events.
   * @returns after the worker can accept delegations.
   */
  async start(): Promise<void> {
    await mkdir(this.options.workspace, { recursive: true })
    await this.history.open()
    this.disposers.push(
      this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session.id, event) }),
      this.ctx.on('subagent/start', (info) => { this.onSubagentStart(info) }),
      this.ctx.on('subagent/end', (info) => { this.onSubagentEnd(info) }),
    )
  }

  /**
   * Stop admitting work, cancel live worker turns, and release their handles.
   * @returns after every owned agent and child tree is torn down.
   */
  async dispose(): Promise<void> {
    this.closed = true
    for (const dispose of this.disposers.splice(0)) dispose()
    const handles = [...this.handles.values()]
    this.handles.clear()
    for (const handle of handles) handle.agent.cancel({ kind: 'disposed' })
    await Promise.allSettled(handles.map(async (handle) => {
      await handle.agent.whenIdle().catch(() => undefined)
      await this.ctx.subagents.drainDescendants([handle.agent]).catch(() => undefined)
      await handle.dispose()
    }))
  }

  /**
   * Delegate one task. Calls for the same Codex conversation run in arrival
   * order; different conversations run concurrently.
   * @param input - the Codex delegation fields.
   * @param signal - caller cancellation; an aborted signal cancels the worker turn.
   * @returns the terminal outcome returned to Codex.
   * @throws Error when the worker is shutting down or the input is empty.
   */
  async delegate(input: DelegateInput, signal?: AbortSignal): Promise<DelegateOutcome> {
    if (this.closed) throw new Error('the pet worker is shutting down')
    const codexSession = input.codexSession.trim()
    if (codexSession === '') throw new Error('codexSession must be a non-empty Codex conversation name')
    if (input.task.trim() === '') throw new Error('task must be non-empty')
    const now = Date.now()
    const record: DelegateRecord = {
      id: newDelegateId(now),
      codexSession,
      task: input.task,
      acceptanceCriteria: input.acceptanceCriteria,
      expectedReturn: input.expectedReturn,
      dispatchedAt: now,
      status: 'queued',
      mainSessionId: workerSessionId(codexSession),
      workspace: this.options.workspace,
      transcript: [],
      subagents: [],
    }
    await this.history.begin(record)
    const previous = this.queues.get(codexSession) ?? Promise.resolve()
    const run = previous.then(
      async () => this.run(record, signal),
      async () => this.run(record, signal),
    )
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(codexSession, tail)
    try {
      return await run
    } finally {
      if (this.queues.get(codexSession) === tail) this.queues.delete(codexSession)
    }
  }

  private async run(record: DelegateRecord, signal?: AbortSignal): Promise<DelegateOutcome> {
    const delegation: ActiveDelegation = { record, builder: new TranscriptBuilder() }
    record.status = 'running'
    this.active.set(record.id, delegation)
    await this.persist(delegation)
    let agent: Agent
    try {
      agent = await this.ensureAgent(record.codexSession)
    } catch (error) {
      return this.finish(delegation, undefined, `worker agent unavailable: ${String(error)}`)
    }
    this.activeBySession.set(agent.session.id, delegation)
    this.tracked.set(agent.session.id, { delegation })
    const afterSeq = agent.session.seq
    let turnReasonValue: TurnEndReason | undefined
    let waiterResolve!: (reason: TurnEndReason) => void
    const turnEnded = new Promise<TurnEndReason>((resolve) => { waiterResolve = resolve })
    this.turnWaiters.set(agent.session.id, { afterSeq, started: false, resolve: waiterResolve })
    const abort = (): void => { agent.cancel({ kind: 'user' }) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const envelope = this.envelope(record)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: envelope }], source: { kind: 'user' } }))
      if (signal?.aborted === true) agent.cancel({ kind: 'user' })
      const aborted = new Promise<undefined>((resolve) => {
        if (signal === undefined) return
        signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
        if (signal.aborted) resolve(undefined)
      })
      turnReasonValue = signal === undefined ? await turnEnded : await Promise.race([turnEnded, aborted])
      await this.settle(agent)
    } catch (error) {
      return await this.finish(delegation, undefined, String(error))
    } finally {
      signal?.removeEventListener('abort', abort)
      this.turnWaiters.delete(agent.session.id)
      this.activeBySession.delete(agent.session.id)
      this.tracked.delete(agent.session.id)
    }
    return this.finish(delegation, turnReasonValue, undefined)
  }

  private async settle(agent: Agent): Promise<void> {
    for (;;) {
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      const more = await this.ctx.subagents.waitForTreeWork(agent)
      if (!more && agent.status === 'idle' && agent.session.seq === idleSeq) break
    }
    await this.ctx.sessions.flush(agent.session)
  }

  private async finish(
    delegation: ActiveDelegation,
    reason: TurnEndReason | undefined,
    error: string | undefined,
  ): Promise<DelegateOutcome> {
    const { record } = delegation
    const stopReason = reason === undefined ? 'cancelled' : turnReason(reason)
    const resultText = finalAssistantText(record.transcript)
      || record.subagents.map(subagent => subagent.output ?? '').filter(text => text !== '').join('\n\n')
    record.result = { text: resultText, stopReason }
    record.completedAt = Date.now()
    record.status = error !== undefined || (reason !== undefined && reason.kind !== 'completed' && reason.kind !== 'aborted')
      ? 'failed'
      : reason?.kind === 'aborted' || reason === undefined ? 'cancelled' : 'completed'
    if (error !== undefined) record.error = error
    else if (reason !== undefined && reason.kind !== 'completed' && reason.kind !== 'aborted') {
      record.error = turnReason(reason)
    }
    this.active.delete(record.id)
    for (const subagent of record.subagents) this.tracked.delete(brandString<SessionId>(subagent.sessionId))
    await this.persist(delegation)
    return {
      id: record.id,
      status: record.status,
      acceptance: record.acceptance === undefined ? undefined : {
        accepted: record.acceptance.accepted,
        notes: record.acceptance.notes,
      },
      text: resultText,
      stopReason,
      ...record.error === undefined ? {} : { error: record.error },
    }
  }

  private envelope(record: DelegateRecord): string {
    return [
      `Codex delegation ${record.id} from conversation ${JSON.stringify(record.codexSession)}.`,
      '',
      'Task:',
      record.task,
      '',
      'Acceptance criteria:',
      record.acceptanceCriteria,
      '',
      'Expected return:',
      record.expectedReturn,
      '',
      'Analyze the task, delegate it to one or more subagents with the `subagent` tool, wait for their results, compare them with the acceptance criteria, call `pet_acceptance` once, and reply with the expected return content.',
    ].join('\n')
  }

  private async ensureAgent(codexSession: string): Promise<Agent> {
    const sessionId = workerSessionId(codexSession)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const existing = await this.ctx.sessionPersistence.stat(sessionId)
    const setup: AgentSetup = async (agentCtx, agent) => {
      installModelSelection(agentCtx)
      const preset = this.ctx.agentPresets.presetForSession(agent.session) ?? this.options.presetId
      await this.ctx.agentPresets.mount(agentCtx, preset)
    }
    const handle = existing === undefined
      ? await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.options.workspace, agentPreset: this.options.presetId },
        agentOptions: this.agentOptions(),
        setup,
      })
      : await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: this.agentOptions(), setup })
    this.handles.set(sessionId, handle)
    return handle.agent
  }

  private agentOptions(): AgentOptions {
    const defaults = this.ctx.agentDefaultModel
    return {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
  }

  private onSessionEvent(sessionId: SessionId, event: SessionEvent): void {
    const target = this.tracked.get(sessionId)
    if (target !== undefined) {
      const entry = target.delegation.builder.push(event)
      if (entry !== undefined) this.append(target, entry)
    }
    const waiter = this.turnWaiters.get(sessionId)
    if (waiter === undefined) return
    if (event.type === 'turn/start' && event.seq > waiter.afterSeq) waiter.started = true
    else if (event.type === 'turn/end' && waiter.started) {
      waiter.started = false
      waiter.resolve(event.data.reason)
    }
  }

  private append(target: TrackedSession, entry: TranscriptEntry): void {
    if (target.subagent === undefined) target.delegation.record.transcript.push(entry)
    else target.subagent.transcript.push(entry)
    if (target.subagent !== undefined && target.subagent.label === '' && entry.kind === 'user') {
      target.subagent.label = firstLine(entry.text)
    }
  }

  private onSubagentStart(info: SubagentRunInfo): void {
    const parent = this.tracked.get(info.parentSessionId)
    if (parent === undefined) return
    const child = this.ctx.agents.get(info.id)
    let name = String(info.id)
    if (child !== undefined) {
      try {
        name = this.ctx.subagents.namesOf(child).self
      } catch {
        // A child that cannot be resolved still has a stable session id to display.
      }
    }
    const icon = iconFor(info.runId)
    const subagent: SubagentRecord = {
      runId: String(info.runId),
      sessionId: String(info.id),
      parentSessionId: String(info.parentSessionId),
      name,
      label: '',
      icon: icon.glyph,
      color: icon.color,
      startedAt: Date.now(),
      status: 'running',
      transcript: [],
    }
    parent.delegation.record.subagents.push(subagent)
    this.tracked.set(info.id, { delegation: parent.delegation, subagent })
    void this.persist(parent.delegation)
  }

  private onSubagentEnd(info: SubagentRunEndInfo): void {
    for (const delegation of this.active.values()) {
      const subagent = delegation.record.subagents.find(candidate => candidate.sessionId === String(info.id))
      if (subagent === undefined) continue
      subagent.endedAt = Date.now()
      subagent.stopReason = info.stopReason
      subagent.status = subagentStatus(info.stopReason)
      const output = info.lastAssistantMessage === undefined ? '' : textOf(info.lastAssistantMessage)
      subagent.output = output === '' ? finalAssistantText(subagent.transcript) : output
      if (subagent.label === '') subagent.label = subagent.name
      void this.persist(delegation)
      return
    }
  }

  private async persist(delegation: ActiveDelegation): Promise<void> {
    try {
      await this.history.save(delegation.record)
    } catch (error) {
      this.ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Record an acceptance verdict from the worker main agent.
   * @param agent - the Agent that called the acceptance tool.
   * @param verdict - accepted flag and notes.
   * @returns after the verdict is durable.
   * @throws Error when the calling Agent is not the worker's active main agent.
   */
  async recordAcceptance(agent: Agent, verdict: AcceptanceVerdict): Promise<void> {
    const delegation = this.activeBySession.get(agent.id)
    if (delegation === undefined) throw new Error('pet_acceptance requires an active delegation from the worker main agent')
    delegation.record.acceptance = { accepted: verdict.accepted, notes: verdict.notes, at: Date.now() }
    await this.history.save(delegation.record)
  }

  /**
   * Build the polled pet snapshot. Only running subagents are included.
   * @returns the active delegations, their running children, and endpoint facts.
   */
  snapshot(): PetSnapshot {
    const active: ActiveDelegateSnapshot[] = [...this.active.values()]
      .sort((left, right) => left.record.dispatchedAt - right.record.dispatchedAt)
      .map(({ record }) => ({
        id: record.id,
        codexSession: record.codexSession,
        dispatchedAt: record.dispatchedAt,
        status: record.status,
        subagents: record.subagents
          .filter(subagent => subagent.status === 'running')
          .map((subagent): ActiveSubagentSnapshot => ({
            id: subagent.sessionId,
            runId: subagent.runId,
            delegateId: record.id,
            codexSession: record.codexSession,
            name: subagent.name,
            label: subagent.label,
            icon: subagent.icon,
            color: subagent.color,
            startedAt: subagent.startedAt,
          })),
      }))
    return {
      generatedAt: Date.now(),
      mcpUrl: this.options.mcpUrl,
      pageUrl: this.options.pageUrl,
      historyLimit: this.options.historyLimit,
      historyCount: this.history.size,
      active,
    }
  }

  /**
   * Read one delegation's details, live or historical.
   * @param id - pet-local record identity.
   * @returns the full record, or undefined when it is unknown or evicted.
   */
  async detail(id: string): Promise<DelegateDetail | undefined> {
    const live = this.active.get(id)
    if (live !== undefined) return live.record
    return await this.history.load(id)
  }

  /**
   * History grouped by Codex conversation.
   * @returns the retained history grouped by Codex conversation.
   */
  historyGroups(): HistoryGroup[] {
    return this.history.groups()
  }
}
