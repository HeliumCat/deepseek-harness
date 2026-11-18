/**
 * The worker that turns one Agent delegation into one durable worker
 * conversation and its subagent tree. The lead subagent starts one assignment
 * exactly as supplied by the calling Agent and tracks the run in Pet history.
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
import { LlmError, type LlmResolvedModelInfo, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SubagentError, type SubagentResult, type SubagentRunEndInfo, type SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { HistoryStore, newDelegateId } from './history.ts'
import { RecurringSchedules, type RecurringPlan } from './recurring-schedules.ts'
import { finalAssistantText, textOf, TranscriptBuilder } from './transcript.ts'
import type {
  ActiveDelegateSnapshot,
  ActiveSubagentSnapshot,
  DelegateDetail,
  DelegateInput,
  DelegateOutcome,
  DelegateScheduleTiming,
  DelegateRecord,
  HistoryGroup,
  PetModelCatalog,
  PetScheduleAction,
  PetScheduleId,
  PetSnapshot,
  RecurringScheduleTiming,
  ScheduledDelegateRecord,
  SubagentRecord,
  SubagentStatus,
  TranscriptEntry,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The pet worker that serves delegation routes and history. */
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
  /** Preset for the Pet lead subagent holding the tree and history. */
  readonly presetId: string
  /** Preset mounted for the direct execution subagent. */
  readonly childPresetId: string
  /** Model route for every new execution subagent when the caller omits one. */
  readonly defaultSubagentModel: NonNullable<DelegateInput['subagentModel']>
  /** MCP endpoint advertised to calling Agents, including its access token. */
  readonly mcpUrl: string
  /** Pet page URL advertised to the desktop window and history page. */
  readonly pageUrl: string
}

/** One live delegation's tracking state. */
interface ActiveDelegation {
  readonly record: DelegateRecord
  readonly builder: TranscriptBuilder
}

const PET_DEFAULT_REASONING_EFFORT = brandString<ReasoningEffortId>('max')

/** Select an advertised effort for the delegation's effective child route. */
function resolvePetReasoningEffort(model: LlmResolvedModelInfo, requested?: ReasoningEffortId): ReasoningEffortId | undefined {
  if (model.reasoning === undefined && requested === undefined) return undefined
  const effort = requested ?? PET_DEFAULT_REASONING_EFFORT
  if (model.reasoning?.efforts.some(candidate => candidate.id === effort) === true) return effort
  const available = model.reasoning?.efforts.map(candidate => candidate.id).join(', ')
  throw new LlmError(
    `reasoning effort "${effort}" is unavailable for "${model.provider}/${model.id}".`
      + (available === undefined ? '' : ` Choose one of: ${available}.`),
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** One session whose events belong to a tracked record. */
interface TrackedSession {
  readonly delegation: ActiveDelegation
  readonly subagent?: SubagentRecord
}

/**
 * Resolve the lead subagent Session id from the calling Agent's conversation name.
 * @param agentSession - the caller-supplied Agent conversation name.
 * @returns the deterministic lead subagent Session id.
 */
export function leadSessionId(agentSession: string): SessionId {
  const digest = createHash('sha256').update(agentSession).digest('hex')
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

/** First non-empty line of a task prompt, bounded for the pet label. */
function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/u).find(candidate => candidate.trim() !== '') ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/**
 * The delegation worker owns live lead subagents, the Pet snapshot, and history.
 */
export class PetWorker {
  private readonly ctx: Context
  private readonly options: PetWorkerOptions
  private readonly history: HistoryStore
  private readonly recurring: RecurringSchedules
  private readonly active = new Map<string, ActiveDelegation>()
  private readonly tracked = new Map<SessionId, TrackedSession>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly scheduled = new Map<string, ScheduledDelegateRecord>()
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined
  private scheduleReady = false
  private readonly disposers: (() => void)[] = []
  private readonly shutdown = new AbortController()

  /**
   * @param ctx - profiling context carrying agents, presets, sessions, and the subagent runtime.
   * @param options - workspace, history, and advertised endpoint values.
   */
  constructor(ctx: Context, options: PetWorkerOptions) {
    this.ctx = ctx
    this.options = options
    this.history = new HistoryStore({
      root: options.historyRoot,
      limit: options.historyLimit,
      logCleanupError: (error) => { this.logError(error) },
    })
    this.recurring = new RecurringSchedules({
      root: options.historyRoot,
      run: async (plan, occurrence) => { await this.runRecurring(plan, occurrence) },
      logError: (error) => { this.logError(error) },
    })
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
    await this.recurring.open()
    try {
      for (const record of await this.history.open()) this.scheduled.set(record.id, record)
    } catch (error) {
      await this.recurring.close().catch((cleanup: unknown) => { this.logError(cleanup) })
      throw error
    }
    this.disposers.push(
      this.ctx.on('session/event', (session, event) => { this.onSessionEvent(session.id, event) }),
      this.ctx.on('subagent/start', (info) => { this.onSubagentStart(info) }),
      this.ctx.on('subagent/end', (info) => { this.onSubagentEnd(info) }),
    )
  }

  /** Allow recovered and newly scheduled delegations to start after profile readiness. */
  resumeSchedule(): void {
    this.scheduleReady = true
    this.armSchedule()
    this.recurring.start()
  }

  /**
   * Stop admitting delegations and cancel and drain owned subagent trees.
   * @returns after queued and active delegations settle.
   */
  async dispose(): Promise<void> {
    this.shutdown.abort()
    clearTimeout(this.scheduleTimer)
    this.scheduleTimer = undefined
    this.scheduled.clear()
    this.recurring.stop()
    try {
      await Promise.all(this.queues.values())
      await this.history.whenIdle()
    } finally {
      try {
        for (const dispose of this.disposers.splice(0)) dispose()
      } finally {
        await this.recurring.close()
      }
    }
  }

  /**
   * Discover routes or inspect a model's reasoning capabilities.
   * @param query - Optional provider filter. Include a model to inspect one exact advertised route.
   * @param signal - Cancellation of this catalog request.
   * @returns Advertised routes and unavailable providers. Exact-model queries include reasoning capabilities.
   * @throws If the requested model needs a provider, the route is unavailable, or the caller cancels.
   */
  async listSubagentModels(query: { readonly provider?: string; readonly model?: string }, signal?: AbortSignal): Promise<PetModelCatalog> {
    const llm = this.ctx.llm
    const { provider, model } = query
    if (model !== undefined) {
      if (provider === undefined) throw new ToolArgsError(['model requires provider'])
      const info = await this.advertisedSubagentModel(provider, model, signal)
      return {
        models: [{ provider: info.provider, model: info.id, name: info.name, reasoning: info.reasoning ?? null }],
        unavailableProviders: [],
      }
    }
    const providers = llm.listProviders().filter(item => provider === undefined || item.id === provider)
    if (provider !== undefined && providers.length === 0) {
      throw new SubagentError(`LLM provider "${provider}" is not registered`, 'LLM_PROVIDER_NOT_FOUND')
    }
    signal?.throwIfAborted()
    const catalogs = await Promise.allSettled(providers.map(item => llm.listModels(item.id)))
    signal?.throwIfAborted()
    const models: PetModelCatalog['models'][number][] = []
    const unavailableProviders: string[] = []
    for (const [index, catalog] of catalogs.entries()) {
      if (catalog.status === 'fulfilled') {
        for (const model of catalog.value) models.push({ provider: model.provider, model: model.id, name: model.name })
      } else {
        const failed = providers[index]
        if (failed !== undefined) unavailableProviders.push(failed.id)
      }
    }
    return { models, unavailableProviders }
  }

  private async advertisedSubagentModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const models = await this.ctx.llm.listModels(provider)
    signal?.throwIfAborted()
    if (!models.some(candidate => candidate.id === model)) {
      throw new SubagentError(`child model "${provider}/${model}" is not advertised; use list_subagent_models`, 'MODEL_ROUTE_NOT_ALLOWED')
    }
    return this.ctx.llm.resolveModelInfo(provider, model, signal)
  }

  /**
   * Delegate one task. Calls for the same Agent conversation run in arrival
   * order; different conversations run concurrently.
   * @param input - the delegation fields.
   * @param signal - caller cancellation stops the active delegation tree.
   * @returns the terminal outcome returned to the caller.
   * @throws When the worker is shutting down or the input is empty.
   */
  async delegate(input: DelegateInput, signal?: AbortSignal): Promise<DelegateOutcome> {
    this.shutdown.signal.throwIfAborted()
    const record = this.newRecord(input, Date.now())
    const cancellation = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal])
    return this.enqueue(record.agentSession, async () => {
      await this.history.begin(record)
      return this.run(record, cancellation)
    })
  }

  /**
   * Persist a one-time dispatch and arm its start independently of the MCP request.
   * @param input - the delegation fields.
   * @param timing - an absolute start time or delay from admission.
   * @param signal - cancellation checked before admission.
   * @returns the durable identity and scheduled start time.
   * @throws If the start is invalid, the worker is closing, or history cannot be written.
   */
  async schedule(
    input: DelegateInput,
    timing: DelegateScheduleTiming,
    signal?: AbortSignal,
  ): Promise<{ readonly id: string; readonly scheduledAt: number }> {
    this.shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
    const now = Date.now()
    const scheduledAt = 'runAt' in timing ? timing.runAt : now + timing.delaySeconds * 1_000
    const year = new Date(scheduledAt).getUTCFullYear()
    if (scheduledAt <= now || !Number.isFinite(year) || year > 9999) {
      throw new ToolArgsError(['the scheduled start must be a valid future instant'])
    }
    const record: ScheduledDelegateRecord = { ...this.newRecord(input, now), status: 'scheduled', scheduledAt }
    await this.history.begin(record)
    if (!this.shutdown.signal.aborted) {
      this.scheduled.set(record.id, record)
      this.armSchedule()
    }
    return { id: record.id, scheduledAt }
  }

  /**
   * Register a recurring dispatch with a fixed interval and captured workspace.
   * @param input - validated assignment.
   * @param timing - interval and optional end conditions.
   * @param signal - cancellation before accepting the plan.
   * @returns the saved recurring plan.
   */
  repeat(input: DelegateInput, timing: RecurringScheduleTiming, signal?: AbortSignal): Promise<RecurringPlan> {
    this.shutdown.signal.throwIfAborted()
    return this.recurring.create({ ...input, agentSession: input.agentSession.trim() }, this.options.workspace, timing, signal)
  }

  /**
   * Read or manage future runs and retrieve the latest run when retained.
   * @param id - recurring schedule ID.
   * @param action - requested management operation.
   * @param signal - cancellation before accepting the operation.
   * @returns the plan and its latest run, with an indication of queued or active work.
   */
  async manageSchedule(id: PetScheduleId, action: PetScheduleAction, signal?: AbortSignal):
  Promise<{ plan: RecurringPlan; lastRun?: DelegateDetail; inFlight: boolean }> {
    const plan = await this.recurring.manage(id, action, signal)
    const lastRun = plan.lastRunId === undefined ? undefined : await this.detail(plan.lastRunId)
    return { plan, ...lastRun === undefined ? {} : { lastRun }, inFlight: this.recurring.inFlight(id) }
  }

  private async runRecurring(plan: RecurringPlan, occurrence: { id: string; scheduledAt: number }): Promise<void> {
    const signal = this.shutdown.signal
    const record: DelegateRecord = {
      ...this.newRecord(plan.input, Date.now(), occurrence.id, plan.workspace),
      scheduledAt: occurrence.scheduledAt,
      scheduleId: plan.id,
    }
    await this.enqueue(record.agentSession, async () => {
      if (!signal.aborted) await this.run(record, signal)
    })
  }

  private newRecord(input: DelegateInput, now: number, id = newDelegateId(now), workspace = this.options.workspace): DelegateRecord {
    const agentSession = input.agentSession.trim()
    if (agentSession === '') throw new ToolArgsError(['agentSession must be a non-empty Agent conversation name'])
    if (input.task.trim() === '') throw new ToolArgsError(['task must be non-empty'])
    return {
      ...input,
      id,
      agentSession,
      dispatchedAt: now,
      status: 'queued',
      mainSessionId: leadSessionId(agentSession),
      workspace,
      transcript: [],
      subagents: [],
    }
  }

  private async enqueue<T>(agentSession: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentSession) ?? Promise.resolve()
    const run = previous.then(work)
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(agentSession, tail)
    try {
      return await run
    } finally {
      if (this.queues.get(agentSession) === tail) this.queues.delete(agentSession)
    }
  }

  private armSchedule(): void {
    clearTimeout(this.scheduleTimer)
    this.scheduleTimer = undefined
    if (!this.scheduleReady || this.shutdown.signal.aborted || this.scheduled.size === 0) return
    let next = Number.POSITIVE_INFINITY
    for (const record of this.scheduled.values()) next = Math.min(next, record.scheduledAt)
    const delay = Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS))
    this.scheduleTimer = setTimeout(() => { this.dispatchDue() }, delay)
  }

  private dispatchDue(): void {
    const signal = this.shutdown.signal
    if (signal.aborted) return
    const now = Date.now()
    const due = [...this.scheduled.values()].filter(record => record.scheduledAt <= now)
      .sort((left, right) => left.scheduledAt - right.scheduledAt || left.dispatchedAt - right.dispatchedAt)
    for (const record of due) {
      this.scheduled.delete(record.id)
      void this.enqueue(record.agentSession, async () => {
        if (!signal.aborted) await this.run(record, signal)
      }).catch((error: unknown) => { this.logError(error) })
    }
    this.armSchedule()
  }

  private async run(record: DelegateRecord, signal: AbortSignal): Promise<DelegateOutcome> {
    const delegation: ActiveDelegation = { record, builder: new TranscriptBuilder() }
    record.status = 'running'
    let result: SubagentResult | undefined
    let errorMessage: string | undefined
    try {
      await this.history.save(record)
      this.active.set(record.id, delegation)
      signal.throwIfAborted()
      const subagentModel = record.subagentModel ?? this.options.defaultSubagentModel
      const { provider, model } = subagentModel
      const info = record.subagentModel === undefined
        ? await this.ctx.llm.resolveModelInfo(provider, model, signal)
        : await this.advertisedSubagentModel(provider, model, signal)
      const reasoningEffort = resolvePetReasoningEffort(info, record.reasoningEffort)
      const handle = await this.openLead(record, signal)
      const lead = handle.agent
      this.tracked.set(lead.id, { delegation })
      try {
        const policy = { ...record, subagentModel, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
        result = await this.ctx.subagents.withTreePolicy(lead, policy, async () => {
          try {
            return await this.forward(lead, record, signal)
          } finally {
            await this.ctx.subagents.drainDescendants([lead])
          }
        })
      } finally {
        this.tracked.delete(lead.id)
        await handle.dispose()
      }
    } catch (error) {
      if (!signal.aborted || signal.reason !== error) errorMessage = error instanceof Error ? error.message : String(error)
    }
    return this.finish(record, result, errorMessage, signal.aborted)
  }

  private async forward(lead: Agent, record: DelegateRecord, signal: AbortSignal): Promise<SubagentResult> {
    const envelope = this.envelope(record)
    record.transcript.push({ kind: 'user', at: Date.now(), text: envelope })
    const maxDepth = this.ctx.subagents.resolveMaxDepth(undefined, lead)
    const child = await this.ctx.subagents.startActivation({
      provider: 'spawn',
      parent: lead,
      agentPreset: this.options.childPresetId,
      ...record.scheduledAt === undefined ? {} : { cwd: record.workspace },
      label: firstLine(record.task),
      prompt: [{ type: 'text', text: envelope }],
      ...maxDepth === undefined ? {} : { maxDepth },
      delivery: 'caller',
      signal,
    })
    const cancellation = Promise.withResolvers<never>()
    const abort = (): void => { cancellation.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      const result = await Promise.race([child.result, cancellation.promise])
      await Promise.race([this.ctx.subagents.waitForTreeWork(lead), cancellation.promise])
      await child.dispose()
      return result
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async finish(
    record: DelegateRecord,
    result: SubagentResult | undefined,
    error: string | undefined,
    cancelled: boolean,
  ): Promise<DelegateOutcome> {
    const status = error !== undefined ? 'failed'
      : cancelled || result?.stopReason === 'aborted' ? 'cancelled'
        : result?.stopReason === 'completed' ? 'completed' : 'failed'
    const stopReason = error !== undefined ? 'error' : status === 'cancelled' ? 'aborted' : result?.stopReason ?? 'error'
    const output = result === undefined ? record.subagents[0]?.output ?? '' : textOf(result.output)
    const diagnostic = error ?? result?.diagnostic
    record.result = { text: output, stopReason }
    record.completedAt = Date.now()
    record.status = status
    if (diagnostic !== undefined) record.error = diagnostic
    this.active.delete(record.id)
    for (const subagent of record.subagents) this.tracked.delete(brandString<SessionId>(subagent.sessionId))
    await this.history.save(record)
    return {
      id: record.id,
      status,
      text: output,
      stopReason,
      ...record.error === undefined ? {} : { error: record.error },
    }
  }

  private envelope(record: DelegateRecord): string {
    return [
      `Agent delegation ${record.id} from conversation ${JSON.stringify(record.agentSession)}.`,
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
      ...record.maxDepth === undefined ? [] : [`Maximum subagent depth: ${record.maxDepth} (direct children are depth 1).`],
      ...record.maxSubagents === undefined ? [] : [`Maximum subagents for this delegation: ${record.maxSubagents}, across all levels.`],
      'Follow the stated scope and steps. If an input, clarification, or permission is needed, stop the affected work and report what the calling Agent must decide.',
    ].join('\n')
  }

  private async openLead(record: DelegateRecord, signal: AbortSignal): Promise<AgentHandle> {
    const sessionId = brandString<SessionId>(record.mainSessionId)
    const existing = await this.ctx.sessionPersistence.stat(sessionId)
    signal.throwIfAborted()
    const setup: AgentSetup = async (agentCtx, agent) => {
      installModelSelection(agentCtx)
      agentCtx.on('agent/pre-step', async ({ agent: subject }, next) =>
        subject === agent ? { kind: 'reject' } : next())
      const preset = this.ctx.agentPresets.presetForSession(agent.session) ?? this.options.presetId
      await this.ctx.agentPresets.mount(agentCtx, preset)
    }
    return existing === undefined
      ? await this.ctx.agents.create({
        sessionId,
        meta: { cwd: record.workspace, agentPreset: this.options.presetId },
        agentOptions: this.agentOptions(),
        setup,
        signal,
      })
      : await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: this.agentOptions(), setup, signal })
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
   * Build the polled pet snapshot. Only running subagents are included.
   * @returns the active delegations, their running children, and endpoint facts.
   */
  snapshot(): PetSnapshot {
    const active: ActiveDelegateSnapshot[] = [...this.active.values()]
      .sort((left, right) => left.record.dispatchedAt - right.record.dispatchedAt)
      .map(({ record }) => ({
        id: record.id,
        agentSession: record.agentSession,
        dispatchedAt: record.dispatchedAt,
        status: record.status,
        subagents: record.subagents
          .filter(subagent => subagent.status === 'running')
          .map((subagent): ActiveSubagentSnapshot => ({
            id: subagent.sessionId,
            runId: subagent.runId,
            delegateId: record.id,
            agentSession: record.agentSession,
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
   * History grouped by Agent conversation.
   * @returns the retained history grouped by Agent conversation.
   */
  historyGroups(): HistoryGroup[] {
    return this.history.groups()
  }
}
